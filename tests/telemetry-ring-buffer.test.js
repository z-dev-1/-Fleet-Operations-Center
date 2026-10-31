// tests/telemetry-ring-buffer.test.js — bounded FIFO used by src/telemetry.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createRingBuffer } = require('../src/telemetry/ring-buffer');

describe('ring buffer', () => {
  it('respects capacity after 3x cap pushes and keeps the newest (rollover)', () => {
    const rb = createRingBuffer(5);
    for (let i = 0; i < 15; i++) rb.push(i);
    expect(rb.size()).toBe(5);
    expect(rb.capacity).toBe(5);
    expect(rb.toArray()).toEqual([10, 11, 12, 13, 14]);
    expect(rb.dropped()).toBe(10);
  });
  it('orders oldest -> newest before it is full', () => {
    const rb = createRingBuffer(4);
    rb.push('a'); rb.push('b'); rb.push('c');
    expect(rb.toArray()).toEqual(['a', 'b', 'c']);
    expect(rb.dropped()).toBe(0);
  });
  it('last(n) returns the newest n in order, clamped', () => {
    const rb = createRingBuffer(3);
    for (let i = 1; i <= 7; i++) rb.push(i);
    expect(rb.last(2)).toEqual([6, 7]);
    expect(rb.last(10)).toEqual([5, 6, 7]);
    expect(rb.last(0)).toEqual([]);
  });
  it('clear() empties and resets counters', () => {
    const rb = createRingBuffer(2);
    rb.push(1); rb.push(2); rb.push(3);
    rb.clear();
    expect(rb.size()).toBe(0);
    expect(rb.toArray()).toEqual([]);
    expect(rb.dropped()).toBe(0);
  });
  it('bad capacity throws', () => {
    expect(() => createRingBuffer(0)).toThrow();
    expect(() => createRingBuffer(-1)).toThrow();
    expect(() => createRingBuffer(1.5)).toThrow();
    expect(() => createRingBuffer('3')).toThrow();
  });
});
