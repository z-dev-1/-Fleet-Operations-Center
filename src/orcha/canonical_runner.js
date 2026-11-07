'use strict';
/**
 * orcha/canonical_runner.js -- run the canonical-state pass in API mode.
 *
 * WHY (2026-10-28): the canonical pass (per-unit status / owner / flags, the
 * ready-for-pickup carrier notice) only ran at the end of the legacy SCRAPE
 * sync (src/sync/index.js _runCanonicalPass). When the AAP API became the
 * default fleet source on 10-16 that code path stopped running, so canonical
 * state froze at 2026-10-16T22:43 and the notes-based ready notice went silent.
 * This runs the same pass after each API fleet load + deep-scan.
 *
 * Also persists what deep-scan learned (Decisiv case stage + offsite notes):
 * in API mode deep-scan only pushData()s its rows, it never saves them, so the
 * stored fleetData never had the stage the canonical pass needs.
 *
 * QUIET BASELINE: when the last canonical run is older than GAP_MS (e.g. the
 * first run after the 10-16 gap, or after the app was off), every unit would
 * look like a fresh transition vs the old snapshot and the ready notice could
 * message a batch of carriers at once. That run records today as the baseline
 * and sends NOTHING; normal transitions resume from the next run.
 */

const GAP_MS = 6 * 3600 * 1000;

// Fields deep-scan updates on its in-memory rows (offsite enrich + case stage).
const DS_FIELDS = ['offsiteStage', 'offsiteStageDetail', 'offsiteStageSince',
  'asistNotes', 'asistScrapedAt', 'asistSource', 'asistLabel', 'asistSrUrl'];

/**
 * overlayDeepScanFields(liveRows, scannedRows) -> number of rows updated.
 * Pure (mutates liveRows in place). Copies DS_FIELDS by equipmentId, only when
 * the scanned value is non-empty AND the offsite still belongs to the same WR
 * (_offsiteWrId), so a cleared/stale offsite is never resurrected.
 */
// Copy a field GROUP only when the scanned copy was read MORE RECENTLY than
// what's already stored. FIX (2026-10-28): deep-scan works on rows loaded
// before it started; a stage refresh that saved "322504 = no status" was then
// overwritten by the deep-scan's stale in-memory "ready". Newer read wins.
const NOTE_FIELDS  = ['asistNotes', 'asistScrapedAt', 'asistSource', 'asistLabel', 'asistSrUrl'];
const STAGE_FIELDS = ['offsiteStage', 'offsiteStageDetail', 'offsiteStageSince', '_stageReadAt'];
const _t = (v) => { const n = v ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : 0; };

function overlayDeepScanFields(liveRows, scannedRows) {
  if (!Array.isArray(liveRows) || !Array.isArray(scannedRows) || !scannedRows.length) return 0;
  const byId = new Map();
  for (const s of scannedRows) if (s && s.equipmentId) byId.set(String(s.equipmentId), s);
  let n = 0;
  for (const r of liveRows) {
    const s = r && byId.get(String(r.equipmentId));
    if (!s || s === r) continue;
    if (String(s._offsiteWrId || '') !== String(r._offsiteWrId || '')) continue;
    let touched = false;
    // Notes: newer asistScrapedAt wins.
    if (_t(s.asistScrapedAt) > _t(r.asistScrapedAt)) {
      for (const k of NOTE_FIELDS) if (s[k] != null && s[k] !== r[k]) { r[k] = s[k]; touched = true; }
    }
    // Stage trio (incl. an API "no status" answer = empty stage): newer
    // _stageReadAt wins, copied together so stage/detail/since never mix.
    if (_t(s._stageReadAt) > _t(r._stageReadAt)) {
      for (const k of STAGE_FIELDS) if ((s[k] == null ? '' : s[k]) !== (r[k] == null ? '' : r[k])) { r[k] = s[k] == null ? '' : s[k]; touched = true; }
    }
    if (touched) n++;
  }
  return n;
}

function _defaultNotifyDeps() {
  const slack = require('../scrapers/slack_send');
  const { resolveOperatorEntry } = require('../scrapers/pm_alert_reply');
  return {
    sendToChannel: slack.sendToChannel,
    askOrcha: (p, o) => require('./relay').ask(p, Object.assign({}, o)),
    resolveOperatorEntry,
  };
}

/**
 * runCanonicalPass(opts) -> { ok, baseline, counts, overlaid, notifyQueued }
 * opts: { scannedRows?, pushData?, ctx?, deps? }
 * deps (tests): { store, canonical, readyNotify, notifyDeps, now, log }
 * Synchronous load -> compute -> save (no await in between, so no other
 * writer's fleetData save can interleave). The carrier notice is queued.
 */
function runCanonicalPass(opts = {}) {
  // Telemetry wrap (Phase 2a): sync pass-through, same return value / throws.
  return require('../telemetry').track('canonical.pass', () => _runCanonicalPassImpl(opts));
}

// The legacy pass, split into _prepare → _compute → _commit with the exact
// same statement order (Phase 8). The legacy path has prep.gen === null, so
// _commit skips the generation check and the whole pass stays synchronous.
function _runCanonicalPassImpl(opts = {}) {
  const prep = _prepare(opts, false);
  if (!prep.ok) return prep.early;
  const built = _compute(prep);
  return _commit(prep, built, opts, null);
}

function _defaultLog() {
  try { const l = require('../utils/logger')('canonical'); return { info: (m) => l.info(m), warn: (m) => l.warn(m) }; }
  catch (_) { return { info() {}, warn() {} }; }
}

/**
 * _prepare(opts, withGen) — every legacy step up to buildAll: resolve deps,
 * load fleetData, overlay the deep-scan fields, load canonicalState, compute
 * the baseline. withGen records the store write generations of both keys right
 * after loading them (isolated path only).
 */
function _prepare(opts, withGen) {
  const deps = opts.deps || {};
  const store = deps.store || require('../store');
  const canonical = deps.canonical || require('./canonical_state');
  const readyNotify = deps.readyNotify || require('../scrapers/ready_pickup_notify');
  const log = deps.log || _defaultLog();
  const now = deps.now ? deps.now() : Date.now();

  const fd = store.load('fleetData', {}) || {};
  const rows = Array.isArray(fd.rows) ? fd.rows : [];
  if (!rows.length) return { ok: false, early: { ok: false, reason: 'no fleet rows' } };

  const overlaid = overlayDeepScanFields(rows, opts.scannedRows);

  const prevCanon = store.load('canonicalState', {}) || {};
  const priorUnits = prevCanon.units || {};
  const gen = withGen ? { fd: store.generation('fleetData'), cs: store.generation('canonicalState') } : null;
  const lastMs = prevCanon.updatedAt ? Date.parse(prevCanon.updatedAt) : NaN;
  const baseline = !Number.isFinite(lastMs) || (now - lastMs) > GAP_MS;
  return { ok: true, deps, store, canonical, readyNotify, log, now, fd, rows, overlaid, prevCanon, priorUnits, baseline, gen };
}

function _compute(prep) {
  const { units, counts } = prep.canonical.buildAll(prep.rows, { decisions: {}, prior: prep.priorUnits });
  return { units, counts };
}

const STALE = Object.freeze({ stale: true });

/**
 * _commit(prep, built, opts, iso) — per-unit baseline, save canonicalState,
 * mirror, save fleetData, ctx/pushData, notify enqueue, log line. When prep.gen
 * is set (isolated path), its FIRST statement is the store write-generation
 * check: if another writer saved fleetData or canonicalState since _prepare
 * loaded them, it returns STALE without writing. Check and writes sit in one
 * synchronous block, so nothing can interleave between them.
 */
function _commit(prep, built, opts, iso) {
  if (prep.gen && (prep.store.generation('fleetData') !== prep.gen.fd || prep.store.generation('canonicalState') !== prep.gen.cs)) return STALE;
  const { deps, store, canonical, readyNotify, log, now, fd, rows, overlaid, prevCanon, priorUnits, baseline } = prep;
  const tCommit = iso ? _perfNow() : 0;
  // PER-UNIT baseline (FIX 2026-10-28): the file-level updatedAt is NOT enough
  // -- the single-unit refresh (ipc/scrapers.js) saves one unit and stamps the
  // whole file fresh, so a file full of 10-16 records looked current and B12343
  // got a catch-up notice. A unit only counts as a real transition when ITS OWN
  // prior record is recent; otherwise it's baselined quietly.
  const _priorFresh = (id) => {
    const p = priorUnits[id];
    const t = p && p.updatedAt ? Date.parse(p.updatedAt) : NaN;
    return Number.isFinite(t) && (now - t) <= GAP_MS;
  };

  const { units, counts } = built;

  let baselinedUnits = 0;
  for (const id of Object.keys(units)) {
    if (!units[id]) continue;
    if (baseline || !_priorFresh(id)) {
      // Record today's state as this unit's starting point; no "transition".
      if (units[id].previousStatus) baselinedUnits++;
      units[id].previousStatus = null;
    }
  }

  store.save('canonicalState', {
    units,
    updatedAt: new Date(now).toISOString(),
    lastReconcileAt: prevCanon.lastReconcileAt || null,
    ...(baseline ? { baselineAt: new Date(now).toISOString() } : {}),
  });

  // Mirror canonical fields + the deep-scan fields onto the stored rows.
  fd.rows = rows.map((r) => {
    const rec = r && units[r.equipmentId];
    return rec ? Object.assign({}, r, canonical.mirrorFields(rec)) : r;
  });
  store.save('fleetData', fd);
  if (opts.ctx) opts.ctx.lastData = fd;
  if (typeof opts.pushData === 'function') { try { opts.pushData(fd); } catch (_) {} }

  let notifyQueued = false;
  if (!baseline && Object.values(units).some(readyNotify._isFreshReady)) {
    notifyQueued = true;
    const nd = deps.notifyDeps || _defaultNotifyDeps();
    readyNotify.enqueue(() => readyNotify.notifyReadyUnits(units, nd))
      .catch((e) => log.warn('[canonical] ready-pickup notify error (non-fatal): ' + e.message));
  }

  log.info('[canonical] ' + counts.total + ' unit(s) — API mode, ' + (counts.changed || 0) + ' changed'
    + (baseline ? ' — QUIET BASELINE (last run ' + (prevCanon.updatedAt || 'never') + '; no carrier notices this run)' : '')
    + (!baseline && baselinedUnits ? ' — ' + baselinedUnits + ' unit(s) with an old prior record baselined quietly' : '')
    + (overlaid ? ' | saved deep-scan stage/notes on ' + overlaid + ' row(s)' : '')
    + (iso ? ' (isolated: worker ' + Math.round(iso.workerMs || 0) + ' ms, main ' + Math.round((iso.dispatchMs || 0) + (_perfNow() - tCommit)) + ' ms)' : ''));
  if (iso) return { ok: true, baseline, baselinedUnits, counts, overlaid, notifyQueued, isolated: true, workerMs: iso.workerMs };
  return { ok: true, baseline, baselinedUnits, counts, overlaid, notifyQueued };
}

function _perfNow() {
  try { return require('perf_hooks').performance.now(); } catch (_) { return Date.now(); }
}

// ── Phase 8: isolated canonical pass (design §6) ────────────────────────────
// requestCanonicalPass(opts) is the call-site entry. With isolation inactive
// (flags off, the default) or an injected store without generation(), it IS
// runCanonicalPass(opts): synchronous, identical. Otherwise it returns a
// Promise that ALWAYS resolves with an object (never rejects); the buildAll
// compute runs in the `canonical` worker and main stays the single writer.
// Every failure falls back to the legacy in-process pass exactly once.

const ROWS_LIMIT = 20000;   // clone-size guard (live fleet ≈ 253 rows)

function _iso() { return require('../workers/isolation'); }

function _whyFor(code) {
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code.toLowerCase().replace(/_/g, '-') : 'internal';
}

/**
 * _inProcess(opts, why) — the legacy pass, never throws. Counts the fallback
 * on the host (host.fallbacks[why]); WARN '[worker:canonical] running
 * in-process (<why>)' once per host state episode, `stale` at INFO every time.
 * A throw logs the legacy call-site WARN text and resolves { ok:false, reason:'error' }.
 */
function _inProcess(opts, why) {
  const log = (opts && opts.deps && opts.deps.log) || _defaultLog();
  let host = null;
  try { host = _iso().getHost('canonical'); } catch (_) { host = null; }
  try { if (host) host.noteFallback(why); } catch (_) { /* ignore */ }
  try {
    if (why === 'stale') log.info('[worker:canonical] running in-process (stale)');
    else if (!host || host.warnOnce('fallback')) log.warn('[worker:canonical] running in-process (' + why + ')');
  } catch (_) { /* ignore */ }
  try { return runCanonicalPass(opts); } catch (e) {
    try { log.warn('[canonical] API-mode pass error (non-fatal): ' + e.message); } catch (_) { /* ignore */ }
    return { ok: false, reason: 'error' };
  }
}

async function _isolatedPass(opts) {
  try {
    const host = _iso().getHost('canonical');
    if (!host || host.state !== 'ready') return _inProcess(opts, 'not-ready');
    const spec = host.spec || {};
    const telemetry = require('../telemetry');
    let prep;
    const t0 = _perfNow();
    try { prep = telemetry.track('canonical.dispatch', () => _prepare(opts, true)); } catch (_) { return _inProcess(opts, 'prepare-error'); }
    const dispatchMs = _perfNow() - t0;
    if (!prep.ok) return prep.early;
    // Clone-size guard, right after _prepare, with its own fallback key (N3).
    if (prep.rows.length > ROWS_LIMIT) return _inProcess(opts, 'rows-limit');
    const r = await host.request('canonical.buildAll', { rows: prep.rows, prior: prep.priorUnits }, { timeoutMs: spec.requestTimeoutMs });
    if (!r || r.ok !== true) return _inProcess(opts, _whyFor(r && r.code));
    const t1 = _perfNow();
    let res;
    try {
      res = telemetry.track('canonical.commit', () => _commit(prep, r.result, opts, { workerMs: r.workerMs, dispatchMs }));
    } catch (e) {
      // A commit throw (e.g. store EPERM) is not retried: the legacy pass would
      // have hit the same error. Same WARN text as the call sites log today.
      try { prep.log.warn('[canonical] API-mode pass error (non-fatal): ' + e.message); } catch (_) { /* ignore */ }
      return { ok: false, reason: 'error' };
    }
    if (res === STALE) return _inProcess(opts, 'stale');
    try { host.noteTiming({ dispatchMs, commitMs: _perfNow() - t1 }); } catch (_) { /* ignore */ }
    return res;
  } catch (_) {
    return _inProcess(opts, 'internal');
  }
}

// Lane (design §6.2): one module-level FIFO, 1 pass in flight, ≤ queueMax waiting.
const _lane = { busy: false, q: [] };

function _queueMax() {
  try { const h = _iso().getHost('canonical'); if (h && h.spec && Number.isInteger(h.spec.queueMax)) return h.spec.queueMax; } catch (_) { /* ignore */ }
  return 4;
}

function _enqueue(opts) {
  if (_lane.busy && _lane.q.length >= _queueMax()) {
    // Overflow (N3): runs in-process IMMEDIATELY, out of FIFO order, ahead of
    // the queued passes. Its saves bump the fleetData/canonicalState write
    // generations, so the in-flight isolated pass is then discarded at commit
    // as stale and re-run in-process on fresh data. Both are counted
    // (fallbacks.overflow + fallbacks.stale). Costs one extra compute; no pass
    // is lost or applied twice.
    return Promise.resolve(_inProcess(opts, 'overflow'));
  }
  return new Promise((resolve) => { _lane.q.push({ opts, resolve }); _pump(); });
}

function _pump() {
  if (_lane.busy) return;
  const e = _lane.q.shift();
  if (!e) return;
  _lane.busy = true;
  Promise.resolve()
    .then(() => _isolatedPass(e.opts))
    .catch(() => _inProcess(e.opts, 'internal'))
    .then((res) => e.resolve(res && typeof res === 'object' ? res : { ok: false, reason: 'error' }))
    .finally(() => { _lane.busy = false; _pump(); });
}

/**
 * requestCanonicalPass(opts) → result (sync, isolation inactive) | Promise<result>
 * Same opts as runCanonicalPass. While isolation is active every call is
 * tracked as telemetry 'canonical.request' (N7): the 8.1 gate's
 * passes = count(canonical.request).
 */
function requestCanonicalPass(opts = {}) {
  const iso = _iso();
  const deps = (opts && opts.deps) || {};
  const store = deps.store || require('../store');
  if (!iso.isActive('canonical') || typeof store.generation !== 'function') return runCanonicalPass(opts);
  return require('../telemetry').track('canonical.request', () => _enqueue(opts));
}

function _resetLaneForTests() { _lane.busy = false; _lane.q = []; }

module.exports = {
  runCanonicalPass, overlayDeepScanFields, GAP_MS, DS_FIELDS,
  requestCanonicalPass, _resetLaneForTests, ROWS_LIMIT,
  _prepare, _compute, _commit, STALE,
};
