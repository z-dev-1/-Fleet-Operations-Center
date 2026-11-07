'use strict';
// A worker that never sends hello and keeps itself alive with a ref'd
// setInterval: the parent's start timeout must kill it (review M2).
function start() {
  if (process.parentPort) process.parentPort.on('message', () => {});
  else process.on('message', () => {});
  setInterval(() => {}, 1000);
}

if (process.parentPort || (require.main === module && typeof process.send === 'function')) start();

module.exports = { start };
