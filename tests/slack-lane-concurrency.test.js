// tests/slack-lane-concurrency.test.js
//
// Phase 4b T4: the bounded, tier-paced lane (src/slack/web-api-lane.js), used
// only when laneConcurrency > 1 or laneTierPacing is on. Fake timers + a
// scripted fake request; no network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createLane, TIER_PER_MIN } = require('../src/slack/web-api-lane');

let log, inFlight, maxInFlight, script, logs, delays;
function mkLane(o = {}) {
  log = []; inFlight = 0; maxInFlight = 0; logs = []; delays = 0;
  const latency = o.latency == null ? 100 : o.latency;
  const request = (method, params) => {
    const rec = { method, id: params && params.id, start: Date.now(), end: null };
    log.push(rec);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const s = (script && script(method, params, rec)) || {};
    const ms = s.ms == null ? latency : s.ms;
    return new Promise((resolve, reject) => {
      setTimeout(() => { inFlight--; rec.end = Date.now(); if (s.reject) reject(s.reject); else resolve(s.res || { ok: true, id: params && params.id }); }, ms);
    });
  };
  return createLane({ concurrency: o.K || 1, pacing: o.pacing, request, random: () => 0,
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    hooks: { onBudgetDelay: () => { delays++; } } });
}
async function settle(promises, stepMs = 50, max = 200000) {
  let done = false, val, err;
  Promise.all(promises).then(v => { done = true; val = v; }, e => { done = true; err = e; });
  for (let i = 0; !done && i < max; i++) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error('did not settle');
  if (err) throw err;
  return val;
}
const starts = (m) => log.filter(r => !m || r.method === m).map(r => r.start);
function expectWithinBudget(method, budget) {
  const s = starts(method).sort((a, b) => a - b);
  for (let i = 0; i + budget < s.length; i++) expect(s[i + budget] - s[i]).toBeGreaterThanOrEqual(60000);
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); script = null; });
afterEach(() => { vi.useRealTimers(); });

describe('concurrency bound, ordering and spacing', () => {
  for (const K of [2, 3, 4]) {
    it(`K = ${K}: max in-flight equals K and never more`, async () => {
      const lane = mkLane({ K, latency: 2000 });
      const ps = Array.from({ length: 20 }, (_, i) => lane.enqueue('conversations.history', { id: i }));
      const res = await settle(ps);
      expect(maxInFlight).toBe(K);
      expect(res.map(r => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(log.map(r => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => i)); // start order = enqueue order
      for (let i = 1; i < log.length; i++) expect(log[i].start - log[i - 1].start).toBeGreaterThanOrEqual(350);
      expect(lane._state()).toMatchObject({ inFlight: 0, queued: 0, retries: 0, hasTimer: false, pacing: true });
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  it('K > 1 forces pacing on even when pacing is false', () => {
    expect(mkLane({ K: 2, pacing: false }).pacing).toBe(true);
    expect(mkLane({ K: 1, pacing: false }).pacing).toBe(false);
  });
});

describe('writes are exclusive barriers', () => {
  it('a write waits for in-flight reads, runs alone, and later reads wait for it', async () => {
    const lane = mkLane({ K: 3, latency: 1000 });
    const ps = [lane.enqueue('conversations.history', { id: 'r1' }), lane.enqueue('users.info', { id: 'r2' }),
      lane.enqueue('chat.postMessage', { id: 'w' }), lane.enqueue('conversations.history', { id: 'r3' })];
    await settle(ps);
    const by = Object.fromEntries(log.map(r => [r.id, r]));
    expect(log.map(r => r.id)).toEqual(['r1', 'r2', 'w', 'r3']);
    expect(by.w.start).toBeGreaterThanOrEqual(Math.max(by.r1.end, by.r2.end));
    expect(by.r3.start).toBeGreaterThanOrEqual(by.w.end);
  });
  it('an unknown method is treated as a write', async () => {
    const lane = mkLane({ K: 3, latency: 1000 });
    const ps = [lane.enqueue('conversations.history', { id: 'r1' }), lane.enqueue('some.newMethod', { id: 'u' }), lane.enqueue('users.info', { id: 'r2' })];
    await settle(ps);
    const by = Object.fromEntries(log.map(r => [r.id, r]));
    expect(by.u.start).toBeGreaterThanOrEqual(by.r1.end);
    expect(by.r2.start).toBeGreaterThanOrEqual(by.u.end);
  });
});

describe('429 / Retry-After', () => {
  it('a 429 pauses ALL new starts; in-flight calls complete; the retry starts first after the pause', async () => {
    let n = 0;
    script = (m, p) => (p.id === 'a' && n++ === 0 ? { res: { __rateLimited: true, retryAfter: 2 }, ms: 1000 } : { ms: 1500 });
    const lane = mkLane({ K: 3 });
    const ps = ['a', 'b', 'c', 'd', 'e'].map(id => lane.enqueue('conversations.history', { id }));
    await settle(ps);
    const a1 = log[0], b = log.find(r => r.id === 'b'), c = log.find(r => r.id === 'c');
    const pausedUntil = a1.end + 2250;
    expect(b.start).toBeLessThan(a1.end);              // b and c were already in flight when the 429 arrived
    expect(c.start).toBeLessThan(a1.end);
    expect(b.end).toBeLessThan(pausedUntil);           // and completed during the pause
    expect(c.end).toBeLessThan(pausedUntil);
    const after = log.filter(r => r.start > c.start);
    expect(after.map(r => r.id)).toEqual(['a', 'd', 'e']); // retried call starts first
    expect(after[0].start).toBe(pausedUntil);
    for (const r of after) expect(r.start).toBeGreaterThanOrEqual(pausedUntil);
    expect(logs.some(([l, m]) => l === 'info' && /conversations\.history 429 — backing off 2250ms \(attempt 1\)/.test(m))).toBe(true);
  });
  it('two concurrent 429s pause for the longer of the two', async () => {
    const seen = new Set();
    script = (m, p) => {
      if (seen.has(p.id)) return { ms: 10 };
      seen.add(p.id);
      if (p.id === 'a') return { res: { __rateLimited: true, retryAfter: 1 }, ms: 400 };
      if (p.id === 'b') return { res: { __rateLimited: true, retryAfter: 3 }, ms: 10 };
      return { ms: 10 };
    };
    const lane = mkLane({ K: 2 });
    await settle(['a', 'b', 'c'].map(id => lane.enqueue('conversations.history', { id })));
    const firstB = log.find(r => r.id === 'b');
    const retries = log.filter(r => r.start > firstB.start);
    expect(Math.min(...retries.map(r => r.start))).toBe(firstB.end + 3250);
  });
  it('gives up after 5 attempts in today\'s shape', async () => {
    script = () => ({ res: { __rateLimited: true, retryAfter: null }, ms: 0 });
    const lane = mkLane({ K: 2 });
    const [r] = await settle([lane.enqueue('conversations.replies', { id: 'x' })]);
    expect(r).toEqual({ ok: false, error: 'ratelimited' });
    expect(log.length).toBe(5);
    expect(logs.some(([l, m]) => l === 'warn' && /conversations\.replies rate-limited after 5 attempts — giving up/.test(m))).toBe(true);
  });
});

describe('failures and cleanup', () => {
  it('a network reject releases its slot and the queue continues; no timers remain', async () => {
    script = (m, p) => (p.id === 0 ? { reject: new Error('net'), ms: 100 } : { ms: 100 });
    const lane = mkLane({ K: 2 });
    const ps = [0, 1, 2, 3].map(id => lane.enqueue('conversations.history', { id }).then(r => r.id, e => e.message));
    expect(await settle(ps)).toEqual(['net', 1, 2, 3]);
    expect(lane._state()).toMatchObject({ inFlight: 0, queued: 0, hasTimer: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('per-method tier budgets', () => {
  it('K = 4, 60 conversations.replies: ≤ 50 per 60 s window; the 51st starts exactly when the 1st leaves', async () => {
    const lane = mkLane({ K: 4, latency: 10 });
    await settle(Array.from({ length: 60 }, (_, i) => lane.enqueue('conversations.replies', { id: i })));
    expectWithinBudget('conversations.replies', 50);
    const s = starts('conversations.replies');
    expect(s[50] - s[0]).toBe(60000);
    expect(delays).toBeGreaterThan(0);
  });
  it('an exhausted method does not block other methods\' reads', async () => {
    const lane = mkLane({ K: 4, latency: 10 });
    const ps = Array.from({ length: 52 }, (_, i) => lane.enqueue('conversations.replies', { id: 'r' + i }));
    ps.push(lane.enqueue('users.info', { id: 'u' }), lane.enqueue('conversations.history', { id: 'h' }));
    await settle(ps);
    const r50 = log.find(r => r.id === 'r50');
    expect(log.find(r => r.id === 'u').start).toBeLessThan(r50.start);
    expect(log.find(r => r.id === 'h').start).toBeLessThan(r50.start);
    expect(log.find(r => r.id === 'u').start - log.find(r => r.id === 'r49').start).toBeLessThan(1000);
  });
  it('head-of-line: a write waits behind a budget-blocked read; reads after the write wait for it', async () => {
    const lane = mkLane({ K: 2, latency: 10 });
    const ps = Array.from({ length: 50 }, (_, i) => lane.enqueue('conversations.replies', { id: 'r' + i }));
    ps.push(lane.enqueue('conversations.replies', { id: 'blocked' }), lane.enqueue('chat.postMessage', { id: 'w' }), lane.enqueue('users.info', { id: 'u' }));
    await settle(ps);
    const by = Object.fromEntries(log.map(r => [r.id, r]));
    expect(by.blocked.start).toBe(by.r0.start + 60000);
    expect(by.w.start).toBeGreaterThanOrEqual(by.blocked.end);   // never overtakes the earlier read
    expect(by.u.start).toBeGreaterThanOrEqual(by.w.end);         // nothing enqueued after the write starts first
  });
  it('K = 1 with pacing on is serialized and budgeted', async () => {
    const lane = mkLane({ K: 1, pacing: true, latency: 10 });
    await settle(Array.from({ length: 55 }, (_, i) => lane.enqueue('conversations.history', { id: i })));
    expect(maxInFlight).toBe(1);
    expectWithinBudget('conversations.history', 50);
    const s = starts();
    expect(s[50] - s[0]).toBe(60000);
  });
  it('Tier 2: conversations.list ≤ 20 per window (21st at +60 s); users.lookupByEmail ≤ 50', async () => {
    expect(TIER_PER_MIN['conversations.list']).toBe(20);
    let lane = mkLane({ K: 2, latency: 10 });
    await settle(Array.from({ length: 25 }, (_, i) => lane.enqueue('conversations.list', { id: i })));
    expectWithinBudget('conversations.list', 20);
    const s = starts('conversations.list');
    expect(s[20] - s[0]).toBe(60000);
    lane = mkLane({ K: 2, latency: 10 });
    await settle(Array.from({ length: 52 }, (_, i) => lane.enqueue('users.lookupByEmail', { id: i })));
    expectWithinBudget('users.lookupByEmail', 50);
  });
  it('retry vs budget: a 429\'d attempt counts as a start; the retry waits for budget, other methods do not', async () => {
    let first = true;
    script = (m, p) => {
      if (p.id === 'r49' && first) { first = false; return { res: { __rateLimited: true, retryAfter: 1 }, ms: 10 }; }
      return { ms: 10 };
    };
    const lane = mkLane({ K: 2, latency: 10 });
    const ps = Array.from({ length: 50 }, (_, i) => lane.enqueue('conversations.replies', { id: 'r' + i }));
    ps.push(lane.enqueue('users.info', { id: 'u' }));
    await settle(ps);
    const r49 = log.filter(r => r.id === 'r49');
    expect(r49.length).toBe(2);
    const pausedUntil = r49[0].end + 1250;
    const u = log.find(r => r.id === 'u');
    expect(u.start).toBe(pausedUntil);                                   // other method starts right after the pause
    expect(r49[1].start).toBe(log.find(r => r.id === 'r0').start + 60000); // retry waits for the budget release
    expectWithinBudget('conversations.replies', 50);                     // retries included
  });
  it('retry FIFO goes first only among eligible requests: a budget-blocked retry is passed by an eligible retry and the queue', async () => {
    // retryQ = [x (conversations.replies, out of budget), y (conversations.history, eligible)], queue = [h1, h2].
    const seen = new Set();
    script = (m, p) => {
      if (seen.has(p.id)) return { ms: 10 };
      seen.add(p.id);
      if (p.id === 'y') return { res: { __rateLimited: true, retryAfter: 1 }, ms: 400 };  // settles after x
      if (p.id === 'x') return { res: { __rateLimited: true, retryAfter: 1 }, ms: 10 };
      return { ms: 10 };
    };
    const lane = mkLane({ K: 2, latency: 10 });
    const ps = Array.from({ length: 49 }, (_, i) => lane.enqueue('conversations.replies', { id: 'r' + i }));
    ps.push(lane.enqueue('conversations.history', { id: 'y' }), lane.enqueue('conversations.replies', { id: 'x' }),
      lane.enqueue('conversations.history', { id: 'h1' }), lane.enqueue('conversations.history', { id: 'h2' }));
    await settle(ps);
    const att = (id) => log.filter(r => r.id === id);
    const [y1, y2] = att('y'), [x1, x2] = att('x'), h1 = att('h1')[0], h2 = att('h2')[0];
    expect(x1.end).toBeLessThan(y1.end);                                  // x entered the retry FIFO first
    const pausedUntil = Math.max(x1.end, y1.end) + 1250;
    // nothing starts during the pause; x's 429'd attempt filled its 50-start window
    expect(Math.min(y2.start, x2.start, h1.start, h2.start)).toBeGreaterThanOrEqual(pausedUntil);
    expect(y2.start).toBe(pausedUntil);                                   // eligible retry first, ahead of the queue
    expect(h1.start).toBeGreaterThan(y2.start);
    expect(h2.start).toBeGreaterThan(h1.start);
    expect(h2.start).toBeLessThan(x2.start);                              // blocked retry does not hold the queue
    expect(x2.start).toBe(log.find(r => r.id === 'r0').start + 60000);    // waits for both pause and budget
    expectWithinBudget('conversations.replies', 50);
  });
});
