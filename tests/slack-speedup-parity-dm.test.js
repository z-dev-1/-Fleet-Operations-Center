// tests/slack-speedup-parity-dm.test.js
//
// Phase 4b step 0 — flags-off GOLDEN parity for the DM auto-reply engine.
// Drives the REAL pollDMAutoReplyOnce over the REAL slack_send, whose raw
// transport is replaced by a scripted fake (tests/helpers/slack-fake-transport).
// Part (a) pins the literal Slack call list (method + params, in order), the
// sends, the watermarks and the reply log that HEAD produced with no speed-up
// flags set. It was captured on HEAD before any speed-up code existed and must
// stay unmodified and green. Part (b) (appended in step 10) is the simulated
// flags-off vs flags-on run comparison.
//
// One engine per file: this file only loads the DM engine (see design §9.0).
// No network, no Slack, no Electron.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createFakeSlack, loadRealSlackSend, drive } = require('./helpers/slack-fake-transport');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-parity-dm-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('../src/orcha/relay', {
  ask: async () => JSON.stringify({ inScope: true, reply: 'Unit 42 is at the shop.', category: null, title: 'answer' }),
  askWithTimeout: async () => JSON.stringify({ inScope: true, reply: 'Unit 42 is at the shop.', category: null, title: 'answer' }),
  runWithTimeout: (run) => run(undefined),
});
injectFake('../src/orcha/ai-context', { buildFleetContext: () => '' });
injectFake('../src/orcha/fas/config', { get: () => ({ enabled: false, mode: 'disabled' }) });
injectFake('../src/scrapers/orcha_ws', { askOrcha: async () => ({ text: '' }) });

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const T = (off) => (NOW_S + off).toFixed(6);
const ME = 'UME';

const fake = createFakeSlack({ me: ME });
let ss, engine;
const ENV_KEYS = ['FLEET_SLACK_DM_PEER_CACHE', 'FLEET_SLACK_DM_SKIP_UNCHANGED',
  'FLEET_SLACK_PM_SHARED_HISTORY', 'FLEET_SLACK_LANE_CONCURRENCY', 'FLEET_SLACK_LANE_TIER_PACING', 'FLEET_SLACK_LANE_FAIRNESS'];

function seedPartA() {
  fake.ims = [
    { id: 'DS', has_unreads: false, latest: T(-7200) },
    { id: 'D1', has_unreads: true, latest: T(-60) },
    { id: 'D2', has_unreads: false, latest: T(-120) },
    { id: 'D3', has_unreads: false, latest: T(-7200) },
    { id: 'D4', has_unreads: false, latest: T(-7300) },
  ];
  fake.mpims = [];
  fake.conv = {
    DS: { peer: ME, messages: [{ ts: T(-7200), user: ME, text: 'note to self' }] },
    D1: { peer: 'U1', messages: [{ ts: T(-3600), user: ME, text: 'earlier' }, { ts: T(-60), user: 'U1', text: 'hi, where is unit 42?' }] },
    D2: { peer: 'U2', messages: [{ ts: T(-3600), user: 'U2', text: 'question' }, { ts: T(-120), user: ME, text: 'my answer' }] },
    D3: { peer: 'U3', messages: [{ ts: T(-7200), user: 'U3', text: 'old' }] },
    D4: { peer: 'U4', messages: [{ ts: T(-7300), user: 'U4', text: 'older' }] },
  };
  store.save('settings', {});
  store.save('slackDMReplies', []);
  store.save('slackDMThreadReplyCount', {});
  store.save('fasInboundClaims', {});
  store.save('contacts', []);
  store.save('slackDMAutoReplyConfig', { enabled: true, threads: {
    DS: { lastSeenTs: T(-7200), name: 'You (self)' },
    D1: { lastSeenTs: T(-3600), name: 'Name U1' },
    D2: { lastSeenTs: T(-3600), name: 'Name U2' },
    D3: { lastSeenTs: T(-7200), name: 'Name U3' },
    D4: { lastSeenTs: T(-7300), name: 'Name U4' },
  } });
}
const watermarks = () => {
  const t = (store.load('slackDMAutoReplyConfig', {}) || {}).threads || {};
  const o = {}; for (const k of Object.keys(t).sort()) o[k] = t[k].lastSeenTs; return o;
};
const replyLog = () => (store.load('slackDMReplies', []) || []).map(e => ({ id: e.id, channelId: e.channelId, ts: e.ts, replyTs: e.replyTs || null, status: e.status }));

beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  seedPartA();
  ss = loadRealSlackSend(require, tmpDir, fake);
  delete require.cache[require.resolve('../src/scrapers/slack_dm_autoreply.js')];
  engine = require('../src/scrapers/slack_dm_autoreply.js');
});
// Phase 4b fix (a): engine speed-up state/stats cleared before every test. With
// every flag off this touches nothing part (a) observes.
beforeEach(() => { engine.__test__.resetSpeedup(); });
afterAll(() => {
  vi.useRealTimers();
  try { ss._setRawRequestForTests(null); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// Literal golden values captured on HEAD (flags off). DO NOT EDIT.
const GOLDEN_RUN1_CALLS = [
  ["auth.test",{}],
  ["client.counts",{}],
  ["conversations.info",{"channel":"D1"}],
  ["conversations.info",{"channel":"D2"}],
  ["conversations.info",{"channel":"DS"}],
  ["conversations.info",{"channel":"D3"}],
  ["conversations.info",{"channel":"D4"}],
  ["conversations.info",{"channel":"D1"}],
  ["conversations.info",{"channel":"D2"}],
  ["conversations.info",{"channel":"DS"}],
  ["conversations.info",{"channel":"D3"}],
  ["conversations.info",{"channel":"D4"}],
  ["users.info",{"user":"U1"}],
  ["users.info",{"user":"U2"}],
  ["users.info",{"user":"UME"}],
  ["users.info",{"user":"U3"}],
  ["users.info",{"user":"U4"}],
  ["conversations.history",{"channel":"D1","limit":"20","oldest":"1793617200.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"D2","limit":"20","oldest":"1793617200.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"DS","limit":"20","oldest":"1793613600.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"D3","limit":"20","oldest":"1793613600.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"D4","limit":"20","oldest":"1793613500.000000","inclusive":"false"}],
  ["users.info",{"user":"U1"}],
  ["chat.postMessage",{"channel":"D1","text":"<@U1> Unit 42 is at the shop.","unfurl_links":"true","unfurl_media":"true"}],
];
const GOLDEN_RUN1_POSTS = [{"channel":"D1","text":"<@U1> Unit 42 is at the shop."}];
const GOLDEN_RUN1_WATERMARKS = {"D1":"1793620740.000000","D2":"1793617200.000000","D3":"1793613600.000000","D4":"1793613500.000000","DS":"1793613600.000000"};
const GOLDEN_RUN1_LOG = [{"id":"D1:1793620740.000000","channelId":"D1","ts":"1793620740.000000","replyTs":"R1","status":"auto-answered"}];
const GOLDEN_RUN1_RESULT = {"repliedCount":1,"escalatedCount":0,"items":0};
const GOLDEN_RUN2_CALLS = [
  ["auth.test",{}],
  ["client.counts",{}],
  ["conversations.info",{"channel":"D1"}],
  ["conversations.info",{"channel":"D2"}],
  ["conversations.info",{"channel":"DS"}],
  ["conversations.info",{"channel":"D3"}],
  ["conversations.info",{"channel":"D4"}],
  ["conversations.history",{"channel":"D1","limit":"20","oldest":"1793620740.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"D2","limit":"20","oldest":"1793617200.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"DS","limit":"20","oldest":"1793613600.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"D3","limit":"20","oldest":"1793613600.000000","inclusive":"false"}],
  ["conversations.history",{"channel":"D4","limit":"20","oldest":"1793613500.000000","inclusive":"false"}],
];
const GOLDEN_RUN2_POSTS = [];
const GOLDEN_RUN2_WATERMARKS = {"D1":"1793620740.000000","D2":"1793617200.000000","D3":"1793613600.000000","D4":"1793613500.000000","DS":"1793613600.000000"};
const GOLDEN_RUN2_RESULT = {"repliedCount":0,"escalatedCount":0,"items":0};


describe.sequential('DM engine flags-off golden parity (part a)', () => {
  it('run 1 (cold module): literal call list, sends, watermarks, reply log', async () => {
    fake.reset();
    const res = await drive(engine.pollDMAutoReplyOnce(() => {}), vi);
    const result = { repliedCount: res.repliedCount, escalatedCount: res.escalatedCount, items: (res.items || []).length };
    expect(fake.unscripted).toEqual([]);
    expect(fake.count('auth.test')).toBeGreaterThan(0);
    expect(fake.count('conversations.history')).toBeGreaterThan(0);
    expect(fake.calls).toEqual(GOLDEN_RUN1_CALLS);
    expect(fake.posts).toEqual(GOLDEN_RUN1_POSTS);
    expect(watermarks()).toEqual(GOLDEN_RUN1_WATERMARKS);
    expect(replyLog()).toEqual(GOLDEN_RUN1_LOG);
    expect(result).toEqual(GOLDEN_RUN1_RESULT);
  });

  it('run 2 (warm caches): literal call list, sends, watermarks', async () => {
    fake.reset();
    vi.setSystemTime(Date.now() + 30000);
    const res = await drive(engine.pollDMAutoReplyOnce(() => {}), vi);
    const result = { repliedCount: res.repliedCount, escalatedCount: res.escalatedCount, items: (res.items || []).length };
    expect(fake.unscripted).toEqual([]);
    expect(fake.count('auth.test')).toBeGreaterThan(0);
    expect(fake.count('conversations.history')).toBeGreaterThan(0);
    expect(fake.calls).toEqual(GOLDEN_RUN2_CALLS);
    expect(fake.posts).toEqual(GOLDEN_RUN2_POSTS);
    expect(watermarks()).toEqual(GOLDEN_RUN2_WATERMARKS);
    expect(result).toEqual(GOLDEN_RUN2_RESULT);
  });
});

// ── T7(a) shape: the golden above is a HEAD capture (b4776c2 = 966eaae + the raw
// transport seam only). On a cold module, per 1:1 DM, listOpenDMs makes the
// isSelf conversations.info for all N DMs first, then the N name-resolution
// conversations.info, then the N users.info (same DM order each time). Pinned
// here as a structural check on the literal array; part (a) is not edited.
describe.sequential('DM golden shape (T7a)', () => {
  it('cold run: N isSelf infos, then N name infos, then N users.info, in one DM order', () => {
    const N = 5;
    const ids = GOLDEN_RUN1_CALLS.slice(2, 2 + N).map(c => c[1].channel);
    const peers = { DS: ME, D1: 'U1', D2: 'U2', D3: 'U3', D4: 'U4' };
    expect(GOLDEN_RUN1_CALLS.slice(0, 2).map(c => c[0])).toEqual(['auth.test', 'client.counts']);
    expect(GOLDEN_RUN1_CALLS.slice(2, 2 + N)).toEqual(ids.map(id => ['conversations.info', { channel: id }]));
    expect(GOLDEN_RUN1_CALLS.slice(2 + N, 2 + 2 * N)).toEqual(ids.map(id => ['conversations.info', { channel: id }]));
    expect(GOLDEN_RUN1_CALLS.slice(2 + 2 * N, 2 + 3 * N)).toEqual(ids.map(id => ['users.info', { user: peers[id] }]));
    expect(new Set(ids)).toEqual(new Set(Object.keys(peers)));
  });
});

// ── T7(b) (step 10): simulated flags-off vs flags-on run, own fixture ─────────
// Sequence, in ONE test so nothing resets in between: reset → uncounted warm-up
// with the built DM flags on (S1 dmPeerCache + S2 dmSkipUnchanged 'on'; S3 is
// not built) → counted flags-off run → counted flags-on run, all within 5 min
// of fake time (so no skipped DM reaches its 5–10 min age refetch).
// N = 50 1:1 DMs: 1 self, 1 unread (latest ≤ W), 15 D_mine (only my own reply
// is newer than W), 33 unchanged. Every message has reply_count 0. The fake
// transport resolves after 450 ms of fake time.
describe.sequential('DM simulated run, flags off vs on (part b)', () => {
  const N = 50, D_MINE = 15, U = 1, LAT = 450;
  function seedPartB() {
    fake.latencyMs = LAT;
    fake.ims = []; fake.mpims = []; fake.conv = {};
    const threads = {};
    const W = T(-7200);
    const add = (id, peer, messages, latest, unread = false) => {
      fake.ims.push({ id, has_unreads: unread, latest });
      fake.conv[id] = { peer, messages };
      threads[id] = { lastSeenTs: W, name: 'Name ' + peer };
    };
    add('BS', ME, [{ ts: T(-7300), user: ME, text: 'note', reply_count: 0 }], T(-7300));
    add('BU', 'UBU', [{ ts: T(-7300), user: 'UBU', text: 'old', reply_count: 0 }], T(-7300), true);
    for (let i = 0; i < D_MINE; i++) {
      add('BM' + i, 'UBM' + i, [{ ts: T(-7300), user: 'UBM' + i, text: 'q', reply_count: 0 },
        { ts: T(-100 - i), user: ME, text: 'my answer', reply_count: 0 }], T(-100 - i));
    }
    for (let i = 0; i < N - 2 - D_MINE; i++) {
      add('BX' + i, 'UBX' + i, [{ ts: T(-7300 - i), user: 'UBX' + i, text: 'old', reply_count: 0 }], T(-7300 - i));
    }
    store.save('settings', {});
    store.save('slackDMReplies', []);
    store.save('slackDMThreadReplyCount', {});
    store.save('fasInboundClaims', {});
    store.save('contacts', []);
    store.save('slackDMAutoReplyConfig', { enabled: true, threads });
  }
  const setSp = (on) => store.save('settings', on ? { comms: { speedup: { dmPeerCache: true, dmSkipUnchanged: 'on' } } } : {});
  async function timedRun() {
    fake.reset();
    const t0 = Date.now();
    await drive(engine.pollDMAutoReplyOnce(() => {}), vi);
    return Date.now() - t0;
  }

  it('reset → warm-up (flags on) → counted off (2 + 2N) → counted on (2 + 1 + u + D_mine), within 5 min', async () => {
    ss._resetForTests();
    engine.__test__.resetSpeedup();
    seedPartB();
    const wmBefore = watermarks();
    const t0 = Date.now();

    setSp(true);
    await timedRun();                                   // warm-up: names, S1 peers, S2 lastFetchedAt
    expect(fake.unscripted).toEqual([]);
    expect(fake.posts).toEqual([]);

    setSp(false);
    const offMs = await timedRun();
    expect(fake.unscripted).toEqual([]);
    expect(fake.count('auth.test')).toBe(1);
    expect(fake.count('client.counts')).toBe(1);
    expect(fake.count('conversations.info')).toBe(N);
    expect(fake.count('conversations.history')).toBe(N);
    expect(fake.count()).toBe(2 + 2 * N);              // 102
    expect(offMs).toBeGreaterThanOrEqual((2 + 2 * N) * LAT);
    expect(fake.posts).toEqual([]);

    setSp(true);
    const onMs = await timedRun();
    expect(fake.unscripted).toEqual([]);
    expect(fake.count('auth.test')).toBe(1);
    expect(fake.count('client.counts')).toBe(1);
    expect(fake.count('conversations.info')).toBe(0);
    const hist = fake.calls.filter(c => c[0] === 'conversations.history').map(c => c[1].channel).sort();
    expect(hist).toEqual(['BS', 'BU', ...Array.from({ length: D_MINE }, (_, i) => 'BM' + i)].sort());
    expect(fake.count()).toBe(2 + 1 + U + D_MINE);     // 19 (ageRefetch = 0 within 5 min)
    expect(onMs).toBeLessThanOrEqual((2 + 1 + U + D_MINE) * LAT + 1000);
    expect(fake.posts).toEqual([]);
    const st = engine.getSpeedupStats();
    expect(st.lastRun).toMatchObject({ dms: N, historyFetched: 2 + D_MINE, historySkipped: N - 2 - D_MINE, peerHits: N, peerMisses: 0 });
    expect(st.lastRun.reasons).toMatchObject({ self: 1, unread: 1, newer: D_MINE, unchanged: N - 2 - D_MINE });

    expect(Date.now() - t0).toBeLessThan(5 * 60000);
    expect(watermarks()).toEqual(wmBefore);             // no counted run moved a watermark
    fake.latencyMs = 0;
  }, 60000); // wall-clock bound for full-suite load (fake time drives the runs)
});
