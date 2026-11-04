import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-core-phase-c-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const aiCore = require('../src/ai/core');
const trace = require('../src/ai/trace');
const fasConfig = require('../src/orcha/fas/config');
const fasRunner = require('../src/orcha/fas/runner');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '321060', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Z', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('aiTraceLog', []);
  store.save('fasInboundClaims', {});
  fasConfig.save({ enabled: false, mode: 'shadow' });
}

beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('AI Core Phase C — handleInbound accepts the NATIVE runner shape (behavior-identical seam)', () => {
  it('passes a native runner input straight through and returns the runner contract + requestId', async () => {
    // Native FAS-runner input shape (exactly what the Slack call sites pass).
    const input = {
      engine: 'dm', slackId: 'U_INT', senderName: 'Z', channelName: 'Z',
      channelId: 'D1', threadTs: null, ts: '100.1', text: 'any update on 321060?',
      isGroup: false, conversation: [], attachments: '', files: [], isSelf: false,
    };
    const res = await aiCore.handleInbound(input, {});
    // Same contract the runner returns when FAS is disabled.
    expect(res.mode).toBe('disabled');
    expect(res.letLegacyReply).toBe(true);
    // Plus the AiCore trace id.
    expect(res.requestId).toBeTruthy();
    const rec = trace.recent(1)[0];
    expect(rec.requestId).toBe(res.requestId);
    expect(rec.source).toBe('slack_dm');     // derived from engine
  });

  it('produces the SAME result the FAS runner would for the same native input', async () => {
    const input = {
      engine: 'dm', slackId: 'U_INT', senderName: 'Z', channelName: 'Z',
      channelId: 'D2', threadTs: null, ts: '200.2', text: 'hello',
      isGroup: false, conversation: [], attachments: '', files: [], isSelf: false,
    };
    const direct = await fasRunner.handleInbound({ ...input, ts: '200.2a' }, {});
    const viaCore = await aiCore.handleInbound({ ...input, ts: '200.2b' }, {});
    // Core adds requestId but the runner-owned fields match.
    expect(viaCore.mode).toBe(direct.mode);
    expect(viaCore.letLegacyReply).toBe(direct.letLegacyReply);
    expect(viaCore.outcome).toBe(direct.outcome);
  });

  it('derives a channel source for a group/channel engine input', async () => {
    const input = {
      engine: 'channel', slackId: 'U_INT', senderName: 'Z', channelName: 'ops',
      channelId: 'C1', threadTs: null, ts: '300.3', text: 'status?', isGroup: true,
      conversation: [], attachments: '', files: [], isSelf: false,
    };
    const res = await aiCore.handleInbound(input, {});
    expect(res.requestId).toBeTruthy();
    expect(trace.recent(1)[0].source).toBe('slack_channel');
  });

  it('derives a self_dm source when isSelf is set', async () => {
    const input = {
      engine: 'dm', slackId: 'U_INT', senderName: 'Z', channelName: 'Z',
      channelId: 'D3', threadTs: null, ts: '400.4', text: 'note to self', isGroup: false,
      conversation: [], attachments: '', files: [], isSelf: true,
    };
    const res = await aiCore.handleInbound(input, {});
    expect(res.requestId).toBeTruthy();
    expect(trace.recent(1)[0].source).toBe('self_dm');
  });
});
