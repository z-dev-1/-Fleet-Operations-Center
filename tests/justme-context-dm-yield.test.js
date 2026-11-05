// T-DM-YIELD (AC-31, design §12.4): when Z's self-DM is also the Just Me channel
// and the context reader is on, DM auto-reply yields that DM (no AI call, no send)
// and advances its watermark. Flag off: today's self-DM file reply.
// Harness: the REAL pollDMAutoReplyOnce with Slack, relay and fleet context faked
// through require.cache and the real store in a temp dir (the pattern of
// tests/slack-inbound-pipeline.test.js).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-dmyield-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let _dms = [];
let _messagesByChannel = {};
let _sent = [];
let _relayCalls = 0;
injectFake('../src/scrapers/slack_send', {
  checkLiveAuth: async () => ({ authenticated: true, userId: 'ME' }),
  listOpenDMs: async () => _dms,
  readMessages: async (channelId) => (_messagesByChannel[channelId] || []).slice(),
  readThreadReplies: async () => [],
  sendToChannel: async (channelId, text, threadTs) => { _sent.push({ channelId, text, threadTs }); return { ts: 'reply-' + _sent.length }; },
  resolveUserName: async (id) => 'Name ' + id,
  downloadFileContent: async () => ({ ok: true, text: 'file text', name: 'notes.txt' }),
  SELF_REPLY_MARKER: '\u200B\u2060',
});
const _relay = async () => { _relayCalls++; return JSON.stringify({ inScope: true, reply: 'Here is what the file says.', category: null, title: 'file' }); };
injectFake('../src/orcha/relay', { ask: _relay, askWithTimeout: (p, o) => _relay(p, o), runWithTimeout: (run) => run(undefined) });
injectFake('../src/orcha/ai-context', { buildFleetContext: () => '' });
injectFake('../src/orcha/fas/config', { get: () => ({ enabled: false, mode: 'disabled' }) });

async function loadEngine() {
  const resolved = require.resolve('../src/scrapers/slack_dm_autoreply.js');
  delete require.cache[resolved];
  return import('../src/scrapers/slack_dm_autoreply.js');
}
const nowTs = (off) => String((Date.now() / 1000 + (off || 0)).toFixed(6));
const wm = (id) => ((store.load('slackDMAutoReplyConfig', {}).threads || {})[id] || {}).lastSeenTs;

let W0, NEW_TS;
beforeEach(() => {
  _dms = [{ channelId: 'DSELF', name: 'Z (you)', isGroup: false, isSelf: true }];
  W0 = nowTs(-600);
  NEW_TS = nowTs(-5);
  _messagesByChannel = { DSELF: [{ userId: 'ME', ts: NEW_TS, text: 'what is in this?', files: [{ id: 'F0TXT1', name: 'notes.txt', mimetype: 'text/plain' }] }] };
  _sent = [];
  _relayCalls = 0;
  store.save('contacts', []);
  store.save('slackDMReplies', []);
  store.save('slackDMThreadReplyCount', {});
  store.save('slackDMAutoReplyConfig', { enabled: true, threads: { DSELF: { name: 'Z (you)', lastSeenTs: W0 } } });
  store.save('slackChannelWatchConfig', { enabled: true, replyMode: 'justme', channels: [{ id: 'DSELF', name: 'Z (you)', enabled: true, replyMode: 'justme' }] });
});
afterEach(() => { process.env.FLEET_JUSTME_READ_CONTEXT = '0'; });

describe('T-DM-YIELD', () => {
  it('flag on: no AI call and no send for the Just Me self-DM; watermark advanced; skip logged', async () => {
    process.env.FLEET_JUSTME_READ_CONTEXT = '1';
    const engine = await loadEngine();
    const lines = [];
    await engine.pollDMAutoReplyOnce((m) => lines.push(m));
    expect(_relayCalls).toBe(0);
    expect(_sent).toHaveLength(0);
    expect(wm('DSELF')).toBe(NEW_TS);
    expect(lines).toContain('[SlackDM] Z (you): self-DM owned by Just Me (context reader on) — skipped');
  });
  it('flag on but the self-DM is not the Just Me channel → today\'s reply', async () => {
    process.env.FLEET_JUSTME_READ_CONTEXT = '1';
    store.save('slackChannelWatchConfig', { enabled: true, replyMode: 'justme', channels: [{ id: 'COTHER', name: 'other', enabled: true, replyMode: 'justme' }] });
    const engine = await loadEngine();
    await engine.pollDMAutoReplyOnce(() => {});
    expect(_sent).toHaveLength(1);
  });
  it('flag off: today\'s self-DM file reply (marked as a self reply)', async () => {
    const engine = await loadEngine();
    const lines = [];
    await engine.pollDMAutoReplyOnce((m) => lines.push(m));
    expect(_relayCalls).toBeGreaterThan(0);
    expect(_sent).toHaveLength(1);
    expect(_sent[0].channelId).toBe('DSELF');
    expect(_sent[0].text.startsWith('\u200B\u2060')).toBe(true);
    expect(lines.some((l) => l.includes('owned by Just Me'))).toBe(false);
  });
});
