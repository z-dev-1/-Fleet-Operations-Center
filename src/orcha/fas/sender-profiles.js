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

// Infer a profile from a `contacts` store entry.
function _fromContact(c) {
  const type = c.type === 'vendor' ? 'vendor'
    : (c.org && /amazon/i.test(c.org)) || /amazon\.com$/i.test(c.email || '') ? 'internal'
    : c.type === 'slack' ? 'carrier'
    : 'unknown';
  // Vendors carry `domiciles` (space/comma separated); carriers may carry operators.
  const domiciles = []
    .concat(c.domiciles ? String(c.domiciles).split(/[\s,]+/) : [])
    .concat(Array.isArray(c.domicileList) ? c.domicileList : [])
    .map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const operators = []
    .concat(Array.isArray(c.operators) ? c.operators : [])
    .concat(c.operator ? [c.operator] : [])
    .map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const isInternal = type === 'internal';
  return {
    slackId: c.slackId || '',
    name: c.name || c.company || c.slackId || 'Unknown',
    org: c.org || c.company || '',
    role: c.role || (type === 'vendor' ? 'vendor' : type === 'internal' ? 'internal' : 'partner'),
    type,
    operators,
    domiciles,
    // Internal users see broad categories; external (carrier/vendor) are scoped
    // to their own operators/domiciles and a narrower category set.
    allowedDataCategories: isInternal ? DATA_CATEGORIES.slice() : ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'],
    permittedRequestTypes: isInternal ? REQUEST_TYPES.slice() : ['unit_status', 'repair_update', 'follow_up', 'process_question'],
    commPreferences: {},
    source: 'contacts-seed',
  };
}

// Load the explicit profile store (edited via settings UI), keyed by slackId.
function _loadProfiles() {
  const raw = store.load('slackSenderProfiles', {});
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

function saveProfile(profile) {
  if (!profile || !profile.slackId) return { ok: false, error: 'slackId required' };
  const all = _loadProfiles();
  all[profile.slackId] = { ...all[profile.slackId], ...profile, updatedAt: new Date().toISOString() };
  store.save('slackSenderProfiles', all);
  return { ok: true, profile: all[profile.slackId] };
}

/**
 * resolveSender(slackId, fallbackName) -> profile
 * Precedence: explicit profile store > contacts seed > limited default.
 */
function resolveSender(slackId, fallbackName) {
  if (!slackId) return _limitedDefaults('', fallbackName);
  const profiles = _loadProfiles();
  if (profiles[slackId]) return { ...profiles[slackId] };
  try {
    const contacts = store.load('contacts', []) || [];
    const c = contacts.find(x => x.slackId && x.slackId === slackId);
    if (c) return _fromContact(c);
  } catch (e) { logger.warn('[fas-profiles] contact seed failed: ' + e.message); }
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

module.exports = {
  DATA_CATEGORIES,
  REQUEST_TYPES,
  resolveSender,
  saveProfile,
  canViewCategory,
  canRequest,
  scopeUnitForSender,
  authorizationSummary,
};
