'use strict';
/**
 * email-intel/reliability/job.js — durable job wrapper for one mailbox scan (design 8.3, 8.4; NFR-12).
 *
 *   begin() -> { skipped:'busy-other-run' } | ScanJob
 *   ScanJob: { durable, resumed, degraded, blockedBy, checkpoint(obj), finish(outcome, summary), fail(code) }
 *
 * jobs.begin({ type:'emailTriage', scopeKey:'mailbox' }) returns the NOOP handle (no SQL) unless the jobs
 * master flag, `jobs.emailTriage.durable` and the jobs layer are all active, so with the job flag OFF the
 * scan is purely in-process (the single-flight lock still applies). A busy handle means another live run
 * owns the open mailbox scope (another process): the scan is skipped. A blocked or degraded handle runs
 * non-durably, as the other adopters do.
 *
 * The job checkpoint only mirrors progress (small, under 16 KB); the authoritative checkpoints remain in
 * emailIntelCheckpoints. Nothing passed to the jobs layer carries message content: ids, counts and enums.
 */
const flags = require('../flags');
const { safeErr } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const TYPE = 'emailTriage';
const SCOPE = 'mailbox';
const CKPT_MAX_CHARS = 16 * 1024 - 64;                  // stay under the jobs layer's 16 KB checkpoint cap
const FAIL_OUTCOMES = new Set(['failed', 'auth-blocked', 'aborted']);
const CODE_RE = /^[a-z0-9-]{1,40}$/i;

let _jobsOverride = null;
function _jobs() { return _jobsOverride || require('../../jobs'); }

function _engaged() { try { return flags.engaged(); } catch (_) { return false; } }

function _wrap(h) {
  let done = false;
  const call = (fn) => { try { fn(); } catch (e) { logger.warn('[email-intel] job handle call failed ' + safeErr(e)); } };
  return {
    get durable() { return !!(h && h.durable); },
    resumed: !!(h && h.resumed),
    degraded: !!(h && h.degraded),
    blockedBy: (h && h.blockedBy) || null,
    /** Mirror progress: small plain objects only (ids, counts); dropped when too large. */
    checkpoint(obj) {
      if (done || !h || !obj || typeof obj !== 'object') return false;
      let json;
      try { json = JSON.stringify(obj); } catch (_) { return false; }
      if (!json || json.length > CKPT_MAX_CHARS) return false;
      call(() => h.setCheckpoint(obj));
      return true;
    },
    /** finish(outcome, summary): complete for complete / partial / skipped; fail for failed / auth-blocked / aborted. */
    finish(outcome, summary) {
      if (done || !h) return;
      done = true;
      const o = String(outcome || '');
      if (FAIL_OUTCOMES.has(o)) { call(() => h.fail(new Error(o))); return; }
      call(() => h.complete(Object.assign({ outcome: o }, summary && typeof summary === 'object' ? summary : {})));
    },
    /** fail(code): an enum code only (never an error message, which could echo content). */
    fail(code) {
      if (done || !h) return;
      done = true;
      const c = CODE_RE.test(String(code || '')) ? String(code) : 'exception';
      call(() => h.fail(new Error(c)));
    },
    get finished() { return done; },
  };
}

/** begin() -> { skipped:'busy-other-run' } | ScanJob (a NOOP-backed job when the jobs layer is off). */
function begin() {
  if (!_engaged()) return _wrap(null);
  let h = null;
  try { h = _jobs().begin({ type: TYPE, scopeKey: SCOPE }); } catch (e) { logger.warn('[email-intel] job begin failed ' + safeErr(e)); h = null; }
  if (h && h.busy) {
    logger.info('[email-intel] scan skipped: another run owns the mailbox job');
    return { skipped: 'busy-other-run' };
  }
  if (h && h.durable) { try { h.start(); } catch (e) { logger.warn('[email-intel] job start failed ' + safeErr(e)); } }
  return _wrap(h);
}

/** Read-only job view for the status document: { mode, effective, open:{state,attempt}|null } or null. */
function statusEntry() {
  try {
    const j = _jobs();
    const st = typeof j.getStatus === 'function' ? j.getStatus() : null;
    const effective = typeof j.isEffective === 'function' ? j.isEffective(TYPE) === true : false;
    let open = null;
    if (effective && typeof j.peek === 'function') {
      const row = j.peek({ type: TYPE, scopeKey: SCOPE });
      if (row) open = { state: row.state || null, attempt: Number(row.attempt) || 0 };
    }
    return { type: TYPE, mode: (st && st.mode) || 'off', effective, open };
  } catch (_) { return null; }
}

function _setJobsForTests(j) { _jobsOverride = j || null; }

module.exports = { TYPE, SCOPE, begin, statusEntry, _setJobsForTests };
