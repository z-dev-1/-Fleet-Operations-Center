'use strict';
/**
 * telemetry/ring-buffer.js — fixed-capacity FIFO. Pushing past capacity
 * evicts the oldest entry, so memory stays bounded no matter how long the app
 * runs.
 */

function createRingBuffer(cap) {
  if (!Number.isInteger(cap) || cap < 1) throw new Error('ring buffer capacity must be an integer >= 1');
  let buf = new Array(cap);
  let start = 0;   // index of the oldest entry
  let count = 0;
  let dropped = 0;

  function push(x) {
    if (count < cap) {
      buf[(start + count) % cap] = x;
      count++;
    } else {
      buf[start] = x;
      start = (start + 1) % cap;
      dropped++;
    }
  }

  function toArray() {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = buf[(start + i) % cap];
    return out;
  }

  function last(n) {
    const k = Math.max(0, Math.min(count, Math.floor(Number(n) || 0)));
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = buf[(start + count - k + i) % cap];
    return out;
  }

  function clear() { buf = new Array(cap); start = 0; count = 0; dropped = 0; }

  return {
    push,
    toArray,
    last,
    size: () => count,
    capacity: cap,
    dropped: () => dropped,
    clear,
  };
}

module.exports = { createRingBuffer };
