// tests/slack-lane-fairness.test.js
//
// Fair Slack Web API lane (comms.speedup.laneFairness / FLEET_SLACK_LANE_FAIRNESS),
// design T1. REAL src/scrapers/slack_send.js with a deterministic fake transport
// (tests/helpers/slack-fake-transport.js loadRealSlackSend + drive) and vitest
// fake timers. No network, no Slack, no Electron.
//
// Every call carries a test-only params.__id; the transport scripts each call's
// attempts by that id (RTT, 429 Retry-After, network reject) and echoes the id,
// so each caller can be checked to settle exactly once with its own result.
// Calls go through slack_send.__test__.slackWebApi (test-only handle).
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadRealSlackSend, drive } = require('./helpers/slack-fake-transport');

const LOGS = [];
const _mk = (ns) => { const rec = (level) => (...a) => LOGS.push({ ns, level, msg: a.map(String).join(' ') }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; };
const _lf = (ns) => _mk(ns); _lf.createLogger = _mk;
{ const r = require.resolve('../src/utils/logger'); require.cache[r] = { id: r, filename: r, loaded: true, exports: _lf }; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-lane-fair-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const { runWithOrigin, currentOrigin } = require('../src/slack/lane-origin');

const ENV_KEYS = ['FLEET_SLACK_DM_PEER_CACHE', 'FLEET_SLACK_DM_SKIP_UNCHANGED', 'FLEET_SLACK_PM_SHARED_HISTORY',
  'FLEET_SLACK_LANE_CONCURRENCY', 'FLEET_SLACK_LANE_TIER_PACING', 'FLEET_SLACK_LANE_FAIRNESS'];
const ORIGINS = ['dmAutoReply', 'channelWatch', 'dmNotify', 'other'];
const READS = ['conversations.history', 'conversations.replies', 'conversations.info', 'users.info', 'client.counts'];
const H = 'conversations.history';
const POST = 'chat.postMessage';

// ── Deterministic transport keyed by params.__id ────────────────────────────
// script[id] = [attempt0, attempt1, ...]; attempt = { ms, rl (retryAfter|null), reject }.
// Unscripted attempts answer { ok:true, echo:id } after DEFAULT_RTT.
let DEFAULT_RTT = 100;
let script, starts, inFlight, maxInFlight, T0;
function transport(method, params) {
  const id = params.__id;
  const attempt = starts.filter(s => s.id === id).length;
  starts.push({ id, method, at: Date.now() - T0, attempt });
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  const st = (script[id] && script[id][attempt]) || {};
  const ms = st.ms == null ? DEFAULT_RTT : st.ms;
  return new Promise((resolve, reject) => {
    const done = () => {
      inFlight--;
      if (st.reject) return reject(new Error(st.reject));
      if ('rl' in st) return resolve({ __rateLimited: true, retryAfter: st.rl });
      resolve({ ok: true, echo: id });
    };
    if (ms === 0) done(); else setTimeout(done, ms);
  });
}

let ss;
// Runs one scenario on the real slack_send. `issue(api)` issues calls and returns
// the promises to wait for. Records enqueue order/time/origin and each settle.
async function runLane(on, issue, { stepMs = 10, scr = {} } = {}) {
  if (on == null) delete process.env.FLEET_SLACK_LANE_FAIRNESS;
  else process.env.FLEET_SLACK_LANE_FAIRNESS = on ? '1' : '0';
  script = scr; starts = []; inFlight = 0; maxInFlight = 0; LOGS.length = 0;
  ss = loadRealSlackSend(require, tmpDir, { transport });
  const enq = new Map(); const settled = new Map(); let seq = 0;
  T0 = Date.now();
  const api = (m, p) => {
    enq.set(p.__id, { seq: seq++, at: Date.now() - T0, m, origin: currentOrigin(), isWrite: !READS.includes(m) && m !== H });
    const pr = ss.__test__.slackWebApi(m, p);
    pr.then((v) => { const e = settled.get(p.__id); settled.set(p.__id, { n: (e ? e.n : 0) + 1, ok: true, v, at: Date.now() - T0 }); },
      (err) => { const e = settled.get(p.__id); settled.set(p.__id, { n: (e ? e.n : 0) + 1, ok: false, err: err.message, at: Date.now() - T0 }); });
    return pr;
  };
  const ps = issue(api);
  await drive(Promise.allSettled(ps), vi, stepMs);
  return { starts: starts.slice(), enq, settled, stats: ss.getLaneStats(), logs: LOGS.filter(l => l.ns === 'slack_send'), maxInFlight };
}
const at = (o, m, id, ms) => new Promise((res) => setTimeout(() => res(runWithOrigin(o, () => apiRef.fn(m, { channel: 'C', __id: id }))), ms));
const apiRef = { fn: null };
const firstStarts = (r) => { const m = new Map(); for (const s of r.starts) if (s.attempt === 0) m.set(s.id, s.at); return m; };
const order = (r) => r.starts.filter(s => s.attempt === 0).map(s => s.id);

beforeAll(() => { vi.useFakeTimers(); store.save('settings', {}); });
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; store.save('settings', {}); DEFAULT_RTT = 100; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.useRealTimers();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ── T1.1 flag-off lane golden ───────────────────────────────────────────────
// Hand-derived from today's chain (350 ms start-to-start spacing, RTT 100 ms
// unless scripted; r1 429 Retry-After 1 -> backoff 1000+250 = 1250 ms slept in
// the chain: 1750 + 50 RTT + 1250 = 3050; x1 waits 350 after 3050 = 3400).
// Checked against base af1a962 (rebased onto feature/owa-triage-midway-fixes;
// original design base d57e9b5) BEFORE slack_send.js was edited.
const GOLD_CALLS = [['h1', H], ['h2', H], ['h3', H], ['p1', POST], ['h4', H], ['r1', H], ['x1', H]];
const GOLD_SCRIPT = { r1: [{ rl: 1, ms: 50 }, { ms: 100 }], x1: [{ reject: 'net down', ms: 50 }] };
const goldIssue = (api) => GOLD_CALLS.map(([id, m]) => api(m, { channel: 'C', __id: id }));
const GOLD_STARTS_OFF = [['h1', 0, 0], ['h2', 350, 0], ['h3', 700, 0], ['p1', 1050, 0], ['h4', 1400, 0],
  ['r1', 1750, 0], ['r1', 3050, 1], ['x1', 3400, 0]];
const GOLD_STATS_OFF = { calls: 8, byMethod: { [H]: 7, [POST]: 1 }, perMinute: { [H]: 7, [POST]: 1 },
  queueWaitMsTotal: 8650, requestMsTotal: 700, maxQueueDepth: 7, inFlightMax: 1,
  rateLimited: 1, retries: 1, gaveUp: 0, budgetDelays: 0, concurrency: 1, pacing: false };
const GOLD_LOGS = [{ ns: 'slack_send', level: 'info', msg: '[slack] conversations.history 429 — backing off 1250ms (attempt 1)' }];

function checkGoldOff(r) {
  expect(r.starts.map(s => [s.id, s.at, s.attempt])).toEqual(GOLD_STARTS_OFF);
  expect(r.maxInFlight).toBe(1);
  for (const [id] of GOLD_CALLS) {
    const s = r.settled.get(id);
    expect(s.n).toBe(1);
    if (id === 'x1') expect(s).toMatchObject({ ok: false, err: 'net down' });
    else expect(s).toMatchObject({ ok: true, v: { ok: true, echo: id } });
  }
  expect(r.logs).toEqual(GOLD_LOGS);
  expect(r.stats).toMatchObject(GOLD_STATS_OFF);
}

describe('T1.1 flag-off lane golden (today\'s chain, unchanged)', () => {
  it('mixed history/postMessage/429/reject sequence: exact starts, results, logs, stats', async () => {
    checkGoldOff(await runLane(false, goldIssue, { scr: GOLD_SCRIPT }));
  });
  it('flag unset and flag "0" give the same golden; tagged origins do not change it; fairness keys are off', async () => {
    const unset = await runLane(null, goldIssue, { scr: GOLD_SCRIPT });
    checkGoldOff(unset);
    expect(unset.stats).toMatchObject({ fairness: false, byOrigin: null, prioritizedWrites: null });
    const tagged = await runLane(false, (api) => GOLD_CALLS.map(([id, m], i) =>
      runWithOrigin(ORIGINS[i % 4], () => api(m, { channel: 'C', __id: id }))), { scr: GOLD_SCRIPT });
    checkGoldOff(tagged);
    expect(Object.keys(tagged.stats).sort()).toEqual(['budgetDelays', 'byMethod', 'byOrigin', 'calls', 'concurrency', 'fairness',
      'gaveUp', 'inFlightMax', 'maxQueueDepth', 'pacing', 'perMinute', 'prioritizedWrites', 'queueWaitMsTotal',
      'rateLimited', 'requestMsTotal', 'retries']);
  });
});

// ── T1.2 duplication parity (_fairServe is a verbatim copy of the attempt loop) ──
describe('T1.2 retry/429 parity flag off vs on', () => {
  const cases = {
    '429/429/ok (no Retry-After, jitter stubbed)': { a: [{ rl: null, ms: 20 }, { rl: null, ms: 20 }, { ms: 100 }] },
    '5×429 give-up': { a: [0, 1, 2, 3, 4].map(() => ({ rl: null, ms: 0 })) },
  };
  for (const [name, scr] of Object.entries(cases)) {
    it(name, async () => {
      const issue = (api) => [runWithOrigin('dmAutoReply', () => api(H, { channel: 'C', __id: 'a' })),
        runWithOrigin('channelWatch', () => api(H, { channel: 'C', __id: 'b' }))];
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const off = await runLane(false, issue, { scr });
      const on = await runLane(true, issue, { scr });
      expect(on.starts).toEqual(off.starts);
      expect(on.logs.filter(l => !/lane fairness=on/.test(l.msg))).toEqual(off.logs);
      for (const k of ['calls', 'rateLimited', 'retries', 'gaveUp', 'requestMsTotal', 'queueWaitMsTotal', 'byMethod'])
        expect(on.stats[k]).toEqual(off.stats[k]);
      expect([...on.settled.entries()].map(([id, s]) => [id, s.n, s.ok, s.v])).toEqual([...off.settled.entries()].map(([id, s]) => [id, s.n, s.ok, s.v]));
      if (scr.a.length === 5) {
        expect(off.starts.filter(s => s.id === 'a').map(s => s.at)).toEqual([0, 1150, 3300, 7450, 15600]);
        expect(on.settled.get('a').v).toEqual({ ok: false, error: 'ratelimited' });
        expect(on.logs.some(l => l.level === 'warn' && l.msg === '[slack] conversations.history rate-limited after 5 attempts — giving up')).toBe(true);
        expect(on.stats).toMatchObject({ rateLimited: 5, retries: 4, gaveUp: 1 });
      } else {
        expect(off.starts.map(s => [s.id, s.at])).toEqual([['a', 0], ['a', 1170], ['a', 3340], ['b', 3690]]);
        expect(on.stats).toMatchObject({ rateLimited: 2, retries: 2, gaveUp: 0 });
      }
    });
  }
});

// ── T1.3 flag on, deterministic ─────────────────────────────────────────────
describe('T1.3 fair lane, deterministic', () => {
  it('round-robin interleave dm×6 / channel×3 / dmNotify×2 / other×1 (all queued at t=0)', async () => {
    const plan = [...[0, 1, 2, 3, 4, 5].map(i => ['dmAutoReply', 'd' + i]), ...[0, 1, 2].map(i => ['channelWatch', 'c' + i]),
      ...[0, 1].map(i => ['dmNotify', 'n' + i]), ['other', 'o0']];
    const issue = (api) => plan.map(([o, id]) => runWithOrigin(o, () => api(H, { channel: 'C', __id: id })));
    const off = await runLane(false, issue);
    const on = await runLane(true, issue);
    expect(order(off)).toEqual(plan.map(p => p[1]));
    expect(order(on)).toEqual(['d0', 'c0', 'n0', 'o0', 'd1', 'c1', 'n1', 'd2', 'c2', 'd3', 'd4', 'd5']);
    // Same start grid (uniform occupancy), one in flight, ≥ 350 ms apart.
    expect(on.starts.map(s => s.at)).toEqual(off.starts.map(s => s.at));
    expect(on.maxInFlight).toBe(1);
    for (let i = 1; i < on.starts.length; i++) expect(on.starts[i].at - on.starts[i - 1].at).toBeGreaterThanOrEqual(350);
    expect(on.stats).toMatchObject({ fairness: true, prioritizedWrites: 0, calls: 12, maxQueueDepth: off.stats.maxQueueDepth });
    expect(on.stats.maxQueueDepth).toBe(12);
    // byOrigin.queued drops at selection (onDequeue): d0 is selected before d1 is enqueued -> max 5.
    expect(on.stats.byOrigin.dmAutoReply).toMatchObject({ enqueued: 6, served: 6, queued: 0, maxQueued: 5, writes: 0 });
    expect(on.stats.byOrigin.channelWatch).toMatchObject({ enqueued: 3, served: 3, queued: 0, maxQueued: 3 });
    expect(on.stats.byOrigin.other).toMatchObject({ enqueued: 1, served: 1, queued: 0, maxQueued: 1 });
    expect(on.logs.filter(l => /lane fairness=on/.test(l.msg)).map(l => l.msg))
      .toEqual(['[slack] lane fairness=on (round-robin: dmAutoReply,channelWatch,dmNotify,other; writes first)']);
  });

  it('fix 2: queueWaitMsTotal and byOrigin waits equal Σ(first start − enqAt), each counted once', async () => {
    const plan = [['dmAutoReply', 'd0', H], ['dmAutoReply', 'd1', H], ['channelWatch', 'c0', H], ['dmAutoReply', 'w0', POST],
      ['other', 'o0', 'users.info'], ['dmNotify', 'n0', H]];
    const issue = (api) => [...plan.slice(0, 3).map(([o, id, m]) => runWithOrigin(o, () => api(m, { channel: 'C', __id: id }))),
      ...plan.slice(3).map(([o, id, m], i) => new Promise((res) => setTimeout(() => res(runWithOrigin(o, () => api(m, { channel: 'C', __id: id }))), 130 + i * 90)))];
    const on = await runLane(true, issue, { scr: { c0: [{ rl: 1, ms: 40 }, { ms: 100 }] } });
    const fs0 = firstStarts(on);
    let total = 0; const per = {}; const max = {};
    for (const [id, e] of on.enq) {
      const w = fs0.get(id) - e.at; total += w;
      per[e.origin] = (per[e.origin] || 0) + w; max[e.origin] = Math.max(max[e.origin] || 0, w);
    }
    expect(total).toBeGreaterThan(0);
    expect(on.stats.queueWaitMsTotal).toBe(total);
    for (const o of ORIGINS) {
      expect(on.stats.byOrigin[o].waitMsTotal).toBe(per[o] || 0);
      expect(on.stats.byOrigin[o].waitMsMax).toBe(max[o] || 0);
    }
    expect(ORIGINS.reduce((a, o) => a + on.stats.byOrigin[o].waitMsTotal, 0)).toBe(on.stats.queueWaitMsTotal);
    expect(on.stats.byOrigin.dmAutoReply).toMatchObject({ enqueued: 3, served: 3, queued: 0, writes: 1 });
  });

  it('fix 2: the fair path (_fairServe) never touches the legacy _depth counter', () => {
    const src = fs.readFileSync(require.resolve('../src/scrapers/slack_send.js'), 'utf8');
    const body = src.slice(src.indexOf('async function _fairServe('), src.indexOf('// ── end _fairServe'));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/_depth/);
    expect(body).toMatch(/_statStart\(method, attempt === 0 \? _slackLastAt - job\.enqAt : 0, 1\)/);
    expect(src.match(/queueWaitMsTotal \+=/g).length).toBe(1);   // only _statStart grows it
  });

  it('O1/O2/O3: a same-origin write overtakes that origin\'s queued read; writes keep global FIFO', async () => {
    // d0 in service; queued: d1 (read), c0 (read), then writes w1 (dm), w2 (channel).
    const issue = (api) => [['dmAutoReply', 'd0', H], ['dmAutoReply', 'd1', H], ['channelWatch', 'c0', H],
      ['dmAutoReply', 'w1', POST], ['channelWatch', 'w2', 'conversations.open']].map(([o, id, m]) =>
      runWithOrigin(o, () => api(m, { channel: 'C', __id: id })));
    const on = await runLane(true, issue);
    expect(order(on)).toEqual(['d0', 'w1', 'w2', 'c0', 'd1']);
    expect(on.stats.prioritizedWrites).toBe(2);
    // A write with no read queued is not counted as prioritized.
    const lone = await runLane(true, (api) => [runWithOrigin('dmAutoReply', () => api(H, { channel: 'C', __id: 'd0' })),
      runWithOrigin('dmAutoReply', () => api(POST, { channel: 'C', __id: 'w1' }))]);
    expect(order(lone)).toEqual(['d0', 'w1']);
    expect(lone.stats.prioritizedWrites).toBe(0);
  });

  it('429 Retry-After 2 holds the whole lane 2250 ms; the same job retries before any other job', async () => {
    const issue = (api) => [['dmAutoReply', 'd0', H], ['channelWatch', 'c0', H], ['dmNotify', 'n0', H], ['other', 'w0', POST]]
      .map(([o, id, m]) => runWithOrigin(o, () => api(m, { channel: 'C', __id: id })));
    const on = await runLane(true, issue, { scr: { d0: [{ rl: 2, ms: 0 }, { ms: 0 }] } });
    expect(on.starts.map(s => [s.id, s.at, s.attempt])).toEqual([['d0', 0, 0], ['d0', 2250, 1], ['w0', 2600, 0], ['c0', 2950, 0], ['n0', 3300, 0]]);
    expect(on.logs.some(l => l.msg === '[slack] conversations.history 429 — backing off 2250ms (attempt 1)')).toBe(true);
    expect(on.stats).toMatchObject({ rateLimited: 1, retries: 1, gaveUp: 0 });
  });

  it('a network reject rejects only its own caller, the lane continues, no fair-lane log; each caller settles once with its own echo', async () => {
    const issue = (api) => ['d0', 'd1', 'd2'].map(id => runWithOrigin('dmAutoReply', () => api(H, { channel: 'C', __id: id })))
      .concat([runWithOrigin('channelWatch', () => api(H, { channel: 'C', __id: 'c0' }))]);
    const on = await runLane(true, issue, { scr: { d1: [{ reject: 'net down', ms: 30 }] } });
    expect(on.settled.get('d1')).toMatchObject({ n: 1, ok: false, err: 'net down' });
    for (const id of ['d0', 'd2', 'c0']) expect(on.settled.get(id)).toMatchObject({ n: 1, ok: true, v: { ok: true, echo: id } });
    expect(order(on)).toEqual(['d0', 'c0', 'd1', 'd2']);
    expect(on.logs.some(l => /fair lane error/.test(l.msg))).toBe(false);
  });
});

// ── T1.4 randomized property test (200 seeds) ───────────────────────────────
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function genSeed(seed, { uniform = false } = {}) {
  const rnd = mulberry32(seed * 7919 + 13);
  const n = 6 + Math.floor(rnd() * 19);
  const calls = []; const scr = {};
  for (let i = 0; i < n; i++) {
    const id = 'k' + i;
    const o = ORIGINS[Math.floor(rnd() * 4)];
    const m = rnd() < 0.25 ? (rnd() < 0.8 ? POST : 'conversations.open') : READS[Math.floor(rnd() * READS.length)];
    const t = rnd() < 0.4 ? 0 : 1 + Math.floor(rnd() * 8000);
    calls.push({ id, o, m, t });
    if (uniform) { scr[id] = [{ ms: 200 }]; continue; }
    const att = [];
    const n429 = rnd() < 0.12 ? 1 + Math.floor(rnd() * 2) : 0;
    for (let a = 0; a < n429; a++) att.push({ rl: 1 + Math.floor(rnd() * 2), ms: 50 + Math.floor(rnd() * 851) });
    const last = { ms: 50 + Math.floor(rnd() * 851) };
    if (rnd() < 0.06) last.reject = 'net down';   // network error: rejects that caller only
    att.push(last);
    scr[id] = att;
  }
  return { calls, scr };
}
function issueFor(calls) {
  return (api) => { apiRef.fn = api; return calls.map(c => c.t === 0 ? runWithOrigin(c.o, () => api(c.m, { channel: 'C', __id: c.id })) : at(c.o, c.m, c.id, c.t)); };
}
function analyze(r, scr) {
  const jobs = new Map();
  for (const s of r.starts) {
    const j = jobs.get(s.id) || { first: s.at, last: s.at, attempts: 0 };
    j.last = s.at; j.attempts++; jobs.set(s.id, j);
  }
  for (const [id, j] of jobs) { const rtt = scr[id][j.attempts - 1].ms; j.occEnd = j.last + Math.max(350, rtt); j.occ = j.occEnd - j.first; }
  const sorted = [...jobs.values()].sort((a, b) => a.first - b.first);
  const ends = []; let cur = null;
  for (const j of sorted) {
    if (cur && j.first <= cur.end) cur.end = Math.max(cur.end, j.occEnd);
    else { if (cur) ends.push(cur.end); cur = { end: j.occEnd }; }
  }
  if (cur) ends.push(cur.end);
  return { jobs, ends };
}

describe('T1.4 randomized property test, 200 seeds, flag off vs on', () => {
  it('same call set exactly once; same busy-period ends; spacing; writes never wait longer; read bound; O1–O3', async () => {
    const totals = { reordered: 0, prioritized: 0, rejects: 0, retried: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const { calls, scr } = genSeed(seed);
      const off = await runLane(false, issueFor(calls), { scr, stepMs: 50 });
      const on = await runLane(true, issueFor(calls), { scr, stepMs: 50 });
      const ctx = 'seed ' + seed;
      const A = analyze(off, scr), B = analyze(on, scr);
      // (a) same multiset of (id, method, params); each job served once with its scripted attempts; own result.
      const sig = (r) => r.starts.map(s => s.id + '|' + s.method + '|' + s.attempt).sort();
      expect(sig(on), ctx).toEqual(sig(off));
      for (const c of calls) {
        const want = scr[c.id].length;
        expect(B.jobs.get(c.id).attempts, ctx).toBe(want);
        const exp = scr[c.id][want - 1].reject ? { n: 1, ok: false, err: 'net down' } : { n: 1, ok: true, v: { ok: true, echo: c.id } };
        expect(on.settled.get(c.id), ctx).toMatchObject(exp);
        expect(off.settled.get(c.id), ctx).toMatchObject(exp);
        if (exp.ok === false) totals.rejects++;
        if (want > 1) totals.retried++;
      }
      if (order(on).join() !== order(off).join()) totals.reordered++;
      totals.prioritized += on.stats.prioritizedWrites;
      expect(on.maxInFlight, ctx).toBe(1);
      // (b) same busy-period end times (and therefore the same total completion).
      expect(B.ends, ctx).toEqual(A.ends);
      // (c) consecutive starts ≥ 350 ms apart.
      for (let i = 1; i < on.starts.length; i++) expect(on.starts[i].at - on.starts[i - 1].at, ctx).toBeGreaterThanOrEqual(350);
      const sMax = Math.max(...[...B.jobs.values()].map(j => j.occ));
      for (const c of calls) {
        const e = on.enq.get(c.id); const st = B.jobs.get(c.id).first; const wait = st - e.at;
        if (e.isWrite) {
          // (d) a write never waits longer than flag-off.
          expect(wait, ctx + ' ' + c.id).toBeLessThanOrEqual(A.jobs.get(c.id).first - off.enq.get(c.id).at);
        } else {
          // (e) R + (O·p − 1)·S_max + Σ occ(writes started while it waited), with R ≤ S_max.
          let p = 1, wsum = 0;
          for (const [id2, e2] of on.enq) {
            const j2 = B.jobs.get(id2);
            if (id2 !== c.id && !e2.isWrite && e2.origin === e.origin && e2.seq < e.seq && j2.first >= e.at) p++;
            if (e2.isWrite && j2.first >= e.at && j2.first <= st) wsum += j2.occ;
          }
          expect(wait, ctx + ' ' + c.id).toBeLessThanOrEqual(sMax + (4 * p - 1) * sMax + wsum);
        }
      }
      // (f) O1 / O2 / O3.
      const ids = [...on.enq.keys()];
      for (const x of ids) for (const y of ids) {
        const ex = on.enq.get(x), ey = on.enq.get(y);
        if (ex.seq >= ey.seq) continue;   // x enqueued before y
        const sx = B.jobs.get(x).first, sy = B.jobs.get(y).first;
        if (!ex.isWrite && !ey.isWrite && ex.origin === ey.origin) expect(sx, ctx + ' O1').toBeLessThan(sy);
        if (ex.isWrite && ey.isWrite) expect(sx, ctx + ' O2').toBeLessThan(sy);
        if (ex.isWrite && !ey.isWrite) expect(sx, ctx + ' O3').toBeLessThan(sy);
      }
    }
    // The seeds actually exercise reordering, write priority, rejections and 429 retries.
    expect(totals.reordered).toBeGreaterThan(50);
    expect(totals.prioritized).toBeGreaterThan(20);
    expect(totals.rejects).toBeGreaterThan(20);
    expect(totals.retried).toBeGreaterThan(50);
  }, 600000);
});

// ── T1.5 uniform occupancy ──────────────────────────────────────────────────
describe('T1.5 uniform occupancy (RTT 200, no 429)', () => {
  it('sorted start times equal flag-off, so calls/min is identical', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { calls, scr } = genSeed(seed, { uniform: true });
      const off = await runLane(false, issueFor(calls), { scr, stepMs: 50 });
      const on = await runLane(true, issueFor(calls), { scr, stepMs: 50 });
      expect(on.starts.map(s => s.at).sort((a, b) => a - b), 'seed ' + seed).toEqual(off.starts.map(s => s.at).sort((a, b) => a - b));
      expect(on.stats.calls).toBe(off.stats.calls);
      expect(on.stats.perMinute).toEqual(off.stats.perMinute);
    }
  }, 120000);
});

// ── T1.6 DM burst + sequential channel run ──────────────────────────────────
// 69 dmAutoReply history reads queued at t=0, then a sequential 52-call
// channelWatch run (each call awaits the previous). RTT 200 ms, no 429.
// Hand derivation (350 ms start spacing; RTT 200 < 350 so every slot is 350):
//   flag off (FIFO): DM k starts 350k, DM 68 at 23800 -> DM-run completion 24000.
//     Channel call 1 waits behind all 69: starts 69×350 = 24150; each next call
//     is enqueued at +200 and starts at the next slot: call 52 starts
//     24150 + 51×350 = 42000 -> channel completion 42200 = last completion.
//   flag on (RR, writes first; no writes here): d0 at 0; when it settles _pump
//     picks the queued channel call (rr) at 350. Each channel settle pumps a DM
//     read synchronously, BEFORE the engine's await continuation enqueues the
//     next channel call, so the channel gets every second slot:
//     call k starts 350 + (k−1)×700, call 52 at 36050 -> completion 36250.
//     All 121 calls still fill the same 350 ms grid: last start 120×350 = 42000
//     -> last completion 42200, which is now the DM run's completion.
// The real gain is time to the FIRST channel call (350 vs 24150 ms). The
// channel run ends 36250 vs 42200 (about 14 % sooner); total completion and
// calls/min are unchanged. A sequential origin gets ~1 slot in 2 of a
// saturated lane, so ≤ 55 % of flag-off is structurally impossible.
describe('T1.6 DM burst + sequential channel run (exact hand-derived values)', () => {
  it('flag off vs on', async () => {
    DEFAULT_RTT = 200;
    const issue = (api) => {
      const dms = [];
      for (let i = 0; i < 69; i++) dms.push(runWithOrigin('dmAutoReply', () => api(H, { channel: 'D', __id: 'd' + i })));
      const ch = runWithOrigin('channelWatch', async () => { for (let k = 1; k <= 52; k++) await api(H, { channel: 'C', __id: 'c' + k }); });
      return [...dms, ch];
    };
    const summarize = (r) => {
      const fs1 = firstStarts(r);
      const done = (pfx) => Math.max(...[...r.settled.entries()].filter(([id]) => id[0] === pfx).map(([, s]) => s.at));
      return { chFirst: fs1.get('c1'), chDone: done('c'), dmDone: done('d'), last: Math.max(done('c'), done('d')),
        calls: r.stats.calls, perMinute: r.stats.perMinute };
    };
    const off = summarize(await runLane(false, issue));
    const on = summarize(await runLane(true, issue));
    expect(off).toMatchObject({ chFirst: 24150, chDone: 42200, dmDone: 24000, last: 42200, calls: 121 });
    expect(on).toMatchObject({ chFirst: 350, chDone: 36250, dmDone: 42200, last: 42200, calls: 121 });
    expect(on.perMinute).toEqual(off.perMinute);
    expect(on.dmDone).toBeLessThanOrEqual(off.last);
  }, 120000);
});

// ── T1.7 combination with S5/S6 ─────────────────────────────────────────────
describe('T1.7 S5/S6 wins; laneFairness is ignored with one info line', () => {
  for (const [sp, msg] of [[{ laneConcurrency: 2 }, 'concurrency=2 pacing=on'], [{ laneTierPacing: true }, 'concurrency=1 pacing=on']]) {
    it(JSON.stringify(sp), async () => {
      store.save('settings', { comms: { speedup: sp } });
      const r = await runLane(true, (api) => [0, 1, 2].map(i => runWithOrigin('dmAutoReply', () => api(H, { channel: 'C', __id: 'd' + i }))));
      expect(r.logs.filter(l => /laneFairness ignored/.test(l.msg)).map(l => l.msg))
        .toEqual(['[slack] laneFairness ignored: requires laneConcurrency=1 and laneTierPacing off (have ' + msg + ')']);
      expect(r.logs.some(l => /lane fairness=on/.test(l.msg))).toBe(false);
      expect(r.stats).toMatchObject({ fairness: false, byOrigin: null, prioritizedWrites: null, pacing: true });
      for (const i of [0, 1, 2]) expect(r.settled.get('d' + i)).toMatchObject({ n: 1, ok: true });
    });
  }
});

// ── T1.8 surfacing through the poller ───────────────────────────────────────
describe('T1.8 getStatus().speedup.lane carries byOrigin / prioritizedWrites', () => {
  it('default speedupStats path and an injected one', async () => {
    await runLane(true, (api) => [runWithOrigin('dmAutoReply', () => api(H, { channel: 'C', __id: 'd0' })),
      runWithOrigin('dmAutoReply', () => api(H, { channel: 'C', __id: 'd1' })),
      runWithOrigin('channelWatch', () => api(POST, { channel: 'C', __id: 'w0' }))]);
    const { createPoller } = require('../src/slack/poller');
    const base = { loadFlags: () => ({ mainProcessPolling: 'off' }), owaStatus: () => null, readRaw: () => null };
    const lane = createPoller(base).getStatus().speedup.lane;
    expect(lane).toMatchObject({ fairness: true, prioritizedWrites: 1 });
    expect(lane.byOrigin.dmAutoReply).toMatchObject({ enqueued: 2, served: 2, queued: 0 });
    expect(lane.byOrigin.channelWatch).toMatchObject({ enqueued: 1, served: 1, writes: 1 });
    const injected = createPoller({ ...base, speedupStats: () => ({ lane: ss.getLaneStats() }) }).getStatus().speedup.lane;
    expect(injected.byOrigin).toEqual(lane.byOrigin);
    expect(injected.prioritizedWrites).toBe(1);
  });
});
