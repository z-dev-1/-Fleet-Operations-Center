'use strict';
/**
 * scrapers/aap_lifecycle_api.js — API-based lifecycle flip + DVIR clear.
 *
 * Replaces the fragile BrowserWindow page-automation (setLifecycle.js) with the
 * authenticated AAP JSON API (reuses aap_api.js — same Midway-session client).
 *
 * CONFIRMED FROM LIVE CAPTURE:
 *   - Flip:  PUT /api/v1/assets/  with body { asset: <full asset> }, where the
 *            asset carries its CURRENT `version` (optimistic lock) and the new
 *            lifecycleState / lifecycleStateReason. Response echoes the asset
 *            with a bumped version — the verified read-back.
 *   - Open DVIRs: GET /api/v2/dvir/{aaid}?openIssuesOnly=true -> components[].
 *   - Clear DVIR: POST /api/v1/dvir/{dvirId}/component/{component}
 *            -> response { condition:'DRIVABLE', lifecycle:
 *            'CLOSED_NO_DRIVER_INSPECTION_REQUIRED', hasOpenIssues:false, version }.
 *   - Valid states/reasons: GET /api/v2/userInterface/fields (self-updating).
 *   - Valid DVIR outcomes:  GET /api/v1/dvir/outcomes.
 *
 * SAFETY:
 *   - END_OF_LIFE is BLOCKED at the code level (never sent).
 *   - A flip is only reported successful after a SOURCE read-back confirms the
 *     new state; otherwise EXECUTION_UNCERTAIN. Never a blind success.
 *   - Supported reasons are curated (the operator's set); any reason AAP's live
 *     fields endpoint reports is also accepted (auto-remember); new/unknown
 *     reasons are detected + logged (never silently change behavior).
 *   - Read-only resolution + reads can run anywhere; this module performs the
 *     real mutations only when called by the Digital FAS executor path, which
 *     applies permission/idempotency/cluster gating.
 */

const aap = require('./aap_api');
let logger; try { logger = require('../utils/logger').createLogger('aap-lifecycle-api'); } catch (_) { logger = { info() {}, warn() {} }; }
let store; try { store = require('../store'); } catch (_) { store = null; }

const AAID_RE = /^aaid_[0-9a-f-]{8,}$/i;

// ── Valid-value governance (states + reasons) ─────────────────────────────────

// States this module will apply. END_OF_LIFE deliberately excluded.
const ALLOWED_STATES = ['ACTIVE', 'UNAVAILABLE', 'ORDERED'];
const BLOCKED_STATES = ['END_OF_LIFE'];

// Operator-curated supported reasons (the ones the app actively offers).
const SUPPORTED_REASONS = [
  'HEALTHY', 'OFFSITE_SHOP_REPAIR', 'PM_FAILED', 'PREVENTATIVE_MAINTENANCE',
  'PARTS_DELAY', 'DAMAGED_MODERATE', 'SENSOR_DETECTED_DAMAGE',
  'SAFETY_INSPECTION_POST_ACCIDENT', 'LICENSE_OR_PERMIT_ISSUE',
  'IMPOUNDED_TOW', 'GPS_MALFUNCTIONING', 'CAMPAIGN',
];

// Cache of AAP's live valid lists (auto-remembered from /userInterface/fields).
const LIVE_CACHE_MS = 6 * 60 * 60 * 1000; // refresh at most every 6h
let _liveCache = null; // { states:[], reasons:[], at }

/**
 * refreshValidValues(fleetId) -> { states, reasons, newReasons }
 * Reads AAP's own valid lifecycleState / lifecycleStateReason lists so the
 * system AUTO-REMEMBERS additions/changes. Flags reasons AAP reports that are
 * not yet in SUPPORTED_REASONS (the "something changed" signal). Best-effort.
 */
async function refreshValidValues(fleetId) {
  try {
    const q = fleetId ? ('?fleetId=' + encodeURIComponent(fleetId)) : '';
    const res = await aap.apiGet('/api/v2/userInterface/fields' + q);
    const defs = (res && (res.userInterfaceFieldDefinitionMap || res.fields)) || {};
    const states = _values(defs.lifecycleState) || ALLOWED_STATES;
    const reasons = _values(defs.lifecycleStateReason) || [];
    const newReasons = reasons.filter((r) => !SUPPORTED_REASONS.includes(r) && !BLOCKED_STATES.includes(r));
    _liveCache = { states, reasons, at: Date.now() };
    if (newReasons.length) {
      logger.info('[aap-lifecycle] AAP reports lifecycle reasons not in the supported set: ' + newReasons.join(', '));
      _recordNewReasons(newReasons);
    }
    return { states, reasons, newReasons };
  } catch (e) {
    logger.warn('[aap-lifecycle] refreshValidValues failed: ' + e.message);
    return { states: ALLOWED_STATES, reasons: SUPPORTED_REASONS.slice(), newReasons: [] };
  }
}

function _values(fieldDef) {
  if (!fieldDef) return null;
  if (Array.isArray(fieldDef.values) && fieldDef.values.length) return fieldDef.values.slice();
  if (fieldDef.displayValueMap && typeof fieldDef.displayValueMap === 'object') return Object.keys(fieldDef.displayValueMap);
  return null;
}

// Persist newly-seen reasons so the AI Health board / operator can surface them.
function _recordNewReasons(list) {
  if (!store) return;
  try {
    const cur = store.load('aiTraceLog', []); // reuse trace store? No — keep separate, best-effort log file only.
  } catch (_) {}
  // Lightweight: stash on a dedicated in-memory field + log. (A durable store
  // key can be added later if you want it surfaced in the UI.)
  _liveCache && (_liveCache.newReasons = list);
}

/** getValidReasons() -> AAP's live reason list (cached), else the supported set. */
async function getValidReasons(fleetId) {
  if (_liveCache && (Date.now() - _liveCache.at) < LIVE_CACHE_MS && _liveCache.reasons.length) return _liveCache.reasons.slice();
  const v = await refreshValidValues(fleetId);
  return v.reasons.length ? v.reasons : SUPPORTED_REASONS.slice();
}
/** getSupportedReasons() -> the operator-curated set. */
function getSupportedReasons() { return SUPPORTED_REASONS.slice(); }
/** getValidStates() -> allowed states (END_OF_LIFE filtered). */
async function getValidStates(fleetId) {
  if (_liveCache && (Date.now() - _liveCache.at) < LIVE_CACHE_MS && _liveCache.states.length) {
    return _liveCache.states.filter((s) => !BLOCKED_STATES.includes(s));
  }
  const v = await refreshValidValues(fleetId);
  return (v.states.length ? v.states : ALLOWED_STATES).filter((s) => !BLOCKED_STATES.includes(s));
}

// ── Equipment-number -> aaid resolution ───────────────────────────────────────
// Fleet data keys units by equipment number (e.g. "324040"); the API keys by
// aaid (UUID). Resolve via the cached fleet row's assetUrl/aaid when present,
// else via the asset-search endpoint on displayName/vehicleId.

function _aaidFromRow(row) {
  if (!row) return null;
  if (row.aaid && AAID_RE.test(row.aaid)) return row.aaid;
  // assetUrl often ends in /v2/asset/aaid_... or /assets/aaid_...
  const m = String(row.assetUrl || '').match(/aaid_[0-9a-f-]{8,}/i);
  return m ? m[0] : null;
}

/**
 * resolveAaid(unitOrAaid) -> { aaid, row? } | { error }
 * Accepts an aaid directly, or an equipment number resolved via fleetData /
 * asset search. NEVER guesses — returns an error if it can't resolve exactly.
 */
async function resolveAaid(unitOrAaid) {
  const token = String(unitOrAaid || '').trim();
  if (!token) return { error: 'no unit specified' };
  if (AAID_RE.test(token)) return { aaid: token };

  // Try the local fleet cache first (cheap, no network).
  if (store) {
    try {
      const rows = (store.load('fleetData', {}) || {}).rows || [];
      const u = token.toUpperCase();
      const row = rows.find((r) => String(r.equipmentId || '').trim().toUpperCase() === u);
      const aaid = _aaidFromRow(row);
      if (aaid) return { aaid, row };
    } catch (_) {}
  }

  // Fall back to the asset-search endpoint by displayName / vehicleId.
  try {
    const res = await aap.searchAssets({ query: token });
    const list = (res && (res.assets || res.results || res.content || res.items || res.data)) || [];
    const hit = (Array.isArray(list) ? list : []).map((x) => x.asset || x).find((a) =>
      String(a.attributesText && a.attributesText.vehicleId || '').trim() === token ||
      String(a.displayName || '').trim() === token);
    if (hit && hit.aaid) return { aaid: hit.aaid };
  } catch (e) { logger.warn('[aap-lifecycle] asset search for ' + token + ' failed: ' + e.message); }

  return { error: 'could not resolve unit ' + token + ' to an asset id' };
}

// ── Lifecycle flip (read-modify-write PUT + verified read-back) ───────────────

const _norm = (s) => String(s || '').trim().toUpperCase();

/**
 * setLifecycleApi({ unit|aaid, state, reason }) -> {
 *   ok, status, verified, from, to, version, aaid, error?
 * }
 * status: 'done' (verified) | 'execution_uncertain' | 'failed' | 'noop' | 'blocked'
 *
 * Reads the current asset, sets lifecycle fields + keeps the live version,
 * PUTs the full asset, then VERIFIES via the PUT response AND a fresh GET.
 * Only 'done' is reported when the source confirms the new state.
 */
async function setLifecycleApi(args) {
  args = args || {};
  const state = _norm(args.state);
  const reason = _norm(args.reason);

  // Hard block END_OF_LIFE and any non-allowed state.
  if (BLOCKED_STATES.includes(state)) return { ok: false, status: 'blocked', error: 'state ' + state + ' is not permitted' };
  if (!ALLOWED_STATES.includes(state)) return { ok: false, status: 'failed', error: 'unknown/invalid state: ' + state };

  const r = await resolveAaid(args.aaid || args.unit);
  if (r.error) return { ok: false, status: 'failed', error: r.error };
  const aaid = r.aaid;

  // Validate the reason against AAP's live valid list (auto-remembered).
  let fleetId = null;
  let asset;
  try { asset = await aap.getAsset(aaid); } catch (e) {
    return { ok: false, status: 'failed', aaid, error: 'could not read asset: ' + e.message };
  }
  if (!asset || !asset.aaid) return { ok: false, status: 'failed', aaid, error: 'asset not found' };
  fleetId = asset.fleetId || null;

  const from = { state: asset.lifecycleState || null, reason: asset.lifecycleStateReason || null };

  // Idempotent no-op: already in the target state/reason.
  if (_norm(from.state) === state && (!reason || _norm(from.reason) === reason)) {
    return { ok: true, status: 'noop', verified: true, from, to: { state, reason: reason || from.reason }, version: asset.version, aaid };
  }

  if (reason) {
    const validReasons = await getValidReasons(fleetId);
    if (validReasons.length && !validReasons.includes(reason)) {
      return { ok: false, status: 'failed', aaid, error: 'reason "' + reason + '" is not a valid AAP lifecycle reason' };
    }
  }

  // Read-modify-write: set lifecycle fields on the FULL asset, keep version.
  const updated = { ...asset, lifecycleState: state };
  if (reason) updated.lifecycleStateReason = reason;
  // Mirror into attributesText (the UI sends it in both places).
  if (updated.attributesText && typeof updated.attributesText === 'object') {
    updated.attributesText = { ...updated.attributesText, lifecycleState: state };
    if (reason) updated.attributesText.lifecycleStateReason = reason;
  }

  let putResp;
  try { putResp = await aap.apiPut('/api/v1/assets/', { asset: updated }); }
  catch (e) {
    // Version conflict -> re-read + retry ONCE (someone edited between read+write).
    if (/409|conflict|version/i.test(e.message || '')) {
      try {
        const fresh = await aap.getAsset(aaid);
        const retry = { ...fresh, lifecycleState: state };
        if (reason) retry.lifecycleStateReason = reason;
        if (retry.attributesText) { retry.attributesText = { ...retry.attributesText, lifecycleState: state }; if (reason) retry.attributesText.lifecycleStateReason = reason; }
        putResp = await aap.apiPut('/api/v1/assets/', { asset: retry });
      } catch (e2) { return { ok: false, status: 'failed', aaid, from, error: 'version conflict, retry failed: ' + e2.message }; }
    } else {
      return { ok: false, status: 'failed', aaid, from, error: 'PUT failed: ' + e.message };
    }
  }

  const respAsset = (putResp && (putResp.asset || putResp)) || {};
  const putOk = _norm(respAsset.lifecycleState) === state && (!reason || _norm(respAsset.lifecycleStateReason) === reason);

  // VERIFY via an INDEPENDENT fresh read (source read-back).
  let verified = false, readBack = null;
  try {
    const confirm = await aap.getAsset(aaid);
    readBack = { state: confirm.lifecycleState, reason: confirm.lifecycleStateReason, version: confirm.version };
    verified = _norm(confirm.lifecycleState) === state && (!reason || _norm(confirm.lifecycleStateReason) === reason);
  } catch (e) { logger.warn('[aap-lifecycle] read-back failed for ' + aaid + ': ' + e.message); }

  if (verified) {
    return { ok: true, status: 'done', verified: true, from, to: { state, reason: reason || respAsset.lifecycleStateReason }, version: readBack.version, aaid, sourceReadback: readBack };
  }
  // The PUT may have landed but we can't confirm -> EXECUTION_UNCERTAIN.
  return { ok: false, status: 'execution_uncertain', verified: false, from,
    to: { state, reason }, version: respAsset.version, aaid,
    putReportedOk: putOk, sourceReadback: readBack,
    error: 'could not verify the flip landed (source read-back did not confirm)' };
}

// ── DVIR read + clear ─────────────────────────────────────────────────────────

/**
 * getOpenDvirs(unit|aaid) -> { ok, aaid, open: [{ dvirId, component, condition, lifecycle }], error? }
 * Reads the OPEN DVIR issues for a unit (openIssuesOnly=true).
 */
async function getOpenDvirs(unitOrAaid) {
  const r = await resolveAaid(unitOrAaid);
  if (r.error) return { ok: false, error: r.error };
  const aaid = r.aaid;
  const start = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  let res;
  try { res = await aap.apiGet('/api/v2/dvir/' + encodeURIComponent(aaid) + '?startDate=' + start + '&endDate=' + end + '&openIssuesOnly=true'); }
  catch (e) { return { ok: false, aaid, error: 'DVIR read failed: ' + e.message }; }
  const open = [];
  (res && Array.isArray(res.components) ? res.components : []).forEach((comp) => {
    (comp.items || []).forEach((it) => {
      // An OPEN/blocking issue is one whose lifecycle is an open state (not PASSED).
      const lc = _norm(it.lifecycle);
      const blocking = lc === 'OPEN_ISSUE' || lc === 'PENDING_OPEN_ITEM' || lc === 'PENDING_DRIVER_INSPECTION' || lc === 'WORK_IN_PROGRESS' || _norm(it.condition) === 'NOT_DRIVABLE';
      open.push({ dvirId: it.dvirId, component: it.component, condition: it.condition, lifecycle: it.lifecycle, blocking });
    });
  });
  return { ok: true, aaid, open, blocking: open.filter((o) => o.blocking) };
}

/**
 * clearDvir({ dvirId, component, outcome? }) -> { ok, verified, hasOpenIssues, error? }
 * POST /api/v1/dvir/{dvirId}/component/{component}. Verifies via the response
 * (hasOpenIssues:false). Body defaults to the UI's resolve values; the exact
 * body is confirmable via one write-body capture — DVIR_CLEAR_BODY centralizes it.
 */
const DVIR_CLEAR_BODY = { condition: 'DRIVABLE', lifecycle: 'CLOSED_NO_DRIVER_INSPECTION_REQUIRED', outcome: 'REPAIRS_MADE' };

async function clearDvir(args) {
  args = args || {};
  const dvirId = String(args.dvirId || '').trim();
  const component = String(args.component || '').trim();
  if (!dvirId || !component) return { ok: false, error: 'dvirId and component required' };
  const body = { ...DVIR_CLEAR_BODY };
  if (args.outcome) body.outcome = _norm(args.outcome);
  let resp;
  try { resp = await aap.apiPost('/api/v1/dvir/' + encodeURIComponent(dvirId) + '/component/' + encodeURIComponent(component), body); }
  catch (e) { return { ok: false, dvirId, component, error: 'DVIR clear failed: ' + e.message }; }
  const hasOpen = !!(resp && resp.hasOpenIssues);
  return { ok: !hasOpen, verified: !hasOpen, dvirId, component, hasOpenIssues: hasOpen, lifecycle: resp && resp.lifecycle, version: resp && resp.version };
}

/**
 * clearAllOpenDvirs(unit|aaid) -> { ok, cleared:[], failed:[], remaining }
 * Clears every BLOCKING open DVIR for a unit, then re-reads to confirm none
 * remain. Used as the auto pre-step when a flip-to-ACTIVE is blocked by a DVIR.
 */
async function clearAllOpenDvirs(unitOrAaid) {
  const open = await getOpenDvirs(unitOrAaid);
  if (!open.ok) return { ok: false, error: open.error };
  const targets = open.blocking.length ? open.blocking : open.open;
  const cleared = [], failed = [];
  for (const d of targets) {
    const r = await clearDvir({ dvirId: d.dvirId, component: d.component });
    if (r.ok) cleared.push({ dvirId: d.dvirId, component: d.component });
    else failed.push({ dvirId: d.dvirId, component: d.component, error: r.error });
  }
  // Re-read to confirm none remain (independent verification).
  const after = await getOpenDvirs(open.aaid);
  const remaining = after.ok ? after.blocking.length : null;
  return { ok: failed.length === 0 && (remaining === 0 || remaining == null), cleared, failed, remaining, aaid: open.aaid };
}

/**
 * setLifecycleActiveWithDvir({ unit|aaid, reason }) -> flip result.
 * Flip to ACTIVE; if blocked by an open DVIR, clear the blocking DVIRs first,
 * then retry the flip. Every step is verified. This is the fix for the
 * "DVIR error when making a unit active" problem.
 */
async function setLifecycleActiveWithDvir(args) {
  args = args || {};
  const first = await setLifecycleApi({ unit: args.unit, aaid: args.aaid, state: 'ACTIVE', reason: args.reason || 'HEALTHY' });
  if (first.ok) return first;
  // If it failed and there are open DVIRs, clear them and retry once.
  const open = await getOpenDvirs(args.aaid || args.unit);
  if (open.ok && (open.blocking.length || open.open.length)) {
    logger.info('[aap-lifecycle] flip blocked; clearing ' + (open.blocking.length || open.open.length) + ' DVIR(s) then retrying');
    const clr = await clearAllOpenDvirs(open.aaid);
    const retry = await setLifecycleApi({ aaid: open.aaid, state: 'ACTIVE', reason: args.reason || 'HEALTHY' });
    return { ...retry, dvirCleared: clr.cleared, dvirFailed: clr.failed };
  }
  return first;
}

module.exports = {
  ALLOWED_STATES, BLOCKED_STATES, SUPPORTED_REASONS, DVIR_CLEAR_BODY,
  refreshValidValues, getValidReasons, getSupportedReasons, getValidStates,
  resolveAaid, setLifecycleApi,
  getOpenDvirs, clearDvir, clearAllOpenDvirs, setLifecycleActiveWithDvir,
};
