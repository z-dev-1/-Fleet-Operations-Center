'use strict';
// tests/smoke/heap-hog-worker.cjs — SMOKE ONLY. Allocates JS arrays (V8 heap, not
// ArrayBuffers) in a loop so the smoke can check whether a utilityProcess forked with
// --max-old-space-size=512 dies of a heap OOM before its working set reaches the 1 GB
// RSS cap (round-3 fix 12). It never replies.
const keep = [];
function grow() {
  for (let i = 0; i < 20; i++) keep.push(new Array(250000).fill(Math.random()));   // ~2 MB of doubles each
  setImmediate(grow);
}
grow();
