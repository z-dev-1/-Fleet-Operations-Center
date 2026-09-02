import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-replyapprove-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const runner = require('../src/orcha/fas/runner');
const relay = require('../src/orcha/relay');

function seed(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('fasIdempotency', {});
  store.save('fasConfig', { enabled: true, mode, maxSteps: 2, retry: { inLoopRetries: 0 } });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
const inbound = () => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM', channelId: 'C1', threadTs: null, ts: '100.1', text: 'update on 320160?' });

describe('FAS reply approval (approval mode)', () => {
  it('queues a reply, then APPROVE sends it via the real send path', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: '320160 is active, nothing open.' }));
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('queued');

    const queued = runner.getReplyQueue('pending');
    expect(queued.length).toBe(1);
    expect(queued[0].proposedReply).toMatch(/320160 is active/);

    // Approve with an injected send boundary.
    const sent = [];
    const res = await runner.approveReply(queued[0].id, null, {
      sendToChannel: async (channelId, text, threadTs) => { sent.push({ channelId, text, threadTs }); return { ts: '999.9' }; },
    });
    expect(res.ok).toBe(true);
    expect(res.sent.ts).toBe('999.9');
    expect(sent[0].channelId).toBe('C1');
    expect(sent[0].text).toMatch(/<@U_INT>.*320160 is active/);

    // Queue item now resolved with real send evidence.
    const after = runner.getReplyQueue();
    expect(after[0].status).toBe('approved-sent');
    expect(after[0].sentTs).toBe('999.9');
  });

  it('REJECT sends nothing and marks the item rejected', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: 'proposed' }));
    await runner.handleInbound(inbound());
    const q = runner.getReplyQueue('pending');
    const res = runner.rejectReply(q[0].id);
    expect(res.ok).toBe(true);
    expect(runner.getReplyQueue('rejected').length).toBe(1);
    expect(runner.getReplyQueue('pending').length).toBe(0);
  });

  it('approve fails safe if send returns no ts (nothing marked sent)', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: 'x' }));
    await runner.handleInbound(inbound());
    const q = runner.getReplyQueue('pending');
    const res = await runner.approveReply(q[0].id, null, { sendToChannel: async () => ({}) });
    expect(res.ok).toBe(false);
    // still pending — not falsely marked sent
    expect(runner.getReplyQueue('pending').length).toBe(1);
  });
});
