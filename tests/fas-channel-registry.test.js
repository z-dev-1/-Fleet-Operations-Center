import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-chan-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const cr = require('../src/slack/channel-registry');
const agent = require('../src/orcha/fas/agent');
const runner = require('../src/orcha/fas/runner');
const relay = require('../src/orcha/relay');

function seedFleet(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '322355', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active', vendor: 'Amerit' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com', identityType: 'internal' }]);
  store.save('slackSenderProfiles', { __migratedAt: new Date().toISOString(), __migrationVersion: 1 });
  store.save('fasCases', {});
  store.save('aiMemory', []);
  store.save('slackChannelRegistry', {});
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('fasConfig', { enabled: true, mode, maxSteps: 2, maxRuntimeMs: 15000, retry: { inLoopRetries: 0 }, reviewReplies: false });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
const decide = (extra) => R(Object.assign({ decision: 'answer', confidence: 0.95, reason: 'ok', research: [], actions: [], reply: 'ack', followUp: { required: false } }, extra || {}));

describe('channel-registry — name classifier', () => {
  it('vendor feed name → VENDOR_FEED, ingest, only_if_mentioned', () => {
    const c = cr.classifyByName('amerit-repair-feed');
    expect(c.mode).toBe('VENDOR_FEED');
    expect(c.replyPolicy).toBe('only_if_directly_mentioned');
    expect(c.ingestionPolicy).toBe(true);
  });
  it('alerts name → ALERT_FEED', () => {
    expect(cr.classifyByName('pm-alerts').mode).toBe('ALERT_FEED');
    expect(cr.classifyByName('sev-incidents').mode).toBe('ALERT_FEED');
  });
  it('generic feed/updates → INFORMATION_FEED', () => {
    expect(cr.classifyByName('fleet-updates').mode).toBe('INFORMATION_FEED');
  });
  it('plain conversation name → CONVERSATIONAL, reply normal', () => {
    const c = cr.classifyByName('team-random');
    expect(c.mode).toBe('CONVERSATIONAL');
    expect(c.replyPolicy).toBe('normal');
  });
});

describe('channel-registry — resolve + governance', () => {
  it('inferred record is marked source inferred (no operator trust granted)', () => {
    seedFleet('autonomous');
    const rec = cr.resolveChannel({ channelId: 'C_FEED', channelName: 'vendor-status-feed' });
    expect(rec.source).toBe('inferred');
    expect(rec.mode).toBe('VENDOR_FEED');
  });
  it('operator record overrides the name guess and is authoritative', () => {
    seedFleet('autonomous');
    cr.upsertChannel({ channelId: 'C_X', name: 'fleet-updates', mode: 'CONVERSATIONAL', replyPolicy: 'normal' }, { operator: true });
    const rec = cr.resolveChannel({ channelId: 'C_X', channelName: 'fleet-updates' });
    expect(rec.source).toBe('operator');
    expect(rec.mode).toBe('CONVERSATIONAL'); // operator override beats the 'updates' feed guess
  });
  it('AI/auto upsert cannot raise trust above the name classifier', () => {
    seedFleet('autonomous');
    // Try to auto-grant SYSTEM_GENERATED to a plainly conversational channel.
    const res = cr.upsertChannel({ channelId: 'C_Y', name: 'team-random', mode: 'CONVERSATIONAL', trustedSourceLevel: 'SYSTEM_GENERATED' }, { operator: false });
    expect(res.record.trustedSourceLevel).not.toBe('SYSTEM_GENERATED');
  });
  it('Slack Connect downgrades source authority to PARTNER_CHANNEL', () => {
    seedFleet('autonomous');
    const rec = cr.resolveChannel({ channelId: 'C_P', channelName: 'partner-chat', isSlackConnect: true });
    expect(rec.trustedSourceLevel).toBe('PARTNER_CHANNEL');
  });
});

describe('channel-registry — ingestOnly behavior', () => {
  it('feed channel + not mentioned → ingest only', () => {
    const rec = cr.resolveChannel({ channelId: 'C_FEED', channelName: 'vendor-repair-feed' });
    expect(cr.ingestOnly(rec, { mentioned: false })).toBe(true);
  });
  it('feed channel + directly mentioned → NOT ingest only (reply)', () => {
    const rec = cr.resolveChannel({ channelId: 'C_FEED', channelName: 'vendor-repair-feed' });
    expect(cr.ingestOnly(rec, { mentioned: true })).toBe(false);
  });
  it('conversational channel → never ingest only', () => {
    const rec = cr.resolveChannel({ channelId: 'C_CONV', channelName: 'ops-team' });
    expect(cr.ingestOnly(rec, { mentioned: false })).toBe(false);
  });
});

// ── INTEGRATION: agent + runner behavior in a feed channel ──────────────────
describe('agent/runner — information-feed ingest (spec #46/#49)', () => {
  it('feed channel, not mentioned → silent no-reply + observation ingested', async () => {
    seedFleet('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: true, replyPlacement: 'thread', reply: '322355 complete, ready pickup' }));
    const out = await runner.handleInbound({
      engine: 'channel', slackId: 'U_INT', senderName: 'Zila', channelId: 'C_FEED', channelName: 'vendor-repair-feed',
      ts: '300.1', text: '322355 COMPLETE - ready pickup', isGroup: true, mentioned: false,
    });
    expect(out.outcome).toBe('no-reply');            // did NOT reply to a feed post
    expect(out.letLegacyReply).toBe(false);          // legacy suppressed too
    expect(out.decision.reasonCode).toBe('INFORMATION_FEED_INGEST_ONLY');
    // the claim was ingested into memory (ai_inferred, unit-scoped)
    const mem = store.load('aiMemory', []);
    const unitMem = mem.find(m => m.type === 'unit' && String(m.entity) === '322355');
    expect(unitMem).toBeTruthy();
    expect(unitMem.origin).toBe('ai_inferred');      // a CLAIM, never canonical
  });

  it('feed channel BUT directly mentioned → replies normally', async () => {
    seedFleet('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ shouldReply: true, replyPlacement: 'thread', reasonCode: 'DIRECT_MENTION', reply: '322355 is active.' }));
    let sent = false;
    const sendToChannel = async () => { sent = true; return { ts: '301.1' }; };
    const out = await runner.handleInbound({
      engine: 'channel', slackId: 'U_INT', senderName: 'Zila', channelId: 'C_FEED', channelName: 'vendor-repair-feed',
      ts: '300.2', text: '<@Zila> whats up with 322355?', isGroup: true, mentioned: true,
    }, { sendToChannel });
    expect(out.outcome).toBe('auto-sent');
    expect(sent).toBe(true);
  });

  it('feed ingest does NOT flip canonical lifecycle (claim only)', async () => {
    seedFleet('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(decide({ reply: '322355 ready' }));
    await runner.handleInbound({
      engine: 'channel', slackId: 'U_INT', senderName: 'Zila', channelId: 'C_FEED', channelName: 'fleet-updates',
      ts: '300.3', text: '322355 is ready for service', isGroup: true, mentioned: false,
    });
    // fleet row lifecycle unchanged (still Active from seed; no flip to anything)
    const rows = store.load('fleetData', { rows: [] }).rows;
    expect(rows[0].lifecycleState).toBe('Active');
  });
});
