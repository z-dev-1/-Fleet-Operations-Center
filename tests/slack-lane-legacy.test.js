// tests/slack-lane-legacy.test.js
//
// Phase 4b T3: the DEFAULT lane (laneConcurrency 1, laneTierPacing off) is
// today's serialized chain: one call in flight, starts ≥ 350 ms apart, a 429
// holds the whole lane for Retry-After, 5 attempts then { ok:false,
// error:'ratelimited' }. Real slack_send, fake transport, fake timers. Also
// covers the S0 lane stats and the method-coverage check for tier budgets.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-lane-legacy-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

// Deferred transport: every call records its start time and waits for the test.
let starts, inFlight, maxInFlight, script;
function transport(method, params) {
  starts.push({ method, params, at: Date.now() });
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  const s = script.shift() || { res: { ok: true }, ms: 100 };
  return new Promise((resolve, reject) => {
    const done = () => { inFlight--; if (s.reject) reject(s.reject); else resolve(s.res); };
    if (s.ms === 0) done(); else setTimeout(done, s.ms == null ? 100 : s.ms);
  });
}
let ss;
beforeAll(() => { vi.useFakeTimers(); store.save('settings', {}); });
beforeEach(() => {
  starts = []; inFlight = 0; maxInFlight = 0; script = []; LOGS.length = 0;
  ss = loadRealSlackSend(require, tmpDir, { transport });
});
afterAll(() => { vi.useRealTimers(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

// slackWebApi is module-private; drive it through a public reader (conversations.history).
const hist = (i) => ss.readMessages('C' + i, 1);

describe('default lane (K = 1, pacing off) is today\'s chain', () => {
  it('strictly serialized, starts ≥ 350 ms apart, FIFO', async () => {
    for (let i = 0; i < 6; i++) script.push({ res: { ok: true, messages: [] }, ms: 100 });
    const ps = [0, 1, 2, 3, 4, 5].map(hist);
    await drive(Promise.all(ps), vi, 10);
    expect(maxInFlight).toBe(1);
    expect(starts.map(s => s.params.channel)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4', 'C5']);
    for (let i = 1; i < starts.length; i++) expect(starts[i].at - starts[i - 1].at).toBeGreaterThanOrEqual(350);
    const st = ss.getLaneStats();
    expect(st).toMatchObject({ calls: 6, concurrency: 1, pacing: false, inFlightMax: 1, rateLimited: 0 });
    expect(st.byMethod['conversations.history']).toBe(6);
    expect(st.perMinute['conversations.history']).toBe(6);
    expect(st.maxQueueDepth).toBeGreaterThanOrEqual(5);
    expect(st.queueWaitMsTotal).toBeGreaterThan(0);
    expect(st.requestMsTotal).toBe(600);
  });

  it('429 with Retry-After=2 retries at +2250 ms and nothing else starts meanwhile', async () => {
    script.push({ res: { __rateLimited: true, retryAfter: 2 }, ms: 0 });
    script.push({ res: { ok: true, messages: [] }, ms: 0 });
    script.push({ res: { ok: true, messages: [] }, ms: 0 });
    const a = hist(0), b = hist(1);
    await drive(Promise.all([a, b]), vi, 10);
    expect(starts.map(s => s.params.channel)).toEqual(['C0', 'C0', 'C1']);
    expect(starts[1].at - starts[0].at).toBe(2250);
    expect(starts[2].at - starts[1].at).toBeGreaterThanOrEqual(350);
    expect(LOGS.some(l => l.level === 'info' && /conversations\.history 429 — backing off 2250ms \(attempt 1\)/.test(l.msg))).toBe(true);
    expect(ss.getLaneStats()).toMatchObject({ rateLimited: 1, retries: 1, gaveUp: 0 });
  });

  it('without Retry-After the backoff is 1/2/4/8 s + jitter, then gives up after 5 attempts', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0);
    for (let i = 0; i < 5; i++) script.push({ res: { __rateLimited: true, retryAfter: null }, ms: 0 });
    const p = ss.readMessages('C9', 1).then(() => 'resolved', (e) => e.message);
    const r = await drive(p, vi, 10);
    rnd.mockRestore();
    expect(starts.length).toBe(5);
    const gaps = starts.slice(1).map((s, i) => s.at - starts[i].at);
    expect(gaps).toEqual([1000, 2000, 4000, 8000]);
    expect(r).toBe('conversations.history failed: ratelimited'); // { ok:false, error:'ratelimited' } shape reached the caller
    expect(LOGS.some(l => l.level === 'warn' && /conversations\.history rate-limited after 5 attempts — giving up/.test(l.msg))).toBe(true);
    expect(ss.getLaneStats()).toMatchObject({ rateLimited: 5, retries: 4, gaveUp: 1 });
  });

  it('a rejected call does not stall the next one', async () => {
    script.push({ reject: new Error('net down'), ms: 50 });
    script.push({ res: { ok: true, messages: [{ ts: '1.000000' }] }, ms: 50 });
    const a = hist(0).then(() => 'ok', (e) => e.message);
    const b = hist(1);
    const [ra, rb] = await drive(Promise.all([a, b]), vi, 10);
    expect(ra).toBe('net down');
    expect(rb.length).toBe(1);
  });
});

describe('lane memoization', () => {
  it('the lane shape is read once per process; settings changes after the first call do not apply', async () => {
    store.save('settings', {});
    script.push({ res: { ok: true, messages: [] }, ms: 0 });
    await drive(hist(0), vi, 10);
    store.save('settings', { comms: { speedup: { laneConcurrency: 3 } } });
    for (let i = 0; i < 3; i++) script.push({ res: { ok: true, messages: [] }, ms: 100 });
    await drive(Promise.all([1, 2, 3].map(hist)), vi, 10);
    expect(maxInFlight).toBe(1);
    expect(ss.getLaneStats()).toMatchObject({ concurrency: 1, pacing: false });
    store.save('settings', {});
  });
  it('a settings load failure memoizes K = 1, pacing off', async () => {
    const flags = require('../src/config/perf-flags');
    const spy = vi.spyOn(flags, 'loadSlackSpeedup').mockImplementation(() => { throw new Error('no data dir'); });
    script.push({ res: { ok: true, messages: [] }, ms: 0 });
    await drive(hist(0), vi, 10);
    spy.mockRestore();
    expect(ss.getLaneStats()).toMatchObject({ concurrency: 1, pacing: false });
  });
  it('laneConcurrency in settings selects the bounded lane (and forces pacing on)', async () => {
    store.save('settings', { comms: { speedup: { laneConcurrency: 2 } } });
    ss = loadRealSlackSend(require, tmpDir, { transport });
    for (let i = 0; i < 4; i++) script.push({ res: { ok: true, messages: [] }, ms: 1000 });
    await drive(Promise.all([0, 1, 2, 3].map(hist)), vi, 10);
    expect(maxInFlight).toBe(2);
    expect(ss.getLaneStats()).toMatchObject({ concurrency: 2, pacing: true, inFlightMax: 2 });
    expect(LOGS.some(l => /\[slack\] lane concurrency=2 pacing=on/.test(l.msg))).toBe(true);
    store.save('settings', {});
  });
});

describe('tier budget method coverage', () => {
  it('every slackWebApi method in slack_send is budgeted or a declared default-budget write', () => {
    const { TIER_PER_MIN, DEFAULT_BUDGET_METHODS, READ_METHODS } = require('../src/slack/web-api-lane');
    const src = fs.readFileSync(require.resolve('../src/scrapers/slack_send.js'), 'utf8');
    const found = new Set();
    for (const m of src.matchAll(/slackWebApi\(\s*['"]([\w.]+)['"]/g)) found.add(m[1]);
    expect([...found].sort()).toEqual(['auth.test', 'chat.postMessage', 'client.counts', 'conversations.history',
      'conversations.info', 'conversations.list', 'conversations.members', 'conversations.open', 'conversations.replies',
      'files.completeUploadExternal', 'files.getUploadURLExternal', 'files.info', 'search.modules', 'users.info',
      'users.lookupByEmail'].sort());
    for (const m of found) expect(m in TIER_PER_MIN || DEFAULT_BUDGET_METHODS.includes(m)).toBe(true);
    for (const m of Object.keys(TIER_PER_MIN)) expect(READ_METHODS.has(m)).toBe(true);
    for (const m of DEFAULT_BUDGET_METHODS) expect(READ_METHODS.has(m)).toBe(false);
    expect(TIER_PER_MIN['conversations.list']).toBe(20);
    expect(TIER_PER_MIN['users.lookupByEmail']).toBe(50);
  });
});
