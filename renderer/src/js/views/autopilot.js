/**
 * views/autopilot.js -- Fleet Autopilot V1 dashboard (read-only / shadow mode, §B12.2).
 *
 * Self-registering view: creates a hidden #view-autopilot on the views mount, adds an
 * "Autopilot" toolbar tab through components/toolbar.js addTab(), and shows / hides itself on
 * bus 'ui:view-change' like views/zoom-hub.js. Styles are injected once as #ap-styles with an
 * .ap- prefix, so no shared CSS file changes. Status is polled every 15 s only while the view
 * is visible and refreshed on 'autopilot:changed'.
 *
 * Sections: Overview, Cases, Case drawer, Controls, Diagnostics. Every data value is set with
 * textContent / setAttribute; the view never assigns innerHTML (the shell is built node by node).
 */
import defaultBus from '../bus.js';
import { addTab as defaultAddTab } from '../components/toolbar.js';
import defaultApi from './autopilot-api.js';
import * as L from './autopilot-logic.js';

const STYLE_ID = 'ap-styles';
const POLL_MS = 15000;
const PAGE = 50;

const CSS = `
.ap-root { flex-direction: column; gap: 12px; padding: 14px 18px; overflow: auto; height: 100%; box-sizing: border-box; color: var(--txt, #e6edf3); }
.ap-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ap-title { font-size: 16px; font-weight: 600; }
.ap-banner { padding: 8px 12px; border-radius: 6px; font-size: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ap-banner--info { background: rgba(88,166,255,.12); border: 1px solid rgba(88,166,255,.35); }
.ap-banner--warn { background: rgba(210,153,34,.12); border: 1px solid rgba(210,153,34,.4); }
.ap-banner--bad { background: rgba(248,81,73,.12); border: 1px solid rgba(248,81,73,.4); }
.ap-section { border: 1px solid var(--border, #30363d); border-radius: 8px; padding: 10px 12px; }
.ap-section-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.ap-tiles { display: flex; gap: 8px; flex-wrap: wrap; }
.ap-tile { min-width: 110px; padding: 8px 10px; border-radius: 6px; background: rgba(110,118,129,.12); }
.ap-tile-val { font-size: 18px; font-weight: 600; }
.ap-tile-lbl { font-size: 11px; opacity: .75; }
.ap-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0; font-size: 12px; }
.ap-btn { font-size: 12px; padding: 4px 10px; border-radius: 5px; border: 1px solid var(--border, #30363d); background: rgba(110,118,129,.15); color: inherit; cursor: pointer; }
.ap-btn[disabled] { opacity: .45; cursor: not-allowed; }
.ap-input { font-size: 12px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--border, #30363d); background: transparent; color: inherit; }
.ap-textarea { width: 100%; min-height: 54px; font-family: inherit; }
.ap-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ap-table th, .ap-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid rgba(110,118,129,.2); vertical-align: top; }
.ap-table tr.ap-click { cursor: pointer; }
.ap-table tr.ap-click:hover { background: rgba(88,166,255,.08); }
.ap-table tr.ap-conflict td { background: rgba(210,153,34,.10); }
.ap-badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; white-space: nowrap; }
.ap-badge--info { background: rgba(88,166,255,.18); }
.ap-badge--busy { background: rgba(163,113,247,.2); }
.ap-badge--action { background: rgba(210,153,34,.22); }
.ap-badge--ok { background: rgba(63,185,80,.2); }
.ap-badge--warn { background: rgba(210,153,34,.22); }
.ap-badge--bad { background: rgba(248,81,73,.22); }
.ap-badge--mute { background: rgba(110,118,129,.2); }
.ap-approval { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px; font-size: 10px; background: rgba(248,81,73,.15); border: 1px solid rgba(248,81,73,.35); }
.ap-note { font-size: 11px; opacity: .75; }
.ap-drawer { position: fixed; top: 48px; right: 0; bottom: 0; width: min(760px, 92vw); background: var(--bg, #0d1117); border-left: 1px solid var(--border, #30363d); padding: 12px 16px; overflow: auto; z-index: 50; box-shadow: -6px 0 18px rgba(0,0,0,.35); }
.ap-drawer h4 { margin: 12px 0 6px; font-size: 13px; }
.ap-list { margin: 0; padding-left: 18px; font-size: 12px; }
.ap-kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 12px; }
.ap-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
`;

const CASE_COLUMNS = ['Unit', 'Domicile', 'State', 'Primary reason', 'Days down', 'ETC', 'Re-check', 'Priority'];

let _state = null;

/**
 * init(mount, deps) -- deps (tests): { bus, addTab, api, document, window }.
 * Returns { root, show, hide, refresh } for tests.
 */
export function init(mount, deps = {}) {
  if (_state) return _state.handle;
  const bus = deps.bus || defaultBus;
  const addTab = deps.addTab || defaultAddTab;
  const api = deps.api || defaultApi;
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  const win = deps.window || (typeof window !== 'undefined' ? window : null);
  if (!doc || !mount) return null;

  const root = doc.createElement('div');
  root.id = 'view-autopilot';
  root.className = 'view ap-root';
  root.style.display = 'none';
  const parts = {};
  const part = (k) => parts[k];

  const st = {
    status: null, cases: { items: [], total: 0 }, offset: 0,
    filter: { state: '', reason: '', domicile: '', q: '' },
    drawer: null, restartPending: false, visible: false, timer: null, unsub: null, message: '',
  };

  // ── DOM helpers (textContent only for data) ─────────────────────────────
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function clear(node) {
    if (!node) return;
    if (typeof node.replaceChildren === 'function') { node.replaceChildren(); return; }
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  function section(title, child) {
    const s = el('div', 'ap-section');
    s.appendChild(el('div', 'ap-section-title', title));
    if (child) s.appendChild(child);
    return s;
  }
  // The static shell, built node by node (no HTML parsing).
  function buildShell() {
    const head = el('div', 'ap-head');
    head.appendChild(el('div', 'ap-title', '🛰️ Fleet Autopilot'));
    head.appendChild(el('span', 'ap-badge ap-badge--info', 'Shadow mode'));
    root.appendChild(head);
    parts.banners = root.appendChild(el('div', 'ap-banners'));
    parts.tiles = el('div', 'ap-tiles');
    root.appendChild(section('Overview', parts.tiles));
    const cases = section('Cases');
    parts.filters = cases.appendChild(el('div', 'ap-row'));
    const table = el('table', 'ap-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of CASE_COLUMNS) hr.appendChild(el('th', null, h));
    thead.appendChild(hr);
    table.appendChild(thead);
    parts.cases = table.appendChild(el('tbody'));
    cases.appendChild(table);
    parts.pager = cases.appendChild(el('div', 'ap-row'));
    root.appendChild(cases);
    const grid = el('div', 'ap-grid2');
    parts.controls = el('div');
    parts.diag = el('div');
    grid.appendChild(section('Controls', parts.controls));
    grid.appendChild(section('Diagnostics', parts.diag));
    root.appendChild(grid);
    parts.drawer = root.appendChild(el('div', 'ap-drawer'));
    parts.drawer.style.display = 'none';
  }
  function btn(label, onClick, disabled, title) {
    const b = el('button', 'ap-btn', label);
    b.type = 'button';
    if (disabled) b.disabled = true;
    if (title) b.setAttribute('title', title);
    b.addEventListener('click', () => { if (!b.disabled) onClick(); });
    return b;
  }
  function kv(pairs) {
    const g = el('div', 'ap-kv');
    for (const [k, v] of pairs) { g.appendChild(el('div', 'ap-note', k)); g.appendChild(el('div', null, v == null || v === '' ? '—' : v)); }
    return g;
  }
  function banner(tone, text) { return el('div', 'ap-banner ap-banner--' + tone, text); }
  function note(msg) { st.message = msg || ''; renderBanners(); }

  async function call(p) {
    let r;
    try { r = await p; } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    if (!r || r.ok === false) note(L.codeMessage(r && r.code) + (r && r.field ? ' (' + r.field + ')' : ''));
    return r || { ok: false };
  }

  // ── Overview ────────────────────────────────────────────────────────────
  function renderBanners() {
    const box = part('banners');
    clear(box);
    const s = st.status;
    box.appendChild(banner('info', L.SHADOW_TEXT));
    if (st.message) box.appendChild(banner('warn', st.message));
    if (!s) return;
    if (s.ok === false) { box.appendChild(banner('bad', L.codeMessage(s.code))); return; }
    if (!s.enabled) { box.appendChild(banner('warn', 'Autopilot is off.')); return; }
    const sb = L.supervisorBanner(s, { restartPending: st.restartPending });
    if (sb) {
      const b = banner('warn', sb.text);
      b.appendChild(btn(sb.buttonLabel, enableSupervisor, sb.buttonDisabled));
      box.appendChild(b);
    }
    if (s.degraded) box.appendChild(banner('bad', 'Degraded: ' + String(s.degraded)));
    const a = s.auth || {};
    const authIssues = [];
    if (a.midway && a.midway !== 'HEALTHY') authIssues.push('Midway ' + String(a.midway));
    if (a.aperia && a.aperia.actionNeeded) authIssues.push('Aperia sign-in needed');
    if (authIssues.length) box.appendChild(banner('warn', 'Auth: ' + authIssues.join(', ') + '. Autopilot keeps using cached data.'));
    const nf = L.unitsNotInFleetText(s);
    if (nf) box.appendChild(banner('info', nf));
  }

  function renderTiles() {
    const box = part('tiles');
    clear(box);
    const c = (st.status && st.status.counts) || null;
    const tile = (label, val) => { const t = el('div', 'ap-tile'); t.appendChild(el('div', 'ap-tile-val', val)); t.appendChild(el('div', 'ap-tile-lbl', label)); box.appendChild(t); };
    if (!c) { tile('Open cases', '—'); return; }
    tile('Open cases', c.open || 0);
    tile('ETC overdue', c.etaOverdue || 0);
    tile('Needs review', c.needsReview || 0);
    tile('Auth issues', c.auth || 0);
    for (const k of Object.keys(c.byState || {})) tile(L.stateBadge(k).label, c.byState[k]);
    for (const k of Object.keys(c.byDomicile || {})) tile('Domicile ' + k, c.byDomicile[k]);
  }

  // ── Cases ───────────────────────────────────────────────────────────────
  function renderFilters() {
    const box = part('filters');
    clear(box);
    const sel = (key, label, options) => {
      const s = el('select', 'ap-input');
      s.setAttribute('aria-label', label);
      const o0 = el('option', null, label); o0.value = ''; s.appendChild(o0);
      for (const v of options) { const o = el('option', null, v[1]); o.value = v[0]; s.appendChild(o); }
      s.value = st.filter[key];
      s.addEventListener('change', () => { st.filter[key] = s.value; st.offset = 0; refreshCases(); });
      return s;
    };
    box.appendChild(sel('state', 'All states', Object.keys(L.STATE_BADGES).map((k) => [k, L.STATE_BADGES[k].label])));
    box.appendChild(sel('reason', 'All reasons', Object.keys(L.REASON_SENTENCES).map((k) => [k, k.replace(/_/g, ' ').toLowerCase()])));
    const dom = el('input', 'ap-input'); dom.setAttribute('placeholder', 'Domicile'); dom.setAttribute('maxlength', '10'); dom.value = st.filter.domicile;
    const q = el('input', 'ap-input'); q.setAttribute('placeholder', 'Unit starts with…'); q.setAttribute('maxlength', '40'); q.value = st.filter.q;
    box.appendChild(dom);
    box.appendChild(q);
    box.appendChild(btn('Apply', () => { st.filter.domicile = dom.value.trim(); st.filter.q = q.value.trim(); st.offset = 0; refreshCases(); }));
  }

  function renderCases() {
    const body = part('cases');
    clear(body);
    const items = st.cases.items || [];
    if (!items.length) {
      const tr = el('tr'); const td = el('td', 'ap-note', st.status && !st.status.enabled ? 'Autopilot is off.' : 'No cases.'); td.setAttribute('colspan', '8'); tr.appendChild(td); body.appendChild(tr);
    }
    for (const c of items) {
      const m = L.caseRow(c);
      const tr = el('tr', 'ap-click');
      tr.setAttribute('data-case', m.caseId);
      tr.appendChild(el('td', null, m.unit));
      tr.appendChild(el('td', null, m.domicile));
      const tdS = el('td'); tdS.appendChild(el('span', m.state.className, m.state.label)); tr.appendChild(tdS);
      tr.appendChild(el('td', null, m.primaryReason));
      tr.appendChild(el('td', null, m.daysDown));
      tr.appendChild(el('td', null, m.etc));
      tr.appendChild(el('td', null, m.recheck));
      tr.appendChild(el('td', null, m.priority));
      tr.addEventListener('click', () => openCase(m.caseId, 0));
      body.appendChild(tr);
    }
    const pager = part('pager');
    clear(pager);
    const total = st.cases.total || 0;
    pager.appendChild(el('span', 'ap-note', total ? (st.offset + 1) + '–' + Math.min(total, st.offset + PAGE) + ' of ' + total : '0 cases'));
    pager.appendChild(btn('Previous', () => { st.offset = Math.max(0, st.offset - PAGE); refreshCases(); }, st.offset === 0));
    pager.appendChild(btn('Next', () => { st.offset += PAGE; refreshCases(); }, st.offset + PAGE >= total));
  }

  async function refreshCases() {
    const f = { limit: PAGE, offset: st.offset };
    for (const k of ['state', 'reason', 'domicile', 'q']) if (st.filter[k]) f[k] = st.filter[k];
    const r = await call(api.cases(f));
    st.cases = r && r.ok ? { items: r.items || [], total: r.total || 0 } : { items: [], total: 0 };
    renderCases();
  }

  // ── Case drawer ─────────────────────────────────────────────────────────
  async function openCase(caseId, eventsOffset) {
    const r = await call(api.getCase(caseId, { eventsOffset }));
    if (!r || !r.ok || !r.case) return;
    st.drawer = { caseId, eventsOffset, data: r };
    renderDrawer();
  }

  function renderDrawer() {
    const d = part('drawer');
    clear(d);
    if (!st.drawer) { d.style.display = 'none'; return; }
    d.style.display = '';
    const r = st.drawer.data;
    const c = r.case || {};
    const head = el('div', 'ap-row');
    head.appendChild(el('strong', null, 'Unit ' + String(c.unit_id || '')));
    const b = L.stateBadge(c.state); head.appendChild(el('span', b.className, b.label));
    head.appendChild(btn('Close', () => { st.drawer = null; renderDrawer(); }));
    d.appendChild(head);
    d.appendChild(kv([
      ['Domicile', String(c.domicile || '')], ['Days down', Number.isFinite(c.days_down) ? String(Math.floor(c.days_down)) : ''],
      ['Repair phase', String(c.repair_phase || '')], ['Responsible party', String(c.responsible_party || '')],
      ['Re-check', L.recheckLabel(c)], ['Review status', String(c.review_status || '')],
    ]));

    d.appendChild(el('h4', null, 'Detection reasons'));
    const rl = el('ul', 'ap-list');
    for (const x of Array.isArray(c.reasons) ? c.reasons : []) rl.appendChild(el('li', null, L.reasonSentence(x && x.code)));
    d.appendChild(rl);

    d.appendChild(el('h4', null, 'Why (decision history)'));
    const tl = el('ul', 'ap-list');
    for (const e of r.events || []) tl.appendChild(el('li', null, L.formatTime(e.at) + ' — ' + L.eventSentence(e)));
    d.appendChild(tl);
    const off = st.drawer.eventsOffset || 0;
    const evRow = el('div', 'ap-row');
    evRow.appendChild(el('span', 'ap-note', (r.eventsTotal || 0) + ' events'));
    evRow.appendChild(btn('Earlier page', () => openCase(st.drawer.caseId, Math.max(0, off - 500)), off === 0));
    evRow.appendChild(btn('Next page', () => openCase(st.drawer.caseId, off + 500), off + 500 >= (r.eventsTotal || 0)));
    d.appendChild(evRow);

    const run = (r.runs || [])[0] || null;
    d.appendChild(el('h4', null, 'Source plan'));
    const pt = el('table', 'ap-table');
    const pth = el('tr'); for (const h of ['Source', 'Status', 'Why']) pth.appendChild(el('th', null, h)); pt.appendChild(pth);
    for (const p of run && Array.isArray(run.plan) ? run.plan : []) {
      const tr = el('tr'); tr.appendChild(el('td', null, String(p.source || ''))); tr.appendChild(el('td', null, String(p.status || ''))); tr.appendChild(el('td', null, String(p.why || ''))); pt.appendChild(tr);
    }
    d.appendChild(pt);

    d.appendChild(el('h4', null, 'Evidence'));
    const et = el('table', 'ap-table');
    const eth = el('tr');
    for (const h of ['Source', 'Field', 'Value', 'Observed', 'Retrieved', 'Freshness', 'Confidence', 'Trust', 'Authority']) eth.appendChild(el('th', null, h));
    et.appendChild(eth);
    for (const row of L.evidenceRows(r.findings, r.conflicts)) {
      const tr = el('tr', row.conflict ? 'ap-conflict' : null);
      if (row.conflictGroup) tr.setAttribute('title', 'Conflict ' + row.conflictGroup);
      for (const k of ['source', 'field', 'value', 'observed', 'retrieved', 'freshness', 'confidence', 'trust', 'authority']) tr.appendChild(el('td', null, row[k]));
      et.appendChild(tr);
    }
    d.appendChild(et);

    const findings = c.ai_findings || null;
    d.appendChild(el('h4', null, 'Findings' + (findings && findings.generatedBy ? ' (' + String(findings.generatedBy) + ')' : '')));
    if (findings && findings.summary) d.appendChild(el('div', null, String(findings.summary)));
    for (const sec of L.findingsSections(Object.assign({}, findings || {}, c.recommendation || {}))) {
      const h = el('div', 'ap-row'); h.appendChild(el('strong', null, sec.title));
      if (sec.badge) h.appendChild(el('span', 'ap-approval', sec.badge));
      d.appendChild(h);
      const ul = el('ul', 'ap-list');
      if (!sec.items.length) ul.appendChild(el('li', 'ap-note', 'None'));
      for (const it of sec.items) {
        const li = el('li', null, it);
        if (sec.badge) li.appendChild(el('span', 'ap-approval', sec.badge));
        ul.appendChild(li);
      }
      d.appendChild(ul);
    }

    d.appendChild(el('h4', null, 'Review'));
    const rb = L.reviewButtons(c.state);
    const noteIn = el('input', 'ap-input'); noteIn.setAttribute('placeholder', 'Note (optional)'); noteIn.setAttribute('maxlength', '500');
    const rr = el('div', 'ap-row');
    rr.appendChild(noteIn);
    const doReview = async (decision) => {
      const res = await call(api.review(c.case_id, decision, noteIn.value ? noteIn.value.slice(0, 500) : undefined));
      if (res.ok) { await openCase(c.case_id, 0); refreshCases(); refreshStatus(); }
    };
    rr.appendChild(btn('Acknowledge', () => doReview('acknowledge'), !rb.acknowledge));
    rr.appendChild(btn('Accept', () => doReview('accept'), !rb.accept));
    rr.appendChild(btn('Re-run', () => doReview('rerun'), !rb.rerun));
    d.appendChild(rr);
  }

  // ── Controls ────────────────────────────────────────────────────────────
  async function save(patch) {
    const r = await call(api.setConfig(patch));
    if (r.ok) { note(''); await refreshStatus(); }
    return r;
  }
  async function control(action) {
    const r = await call(api.control(action));
    if (r.ok) { note(''); await refreshStatus(); refreshCases(); }
    return r;
  }
  async function enableSupervisor() {
    const r = await call(api.control('enable-supervisor'));
    if (r.ok) { st.restartPending = true; renderBanners(); }
  }

  function check(label, checked, onChange, disabled, hint) {
    const row = el('label', 'ap-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (disabled) cb.disabled = true;
    cb.addEventListener('change', () => onChange(cb.checked, cb));
    row.appendChild(cb);
    row.appendChild(el('span', null, label));
    if (hint) row.appendChild(el('span', 'ap-note', hint));
    return row;
  }

  function renderControls() {
    const box = part('controls');
    clear(box);
    const s = st.status;
    if (!s || s.ok === false) { box.appendChild(el('div', 'ap-note', 'Status unavailable.')); return; }
    const cfg = s.config || {};
    const rb = L.runButtons(s);
    box.appendChild(check('Autopilot on (observation only)', s.enabled, (v) => save({ enabled: v })));
    const row = el('div', 'ap-row');
    row.appendChild(el('span', 'ap-note', 'Run state: ' + String(s.runState || '')));
    row.appendChild(btn('Pause', () => control('pause'), !s.enabled || s.runState === 'paused'));
    row.appendChild(btn('Resume', () => control('resume'), !s.enabled || s.runState === 'running'));
    row.appendChild(btn('Stop', () => control('stop'), s.runState === 'stopped'));
    row.appendChild(btn('Run now', () => control('run-now'), rb.runNowDisabled, rb.harnessHint));
    box.appendChild(row);

    box.appendChild(el('div', 'ap-section-title', 'Features'));
    const feats = cfg.features || {};
    for (const k of Object.keys(L.FEATURE_LABELS)) {
      box.appendChild(check(L.FEATURE_LABELS[k], feats[k], (v) => save({ features: { [k]: v } }), false, k === 'liveReads' ? L.LIVE_READS_TEXT : ''));
    }

    box.appendChild(el('div', 'ap-section-title', 'Writes (locked off in V1)'));
    for (const k of Object.keys(L.WRITE_LABELS)) box.appendChild(check(L.WRITE_LABELS[k], false, () => {}, true, L.LOCKED_WRITE_TEXT));
    box.appendChild(el('div', 'ap-section-title', 'Protections (always on)'));
    const pl = el('ul', 'ap-list');
    for (const k of Object.keys(L.PROTECTION_LABELS)) pl.appendChild(el('li', null, L.PROTECTION_LABELS[k] + ': on (locked)'));
    box.appendChild(pl);

    box.appendChild(el('div', 'ap-section-title', 'Scope'));
    const sc = cfg.scope || {};
    const dom = el('input', 'ap-input'); dom.setAttribute('maxlength', '10'); dom.setAttribute('aria-label', 'Domicile'); dom.value = String(sc.domicile || '');
    const units = el('textarea', 'ap-input ap-textarea'); units.setAttribute('aria-label', 'Units'); units.value = (Array.isArray(sc.units) ? sc.units : []).join('\n');
    const dr = el('div', 'ap-row'); dr.appendChild(el('span', null, 'Domicile')); dr.appendChild(dom); box.appendChild(dr);
    box.appendChild(units);
    box.appendChild(check('All units', sc.allUnits, (v, cb) => {
      if (v) {
        const n = s.scope && Number.isFinite(s.scope.fleetDown) ? s.scope.fleetDown : 0;
        const ok = win && typeof win.confirm === 'function' ? win.confirm(L.allUnitsConfirmText(n)) : false;
        if (!ok) { cb.checked = false; return; }
      }
      save({ scope: { allUnits: v } });
    }));
    box.appendChild(btn('Save scope', () => save({ scope: { domicile: dom.value.trim().toUpperCase(), units: L.parseUnits(units.value) } })));

    box.appendChild(el('div', 'ap-section-title', 'Settings'));
    const nums = [['oosDays', 'Days down before a case opens'], ['maxCasesPerTick', 'Cases per tick'], ['intervalMs', 'Tick interval (ms)'], ['dailyCap', 'AI calls per day']];
    const inputs = {};
    for (const [k, label] of nums) {
      const r = el('div', 'ap-row');
      const i = el('input', 'ap-input'); i.type = 'number'; i.setAttribute('aria-label', label); i.value = cfg[k] == null ? '' : String(cfg[k]);
      inputs[k] = i;
      r.appendChild(el('span', null, label)); r.appendChild(i);
      box.appendChild(r);
    }
    box.appendChild(btn('Save settings', () => {
      const patch = {};
      for (const [k] of nums) { const v = parseInt(inputs[k].value, 10); if (Number.isFinite(v) && v !== cfg[k]) patch[k] = v; }
      if (Object.keys(patch).length) save(patch);
    }));
    box.appendChild(el('div', 'ap-note', L.reliabilityHint(s)));
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────
  function renderDiag() {
    const box = part('diag');
    clear(box);
    const s = st.status;
    if (!s || s.ok === false) return;
    const w = s.worker;
    const lt = s.lastTick || null;
    const ai = s.ai || {};
    const res = s.resources || {};
    box.appendChild(kv([
      ['Worker', typeof w === 'string' ? w : (w ? String(w.state || '') + (w.breakerState ? ' / breaker ' + String(w.breakerState) : '') : '')],
      ['Supervisor', s.supervisorEnabled ? 'on' : 'off'],
      ['Last tick', lt ? L.formatTime(lt.at) + ' · ' + lt.ms + ' ms · cpu ' + lt.cpuMs + ' ms · ' + String(lt.outcome || '') : ''],
      ['AI today', ai.today == null ? '' : ai.today + ' / ' + ai.cap],
      ['AI latency p50 / p95', ai.p50 == null ? '' : ai.p50 + ' / ' + ai.p95 + ' ms'],
      ['Gateway p95', ai.gatewayP95 == null ? '' : ai.gatewayP95 + ' ms'],
      ['AI lanes', ai.lanes ? Object.keys(ai.lanes).map((k) => k + ' ' + ai.lanes[k]).join(', ') : ''],
      ['AI outcomes', ai.outcomes ? Object.keys(ai.outcomes).map((k) => k + ' ' + ai.outcomes[k]).join(', ') : ''],
      ['Isolated lane', ai.isolatedAvailable == null ? '' : (ai.isolatedAvailable ? 'available' : 'not available')],
      ['AI cost', String(ai.cost || 'not reported by AI lanes')],
      ['Memory', res.rssMb == null ? '' : 'RSS ' + res.rssMb + ' MB · heap ' + res.heapUsedMb + ' MB'],
      ['Event loop p99', res.eventLoopP99Ms == null ? '' : res.eventLoopP99Ms + ' ms'],
      ['Durable jobs', s.jobs ? String(s.jobs.mode || (s.jobs.effective ? 'on' : 'off')) : 'off'],
    ]));
    const src = s.sources || {};
    if (Object.keys(src).length) {
      const t = el('table', 'ap-table');
      const h = el('tr'); for (const x of ['Source (24 h)', 'Live calls', 'Errors', 'Not warm', 'Cache only']) h.appendChild(el('th', null, x)); t.appendChild(h);
      for (const k of Object.keys(src)) {
        const v = src[k] || {};
        const tr = el('tr');
        for (const x of [k, v.calls, v.errors, v.not_warm, v.cache_only]) tr.appendChild(el('td', null, x == null ? '0' : x));
        t.appendChild(tr);
      }
      box.appendChild(t);
    }
    const rb = L.runButtons(s);
    const hr = el('div', 'ap-row');
    hr.appendChild(btn('Run harness (24 runs)', async () => {
      const r = await call(api.harnessRun({ runs: 24 }));
      if (r.ok) { note('Harness finished: ' + (r.summary ? r.summary.runsDone : 0) + ' runs. Report: ' + String(r.reportPath || '')); refreshStatus(); refreshCases(); }
    }, rb.harnessDisabled, rb.harnessHint));
    if (rb.harnessHint) hr.appendChild(el('span', 'ap-note', rb.harnessHint));
    box.appendChild(hr);
  }

  // ── refresh / visibility ────────────────────────────────────────────────
  async function refreshStatus() {
    let r;
    try { r = await api.status(); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    st.status = r || { ok: false, code: 'UNAVAILABLE' };
    renderBanners();
    renderTiles();
    renderControls();
    renderDiag();
  }
  async function refresh() {
    await refreshStatus();
    await refreshCases();
    if (st.drawer) await openCase(st.drawer.caseId, st.drawer.eventsOffset || 0);
  }

  function show() {
    root.style.display = 'flex';
    if (st.visible) return;
    st.visible = true;
    renderFilters();
    refresh();
    st.timer = setInterval(() => { if (st.visible) refreshStatus(); }, POLL_MS);
    try { st.unsub = api.onChanged(() => { if (st.visible) refresh(); }); } catch (_) { st.unsub = null; }
  }
  function hide() {
    root.style.display = 'none';
    if (!st.visible) return;
    st.visible = false;
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    if (typeof st.unsub === 'function') { try { st.unsub(); } catch (_) {} }
    st.unsub = null;
  }

  bus.on('ui:view-change', ({ to } = {}) => {
    if (to === 'autopilot') show();
    else if (to !== 'settings') hide();   // Settings is a drawer over the current view
  });

  buildShell();
  mount.appendChild(root);
  if (doc.head && !doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  addTab({ key: 'autopilot', view: 'autopilot', label: 'Autopilot', icon: '🛰️' });
  renderBanners();

  const handle = { root, show, hide, refresh, get visible() { return st.visible; } };
  _state = { handle };
  return handle;
}

/** _resetForTests() -- allow init() again in a fresh fake DOM. */
export function _resetForTests() { _state = null; }
