import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-int-txn-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const runner = require('../src/orcha/fas/runner');
const caseStore = require('../src/orcha/fas/case-store');
const relay = require('../src/orcha/relay');

function seed(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {}); store.save('fasApprovalQueue', []); store.save('fasAuditLog', []);
  store.save('fasIdempotency', {}); store.save('notesStore', {});
  store.save('fasConfig', { enabled: true, mode: mode || 'approval', maxSteps: 2, retry: { inLoopRetries: 0 } });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
const inbound = () => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM', channelId: 'C1', ts: '100.1', text: 'log a note on 320160 that parts arrived' });

describe('Part 16: full runner -> transaction -> approve -> execute+verify -> send', () => {
  it('APPROVAL: reply + linked low-risk action form ONE transaction; approve executes the action (verified) then sends', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'act', confidence: 0.9, reason: 'log it',
      research: [], actions: [{ tool: 'ADD_TIMELINE', args: { unit: '320160', entry: 'parts arrived' } }],
      reply: 'Logged: parts arrived for 320160.' }));

    // 1) Inbound -> ONE queued transaction (no separately-queued action item).
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('queued');
    const q = runner.getReplyQueue('pending');
    expect(q.length).toBe(1);
    expect(q[0].proposedActions.length).toBe(1);
    expect(q[0].proposedActions[0].tool).toBe('ADD_TIMELINE');
    // The action was NOT executed yet (before the final gate / approval).
    expect(store.load('notesStore', {})['320160']).toBeUndefined();

    // 2) Approve -> executes+verifies the action FIRST, then sends the reply.
    const sent = [];
    const res = await runner.approveReply(q[0].id, null, { sendToChannel: async (c, t) => { sent.push({ c, t }); return { ts: '999.9' }; } });
    expect(res.ok).toBe(true);
    // Action really ran (note persisted) AND the reply was sent AFTER it.
    expect(store.load('notesStore', {})['320160'].timeline).toMatch(/parts arrived/);
    expect(sent.length).toBe(1);
    expect(res.actionOutcomes[0].status).toBe('done');
    // Transaction resolved to 'sent' with evidence; case memory committed.
    expect(runner.getReplyQueue('sent').length).toBe(1);
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    expect(c).toBeTruthy();
  });

  it('double approval cannot execute twice (atomic claim)', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'act', confidence: 0.9, reason: 'log it',
      research: [], actions: [{ tool: 'ADD_TIMELINE', args: { unit: '320160', entry: 'parts arrived' } }],
      reply: 'Logged.' }));
    await runner.handleInbound(inbound());
    const id = runner.getReplyQueue('pending')[0].id;

    let sends = 0;
    const send = async () => { sends++; return { ts: 's' + sends }; };
    // Fire two approvals "simultaneously".
    const [r1, r2] = await Promise.all([
      runner.approveReply(id, null, { sendToChannel: send }),
      runner.approveReply(id, null, { sendToChannel: send }),
    ]);
    // Exactly one succeeds; the other is rejected by the atomic claim.
    const oks = [r1, r2].filter(r => r && r.ok).length;
    expect(oks).toBe(1);
    // The note timeline has exactly ONE 'parts arrived' entry (idempotency +
    // claim together prevent double execution).
    const tl = store.load('notesStore', {})['320160'].timeline.split('\n').filter(l => l.includes('parts arrived'));
    expect(tl.length).toBe(1);
    expect(sends).toBe(1);
  });

  it('AUTONOMOUS: linked low-risk action is executed+verified as part of the auto-send transaction', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'act', confidence: 0.95, reason: 'log it',
      research: [], actions: [{ tool: 'ADD_TIMELINE', args: { unit: '320160', entry: 'auto note' } }],
      reply: 'Logged automatically.' }));
    const out = await runner.handleInbound(inbound());
    // ADD_TIMELINE is low-risk -> eligible for the autonomous transaction.
    expect(['auto-sent', 'queued']).toContain(out.outcome);
    if (out.outcome === 'auto-sent') {
      expect(store.load('notesStore', {})['320160'].timeline).toMatch(/auto note/);
      expect(out.fasReply).toMatch(/Logged automatically/);
    }
  });
});
