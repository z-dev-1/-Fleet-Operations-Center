/**
 * relay-actions.js — Unit detail Relay/AAP action modals.
 *
 * WR cards get "⚠ Escalate" and "💬 Add Relay Comment"; the unit header gets
 * "⟳ Change Lifecycle". Each opens a compact modal.js modal. Every write goes
 * through the gated bridge only (window.relayWrites.escalate / addComment /
 * changeLifecycle -> relay:* IPC -> write-gate.requestWrite -> approval modal).
 * The raw ungated writes (aapApi.updateEscalations, aap.setLifecycle) are never
 * called here. Drafting (relayWrites.draftAction / draftComment) only fills the
 * text box; it never sends.
 *
 * The action modal calls modal.close() BEFORE awaiting the gated IPC, because
 * the approval modal (relay-write-approval.js) waits while another modal.js
 * modal is open, and modal.js is a singleton.
 *
 * Pure helpers, HTML builders and openers are exported for tests. All deps are
 * injectable: { modal, bridge, aapApi, confirm, toast, verifyLifecycle }.
 * This module must not import unit-detail.js (ESM cycle).
 */

import modalDefault from '../components/modal.js';

// ── constants ───────────────────────────────────────────────────────────────
// Same keys/labels as src/writes/relay-action-policy.js ESCALATION_TARGETS.
export const RG_TARGETS = Object.freeze([
  { key: 'FAS', label: 'FAS', aliases: ['FAS'] },
  { key: 'MCS_LEAD', label: 'MCS Lead', aliases: ['MCS_LEAD'] },
  { key: 'MCS_HIGH_VALUE_ESTIMATE', label: 'MCS High Value Estimate', aliases: ['HIGH_VALUE_ESTIMATE', 'MCS_HVE'] },
  { key: 'MCS_REACTIVATION', label: 'MCS Reactivation', aliases: ['REACTIVATION'] },
  { key: 'TOM_PENDING_ACTION', label: 'TOM Pending Action', aliases: ['TOM_PENDING'] },
  { key: 'DOCUMENT_REQUEST', label: 'Document Request', aliases: ['DOCUMENTS_REQUEST', 'DOC_REQUEST'] },
  { key: 'MCS_RECOVERY_SIM_POST_REPAIR', label: 'MCS Recovery SIM Post Repair', aliases: ['RECOVERY_SIM_POST_REPAIR'] },
  { key: 'MCS_CARRIER_UPDATE_REQUEST', label: 'MCS Carrier Update Request', aliases: ['CARRIER_UPDATE_REQUEST'] },
]);
export const TOWING_NOTE = 'Towing goes through a SIM, not RG escalation.';
export const HVE_HINT = 'confirm threshold with MCS lead';
export const REACTIVATION_HINT = 'use on the most recent RG event';
export const COMMENT_TEMPLATES = Object.freeze([
  { id: 'offsite-update', label: 'Offsite Update' },
  { id: 'update-request', label: 'Update Request' },
  { id: 'free-form', label: 'Free-form' },
]);
export const ESC_MAX = 2000;

const HVE_KEY = 'MCS_HIGH_VALUE_ESTIMATE';
const REACT_KEY = 'MCS_REACTIVATION';
const CARRIER_KEY = 'MCS_CARRIER_UPDATE_REQUEST';
const STALE_MS = 24 * 3600 * 1000;
const WR_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LC_FALLBACK_STATES = ['ACTIVE', 'UNAVAILABLE', 'ORDERED'];
// Same list as unit-detail's Actions-pane #dp-lc-reason options.
const LC_REASON_LABELS = {
  HEALTHY: 'Healthy',
  OFFSITE_SHOP_REPAIR: 'Off-site Shop Repair',
  PM_FAILED: 'PM Failed',
  PREVENTATIVE_MAINTENANCE: 'Preventative Maintenance',
  PARTS_DELAY: 'Parts Delay',
  DAMAGED_MODERATE: 'Damaged - Moderate',
  SENSOR_DETECTED_DAMAGE: 'Sensor Detected Damage',
  SAFETY_INSPECTION_POST_ACCIDENT: 'Safety Inspection Post Accident',
  LICENSE_OR_PERMIT_ISSUE: 'License or Permit Issue',
  IMPOUNDED_TOW: 'Impounded / Tow',
  GPS_MALFUNCTIONING: 'GPS Malfunctioning',
  CAMPAIGN: 'Campaign',
};
const DRAFT_FIELDS = ['equipmentId', 'workRequestId', 'serviceUrl', 'vendor', 'subVendor', 'dealerName', 'savedRepairStatus',
  'serviceState', 'subState', 'lifecycleState', 'lifecycleReason', 'issueSummary', 'issueDetails', 'repairTimeline',
  'savedNotes', 'fullConversation', 'asistNotes', 'created', 'offsiteStage', 'offsiteStageDetail', 'offsiteStageSince',
  'escalations', 'estimatePendingCost', 'vendorWorkOrderId', 'offsiteShopEventUrl', 'savedOffsiteUrl', 'asistSrUrl',
  'asistScrapedAt', 'scrapedAt', 'geofence', 'domicileSite', 'savedPrimaryComponent', 'level1', 'serviceCategory', 'urgent'];

// ── pure helpers ────────────────────────────────────────────────────────────
function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function _norm(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function isTowingOption(o) {
  const x = o || {};
  return /TOW/.test(_norm(x.value)) || /TOW/.test(_norm(x.displayText));
}

// Map the 8 RG types to the LIVE AAP options. A type AAP did not list stays
// disabled with value null, so a value AAP did not list is never sent.
export function resolveTargetOptions(liveOptions) {
  const live = (Array.isArray(liveOptions) ? liveOptions : [])
    .filter((o) => o && String(o.value || '').trim() && !isTowingOption(o));
  return RG_TARGETS.map((t) => {
    const names = new Set([t.key, _norm(t.label)].concat(t.aliases));
    const hit = live.find((o) => names.has(_norm(o.value)) || names.has(_norm(o.displayText)));
    const value = hit ? String(hit.value).trim() : null;
    return { key: t.key, label: t.label, value, disabled: !value };
  });
}

function _wrIsOpen(w) {
  return !w.completed && !/complet|closed|cancel/i.test(String(w.serviceState || ''));
}

export function wrCardActionRowHtml(wr) {
  const w = wr || {};
  const id = String(w.workRequestId || '').trim();
  if (!WR_UUID_RE.test(id) || !_wrIsOpen(w)) return '';
  return '<div class="dp-ra-row">' +
    '<button type="button" class="dp-escalate__btn dp-ra-btn" data-ra-escalate="' + escAttr(id) + '">\u26A0 Escalate</button>' +
    '<button type="button" class="dp-escalate__btn dp-ra-btn" data-ra-comment="' + escAttr(id) + '">\uD83D\uDCAC Add Relay Comment</button>' +
  '</div>';
}

export function headerLifecycleButtonHtml(unit) {
  if (!unit || !unit.assetUrl) return '';
  // Icon-only, same size as the AAP / Relay / Portal / Daily launchers it sits with.
  return '<button type="button" id="dp-lc-change" class="dp-launcher" title="Change Lifecycle" aria-label="Change Lifecycle">\u27F3</button>';
}

// The unit's known estimate amount for the HVE field (AAP estimatePendingCost), or 0.
export function unitEstAmount(unit) {
  const v = (unit || {}).estimatePendingCost;
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '') || NaN) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A planned/secondary WR carries its pending estimate as totalCost (same mapping as
// main relay-comment-draft rowForWr).
function _wrEstAmount(unit, wrId) {
  const w = wrUnitOf(unit, wrId);
  if (w === unit) return unitEstAmount(w);
  return unitEstAmount(w) || unitEstAmount({ estimatePendingCost: w.totalCost });
}

// The plain string fields sent over IPC (main re-validates and caps them).
export function relayActionDraftUnit(unit) {
  const u = unit || {};
  const out = {};
  for (const k of DRAFT_FIELDS) {
    const v = u[k];
    if (typeof v === 'string') out[k] = v;
    else if (k === 'estimatePendingCost' && typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

export function stateLabel(s) {
  const k = _norm(s);
  if (k === 'ACTIVE') return 'Active';
  if (k === 'UNAVAILABLE') return 'Unavailable';
  if (k === 'ORDERED') return 'Ordered';
  return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export function lifecycleConfirmText(unitId, cur, next) {
  return 'Change ' + unitId + ' ' + cur + ' \u2192 ' + next + ' in AAP?';
}

export function outcomeMessage(r, what) {
  const o = (r && r.outcome) || '';
  const w = what || 'Write';
  if (o === 'sent') return { level: 'success', text: w + ' sent.' };
  if (o === 'pending-approval') return { level: 'info', text: 'Queued in Relay writes. Approve it there to send.' };
  if (o === 'skipped-not-approved') return { level: 'info', text: 'Not sent.' };
  return { level: 'error', text: w + ' failed: ' + ((r && (r.error || r.code)) || 'unknown') };
}

// Same rule as main relay-action-draft toCaps: keep <FILL: …>, URLs and 'Xh Ym'.
const CAPS_SPLIT_RE = /(<FILL: [^>]*>|https?:\/\/\S+|\b\d+h \d+m\b)/;
export function toCapsKeepFills(text) {
  return String(text == null ? '' : text).split(CAPS_SPLIT_RE).map((p, i) => (i % 2 ? p : p.toUpperCase())).join('');
}

export function aaidOf(unit) {
  const u = unit || {};
  if (u.aaid) return String(u.aaid).trim();
  const m = String(u.assetUrl || '').match(/\/v2\/asset\/([^/?#]+)/);
  return m ? m[1] : '';
}

function _currentList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[;,]/);
  const out = [];
  arr.forEach((x) => {
    const s = String((x && typeof x === 'object') ? (x.value || '') : (x == null ? '' : x)).trim();
    if (s && !out.includes(s)) out.push(s);
  });
  return out;
}

function _fmtAsOf(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// Free-form drafts come from relay:draft-comment, which has no freshness block.
export function localFreshnessWarnings(unit, now) {
  const u = unit || {};
  const t = now == null ? Date.now() : now;
  const out = [];
  const one = (ts, what) => {
    const ms = Date.parse(ts || '');
    if (!Number.isFinite(ms)) { out.push(what + ' freshness unknown'); return; }
    if (t - ms > STALE_MS) out.push(what + ' is ' + Math.floor((t - ms) / 3600000) + ' h old (' + _fmtAsOf(ms) + ') \u2014 may be stale');
  };
  one(u.asistScrapedAt, 'Offsite notes');
  one(u.scrapedAt, 'Relay row');
  if (!String(u.fullConversation || '').trim()) out.push('No Relay conversation loaded');
  return out;
}

// The fields of WR `wrId` for local checks: the unit itself for its primary WR, else the
// matching planned/secondary entry plus the unit's row scrape time (same rule as main rowForWr).
export function wrUnitOf(unit, wrId) {
  const u = unit || {};
  const want = String(wrId || '').toLowerCase();
  if (!want || String(u.workRequestId || '').toLowerCase() === want) return u;
  const entries = [u._plannedWRData].concat(Array.isArray(u._secondaryWRs) ? u._secondaryWRs : []);
  const e = entries.find((x) => x && String(x.workRequestId || '').toLowerCase() === want);
  return e ? Object.assign({ scrapedAt: u.scrapedAt }, e) : u;
}

// ── body builders ───────────────────────────────────────────────────────────
const NOTE_APPROVE = '<p class="ra-hint">You approve the exact text before anything is sent.</p>';

export function escalationModalBody({ targets, current, labelOf, estAmount } = {}) {
  const amt = Number(estAmount) > 0 ? String(Number(estAmount)) : '0';
  const ts = Array.isArray(targets) ? targets : resolveTargetOptions([]);
  const cur = Array.isArray(current) ? current : [];
  const lab = typeof labelOf === 'function' ? labelOf : (v) => v;
  const opts = '<option value=""></option>' + ts.map((t) =>
    '<option value="' + escAttr(t.key) + '"' + (t.disabled ? ' disabled' : '') + '>' +
      escAttr(t.label + (t.disabled ? ' (not offered for this fleet)' : '')) + '</option>').join('');
  const chips = cur.length
    ? cur.map((v) => '<span class="dp-escalate__chip">' + escAttr(lab(v)) +
        ' <button type="button" class="dp-ra-btn" data-ra-remove="' + escAttr(v) + '">Remove</button></span>').join(' ')
    : '<span class="ra-hint">No current escalations.</span>';
  return '<div class="ra-modal ra-modal--esc">' +
    '<label>Escalate to <select id="ra-esc-target" class="detail-panel__select">' + opts + '</select></label>' +
    '<div id="ra-esc-current" class="ra-current">Current: ' + chips + '</div>' +
    '<div id="ra-esc-hve" hidden>Est amount $ <input id="ra-esc-amount" type="number" min="0" step="0.01" value="' + escAttr(amt) + '"> ' +
      '<span class="ra-hint">' + escAttr(HVE_HINT) + '</span></div>' +
    '<div id="ra-esc-reactivation-hint" class="ra-hint" hidden>' + escAttr(REACTIVATION_HINT) + '</div>' +
    '<textarea id="ra-esc-reason" class="dp-escalate__comment" maxlength="' + ESC_MAX + '" rows="6" aria-label="Escalation reason" placeholder="Reason (internal only)"></textarea>' +
    '<div class="dp-escalate__row"><button type="button" id="ra-esc-draft" class="dp-escalate__btn dp-ra-btn">Draft with AI</button>' +
      '<span id="ra-esc-count" class="dp-escalate__count">0/' + ESC_MAX + '</span></div>' +
    '<div id="ra-stale" class="ra-stale" role="status"></div>' +
    '<div id="ra-fills" class="ra-fill-note"></div>' +
    '<p class="ra-hint">' + escAttr(TOWING_NOTE) + '</p>' +
    NOTE_APPROVE +
  '</div>';
}

export function commentModalBody() {
  return '<div class="ra-modal ra-modal--cm">' +
    '<label>Template <select id="ra-cm-template" class="detail-panel__select">' +
      COMMENT_TEMPLATES.map((t) => '<option value="' + escAttr(t.id) + '">' + escAttr(t.label) + '</option>').join('') +
    '</select></label>' +
    '<textarea id="ra-cm-text" class="dp-escalate__comment" maxlength="' + ESC_MAX + '" rows="7" aria-label="Internal Relay comment" placeholder="Internal comment for the Relay WR"></textarea>' +
    '<div class="dp-escalate__row"><button type="button" id="ra-cm-draft" class="dp-escalate__btn dp-ra-btn">Draft with AI</button>' +
      '<span id="ra-cm-count" class="dp-escalate__count">0/' + ESC_MAX + '</span></div>' +
    '<div id="ra-stale" class="ra-stale" role="status"></div>' +
    '<div id="ra-fills" class="ra-fill-note"></div>' +
    '<p class="ra-hint">Posts an INTERNAL comment (internal only, not shared with the vendor).</p>' +
    NOTE_APPROVE +
  '</div>';
}

function _reasonList(reasons) {
  const src = Array.isArray(reasons) && reasons.length ? reasons : Object.keys(LC_REASON_LABELS);
  return src.map((r) => {
    const v = String((r && typeof r === 'object') ? (r.value || '') : r).trim();
    const l = (r && typeof r === 'object' && r.label) || LC_REASON_LABELS[v] || stateLabel(v);
    return { value: v, label: l };
  }).filter((r) => r.value);
}

function _stateList(states) {
  const src = Array.isArray(states) && states.length ? states : LC_FALLBACK_STATES;
  const out = [];
  src.forEach((s) => {
    if (_norm(s) === 'END_OF_LIFE') return;
    const l = stateLabel(s);
    if (l && !out.includes(l)) out.push(l);
  });
  return out;
}

export function lifecycleModalBody({ unitId, current, states, reasons } = {}) {
  const cur = stateLabel(current);
  const sts = _stateList(states);
  const rs = _reasonList(reasons);
  return '<div class="ra-modal ra-modal--lc">' +
    '<div>Unit ' + escAttr(unitId) + ' \u00B7 Current: <b>' + escAttr(cur || 'Unknown') + '</b></div>' +
    '<label>New state <select id="ra-lc-state" class="detail-panel__select">' +
      sts.map((l) => '<option value="' + escAttr(l) + '"' + (_norm(l) === _norm(cur) ? ' selected' : '') + '>' + escAttr(l) + '</option>').join('') +
    '</select></label> ' +
    '<label>Reason <select id="ra-lc-reason" class="detail-panel__select">' +
      rs.map((r) => '<option value="' + escAttr(r.value) + '">' + escAttr(r.label) + '</option>').join('') +
    '</select></label>' +
    '<p class="ra-hint">You will confirm, then approve, before AAP changes.</p>' +
  '</div>';
}

// ── openers ─────────────────────────────────────────────────────────────────
function _deps(deps) {
  const d = deps || {};
  const w = typeof window !== 'undefined' ? window : {};
  return {
    modal: d.modal || modalDefault,
    bridge: d.bridge || w.relayWrites || null,
    aapApi: d.aapApi || w.aapApi || null,
    confirm: d.confirm || ((m) => (typeof w.confirm === 'function' ? w.confirm(m) : false)),
    toast: d.toast || { show() {} },
    verifyLifecycle: d.verifyLifecycle || null,
  };
}

function _renderDraftNotes(q, warnings, placeholders) {
  const st = q('#ra-stale');
  const fl = q('#ra-fills');
  const w = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  const p = Array.isArray(placeholders) ? placeholders.filter(Boolean) : [];
  if (st) st.textContent = w.length ? '\u26A0 ' + w.join(' \u00B7 ') : '';
  if (fl) fl.textContent = p.length ? 'Fill before sending: ' + p.map((x) => '<FILL: ' + x + '>').join(', ') : '';
}

function _wireCount(ta, cnt, onInput) {
  if (!ta) return;
  const upd = () => { if (cnt) cnt.textContent = String(ta.value || '').length + '/' + ESC_MAX; };
  ta.addEventListener('input', () => { upd(); if (onInput) onInput(); });
  return upd;
}

function _draftErr(r) {
  const c = (r && (r.code || r.error)) || 'unknown';
  if (c === 'busy') return 'An AI draft for this WR is already running.';
  if (c === 'wr-mismatch') return 'AI draft unavailable: the WR does not match this unit.';
  return 'AI draft failed: ' + c;
}

// opts.initialTarget: an RG target key to pre-select when AAP offers it (e.g. the Pending
// Estimates overlay passes MCS_HIGH_VALUE_ESTIMATE). Pre-selecting never drafts or sends.
export async function openEscalationModal(unit, wrId, deps, opts = {}) {
  const d = _deps(deps);
  const o0 = opts || {};
  const u = unit || {};
  const title = 'Escalate WR ' + String(wrId || '').slice(0, 8);
  const aaid = aaidOf(u);
  let ctx = null;
  let why = '';
  if (!aaid) why = 'No AAP asset id for this unit, so escalation teams could not be loaded.';
  else if (!d.aapApi || typeof d.aapApi.escalationOptions !== 'function') why = 'Could not load escalation teams (bridge unavailable).';
  else {
    try { ctx = await d.aapApi.escalationOptions({ aaid, workRequestId: wrId }); } catch (e) { ctx = { ok: false, error: e && e.message }; }
    if (!ctx || !ctx.ok) why = 'Could not load escalation teams' + (ctx && ctx.error ? ': ' + ctx.error : '.');
    else if (!ctx.enabled) why = 'Escalation is not enabled for your AAP user.';
  }
  if (why) {
    d.modal.show({ title, width: 480, body: '<p>' + escAttr(why) + '</p>',
      actions: [{ label: 'Close', cls: '', onClick: () => d.modal.close() }] });
    return;
  }

  const targets = resolveTargetOptions(ctx.options);
  const current = _currentList(ctx.current);
  const labels = new Map();
  (Array.isArray(ctx.options) ? ctx.options : []).forEach((o) => {
    if (o && o.value) labels.set(String(o.value), String(o.displayText || o.value));
  });
  const labelOf = (v) => labels.get(v) || v;

  let q = () => null;
  let aiDrafted = false;
  let userTyped = false;
  let amountTyped = false;
  let drafting = false;
  let sending = false;

  async function send(add, remove, comment, what) {
    if (sending) return;
    sending = true;
    d.modal.close();
    d.toast.show('info', 'Waiting for your approval\u2026', 3000);
    let r;
    try {
      r = await d.bridge.escalate({ workRequestId: wrId, aaid, add, remove, comment, unit: u.equipmentId, aiDrafted: add.length ? aiDrafted : false });
    } catch (e) { r = { ok: false, error: e && e.message }; }
    const o = outcomeMessage(r, what);
    d.toast.show(o.level, o.text);
  }

  function submit() {
    const tEl = q('#ra-esc-target');
    const rEl = q('#ra-esc-reason');
    const t = targets.find((x) => x.key === (tEl && tEl.value));
    const comment = String((rEl && rEl.value) || '').trim();
    if (!t) { d.toast.show('warn', 'Pick an escalation target.'); return; }
    if (!t.value) { d.toast.show('warn', t.label + ' is not offered for this fleet.'); return; }
    if (!comment) { d.toast.show('warn', 'A reason is required to escalate.'); if (rEl && rEl.focus) rEl.focus(); return; }
    if (comment.length > ESC_MAX) { d.toast.show('warn', 'Reason must be ' + ESC_MAX + ' characters or fewer.'); return; }
    if (current.includes(t.value)) { d.toast.show('warn', 'That escalation is already applied.'); return; }
    return send([t.value], [], comment, 'Escalation');
  }

  function remove(value) {
    const rEl = q('#ra-esc-reason');
    const comment = userTyped ? String((rEl && rEl.value) || '').trim() : '';
    if (value === CARRIER_KEY && !comment) {
      d.toast.show('warn', 'Add a reason comment to remove Carrier Update Request');
      if (rEl && rEl.focus) rEl.focus();
      return;
    }
    if (comment.length > ESC_MAX) { d.toast.show('warn', 'Reason must be ' + ESC_MAX + ' characters or fewer.'); return; }
    return send([], [value], comment, 'Escalation removal');
  }

  async function draft() {
    const tEl = q('#ra-esc-target');
    const rEl = q('#ra-esc-reason');
    const btn = q('#ra-esc-draft');
    const key = (tEl && tEl.value) || '';
    if (!key) { d.toast.show('warn', 'Pick an escalation target first.'); return; }
    if (drafting) return;
    if (!d.bridge || typeof d.bridge.draftAction !== 'function') { d.toast.show('error', 'AI draft failed: Relay writes bridge unavailable.'); return; }
    if (rEl && String(rEl.value || '').trim() && !d.confirm('Replace the reason text with an AI draft?')) return;
    drafting = true;
    if (btn) btn.disabled = true;
    let r;
    try {
      // Only a typed amount is sent; untouched, main uses the unit's own estimate
      // (offsite / Relay Garage, then AAP) or leaves the EST part out.
      const amt = amountTyped ? (Number((q('#ra-esc-amount') || {}).value) || 0) : 0;
      r = await d.bridge.draftAction({ kind: 'escalation', target: key, workRequestId: wrId,
        unit: relayActionDraftUnit(u), userInputs: { estAmount: amt } });
    } catch (e) { r = { ok: false, error: e && e.message }; }
    finally { drafting = false; if (btn) btn.disabled = false; }
    if (!r || !r.ok) { d.toast.show('error', _draftErr(r)); return; }
    if (rEl) rEl.value = String(r.draft || '').slice(0, ESC_MAX);
    aiDrafted = true;
    userTyped = false;
    _renderDraftNotes(q, r.freshness && r.freshness.warnings, r.placeholders);
    if (upd) upd();
    d.toast.show('info', 'AI draft inserted. Review it and fill any <FILL: \u2026> before you submit.');
  }

  let upd = null;
  d.modal.show({
    title, width: 560,
    body: escalationModalBody({ targets, current, labelOf, estAmount: _wrEstAmount(u, wrId) }),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => d.modal.close() },
      { label: 'Submit escalation', cls: 'primary', onClick: () => submit() },
    ],
    onMount(panel) {
      q = (s) => (panel && panel.querySelector ? panel.querySelector(s) : null);
      const tEl = q('#ra-esc-target');
      const hve = q('#ra-esc-hve');
      const rh = q('#ra-esc-reactivation-hint');
      if (tEl) tEl.addEventListener('change', () => {
        if (hve) hve.hidden = tEl.value !== HVE_KEY;
        if (rh) rh.hidden = tEl.value !== REACT_KEY;
      });
      if (tEl && o0.initialTarget && targets.some((t) => t.key === o0.initialTarget && !t.disabled)) {
        tEl.value = o0.initialTarget;
        if (hve) hve.hidden = tEl.value !== HVE_KEY;
        if (rh) rh.hidden = tEl.value !== REACT_KEY;
      }
      const aEl = q('#ra-esc-amount');
      if (aEl) aEl.addEventListener('input', () => { amountTyped = true; });
      const rEl = q('#ra-esc-reason');
      upd = _wireCount(rEl, q('#ra-esc-count'), () => {
        userTyped = true;
        if (!String(rEl.value || '').trim()) aiDrafted = false;
      });
      const db = q('#ra-esc-draft');
      if (db) db.addEventListener('click', () => draft());
      const chips = panel && panel.querySelectorAll ? panel.querySelectorAll('[data-ra-remove]') : [];
      Array.prototype.forEach.call(chips || [], (b) => {
        b.addEventListener('click', () => remove(b.getAttribute('data-ra-remove')));
      });
    },
  });
}

export async function openCommentModal(unit, wrId, deps) {
  const d = _deps(deps);
  const u = unit || {};
  let q = () => null;
  let aiDrafted = false;
  let drafting = false;
  let sending = false;
  let upd = null;

  async function draft() {
    const tpl = (q('#ra-cm-template') || {}).value || 'offsite-update';
    const ta = q('#ra-cm-text');
    const btn = q('#ra-cm-draft');
    if (drafting) return;
    if (!d.bridge) { d.toast.show('error', 'AI draft failed: Relay writes bridge unavailable.'); return; }
    if (ta && String(ta.value || '').trim() && !d.confirm('Replace the comment text with an AI draft?')) return;
    drafting = true;
    if (btn) btn.disabled = true;
    let r;
    let text = '';
    let warnings = [];
    let placeholders = [];
    try {
      if (tpl === 'free-form') {
        r = await d.bridge.draftComment(wrId, relayActionDraftUnit(u));
        if (r && r.ok) { text = toCapsKeepFills(r.draft || ''); warnings = localFreshnessWarnings(wrUnitOf(u, wrId)); }
      } else {
        r = await d.bridge.draftAction({ kind: 'comment', template: tpl, workRequestId: wrId,
          unit: relayActionDraftUnit(u), userInputs: {} });
        if (r && r.ok) { text = String(r.draft || ''); warnings = (r.freshness && r.freshness.warnings) || []; placeholders = r.placeholders || []; }
      }
    } catch (e) { r = { ok: false, error: e && e.message }; }
    finally { drafting = false; if (btn) btn.disabled = false; }
    if (!r || !r.ok) { d.toast.show('error', _draftErr(r)); return; }
    if (!text.trim()) { d.toast.show('info', 'AI returned no draft for this WR.'); return; }
    if (ta) ta.value = text.slice(0, ESC_MAX);
    aiDrafted = true;
    _renderDraftNotes(q, warnings, placeholders);
    if (upd) upd();
    d.toast.show('info', 'AI draft inserted. Review it and fill any <FILL: \u2026> before you submit.');
  }

  async function submit() {
    const ta = q('#ra-cm-text');
    const text = String((ta && ta.value) || '').trim();
    if (!text) { d.toast.show('warn', 'Write a comment first.'); return; }
    if (text.length > ESC_MAX) { d.toast.show('warn', 'Comment must be ' + ESC_MAX + ' characters or fewer.'); return; }
    if (sending) return;
    sending = true;
    d.modal.close();
    d.toast.show('info', 'Waiting for your approval\u2026', 3000);
    let r;
    try {
      r = aiDrafted
        ? await d.bridge.addComment(wrId, text, u.equipmentId, { aiDrafted: true })
        : await d.bridge.addComment(wrId, text, u.equipmentId);
    } catch (e) { r = { ok: false, error: e && e.message }; }
    const o = outcomeMessage(r, 'Relay comment');
    if (r && r.outcome === 'sent') {
      o.text = 'Internal comment posted to Relay WR ' + String(wrId || '').slice(0, 8) + '. It appears in the Relay conversation after the next refresh.';
    }
    d.toast.show(o.level, o.text);
  }

  d.modal.show({
    title: 'Add Relay comment \u2014 WR ' + String(wrId || '').slice(0, 8),
    width: 560,
    body: commentModalBody(),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => d.modal.close() },
      { label: 'Submit comment', cls: 'primary', onClick: () => submit() },
    ],
    onMount(panel) {
      q = (s) => (panel && panel.querySelector ? panel.querySelector(s) : null);
      const ta = q('#ra-cm-text');
      upd = _wireCount(ta, q('#ra-cm-count'), () => { if (!String(ta.value || '').trim()) aiDrafted = false; });
      const db = q('#ra-cm-draft');
      if (db) db.addEventListener('click', () => draft());
    },
  });
}

export async function openLifecycleModal(unit, deps) {
  const d = _deps(deps);
  const u = unit || {};
  let opts = null;
  try {
    if (d.bridge && typeof d.bridge.lifecycleOptions === 'function') opts = await d.bridge.lifecycleOptions({});
  } catch (_) { opts = null; }
  const states = (opts && opts.ok && Array.isArray(opts.states) && opts.states.length) ? opts.states : LC_FALLBACK_STATES;
  const reasons = (opts && opts.ok && Array.isArray(opts.reasons) && opts.reasons.length) ? opts.reasons : Object.keys(LC_REASON_LABELS);
  const reasonValues = _reasonList(reasons).map((r) => r.value);
  const current = stateLabel(u.lifecycleState) || 'Unknown';
  let q = () => null;
  let sending = false;

  async function submit() {
    const next = (q('#ra-lc-state') || {}).value || '';
    const reason = String((q('#ra-lc-reason') || {}).value || '').trim();
    if (!next) { d.toast.show('warn', 'Pick a lifecycle state.'); return; }
    if (_norm(next) === _norm(current)) { d.toast.show('warn', 'The unit is already ' + current + '. Pick a different state.'); return; }
    if (!d.confirm(lifecycleConfirmText(u.equipmentId, current, next))) return;
    if (sending) return;
    sending = true;
    d.modal.close();
    d.toast.show('info', 'Waiting for your approval\u2026', 3000);
    let r;
    try {
      r = await d.bridge.changeLifecycle({ equipmentId: u.equipmentId, assetUrl: u.assetUrl, state: next, reason,
        fromState: current, confirmed: true });
    } catch (e) { r = { ok: false, error: e && e.message }; }
    if (r && r.outcome === 'send-failed' && r.result && r.result.message) r = Object.assign({}, r, { error: r.result.message });
    const o = outcomeMessage(r, 'Lifecycle change');
    d.toast.show(o.level, o.text);
    if (r && r.outcome === 'sent' && typeof d.verifyLifecycle === 'function') {
      let ok = false;
      try { ok = await d.verifyLifecycle(u, next, reason); } catch (_) { ok = false; }
      if (ok) d.toast.show('success', 'Lifecycle ' + next + ' confirmed live in AAP.');
      else d.toast.show('warn', 'Lifecycle change sent, but could not confirm it live in AAP yet.');
    }
  }

  d.modal.show({
    title: 'Change lifecycle \u2014 ' + (u.equipmentId || ''),
    width: 480,
    body: lifecycleModalBody({ unitId: u.equipmentId, current, states, reasons }),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => d.modal.close() },
      { label: 'Change lifecycle', cls: 'primary', onClick: () => submit() },
    ],
    onMount(panel) {
      q = (s) => (panel && panel.querySelector ? panel.querySelector(s) : null);
      const sEl = q('#ra-lc-state');
      const rEl = q('#ra-lc-reason');
      // Same auto-reason rule as unit-detail _wireLifecycleForm.
      if (sEl && rEl) sEl.addEventListener('change', () => {
        const st = String(sEl.value || '').toLowerCase();
        const want = st === 'active' ? 'HEALTHY' : (st.includes('unavail') ? 'OFFSITE_SHOP_REPAIR' : '');
        if (want && reasonValues.includes(want)) rEl.value = want;
      });
    },
  });
}

// ── wiring ──────────────────────────────────────────────────────────────────
export function wireRelayActions(root, unit, deps) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const d = _deps(deps);
  let opening = false;
  const run = async (fn) => {
    if (opening) return;
    opening = true;
    try { await fn(); } catch (e) { d.toast.show('error', 'Could not open: ' + ((e && e.message) || 'unknown')); }
    finally { opening = false; }
  };
  Array.prototype.forEach.call(root.querySelectorAll('[data-ra-escalate]') || [], (b) => {
    b.addEventListener('click', () => run(() => openEscalationModal(unit, b.getAttribute('data-ra-escalate'), d)));
  });
  Array.prototype.forEach.call(root.querySelectorAll('[data-ra-comment]') || [], (b) => {
    b.addEventListener('click', () => run(() => openCommentModal(unit, b.getAttribute('data-ra-comment'), d)));
  });
  const lc = typeof root.querySelector === 'function' ? root.querySelector('#dp-lc-change') : null;
  if (lc) lc.addEventListener('click', () => run(() => openLifecycleModal(unit, d)));
}
