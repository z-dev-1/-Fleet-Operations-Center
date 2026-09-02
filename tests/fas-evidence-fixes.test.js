import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-evfix-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const { buildEvidence } = require('../src/orcha/fas/evidence');
const tools = require('../src/orcha/fas/tool-registry');
const profiles = require('../src/orcha/fas/sender-profiles');

// Two units: one internal-owned, one for carrier TUZR at ABE40.
function seed(extraRow) {
  const rows = [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40',
      lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair',
      vendor: 'Amerit', workDuration: '20d',
      openUnplanned: '1', workRequestId: 'WR-777' },
    { equipmentId: '622072', operator: 'SAPB', domicileSite: 'EWR45',
      lifecycleState: 'Active', lifecycleReason: '', vendor: '', workDuration: '' },
  ];
  if (extraRow) rows.push(extraRow);
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows });
  store.save('contacts', []);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasConfig', { enabled: true, mode: 'shadow', dataFreshnessMs: 6 * 60 * 60 * 1000,
    approvedLinkDomains: ['aap-na.corp.amazon.com'] });
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

// Helper profiles
const internal = () => ({ slackId: 'U_INT', name: 'Zila', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: profiles.DATA_CATEGORIES.slice(),
  permittedRequestTypes: profiles.REQUEST_TYPES.slice() });
const carrierTUZR = () => ({ slackId: 'U_TUZR', name: 'TUZR partner', type: 'carrier', operators: ['TUZR'], domiciles: [],
  allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'],
  permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up'] });

describe('FAS evidence bug fixes', () => {
  it('resolves site/operator groups via g.value (not g.key)', async () => {
    // "how are TUZR units doing" -> operator group; must not throw and must
    // produce an operatorSummary fact (proving g.value reached the tool).
    const ev = await buildEvidence({ profile: internal(), text: 'how are TUZR units doing?' });
    const hasOpGroup = ev.entities.groups.some(g => g.kind === 'operator' && g.value === 'TUZR');
    expect(hasOpGroup).toBe(true);
    const opSummary = ev.verifiedFacts.find(f => f.field === 'operatorSummary');
    expect(opSummary).toBeTruthy();
    expect(opSummary.value).toBeTruthy();
  });

  it('flags a missing ETC ONLY when the request asks about timing', async () => {
    const asks = await buildEvidence({ profile: internal(), text: 'when will 320160 be ready?' });
    const withEtcGap = asks.missingFacts.some(m => /ETC for 320160/.test(m));
    expect(withEtcGap).toBe(true);

    const noAsk = await buildEvidence({ profile: internal(), text: 'who is the vendor on 320160?' });
    const noEtcGap = noAsk.missingFacts.some(m => /ETC for 320160/.test(m));
    expect(noEtcGap).toBe(false);
  });

  it('factsNeeded gates which tool families run', async () => {
    // Only ask for work orders -> should collect the open-WR fact.
    const ev = await buildEvidence({ profile: internal(), text: 'status of 320160', factsNeeded: ['work_orders'] });
    const woUnit = ev.openWorkOrders.find(w => w.unit === '320160');
    expect(woUnit).toBeTruthy();
    // pm/uptake families are NOT requested -> no pm fact present
    const hasPm = ev.verifiedFacts.some(f => f.field === 'pmB' || f.field === 'pmX');
    expect(hasPm).toBe(false);
  });

  it('uses configured dataFreshnessMs to flag stale fleet data', async () => {
    // Sync 8h ago; freshness window 6h -> stale.
    store.save('fleetData', { syncedAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
      rows: [{ equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active' }] });
    const ev = await buildEvidence({ profile: internal(), text: 'status of 320160' });
    expect(ev.missingFacts.some(m => /stale/i.test(m))).toBe(true);
  });

  it('detects lifecycle-vs-workorder conflict (ACTIVE but open WR)', async () => {
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
      { equipmentId: '999001', operator: 'TUZR', domicileSite: 'ABE40',
        lifecycleState: 'Active', openUnplanned: '1', workRequestId: 'WR-123' },
    ] });
    const ev = await buildEvidence({ profile: internal(), text: 'is 999001 good to dispatch?', factsNeeded: ['work_orders'] });
    expect(ev.conflicts.some(c => c.type === 'lifecycle_vs_wr')).toBe(true);
  });
});

describe('FAS tool-registry authorization (code-enforced)', () => {
  it('GET_UPTAKE_INSIGHTS is denied for a carrier lacking the uptake category', () => {
    const r = tools.runTool('GET_UPTAKE_INSIGHTS', { unit: '320160' }, { profile: carrierTUZR() });
    return Promise.resolve(r).then(res => {
      expect(res.denied).toBe(true);
    });
  });

  it('GET_UNIT allowed for in-scope carrier, denied cross-operator', async () => {
    const ok = await tools.runTool('GET_UNIT', { unit: '320160' }, { profile: carrierTUZR() });
    expect(ok.ok).toBe(true);
    // 622072 is SAPB -> outside TUZR carrier scope
    const denied = await tools.runTool('GET_UNIT', { unit: '622072' }, { profile: carrierTUZR() });
    expect(denied.denied).toBe(true);
  });

  it('GET_VENDOR_CONTACT denied without vendor_contact category', async () => {
    const denied = await tools.runTool('GET_VENDOR_CONTACT', { vendor: 'Amerit' }, { profile: carrierTUZR() });
    expect(denied.denied).toBe(true);
    const ok = await tools.runTool('GET_VENDOR_CONTACT', { vendor: 'Amerit' }, { profile: internal() });
    // internal has vendor_contact; ok may be true or "not found" but never denied
    expect(ok.denied).toBeFalsy();
  });

  it('ASK_INTERNAL restricted to internal users', async () => {
    const denied = await tools.runTool('ASK_INTERNAL', { question: 'policy?' }, { profile: carrierTUZR() });
    expect(denied.denied).toBe(true);
  });
});
