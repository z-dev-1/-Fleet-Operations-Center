import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-runner-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const runner = require('../src/orcha/fas/runner');
const relay = require('../src/orcha/relay');

function seed(mode, enabled = true) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active', vendor: 'Amerit' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('fasConfig', { enabled, mode, maxSteps: 2, maxRuntimeMs: 15000, retry: { inLoopRetries: 0 },
    approvedAutomaticActions: [] });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
const answer = (reply, conf = 0.9) => R({ decision: 'answer', confidence: conf, reason: 'ok', research: [], actions: [], reply, followUp: { required: false } });

const inbound = () => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM', channelId: 'C1', ts: '100.1', text: 'any update on 320160?', conversation: [], actualReply: 'legacy said something' });

describe('FAS unified runner — mode routing (all three differ)', () => {
  it('DISABLED: legacy replies, FAS does nothing', async () => {
    seed('shadow', false); // disabled
    const spy = vi.spyOn(relay, 'ask');
    const out = await runner.handleInbound(inbound());
    expect(out.mode).toBe('disabled');
    expect(out.letLegacyReply).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(store.load('fasApprovalQueue', []).length).toBe(0);
  });

  it('SHADOW: legacy replies; FAS records a comparison; queues nothing', async () => {
    seed('shadow');
    vi.spyOn(relay, 'ask').mockResolvedValue(answer('320160 is active, nothing open.'));
    const out = await runner.handleInbound(inbound());
    expect(out.mode).toBe('shadow');
    expect(out.letLegacyReply).toBe(true);
    expect(out.fasReply).toBeUndefined();
    // audit recorded with divergence vs the legacy actualReply
    const audit = store.load('fasAuditLog', []);
    expect(audit[0].mode).toBe('shadow');
    expect(typeof audit[0].divergence).toBe('number');
    expect(store.load('fasApprovalQueue', []).length).toBe(0);
  });

  it('APPROVAL: legacy silent; proposed reply queued (nothing sent)', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(answer('Proposed: 320160 is active.'));
    const out = await runner.handleInbound(inbound());
    expect(out.mode).toBe('approval');
    expect(out.letLegacyReply).toBe(false);
    expect(out.fasReply).toBeUndefined(); // nothing auto-sent
    const q = store.load('fasApprovalQueue', []);
    const reply = q.find(x => x.kind === 'reply');
    expect(reply).toBeTruthy();
    expect(reply.proposedReply).toMatch(/320160 is active/);
    expect(reply.request).toMatch(/update on 320160/);
    expect(reply.status).toBe('pending');
  });

  it('AUTONOMOUS: routine confident answer is auto-sent; legacy silent', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(answer('320160 is active, no open work orders.', 0.9));
    const out = await runner.handleInbound(inbound());
    expect(out.mode).toBe('autonomous');
    expect(out.letLegacyReply).toBe(false);
    expect(out.fasReply).toMatch(/320160 is active/);
    expect(out.outcome).toBe('auto-sent');
  });

  it('AUTONOMOUS: low confidence is queued, not sent', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(answer('not sure...', 0.4));
    const out = await runner.handleInbound(inbound());
    expect(out.letLegacyReply).toBe(false);
    expect(out.fasReply).toBeUndefined();
    expect(out.outcome).toBe('queued');
  });

  it('AUTONOMOUS: clarify decision is queued, not auto-sent', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'clarify', confidence: 0.9, reason: 'ambiguous', research: [], actions: [], reply: 'Which 320160 — tractor or trailer?' }));
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('queued');
    expect(out.fasReply).toBeUndefined();
  });

  it('AUTONOMOUS: SEND_SLACK queues when NOT whitelisted (safe default)', async () => {
    seed('autonomous');   // approvedAutomaticActions: [] — not whitelisted
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.95, reason: 'ok', research: [],
      actions: [{ tool: 'SEND_SLACK', args: { text: 'hi' } }], reply: 'done' }));
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('queued');
    expect(out.fasReply).toBeUndefined();
  });

  // The routeAction gate is the authoritative place the auto-send decision is
  // made; prove it directly (executor unit) rather than through the whole
  // runner dispatch (which has its own reply-vs-send routing).
  it('AUTONOMOUS + whitelisted: routeAction AUTO-EXECUTES SEND_SLACK_MESSAGE (the requested behavior)', async () => {
    seed('autonomous');
    config.save({ enabled: true, mode: 'autonomous', approvedAutomaticActions: ['SEND_SLACK_MESSAGE'] });
    const executor = require('../src/orcha/fas/executor');
    const slackSend = require('../src/scrapers/slack_send');
    const sendSpy = vi.spyOn(slackSend, 'sendToChannel').mockResolvedValue({ ts: '111.222' });
    // Internal sender profile (authorized for follow_up / in scope).
    const profile = { slackId: 'U_INT', type: 'internal', operators: ['*'], domiciles: ['*'], permittedRequestTypes: ['follow_up'] };
    const res = await executor.routeAction('SEND_SLACK_MESSAGE', { channelId: 'C1', message: 'hi' }, { profile });
    expect(res.outcome).toBe('executed');          // NOT 'queued'
    expect(sendSpy).toHaveBeenCalled();
    expect(store.load('fasApprovalQueue', []).filter(x => x.status === 'pending').length).toBe(0);
  });

  it('AUTONOMOUS + whitelisted: MOVE_UNIT still QUEUES (mutations never auto-run)', async () => {
    seed('autonomous');
    // Even if someone tries to whitelist a mutation, config strips it — and
    // routeAction would queue it regardless. Prove the safety invariant holds.
    config.save({ enabled: true, mode: 'autonomous', approvedAutomaticActions: ['SEND_SLACK_MESSAGE', 'MOVE_UNIT'] });
    const executor = require('../src/orcha/fas/executor');
    const profile = { slackId: 'U_INT', type: 'internal', operators: ['*'], domiciles: ['*'], permittedRequestTypes: ['lifecycle_change'] };
    const res = await executor.routeAction('MOVE_UNIT', { unit: '320160', state: 'Active', reason: 'x' }, { profile });
    expect(res.outcome).toBe('queued');            // mutation always queues
  });

  it('FAIL-SAFE: AI unavailable never auto-sends and never marks handled', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockRejectedValue(new Error('relay down'));
    const out = await runner.handleInbound(inbound());
    expect(out.fasReply).toBeUndefined();       // never an (empty) auto-send
    expect(out.outcome).toBe('manual-review');  // visible review, not silent
  });
});

describe('Part 6: AI failure handling', () => {
  it('AUTONOMOUS: unparseable/empty AI -> manual-review item with the original request + reason (no empty send)', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue('not json at all');
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('manual-review');
    expect(out.fasReply).toBeUndefined();
    expect(out.failReason).toBeTruthy();
    const q = store.load('fasApprovalQueue', []);
    const item = q.find(x => x.kind === 'manual-review');
    expect(item).toBeTruthy();
    expect(item.request).toMatch(/update on 320160/); // original request preserved
    expect(item.proposedReply).toBe('');              // nothing to send
    expect(item.ts).toBe('100.1');                    // original Slack ref preserved
  });

  it('APPROVAL: empty reply -> manual-review, not a queued empty proposal', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'x', research: [], actions: [], reply: '   ' }));
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('manual-review');
    const q = store.load('fasApprovalQueue', []);
    expect(q.some(x => x.kind === 'manual-review')).toBe(true);
    expect(q.some(x => x.kind === 'reply' && x.proposedReply.trim() === '')).toBe(false);
  });

  it('SHADOW: AI failure lets the legacy path proceed (no manual-review queue)', async () => {
    seed('shadow');
    vi.spyOn(relay, 'ask').mockRejectedValue(new Error('timeout'));
    const out = await runner.handleInbound(inbound());
    expect(out.letLegacyReply).toBe(true);
    expect(out.outcome).toBe('ai-failed-shadow');
    expect(store.load('fasApprovalQueue', []).length).toBe(0);
  });
});
