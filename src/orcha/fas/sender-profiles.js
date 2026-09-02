'use strict';
/**
 * orcha/fas/sender-profiles.js — Digital FAS Stage 10: sender identity + scoping.
 *
 * Resolves an incoming Slack sender to a permission-scoped profile BEFORE any
 * fleet data enters the AI context. Profiles are seeded from the existing
 * `contacts` store (Slack contacts have slackId; vendors have domiciles; some
 * carriers have operators) and can be edited/extended in the FAS settings UI,
 * persisted in the `slackSenderProfiles` store.
 *
 * Unknown senders default to LIMITED permissions (view nothing fleet-wide,
 * cannot request actions) — data scoping is enforced by code, never by trusting
 * the model.
 */

const store = require('../../store');
let logger; try { logger = require('../../utils/logger').createLogger('fas-profiles'); } catch (_) { logger = { info(){}, warn(){} }; }

// Data categories a profile may be allowed to see.
const DATA_CATEGORIES = ['unit_status', 'repair_timeline', 'work_orders', 'pm_status', 'uptake', 'vendor_contact', 'site_summary', 'operator_summary'];
// Request types a profile may be allowed to make.
const REQUEST_TYPES = ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'];

// Conservative default for anyone we don't recognize.
function _limitedDefaults(slackId, name) {
  return {
    slackId: slackId || '',
    name: name || slackId || 'Unknown',
    org: '',
    role: 'unknown',
    type: 'unknown',           // internal | carrier | vendor | manager | unknown
    operators: [],
    domiciles: [],
    allowedDataCategories: ['unit_status'], // may ask about a unit they name; nothing fleet-wide
    permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'process_question'],
    commPreferences: {},
    source: 'default-limited',
  };
}

// ── Permission PRESETS by identity type (Part 1) ─────────────────────────────
// Safe starting points; an authorized operator can customize per contact in the
// Contact Book. Internal/manager get broad categories; external (carrier/vendor)
// are scoped to their own operators/domiciles with a narrower category set;
// unknown gets the most limited access.
function presetFor(type) {
  const isInternal = type === 'internal' || type === 'manager';
  if (isInternal) {
    return { allowedDataCategories: DATA_CATEGORIES.slice(), permittedRequestTypes: REQUEST_TYPES.slice() };
  }
  if (type === 'carrier' || type === 'vendor') {
    return {
      allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'],
      permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'process_question'],
    };
  }
  // unknown
  return {
    allowedDataCategories: ['unit_status'],
    permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'process_question'],
  };
}

// Infer identityType from a raw contact when not explicitly set.
function _inferType(c) {
  if (VALID_TYPES.includes(c.identityType)) return c.identityType;
  if (VALID_TYPES.includes(c.type) && c.type !== 'slack') return c.type;
  if ((c.org && /amazon/i.test(c.org)) || /amazon\.com$/i.test(c.email || '')) return 'internal';
  if (c.type === 'vendor') return 'vendor';
  if (c.type === 'slack' || c.slackId) return 'carrier';
  return 'unknown';
}

// Resolve a FAS permission profile from a `contacts` store entry. The Contact
// Book is the SINGLE source of truth (Part 1): if the contact carries explicit
// FAS permission fields (allowedDataCategories/permittedRequestTypes) they win;
// otherwise a preset for the identity type is applied. A disabled contact
// (enabled === false) grants NO access.
function _fromContact(c) {
  const type = _inferType(c);
  const domiciles = []
    .concat(c.domiciles ? (Array.isArray(c.domiciles) ? c.domiciles : String(c.domiciles).split(/[\s,]+/)) : [])
    .concat(Array.isArray(c.domicileList) ? c.domicileList : [])
    .map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const operators = []
    .concat(Array.isArray(c.operators) ? c.operators : [])
    .concat(c.operator ? [c.operator] : [])
    .map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const preset = presetFor(type);
  // Disabled contact -> revoke all FAS authorization immediately (Part 1).
  const disabled = c.enabled === false;
  const hasExplicitCats = Array.isArray(c.allowedDataCategories);
  const hasExplicitReqs = Array.isArray(c.permittedRequestTypes);
  return {
    contactId: c.id || null,
    slackId: c.slackId || '',
    channelId: c.channelId || '',
    name: c.name || c.company || c.slackId || 'Unknown',
    org: c.org || c.organization || c.company || '',
    role: c.role || (type === 'vendor' ? 'vendor' : type === 'internal' ? 'internal' : 'partner'),
    type,
    enabled: !disabled,
    operators,
    domiciles,
    allowedDataCategories: disabled ? [] : (hasExplicitCats ? c.allowedDataCategories.filter(x => DATA_CATEGORIES.includes(x)) : preset.allowedDataCategories),
    permittedRequestTypes: disabled ? [] : (hasExplicitReqs ? c.permittedRequestTypes.filter(x => REQUEST_TYPES.includes(x)) : preset.permittedRequestTypes),
    commPreferences: (c.communicationPreferences && typeof c.communicationPreferences === 'object') ? c.communicationPreferences : (c.commPreferences || {}),
    source: 'contact-book',
  };
}

// Load the explicit profile store (edited via settings UI), keyed by slackId.
function _loadProfiles() {
  const raw = store.load('slackSenderProfiles', {});
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

const VALID_TYPES = ['internal', 'manager', 'carrier', 'vendor', 'unknown'];

/**
 * validateProfile(profile) -> { ok, profile?, error? }
 * Sanitizes an inbound (UI-edited) profile so a malformed one can't grant
 * unintended access:
 *   - slackId required (string)
 *   - type coerced to a known value (default 'unknown')
 *   - allowedDataCategories / permittedRequestTypes filtered to the known
 *     enums; anything else (incl. wildcards like "*" or non-arrays) dropped
 *   - operators / domiciles normalized to uppercase string arrays
 * Security-enforcing categories/scopes therefore only ever contain known,
 * intended values — never a wildcard or arbitrary string.
 */
function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return { ok: false, error: 'profile object required' };
  const slackId = typeof profile.slackId === 'string' ? profile.slackId.trim() : '';
  if (!slackId) return { ok: false, error: 'slackId required (string)' };
  const type = VALID_TYPES.includes(profile.type) ? profile.type : 'unknown';
  const toUpperArr = (v) => Array.isArray(v) ? v.map(x => String(x).trim().toUpperCase()).filter(Boolean) : [];
  const filterEnum = (v, allowed) => Array.isArray(v) ? v.filter(x => allowed.includes(x)) : [];
  const clean = {
    slackId,
    name: typeof profile.name === 'string' ? profile.name.slice(0, 120) : slackId,
    org: typeof profile.org === 'string' ? profile.org.slice(0, 120) : '',
    role: typeof profile.role === 'string' ? profile.role.slice(0, 60) : '',
    type,
    operators: toUpperArr(profile.operators),
    domiciles: toUpperArr(profile.domiciles),
    allowedDataCategories: filterEnum(profile.allowedDataCategories, DATA_CATEGORIES),
    permittedRequestTypes: filterEnum(profile.permittedRequestTypes, REQUEST_TYPES),
    commPreferences: (profile.commPreferences && typeof profile.commPreferences === 'object' && !Array.isArray(profile.commPreferences)) ? profile.commPreferences : {},
    source: 'ui-edited',
  };
  return { ok: true, profile: clean };
}

function saveProfile(profile) {
  const v = validateProfile(profile);
  if (!v.ok) return { ok: false, error: v.error };
  const all = _loadProfiles();
  all[v.profile.slackId] = { ...all[v.profile.slackId], ...v.profile, updatedAt: new Date().toISOString() };
  store.save('slackSenderProfiles', all);
  return { ok: true, profile: all[v.profile.slackId] };
}

/**
 * resolveSender(slackId, fallbackName) -> profile
 * Precedence: explicit profile store > contacts seed > limited default.
 */
function resolveSender(slackId, fallbackName) {
  if (!slackId) return _limitedDefaults('', fallbackName);
  // PART 1: the Contact Book is the SINGLE source of truth for identity +
  // permissions. Resolve from the matching contact FIRST.
  try {
    const contacts = store.load('contacts', []) || [];
    const c = contacts.find(x => x.slackId && String(x.slackId) === String(slackId));
    if (c) return _fromContact(c);
  } catch (e) { logger.warn('[fas-profiles] contact resolve failed: ' + e.message); }
  // LEGACY FALLBACK: a pre-migration slackSenderProfiles entry. Once migration
  // has run (migratedAt set), legacy profiles NO LONGER grant access — a sender
  // with no contact falls through to the limited default. This guarantees a
  // stale legacy profile can't keep authorizing someone after migration.
  try {
    const legacy = _loadProfiles();
    if (!legacy.__migratedAt && legacy[slackId]) return { ...legacy[slackId], source: 'legacy-sender-profile' };
  } catch (_) {}
  return _limitedDefaults(slackId, fallbackName);
}

/** Can this sender view a given data category at all? */
function canViewCategory(profile, category) {
  if (!profile) return false;
  return (profile.allowedDataCategories || []).includes(category);
}

/** Can this sender make a given request type? */
function canRequest(profile, requestType) {
  if (!profile) return false;
  return (profile.permittedRequestTypes || []).includes(requestType);
}

/**
 * scopeUnitForSender(profile, unitRow) -> boolean
 * Enforces operator/domicile scoping. Internal users see everything; external
 * senders only see units for THEIR operators/domiciles. If the sender has no
 * operators/domiciles configured, external senders see nothing fleet-scoped
 * (they can still be answered about a unit only if code decides to allow it).
 */
function scopeUnitForSender(profile, unitRow) {
  if (!profile || !unitRow) return false;
  if (profile.type === 'internal' || profile.type === 'manager') return true;
  const op = (unitRow.operator || '').trim().toUpperCase();
  const dom = (unitRow.domicileSite || unitRow.site || '').trim().toUpperCase();
  const ops = (profile.operators || []).map(s => s.toUpperCase());
  const doms = (profile.domiciles || []).map(s => s.toUpperCase());
  if (ops.length && op && ops.includes(op)) return true;
  if (doms.length && dom && doms.includes(dom)) return true;
  // No matching scope -> deny (conservative). Unknown senders with no scope
  // configured cannot pull fleet-scoped records.
  return false;
}

/**
 * canViewLifecycleChange etc. — authorization summary for the evidence package.
 */
function authorizationSummary(profile) {
  return {
    canView: !!(profile && (profile.allowedDataCategories || []).length),
    canRequestFollowUp: canRequest(profile, 'follow_up'),
    canRequestLifecycleChange: canRequest(profile, 'lifecycle_change'),
    canRequestWR: canRequest(profile, 'create_wr'),
    isInternal: !!(profile && (profile.type === 'internal' || profile.type === 'manager')),
  };
}

// Plain-language summary of what a resolved profile can do (Part 1 UI helper).
function permissionSummary(profile) {
  if (!profile) return 'No access.';
  if (profile.enabled === false) return 'Disabled — no FAS access.';
  const isInternal = profile.type === 'internal' || profile.type === 'manager';
  const cats = (profile.allowedDataCategories || []);
  const scope = isInternal ? 'all fleet units'
    : (profile.operators || []).length || (profile.domiciles || []).length
      ? ([].concat((profile.operators || []).length ? (profile.operators.join('/') + ' units') : [])
           .concat((profile.domiciles || []).length ? ('units at ' + profile.domiciles.join('/')) : []).join(' and '))
      : 'NO fleet-scoped units (no operator/domicile scope set)';
  const canView = cats.length ? ('can view ' + cats.map(c => c.replace(/_/g, ' ')).join(', ')) : 'cannot view fleet data';
  const canLc = canRequest(profile, 'lifecycle_change');
  const canWr = canRequest(profile, 'create_wr');
  const cannot = [];
  if (!canLc) cannot.push('request lifecycle changes');
  if (!canWr) cannot.push('create work requests');
  return 'Can ' + canView + ' for ' + scope + '.' + (cannot.length ? (' Cannot ' + cannot.join(' or ') + '.') : '');
}

// ── MIGRATION: slackSenderProfiles -> Contact Book (Part 1 / MIGRATION) ──────
// Versioned, idempotent. Backs up BOTH stores first. Matches by exact
// normalized slackId; merges FAS permission fields into the matching contact
// WITHOUT overwriting useful info with blanks; creates a new person contact
// only when none exists; never creates duplicates. Records a migration record.
// Re-running produces the same result. After migration, stale legacy profiles
// no longer grant access (resolveSender ignores them once __migratedAt is set).
const MIGRATION_VERSION = 1;
function _genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function migrateSenderProfilesToContacts(opts) {
  opts = opts || {};
  const legacy = _loadProfiles();
  const already = legacy.__migratedAt && legacy.__migrationVersion === MIGRATION_VERSION;
  const contacts = store.load('contacts', []) || [];
  const result = { version: MIGRATION_VERSION, at: new Date().toISOString(), merged: 0, created: 0, conflicts: [], failures: [], alreadyMigrated: !!already };

  // Back up both stores before any change (idempotent — overwrite each run).
  try {
    store.save('contactsBackup', { at: result.at, contacts });
    store.save('slackSenderProfilesBackup', { at: result.at, profiles: legacy });
  } catch (e) { result.failures.push('backup: ' + e.message); }

  const entries = Object.keys(legacy).filter(k => !k.startsWith('__')).map(k => legacy[k]).filter(p => p && p.slackId);
  const bySlack = {};
  contacts.forEach(c => { if (c.slackId) bySlack[String(c.slackId).trim().toUpperCase()] = c; });

  for (const p of entries) {
    try {
      const key = String(p.slackId).trim().toUpperCase();
      const permFields = {
        identityType: VALID_TYPES.includes(p.type) ? p.type : 'unknown',
        operators: (p.operators || []).map(s => String(s).trim().toUpperCase()).filter(Boolean),
        domiciles: (p.domiciles || []).map(s => String(s).trim().toUpperCase()).filter(Boolean),
        allowedDataCategories: (p.allowedDataCategories || []).filter(x => DATA_CATEGORIES.includes(x)),
        permittedRequestTypes: (p.permittedRequestTypes || []).filter(x => REQUEST_TYPES.includes(x)),
        communicationPreferences: (p.commPreferences && typeof p.commPreferences === 'object') ? p.commPreferences : {},
        permissionSource: 'migrated-v' + MIGRATION_VERSION,
        updatedAt: result.at,
      };
      const existing = bySlack[key];
      if (existing) {
        // Merge WITHOUT overwriting useful existing info with blanks.
        if (!existing.name && p.name) existing.name = p.name;
        if (!existing.org && !existing.organization && (p.org)) existing.organization = p.org;
        // Only set identityType if the contact doesn't already have one.
        if (!existing.identityType) existing.identityType = permFields.identityType;
        // Scopes: union (don't drop what the contact already had).
        existing.operators = Array.from(new Set([].concat(existing.operators || [], permFields.operators).map(s => String(s).trim().toUpperCase()).filter(Boolean)));
        existing.domiciles = Array.from(new Set([].concat(existing.domiciles || [], permFields.domiciles).map(s => String(s).trim().toUpperCase()).filter(Boolean)));
        // Permissions: prefer existing explicit permissions if present.
        if (!Array.isArray(existing.allowedDataCategories) && permFields.allowedDataCategories.length) existing.allowedDataCategories = permFields.allowedDataCategories;
        if (!Array.isArray(existing.permittedRequestTypes) && permFields.permittedRequestTypes.length) existing.permittedRequestTypes = permFields.permittedRequestTypes;
        if (!existing.communicationPreferences && Object.keys(permFields.communicationPreferences).length) existing.communicationPreferences = permFields.communicationPreferences;
        if (existing.enabled === undefined) existing.enabled = true;
        existing.permissionSource = permFields.permissionSource;
        existing.updatedAt = result.at;
        result.merged++;
      } else {
        const nc = {
          id: _genId(), type: 'slack', slackId: p.slackId,
          name: p.name || p.slackId, organization: p.org || '',
          role: p.role || '', enabled: true, source: 'migrated-sender-profile',
          createdAt: result.at, ...permFields,
        };
        contacts.push(nc);
        bySlack[key] = nc;
        result.created++;
      }
    } catch (e) { result.failures.push((p && p.slackId) + ': ' + e.message); }
  }

  if (!opts.dryRun) {
    try { store.save('contacts', contacts); } catch (e) { result.failures.push('save contacts: ' + e.message); }
    // Mark legacy store migrated so resolveSender stops honoring it, but KEEP it
    // as a legacy backup (do not delete) until the operator verifies migration.
    try { legacy.__migratedAt = result.at; legacy.__migrationVersion = MIGRATION_VERSION; store.save('slackSenderProfiles', legacy); } catch (e) { result.failures.push('mark legacy: ' + e.message); }
    try { const log = store.load('fasMigrationLog', []); const arr = Array.isArray(log) ? log : []; arr.unshift(result); store.save('fasMigrationLog', arr.slice(0, 50)); } catch (_) {}
  }
  return result;
}

module.exports = {
  DATA_CATEGORIES,
  REQUEST_TYPES,
  resolveSender,
  saveProfile,
  validateProfile,
  canViewCategory,
  canRequest,
  scopeUnitForSender,
  authorizationSummary,
  presetFor,
  permissionSummary,
  migrateSenderProfilesToContacts,
  MIGRATION_VERSION,
};
