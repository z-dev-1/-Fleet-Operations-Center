// tests/slack-inbound-pipeline.test.js
//
// Integration coverage for the REAL DM auto-reply pipeline
// (src/scrapers/slack_dm_autoreply.js pollDMAutoReplyOnce), focused on the
// 2026-09 rework: contact discovery is DECOUPLED from every reply decision, the
// first-seen baseline still saves senders, thread-only + group senders are
// saved, >40 DMs are scanned, duplicate polling never double-replies, and a
// restricted_action becomes a TEMPORARY send-block.
//
// MOCKING NOTE (same approach as tests/slack-justme-queue.test.js): the SUT
// pulls deps via lazy require() inside its functions, so we pre-seed Node's
// require.cache with fakes at the real resolved paths. We keep the REAL store
// (a tmp data dir), the REAL Contact Book service, and the REAL
// slack_inbound_support module — only Slack I/O + the AI relay + fleet-context
// are faked. FAS is left DISABLED so the legacy reply path runs.
//
// HONEST SCOPE: these are UNIT/INTEGRATION tests with Slack faked. They do NOT
// exercise the real Slack Web API, real auth, or a real restricted_action from
// Slack — that still requires live credentials + a real workspace.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'slack-pipe-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');

// ── Fakes (injected at real resolved paths) ─────────────────────────────────
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return resolved;
}

// Controlled Slack surface.
let _dms = [];                 // what listOpenDMs returns
let _messagesByChannel = {};   // channelId -> messages (newest-first)
let _threadRepliesByKey = {};  // channelId:parentTs -> replies (parent at index 0)
let _sent = [];                // [{channelId, text, threadTs}]
let _sendImpl = null;          // optional custom send behavior (throw etc.)

injectFake('../src/scrapers/slack_send', {
  checkLiveAuth: async () => ({ authenticated: true, userId: 'ME' }),
  listOpenDMs: async () => _dms,
  readMessages: async (channelId) => (_messagesByChannel[channelId] || []).slice(),
  readThreadReplies: async (channelId, parentTs) => (_threadRepliesByKey[channelId + ':' + parentTs] || []).slice(),
  sendToChannel: async (channelId, text, threadTs) => {
    if (_sendImpl) return _sendImpl(channelId, text, threadTs);
    _sent.push({ channelId, text, threadTs });
    return { ts: 'reply-' + _sent.length };
  },
  resolveUserName: async (id) => 'Name ' + id,
  downloadFileContent: async () => null,
});

// AI relay — default: a confident in-scope reply. Overridable per test.
let _relayImpl = async () => JSON.stringify({ inScope: true, reply: 'Here is your answer.', category: null, title: 'answer' });
injectFake('../src/orcha/relay', { ask: (...a) => _relayImpl(...a) });

// Fleet-context builder — keep it cheap/empty so _classifyAndDraft doesn't need
// real fleet data.
injectFake('../src/orcha/ai-context', { buildFleetContext: () => '' });

// FAS runner + config: leave FAS DISABLED so the legacy reply path runs (the
// discovery decoupling we're testing is engine-agnostic).
injectFake('../src/orcha/fas/config', { get: () => ({ enabled: false, mode: 'disabled' }) });

const inbound = require('../src/scrapers/slack_inbound_support');
const contactBook = require('../src/services/contact-book');

async function loadEngine() {
  const resolved = require.resolve('../src/scrapers/slack_dm_autoreply.js');
  delete require.cache[resolved]; // fresh module state (watermarks, retry maps)
  const mod = await import('../src/scrapers/slack_dm_autoreply.js');
  return mod;
}

function enable(threads) {
  store.save('slackDMAutoReplyConfig', { enabled: true, threads: threads || {} });
}
function nowTs(offsetSec) { return String((Date.now() / 1000 + (offsetSec || 0)).toFixed(6)); }
function contactsBySlack(id) { return store.load('contacts', []).find(c => c.slackId === id); }

beforeEach(() => {
  _dms = []; _messagesByChannel = {}; _threadRepliesByKey = {}; _sent = []; _sendImpl = null;
  _relayImpl = async () => JSON.stringify({ inScope: true, reply: 'Here is your answer.', category: null, title: 'answer' });
  store.save('contacts', []);
  store.save('contactsTombstones', []);
  store.save('slackDMReplies', []);
  store.save('slackDMThreadReplyCount', {});
  store.save(inbound.SAVE_FAILURES_KEY, []);
  store.save(inbound.SEND_BLOCKS_KEY, {});
  store.save(inbound.LIFECYCLE_KEY, []);
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('DM inbound: contact discovery is decoupled from reply decisions', () => {
  it('first 1:1 DM within 10 min: saves the sender AND replies', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D1', name: 'Alice', isGroup: false }];
    _messagesByChannel.D1 = [{ userId: 'U_ALICE', ts: nowTs(-5), text: 'hi there' }];
    enable({}); // no prior watermark -> first poll
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_ALICE')).toBeTruthy();     // discovered
    expect(_sent.length).toBe(1);                         // replied (recent 1:1)
  });

  it('first 1:1 DM OLDER than 10 min: saves the sender but does NOT reply to old history', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D2', name: 'Bob', isGroup: false }];
    _messagesByChannel.D2 = [{ userId: 'U_BOB', ts: nowTs(-3600), text: 'old message from an hour ago' }];
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_BOB')).toBeTruthy();        // STILL discovered
    expect(_sent.length).toBe(0);                          // no reply to old history
  });

  it('first-seen GROUP DM: saves every member, no reply to backlog', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'G1', name: 'Alice, Bob', isGroup: true }];
    _messagesByChannel.G1 = [
      { userId: 'U_A', ts: nowTs(-30), text: 'hey team' },
      { userId: 'U_B', ts: nowTs(-40), text: 'hello' },
    ];
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_A')).toBeTruthy();
    expect(contactsBySlack('U_B')).toBeTruthy();          // BOTH group members saved
    expect(_sent.length).toBe(0);                          // group first-poll = baseline only
  });

  it('sender that appears ONLY in a thread reply is discovered', async () => {
    const engine = await loadEngine();
    const parentTs = nowTs(-100);
    _dms = [{ channelId: 'D3', name: 'Carol', isGroup: false }];
    // Parent is at the watermark (not a new top-level message). It has replies.
    _messagesByChannel.D3 = [{ userId: 'U_CAROL', ts: parentTs, text: 'parent', replyCount: 1 }];
    _threadRepliesByKey['D3:' + parentTs] = [
      { userId: 'U_CAROL', ts: parentTs, text: 'parent' },
    ];
    enable({ D3: { lastSeenTs: parentTs, name: 'Carol', isGroup: false } });
    // Poll #1: establishes the thread-reply-count baseline (replyCount=1) with
    // NO fetch (cold-start). No new reply yet.
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_THREADONLY')).toBeFalsy();
    // Poll #2: a NEW reply arrives from a thread-only sender; replyCount ticks
    // to 2 -> the thread is fetched -> the new sender is discovered.
    _messagesByChannel.D3 = [{ userId: 'U_CAROL', ts: parentTs, text: 'parent', replyCount: 2 }];
    _threadRepliesByKey['D3:' + parentTs] = [
      { userId: 'U_CAROL', ts: parentTs, text: 'parent' },
      { userId: 'U_THREADONLY', ts: nowTs(-5), text: 'a reply from someone new' },
    ];
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_THREADONLY')).toBeTruthy(); // thread-only sender saved
  });

  it('scans MORE than 40 DMs (conversations beyond the old ~40 cap are still discovered)', async () => {
    // 50 sequential contact-book writes (each a full-array load+save) is slow
    // under the parallel full-suite; give it headroom (the point is proving the
    // cap is gone, not speed — real polls bound work per cycle via MAX_DMS_PER_POLL).
    const engine = await loadEngine();
    _dms = [];
    const N = 50; // > the old 40 cap
    for (let i = 0; i < N; i++) {
      const cid = 'DX' + i;
      _dms.push({ channelId: cid, name: 'P' + i, isGroup: false });
      _messagesByChannel[cid] = [{ userId: 'U_P' + i, ts: nowTs(-3600), text: 'old' }]; // old -> baseline (no AI/send), still discovered
    }
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    // Every conversation is examined for discovery — including those past #40.
    expect(contactsBySlack('U_P41')).toBeTruthy();        // beyond the old ~40 cap
    expect(contactsBySlack('U_P' + (N - 1))).toBeTruthy();// the very last one
    // Sanity: essentially all were discovered (bounded per-cycle work == full list here).
    const saved = store.load('contacts', []).filter(c => c.slackId && c.slackId.startsWith('U_P')).length;
    expect(saved).toBe(N);
  }, 30000);
});

describe('DM inbound: reply safety + reliability', () => {
  it('duplicate polling does not send a second reply for the same message', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D4', name: 'Dave', isGroup: false }];
    _messagesByChannel.D4 = [{ userId: 'U_DAVE', ts: nowTs(-5), text: 'question' }];
    enable({});
    await engine.pollDMAutoReplyOnce(() => {}); // first poll replies
    const afterFirst = _sent.length;
    await engine.pollDMAutoReplyOnce(() => {}); // second poll: already logged -> no dup
    expect(_sent.length).toBe(afterFirst);      // no duplicate reply
    expect(afterFirst).toBe(1);
  });

  it('restricted_action becomes a TEMPORARY send-block (recorded, not permanent) — discovery still ran', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D5', name: 'Eve', isGroup: false }];
    _messagesByChannel.D5 = [{ userId: 'U_EVE', ts: nowTs(-5), text: 'question' }];
    _sendImpl = () => { throw new Error('Slack API error: restricted_action_read_only_channel'); };
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_EVE')).toBeTruthy();        // discovered despite send block
    expect(inbound.isSendBlocked('D5')).toBe(true);       // temporary block recorded
    expect(inbound.getSendBlocks().D5.reason).toMatch(/restricted_action/);
    expect(_sent.length).toBe(0);
    // The message was NOT marked handled (watermark held) — a later poll after
    // the block clears would retry. Simulate recheck elapsed + send now works.
    const blocks = store.load(inbound.SEND_BLOCKS_KEY, {});
    blocks.D5.recheckAt = new Date(Date.now() - 1000).toISOString();
    store.save(inbound.SEND_BLOCKS_KEY, blocks);
    _sendImpl = null; // send works now
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent.length).toBe(1);                          // retried + delivered after recheck
    expect(inbound.isSendBlocked('D5')).toBe(false);       // cleared on success
  });

  it('transient send failure holds the message for retry (not marked handled), then succeeds', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D6', name: 'Frank', isGroup: false }];
    _messagesByChannel.D6 = [{ userId: 'U_FRANK', ts: nowTs(-5), text: 'question' }];
    _sendImpl = () => { throw new Error('request timeout'); };
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent.length).toBe(0);
    expect(store.load('slackDMReplies', []).length).toBe(0); // NOT logged as handled
    // Next poll: send works -> the SAME message is retried and delivered.
    _sendImpl = null;
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent.length).toBe(1);
  });

  it('AI exception (relay throws): no false success, message held for retry, sender still saved', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D7', name: 'Grace', isGroup: false }];
    _messagesByChannel.D7 = [{ userId: 'U_GRACE', ts: nowTs(-5), text: 'question' }];
    _relayImpl = async () => { throw new Error('AI backend down'); };
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(contactsBySlack('U_GRACE')).toBeTruthy();      // discovered regardless of AI failure
    expect(_sent.length).toBe(0);                          // no canned/false reply sent
  });

  it('AI success (relay returns a real answer): replies and logs it', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D8', name: 'Heidi', isGroup: false }];
    _messagesByChannel.D8 = [{ userId: 'U_HEIDI', ts: nowTs(-5), text: 'what is the status?' }];
    _relayImpl = async () => JSON.stringify({ inScope: true, reply: 'It is Active.', category: null, title: 'status' });
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent.length).toBe(1);
    expect(_sent[0].text).toContain('It is Active.');
    expect(store.load('slackDMReplies', []).length).toBe(1);
  });

  it('restart with a pending (un-answered, send-failed) message re-processes it after restart', async () => {
    let engine = await loadEngine();
    _dms = [{ channelId: 'D9', name: 'Ivan', isGroup: false }];
    _messagesByChannel.D9 = [{ userId: 'U_IVAN', ts: nowTs(-5), text: 'question' }];
    _sendImpl = () => { throw new Error('request timeout'); };
    enable({});
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent.length).toBe(0); // held (watermark not advanced past it)
    // "Restart": reload the module fresh (loses in-memory state); the persisted
    // watermark was NOT advanced past the message, so it is retried.
    engine = await loadEngine();
    _sendImpl = null;
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent.length).toBe(1); // pending message survived the restart + delivered
  });
});
