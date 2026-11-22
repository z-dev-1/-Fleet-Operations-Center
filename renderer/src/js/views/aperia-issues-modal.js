/**
 * aperia-issues-modal.js — Aperia tire issues view (opened from the Aperia
 * panel's "Tire issues" button). Pattern: dtna-bulk-modal.js + modal.js.
 *
 * Opening reads aperia.status() only. Load calls aperia.issues({ type }) once
 * for the chosen view: 'active' (every open Aperia tire issue) or
 * 'critical-no-case' (units with a non-muted CRITICAL issue and no open DTNA
 * case in the local DTNA cache). Sorting and the domicile filter run in the
 * renderer; Save TSV / Save Excel call exportBulk({ jobId, format, domicile })
 * so the file matches the filter.
 */
import bus from '../bus.js';
import modal from '../components/modal.js';
import { aperiaPill, fmtEt } from '../components/aperia-pill-logic.js';

const _aperia = () => (typeof window !== 'undefined' && window.aperia) || null;

const _esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SEVERITY_RANK = { CRITICAL: 3, MAJOR: 2, MINOR: 1 };

/** severityRank(sev) -> CRITICAL 3, MAJOR 2, MINOR 1, anything else 0. */
export function severityRank(sev) {
  return SEVERITY_RANK[String(sev == null ? '' : sev).toUpperCase()] || 0;
}

function _ms(v) {
  const ms = Date.parse(String(v == null ? '' : v));
  return Number.isFinite(ms) ? ms : -Infinity;
}
function _list(v) { return Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v); }

// Sort value per column key (active rows and critical-no-case rows).
const SORT_VALUE = {
  severity: (r) => severityRank(r.severity),
  unit: (r) => String(r.fleetVehicleId || ''),
  domicile: (r) => String(r.domicile || ''),
  state: (r) => (r.state != null ? String(r.state) : _list(r.states)),
  position: (r) => (r.positionName || r.position ? String(r.positionName || r.position) : _list(r.positions)),
  detected: (r) => _ms(r.dateDetected || r.latestDetected),
  criticalCount: (r) => (typeof r.criticalCount === 'number' ? r.criticalCount : 0),
};

/** sortIssueRows(rows, key, dir) -> new array sorted by column key, dir 'asc' | 'desc' (stable). */
export function sortIssueRows(rows, key, dir) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const val = SORT_VALUE[key] || ((r) => (r && r[key] != null ? r[key] : ''));
  const sign = dir === 'desc' ? -1 : 1;
  return list.sort((a, b) => {
    const x = val(a || {});
    const y = val(b || {});
    if (typeof x === 'number' && typeof y === 'number') return x === y ? 0 : (x < y ? -sign : sign);
    return sign * String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' });
  });
}

/** filterByDomicile(rows, d) -> rows whose domicile equals d; every row when d is empty. */
export function filterByDomicile(rows, d) {
  const list = Array.isArray(rows) ? rows : [];
  if (!d) return list.slice();
  return list.filter((r) => r && r.domicile === d);
}

const COLUMNS = {
  'active': [
    ['severity', 'Severity'], ['unit', 'Unit'], ['domicile', 'Domicile'], ['state', 'State'],
    ['position', 'Position'], ['detected', 'Detected ET'],
  ],
  'critical-no-case': [
    ['unit', 'Unit'], ['domicile', 'Domicile'], ['criticalCount', 'Critical'], ['state', 'States'],
    ['position', 'Positions'], ['detected', 'Latest detected ET'], ['inFleet', 'In fleet'], ['closedDtnaCases', 'Closed DTNA cases'],
  ],
};

function _cellHtml(type, key, r) {
  if (key === 'severity') {
    return '<span class="dp-aperia-sev dp-aperia-sev--' + _esc(String(r.severity || '').toLowerCase()) + '">' + _esc(r.severity || '') + '</span>';
  }
  if (key === 'unit') return _esc(r.fleetVehicleId || '');
  if (key === 'domicile') return _esc(r.domicile || '');
  if (key === 'state') {
    const s = r.state != null ? String(r.state) : _list(r.states);
    return _esc(s.replace(/_/g, ' ')) + (r.muted === true ? ' <span class="aperia-muted">(muted)</span>' : '');
  }
  if (key === 'position') return _esc(r.positionName || r.position ? (r.positionName || r.position) : _list(r.positions));
  if (key === 'detected') return _esc(type === 'active' ? r.detectedEt || '' : r.latestDetectedEt || '');
  if (key === 'inFleet') return r.inFleet ? 'YES' : 'NO';
  return _esc(r[key] == null ? '' : r[key]);
}

/** tableHtml(type, rows, sort) -> the issues table markup (headers carry data-aperia-sort). */
export function tableHtml(type, rows, sort) {
  const cols = COLUMNS[type] || COLUMNS.active;
  const s = sort || {};
  if (!rows.length) return '<div class="dp-empty">No rows.</div>';
  return '<table class="aperia-issues"><thead><tr>' +
    cols.map(([k, label]) => {
      const sortable = k !== 'inFleet' && k !== 'closedDtnaCases';
      const mark = s.key === k ? (s.dir === 'desc' ? ' \u25bc' : ' \u25b2') : '';
      return sortable ? '<th data-aperia-sort="' + k + '">' + _esc(label) + mark + '</th>' : '<th>' + _esc(label) + '</th>';
    }).join('') +
    '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + cols.map(([k]) => '<td>' + _cellHtml(type, k, r || {}) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>';
}

const BODY =
  '<div class="aperia-issues-modal">' +
    '<div style="margin-bottom:8px">Status: <b id="aperia-issues-state">Aperia \u2026</b></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
      '<select id="aperia-issues-view">' +
        '<option value="active" selected>Active issues</option>' +
        '<option value="critical-no-case">Tire critical, no repair case</option>' +
      '</select>' +
      '<button type="button" class="btn primary" id="aperia-issues-load">Load</button>' +
      '<select id="aperia-issues-domicile" disabled><option value="">All domiciles</option></select>' +
    '</div>' +
    '<div style="margin-bottom:8px">"Tire critical, no repair case" lists units with a CRITICAL Aperia issue and no open case in your last DTNA pull. Nothing loads until you press Load.</div>' +
    '<div id="aperia-issues-msg" style="margin:6px 0"></div>' +
    '<div id="aperia-issues-table"></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
      '<button type="button" class="btn" id="aperia-issues-save-tsv" disabled>Save TSV</button>' +
      '<button type="button" class="btn" id="aperia-issues-save-xls" disabled>Save Excel</button>' +
    '</div>' +
  '</div>';

const MESSAGES = {
  APERIA_SIGNIN_REQUIRED: 'Aperia sign-in needed. Sign in from the Aperia pill, then Load again.',
  APERIA_SESSION_EXPIRED: 'Aperia session expired. Sign in from the Aperia pill, then Load again.',
  APERIA_BUSY: 'An Aperia pull is already running.',
};
const _msgFor = (code) => MESSAGES[code] || ('Aperia issues failed (' + String(code || 'unknown') + ')');

export function openAperiaIssuesModal(deps) {
  const d = deps || {};
  const ap = d.aperia !== undefined ? d.aperia : _aperia();
  const m = d.modal || modal;
  const b = d.bus || bus;
  const toast = (type, message, duration) => { try { b.emit('ui:toast', { type, message, duration }); } catch (_) {} };

  let root = null;
  let loading = false;
  let jobId = null;
  let type = 'active';
  let rows = [];
  let domicile = '';
  let sort = { key: 'severity', dir: 'desc' };
  const q = (sel) => (root ? root.querySelector(sel) : null);
  const setMsg = (t) => { const el = q('#aperia-issues-msg'); if (el) el.textContent = t || ''; };
  const refreshButtons = () => {
    const load = q('#aperia-issues-load'); if (load) load.disabled = loading || !ap;
    for (const id of ['#aperia-issues-save-tsv', '#aperia-issues-save-xls']) {
      const el = q(id); if (el) el.disabled = loading || !jobId;
    }
  };
  const render = () => {
    const el = q('#aperia-issues-table');
    if (!el) return;
    const shown = sortIssueRows(filterByDomicile(rows, domicile), sort.key, sort.dir);
    el.innerHTML = jobId ? tableHtml(type, shown, sort) : '';
  };
  const fillDomiciles = (list) => {
    const sel = q('#aperia-issues-domicile');
    if (!sel) return;
    const doms = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x);
    sel.innerHTML = '<option value="">All domiciles</option>' + doms.map((x) => '<option value="' + _esc(x) + '">' + _esc(x) + '</option>').join('');
    sel.value = '';
    sel.disabled = !doms.length;
    domicile = '';
  };

  const load = () => {
    if (!ap || loading) return;
    const view = q('#aperia-issues-view');
    const want = view && view.value === 'critical-no-case' ? 'critical-no-case' : 'active';
    loading = true;
    setMsg('Loading\u2026');
    refreshButtons();
    Promise.resolve().then(() => ap.issues({ type: want })).then((r) => {
      loading = false;
      if (r && r.ok) {
        type = want;
        jobId = r.jobId || null;
        rows = Array.isArray(r.rows) ? r.rows : [];
        sort = type === 'active' ? { key: 'severity', dir: 'desc' } : { key: 'detected', dir: 'desc' };
        fillDomiciles(r.domiciles);
        setMsg(rows.length + (rows.length === 1 ? ' row' : ' rows') + (fmtEt(r.pulledAt) ? ' \u00b7 pulled ' + fmtEt(r.pulledAt) : ''));
      } else {
        setMsg(_msgFor(r && r.code));
      }
      render();
      refreshButtons();
    }).catch(() => { loading = false; setMsg(_msgFor('APERIA_INTERNAL')); refreshButtons(); });
  };
  const save = (format) => {
    if (!ap || !jobId || loading) return;
    Promise.resolve().then(() => ap.exportBulk({ jobId, format, domicile })).then((r) => {
      if (r && r.ok) toast('success', 'Saved ' + r.filename + ' to Downloads', 4000);
      else toast('error', 'Aperia export failed (' + String((r && r.code) || 'unknown') + ')', 4000);
    }).catch(() => toast('error', 'Aperia export failed', 4000));
  };
  const onSortClick = (e) => {
    const t = e && e.target;
    const th = t && typeof t.closest === 'function' ? t.closest('[data-aperia-sort]') : null;
    if (!th) return;
    const key = th.getAttribute('data-aperia-sort');
    sort = sort.key === key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'severity' || key === 'detected' || key === 'criticalCount' ? 'desc' : 'asc' };
    render();
  };

  m.show({
    title: 'Aperia tire issues',
    width: 760,
    body: BODY,
    onMount: (el) => {
      root = el;
      if (!ap) setMsg('Aperia is not available in this build');
      const on = (sel, ev, fn) => { const x = q(sel); if (x) x.addEventListener(ev, fn); };
      on('#aperia-issues-load', 'click', load);
      on('#aperia-issues-save-tsv', 'click', () => save('tsv'));
      on('#aperia-issues-save-xls', 'click', () => save('xls'));
      on('#aperia-issues-domicile', 'change', () => { const s = q('#aperia-issues-domicile'); domicile = (s && s.value) || ''; render(); });
      on('#aperia-issues-table', 'click', onSortClick);
      refreshButtons();
      if (!ap) return;
      try { Promise.resolve(ap.status()).then((s) => { const x = q('#aperia-issues-state'); if (x) x.textContent = aperiaPill(s).text; }).catch(() => {}); } catch (_) {}
    },
    onClose: () => { root = null; },
  });
}
