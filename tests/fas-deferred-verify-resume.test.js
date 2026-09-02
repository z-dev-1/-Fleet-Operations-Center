import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-defver-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const runner = require('../src/orcha/fas/runner');
const executor = require('../src/orcha/fas/executor');
const relay = require('../src/orcha/relay');

const AAP = 'https://aap-na.corp.amazon.com/v2/asset/x';
function seed(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', assetUrl: AAP },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {}); store.save('fasApprovalQueue', []); store.save('fasAuditLog', []); store.save('fasIdempotency', {});
  store.save('fasConfig', { enabled: true, mode: mode || 'approval', maxSteps: 2, retry: { inLoopRetries: 0 } });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
const inbound = () => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM', channelId: 'C1', threadTs: null, ts: '5.1', text: 'move 320160 to Active' });

async function queueAndApproveMoveUnit(sends) {
  const sl = require('../src/scrapers/setLifecycle');
  vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
  vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'act', confidence: 0.95, reason: 'move it',
    research: [], actions: [{ tool: 'MOVE_UNIT', args: { unit: '320160', state: 'Active', assetUrl: AAP } }],
    reply: '320160 has been moved to Active.' }));
  await runner.handleInbound(inbound());
  const id = runner.getReplyQueue('pending')[0].id;
  const res = await runner.approveReply(id, null, { sendToChannel: async (c, t) => { sends.push(t); return { ts: 'S' + sends.length }; } });
  return { id, res };
}

describe('Part 7: deferred lifecycle verification resumes the SAME transaction', () => {
  it('waits for verification (no send), then sync-confirm resumes + sends truthful reply ONCE', async () => {
    seed('approval');
    const sends = [];
    const { id, res } = await queueAndApproveMoveUnit(sends);
    expect(res.deferred).toBe(true);
    expect(sends.length).toBe(0);
    expect(runner.getReplyQueue('waiting-verification').length).toBe(1);

    // Fleet sync now shows the unit is Active -> reconcile marks the MOVE_UNIT
    // idempotency entry done.
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [{ equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active', assetUrl: AAP }] });
    executor.reconcileVerifyingLifecycle();

    // Resume the waiting transaction with an injected send.
    const r1 = await runner.resumeVerifiedTransactions({ sendToChannel: async (c, t) => { sends.push(t); return { ts: 'FINAL' }; } });
    expect(r1.resumed).toBe(1);
    expect(sends.length).toBe(1);                       // sent exactly once
    expect(runner.getReplyQueue('sent').length).toBe(1);

    // A second resume must NOT send again (idempotent).
    const r2 = await runner.resumeVerifiedTransactions({ sendToChannel: async () => { sends.push('DUP'); return { ts: 'X' }; } });
    expect(r2.resumed).toBe(0);
    expect(sends.length).toBe(1);
  });

  it('if sync DISAGREES, the transaction fails + operator review; no false success sent', async () => {
    seed('approval');
    const sends = [];
    await queueAndApproveMoveUnit(sends);
    expect(runner.getReplyQueue('waiting-verification').length).toBe(1);

    // Fleet sync shows the unit is STILL Unavailable -> reconcile marks failed.
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [{ equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', assetUrl: AAP }] });
    executor.reconcileVerifyingLifecycle();

    const r = await runner.resumeVerifiedTransactions({ sendToChannel: async (c, t) => { sends.push(t); return { ts: 'F' }; } });
    expect(r.failed).toBe(1);
    expect(sends.length).toBe(0);                        // NO false "has been moved"
    const failed = runner.getReplyQueue('failed');
    expect(failed.length).toBe(1);
    expect(failed[0].needsOperatorReview).toBe(true);
  });

  it('still pending (sync has not run) keeps the transaction waiting', async () => {
    seed('approval');
    const sends = [];
    await queueAndApproveMoveUnit(sends);
    // No reconcile -> ledger still verifying.
    const r = await runner.resumeVerifiedTransactions({ sendToChannel: async () => { sends.push('x'); return { ts: 'x' }; } });
    expect(r.resumed).toBe(0);
    expect(r.failed).toBe(0);
    expect(sends.length).toBe(0);
    expect(runner.getReplyQueue('waiting-verification').length).toBe(1);
  });
});
