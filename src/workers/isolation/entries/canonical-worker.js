'use strict';
/**
 * workers/isolation/entries/canonical-worker.js — the `canonical` group worker.
 *
 * Op 'canonical.buildAll' → orcha/canonical_state.buildAll(rows, { decisions:{},
 * prior }) → { units, counts }. `mirrored` is not returned: main recomputes the
 * mirrors with mirrorFields at commit, as the in-process pass does.
 *
 * Inert under require (review M1): the runtime starts ONLY when this file is
 * the real utilityProcess / child_process.fork entry (same guard as
 * src/justme-context/extract-worker.js), so vitest's forks pool and the
 * in-process parity test can require it and call OPS directly.
 */

const OPS = {
  'canonical.buildAll': (p) => {
    const payload = p || {};
    const { units, counts } = require('../../../orcha/canonical_state').buildAll(payload.rows, { decisions: {}, prior: payload.prior || {} });
    return { units, counts };
  },
};

function start() {
  return require('../worker-runtime').startWorker({ group: 'canonical', ops: OPS });
}

if (process.parentPort || (require.main === module && typeof process.send === 'function')) start();

module.exports = { OPS, start };
