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

// Wildcard all-scope token (matches every operator/domicile, incl. future).
const ALL_SCOPE = '*';

// Default for anyone we don't recognize = UNKNOWN. Because most unknown senders
// are internal contacts, unknown gets ALL data + ALL request types and ALL
// scope ('*'), but may NOT change lifecycle or create WRs automatically.
function _limitedDefaults(slackId, name) {
  return {
    slackId: slackId || '',
    name: name || slackId || 'Unknown',
    org: '',
    role: 'unknown',
    type: 'unknown',           // internal | carrier | vendor | unknown
    operators: [ALL_SCOPE],
    domiciles: [ALL_SCOPE],
    allowedDataCategories: DATA_CATEGORIES.slice(),
    permittedRequestTypes: REQUEST_TYPES.slice(),
    lifecyclePermission: 'not_allowed',
    createWrPermission: 'not_allowed',
    commPreferences: {},
    source: 'default-limited',
  };
}

// ── Permission PRESETS by identity type (2026-09 simplified model) ───────────
// Every identity gets ALL data categories + ALL request types (data access is
// governed by SCOPE, not category toggles). The meaningful per-contact controls
// are: SCAC/domicile scope, lifecyclePermission (3-state), createWrPermission
// (3-state). Lifecycle + create-WR are NEVER granted by a preset — they default
// to not_allowed and must be set explicitly per contact.
//   - internal / carrier : all data + all requests; operator picks scope.
//   - vendor             : all data + all requests, but lifecycle + create-WR
//                          are LOCKED to not_allowed (mechanic asks, op acts).
//   - unknown            : all data + all requests + ALL scope ('*').
function presetFor(type) {
  return { allowedDataCategories: DATA_CATEGORIES.slice(), permittedRequestTypes: REQUEST_TYPES.slice() };
}

// Default SCOPE for an identity when the contact carries no explicit scope.
// `internal` and `unknown` default to ALL-scope ('*') — broad by default, but
// editable to specific SCAC/domicile. `carrier`/`vendor` (external) default to
// EMPTY = no data until explicitly scoped ("empty external scope = NO access").
function _defaultScopeFor(type) {
  return (type === 'unknown' || type === 'internal') ? [ALL_SCOPE] : [];
}

// Infer identityType from a raw contact when not explicitly set. IMPORTANT: an
// UNTRIAGED Slack contact (type:'slack' with no explicit identityType) must NOT
// be treated as a carrier — that would grant a carrier preset to an unknown DM
// sender. Only an Amazon org/email is safely inferred as internal; a declared
// vendor is vendor; everything else is UNKNOWN (safe default) until an operator
// sets the identity in the Contact Book.
function _inferType(c) {
  if (VALID_TYPES.includes(c.identityType)) return c.identityType;
  if (VALID_TYPES.includes(c.type) && c.type !== 'slack') return c.type;
  if ((c.org && /amazon/i.test(c.org)) || /amazon\.com$/i.test(c.email || '')) return 'internal';
  if (c.type === 'vendor') return 'vendor';
  // A contact that has been explicitly SCOPED to specific operators/domiciles is
  // clearly a carrier (that scope only makes sense for one). But an UNTRIAGED
  // contact with NO scope (e.g. an auto-discovered DM sender) stays UNKNOWN so
  // it never gets a carrier preset by accident.
  const hasScope = (Array.isArray(c.operators) && c.operators.length) ||
    (Array.isArray(c.domiciles) && c.domiciles.length) ||
    (typeof c.domiciles === 'string' && c.domiciles.trim()) || c.operator;
  if (hasScope) return 'carrier';
  return 'unknown';
}

// Resolve a FAS permission profile from a `contacts` store entry. The Contact
// Book is the SINGLE source of truth (Part 1): if the contact carries explicit
// FAS permission fields (allowedDataCategories/permittedRequestTypes) they win;
// otherwise a preset for the identity type is applied. A disabled contact
// (enabled === false) grants NO access.
function _fromContact(c) {
  const type = _inferType(c);
  // Normalize scope, PRESERVING the '*' all-scope wildcard.
  const normScope = (arr) => {
    const out = Array.from(new Set(arr.map(s => String(s).trim()).filter(Boolean)
      .map(s => s === ALL_SCOPE ? ALL_SCOPE : s.toUpperCase())));
    return out.includes(ALL_SCOPE) ? [ALL_SCOPE] : out;
  };
  let domiciles = normScope([]
    .concat(c.domiciles ? (Array.isArray(c.domiciles) ? c.domiciles : String(c.domiciles).split(/[\s,]+/)) : [])
    .concat(Array.isArray(c.domicileList) ? c.domicileList : []));
  let operators = normScope([]
    .concat(Array.isArray(c.operators) ? c.operators : [])
    .concat(c.operator ? [c.operator] : []));
  // If the resolved scope is empty, apply the identity's default scope.
  // internal/unknown default to all-scope ('*'); carrier/vendor stay empty
  // (= no data until explicitly scoped).
  if (!operators.length && !domiciles.length) {
    const def = _defaultScopeFor(type);
    operators = def.slice(); domiciles = def.slice();
  }
  const preset = presetFor(type);
  // Disabled contact -> revoke all FAS authorization immediately.
  const disabled = c.enabled === false;
  const hasExplicitCats = Array.isArray(c.allowedDataCategories);
  const hasExplicitReqs = Array.isArray(c.permittedRequestTypes);
  // VENDOR LOCK: mechanics can never be trusted/autonomous for lifecycle or WR
  // creation — force both to not_allowed no matter what the contact stored.
  const isVendor = type === 'vendor';
  const three = (v) => (['not_allowed', 'may_request', 'trusted_autonomous'].includes(v) ? v : 'not_allowed');
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
    // Lifecycle + create-WR are 3-state, explicit-only, and disabled/vendor ->
    // not_allowed. 'trusted_autonomous' only honored when explicitly set on a
    // non-vendor contact.
    lifecyclePermission: (disabled || isVendor) ? 'not_allowed' : three(c.lifecyclePermission),
    createWrPermission: (disabled || isVendor) ? 'not_allowed' : three(c.createWrPermission),
    commPreferences: (c.communicationPreferences && typeof c.communicationPreferences === 'object') ? c.communicationPreferences : (c.commPreferences || {}),
    source: 'contact-book',
  };
}

// Load the explicit profile store (edited via settings UI), keyed by slackId.
function _loadProfiles() {
  const raw = store.load('slackSenderProfiles', {});
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

const VALID_TYPES = ['internal', 'carrier', 'vendor', 'unknown'];

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

/** Can this sender make a given request type?
 * lifecycle_change + create_wr are gated by their dedicated 3-state fields
 * (not just membership in permittedRequestTypes): anything other than
 * not_allowed counts as "may request" for the purpose of proposing/asking. */
function canRequest(profile, requestType) {
  if (!profile) return false;
  if (profile.enabled === false) return false; // disabled -> no access at all
  // Internal actors have full request authority (they ARE the operator).
  if (profile.type === 'internal') return true;
  if (requestType === 'lifecycle_change') return (profile.lifecyclePermission || 'not_allowed') !== 'not_allowed';
  if (requestType === 'create_wr') return (profile.createWrPermission || 'not_allowed') !== 'not_allowed';
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
  const ops = (profile.operators || []).map(s => String(s).toUpperCase());
  const doms = (profile.domiciles || []).map(s => String(s).toUpperCase());
  // All-scope wildcard: an operator OR domicile of '*' matches every unit
  // (default for unknown/internal; can be set on any identity explicitly).
  if (ops.includes(ALL_SCOPE) || doms.includes(ALL_SCOPE)) return true;
  // internal with NO narrowing scope = all fleet (broad by default). Once an
  // internal contact is given specific SCAC/domicile, it is restricted to them.
  if (profile.type === 'internal' && !ops.length && !doms.length) return true;
  const op = (unitRow.operator || '').trim().toUpperCase();
  const dom = (unitRow.domicileSite || unitRow.site || '').trim().toUpperCase();
  if (ops.length && op && ops.includes(op)) return true;
  if (doms.length && dom && doms.includes(dom)) return true;
  // No matching scope -> deny (conservative). A contact with empty scope
  // (carrier/internal/vendor that hasn't been scoped) sees NO fleet-scoped data.
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
    isInternal: !!(profile && profile.type === 'internal'),
  };
}

// Plain-language summary of what a resolved profile can do (Contact Book UI).
function permissionSummary(profile) {
  if (!profile) return 'No access.';
  if (profile.enabled === false) return 'Disabled — no FAS access.';
  const ops = (profile.operators || []);
  const doms = (profile.domiciles || []);
  const allScope = ops.includes(ALL_SCOPE) || doms.includes(ALL_SCOPE);
  const cats = (profile.allowedDataCategories || []);
  let scope;
  if (allScope) scope = 'all fleet units (all SCAC + all domiciles)';
  else if (ops.length || doms.length) {
    scope = [].concat(ops.length ? (ops.join('/') + ' units') : [])
              .concat(doms.length ? ('units at ' + doms.join('/')) : []).join(' and ');
  } else scope = 'NO fleet-scoped units (no SCAC/domicile scope set)';
  const canView = cats.length ? ('can view ' + cats.map(c => c.replace(/_/g, ' ')).join(', ')) : 'cannot view fleet data';
  const lp = profile.lifecyclePermission || 'not_allowed';
  const wp = profile.createWrPermission || 'not_allowed';
  const cap = (label, v) => v === 'trusted_autonomous' ? (label + ': trusted (autonomous)')
    : v === 'may_request' ? (label + ': may request (approval)') : null;
  let out = 'Can ' + canView + ' for ' + scope + '.';
  const canCaps = [cap('lifecycle changes', lp), cap('work requests', wp)].filter(Boolean);
  if (canCaps.length) out += ' ' + canCaps.join('; ') + '.';
  const cannotCaps = [];
  if (lp === 'not_allowed') cannotCaps.push('change lifecycle');
  if (wp === 'not_allowed') cannotCaps.push('create work requests');
  if (cannotCaps.length) out += ' Cannot ' + cannotCaps.join(' or ') + '.';
  return out;
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
  const at = new Date().toISOString();
  const result = { version: MIGRATION_VERSION, at, merged: 0, created: 0, conflicts: [], failures: [], alreadyMigrated: !!already, dryRun: !!opts.dryRun, noop: false };

  // (1) TRUE NO-OP if this version already completed: return WITHOUT rewriting
  //     contacts, backups, timestamps, or logs. Re-running is safe.
  if (already && !opts.force) { result.noop = true; return result; }

  // (2) Take an IMMUTABLE, VERSIONED backup exactly ONCE (never overwrite the
  //     original pre-migration backup). A dry run performs NO writes at all.
  const backupKey = 'fasMigrationBackup_v' + MIGRATION_VERSION;
  if (!opts.dryRun) {
    const existingBackup = store.load(backupKey, null);
    if (!existingBackup) {
      try {
        store.save(backupKey, { version: MIGRATION_VERSION, at,
          contacts: store.load('contacts', []) || [],
          slackSenderProfiles: legacy });
      } catch (e) {
        // (3) ABORT if backup fails — do not touch contacts or legacy.
        result.failures.push('backup: ' + e.message);
        result.aborted = 'backup-failed';
        return result;
      }
    }
  }

  const contacts = (store.load('contacts', []) || []).map(c => ({ ...c }));
  const entries = Object.keys(legacy).filter(k => !k.startsWith('__')).map(k => legacy[k]).filter(p => p && p.slackId);
  const bySlack = {};
  contacts.forEach(c => { if (c.slackId) bySlack[String(c.slackId).trim().toUpperCase()] = c; }); // case-insensitive

  for (const p of entries) {
    try {
      const key = String(p.slackId).trim().toUpperCase();
      const permFields = {
        identityType: VALID_TYPES.includes(p.type) ? p.type : 'unknown',
        operators: (p.operators || []).map(s => String(s).trim().toUpperCase()).filter(Boolean),
        domiciles: (p.domiciles || []).map(s => String(s).trim().toUpperCase()).filter(Boolean),
        allowedDataCategories: (p.allowedDataCategories || []).filter(x => DATA_CATEGORIES.includes(x)),
        permittedRequestTypes: (p.permittedRequestTypes || []).filter(x => REQUEST_TYPES.includes(x)),
        lifecyclePermission: ['not_allowed', 'may_request', 'trusted_autonomous'].includes(p.lifecyclePermission) ? p.lifecyclePermission : 'not_allowed',
        createWrPermission: ['not_allowed', 'may_request', 'trusted_autonomous'].includes(p.createWrPermission) ? p.createWrPermission : 'not_allowed',
        communicationPreferences: (p.commPreferences && typeof p.commPreferences === 'object') ? p.commPreferences : {},
        permissionSource: 'migrated-v' + MIGRATION_VERSION,
        updatedAt: at,
      };
      const existing = bySlack[key];
      if (existing) {
        // Merge WITHOUT overwriting useful existing info with blanks.
        if (!existing.name && p.name) existing.name = p.name;
        if (!existing.org && !existing.organization && (p.org)) existing.organization = p.org;
        if (!existing.identityType) existing.identityType = permFields.identityType;
        existing.operators = Array.from(new Set([].concat(existing.operators || [], permFields.operators).map(s => String(s).trim().toUpperCase()).filter(Boolean)));
        existing.domiciles = Array.from(new Set([].concat(existing.domiciles || [], permFields.domiciles).map(s => String(s).trim().toUpperCase()).filter(Boolean)));
        if (!Array.isArray(existing.allowedDataCategories) && permFields.allowedDataCategories.length) existing.allowedDataCategories = permFields.allowedDataCategories;
        if (!Array.isArray(existing.permittedRequestTypes) && permFields.permittedRequestTypes.length) existing.permittedRequestTypes = permFields.permittedRequestTypes;
        if (!existing.communicationPreferences && Object.keys(permFields.communicationPreferences).length) existing.communicationPreferences = permFields.communicationPreferences;
        if (existing.enabled === undefined) existing.enabled = true;
        existing.permissionSource = permFields.permissionSource;
        existing.updatedAt = at;
        result.merged++;
      } else {
        const nc = {
          id: _genId(), type: 'slack', slackId: p.slackId,
          name: p.name || p.slackId, organization: p.org || '',
          role: p.role || '', enabled: true, source: 'migrated-sender-profile',
          createdAt: at, ...permFields,
        };
        contacts.push(nc);
        bySlack[key] = nc;
        result.created++;
      }
    } catch (e) { result.failures.push((p && p.slackId) + ': ' + e.message); }
  }

  // (4) DRY RUN: report what WOULD happen; write nothing.
  if (opts.dryRun) return result;

  // (5) Save contacts and VERIFY the save succeeded BEFORE marking legacy
  //     migrated. If contacts save/verify fails, keep honoring legacy profiles
  //     (do NOT mark migrated) so authorization is never silently lost.
  let saved = false;
  try {
    store.save('contacts', contacts);
    const back = store.load('contacts', []) || [];
    saved = back.length >= contacts.length; // verify persisted
  } catch (e) { result.failures.push('save contacts: ' + e.message); }

  if (!saved) {
    result.aborted = 'contacts-save-failed';
    result.rollback = { backupKey }; // legacy remains authoritative
    try { const log = store.load('fasMigrationLog', []); const arr = Array.isArray(log) ? log : []; arr.unshift(result); store.save('fasMigrationLog', arr.slice(0, 50)); } catch (_) {}
    return result; // legacy NOT marked migrated -> resolveSender keeps honoring it
  }

  // Contacts saved + verified -> now it's safe to mark legacy migrated.
  try { legacy.__migratedAt = at; legacy.__migrationVersion = MIGRATION_VERSION; store.save('slackSenderProfiles', legacy); } catch (e) { result.failures.push('mark legacy: ' + e.message); }
  try { const log = store.load('fasMigrationLog', []); const arr = Array.isArray(log) ? log : []; arr.unshift(result); store.save('fasMigrationLog', arr.slice(0, 50)); } catch (_) {}
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
