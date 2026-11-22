/**
 * aperia-bulk-modal.js — Aperia bulk / full-fleet tire tool (opened from the
 * Aperia panel's "Bulk / fleet tires" button). Pattern: dtna-bulk-modal.js.
 *
 * Opening reads aperia.status() only. "Look up" calls aperia.bulk({ list })
 * with the pasted unit list; "Pull full fleet" asks for confirmation first and
 * then calls aperia.fleetTires({}). Progress events are filtered by the jobId
 * the call returned. The bulk results table comes from the final progress
 * event's rows; Save TSV / Save Excel call exportBulk({ jobId, format,
 * domicile }). Sign out (Aperia panel) stops a running pull. Subscriptions are
 * dropped when the modal closes.
 */
import bus from '../bus.js';
import modal from '../components/modal.js';
import { aperiaPill } from '../components/aperia-pill-logic.js';
import { filterByDomicile } from './aperia-issues-modal.js';

const _aperia = () => (typeof window !== 'undefined' && window.aperia) || null;

const _esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const LIST_MAX = 500;
const ID_RE = /^[A-Za-z0-9#_.-]{1,40}$/;

/**
 * parseUnitList(text) -> { list, overflow, invalid }. Splits on whitespace,
 * commas and semicolons, trims, drops entries the IPC would reject, de-dupes
 * case-insensitively (first spelling kept) and caps at LIST_MAX; overflow is
 * the number of unique entries past the cap.
 */
export function parseUnitList(text) {
  const parts = String(text == null ? '' : text).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const list = [];
  let overflow = 0;
  let invalid = 0;
  for (const p of parts) {
    if (!ID_RE.test(p)) { invalid++; continue; }
    const k = p.toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (list.length < LIST_MAX) list.push(p); else overflow++;
  }
  return { list, overflow, invalid };
}

/** "done / total · N failed" for an aperia:progress payload. */
export function progressText(p) {
  const n = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const q = p || {};
  return n(q.done) + ' / ' + n(q.total) + ' \u00b7 ' + n(q.failed) + ' failed';
}

const FLAG_CLASS = {
  'CRITICAL LOW': 'critical', 'LOW': 'low', 'HIGH': 'high', 'STALE': 'stale',
  'NO READING': 'noread', 'SENSOR FAULT': 'fault', 'OK': 'ok',
};
const _v = (x) => (x == null || x === '' ? '\u2014' : _esc(x));

/** resultsHtml(rows) -> the bulk results table (export tire rows). */
export function resultsHtml(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '<div class="dp-empty">No rows.</div>';
  return '<table class="aperia-issues aperia-bulk-table"><thead><tr>' +
    '<th>Unit</th><th>Domicile</th><th>Position</th><th>PSI</th><th>Target</th><th>\u0394</th><th>Read (ET)</th><th>Flag</th><th>Issue</th><th>Lookup</th>' +
    '</tr></thead><tbody>' +
    list.map((r) => {
      const x = r || {};
      const flag = String(x.flag || '');
      const flagHtml = flag ? '<span class="dp-aperia-flag dp-aperia-flag--' + (FLAG_CLASS[flag] || 'none') + '">' + _esc(flag) + '</span>' : '\u2014';
      return '<tr>' +
        '<td>' + _v(x.unit) + '</td><td>' + _v(x.domicile) + '</td><td>' + _v(x.positionName || x.position) + '</td>' +
        '<td>' + _v(x.pressurePsi) + '</td><td>' + _v(x.setPointPsi) + '</td><td>' + _v(x.deltaPsi) + '</td>' +
        '<td>' + _v(x.readAtEt) + '</td><td>' + flagHtml + '</td>' +
        '<td>' + _v([x.issueSeverity, x.issueType].filter(Boolean).join(' ')) + '</td><td>' + _v(x.lookup) + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table>';
}

const BODY =
  '<div class="aperia-bulk">' +
    '<div style="margin-bottom:8px">Status: <b id="aperia-bulk-state">Aperia \u2026</b></div>' +
    '<div style="margin-bottom:8px">Paste unit numbers (spaces, commas, semicolons or one per line; up to 500). Nothing runs until you press a button. Sign out in the Aperia panel stops a running pull.</div>' +
    '<textarea id="aperia-bulk-list" rows="5" style="width:100%" placeholder="122269, NP6923 ..."></textarea>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">' +
      '<button type="button" class="btn primary" id="aperia-bulk-lookup">Look up</button>' +
      '<button type="button" class="btn" id="aperia-bulk-fleet">Pull full fleet</button>' +
    '</div>' +
    '<progress id="aperia-bulk-progress" max="1" value="0" style="width:100%"></progress>' +
    '<div id="aperia-bulk-progress-text">0 / 0 \u00b7 0 failed</div>' +
    '<div id="aperia-bulk-msg" style="margin:6px 0"></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
      '<select id="aperia-bulk-domicile" disabled><option value="">All domiciles</option></select>' +
      '<button type="button" class="btn" id="aperia-bulk-save-tsv" disabled>Save TSV</button>' +
      '<button type="button" class="btn" id="aperia-bulk-save-xls" disabled>Save Excel</button>' +
    '</div>' +
    '<div id="aperia-bulk-results"></div>' +
  '</div>';

const MESSAGES = {
  APERIA_SIGNIN_REQUIRED: 'Aperia sign-in needed. Sign in from the Aperia pill, then try again.',
  APERIA_SESSION_EXPIRED: 'Aperia session expired. Sign in from the Aperia pill, then try again.',
  APERIA_BUSY: 'An Aperia pull is already running.',
  APERIA_INVALID_INPUT: 'The unit list has an entry Aperia cannot look up.',
};
const _msgFor = (code) => MESSAGES[code] || ('Aperia pull failed (' + String(code || 'unknown') + ')');

const FLEET_CONFIRM = 'Pull tires for the full Aperia fleet? That is about 8,800 units, one read each, and takes several minutes. Sign out in the Aperia panel stops it.';

export function openAperiaBulkModal(deps) {
  const d = deps || {};
  const ap = d.aperia !== undefined ? d.aperia : _aperia();
  const m = d.modal || modal;
  const b = d.bus || bus;
  const confirmFn = d.confirm || ((t) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(t) : false));
  const toast = (type, message, duration) => { try { b.emit('ui:toast', { type, message, duration }); } catch (_) {} };

  let root = null;
  let jobId = null;
  let kind = null;
  let running = false;
  let finished = false;
  let rows = [];
  let domicile = '';
  const unsubs = [];
  const q = (sel) => (root ? root.querySelector(sel) : null);
  const setMsg = (t) => { const el = q('#aperia-bulk-msg'); if (el) el.textContent = t || ''; };
  const refreshButtons = () => {
    for (const id of ['#aperia-bulk-lookup', '#aperia-bulk-fleet']) { const el = q(id); if (el) el.disabled = running || !ap; }
    for (const id of ['#aperia-bulk-save-tsv', '#aperia-bulk-save-xls']) { const el = q(id); if (el) el.disabled = !(finished && jobId); }
  };
  const renderResults = () => {
    const el = q('#aperia-bulk-results');
    if (!el) return;
    if (!finished) { el.innerHTML = ''; return; }
    if (kind === 'fleet') { el.innerHTML = '<div class="dp-empty">Full-fleet results are in the saved file (Save TSV / Save Excel).</div>'; return; }
    el.innerHTML = resultsHtml(filterByDomicile(rows, domicile));
  };
  const fillDomiciles = (list) => {
    const sel = q('#aperia-bulk-domicile');
    if (!sel) return;
    const doms = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x);
    sel.innerHTML = '<option value="">All domiciles</option>' + doms.map((x) => '<option value="' + _esc(x) + '">' + _esc(x) + '</option>').join('');
    sel.value = '';
    sel.disabled = !doms.length;
    domicile = '';
  };
  const onProgress = (p) => {
    if (!p || !jobId || p.jobId !== jobId) return;
    const bar = q('#aperia-bulk-progress');
    if (bar) {
      bar.setAttribute('max', String(Number(p.total) || 1));
      bar.setAttribute('value', String(Number(p.done) || 0));
    }
    const txt = q('#aperia-bulk-progress-text'); if (txt) txt.textContent = progressText(p);
    if (p.finished) {
      running = false;
      finished = true;
      rows = Array.isArray(p.rows) ? p.rows : [];
      fillDomiciles(p.domiciles);
      if (p.code) setMsg(_msgFor(p.code));
      else if (p.cancelled) setMsg('Stopped (signed out). Partial results kept.');
      else setMsg('Done.');
      renderResults();
    }
    refreshButtons();
  };
  const begin = (k, call, note) => {
    const tail = note ? ' (' + note + ')' : '';
    running = true; finished = false; jobId = null; kind = k; rows = [];
    setMsg('Starting\u2026' + tail);
    renderResults();
    refreshButtons();
    Promise.resolve().then(call).then((r) => {
      if (r && r.ok && r.jobId) { jobId = r.jobId; setMsg('Pulling\u2026' + tail); }
      else { running = false; setMsg(_msgFor(r && r.code)); }
      refreshButtons();
    }).catch(() => { running = false; setMsg(_msgFor('APERIA_INTERNAL')); refreshButtons(); });
  };
  const lookup = () => {
    if (!ap || running) return;
    const ta = q('#aperia-bulk-list');
    const parsed = parseUnitList(ta ? ta.value : '');
    if (!parsed.list.length) { setMsg('Paste at least one unit number.'); return; }
    const notes = [];
    if (parsed.overflow) notes.push(parsed.overflow + ' over the ' + LIST_MAX + ' limit skipped');
    if (parsed.invalid) notes.push(parsed.invalid + ' invalid entr' + (parsed.invalid === 1 ? 'y' : 'ies') + ' skipped');
    begin('bulk', () => ap.bulk({ list: parsed.list }), notes.join('; '));
  };
  const fleet = () => {
    if (!ap || running) return;
    let ok = false;
    try { ok = !!confirmFn(FLEET_CONFIRM); } catch (_) { ok = false; }
    if (!ok) return;
    begin('fleet', () => ap.fleetTires({}));
  };
  const save = (format) => {
    if (!ap || !finished || !jobId) return;
    Promise.resolve().then(() => ap.exportBulk({ jobId, format, domicile })).then((r) => {
      if (r && r.ok) toast('success', 'Saved ' + r.filename + ' to Downloads', 4000);
      else toast('error', 'Aperia export failed (' + String((r && r.code) || 'unknown') + ')', 4000);
    }).catch(() => toast('error', 'Aperia export failed', 4000));
  };

  m.show({
    title: 'Aperia bulk tires',
    width: 760,
    body: BODY,
    onMount: (el) => {
      root = el;
      if (!ap) setMsg('Aperia is not available in this build');
      const on = (sel, ev, fn) => { const x = q(sel); if (x) x.addEventListener(ev, fn); };
      on('#aperia-bulk-lookup', 'click', lookup);
      on('#aperia-bulk-fleet', 'click', fleet);
      on('#aperia-bulk-save-tsv', 'click', () => save('tsv'));
      on('#aperia-bulk-save-xls', 'click', () => save('xls'));
      on('#aperia-bulk-domicile', 'change', () => { const s = q('#aperia-bulk-domicile'); domicile = (s && s.value) || ''; renderResults(); });
      refreshButtons();
      if (!ap) return;
      try { if (typeof ap.onProgress === 'function') unsubs.push(ap.onProgress(onProgress)); } catch (_) {}
      try { Promise.resolve(ap.status()).then((s) => { const x = q('#aperia-bulk-state'); if (x) x.textContent = aperiaPill(s).text; }).catch(() => {}); } catch (_) {}
    },
    onClose: () => {
      for (const u of unsubs.splice(0)) { try { if (typeof u === 'function') u(); } catch (_) {} }
      root = null;
    },
  });
}
