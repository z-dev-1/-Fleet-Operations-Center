/**
 * fleet-dbr-panel.js — the Daily Call "📊 DBR DATA" panel: the 24-column Fleet
 * Health DBR built from fleet data (main: src/ipc/fleet-dbr.js), replacing the
 * retired dashboard-scrape AFP/DSP overlay.
 *
 * - ↺ Build from fleet data, editable cells (debounced save), per-row Reset/Copy.
 * - ✨ Draft with AI / ■ Stop: AI drafts fill only the prose cells (6 Details, FAS Actions,
 *   Support) with sentences that passed the main-side sheet gate; Y/N, counts and hard cells
 *   never change. "AI" text markers, editable cells stay editable, nothing is sent anywhere.
 * - Copy (rows / with header / fill columns / row) writes the golden sheet format
 *   (L.sheetTsv); the copy-scope select picks "My pairs with units down" (default) or
 *   "All visible rows". A fleet-data alert (red stale / amber partial or AAP refresh failing,
 *   data-as-of = the last AAP build, model.dataFreshness) re-renders every 60 s while open.
 *   The automatic draft pass runs only on fresh data; manual drafts on non-fresh data are badged.
 *   The only thing that leaves the panel is the clipboard on an explicit Copy.
 * - Accessible dialog: Escape / × / backdrop close, focus returns to the opener.
 *
 * All HTML comes from ./fleet-dbr-logic.js (pure, unit-tested). The controller
 * takes injected { api, doc, clipboard, storage, bus } so the DOM test can drive
 * it without jsdom (see __test__.createController).
 */
import bus from '../bus.js';
import { fleetDbr as fleetDbrBridge } from '../bridge.js';
import * as L from './fleet-dbr-logic.js';

const SAVE_DEBOUNCE_MS = 600;
const MAX_DRAFTS_IN_FLIGHT = 2;
const BUSY_RETRY_MS = 2000;
const BUSY_RETRIES = 3;
const STATUS_TICK_MS = 30000;
const HIDE_ZERO_KEY = 'fleetDbr__hideZero';
const SCAC_KEY = 'fleetDbr__scacs';
const COPY_SCOPE_KEY = 'fleetDbr__copyScope';
const BUILD_TIMEOUT_MS = 60000;
// Banner + status line (fleet data age) re-render while the panel is open.
const FRESH_TICK_MS = 60000;
const DRAFTS_PAUSED = 'AI drafts paused \u2014 fleet data is stale';

// Persisted copy scope: 'visible' or 'mine' (anything else -> 'mine').
function _readCopyScope(storage) {
  try { return storage && storage.getItem(COPY_SCOPE_KEY) === 'visible' ? 'visible' : 'mine'; } catch (_) { return 'mine'; }
}

// Persisted SCAC selection: JSON array of strings; anything else -> [] (show all).
function _readScacs(storage) {
  try {
    const raw = storage && storage.getItem(SCAC_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch (_) { return []; }
}

let _active = null;

export async function openFleetDbrPanel({ returnFocusEl } = {}) {
  if (_active) return;
  const ctl = createController({
    api: fleetDbrBridge, doc: document, clipboard: _defaultClipboard(), storage: _safeStorage(), bus,
    returnFocusEl, onClose: () => { _active = null; },
  });
  _active = ctl;
  await ctl.open();
}

// First-class DBR view: same controller mounted inside `container`; on open it
// auto-builds (fleet-dbr:build) when getFleetSyncedAt() is newer than the cached build.
export async function openFleetDbrView(container, { getFleetSyncedAt } = {}) {
  const ctl = createController({
    api: fleetDbrBridge, doc: document, clipboard: _defaultClipboard(), storage: _safeStorage(), bus,
    mode: 'view', container, getFleetSyncedAt,
  });
  ctl.open().catch((err) => console.warn('[fleet-dbr] view open failed', err));
  return ctl;
}

function _safeStorage() {
  return {
    getItem(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    setItem(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage full / blocked */ } },
  };
}

// navigator.clipboard first, then the textarea/execCommand fallback (same as
// daily-call.js _copyToClipboard). Resolves true when either path worked.
function _defaultClipboard() {
  return {
    async writeText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok !== false;
      } catch (_) { return false; }
    },
  };
}

function _attr(s) { return String(s).replace(/["\\]/g, '\\$&'); }

function createController(deps) {
  const { api, doc, clipboard, storage, returnFocusEl, onClose } = deps;
  const evBus = deps.bus || null;
  const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clrT = deps.clearTimeout || ((id) => clearTimeout(id));
  const now = deps.now || (() => Date.now());
  const isView = deps.mode === 'view';
  const getFleetSyncedAt = typeof deps.getFleetSyncedAt === 'function' ? deps.getFleetSyncedAt : () => null;
  const buildTimeoutMs = Number(deps.buildTimeoutMs) > 0 ? Number(deps.buildTimeoutMs) : BUILD_TIMEOUT_MS;

  const st = {
    refreshing: false,      // view mode: auto-build on open in progress (cached model shown meanwhile)
    refreshFailed: null,    // view mode: { builtAt, code } when a build failed and the cached build is shown
    status: 'loading', aiDraft: false, model: null, note: '',
    hideZero: false, stale: false, closed: false, building: false,
    drafting: false, stopped: false, queue: [], inFlight: new Set(), retrying: new Set(),
    done: 0, total: 0, rowStatus: {}, draftStartedAt: 0,
    scacs: [],              // persisted SCAC selection (raw; effective = L.normalizeScacs(st.scacs, st.model))
    sessionKeys: new Set(), // keys queued this drafting session
    doneKeys: new Set(),    // keys finished this session (ok or final error)
    identityRequeued: new Set(), // R-N3: keys re-queued once because the FAS alias became known
    live: {},     // key -> { col -> unsaved/just-typed value }
    pending: {},  // 'key\u0000col' -> debounce timer
  };
  try { st.hideZero = storage && storage.getItem(HIDE_ZERO_KEY) === '1'; } catch (_) { st.hideZero = false; }
  st.scacs = _readScacs(storage);
  st.copyScope = _readCopyScope(storage);
  const visibleKeys = () => new Set(L.visibleRows(st.model, st.hideZero, st.scacs).map((r) => r.key));

  let overlay = null; let frame = null; let bannerEl = null; let statusEl = null; let tableEl = null;
  let unsub = null; let lastFrame = '';
  const timers = new Set();
  const later = (fn, ms) => { const id = setT(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  // ── rendering ─────────────────────────────────────────────────────────────
  function _children(parent) {
    frame = doc.createElement('div'); frame.id = 'fdbr-frame';
    bannerEl = doc.createElement('div'); bannerEl.id = 'fdbr-banner';
    statusEl = doc.createElement('div'); statusEl.id = 'fdbr-status'; statusEl.className = 'fdbr-status';
    statusEl.setAttribute('role', 'status'); statusEl.setAttribute('aria-live', 'polite');
    tableEl = doc.createElement('div'); tableEl.id = 'fdbr-table'; tableEl.className = 'fdbr-scroll';
    parent.appendChild(frame); parent.appendChild(bannerEl); parent.appendChild(statusEl); parent.appendChild(tableEl);
  }

  // View mode: mount inside the view container (never document.body), no dialog semantics.
  function mountView() {
    overlay = doc.createElement('div');
    overlay.id = 'fdbr-view-root';
    overlay.className = 'fdbr-view';
    _children(overlay);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('input', onInput);
    overlay.addEventListener('change', onChange);
    overlay.addEventListener('keydown', onKeydown);
    deps.container.appendChild(overlay);
  }

  function mount() {
    if (isView) { mountView(); return; }
    overlay = doc.createElement('div');
    overlay.id = 'dbr-overlay';
    overlay.className = 'wr-modal-overlay';
    const box = doc.createElement('div');
    box.className = 'wr-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'fdbr-title');
    box.setAttribute('style', 'width:98vw;max-width:1800px;max-height:92vh;');
    frame = doc.createElement('div'); frame.id = 'fdbr-frame';
    bannerEl = doc.createElement('div'); bannerEl.id = 'fdbr-banner';
    statusEl = doc.createElement('div'); statusEl.id = 'fdbr-status'; statusEl.className = 'fdbr-status';
    statusEl.setAttribute('role', 'status'); statusEl.setAttribute('aria-live', 'polite');
    tableEl = doc.createElement('div'); tableEl.id = 'fdbr-table'; tableEl.className = 'fdbr-scroll';
    box.appendChild(frame); box.appendChild(bannerEl); box.appendChild(statusEl); box.appendChild(tableEl);
    overlay.appendChild(box);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('input', onInput);
    overlay.addEventListener('change', onChange);
    overlay.addEventListener('keydown', onKeydown);
    doc.body.appendChild(overlay);
  }

  function renderFrame(focusScac) {
    const m = st.model;
    const html = L.panelHtml({
      mode: isView ? 'view' : undefined,
      status: st.status, aiDraft: st.aiDraft, drafting: st.drafting, hideZero: st.hideZero,
      fasName: m ? m.fasName : '', conflicts: m ? m.conflicts : [], message: st.note,
      scacOptions: L.scacOptions(m), scacs: L.normalizeScacs(st.scacs, m),
      copyScope: st.copyScope, copyInfo: m ? L.copyScopeInfo(m, st.hideZero, st.scacs) : undefined,
    });
    if (html === lastFrame) return; // keep focus/caret in the FAS Name input
    lastFrame = html;
    frame.innerHTML = html;
    // The frame was re-rendered: keep keyboard focus on the SCAC checkbox the user toggled.
    if (focusScac && typeof frame.querySelector === 'function') {
      const cb = frame.querySelector('input[data-fdbr-field="scac"][data-scac="' + _attr(focusScac) + '"]');
      if (cb && typeof cb.focus === 'function') cb.focus();
    }
  }

  function liveValue(row, col) {
    const l = st.live[row.key];
    if (l && Object.prototype.hasOwnProperty.call(l, col)) return l[col];
    return row.cells && row.cells[col] != null ? row.cells[col] : '';
  }

  function autoGrow(ta) {
    if (!ta || !ta.style) return;
    ta.style.height = 'auto';
    ta.style.height = ((ta.scrollHeight || 0) + 2) + 'px';
  }

  function renderTable() {
    if (!tableEl) return;
    tableEl.innerHTML = st.model && st.status === 'ready'
      ? L.tableHtml(st.model, { aiDraft: st.aiDraft, rowStatus: st.rowStatus, hideZero: st.hideZero, scacs: st.scacs, getValue: liveValue })
      : '';
    if (typeof tableEl.querySelectorAll === 'function') tableEl.querySelectorAll('textarea.fdbr-cell').forEach(autoGrow);
  }

  // Re-render the table unless the user is typing in it; then patch only the
  // changed row's AI cells + badge so the caret isn't lost.
  function refreshRow(key) {
    const active = doc.activeElement;
    const typing = active && tableEl && typeof tableEl.contains === 'function' && tableEl.contains(active);
    if (!typing || !key || typeof tableEl.querySelector !== 'function') { renderTable(); return; }
    const row = _row(key);
    if (!row) { renderTable(); return; }
    const k = _attr(key);
    for (const col of L.aiCellIds(st.model)) {
      const c = _attr(col);
      const ta = tableEl.querySelector('textarea[data-key="' + k + '"][data-col="' + c + '"]');
      if (ta) {
        if (ta !== active) { ta.value = liveValue(row, col); autoGrow(ta); }
        const marks = tableEl.querySelector('[data-mark-key="' + k + '"][data-mark-col="' + c + '"]');
        if (marks) marks.innerHTML = L.markHtml(row, col);
        continue;
      }
      const td = tableEl.querySelector('td[data-key="' + k + '"][data-col="' + c + '"]');
      if (td) td.innerHTML = L.cellInnerHtml(row, col, liveValue(row, col));
    }
    const badge = tableEl.querySelector('[data-fdbr-badge="' + _attr(key) + '"]');
    if (badge) badge.innerHTML = L.badgeHtml(row, st.rowStatus[key]);
  }

  function renderStatus() {
    if (!statusEl) return;
    // AI done/total and ETA over the rows visible under the SCAC filter + hide-zero.
    const ai = L.aiProgress({ sessionKeys: st.sessionKeys, doneKeys: st.doneKeys, visibleKeys: visibleKeys() });
    const etaMin = st.drafting
      ? L.etaMinutes({ done: ai.done, total: ai.total, startedAt: st.draftStartedAt, now: now(), slots: MAX_DRAFTS_IN_FLIGHT })
      : null;
    const line = st.status === 'ready' ? L.statusLine(st.model, { ai: { done: ai.done, total: ai.total, etaMin }, scacs: st.scacs, nowMs: now() }) : '';
    statusEl.textContent = [line, st.note].filter(Boolean).join(' \u00b7 ');
  }
  function note(text) { st.note = text || ''; renderStatus(); }

  // The fleet-data-age alert comes first, then the refresh / fallback / "Fleet data updated" banner.
  function renderBanner() {
    if (!bannerEl) return;
    const fresh = st.status === 'ready' && st.model ? L.freshness(st.model, now()) : null;
    const staleHtml = fresh ? L.staleBannerHtml(fresh, now()) : '';
    let rest;
    if (st.refreshing) rest = L.refreshingBannerHtml();
    else if (st.refreshFailed) rest = L.fallbackBannerHtml(st.refreshFailed.builtAt);
    else rest = L.bannerHtml(st.stale && st.status === 'ready');
    bannerEl.innerHTML = staleHtml + rest;
  }

  // Re-render the banner and status line every FRESH_TICK_MS while open (cleared by close()).
  function freshTick() {
    later(() => {
      if (st.closed) return;
      renderBanner(); renderStatus();
      freshTick();
    }, FRESH_TICK_MS);
  }

  function renderAll() { renderFrame(); renderBanner(); renderStatus(); renderTable(); }

  const _row = (key) => (st.model && Array.isArray(st.model.rows) ? st.model.rows.find((r) => r.key === key) : null) || null;

  function setModel(m) {
    st.model = m || null;
    if (m && m.flags && typeof m.flags.aiDraft === 'boolean') st.aiDraft = st.aiDraft && m.flags.aiDraft;
  }

  // ── flow ──────────────────────────────────────────────────────────────────
  async function _call(name, payload) {
    try { return (await api[name](payload)) || { ok: false, code: 'internal' }; }
    catch (_) { return { ok: false, code: 'internal' }; }
  }

  function _failState(res) {
    if (res && res.code === 'off') { st.status = 'off'; return; }
    if (res && res.code === 'unavailable') { console.warn('[fleet-dbr] bridge unavailable'); st.status = 'unavailable'; return; }
    st.status = 'error';
    st.note = "Fleet DBR couldn't load (" + ((res && res.code) || 'error') + ').';
  }

  async function open() {
    mount();
    renderAll();
    freshTick();
    const btn = !isView && frame.querySelector && frame.querySelector('[data-fdbr-action="close"]');
    if (btn && typeof btn.focus === 'function') btn.focus();
    if (evBus && typeof evBus.on === 'function') {
      unsub = evBus.on('fleet:data', (d) => {
        if (st.closed || !st.model || !d || !d.syncedAt) return;
        if (d.syncedAt !== st.model.fleetSyncedAt) { st.stale = true; renderBanner(); }
      });
    }
    const s = await _call('status');
    if (st.closed) return;
    if (!s.ok) { _failState(s); renderAll(); return; }
    if (!s.enabled) { st.status = 'off'; renderAll(); return; }
    st.aiDraft = !!s.aiDraft;
    st.status = 'ready';
    note('Loading\u2026');
    const g = await _call('get');
    if (st.closed) return;
    if (!g.ok) { _failState(g); renderAll(); return; }
    if (g.model) {
      setModel(g.model); st.note = ''; renderAll();
      // View mode: fleet data synced after this build -> rebuild now (cached rows stay visible).
      if (isView && L.isFleetNewer(g.model.fleetSyncedAt, getFleetSyncedAt())) {
        st.refreshing = true;
        renderBanner();
        if (!(await build())) return;
      }
    } else if (!(await build())) return;
    autoDrafts();
  }

  // The automatic draft pass (open / build / SCAC change) runs only on fresh fleet data. When the
  // data is stale, partial or of unknown age it is skipped with a note; ✨ Draft all and ↻ Redraft
  // still work (those rows get a "drafted on stale data" badge).
  function autoDrafts() {
    if (!st.model) return;
    const f = L.freshness(st.model, now());
    if (f.status !== 'fresh') {
      if (st.aiDraft && !String(st.note || '').includes(DRAFTS_PAUSED)) note([st.note, DRAFTS_PAUSED].filter(Boolean).join(' \u00b7 '));
      return;
    }
    startDrafts(null);
  }

  // View mode only: a build that never answers resolves as a timeout, so the view can't hang.
  function _buildCall(payload) {
    const p = _call('build', payload);
    if (!isView) return p;
    let tid = null;
    const to = new Promise((resolve) => { tid = setT(() => resolve({ ok: false, code: 'timeout' }), buildTimeoutMs); });
    return Promise.race([p, to]).then((r) => { clrT(tid); return r; });
  }

  async function build() {
    if (st.building) return false;
    st.building = true;
    if (isView && st.model && st.status === 'ready') { st.refreshing = true; renderBanner(); }
    note(isView ? 'Building DBR\u2026' : 'Building from fleet data\u2026');
    const res = await _buildCall({ scacs: L.normalizeScacs(st.scacs, st.model) });
    st.building = false;
    st.refreshing = false;
    if (st.closed) return false;
    if (!res.ok && isView && st.model && st.status === 'ready') {
      // Keep the cached build on screen with the fallback banner; never blank the view.
      st.refreshFailed = { builtAt: st.model.builtAt || null, code: res.code || 'error' };
      st.note = res.code === 'no-fleet-data' ? 'No fleet data yet \u2014 run a sync, then \u21ba Rebuild' : "\u26a0 Build failed (" + (res.code || 'error') + ')';
      renderAll();
      return false;
    }
    if (!res.ok) {
      if (res.code === 'off' || res.code === 'unavailable') { _failState(res); renderAll(); return false; }
      note(res.code === 'no-fleet-data' ? 'No fleet data yet \u2014 run a sync, then \u21ba Build' : "\u26a0 Build failed (" + (res.code || 'error') + ')');
      return false;
    }
    setModel(res.model);
    st.stale = false;
    st.refreshFailed = null;
    st.rowStatus = {};
    st.note = res.saved === false ? '\u26a0 Built but not saved; edits and AI drafts may not persist' : '';
    const cov = res.serverCoverage;
    if (cov && Array.isArray(cov.missingFromFleet) && cov.missingFromFleet.length) {
      const n = Number(cov.missingCount) || cov.missingFromFleet.length;
      const sites = Array.isArray(cov.sites) ? cov.sites.join(', ') : '';
      st.note = [st.note, 'Relay shows ' + n + ' open WO' + (n === 1 ? '' : 's') + ' at ' + sites
        + ' that are not in fleet data \u2014 run a sync'].filter(Boolean).join(' \u00b7 ');
    }
    renderAll();
    return true;
  }

  // ── AI drafting (2 at a time, busy re-queue x3, Stop) ─────────────────────
  function startDrafts(keys) {
    if (!st.aiDraft || !st.model || st.closed) return;
    const list = keys || L.eligibleForAutoDraft(st.model, { hideZero: st.hideZero, scacs: st.scacs });
    const queued = new Set(st.queue.map((q) => q.key));
    const vis = visibleKeys(); // AI time is only spent on rows the user can see
    const add = [];
    for (const key of list) {
      if (!vis.has(key) || queued.has(key) || st.inFlight.has(key) || st.retrying.has(key)) continue;
      queued.add(key);
      add.push(key);
    }
    if (!add.length) return;
    if (!st.drafting) {
      st.done = 0; st.total = 0; st.draftStartedAt = now();
      st.sessionKeys = new Set(); st.doneKeys = new Set();
    }
    for (const key of add) {
      st.queue.push({ key, tries: 0 });
      st.rowStatus[key] = { state: 'queued' };
      st.sessionKeys.add(key);
      st.doneKeys.delete(key);
    }
    const added = add.length;
    st.total += added;
    const wasDrafting = st.drafting;
    st.drafting = true;
    st.stopped = false;
    if (!wasDrafting) statusTick();
    renderFrame(); renderTable(); renderStatus();
    pump();
  }

  // Re-render the status line (ETA) every 30 s while drafting; stops on drain / Stop / close.
  let tickId = null;
  function statusTick() {
    if (tickId != null) { clrT(tickId); timers.delete(tickId); }
    tickId = later(() => {
      tickId = null;
      if (st.closed || !st.drafting) return;
      renderStatus();
      statusTick();
    }, STATUS_TICK_MS);
  }
  function stopTick() {
    if (tickId != null) { clrT(tickId); timers.delete(tickId); tickId = null; }
  }

  function pump() {
    while (!st.stopped && !st.closed && st.inFlight.size < MAX_DRAFTS_IN_FLIGHT && st.queue.length) runDraft(st.queue.shift());
    if (!st.inFlight.size && !st.queue.length && !st.retrying.size && st.drafting) {
      st.drafting = false;
      stopTick();
      renderFrame(); renderStatus();
    }
  }

  async function runDraft(item) {
    const key = item.key;
    st.inFlight.add(key);
    st.rowStatus[key] = { state: 'pending' };
    refreshRow(key); renderStatus();
    const res = await _call('draft', { key });
    st.inFlight.delete(key);
    if (st.closed) return;
    let requeue = false;
    if (res.ok) {
      if (res.model) setModel(res.model);
      else _patchDraft(key, res);
      delete st.rowStatus[key];
      st.done++;
      st.doneKeys.add(key);
      // R-N3: drafted before the FAS alias was known (either branch) -> redraft once per panel.
      const row = _row(key);
      if (row && row.draft && row.draft.staleReason === 'identity' && !st.identityRequeued.has(key)) {
        st.identityRequeued.add(key);
        requeue = true;
      }
    } else if (res.code === 'busy' && item.tries < BUSY_RETRIES && !st.stopped) {
      item.tries++;
      st.retrying.add(key);
      st.rowStatus[key] = { state: 'queued' };
      later(() => {
        st.retrying.delete(key);
        if (st.closed) return;
        if (st.stopped) { delete st.rowStatus[key]; pump(); refreshRow(key); return; }
        // Row hidden by the SCAC filter meanwhile: drop the retry (no AI time on hidden rows).
        if (!visibleKeys().has(key)) { delete st.rowStatus[key]; renderStatus(); pump(); return; }
        st.queue.unshift(item); pump(); // retry goes first when a slot frees
      }, BUSY_RETRY_MS);
    } else {
      if (res.code === 'stale-build') { st.stale = true; renderBanner(); }
      st.rowStatus[key] = { state: 'error', code: res.code || 'ai-failed' };
      st.done++;
      st.doneKeys.add(key);
    }
    refreshRow(key); renderStatus();
    if (requeue && !st.stopped) startDrafts([key]);
    pump();
  }

  // Draft committed but no model came back (snapshot save path): patch locally with the same
  // rule as main's applyOverlays v3: only res.sheet cells of the draft sheet ids (6 Details,
  // FAS Actions, Support), a Details cell only when its computed Y/N is Y; Y/N and counts are
  // never touched. res.unitNotes / flags go to the drill-down. Never throws on a missing field,
  // so runDraft always reaches refreshRow + pump.
  function _patchDraft(key, res) {
    const row = _row(key);
    if (!row) return;
    const sheet = res.sheet && typeof res.sheet === 'object' ? res.sheet : {};
    const ids = st.model && Array.isArray(st.model.draftSheetIds) && st.model.draftSheetIds.length
      ? st.model.draftSheetIds : L.fillColumns(st.model).map((c) => c.id).filter((id) => /Details$/.test(id) || id === 'fasActions' || id === 'support');
    row.cells = Object.assign({}, row.cells); row.source = Object.assign({}, row.source);
    row.base = Object.assign({}, row.base);
    for (const col of ids) {
      const v = sheet[col];
      if (typeof v !== 'string' || !v.trim()) continue;
      if (/Details$/.test(col) && !/^y/i.test(String(row.base[col.replace(/Details$/, 'YN')] || ''))) continue;
      row.base[col] = v;
      if (row.source[col] !== 'edit') { row.cells[col] = v; row.source[col] = 'ai'; }
    }
    const arr = (v) => (Array.isArray(v) ? v : []);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    row.unitNotes = obj(res.unitNotes);
    row.unitNoteFlags = Object.fromEntries(Object.entries(obj(res.flags)).filter(([id, f]) => ids.includes(id) && f === 'review'));
    row.disagreements = arr(res.disagreements);
    row.etcUnits = arr(res.etcUnits);
    row.etcDisagreements = arr(res.etcDisagreements);
    row.etcOverrides = arr(res.etcOverrides);
    row.provenance = res.provenance && typeof res.provenance === 'object' ? res.provenance : {};
    row.unverifiedNames = arr(res.unverifiedNames);
    row.unboundDates = arr(res.unboundDates);
    row.reviewSkipped = typeof res.reviewSkipped === 'string' ? res.reviewSkipped : null;
    row.draft = { state: 'ok', draftedAt: res.draftedAt || null };
    if (typeof res.dataAsOf === 'string' && res.dataAsOf) row.draft.dataAsOf = res.dataAsOf;
    if (typeof res.dataStatus === 'string' && res.dataStatus) row.draft.dataStatus = res.dataStatus;
  }

  function stopDrafts() {
    st.stopped = true;
    for (const q of st.queue) delete st.rowStatus[q.key];
    st.queue = [];
    for (const k of st.retrying) delete st.rowStatus[k];
    st.drafting = false;
    stopTick();
    renderFrame(); renderTable(); renderStatus();
  }

  // ── SCAC filter ───────────────────────────────────────────────────────────
  // In-flight drafts are never aborted (their results land normally). Queued rows that
  // became hidden are dropped; newly visible eligible rows are queued unless the user
  // pressed ■ Stop. Already-drafted (ok) rows are not eligible, so nothing is re-drafted.
  function applyScacs(next, focusScac) {
    st.scacs = L.normalizeScacs(next, st.model);
    if (storage) storage.setItem(SCAC_KEY, JSON.stringify(st.scacs));
    const vis = visibleKeys();
    st.queue = st.queue.filter((q) => {
      if (vis.has(q.key)) return true;
      delete st.rowStatus[q.key];
      return false;
    });
    renderFrame(focusScac); renderTable(); renderStatus();
    if (!st.stopped) autoDrafts();
    pump();
  }

  // ── edits ─────────────────────────────────────────────────────────────────
  function scheduleSave(key, col) {
    const id = key + '\u0000' + col;
    if (st.pending[id]) { clrT(st.pending[id]); timers.delete(st.pending[id]); }
    st.pending[id] = later(() => { delete st.pending[id]; saveNow(key, col); }, SAVE_DEBOUNCE_MS);
  }

  async function saveNow(key, col) {
    const l = st.live[key];
    if (!l || !Object.prototype.hasOwnProperty.call(l, col)) return;
    const value = l[col];
    const res = await _call('saveEdit', { key, col, value });
    if (res.ok) {
      const row = _row(key);
      if (row) {
        row.cells = Object.assign({}, row.cells, { [col]: value });
        row.source = Object.assign({}, row.source, { [col]: 'edit' });
      }
      if (st.live[key] && st.live[key][col] === value) delete st.live[key][col];
      return;
    }
    if (res.code === 'unknown-row') return; // row vanished after a rebuild: drop silently
    if (!st.closed) note("\u26a0 Couldn't save edit (" + (res.code || 'error') + '). Your text is still in the cell and Copy includes it.');
  }

  function cancelPending(key) {
    for (const id of Object.keys(st.pending)) {
      if (key != null && id.split('\u0000')[0] !== key) continue;
      clrT(st.pending[id]); timers.delete(st.pending[id]); delete st.pending[id];
    }
  }

  function flushPending() {
    for (const id of Object.keys(st.pending)) {
      clrT(st.pending[id]); timers.delete(st.pending[id]); delete st.pending[id];
      const [key, col] = id.split('\u0000');
      saveNow(key, col); // fire-and-forget on close
    }
  }

  async function resetRow(key) {
    cancelPending(key);
    const res = await _call('resetRow', { key });
    if (st.closed) return;
    if (!res.ok) { note("\u26a0 Couldn't reset row (" + (res.code || 'error') + ').'); return; }
    delete st.live[key];
    const g = await _call('get');
    if (st.closed) return;
    if (g.ok && g.model) setModel(g.model);
    else {
      const row = _row(key);
      if (row) {
        row.cells = Object.assign({}, row.base);
        row.source = Object.assign({}, row.source);
        for (const id of Object.keys(row.source)) if (row.source[id] === 'edit') row.source[id] = 'computed';
      }
    }
    renderAll();
  }

  async function setFasName(name) {
    const res = await _call('setFasName', { name });
    if (st.closed) return;
    if (!res.ok) { note("\u26a0 Couldn't save FAS name (" + (res.code || 'error') + ').'); return; }
    const m = st.model;
    if (m) {
      m.fasName = res.fasName;
      m.userName = res.fasName;
      m.fasNameSource = res.fasName ? 'panel' : 'none';
      const norm = (s) => String(s || '').trim().toLowerCase();
      for (const r of m.rows || []) {
        // Same rule as main's applyOverlays: mine = exact roster owner equals the user name.
        r.mine = !!m.rosterLoaded && !!res.fasName && r.fasSource === 'roster' && norm(r.base && r.base.fasName) === norm(res.fasName);
        // With the roster loaded, rows without an exact roster owner keep an empty FAS Name.
        if (r.fasSource === 'roster' || m.rosterLoaded) continue;
        r.fasSource = res.fasName ? 'you' : 'none';
        r.base = Object.assign({}, r.base, { fasName: res.fasName });
        if (!r.source || r.source.fasName !== 'edit') r.cells = Object.assign({}, r.cells, { fasName: res.fasName });
      }
    }
    st.note = '';
    renderAll();
  }

  // ── copy ──────────────────────────────────────────────────────────────────
  // Effective copy scope: 'mine' only when that option is available (roster, name, a matching pair).
  function copyKind() {
    return st.copyScope === 'mine' && st.model && L.copyScopeInfo(st.model, st.hideZero, st.scacs).mineOk ? 'mine' : 'visible';
  }

  // Copies in the golden sheet format (L.sheetTsv). fillOnly: only the fill columns
  // (L.fillColumns), no identity/count columns, no header. kind: 'mine' | 'visible' | 'row'.
  async function copy(rows, header, btnEl, fillOnly, kind) {
    const m = st.model;
    if (!m) { note('Nothing to copy yet \u2014 \u21ba Build first.'); return; }
    const isLive = (r, col) => !!(st.live[r.key] && Object.prototype.hasOwnProperty.call(st.live[r.key], col));
    // Live (unsaved) typing is a user edit: copied as typed, like a saved edit.
    const getSource = (r, col) => (isLive(r, col) ? 'edit' : (r.source ? r.source[col] : undefined));
    const tsv = L.sheetTsv(fillOnly ? L.fillColumns(m) : m.columns, rows, liveValue, { header: !!header && !fillOnly, getSource });
    let ok = false;
    try { ok = (await clipboard.writeText(tsv)) !== false; } catch (_) { ok = false; }
    if (st.closed) return;
    if (!ok) { note('\u26a0 Copy failed \u2014 select the table and Ctrl+C'); return; }
    // The pasted text is unchanged; the note tells the user what was copied and what needs a look.
    const scope = kind === 'mine' ? ' (your pairs with units down)' : (kind === 'visible' ? ' (all visible rows)' : '');
    let text = 'Copied ' + rows.length + (rows.length === 1 ? ' row' : ' rows') + scope;
    // Status of the copied data (as of the last AAP build); the copied text never changes.
    const fresh = L.freshness(m, now());
    const asOf = L.fmtClock(fresh.dataAsOf);
    const asOfNote = asOf ? ' (as of ' + asOf + ')' : '';
    if (fresh.stale) text += fresh.label ? ' \u00b7 \u26a0 fleet data is ' + fresh.label + ' old' + asOfNote : ' \u00b7 \u26a0 fleet sync time unknown';
    else if (fresh.status === 'partial') text += ' \u00b7 \u26a0 fleet data partial' + asOfNote;
    if (fresh.refreshFailed) text += ' \u00b7 \u26a0 AAP refresh failing since ' + (L.fmtClock(fresh.lastFailAt) || 'unknown');
    if (m.flags && m.flags.aiDraft) {
      const auto = rows.filter((r) => r && r.pair && r.pair.down > 0 && (!r.draft || r.draft.state !== 'ok')).length;
      if (auto) text += ' \u00b7 ' + auto + (auto === 1 ? ' row uses' : ' rows use') + ' auto text (AI draft pending)';
    }
    const flagged = L.flaggedCount(rows, isLive);
    if (flagged) text += ' \u2014 ' + flagged + (flagged === 1 ? ' cell' : ' cells') + ' flagged \u26a0 \u2014 review before pasting';
    note(text);
    if (btnEl && typeof btnEl.textContent === 'string') {
      const orig = btnEl.textContent;
      btnEl.textContent = '\u2713 Copied';
      later(() => { btnEl.textContent = orig; }, 1500);
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  function onClick(e) {
    const t = e && e.target;
    if (t === overlay) { if (!isView) close(); return; }
    const el = t && typeof t.closest === 'function' ? t.closest('[data-fdbr-action]') : null;
    if (!el || !el.dataset) return;
    const key = el.dataset.key;
    switch (el.dataset.fdbrAction) {
      case 'close': close(); return;
      case 'build': return build().then((ok) => { if (ok) autoDrafts(); });
      case 'draft-all': startDrafts(st.model ? L.eligibleForAutoDraft(st.model, { includeEvidenceStale: true, hideZero: st.hideZero, scacs: st.scacs }) : null); return;
      case 'scac-all': applyScacs([]); return;
      case 'stop': stopDrafts(); return;
      case 'redraft': if (key) startDrafts([key]); return;
      case 'reset-row': if (key) return resetRow(key); return;
      case 'copy': return copy(L.copyRows(st.model, st.copyScope, st.hideZero, st.scacs), false, el, false, copyKind());
      case 'copy-header': return copy(L.copyRows(st.model, st.copyScope, st.hideZero, st.scacs), true, el, false, copyKind());
      case 'copy-fill': return copy(L.copyRows(st.model, st.copyScope, st.hideZero, st.scacs), false, el, true, copyKind());
      // Copy row = this row's fill columns only (1P Vendor Barrier Y/N? .. Where Do You Need Support?).
      case 'copy-row': { const row = key ? _row(key) : null; if (row) return copy([row], false, el, true, 'row'); return; }
      default:
    }
  }

  function onInput(e) {
    const t = e && e.target;
    const ds = t && t.dataset;
    if (!ds || !ds.key || !ds.col) return;
    (st.live[ds.key] = st.live[ds.key] || {})[ds.col] = String(t.value == null ? '' : t.value);
    autoGrow(t);
    scheduleSave(ds.key, ds.col);
  }

  function onChange(e) {
    const t = e && e.target;
    const field = t && t.dataset && t.dataset.fdbrField;
    if (field === 'fasName') return setFasName(String(t.value == null ? '' : t.value));
    if (field === 'copyScope') {
      st.copyScope = t.value === 'visible' ? 'visible' : 'mine';
      if (storage) storage.setItem(COPY_SCOPE_KEY, st.copyScope);
      renderFrame();
      return;
    }
    if (field === 'hideZero') {
      st.hideZero = !!t.checked;
      if (storage) storage.setItem(HIDE_ZERO_KEY, st.hideZero ? '1' : '0');
      renderFrame(); renderTable();
      return;
    }
    if (field === 'scac') {
      const scac = String((t.dataset && t.dataset.scac) || '');
      if (!scac) return;
      const sel = new Set(L.normalizeScacs(st.scacs, st.model));
      if (t.checked) sel.add(scac); else sel.delete(scac);
      applyScacs(sel, scac);
    }
  }

  function onKeydown(e) {
    if (!isView && e && e.key === 'Escape') { if (typeof e.preventDefault === 'function') e.preventDefault(); close(); }
  }

  function close() {
    if (st.closed) return;
    st.stopped = true;
    st.queue = [];
    flushPending();
    st.closed = true;
    for (const id of timers) clrT(id);
    timers.clear();
    if (typeof unsub === 'function') { try { unsub(); } catch (_) { /* ignore */ } }
    unsub = null;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    if (returnFocusEl && typeof returnFocusEl.focus === 'function') { try { returnFocusEl.focus(); } catch (_) { /* detached */ } }
    if (typeof onClose === 'function') onClose();
  }

  return {
    open, close, build,
    get overlay() { return overlay; },
    get state() { return st; },
  };
}

export const __test__ = { createController, BUILD_TIMEOUT_MS, SAVE_DEBOUNCE_MS, MAX_DRAFTS_IN_FLIGHT, HIDE_ZERO_KEY, SCAC_KEY, COPY_SCOPE_KEY, FRESH_TICK_MS };
