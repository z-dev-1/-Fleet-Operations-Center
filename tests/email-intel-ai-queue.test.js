// tests/email-intel-ai-queue.test.js — scan AI queue (design 3.10; F-17, R8.4, F2-06).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mk } from './fixtures/email-intel/emails.js';
import { recordOf, docOf, analyzeDoc, scriptedRelay, aiFixture } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const { createQueue } = require('../src/email-intel/understand/ai-queue');
const lane = require('../src/email-intel/understand/lane');
const C = require('../src/email-intel/constants');

beforeEach(() => lane._resetForTests());
afterEach(() => lane._resetForTests());

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function tracked() {
  const t = { inFlight: 0, max: 0, order: [] };
  t.job = (name, ms = 5) => async () => { t.inFlight++; t.max = Math.max(t.max, t.inFlight); t.order.push(name); await tick(ms); t.inFlight--; return name; };
  return t;
}
// Collect results sequentially (no Promise.all in the module; the test awaits in order too).
async function settle(ps) { const out = []; for (const p of ps) out.push(await p); return out; }

describe('F-17 concurrency', () => {
  it('F-17 never more than AI_CONCURRENCY calls in flight', async () => {
    const t = tracked();
    const q = createQueue({});
    const res = await settle(['a', 'b', 'c', 'd', 'e'].map((n) => q.run(t.job(n))));
    expect(res.map((r) => r.value)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(t.max).toBe(C.AI_CONCURRENCY);
    expect(C.AI_CONCURRENCY).toBe(1);
    const t2 = tracked();
    const q2 = createQueue({ concurrency: 9 });                  // config can ask for more; the hard cap is 2
    await settle([1, 2, 3, 4, 5, 6].map((n) => q2.run(t2.job(n))));
    expect(t2.max).toBe(C.AI_CONCURRENCY_HARD);
    expect(q2.stats().concurrency).toBe(2);
  });

  it('F-17 aborted signal stops queued calls', async () => {
    const t = tracked();
    const ac = new AbortController();
    const q = createQueue({ signal: ac.signal });
    const ps = ['a', 'b', 'c'].map((n) => q.run(t.job(n, 15)));
    await tick(2);
    ac.abort();
    const res = await settle(ps);
    expect(res[0]).toEqual({ ok: true, value: 'a' });
    expect(res.slice(1)).toEqual([{ ok: false, dropped: 'aborted' }, { ok: false, dropped: 'aborted' }]);
    expect(t.order).toEqual(['a']);
    expect(await q.run(t.job('late'))).toEqual({ ok: false, dropped: 'aborted' });
  });

  it('budget, deadline and degraded lane drop work without running it; higher priority goes first', async () => {
    const t = tracked();
    const q = createQueue({ budget: 2 });
    const res = await settle([1, 2, 3].map((n) => q.run(t.job(n))));
    expect(res[2]).toEqual({ ok: false, dropped: 'budget' });
    expect(q.stats()).toMatchObject({ started: 2, dropped: 1, droppedBy: { budget: 1 } });
    const clock = 1_000_000;
    const qd = createQueue({ deadlineAt: clock + C.AI_CALL_TIMEOUT_MS - 1, now: () => clock });
    expect(await qd.run(t.job('x'))).toEqual({ ok: false, dropped: 'deadline' });
    let ls = 'ok';
    const ql = createQueue({ laneState: () => ls });
    const first = ql.run(t.job('l1', 10));
    const second = ql.run(t.job('l2'));
    ls = 'degraded';
    expect(await first).toEqual({ ok: true, value: 'l1' });
    expect(await second).toEqual({ ok: false, dropped: 'degraded' });
    const tp = tracked();
    const qp = createQueue({});
    const ps = [qp.run(tp.job('busy', 10)), qp.run(tp.job('low'), { priority: 0 }), qp.run(tp.job('high'), { priority: 6 }), qp.run(tp.job('low2'), { priority: 0 })];
    await settle(ps);
    expect(tp.order).toEqual(['busy', 'high', 'low', 'low2']);
    expect(C.AI_CALLS_HARD).toBe(40);
    expect(createQueue({ budget: 500 }).stats().budget).toBe(40);
  });
});

describe('F2-06 back-to-back isolated calls', () => {
  it('F2-06 scan AI calls are dequeued back to back and every call carries isolated true', async () => {
    const recs = [0, 1, 2, 3].map((i) => recordOf(mk({ conversationId: 'conv-b2b-' + i, subject: 'Parts update 40123 #' + i, body: 'Parts arrived for unit 40123, repair starts Monday. Ref ' + i, to: undefined })));
    const relay = scriptedRelay(() => aiFixture('multi20to'), { delayMs: 3 });
    const doc = docOf(recs);
    const stats = await analyzeDoc(doc, relay);
    expect(stats.aiCalls).toBe(4);
    expect(relay.calls).toHaveLength(4);
    expect(relay.maxInFlight).toBe(1);
    // strictly alternating start/end: no overlap, no interleaved call from anywhere else
    expect(relay.events).toEqual(['start:0', 'end:0', 'start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    for (const c of relay.calls) expect(c.opts).toMatchObject({ isolated: true, source: 'email_intel', priority: 'normal' });
    for (const r of recs) expect(doc.messages[r.messageKey].analysis.status).toBe('ok');
  });
});
