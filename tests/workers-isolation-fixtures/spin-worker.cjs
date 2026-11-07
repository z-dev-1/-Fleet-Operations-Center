'use strict';
// Synthetic CPU worker on the real worker-runtime (group 'spin'), used by the
// runtime tests, the real-fork tests and the lag benchmark. Same "start only as
// the real entry" guard as the canonical worker (review M1).
const path = require('path');

/** spinSync(ms) — busy-loop the current thread for ms milliseconds. */
function spinSync(ms) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x++;
  return x;
}

const OPS = {
  spin: async (p, ctx) => {
    if (!p || !Number.isFinite(p.ms) || !Number.isInteger(p.n)) throw new Error('bad spin payload');
    for (let i = 0; i < p.n; i++) {
      spinSync(p.ms);
      ctx.progress(((i + 1) / p.n) * 100);
    }
    return { slices: p.n };
  },
  echo: (p) => p,
  log: (p, ctx) => { ctx.log('info', String(p)); return true; },
  hold: (p) => new Promise((resolve) => setTimeout(() => resolve('held'), (p && p.ms) || 0)),
  order: (p) => new Promise((resolve) => setTimeout(() => resolve({ tag: p.tag, at: Date.now() }), (p && p.ms) || 0)),
};

function start() {
  const r = require(path.join(__dirname, '..', '..', 'src', 'workers', 'isolation', 'worker-runtime.js')).startWorker({ group: 'spin', ops: OPS });
  // Test-only: announce that the runtime (and its pre-init watchdog) is armed, so a
  // timing test can measure from here rather than from process creation.
  if (process.env.SPIN_ANNOUNCE === '1' && typeof process.send === 'function') process.send({ t: 'booted' });
  return r;
}

if (process.parentPort || (require.main === module && typeof process.send === 'function')) start();

module.exports = { OPS, spinSync, start };
