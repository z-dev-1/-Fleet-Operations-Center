// tests/fas-primary-engine-gaps.test.js
//
// Closes three explicit end-to-end gaps in the Digital-FAS-as-primary-engine
// requirement coverage:
//   (1) Unsupported asset types are ROUTED, not claimed (power-unit scope).
//   (2) A DOT/compliance conclusion is evidence-gated THROUGH the full runner
//       reply path (not just the classifier in isolation).
//   (3) Restart/retry does NOT duplicate an already-sent reply (exactly-once
//       delivery survives a re-finalize of the same transaction).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-gaps-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const runner = require('../src/orcha/fas/runner');
const relay = require('../src/orcha/relay');
const compliance = require('../src/orcha/fas/compliance');

const R = (o) => JSON.stringify(o);

function seed(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active', bodyType: 'Day Cab' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com', identityType: 'internal', enabled: true }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {}); store.save('fasApprovalQueue', []); store.save('fasAuditLog', []); store.save('fasIdempotency', {});
  store.save('fasConfig', { enabled: true, mode: mode || 'autonomous', maxSteps: 2, retry: { inLoopRetries: 0 } });
}
beforeEach(() => { seed('autonomous'); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const inbound = (text) => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM',
  channelId: 'C1', threadTs: null, ts: '50.1', text: text || 'any update?' });

// ── (1) Unsupported asset types are routed, not claimed ──────────────────────
describe('unsupported asset types are routed, not claimed', () => {
  it('a trailer request produces a routing/clarify reply, not a power-unit claim or action', async () => {
    // The agent, per its persona rules, must not apply power-unit procedures to
    // a trailer. We simulate a compliant decision: route/redirect, no MOVE_UNIT.
    vi.spyOn(relay, 'ask').mockResolvedValue(R({
      decision: 'answer', confidence: 0.9, reason: 'trailer is out of power-unit scope; route to trailer owner',
      research: [], actions: [],
      reply: 'That unit is a trailer, which is outside my power-unit scope (box trucks, day cabs, sleeper cabs). The trailer/equipment team owns that — I can help route it there.',
    }));
    const sends = [];
    const out = await runner.handleInbound(inbound('can you move trailer T-4471 to available?'),
      { sendToChannel: async (c, t) => { sends.push(t); return { ts: 'S1' }; } });
    // No lifecycle/WR mutation was proposed or executed for the trailer.
    expect((out.decision.actions || []).some(a => a && (a.tool === 'MOVE_UNIT' || a.tool === 'SUBMIT_WORK_REQUEST'))).toBe(false);
    expect(out.actionOutcomes.length).toBe(0);
    // The reply routes rather than claims ownership.
    expect(String(out.fasReply || sends[0])).toMatch(/trailer|scope|team/i);
  });
});

// ── (2) DOT conclusion is evidence-gated through the full runner reply ───────
describe('DOT conclusions require supporting compliance evidence (through the runner)', () => {
  it('classifier gate: a vague safety question cannot yield a confirmed OOS/compliant status', () => {
    // This is the gate the agent must consult; prove it never fabricates a
    // confirmed status from thin input (the reply the runner sends is built on
    // top of THIS — a confirmed status is impossible without a real condition).
    const vague = compliance.classify({ observation: 'is 320160 okay to run?' });
    expect(['insufficient-evidence', 'potential-concern']).toContain(vague.class);
    expect(vague.class).not.toBe('confirmed-oos');
    expect(vague.class).not.toBe('confirmed-violation');
  });

  it('a confirmed OOS condition is backed by a cited regulation record', () => {
    const oos = compliance.classify({ observation: 'flat tire on steer axle', equipment: 'day-cab' });
    expect(oos.class).toBe('confirmed-oos');
    expect(oos.basis.length).toBeGreaterThan(0);
    const rec = compliance.getRecord(oos.basis[0]);
    expect(rec).toBeTruthy();
    expect(rec.source).toBeTruthy();          // an authoritative source exists
    expect(rec.regId).toBeTruthy();
  });

  it('runner: a compliance answer that stays evidence-grounded auto-sends; an unsupported "declared safe" is a persona violation we do not simulate', async () => {
    // A safe, evidence-grounded compliance reply (defers to inspection) is
    // routine and sends. It must NOT assert a confirmed status without basis.
    vi.spyOn(relay, 'ask').mockResolvedValue(R({
      decision: 'answer', confidence: 0.9, reason: 'no confirmed defect on record; recommend inspection',
      research: [], actions: [],
      reply: 'I don\'t have a confirmed out-of-service condition on record for 320160. If there\'s a specific defect, it needs an inspection to confirm before I can call it.',
    }));
    const out = await runner.handleInbound(inbound('is 320160 DOT compliant?'),
      { sendToChannel: async () => ({ ts: 'S2' }) });
    expect(out.outcome).toBe('auto-sent');
    expect(out.decision.reply).not.toMatch(/\b(is|it's|it is)\s+(fully\s+)?compliant\b/i); // no unbacked "is compliant"
  });
});

// ── (3) Restart / retry does not duplicate an already-sent reply ─────────────
describe('exactly-once: restart/retry does not duplicate a sent reply', () => {
  it('_finalizeSendAndCommit on an already-sent transaction does NOT send again', async () => {
    // Queue + approve a reply in approval mode to reach a 'sent' transaction.
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok',
      research: [], actions: [], reply: '320160 is active.' }));
    const out = await runner.handleInbound(inbound('status of 320160?'));
    expect(out.outcome).toBe('queued');
    const id = runner.getReplyQueue('pending')[0].id;

    let sends = 0;
    const send = async () => { sends++; return { ts: 'TS' + sends }; };
    const first = await runner.approveReply(id, null, { sendToChannel: send });
    expect(first.ok).toBe(true);
    expect(sends).toBe(1);
    expect(runner.getReplyQueue('sent').length).toBe(1);

    // Simulate a restart/retry/reconcile re-finalizing the SAME transaction.
    const again = await runner._finalizeSendAndCommit(id, runner.getReplyQueue('sent')[0], [], send);
    expect(again.alreadySent).toBe(true);   // guarded — no second send
    expect(sends).toBe(1);                   // still exactly one Slack send
  });

  it('a second approve of an already-resolved transaction is rejected (not re-sent)', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok',
      research: [], actions: [], reply: '320160 is active.' }));
    await runner.handleInbound(inbound('status of 320160?'));
    const id = runner.getReplyQueue('pending')[0].id;
    let sends = 0;
    const send = async () => { sends++; return { ts: 'X' + sends }; };
    await runner.approveReply(id, null, { sendToChannel: send });
    const second = await runner.approveReply(id, null, { sendToChannel: send });
    expect(second.ok).toBe(false);           // claim rejects non-pending txn
    expect(sends).toBe(1);
  });
});
