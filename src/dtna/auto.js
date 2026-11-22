'use strict';
/**
 * src/dtna/auto.js — the sync pass's only way into DTNA.
 *
 * Callers: the deep-scan offsite pass (through src/scrapers/dtna_enrich.js) and the Pending Estimates
 * scan (src/scrapers/pending_est_sources.js), on the same triggers and freshness windows as their
 * Decisiv branches. No timer and no scheduler here.
 *
 * Session-gated: a read runs only while the user is signed in (session.canAutoSync()). Signed out or
 * expired, the pass first asks the session for one gated HIDDEN background sign-in
 * (session.backgroundLogin, rate limited there) and reads live once it succeeds; otherwise every call
 * returns the cached entry with no network. Reads are {silent:true}: never a visible sign-in window,
 * so a sync can never put an interactive or MFA prompt in front of the user.
 * Logs: op, caseTag, counts, codes and ms only.
 */
const { setTimeout: _wait } = require('timers/promises');
const C = require('./constants');
const J = require('./join');
const P = require('./pending');
const { caseTag } = require('./redact');
const { offsiteUrlOf } = require('../utils/offsite-owner');
const log = require('../utils/logger')('dtna');

// Test seam: { client, session, store, now, sleep }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _client() { return _deps.client || require('./client'); }
function _session() { return _deps.session || require('./session'); }
function _store() { return _deps.store || require('./store'); }
function _rowApply() { return _deps.rowApply || require('./row-apply'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _sleep(ms) { return typeof _deps.sleep === 'function' ? _deps.sleep(ms) : _wait(ms); }

const SIGNED_OUT = 'DTNA_AUTO_SIGNED_OUT';
// Codes that end a discovery run (same rule as client.bulkPull).
const STOP = new Set(['DTNA_SIGNIN_REQUIRED', 'DTNA_SESSION_EXPIRED', 'DTNA_NETWORK']);

function _str(v) { return v == null ? '' : String(v); }
function _ms(v) { const t = v ? Date.parse(String(v)) : NaN; return Number.isFinite(t) ? t : null; }

// A skip line only when the skip code changes, so a signed-out sync does not repeat it per case.
let _lastSkip = null;
function _noteSkip(code) {
  if (code === _lastSkip) return;
  _lastSkip = code;
  log.info('[dtna] auto', { op: 'skip', code });
}

/** gate() -> {ok:true} | {ok:false, code:'DTNA_AUTO_SIGNED_OUT'}. No network. */
function gate() {
  let ok = false;
  try { ok = _session().canAutoSync() === true; } catch (_) { ok = false; }
  return ok ? { ok: true } : { ok: false, code: SIGNED_OUT };
}

/**
 * ensureSignedIn() -> {ok:true} | {ok:false, code:'DTNA_AUTO_SIGNED_OUT'}
 * gate(), and when closed one gated hidden background sign-in (session.backgroundLogin) then gate()
 * again. A session without backgroundLogin behaves exactly like gate().
 */
let _signInP = null; // concurrent sync callers share one background sign-in
function ensureSignedIn() {
  if (gate().ok) return Promise.resolve({ ok: true });
  let S = null;
  try { S = _session(); } catch (_) { S = null; }
  if (!S || typeof S.backgroundLogin !== 'function') return Promise.resolve({ ok: false, code: SIGNED_OUT });
  if (!_signInP) {
    _signInP = Promise.resolve()
      .then(() => S.backgroundLogin({ reason: 'sync' }))
      .catch(() => null)
      .then(() => gate())
      .finally(() => { _signInP = null; });
  }
  return _signInP;
}

// At most C.CONCURRENCY live pulls at once across every caller (a released slot is handed over).
let _active = 0;
const _queue = [];
function _acquire() {
  if (_active < C.CONCURRENCY) { _active++; return Promise.resolve(); }
  return new Promise((r) => _queue.push(r));
}
function _release() {
  const next = _queue.shift();
  if (next) next(); else _active--;
}

async function _pull(caseId, opts) {
  await _acquire();
  try { return await _client().pullCase(caseId, Object.assign({}, opts, { silent: true })); } catch (_) { return { ok: false, code: 'DTNA_NETWORK' }; } finally { _release(); }
}

const _inflight = new Map(); // caseId -> pending pullIfStale result
const _discovered = new Set(); // case ids discovery already read this run

async function _livePull(caseId, cached) {
  const t0 = _now();
  const r = await _pull(caseId, {});
  const code = r && r.ok ? 'OK' : _str(r && r.code).slice(0, 40) || 'DTNA_INTERNAL';
  log.info('[dtna] auto', { op: 'pull', caseTag: caseTag(caseId), code, ms: _now() - t0 });
  if (r && r.ok && r.entry) return { ok: true, entry: r.entry, live: true };
  return { ok: false, entry: cached, live: true, code };
}

/**
 * pullIfStale(caseId, {freshMs, force}) -> { ok, entry, live, code? }
 * A cached entry younger than freshMs is returned with no call (the caller's throttle). Signed out ->
 * the cached entry and DTNA_AUTO_SIGNED_OUT, no network. Else one silent pull; a failed pull returns
 * the cached entry with the failure code.
 */
async function pullIfStale(caseId, opts) {
  const o = opts || {};
  if (!C.CASE_ID_RE.test(_str(caseId))) return { ok: false, entry: null, live: false, code: 'DTNA_INVALID_INPUT' };
  let entry = null;
  try { entry = _store().get(caseId); } catch (_) { entry = null; }
  const fresh = Number(o.freshMs);
  const at = entry ? _ms(entry.pulledAt) : null;
  if (!o.force && entry && Number.isFinite(fresh) && fresh > 0 && at != null) {
    const age = _now() - at;
    if (age >= 0 && age < fresh) return { ok: true, entry, live: false };
  }
  const g = await ensureSignedIn();
  if (!g.ok) { _noteSkip(g.code); return { ok: !!entry, entry, live: false, code: g.code }; }
  _lastSkip = null;
  if (_inflight.has(caseId)) return _inflight.get(caseId);
  const p = _livePull(caseId, entry).finally(() => _inflight.delete(caseId));
  _inflight.set(caseId, p);
  return p;
}

/**
 * discover({units, budget}) -> { pulled, code }
 * Signed in only. Lists the portal's cases (client.listCaseIds, memoized 30 min) and reads the
 * uncached ones case-only, at most `budget`, in batches of CONCURRENCY with BATCH_GAP_MS between.
 * Stops once every requested unit has a cached case, or on a sign-in / network code.
 */
async function discover(opts) {
  const o = opts || {};
  const budget = Math.max(0, Math.floor(Number(o.budget) || 0));
  const g = await ensureSignedIn();
  if (!g.ok) { _noteSkip(g.code); return { pulled: 0, code: g.code }; }
  if (!budget) return { pulled: 0, code: 'OK' };
  const want = new Set((Array.isArray(o.units) ? o.units : []).map(J.normUnit).filter(Boolean));
  const t0 = _now();
  let lr;
  try { lr = await _client().listCaseIds({ silent: true }); } catch (_) { lr = { ok: false, code: 'DTNA_NETWORK' }; }
  if (!lr || !lr.ok) {
    const code = _str(lr && lr.code).slice(0, 40) || 'DTNA_INTERNAL';
    log.info('[dtna] auto', { op: 'discover', listed: 0, pulled: 0, code, ms: _now() - t0 });
    return { pulled: 0, code };
  }
  let have = new Set();
  try { have = new Set(_store().all().map((e) => e && e.caseId)); } catch (_) { have = new Set(); }
  // Each listed case is read by discovery at most once per run (a large list never churns the cache).
  const todo = lr.ids.filter((id) => !have.has(id) && !_discovered.has(id)).slice(0, budget);
  let pulled = 0;
  let code = 'OK';
  for (let i = 0; i < todo.length; i += C.CONCURRENCY) {
    if (i > 0) await _sleep(C.BATCH_GAP_MS);
    if (!(await ensureSignedIn()).ok) { code = SIGNED_OUT; break; }
    let stop = null;
    await Promise.all(todo.slice(i, i + C.CONCURRENCY).map(async (id) => {
      const r = await _pull(id, { includeComments: false });
      if (!(r && STOP.has(r.code))) _discovered.add(id);
      if (r && r.ok) {
        pulled++;
        if (r.entry) want.delete(J.normUnit(r.entry.unitId));
      } else if (r && STOP.has(r.code)) stop = r.code;
    }));
    if (stop) { code = stop; break; }
    if (Array.isArray(o.units) && o.units.length && !want.size) break;
  }
  log.info('[dtna] auto', { op: 'discover', listed: lr.ids.length, pulled, code, ms: _now() - t0 });
  return { pulled, code };
}

/**
 * applyCachedCase(row, {extract}) -> { applied, reason }. Cache only, no network.
 * A FREIGHTLINER / DAIMLER row with no offsite link gets its unit's open cached case (unit-number
 * join, src/dtna/join.js) written through row-apply (OFFSITE_FIELDS + _offsiteWrId).
 */
function applyCachedCase(row, opts) {
  const o = opts || {};
  if (!row || typeof row !== 'object') return { applied: false, reason: 'no-row' };
  if (offsiteUrlOf(row)) return { applied: false, reason: 'has-offsite' };
  if (!P.DTNA_VENDOR_RE.test(_str(row.vendor))) return { applied: false, reason: 'not-dtna-vendor' };
  let entries = [];
  try { entries = _store().all(); } catch (_) { entries = []; }
  const entry = J.findCaseForRow(row, entries);
  if (!entry) return { applied: false, reason: 'no-case' };
  if (P.isCaseClosed(entry)) return { applied: false, reason: 'closed' };
  const pick = J.pickWrForCase(entry, [row]);
  if (!pick) return { applied: false, reason: 'no-wr' };
  return _rowApply().applyCaseToRow(row, entry, { wrId: pick.wrId, extract: !!o.extract });
}

function _resetForTests() {
  _deps = {}; _lastSkip = null; _active = 0; _queue.length = 0; _inflight.clear(); _discovered.clear(); _signInP = null;
}

module.exports = { gate, ensureSignedIn, pullIfStale, discover, applyCachedCase, _setDeps, _resetForTests };
