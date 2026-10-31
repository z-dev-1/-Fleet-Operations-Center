import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-aud-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const ar = require('../src/slack/audience-resolver');
const agent = require('../src/orcha/fas/agent');
const relay = require('../src/orcha/relay');

// Contacts: an internal manager, a carrier contact (TUZR), a vendor.
function seedContacts() {
  store.save('contacts', [
    { type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com', identityType: 'internal' },
    { type: 'slack', slackId: 'U_MGR', name: 'Manager', org: 'Amazon', email: 'm@amazon.com', identityType: 'internal' },
    { type: 'slack', slackId: 'U_CARRIER', name: 'Carrier Op', identityType: 'carrier', operators: ['TUZR'] },
    { type: 'slack', slackId: 'U_VENDOR', name: 'Amerit Mech', identityType: 'vendor', domiciles: ['ABE40'] },
  ]);
  store.save('slackSenderProfiles', { __migratedAt: new Date().toISOString(), __migrationVersion: 1 });
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('audience-resolver — _intersectScope', () => {
  it('* is the identity element', () => {
    expect(ar._intersectScope(['*'], ['TUZR'])).toEqual(['TUZR']);
    expect(ar._intersectScope(['ABE40'], ['*'])).toEqual(['ABE40']);
    expect(ar._intersectScope(['*'], ['*'])).toEqual(['*']);
  });
  it('concrete lists intersect', () => {
    expect(ar._intersectScope(['TUZR', 'AUVTE'], ['AUVTE', 'SAPB'])).toEqual(['AUVTE']);
    expect(ar._intersectScope(['TUZR'], ['SAPB'])).toEqual([]);
  });
});

describe('audience-resolver — surfaces', () => {
  it('1:1 DM: audience is the sender (internal → internal, not conservative)', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'dm', sender: { slackId: 'U_INT', name: 'Zila' } });
    expect(a.audienceSensitivity).toBe('internal');
    expect(a.conservative).toBe(false);
    expect(a.withholdInternalOnly).toBe(false);
  });

  it('self-DM: operator interface, internal', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'self_dm', isSelf: true, sender: { slackId: 'U_INT' } });
    expect(a.audienceSensitivity).toBe('internal');
    expect(a.withholdInternalOnly).toBe(false);
  });

  it('channel with NO participant list → conservative, withhold internal-only', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'channel', isGroup: true, sender: { slackId: 'U_INT' } });
    expect(a.conservative).toBe(true);
    expect(a.withholdInternalOnly).toBe(true);
  });

  it('Slack Connect → always conservative even with a known internal list', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'channel', isGroup: true, isSlackConnect: true,
      sender: { slackId: 'U_INT' }, participants: ['U_MGR'] });
    expect(a.surface).toBe('slack_connect');
    expect(a.conservative).toBe(true);
    expect(a.withholdInternalOnly).toBe(true);
  });

  it('group DM: internal manager + carrier → MIXED, withhold internal-only, scope narrows to carrier (TUZR)', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'group_dm', isGroup: true,
      sender: { slackId: 'U_MGR' }, participants: ['U_CARRIER'] });
    expect(a.audienceSensitivity).toBe('internal_external_mixed');
    expect(a.externalPresent).toBe(true);
    expect(a.withholdInternalOnly).toBe(true);
    // Manager is all-scope ('*'); carrier is TUZR → effective ops = TUZR.
    expect(a.effectiveOperators).toEqual(['TUZR']);
  });

  it('group DM: all internal + known list → INTERNAL, no withhold', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'group_dm', isGroup: true,
      sender: { slackId: 'U_INT' }, participants: ['U_MGR'] });
    expect(a.audienceSensitivity).toBe('internal');
    expect(a.conservative).toBe(false);
    expect(a.withholdInternalOnly).toBe(false);
  });

  it('group DM: internal + vendor → MIXED, vendor present counts as external', () => {
    seedContacts();
    const a = ar.resolveAudience({ surface: 'group_dm', isGroup: true,
      sender: { slackId: 'U_INT' }, participants: ['U_VENDOR'] });
    expect(a.audienceSensitivity).toBe('internal_external_mixed');
    expect(a.externalPresent).toBe(true);
  });
});

describe('audience-resolver — applyAudienceCeiling', () => {
  const ev = () => ({ verifiedFacts: [
    { field: 'lifecycleState', value: 'Active', source: 'aap' },
    { field: 'operatorSummary', value: 'TUZR fleet health...', source: 'internal' },
    { field: 'siteSummary', value: 'ABE40 summary...', source: 'internal' },
    { field: 'uptakeInsights', value: 'risk 0.8', source: 'uptake' },
  ] });

  it('withholds internal-only facts for a mixed/external audience', () => {
    const out = ar.applyAudienceCeiling(ev(), { withholdInternalOnly: true, audienceSensitivity: 'internal_external_mixed' });
    const fields = out.verifiedFacts.map(f => f.field);
    expect(fields).toContain('lifecycleState');          // kept
    expect(fields).not.toContain('operatorSummary');     // withheld
    expect(fields).not.toContain('siteSummary');         // withheld
    expect(fields).not.toContain('uptakeInsights');      // withheld
    expect(out._audienceWithheld.length).toBe(3);
  });

  it('keeps everything for an internal audience', () => {
    const out = ar.applyAudienceCeiling(ev(), { withholdInternalOnly: false, audienceSensitivity: 'internal' });
    expect(out.verifiedFacts.length).toBe(4);
    expect(out._audienceWithheld).toBeUndefined();
  });
});

// ── INTEGRATION: the agent sets audienceSensitivity AUTHORITATIVELY ──────────
describe('agent integration — audience is authoritative from code', () => {
  function seedFleet(mode) {
    seedContacts();
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
      { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active', vendor: 'Amerit' },
    ] });
    store.save('fasCases', {});
    store.save('fasConfig', { enabled: true, mode, maxSteps: 2, maxRuntimeMs: 15000, retry: { inLoopRetries: 0 }, reviewReplies: false });
  }
  const R = (o) => JSON.stringify(o);

  it('model claims "internal" but a carrier is present → code overrides to mixed', async () => {
    seedFleet('autonomous');
    // Model under-reports audienceSensitivity as internal; code must override.
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.95, reason: 'ok',
      shouldReply: true, replyPlacement: 'thread', audienceSensitivity: 'internal', reasonCode: 'DIRECT_QUESTION',
      research: [], actions: [], reply: '320160 is active.' }));
    const decision = await agent.runAgent({
      slackId: 'U_MGR', senderName: 'Manager', text: 'status on 320160?', isGroup: true,
      participants: ['U_CARRIER'],
    });
    expect(decision.audienceSensitivity).toBe('internal_external_mixed'); // NOT internal
    expect(decision._audience).toBeTruthy();
    expect(decision._audience.externalPresent).toBe(true);
  });

  it('1:1 DM internal → audienceSensitivity internal', async () => {
    seedFleet('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.95, reason: 'ok',
      shouldReply: true, reasonCode: 'DIRECT_QUESTION', research: [], actions: [], reply: 'ok' }));
    const decision = await agent.runAgent({ slackId: 'U_INT', senderName: 'Zila', text: 'hi', isGroup: false });
    expect(decision.audienceSensitivity).toBe('internal');
  });
});
