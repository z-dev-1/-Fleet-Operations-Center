import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-autosend-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const runner = require('../src/orcha/fas/runner');
const relay = require('../src/orcha/relay');

// A routine, high-confidence, action-free answer — the ONLY class the runner
// will auto-send in autonomous mode.
const ROUTINE = JSON.stringify({
  decision: 'answer', confidence: 0.95, reason: 'routine status answer',
  research: [], actions: [],
  reply: 'Unit 320160 is currently Active at ABE40.',
});

function seedAutonomous() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active', assetUrl: 'https://aap/x' },
  ] });
  // Internal/trusted sender so scope never blocks the routine answer.
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com',
    identityType: 'internal', enabled: true }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {}); store.save('fasApprovalQueue', []); store.save('fasAuditLog', []); store.save('fasIdempotency', {});
  store.save('fasConfig', { enabled: true, mode: 'autonomous', maxSteps: 2, retry: { inLoopRetries: 0 } });
}

afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const inbound = () => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM',
  channelId: 'C1', threadTs: null, ts: '9.1', text: 'is 320160 active?' });

describe('Part 8: autonomous Slack delivery safety (case memory only after confirmed ts)', () => {
  it('confirmed send -> auto-sent + case memory committed once', async () => {
    seedAutonomous();
    vi.spyOn(relay, 'ask').mockResolvedValue(ROUTINE);
    const sends = [];
    const res = await runner.handleInbound(inbound(), {
      sendToChannel: async (c, t) => { sends.push(t); return { ts: 'S1' }; },
    });
    expect(res.outcome).toBe('auto-sent');
    expect(res.sent && res.sent.ts).toBe('S1');
    expect(sends.length).toBe(1);                       // sent exactly once
    // Case memory committed AFTER the confirmed ts (keyed by unit or sender).
    const allCases = store.load('fasCases', {});
    expect(Object.keys(allCases).length).toBeGreaterThan(0);
    // Nothing left dangling in the approval queue.
    expect(runner.getReplyQueue('pending').length).toBe(0);
  });

  it('send THROWS -> auto-send-failed, NO case memory, recoverable review item', async () => {
    seedAutonomous();
    vi.spyOn(relay, 'ask').mockResolvedValue(ROUTINE);
    const res = await runner.handleInbound(inbound(), {
      sendToChannel: async () => { throw new Error('slack 503'); },
    });
    expect(res.outcome).toBe('auto-send-failed');
    // Case memory MUST NOT be committed on a failed delivery.
    expect(Object.keys(store.load('fasCases', {})).length).toBe(0);
    // A recoverable review item is queued so the operator sees it / retry.
    expect(res.approvalId).toBeTruthy();
    const pending = runner.getReplyQueue('pending');
    expect(pending.length).toBe(1);
    expect(String(pending[0].failReason || '')).toMatch(/delivery failed/i);
  });

  it('send returns NO ts -> treated as failure: no case memory, queued', async () => {
    seedAutonomous();
    vi.spyOn(relay, 'ask').mockResolvedValue(ROUTINE);
    const res = await runner.handleInbound(inbound(), {
      sendToChannel: async () => ({}),                  // no ts
    });
    expect(res.outcome).toBe('auto-send-failed');
    expect(Object.keys(store.load('fasCases', {})).length).toBe(0);
    expect(runner.getReplyQueue('pending').length).toBe(1);
  });

  it('no send path injected -> returns fasReply + _pendingCaseCommit, commits nothing until confirmAutonomousSend', async () => {
    seedAutonomous();
    vi.spyOn(relay, 'ask').mockResolvedValue(ROUTINE);
    const res = await runner.handleInbound(inbound());  // no deps
    expect(res.outcome).toBe('auto-sent');
    expect(res._pendingCaseCommit).toBe(true);
    expect(typeof res.fasReply).toBe('string');
    // No case memory yet — caller has not confirmed delivery.
    expect(Object.keys(store.load('fasCases', {})).length).toBe(0);
    // Caller confirms delivery -> commit exactly once.
    const ok = runner.confirmAutonomousSend(inbound(), res.decision);
    expect(ok.ok).toBe(true);
    expect(Object.keys(store.load('fasCases', {})).length).toBeGreaterThan(0);
  });
});
