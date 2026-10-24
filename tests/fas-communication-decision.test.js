import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-comm-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const runner = require('../src/orcha/fas/runner');
const agent = require('../src/orcha/fas/agent');
const schemas = require('../src/ai/schemas');
const relay = require('../src/orcha/relay');

function seed(mode, enabled = true) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active', vendor: 'Amerit' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com', identityType: 'internal' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('fasConfig', { enabled, mode, maxSteps: 2, maxRuntimeMs: 15000, retry: { inLoopRetries: 0 },
    reviewReplies: false, approvedAutomaticActions: [] });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
// A full terminal answer with optional communication fields merged in.
const decide = (extra) => R(Object.assign({ decision: 'answer', confidence: 0.95, reason: 'ok', research: [], actions: [], reply: 'ack', followUp: { required: false } }, extra || {}));

const dm = (over) => Object.assign({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM', channelId: 'C1', ts: '100.1', text: 'any update on 320160?', conversation: [], isGroup: false }, over || {});
const channel = (over) => Object.assign({ engine: 'channel', slackId: 'U_INT', senderName: 'Zila', channelName: 'ops', channelId: 'C9', ts: '200.2', text: 'good morning everyone', conversation: [], isGroup: true }, over || {});

// ── UNIT: agent._normalizeCommunication ─────────────────────────────────────
describe('agent._normalizeCommunication — defaults + consistency', () => {
  it('DM with no fields → shouldReply true, placement dm', () => {
    const c = agent._normalizeCommunication({ decision: 'answer', reply: 'x' }, false, false);
    expect(c.shouldReply).toBe(true);
    expect(c.replyPlacement).toBe('dm');
    expect(c.reasonCode).toBe('DIRECT_QUESTION');
  });
  it('group with no fields → placement thread (quiet default)', () => {
    const c = agent._normalizeCommunication({ decision: 'answer', reply: 'x' }, true, false);
    expect(c.shouldReply).toBe(true);
    expect(c.replyPlacement).toBe('thread');
  });
  it('shouldReply false forces placement none', () => {
    const c = agent._normalizeCommunication({ shouldReply: false, replyPlacement: 'thread' }, true, false);
    expect(c.shouldReply).toBe(false);
    expect(c.replyPlacement).toBe('none');
  });
  it('a silent reasonCode forces silence regardless of other fields', () => {
    const c = agent._normalizeCommunication({ shouldReply: true, replyPlacement: 'top_level', reasonCode: 'GENERAL_CHANNEL_CHATTER' }, true, false);
    expect(c.shouldReply).toBe(false);
    expect(c.replyPlacement).toBe('none');
  });
  it('placement none implies shouldReply false', () => {
    const c = agent._normalizeCommunication({ replyPlacement: 'none' }, true, false);
    expect(c.shouldReply).toBe(false);
  });
  it('explicit top_level honored for a channel-wide correction', () => {
    const c = agent._normalizeCommunication({ shouldReply: true, replyPlacement: 'top_level', reasonCode: 'CORRECT_CRITICAL_INFO' }, true, false);
    expect(c.replyPlacement).toBe('top_level');
    expect(c.reasonCode).toBe('CORRECT_CRITICAL_INFO');
  });
  it('invalid enum values fall back to safe defaults', () => {
    const c = agent._normalizeCommunication({ shouldReply: true, replyPlacement: 'sideways', reasonCode: 'NONSENSE', audienceSensitivity: 'foo' }, false, false);
    expect(agent.REPLY_PLACEMENTS).toContain(c.replyPlacement);
    expect(c.audienceSensitivity).toBe('unknown');
  });
});

// ── UNIT: schema validator treats new fields as optional + enum-checked ──────
describe('ai/schemas — communication fields are optional + validated', () => {
  it('a decision WITHOUT the new fields still validates (backward compatible)', () => {
    const v = schemas.validateDecision({ decision: 'answer', reply: 'hello' });
    expect(v.ok).toBe(true);
  });
  it('valid enum values pass', () => {
    const v = schemas.validateDecision({ decision: 'answer', reply: 'hi', shouldReply: true, replyPlacement: 'thread', audienceSensitivity: 'external_partner', reasonCode: 'DIRECT_MENTION' });
    expect(v.ok).toBe(true);
  });
  it('bad replyPlacement fails validation but repairs by dropping it', () => {
    const v = schemas.validateDecision({ decision: 'answer', reply: 'hi', replyPlacement: 'nope' });
    expect(v.ok).toBe(false);
    const r = schemas.validateOrRepair({ decision: 'answer', reply: 'hi', replyPlacement: 'nope' });
    expect(r.ok).toBe(true);
    expect(r.decision.replyPlacement).toBeUndefined();
  });
  it('inconsistent shouldReply=false + placement!=none is flagged, repaired to none', () => {
    const v = schemas.validateDecision({ decision: 'answer', reply: 'hi', shouldReply: false, replyPlacement: 'thread' });
    expect(v.ok).toBe(false);
    const r = schemas.validateOrRepair({ decision: 'answer', reply: 'hi', shouldReply: false, replyPlacement: 'thread' });
    expect(r.ok).toBe(true);
    expect(r.decision.replyPlacement).toBe('none');
  });
});

// ── INTEGRATION: runner silence gate + placement threadTs ────────────────────
describe('FAS runner — silence gate (spec #4/#5/#22/#23)', () => {
  it('AUTONOMOUS: shouldReply=false → outcome no-reply, nothing sent, legacy suppressed', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: false, reasonCode: 'GENERAL_CHANNEL_CHATTER', reply: 'ack' }));
    const out = await runner.handleInbound(channel());
    expect(out.outcome).toBe('no-reply');
    expect(out.letLegacyReply).toBe(false);   // legacy must NOT reply either
    expect(out.fasReply).toBeUndefined();
    // nothing queued, nothing sent
    expect(store.load('fasApprovalQueue', []).length).toBe(0);
  });

  it('APPROVAL: silent decision → no-reply, legacy suppressed, nothing queued', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: false, reasonCode: 'DIRECTED_TO_OTHER_PERSON', reply: 'ack' }));
    const out = await runner.handleInbound(channel({ text: 'John can you grab that report?' }));
    expect(out.outcome).toBe('no-reply');
    expect(out.letLegacyReply).toBe(false);
    expect(store.load('fasApprovalQueue', []).length).toBe(0);
  });

  it('SHADOW: silence field recorded but legacy still owns the cycle', async () => {
    seed('shadow');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: false, reasonCode: 'NO_RESPONSE_NEEDED', reply: 'ack' }));
    const out = await runner.handleInbound(channel({ actualReply: 'legacy chatter reply' }));
    // shadow never suppresses legacy from a silence decision — it's eval only
    expect(out.letLegacyReply).toBe(true);
    const audit = store.load('fasAuditLog', []);
    expect(audit[0].shouldReply).toBe(false);
    expect(audit[0].reasonCode).toBe('NO_RESPONSE_NEEDED');
  });
});

describe('FAS runner — reply placement → threadTs (spec #6)', () => {
  it('AUTONOMOUS channel: placement thread starts a thread from the message ts', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: true, replyPlacement: 'thread', reasonCode: 'DIRECT_QUESTION', reply: '320160 is active.' }));
    let sentThreadTs = 'UNSET';
    const sendToChannel = vi.fn(async (_ch, _txt, threadTs) => { sentThreadTs = threadTs; return { ts: '201.1' }; });
    const out = await runner.handleInbound(channel({ ts: '200.2' }), { sendToChannel });
    expect(out.outcome).toBe('auto-sent');
    expect(sendToChannel).toHaveBeenCalled();
    expect(sentThreadTs).toBe('200.2'); // started a thread from the inbound ts
  });

  it('AUTONOMOUS channel: placement top_level sends with NO thread', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: true, replyPlacement: 'top_level', reasonCode: 'CORRECT_CRITICAL_INFO', reply: 'Heads up: 320160 is NOT ready.' }));
    let sentThreadTs = 'UNSET';
    const sendToChannel = vi.fn(async (_ch, _txt, threadTs) => { sentThreadTs = threadTs; return { ts: '201.2' }; });
    const out = await runner.handleInbound(channel({ ts: '200.2' }), { sendToChannel });
    expect(out.outcome).toBe('auto-sent');
    expect(sentThreadTs).toBeUndefined(); // channel-wide, no thread
  });

  it('AUTONOMOUS channel: placement thread continues an EXISTING thread', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: true, replyPlacement: 'thread', reasonCode: 'THREAD_CONTINUATION', reply: 'continuing.' }));
    let sentThreadTs = 'UNSET';
    const sendToChannel = vi.fn(async (_ch, _txt, threadTs) => { sentThreadTs = threadTs; return { ts: '201.3' }; });
    const out = await runner.handleInbound(channel({ ts: '205.5', threadTs: '200.0' }), { sendToChannel });
    expect(out.outcome).toBe('auto-sent');
    expect(sentThreadTs).toBe('200.0'); // kept the existing thread
  });

  it('APPROVAL: queued item gets threadTs derived from placement', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: true, replyPlacement: 'thread', reasonCode: 'DIRECT_QUESTION', reply: 'proposed.' }));
    const out = await runner.handleInbound(channel({ ts: '200.2' }));
    expect(out.outcome).toBe('queued');
    const item = store.load('fasApprovalQueue', []).find(x => x.kind === 'reply');
    expect(item.threadTs).toBe('200.2');
    expect(item.replyPlacement).toBe('thread');
  });
});
