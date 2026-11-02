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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
const ENV_KEYS = ['FLEET_SLACK_DM_PEER_CACHE', 'FLEET_SLACK_DM_SKIP_UNCHANGED', 'FLEET_SLACK_THREAD_REUSE',
  'FLEET_SLACK_PM_SHARED_HISTORY', 'FLEET_SLACK_LANE_CONCURRENCY', 'FLEET_SLACK_LANE_TIER_PACING'];

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
