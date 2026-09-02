import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-case-sched-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const runner = require('../src/orcha/fas/runner');
const caseStore = require('../src/orcha/fas/case-store');
const scheduler = require('../src/orcha/fas/scheduler');
const relay = require('../src/orcha/relay');

function seed(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', vendor: 'Amerit' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('fasConfig', { enabled: true, mode: mode || 'shadow', maxSteps: 2, retry: { inLoopRetries: 0 } });
}
afterEach(() => { vi.restoreAllMocks(); scheduler.stopScheduler(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);
const inbound = () => ({ engine: 'dm', slackId: 'U_INT', senderName: 'Zila', channelName: 'DM', channelId: 'C1', ts: '100.1', text: 'any update on 320160?' });

describe('FAS case memory auto-wiring (only from SENT replies — Part 7)', () => {
  it('creates/updates a unit case after an AUTONOMOUS SENT reply', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: "I'll follow up with Amerit and confirm the ETA today." }));
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('auto-sent'); // actually sent -> case committed
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    expect(c).toBeTruthy();
    expect(c.unit).toBe('320160');
    expect(c.currentSummary).toMatch(/Amerit/);
    expect(c.promises.length).toBeGreaterThanOrEqual(1);
    expect(c.nextFollowUpAt).toBeTruthy();
  });

  it('dedupes repeated promises across sent interactions', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: "I'll follow up with Amerit today." }));
    await runner.handleInbound(inbound());
    await runner.handleInbound(inbound()); // same promise again
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    const followUps = c.promises.filter(p => /follow up with amerit/i.test(p.text));
    expect(followUps.length).toBe(1); // not duplicated
  });

  it('dedupes verified facts in the case', async () => {
    seed('autonomous');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: 'status noted' }));
    await runner.handleInbound(inbound());
    const before = caseStore.getCase(caseStore.caseIdForUnit('320160')).verifiedFacts.length;
    await runner.handleInbound(inbound()); // same facts again
    const after = caseStore.getCase(caseStore.caseIdForUnit('320160')).verifiedFacts.length;
    expect(after).toBe(before);
  });

  it('SHADOW mode does NOT write authoritative case memory (Part 7)', async () => {
    seed('shadow');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: "I'll follow up with Amerit today." }));
    await runner.handleInbound(inbound());
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    expect(c).toBeNull(); // shadow drafts are evaluation-only, never case facts
  });

  it('APPROVAL queued (unapproved) draft does NOT create a promise (Part 7)', async () => {
    seed('approval');
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: "I'll follow up with Amerit today." }));
    const out = await runner.handleInbound(inbound());
    expect(out.outcome).toBe('queued');
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    expect(c).toBeNull(); // nothing committed until the reply is actually sent
  });
});

describe('FAS follow-up scheduler (passive)', () => {
  it('surfaces due follow-ups without contacting anyone', () => {
    seed('shadow');
    // Seed a case due in the past.
    caseStore.upsert(caseStore.caseIdForUnit('320160'), {
      unit: '320160', currentSummary: 'awaiting Amerit ETA', responsibleParty: 'Amerit',
      nextFollowUpAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    }, '320160');
    // And one NOT due yet.
    caseStore.upsert(caseStore.caseIdForUnit('999999'), {
      unit: '999999', currentSummary: 'future', nextFollowUpAt: new Date(Date.now() + 864e5).toISOString(),
    }, '999999');

    const due = scheduler.getDueFollowUps();
    expect(due.length).toBe(1);
    expect(due[0].unit).toBe('320160');
    expect(due[0].owner).toBe('Amerit');
  });

  it('surfaceDueFollowUps records an audit entry but sends nothing', () => {
    seed('shadow');
    caseStore.upsert(caseStore.caseIdForUnit('320160'), {
      unit: '320160', nextFollowUpAt: new Date(Date.now() - 1000).toISOString(),
    }, '320160');
    const due = scheduler.surfaceDueFollowUps();
    expect(due.length).toBe(1);
    const audit = store.load('fasAuditLog', []);
    expect(audit.some(a => a.kind === 'followups-due')).toBe(true);
  });
});
