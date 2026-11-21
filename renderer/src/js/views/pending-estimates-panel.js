/**
 * pending-estimates-panel.js — Fleet tab "⏳ Pending Estimates" overlay.
 *
 * Lists the user's work orders whose estimate is submitted and awaiting approval,
 * oldest-submitted first, from the rows already in the fleet slice.
 * All HTML comes from ./pending-estimates-logic.js.
 *
 * Upgrade: the team-wide scan (window.pendingEst.get / .scan -> src/ipc/pending-est.js)
 * adds RG + Volvo/PACCAR + DTNA offsite rows for the whole team. DTNA rows come from
 * the DTNA case cache only: open, auto-scan and Refresh never make a DTNA call. The
 * header "Pull DTNA" button (window.dtna.bulkPull, user click only) refreshes that
 * cache, then runs one forced team scan. The Owner control
 * (Mine · Everyone · All, default Mine) and the filter bar only filter what is shown;
 * they never change the scan request. On open the cached scan (get) renders first; if
 * its asOf is 15+ min old one background non-forced scan runs and repaints on resolve.
 * The Refresh button runs a forced scan and is disabled while any scan is in flight.
 * There is no timer or poll. Without window.pendingEst the overlay shows the
 * v1 fleet-slice rows only.
 *
 * Escalate reuses the existing WR-card Escalate modal (relay-actions.js
 * openEscalationModal) pre-targeted to MCS High Value Estimate. That modal drafts via
 * relay:draft-action and sends only through the gated relay:escalate -> write-gate ->
 * approval modal. Nothing here writes. Vendor WO chips open in-app through
 * wireIdLinks -> window.aap.openUrl(url, { zoom: true }).
 *
 * The overlay sits at z-index 850, below the modal.js singleton (900), so the
 * Escalate and approval modals render above it. Escape is ignored while a modal.js
 * modal is open, so the first Escape closes the modal and the next one the overlay.
 *
 * The controller takes injected { doc, bus, getFleet, getScan, runScan, openUrl,
 * openEscalation, escalationDeps, modal, navigate, dtna } so the DOM tests drive it without
 * jsdom (__test__.createController).
 */
import bus from '../bus.js';
import state from '../state.js';
import modal from '../components/modal.js';
import toast from '../components/toast.js';
import { openEscalationModal } from './relay-actions.js';
import { wireIdLinks } from './id-links.js';
import * as L from './pending-estimates-logic.js';

let _active = null;

export function openPendingEstimatesPanel({ returnFocusEl } = {}) {
  if (_active) return _active;
  const w = typeof window !== 'undefined' ? window : {};
  const ctl = createController({
    doc: document, bus, modal,
    getFleet: () => state.slice('fleet'),
    getScan: () => (w.pendingEst && w.pendingEst.get ? w.pendingEst.get() : null),
    runScan: (o) => (w.pendingEst && w.pendingEst.scan ? w.pendingEst.scan(o) : null),
    openUrl: (u, o) => (w.aap && w.aap.openUrl ? w.aap.openUrl(u, o) : undefined),
    openEscalation: openEscalationModal,
    // Same deps the unit-detail WR cards pass to the Escalate modal.
    escalationDeps: { modal, bridge: w.relayWrites, aapApi: w.aapApi, confirm: (m) => w.confirm(m), toast },
    navigate: (id) => bus.emit('navigate:unit', id),
    toast,
    dtna: w.dtna || null,
    returnFocusEl,
    onClose: () => { _active = null; },
  });
  _active = ctl;
  ctl.open();
  return ctl;
}

const FILTER_NAMES = ['source', 'fleetStatus', 'repairStatus', 'vendor', 'fas', 'mismatch'];
const SCAN_TTL_MS = 15 * 60 * 1000;
const REFRESH_LABEL = '\u21BB Refresh team-wide';
const REFRESHING_LABEL = '\u21BB Refreshing\u2026';
const DTNA_PULL_LABEL = '\u2B07 Pull DTNA';

function createController(deps) {
  const { doc, returnFocusEl, onClose } = deps;
  const evBus = deps.bus || null;
  const now = deps.now || (() => Date.now());
  const getFleet = typeof deps.getFleet === 'function' ? deps.getFleet : () => ({});
  const getScan = typeof deps.getScan === 'function' ? deps.getScan : null;
  const runScan = typeof deps.runScan === 'function' ? deps.runScan : null;
  const mdl = deps.modal || { isOpen: () => false };
  const tst = deps.toast || { show() {} };
  // DTNA bulk pull: only from the header button (a user click). Needs progress events
  // to know when the pull finished.
  const dtna = deps.dtna && typeof deps.dtna.bulkPull === 'function' && typeof deps.dtna.onProgress === 'function' ? deps.dtna : null;
  const pull = { active: false, done: 0, total: 0, unsub: null };

  let overlay = null; let backdrop = null; let bodyEl = null; let barEl = null; let headEl = null;
  let unsub = null; let closed = false; let opening = false;
  let byKey = new Map(); let byWr = new Map();
  let filters = L.defaultFilters(); // Owner = Mine on open
  let sort = { key: 'default', dir: 'asc' };
  const scan = { rows: [], asOf: null, cached: false, scanning: false, error: null, excludedDtna: 0, dtnaAsOf: null };
  let loading = Promise.resolve();

  function render() {
    if (!bodyEl) return;
    const f = getFleet() || {};
    const t = now();
    const res = L.collectPendingEstimates(f.rows || [], { now: t, fleetSyncedAt: f.syncedAt });
    const all = L.mergeTeamRows(res.items, scan.rows, { now: t, asOf: scan.asOf });
    const shown = L.sortItems(L.applyFilters(all, filters), sort);
    byKey = new Map(all.map((it) => [it.key, it]));
    byWr = new Map(all.filter((it) => it.wrId).map((it) => [it.wrId, it]));
    const mismatch = all.filter((it) => it.statusMismatch === true).length;
    if (barEl) {
      barEl.innerHTML = L.filterBarHtml(filters, L.filterOptions(all), { mismatch,
        mine: all.filter((it) => it.mine === true).length, everyone: all.filter((it) => it.mine === false).length, all: all.length });
    }
    const team = !!(getScan || runScan);
    bodyEl.innerHTML = L.overlayHtml({ items: shown, excludedDtna: Math.max(res.excludedDtna, scan.excludedDtna || 0), asOf: f.syncedAt,
      cached: !!(f.usedCache || f.stale), filtered: all.length > 0, sort,
      meta: { shown: shown.length, total: all.length, mismatch: team ? mismatch : undefined, teamAsOf: scan.asOf,
        teamCached: scan.cached, scanning: scan.scanning, teamError: scan.error, dtnaAsOf: scan.dtnaAsOf } });
    wireIdLinks(bodyEl, (u, o) => (typeof deps.openUrl === 'function' ? deps.openUrl(u, o) : undefined));
    const btn = headEl && typeof headEl.querySelector === 'function' ? headEl.querySelector('[data-pe-refresh]') : null;
    if (btn) {
      btn.disabled = !!scan.scanning;
      btn.setAttribute('aria-busy', scan.scanning ? 'true' : 'false');
      btn.textContent = scan.scanning ? REFRESHING_LABEL : REFRESH_LABEL;
    }
    renderPullBtn();
  }

  function renderPullBtn() {
    const b = headEl && typeof headEl.querySelector === 'function' ? headEl.querySelector('[data-pe-dtna-pull]') : null;
    if (!b) return;
    b.disabled = pull.active;
    b.setAttribute('aria-busy', pull.active ? 'true' : 'false');
    b.textContent = pull.active ? 'Pulling DTNA\u2026 ' + pull.done + '/' + (pull.total || '?') : DTNA_PULL_LABEL;
  }

  function stopPull() {
    pull.active = false;
    if (typeof pull.unsub === 'function') { try { pull.unsub(); } catch (_) { /* gone */ } }
    pull.unsub = null;
    if (!closed) renderPullBtn();
  }

  function dtnaSignIn(msg) {
    tst.show('warn', msg || 'DTNA sign-in needed \u2014 opening the sign-in window', 4000);
    try { if (typeof dtna.login === 'function') Promise.resolve(dtna.login()).catch(() => {}); } catch (_) { /* no login */ }
  }

  // "Pull DTNA": one user-initiated bulk pull (with comments), then exactly one forced
  // team scan so the DTNA rows read the fresh cache. Ignored while a pull is running.
  async function pullDtna() {
    if (!dtna || pull.active || closed) return;
    pull.active = true; pull.done = 0; pull.total = 0;
    renderPullBtn();
    let jobId = null;
    const early = [];
    let finish;
    const finished = new Promise((r) => { finish = r; });
    const onEv = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (jobId == null) { early.push(ev); return; }
      if (ev.jobId !== jobId) return;
      pull.done = Number(ev.done) || 0;
      pull.total = Number(ev.total) || 0;
      if (ev.finished) { finish(ev); return; }
      if (!closed) renderPullBtn();
    };
    try { pull.unsub = dtna.onProgress(onEv); } catch (_) { pull.unsub = null; }
    let r;
    try { r = await dtna.bulkPull({ includeComments: true }); } catch (_) { r = { ok: false, code: 'DTNA_INTERNAL' }; }
    if (!r || !r.ok || !r.jobId) {
      stopPull();
      const code = String((r && r.code) || 'unknown');
      if (code === 'DTNA_BUSY') tst.show('warn', 'A DTNA pull is already running', 4000);
      else if (code === 'DTNA_SIGNIN_REQUIRED') dtnaSignIn();
      else tst.show('warn', 'DTNA pull failed (' + code + ')', 4000);
      return;
    }
    jobId = r.jobId;
    early.splice(0).forEach(onEv);
    const fin = await finished;
    stopPull();
    if (closed) return;
    if (fin.code === 'DTNA_SIGNIN_REQUIRED') dtnaSignIn();
    else tst.show(fin.failed ? 'warn' : 'success', 'DTNA: ' + (Number(fin.done) || 0) + ' cases pulled (' + (Number(fin.failed) || 0) + ' failed)', 4000);
    if ((Number(fin.done) || 0) > 0) {
      try { await loading; } catch (_) { /* scan errors are shown in meta */ }
      if (closed) return;
      loading = doScan(true);
      await loading;
    }
  }

  function mount() {
    overlay = doc.createElement('div');
    overlay.id = 'pe-overlay';
    overlay.className = 'pe-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pe-title');
    backdrop = doc.createElement('div');
    backdrop.className = 'pe-backdrop';
    const panel = doc.createElement('div');
    panel.className = 'pe-panel';
    const head = doc.createElement('div');
    head.className = 'pe-head';
    headEl = head;
    head.innerHTML = '<div id="pe-title" class="pe-title">\u23F3 Pending Estimates</div>' +
      '<span class="pe-sub">RG + Volvo/PACCAR + DTNA offsite \u00B7 team-wide pull</span>' +
      '<button type="button" class="pe-refresh" data-pe-refresh="1">' + REFRESH_LABEL + '</button>' +
      (dtna ? '<button type="button" class="pe-refresh" data-pe-dtna-pull="1" title="Pull every DTNA Service Tracker case (with comments), then refresh">' + DTNA_PULL_LABEL + '</button>' : '') +
      '<button type="button" class="pe-close" data-pe-close="1" aria-label="Close">\u00D7</button>';
    barEl = doc.createElement('div');
    barEl.id = 'pe-bar';
    barEl.className = 'pe-bar';
    bodyEl = doc.createElement('div');
    bodyEl.id = 'pe-body';
    bodyEl.className = 'pe-body';
    panel.appendChild(head);
    panel.appendChild(barEl);
    panel.appendChild(bodyEl);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('change', onChange);
    doc.addEventListener('keydown', onKeydown, true);
    doc.body.appendChild(overlay);
  }

  function applyScan(s) {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s.rows) && (s.ok !== false || s.rows.length)) {
      scan.rows = s.rows;
      scan.asOf = s.asOf || null;
      scan.cached = !!s.cached;
      scan.excludedDtna = Number(s.excludedDtna) || 0;
      scan.dtnaAsOf = s.dtnaAsOf || null;
    }
    // Per-case Decisiv failures (e.g. an expired session) explain blank offsite columns.
    const dec = (Array.isArray(s.errors) ? s.errors : [])
      .filter((x) => x && (x.stage === 'getCasePage' || x.stage === 'getCaseStatusSummary'))
      .map((x) => x.stage + ' ' + String(x.code || 'ERROR') + ' \u00D7' + (Number(x.n) || 1));
    const parts = [];
    if (s.ok === false) parts.push(String(s.code || 'failed'));
    if (dec.length) parts.push('Decisiv errors: ' + dec.join(', '));
    scan.error = parts.length ? parts.join(' \u00B7 ') : null;
  }

  async function doScan(force) {
    if (!runScan || scan.scanning || closed) return;
    scan.scanning = true;
    render();
    try { applyScan(await runScan({ force: !!force })); } catch (e) { scan.error = (e && e.message) || 'failed'; }
    scan.scanning = false;
    if (!closed) render();
  }

  // Same rule as the main-process throttle (pending_est_sources SCAN_TTL_MS): a
  // non-forced scan only runs when the stored scan is at least 15 min old.
  function cacheStale() {
    const t = Date.parse(scan.asOf || '');
    const age = now() - t;
    return !Number.isFinite(t) || age < 0 || age >= SCAN_TTL_MS;
  }

  async function loadTeam() {
    if (getScan) {
      // A non-promise result is applied before open() returns (no await, no wait).
      try { let s = getScan(); if (s && typeof s.then === 'function') s = await s; applyScan(s); } catch (_) { /* keep v1 rows */ }
      if (closed) return;
      render();
    }
    // Open-triggered only: one background non-forced scan when the cache is stale.
    if (cacheStale()) await doScan(false);
  }

  async function escalate(key) {
    const it = byKey.get(key) || byWr.get(key);
    if (!it || !it.canEscalate || opening) return;
    opening = true;
    try {
      await deps.openEscalation(it.unit, it.wrId, deps.escalationDeps, { initialTarget: L.HVE_TARGET });
    } catch (e) {
      tst.show('error', 'Could not open: ' + ((e && e.message) || 'unknown'));
    } finally { opening = false; }
  }

  function onClick(e) {
    const t = e && e.target;
    if (!t) return;
    if (t === backdrop || t === overlay) { close(); return; }
    const pick = (sel) => (typeof t.closest === 'function' ? t.closest(sel) : null);
    if (pick('[data-pe-close]')) { close(); return; }
    const own = pick('[data-pe-owner]');
    if (own) {
      const v = own.getAttribute('data-pe-owner');
      if (L.OWNER_VALUES.includes(v)) { filters = Object.assign({}, filters, { owner: v }); render(); }
      return;
    }
    if (pick('[data-pe-clear]')) { filters = Object.assign(L.defaultFilters(), { owner: filters.owner }); render(); return; }
    const ref = pick('[data-pe-refresh]');
    if (ref) {
      // Manual refresh overrides the 15-min throttle; ignored while any scan is in flight.
      if (ref.disabled || scan.scanning) return;
      loading = doScan(true);
      return loading;
    }
    const dp = pick('[data-pe-dtna-pull]');
    if (dp) {
      if (dp.disabled || pull.active) return;
      return pullDtna();
    }
    const srt = pick('[data-pe-sort]');
    if (srt) {
      const k = srt.getAttribute('data-pe-sort');
      sort = sort.key === k ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' };
      render();
      return;
    }
    const esc = pick('[data-pe-escalate]');
    if (esc) { if (!esc.disabled) return escalate(esc.getAttribute('data-pe-escalate')); return; }
    const u = pick('[data-pe-unit]');
    if (u) {
      const id = u.getAttribute('data-pe-unit');
      close();
      if (typeof deps.navigate === 'function') deps.navigate(id);
    }
  }

  function onChange(e) {
    const t = e && e.target;
    const el = t && typeof t.closest === 'function' ? t.closest('[data-pe-filter]') : null;
    if (!el) return;
    const name = el.getAttribute('data-pe-filter');
    if (!FILTER_NAMES.includes(name)) return;
    const val = name === 'mismatch' ? !!el.checked : String(el.value || '');
    filters = Object.assign({}, filters, { [name]: val });
    render();
  }

  function onKeydown(e) {
    if (!e || e.key !== 'Escape' || closed) return;
    if (typeof mdl.isOpen === 'function' && mdl.isOpen()) return; // the modal closes first
    if (typeof e.preventDefault === 'function') e.preventDefault();
    close();
  }

  function open() {
    mount();
    render();
    if (evBus && typeof evBus.on === 'function') unsub = evBus.on('fleet:data', () => render());
    loading = loadTeam();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (typeof unsub === 'function') unsub();
    unsub = null;
    if (typeof pull.unsub === 'function') { try { pull.unsub(); } catch (_) { /* gone */ } }
    pull.unsub = null;
    doc.removeEventListener('keydown', onKeydown, true);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; bodyEl = null; barEl = null; headEl = null;
    if (returnFocusEl && typeof returnFocusEl.focus === 'function') { try { returnFocusEl.focus(); } catch (_) { /* detached */ } }
    if (typeof onClose === 'function') onClose();
  }

  return { open, close, render, isClosed: () => closed, whenLoaded: () => loading };
}

export const __test__ = { createController };
