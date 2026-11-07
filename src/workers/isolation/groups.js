'use strict';
/**
 * workers/isolation/groups.js — frozen worker-group specs (design §5.2).
 *
 * Phase 1 has exactly one group, `canonical` (canonical_state.buildAll in a
 * utilityProcess). Limits are code constants, not settings. Main-process only:
 * the validator lazily requires orcha/canonical_state (already loaded in main).
 */

const path = require('path');

function _plain(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
const _nonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * validateCanonicalResult(op, result, payload) → { ok:true, value:{units,counts} } | { ok:false, rule }
 *
 * Main's trust boundary before any store write (design §5.6). On failure it
 * returns the FIRST failing rule name (one of: 'op', 'payload', 'result-shape',
 * 'units-shape', 'units-count', 'foreign-key', 'value-shape', 'value-id',
 * 'status', 'counts-shape', 'counts-total'); the host resolves the request
 * INVALID_RESULT (no kill, no crash count). Ids are normalized exactly as
 * buildAll keys units (canonical._normId === canonical_state._s).
 */
function validateCanonicalResult(op, result, payload) {
  if (op !== 'canonical.buildAll') return { ok: false, rule: 'op' };
  const rows = payload && Array.isArray(payload.rows) ? payload.rows : null;
  if (!rows) return { ok: false, rule: 'payload' };
  if (!_plain(result)) return { ok: false, rule: 'result-shape' };
  const units = result.units;
  if (!_plain(units)) return { ok: false, rule: 'units-shape' };
  const keys = Object.keys(units);
  if (keys.length > rows.length) return { ok: false, rule: 'units-count' };
  const canonical = require('../../orcha/canonical_state');
  const ids = new Set(rows.map((r) => canonical._normId(r && r.equipmentId)).filter(Boolean));
  for (const k of keys) {
    if (!ids.has(k)) return { ok: false, rule: 'foreign-key' };
    const v = units[k];
    if (!_plain(v)) return { ok: false, rule: 'value-shape' };
    if (v.equipmentId !== k) return { ok: false, rule: 'value-id' };
    if (!canonical.isValidStatus(v.status)) return { ok: false, rule: 'status' };
  }
  const c = result.counts;
  if (!_plain(c) || !_nonNegInt(c.total) || !_nonNegInt(c.reconciled) || !_nonNegInt(c.baseline) || !_nonNegInt(c.changed)) {
    return { ok: false, rule: 'counts-shape' };
  }
  if (c.total !== keys.length) return { ok: false, rule: 'counts-total' };
  return { ok: true, value: { units, counts: c } };
}

/**
 * assertSpec(spec) — throws for a spec whose AI budget is > 0 but whose
 * timeout / concurrency / prompt limits are unusable (design §5.4).
 */
function assertSpec(spec) {
  const ai = (spec && spec.ai) || {};
  if (ai.maxPerRequest > 0) {
    if (!(ai.maxTimeoutMs >= 1000)) throw new Error('worker group ' + (spec && spec.group) + ': ai.maxTimeoutMs must be >= 1000');
    if (!(ai.maxConcurrent >= 1)) throw new Error('worker group ' + (spec && spec.group) + ': ai.maxConcurrent must be >= 1');
    if (!(ai.maxPromptChars >= 1)) throw new Error('worker group ' + (spec && spec.group) + ': ai.maxPromptChars must be >= 1');
  }
  return spec;
}

const canonical = Object.freeze({
  group: 'canonical',
  name: 'isoCanonical',                 // supervisor row name (NAME_RE-valid, no collision with WORKER_NAMES)
  label: 'Canonical pass (isolated)',
  file: path.join(__dirname, 'entries', 'canonical-worker.js'),
  serviceName: 'fleet-worker-canonical',
  ops: Object.freeze(['canonical.buildAll']),
  heapMb: 384,                          // --max-old-space-size
  rssCapMb: 512,                        // working-set kill threshold
  startTimeoutMs: 10000,
  requestTimeoutMs: 30000,              // ~28× the observed max of 1074 ms incl. store I/O
  cancelGraceMs: 2000,
  maxConcurrency: 1,                    // in flight per host
  queueMax: 4,                          // lane queue in canonical_runner; overflow → in-process
  pingIntervalMs: 10000,
  pingMissLimit: 3,                     // 30 s without pong → hung → kill
  workerSilenceExitMs: 45000,           // worker self-exit; > worst main stall 13.9 s
  ppidPollMs: 2000,
  rssPollBusyMs: 5000,
  rssPollIdleMs: 30000,
  backoffMs: Object.freeze([5000, 30000, 120000, 300000]),   // ±15 % jitter
  crashWindowMs: 600000,
  maxCrashes: 3,                        // 3 crashes in 10 min → isolated
  cooldownMs: 1800000,                  // 30 min, same default as the supervisor
  maxRestarts: 3,                       // isolations recovered before 'disabled'
  maxLogPerMin: 50,
  ai: Object.freeze({ maxPerRequest: 0, maxConcurrent: 0, maxPriority: 'low', isolatedOnly: true, maxTimeoutMs: 0, maxPromptChars: 0 }),
  validateResult: validateCanonicalResult,
});

const GROUPS = { canonical };
for (const g of Object.keys(GROUPS)) assertSpec(GROUPS[g]);

module.exports = { canonical, GROUPS, assertSpec, validateCanonicalResult };
