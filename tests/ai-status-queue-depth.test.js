// tests/ai-status-queue-depth.test.js — src/ai/status.js reads queue depth
// from relay.queueStats() (getStatus() never carried queue fields, so the board
// always showed "-").
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const status = require('../src/ai/status');

describe('ai/status queue depth', () => {
  it('_queueFromRelay maps relay.queueStats()', () => {
    const fake = { queueStats: () => ({ active: 2, waiting: 3, max: 5 }), getStatus: () => ({}) };
    expect(status._queueFromRelay(fake)).toEqual({ activeRequests: 2, queueDepth: 3, maxConcurrent: 5 });
  });
  it('falls back to the legacy getStatus() fields', () => {
    const fake = { getStatus: () => ({ activeCount: 1, queueLength: 4 }) };
    expect(status._queueFromRelay(fake)).toEqual({ activeRequests: 1, queueDepth: 4, maxConcurrent: null });
  });
  it('null / throwing relays degrade to nulls without throwing', () => {
    const nulls = { activeRequests: null, queueDepth: null, maxConcurrent: null };
    expect(status._queueFromRelay(null)).toEqual(nulls);
    expect(status._queueFromRelay({ queueStats: () => { throw new Error('x'); }, getStatus: () => { throw new Error('y'); } })).toEqual(nulls);
    expect(status._queueFromRelay({})).toEqual(nulls);
  });
  it('snapshot() throughput + board Queue use relay.queueStats()', () => {
    const relay = require('../src/orcha/relay');
    const orig = relay.queueStats;
    relay.queueStats = () => ({ active: 1, waiting: 3, max: 5 });
    try {
      const s = status.snapshot();
      expect(s.throughput.queueDepth).toBe(3);
      expect(s.throughput.activeRequests).toBe(1);
      expect(s.throughput.maxConcurrent).toBe(5);
      expect(s.board.Queue).toBe(3);
    } finally {
      relay.queueStats = orig;
    }
  });
});
