'use strict';
// tests/smoke/worker-hog-worker.cjs — protocol-speaking worker (group 'hog') whose op
// allocates off-heap memory until the host's RSS cap kills it (design §11.4 step 4).
// Same "start only as the real entry" guard as the canonical worker (review M1).
const path = require('path');

const OPS = {
  hog: async () => {
    const keep = [];
    for (;;) {
      keep.push(Buffer.alloc(16 * 1024 * 1024, 1));   // committed pages → working set grows
      await new Promise((r) => setTimeout(r, 20));
    }
  },
};

function start() {
  return require(path.join(__dirname, '..', '..', 'src', 'workers', 'isolation', 'worker-runtime.js')).startWorker({ group: 'hog', ops: OPS });
}

if (process.parentPort || (require.main === module && typeof process.send === 'function')) start();

module.exports = { OPS, start };
