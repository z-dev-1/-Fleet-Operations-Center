/**
 * fleet-dbr-panel.js — the Daily Call "📊 DBR DATA" panel: the 24-column Fleet
 * Health DBR built from fleet data (main: src/ipc/fleet-dbr.js), replacing the
 * retired dashboard-scrape AFP/DSP overlay.
 *
 * - ↺ Build from fleet data, editable cells (debounced save), per-row Reset/Copy.
 * - ✨ Draft with AI / ■ Stop: AI drafts fill the 17 judgment cells (model.aiCellIds;
 *   fact-checked main-side, hard cells never change), carry "AI" / "⚠ check" text
 *   markers, editable cells stay editable, and nothing is sent anywhere.
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

  const st = {
    status: 'loading', aiDraft: false, model: null, note: '',
    hideZero: false, stale: false, closed: false, building: false,
    drafting: false, stopped: false, queue: [], inFlight: new Set(), retrying: new Set(),
    done: 0, total: 0, rowStatus: {}, draftStartedAt: 0,
    identityRequeued: new Set(), // R-N3: keys re-queued once because the FAS alias became known
    live: {},     // key -> { col -> unsaved/just-typed value }
    pending: {},  // 'key\u0000col' -> debounce timer
  };
  try { st.hideZero = storage && storage.getItem(HIDE_ZERO_KEY) === '1'; } catch (_) { st.hideZero = false; }

  let overlay = null; let frame = null; let bannerEl = null; let statusEl = null; let tableEl = null;
  let unsub = null; let lastFrame = '';
  const timers = new Set();
  const later = (fn, ms) => { const id = setT(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  // ── rendering ─────────────────────────────────────────────────────────────
  function mount() {
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

  function renderFrame() {
    const m = st.model;
    const html = L.panelHtml({
      status: st.status, aiDraft: st.aiDraft, drafting: st.drafting, hideZero: st.hideZero,
      fasName: m ? m.fasName : '', conflicts: m ? m.conflicts : [], message: st.note,
    });
    if (html === lastFrame) return; // keep focus/caret in the FAS Name input
    lastFrame = html;
    frame.innerHTML = html;
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
      ? L.tableHtml(st.model, { aiDraft: st.aiDraft, rowStatus: st.rowStatus, hideZero: st.hideZero, getValue: liveValue })
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
    const etaMin = st.drafting
      ? L.etaMinutes({ done: st.done, total: st.total, startedAt: st.draftStartedAt, now: now(), slots: MAX_DRAFTS_IN_FLIGHT })
      : null;
    const line = st.status === 'ready' ? L.statusLine(st.model, { ai: { done: st.done, total: st.total, etaMin } }) : '';
    statusEl.textContent = [line, st.note].filter(Boolean).join(' \u00b7 ');
  }
  function note(text) { st.note = text || ''; renderStatus(); }

  function renderBanner() { if (bannerEl) bannerEl.innerHTML = L.bannerHtml(st.stale && st.status === 'ready'); }

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
    const btn = frame.querySelector && frame.querySelector('[data-fdbr-action="close"]');
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
    if (g.model) { setModel(g.model); st.note = ''; renderAll(); }
    else if (!(await build())) return;
    startDrafts(null);
  }

  async function build() {
    if (st.building) return false;
    st.building = true;
    note('Building from fleet data\u2026');
    const res = await _call('build');
    st.building = false;
    if (st.closed) return false;
    if (!res.ok) {
      if (res.code === 'off' || res.code === 'unavailable') { _failState(res); renderAll(); return false; }
      note(res.code === 'no-fleet-data' ? 'No fleet data yet \u2014 run a sync, then \u21ba Build' : "\u26a0 Build failed (" + (res.code || 'error') + ')');
      return false;
    }
    setModel(res.model);
    st.stale = false;
    st.rowStatus = {};
    st.note = res.saved === false ? '\u26a0 Built but not saved; edits and AI drafts may not persist' : '';
    renderAll();
    return true;
  }

  // ── AI drafting (2 at a time, busy re-queue x3, Stop) ─────────────────────
  function startDrafts(keys) {
    if (!st.aiDraft || !st.model || st.closed) return;
    const list = keys || L.eligibleForAutoDraft(st.model);
    const queued = new Set(st.queue.map((q) => q.key));
    let added = 0;
    for (const key of list) {
      if (queued.has(key) || st.inFlight.has(key) || st.retrying.has(key)) continue;
      st.queue.push({ key, tries: 0 });
      st.rowStatus[key] = { state: 'queued' };
      added++;
    }
    if (!added) return;
    if (!st.drafting) { st.done = 0; st.total = 0; st.draftStartedAt = now(); }
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
        st.queue.unshift(item); pump(); // retry goes first when a slot frees
      }, BUSY_RETRY_MS);
    } else {
      if (res.code === 'stale-build') { st.stale = true; renderBanner(); }
      st.rowStatus[key] = { state: 'error', code: res.code || 'ai-failed' };
      st.done++;
    }
    refreshRow(key); renderStatus();
    if (requeue && !st.stopped) startDrafts([key]);
    pump();
  }

  // Draft committed but no model came back (snapshot save path): patch locally. Reads
  // res.cells / sources / flags (v2) or res.fasActions / support (v1); never throws on a
  // missing field, so runDraft always reaches refreshRow + pump.
  function _patchDraft(key, res) {
    const row = _row(key);
    if (!row) return;
    const cells = res.cells && typeof res.cells === 'object' ? res.cells : null;
    const srcs = res.sources && typeof res.sources === 'object' ? res.sources : {};
    const flags = res.flags && typeof res.flags === 'object' ? res.flags : {};
    row.cells = Object.assign({}, row.cells); row.source = Object.assign({}, row.source);
    row.base = Object.assign({}, row.base);
    const put = (col, v, src) => {
      if (typeof v !== 'string') return;
      row.base[col] = v;
      if (row.source[col] !== 'edit') { row.cells[col] = v; row.source[col] = src; }
    };
    if (cells) {
      for (const col of L.aiCellIds(st.model)) put(col, cells[col], srcs[col] === 'computed' ? 'computed' : 'ai');
    } else {
      for (const col of ['fasActions', 'support']) if (res[col]) put(col, res[col], 'ai');
    }
    const arr = (v) => (Array.isArray(v) ? v : []);
    row.flags = cells ? Object.assign({}, flags) : (row.flags || {});
    row.disagreements = arr(res.disagreements);
    row.etcUnits = arr(res.etcUnits);
    row.etcDisagreements = arr(res.etcDisagreements);
    row.etcOverrides = arr(res.etcOverrides);
    row.provenance = res.provenance && typeof res.provenance === 'object' ? res.provenance : {};
    row.unverifiedNames = arr(res.unverifiedNames);
    row.unboundDates = arr(res.unboundDates);
    row.reviewSkipped = typeof res.reviewSkipped === 'string' ? res.reviewSkipped : null;
    row.draft = { state: 'ok', draftedAt: res.draftedAt || null };
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
      m.fasNameSource = res.fasName ? 'panel' : 'none';
      for (const r of m.rows || []) {
        if (r.fasSource === 'roster') continue;
        r.fasSource = res.fasName ? 'you' : 'none';
        r.base = Object.assign({}, r.base, { fasName: res.fasName });
        if (!r.source || r.source.fasName !== 'edit') r.cells = Object.assign({}, r.cells, { fasName: res.fasName });
      }
    }
    st.note = '';
    renderAll();
  }

  // ── copy ──────────────────────────────────────────────────────────────────
  async function copy(rows, header, btnEl) {
    const m = st.model;
    if (!m) { note('Nothing to copy yet \u2014 \u21ba Build first.'); return; }
    const tsv = L.rowsToTsv(m.columns, rows, liveValue, { header });
    let ok = false;
    try { ok = (await clipboard.writeText(tsv)) !== false; } catch (_) { ok = false; }
    if (st.closed) return;
    if (!ok) { note('\u26a0 Copy failed \u2014 select the table and Ctrl+C'); return; }
    // The pasted text is unchanged; the note tells the user what still needs a look.
    const isLive = (r, col) => !!(st.live[r.key] && Object.prototype.hasOwnProperty.call(st.live[r.key], col));
    const flagged = L.flaggedCount(rows, isLive);
    note(flagged ? 'Copied ' + rows.length + (rows.length === 1 ? ' row' : ' rows') + ' \u2014 '
      + flagged + (flagged === 1 ? ' cell' : ' cells') + ' flagged \u26a0 \u2014 review before pasting' : '');
    if (btnEl && typeof btnEl.textContent === 'string') {
      const orig = btnEl.textContent;
      btnEl.textContent = '\u2713 Copied';
      later(() => { btnEl.textContent = orig; }, 1500);
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  function onClick(e) {
    const t = e && e.target;
    if (t === overlay) { close(); return; }
    const el = t && typeof t.closest === 'function' ? t.closest('[data-fdbr-action]') : null;
    if (!el || !el.dataset) return;
    const key = el.dataset.key;
    switch (el.dataset.fdbrAction) {
      case 'close': close(); return;
      case 'build': return build().then((ok) => { if (ok) startDrafts(null); });
      case 'draft-all': startDrafts(st.model ? L.eligibleForAutoDraft(st.model, { includeEvidenceStale: true }) : null); return;
      case 'stop': stopDrafts(); return;
      case 'redraft': if (key) startDrafts([key]); return;
      case 'reset-row': if (key) return resetRow(key); return;
      case 'copy': return copy(L.visibleRows(st.model, st.hideZero), false, el);
      case 'copy-header': return copy(L.visibleRows(st.model, st.hideZero), true, el);
      case 'copy-row': { const row = key ? _row(key) : null; if (row) return copy([row], false, el); return; }
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
    if (field === 'hideZero') {
      st.hideZero = !!t.checked;
      if (storage) storage.setItem(HIDE_ZERO_KEY, st.hideZero ? '1' : '0');
      renderFrame(); renderTable();
    }
  }

  function onKeydown(e) {
    if (e && e.key === 'Escape') { if (typeof e.preventDefault === 'function') e.preventDefault(); close(); }
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

export const __test__ = { createController, SAVE_DEBOUNCE_MS, MAX_DRAFTS_IN_FLIGHT, HIDE_ZERO_KEY };
