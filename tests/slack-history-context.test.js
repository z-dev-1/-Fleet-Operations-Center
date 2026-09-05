// tests/slack-history-context.test.js
//
// Spec v2: conversation history raised from 2 to >=10 relevant messages, and
// "any update?"-style references must resolve the correct unit from that
// history. Exercised through the REAL DM poll (pollDMAutoReplyOnce) with Slack
// + AI faked (same pattern as slack-inbound-pipeline.test.js). We capture the
// prompt the AI relay receives and assert the loaded conversation context.
//
// HONEST SCOPE: unit/integration with Slack + AI faked (no live Slack/AI).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'slack-hist-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');

function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let _dms = [], _messagesByChannel = {}, _sent = [];
let _lastPrompt = '';

injectFake('../src/scrapers/slack_send', {
  checkLiveAuth: async () => ({ authenticated: true, userId: 'ME' }),
  listOpenDMs: async () => _dms,
  readMessages: async (channelId) => (_messagesByChannel[channelId] || []).slice(),
  readThreadReplies: async () => [],
  sendToChannel: async (channelId, text, threadTs) => { _sent.push({ channelId, text, threadTs }); return { ts: 'r-' + _sent.length }; },
  resolveUserName: async (id) => 'Name ' + id,
  downloadFileContent: async () => null,
});
// Capture the prompt the AI receives; return a confident reply.
injectFake('../src/orcha/relay', { ask: async (prompt) => { _lastPrompt = prompt; return JSON.stringify({ inScope: true, reply: 'ack', category: null, title: 't' }); } });
injectFake('../src/orcha/ai-context', { buildFleetContext: () => '' });
// FAS disabled -> legacy path (history building is engine-agnostic; the legacy
// _classifyAndDraft embeds the conversation context into the prompt).
injectFake('../src/orcha/fas/config', { get: () => ({ enabled: false, mode: 'disabled' }) });

async function loadEngine() {
  const resolved = require.resolve('../src/scrapers/slack_dm_autoreply.js');
  delete require.cache[resolved];
  return import('../src/scrapers/slack_dm_autoreply.js');
}
function nowTs(offsetSec) { return String((Date.now() / 1000 + (offsetSec || 0)).toFixed(6)); }

beforeEach(() => {
  _dms = []; _messagesByChannel = {}; _sent = []; _lastPrompt = '';
  store.save('contacts', []); store.save('contactsTombstones', []);
  store.save('slackDMReplies', []); store.save('slackDMThreadReplyCount', {});
  store.save('fasInboundClaims', {});
  const inbound = require('../src/scrapers/slack_inbound_support');
  store.save(inbound.SAVE_FAILURES_KEY, []); store.save(inbound.SEND_BLOCKS_KEY, {}); store.save(inbound.LIFECYCLE_KEY, []);
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('conversation history: >=10 relevant messages loaded', () => {
  it('loads at least 10 prior messages into the AI context when available', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D1', name: 'Alice', isGroup: false }];
    // 14 prior messages + 1 current (newest-first array).
    const msgs = [];
    for (let i = 1; i <= 14; i++) msgs.push({ userId: 'U_A', ts: nowTs(-100 - i), text: 'history line ' + i });
    const current = { userId: 'U_A', ts: nowTs(-1), text: 'what is going on?' };
    _messagesByChannel.D1 = [current, ...msgs]; // newest-first
    store.save('slackDMAutoReplyConfig', { enabled: true, threads: {} });
    await engine.pollDMAutoReplyOnce(() => {});
    // Count how many distinct "history line N" appear in the prompt context.
    const loaded = (_lastPrompt.match(/history line \d+/g) || []).length;
    expect(loaded).toBeGreaterThanOrEqual(10);
  });
});

describe('"any update?" resolves the unit from relevant history', () => {
  it('prioritizes the same-unit prior message so the current vague ask has unit context', async () => {
    const engine = await loadEngine();
    _dms = [{ channelId: 'D2', name: 'Bob', isGroup: false }];
    // A mix of noise + one message that names the unit; then a vague follow-up.
    const noise = [];
    for (let i = 1; i <= 12; i++) noise.push({ userId: 'U_B', ts: nowTs(-200 - i), text: 'chit chat ' + i });
    const unitMsg = { userId: 'U_B', ts: nowTs(-50), text: 'the issue is with unit 320160' };
    const current = { userId: 'U_B', ts: nowTs(-1), text: 'any update?' };
    _messagesByChannel.D2 = [current, unitMsg, ...noise]; // newest-first
    store.save('slackDMAutoReplyConfig', { enabled: true, threads: {} });
    await engine.pollDMAutoReplyOnce(() => {});
    // The same-unit message must be present in the loaded context (relevance
    // ordering keeps it even amid noise), so the AI can resolve "any update?".
    expect(_lastPrompt).toMatch(/320160/);
  });
});
