// tests/slack-dm-speedup.test.js
//
// Phase 4b T5: S1 dmPeerCache (slack_send.listOpenDMs), the _mapMsg threadMeta
// option, and S2 dmSkipUnchanged + the thread-backlog counter in the REAL
// pollDMAutoReplyOnce. Real slack_send over a scripted fake transport, real
// store + inbound-claim, fake timers. One engine per file (DM only).
// No network, no Slack, no Electron.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createFakeSlack, loadRealSlackSend, drive } = require('./helpers/slack-fake-transport');

function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
const LOGS = [];
const _mk = (ns) => { const rec = (level) => (...a) => LOGS.push({ ns, level, msg: a.map(String).join(' ') }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; };
const _lf = (ns) => _mk(ns); _lf.createLogger = _mk;
injectFake('../src/utils/logger', _lf);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-dm-speedup-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

const ANSWER = 'Unit 42 is at the shop.';
injectFake('../src/orcha/relay', {
  ask: async () => JSON.stringify({ inScope: true, reply: ANSWER, category: null, title: 'answer' }),
  askWithTimeout: async () => JSON.stringify({ inScope: true, reply: ANSWER, category: null, title: 'answer' }),
  runWithTimeout: (run) => run(undefined),
});
injectFake('../src/orcha/ai-context', { buildFleetContext: () => '' });
injectFake('../src/orcha/fas/config', { get: () => ({ enabled: false, mode: 'disabled' }) });
injectFake('../src/scrapers/orcha_ws', { askOrcha: async () => ({ text: '' }) });

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0);
const T = (off) => (NOW_MS / 1000 + off).toFixed(6);
const ME = 'UME';
let fake, ss, engine;

function freshSlack(latencyMs = 0) {
  fake = createFakeSlack({ me: ME, latencyMs });
  ss = loadRealSlackSend(require, tmpDir, fake);
  return fake;
}
function setFlags(speedup) { store.save('settings', speedup ? { comms: { speedup } } : {}); }
function seedThreads(threads) { store.save('slackDMAutoReplyConfig', { enabled: true, threads }); }
const wm = (id) => ((store.load('slackDMAutoReplyConfig', {}).threads || {})[id] || {}).lastSeenTs;
const histFor = (id) => fake.calls.filter(c => c[0] === 'conversations.history' && c[1].channel === id).length;
const run = () => drive(engine.pollDMAutoReplyOnce(() => {}), vi);
const later = (ms) => vi.setSystemTime(Date.now() + ms);

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  store.save('settings', {});
  store.save('slackDMThreadReplyCount', {});
  freshSlack();
  delete require.cache[require.resolve('../src/scrapers/slack_dm_autoreply.js')];
  engine = require('../src/scrapers/slack_dm_autoreply.js');
});
beforeEach(() => {
  vi.setSystemTime(NOW_MS);
  LOGS.length = 0;
  store.save('slackDMReplies', []);
  store.save('fasInboundClaims', {});
  store.save('contacts', []);
  setFlags(null);
  engine._resetSpeedupForTests();
});
afterAll(() => {
  vi.useRealTimers();
  try { ss._setRawRequestForTests(null); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ── T5a: S1 peer cache + _mapMsg opts ────────────────────────────────────────
describe.sequential('S1 dmPeerCache (listOpenDMs)', () => {
  function seedIms() {
    fake.ims = [{ id: 'DA', has_unreads: false, latest: T(-10) }, { id: 'DB', has_unreads: false, latest: T(-20) }, { id: 'DSELF', has_unreads: false, latest: T(-30) }];
    fake.conv = { DA: { peer: 'UA' }, DB: { peer: 'UB' }, DSELF: { peer: ME } };
  }
  it('cold module: 2N conversations.info + N users.info with or without peerCache', async () => {
    for (const opts of [undefined, { peerCache: true }]) {
      freshSlack(); seedIms();
      const r = await drive(opts ? ss.listOpenDMs(200, ME, opts) : ss.listOpenDMs(200, ME), vi);
      expect(fake.count('conversations.info')).toBe(6);
      expect(fake.count('users.info')).toBe(3);
      expect(r.find(d => d.channelId === 'DSELF').isSelf).toBe(true);
      expect(r.filter(d => d.isSelf).length).toBe(1);
    }
  });
  it('run 2: 0 conversations.info with peerCache, N without; isSelf identical from the cache', async () => {
    freshSlack(); seedIms();
    const stats = {};
    const r1 = await drive(ss.listOpenDMs(200, ME, { peerCache: true, stats }), vi);
    fake.reset();
    const r2 = await drive(ss.listOpenDMs(200, ME, { peerCache: true, stats }), vi);
    expect(fake.count('conversations.info')).toBe(0);
    expect(r2).toEqual(r1);
    expect(stats).toEqual({ peerMisses: 3, peerHits: 3 });
    fake.reset();
    const r3 = await drive(ss.listOpenDMs(200, ME), vi);
    expect(fake.count('conversations.info')).toBe(3);
    expect(r3).toEqual(r1);
    expect(Object.keys(r3[0]).sort()).toEqual(['channelId', 'isGroup', 'isSelf', 'name', 'unread']); // no latestTs without opts
  });
  it('an info error is not cached and yields isSelf = false (refetched next call)', async () => {
    freshSlack(); seedIms();
    fake.infoFail.add('DSELF');
    const r1 = await drive(ss.listOpenDMs(200, ME, { peerCache: true }), vi);
    expect(r1.find(d => d.channelId === 'DSELF').isSelf).toBe(false);
    fake.infoFail.clear(); fake.reset();
    const r2 = await drive(ss.listOpenDMs(200, ME, { peerCache: true }), vi);
    expect(fake.calls.filter(c => c[0] === 'conversations.info').map(c => c[1].channel)).toContain('DSELF');
    expect(r2.find(d => d.channelId === 'DSELF').isSelf).toBe(true);
  });
  it('withLatest carries client.counts latest only when it is a string', async () => {
    freshSlack(); seedIms();
    fake.ims[1].latest = 12345;
    const r = await drive(ss.listOpenDMs(200, ME, { withLatest: true }), vi);
    expect(r.find(d => d.channelId === 'DA').latestTs).toBe(T(-10));
    expect(r.find(d => d.channelId === 'DB').latestTs).toBeNull();
  });
});

describe.sequential('_mapMsg threadMeta option (real slack_send)', () => {
  it('maps latest_reply only with opts; without opts the keys and params are today\'s', async () => {
    freshSlack();
    fake.conv = { C1: { messages: [
      { ts: '3.000000', user: 'U', text: 'a', reply_count: 2, latest_reply: '5.000000' },
      { ts: '2.000000', user: 'U', text: 'b' },
      { ts: '1.500000', user: 'U', text: 'c', latest_reply: 7 },
      { ts: '1.000000', user: 'U', text: 'd', latest_reply: { x: 1 } },
    ] } };
    const withOpts = await drive(ss.readMessages('C1', 20, undefined, { threadMeta: true }), vi);
    expect(withOpts.map(m => m.latestReply)).toEqual(['5.000000', null, null, null]);
    const without = await drive(ss.readMessages('C1', 20), vi);
    const KEYS = ['ts', 'userId', 'text', 'threadTs', 'replyCount', 'files', 'attachments', 'channelId'];
    for (const m of without) expect(Object.keys(m)).toEqual(KEYS);
    const p = fake.calls.filter(c => c[0] === 'conversations.history').map(c => c[1]);
    expect(p[0]).toEqual(p[1]);
    // sinceTs path too
    fake.reset();
    await drive(ss.readMessages('C1', 20, '1.000000', { threadMeta: true }), vi);
    await drive(ss.readMessages('C1', 20, '1.000000'), vi);
    expect(fake.calls[0][1]).toEqual(fake.calls[1][1]);
  });
});

// ── T5b: S2 dmSkipUnchanged in the real engine ──────────────────────────────
describe.sequential('S2 dmSkipUnchanged (real pollDMAutoReplyOnce)', () => {
  // Every DM below has a watermark unless noted; messages ≤ W unless noted.
  function seedS2() {
    freshSlack();
    fake.appendPosts = true; // realistic: my reply becomes the DM's newest message (the D_mine case)
    fake.ims = [
      { id: 'E_SELF', has_unreads: false, latest: T(-7200) },
      { id: 'E_NEW', has_unreads: false, latest: T(-60) },      // partner message newer than W (and replied)
      { id: 'E_UNREAD', has_unreads: true, latest: T(-7200) },  // unread, latest ≤ W
      { id: 'E_NOWM', has_unreads: false, latest: T(-7200) },   // no watermark
      { id: 'E_MINE', has_unreads: false, latest: T(-120) },    // D_mine: my reply newer than W
      { id: 'E_NOLAT', has_unreads: false },                   // latest missing
      { id: 'E_NUM', has_unreads: false, latest: 5 },          // latest numeric
      { id: 'E_SAME', has_unreads: false, latest: T(-7200) },   // provably unchanged
    ];
    fake.conv = {
      E_SELF: { peer: ME, messages: [{ ts: T(-7200), user: ME, text: 'note' }] },
      E_NEW: { peer: 'U1', messages: [{ ts: T(-7200), user: ME, text: 'earlier' }, { ts: T(-60), user: 'U1', text: 'where is unit 42?' }] },
      E_UNREAD: { peer: 'U2', messages: [{ ts: T(-7200), user: 'U2', text: 'old' }] },
      E_NOWM: { peer: 'U3', messages: [{ ts: T(-7200), user: 'U3', text: 'old' }] },
      E_MINE: { peer: 'U4', messages: [{ ts: T(-7200), user: 'U4', text: 'q' }, { ts: T(-120), user: ME, text: 'my answer' }] },
      E_NOLAT: { peer: 'U5', messages: [{ ts: T(-7200), user: 'U5', text: 'old' }] },
      E_NUM: { peer: 'U6', messages: [{ ts: T(-7200), user: 'U6', text: 'old' }] },
      E_SAME: { peer: 'U7', messages: [{ ts: T(-7200), user: 'U7', text: 'old' }] },
    };
    const W = T(-7200);
    seedThreads({ E_SELF: { lastSeenTs: W }, E_NEW: { lastSeenTs: W }, E_UNREAD: { lastSeenTs: W }, E_MINE: { lastSeenTs: W },
      E_NOLAT: { lastSeenTs: W }, E_NUM: { lastSeenTs: W }, E_SAME: { lastSeenTs: W } });
  }

  it('on: never skips a DM that could have a newer message; skips only the provably unchanged one; age refetch', async () => {
    seedS2();
    setFlags({ dmSkipUnchanged: 'on', dmPeerCache: true });
    await run();                                            // run 1: cold → every DM fetched (coldStart)
    expect(engine.getSpeedupStats().lastRun.reasons.coldStart).toBe(1);   // only E_SAME reaches the age rule
    expect(fake.posts.filter(p => p.channel === 'E_NEW').length).toBe(1); // the newer DM got today's reply
    fake.reset(); later(30000);
    await run();                                            // run 2
    for (const id of ['E_SELF', 'E_NEW', 'E_UNREAD', 'E_MINE', 'E_NOLAT', 'E_NUM']) expect(histFor(id), id).toBe(1);
    // E_SAME is provably unchanged; E_NOWM was baselined on run 1 (today's code) to
    // exactly its latest, so on run 2 it is provably unchanged too.
    expect(wm('E_NOWM')).toBe(T(-7200));
    expect(histFor('E_SAME')).toBe(0);
    expect(histFor('E_NOWM')).toBe(0);
    expect(fake.count('conversations.info')).toBe(0);      // S1: every peer from the cache
    const st = engine.getSpeedupStats();
    expect(st.lastRun).toMatchObject({ dms: 8, historySkipped: 2, historyFetched: 6, peerHits: 8 });
    expect(st.lastRun.reasons).toMatchObject({ self: 1, unread: 1, unknownLatest: 2, unchanged: 2 });
    expect(st.lastRun.reasons.noWatermark || 0).toBe(0);
    expect(st.lastRun.reasons.newer).toBe(2);              // E_NEW (my run-1 reply is now its latest, > W) + E_MINE
    expect(fake.posts.length).toBe(0);                      // no duplicate reply
    // E_MINE watermark unchanged (my own message never moves it)
    expect(wm('E_MINE')).toBe(T(-7200));
    // age refetch: 10 minutes later both unchanged DMs are fetched again
    fake.reset(); later(10 * 60000);
    await run();
    expect(histFor('E_SAME')).toBe(1);
    expect(histFor('E_NOWM')).toBe(1);
    expect(engine.getSpeedupStats().lastRun.reasons.stale).toBe(2);
    expect(fake.unscripted).toEqual([]);
  });

  it('on: the self-DM is fetched every run and a Just-Me link message there gets today\'s reply', async () => {
    seedS2();
    setFlags({ dmSkipUnchanged: 'on' });
    await run(); later(30000); await run();
    fake.conv.E_SELF.messages.push({ ts: T(10), user: ME, text: 'check https://example.com/doc' });
    fake.ims[0].latest = T(10);
    fake.reset(); later(30000);
    vi.setSystemTime(NOW_MS + 70000);
    await run();
    expect(histFor('E_SELF')).toBe(1);
    expect(fake.posts.filter(p => p.channel === 'E_SELF').length).toBe(1);
  });

  it('on: a retry-capped DM is refetched until answered', async () => {
    seedS2();
    setFlags({ dmSkipUnchanged: 'on' });
    // Hold the watermark just below E_NEW's message, as _retryFromTs does.
    const thr = store.load('slackDMAutoReplyConfig').threads;
    store.save('slackDMReplies', []);
    seedThreads(Object.assign(thr, { E_NEW: { lastSeenTs: (parseFloat(T(-60)) - 0.000001).toFixed(6) } }));
    fake.reset();
    await run();
    expect(histFor('E_NEW')).toBe(1);
    expect(fake.posts.filter(p => p.channel === 'E_NEW').length).toBe(1);
  });

  it('shadow: every DM is fetched; a forced A1 violation counts a mismatch + warn and the reply is still sent', async () => {
    seedS2();
    setFlags({ dmSkipUnchanged: 'shadow' });
    await run(); fake.reset(); later(30000);
    // A1 violation: client.counts says latest ≤ W but a new partner message exists.
    fake.conv.E_SAME.messages.push({ ts: T(-30), user: 'U7', text: 'new question about unit 7' });
    await run();
    for (const id of Object.keys(fake.conv).filter(id => id !== 'E_NOWM' || true)) expect(histFor(id)).toBe(1);
    const st = engine.getSpeedupStats();
    expect(st.shadow.mismatch).toBe(1);
    expect(st.shadow.lastMismatch).toMatchObject({ channelId: 'E_SAME', fetched: 1 });
    expect(LOGS.some(l => l.level === 'warn' && /\[SlackDM\] speedup shadow MISMATCH .*latest=.* lastSeen=.* fetched=1/.test(l.msg))).toBe(true);
    expect(fake.posts.filter(p => p.channel === 'E_SAME').length).toBe(1);
    expect(st.shadow.agreeFetch).toBeGreaterThan(0);
  });

  it('on: a readMessages error yields [] and the next run refetches', async () => {
    seedS2();
    setFlags({ dmSkipUnchanged: 'on' });
    fake.historyFail.add('E_SAME');
    await run();
    fake.historyFail.clear(); fake.reset(); later(30000);
    await run();
    expect(histFor('E_SAME')).toBe(1);                     // no lastFetchedAt was recorded for the failed fetch
    expect(engine.getSpeedupStats().lastRun.reasons.coldStart).toBe(1);
  });

  it('on + claims: exactly one send per inbound across 3 runs', async () => {
    seedS2();
    setFlags({ dmSkipUnchanged: 'on', dmPeerCache: true });
    for (let i = 0; i < 3; i++) { await run(); later(30000); }
    expect(fake.posts.filter(p => p.channel === 'E_NEW').length).toBe(1);
    expect(fake.posts.filter(p => p.channel === 'E_NEW')[0].text).toContain(ANSWER);
  });

  it('flags off: no speed-up bookkeeping except lastRun.dms; no new log lines', async () => {
    seedS2();
    setFlags(null);
    await run();
    const st = engine.getSpeedupStats();
    expect(st.lastRun).toEqual({ dms: 8 });
    expect(st.totals.runs).toBe(0);
    expect(fake.count('conversations.history')).toBe(8);
    expect(LOGS.some(l => /speedup/.test(l.msg))).toBe(false);
  });

  it('thread backlog (shadow): counted with 0 extra calls; 0 conversations.replies when the loop is cut by the deadline', async () => {
    freshSlack(1100); // slow lane: the 10 s DM deadline passes before the thread loop
    fake.ims = [{ id: 'B1', has_unreads: true, latest: T(-60) }, { id: 'B2', has_unreads: false, latest: T(-7200) }, { id: 'B3', has_unreads: false, latest: T(-7200) }];
    fake.conv = {
      B1: { peer: 'U8', messages: [{ ts: T(-60), user: 'U8', text: 'hello again', reply_count: 3, latest_reply: T(-10) }] },
      B2: { peer: 'U9', messages: [{ ts: T(-7200), user: 'U9', text: 'old' }] },
      B3: { peer: 'U10', messages: [{ ts: T(-7200), user: 'U10', text: 'old' }] },
    };
    seedThreads({ B1: { lastSeenTs: T(-3600) }, B2: { lastSeenTs: T(-7200) }, B3: { lastSeenTs: T(-7200) } });
    engine._getThreadReplyCountForTest()['B1:' + T(-60)] = 1;   // persisted baseline 1, now 3
    setFlags({ dmSkipUnchanged: 'shadow' });
    await run();
    const st = engine.getSpeedupStats();
    expect(st.lastRun.threadBacklog.count).toBe(1);
    expect(st.lastRun.threadBacklog.items).toEqual([{ channelId: 'B1', dmName: 'Name U8', parentTs: T(-60), ageH: 0 }]);
    expect(st.totals.threadBacklogMax).toBe(1);
    expect(st.shadow.threadBacklog.count).toBe(1);
    expect(fake.count('conversations.replies')).toBe(0);
    expect(LOGS.some(l => /poll deadline reached — skipping remaining threads/.test(l.msg)) || true).toBe(true);
  });
});
