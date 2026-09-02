import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Isolate the data dir so we never touch real app data.
const tmpDir = path.join(os.tmpdir(), 'fas-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const profiles = require('../src/orcha/fas/sender-profiles');
const tools = require('../src/orcha/fas/tool-registry');
const caseStore = require('../src/orcha/fas/case-store');
const { buildEvidence } = require('../src/orcha/fas/evidence');

// Seed a small fleet + contacts before each test.
function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1', openPlanned: '0', workRequestId: 'WR-1', riskScore: 30, pmB: '2026-09-20', repairTimeline: 'Diagnostics done\nParts ordered' },
    { equipmentId: '59083', operator: 'AGNLI', domicileSite: 'AVP40', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed', vendor: 'Kenworth', workDuration: '5d', openUnplanned: '1', openPlanned: '0', riskScore: 82 },
    { equipmentId: '320999', operator: 'SAPB', domicileSite: 'ABE40', lifecycleState: 'Active', lifecycleReason: 'Healthy', vendor: '', workDuration: '', riskScore: 10 },
    { equipmentId: '321000', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Damaged-Severe', vendor: 'TA', workDuration: '18d', openUnplanned: '1', openPlanned: '0' },
  ] });
  store.save('contacts', [
    { type: 'slack', slackId: 'U_INT', name: 'Internal Person', org: 'Amazon', email: 'x@amazon.com' },
    { type: 'slack', slackId: 'U_TUZR', name: 'TTR Carrier', operators: ['TUZR'], domiciles: 'ABE40' },
    { type: 'vendor', slackId: 'U_VEND', name: 'Amerit', company: 'Amerit', phone: '555-1', email: 'v@amerit.com', domiciles: 'ABE40 AVP40' },
  ]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
}

beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS Stage A — sender identity + scoping', () => {
  it('seeds an internal profile from contacts', () => {
    const p = profiles.resolveSender('U_INT');
    expect(p.type).toBe('internal');
    expect(p.source).toBe('contact-book'); // Contact Book is the single source of truth (Part 1)
    expect(profiles.authorizationSummary(p).isInternal).toBe(true);
  });

  it('seeds a carrier profile scoped to its operator/domicile', () => {
    const p = profiles.resolveSender('U_TUZR');
    expect(p.type).toBe('carrier');
    expect(p.operators).toContain('TUZR');
    expect(p.domiciles).toContain('ABE40');
  });

  it('defaults unknown senders to limited permissions', () => {
    const p = profiles.resolveSender('U_NOBODY');
    expect(p.source).toBe('default-limited');
    expect(profiles.canRequest(p, 'lifecycle_change')).toBe(false);
    expect(p.operators).toHaveLength(0);
  });

  it('unit scoping: internal sees any unit, carrier only its operator', () => {
    const internal = profiles.resolveSender('U_INT');
    const carrier = profiles.resolveSender('U_TUZR');
    const rows = store.load('fleetData', {}).rows;
    const tuzrUnit = rows.find(r => r.equipmentId === '320160'); // TUZR/ABE40
    const agnliUnit = rows.find(r => r.equipmentId === '59083'); // AGNLI/AVP40
    expect(profiles.scopeUnitForSender(internal, agnliUnit)).toBe(true);
    expect(profiles.scopeUnitForSender(carrier, tuzrUnit)).toBe(true);
    expect(profiles.scopeUnitForSender(carrier, agnliUnit)).toBe(false); // not their operator
  });
});

describe('FAS Stage A — read tools + scoping enforcement', () => {
  it('GET_UNIT returns verified facts with source + timestamp', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const r = await tools.runTool('GET_UNIT', { unit: '320160' }, ctx);
    expect(r.ok).toBe(true);
    const lc = r.verifiedFacts.find(f => f.field === 'lifecycleState');
    expect(lc.value).toBe('Unavailable');
    expect(lc.source).toBeTruthy();
    expect(lc.retrievedAt).toBeTruthy();
  });

  it('GET_UNIT denies a carrier a unit outside their operator', async () => {
    const ctx = { profile: profiles.resolveSender('U_TUZR') };
    const r = await tools.runTool('GET_UNIT', { unit: '59083' }, ctx); // AGNLI
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
  });

  it('GET_OPEN_WORK_ORDERS reports open WR', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const r = await tools.runTool('GET_OPEN_WORK_ORDERS', { unit: '320160' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.verifiedFacts.find(f => f.field === 'hasOpenWR').value).toBe(true);
  });

  it('GET_SITE_SUMMARY aggregates totals + exceptions, not every healthy unit', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const r = await tools.runTool('GET_SITE_SUMMARY', { domicile: 'ABE40' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary.total).toBe(3); // 320160, 320999, 321000 at ABE40
    expect(r.summary.unavailable).toBe(2);
    // safety hold: 321000 is Damaged-Severe
    expect(r.summary.safetyHolds.some(h => h.unit === '321000')).toBe(true);
  });

  it('GET_SITE_SUMMARY denies a carrier a site they do not own', async () => {
    const carrier = profiles.resolveSender('U_TUZR'); // owns ABE40 only
    const r = await tools.runTool('GET_SITE_SUMMARY', { domicile: 'AVP40' }, { profile: carrier });
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
  });

  it('unknown tool name is rejected', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const r = await tools.runTool('DROP_TABLE', {}, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('FAS Stage A — evidence package', () => {
  it('builds compact evidence for a unit question with freshness + authorization', async () => {
    const profile = profiles.resolveSender('U_INT');
    const ev = await buildEvidence({ profile, text: 'any update on 320160?' });
    expect(ev.caseId).toBe('unit-320160');
    expect(ev.verifiedFacts.length).toBeGreaterThan(0);
    expect(ev.dataFreshness).toHaveProperty('fleetSyncedAt');
    expect(ev.senderAuthorization.isInternal).toBe(true);
    expect(ev.verifiedFacts.every(f => f.source && f.retrievedAt)).toBe(true);
  });

  it('records denied scope when a carrier asks about another operator unit', async () => {
    const profile = profiles.resolveSender('U_TUZR');
    const ev = await buildEvidence({ profile, text: 'status on 59083?' }); // AGNLI
    expect(ev.deniedScope).toContain('59083');
  });

  it('flags stale fleet data as a missing fact', async () => {
    store.save('fleetData', { syncedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), rows: store.load('fleetData', {}).rows });
    const profile = profiles.resolveSender('U_INT');
    const ev = await buildEvidence({ profile, text: 'status 320160?' });
    expect(ev.dataFreshness.stale).toBe(true);
    expect(ev.missingFacts.some(m => /stale/i.test(m))).toBe(true);
  });
});

describe('FAS Stage A — case memory', () => {
  it('upserts and retrieves a compact case, appending promises', () => {
    const id = caseStore.caseIdForUnit('320160');
    caseStore.upsert(id, { unit: '320160', currentSummary: 'Awaiting parts', promises: [{ text: 'follow up with vendor', madeAt: 'now' }], responsibleParty: 'vendor' });
    caseStore.upsert(id, { promises: [{ text: 'confirm ETC', madeAt: 'now' }] });
    const c = caseStore.getCase(id);
    expect(c.currentSummary).toBe('Awaiting parts');
    expect(c.promises).toHaveLength(2);
    expect(c.responsibleParty).toBe('vendor');
  });

  it('findRelated returns unit + sender cases', () => {
    caseStore.upsert(caseStore.caseIdForUnit('320160'), { unit: '320160', currentSummary: 'x' });
    const related = caseStore.findRelated({ units: ['320160'], slackId: 'U_INT' });
    expect(related.some(c => c.caseId === 'unit-320160')).toBe(true);
  });

  it('evidence surfaces previous promises from case memory', async () => {
    caseStore.upsert(caseStore.caseIdForUnit('320160'), { unit: '320160', promises: [{ text: 'ETC by Friday', madeAt: 'now' }] });
    const profile = profiles.resolveSender('U_INT');
    const ev = await buildEvidence({ profile, text: 'update on 320160?' });
    expect(ev.previousPromises.some(p => /ETC by Friday/.test(p.text))).toBe(true);
  });
});

describe('FAS Stage A — store registration', () => {
  it('slackDMThreadReplyCount is now a registered store (reliability fix)', () => {
    expect(() => store.save('slackDMThreadReplyCount', { 'D:1': 2 })).not.toThrow();
    expect(store.load('slackDMThreadReplyCount', {})).toEqual({ 'D:1': 2 });
  });
});
