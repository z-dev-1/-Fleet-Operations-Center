import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-evscope-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const { buildEvidence } = require('../src/orcha/fas/evidence');
const caseStore = require('../src/orcha/fas/case-store');
const P = require('../src/orcha/fas/sender-profiles');

// Two carriers at two domiciles; one unit each. Relay cache for both.
function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '111111', operator: 'AUVTE', domicileSite: 'ROC5', lifecycleState: 'Unavailable', vendor: 'Amerit', workDuration: '10d' },
    { equipmentId: '222222', operator: 'TURZ', domicileSite: 'EWR9', lifecycleState: 'Unavailable', vendor: 'TA', workDuration: '4d' },
  ] });
  store.save('relayCache', {
    '111111': { workRequestId: 'WR-A', serviceState: 'WIP', vendor: 'Amerit', offsiteShopEvent: 'SR-1', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/service_requests/1', _cachedAt: Date.now() },
    '222222': { workRequestId: 'WR-B', serviceState: 'WIP', vendor: 'TA', _cachedAt: Date.now() },
  });
  store.save('contacts', []);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasConfig', { enabled: true, mode: 'shadow', dataFreshnessMs: 6 * 3600 * 1000 });
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const internal = () => ({ slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: P.DATA_CATEGORIES.slice(), permittedRequestTypes: P.REQUEST_TYPES.slice() });
const carrier = (ops, doms) => ({ slackId: 'U_C', name: 'C', type: 'carrier', operators: ops || [], domiciles: doms || [],
  allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'], permittedRequestTypes: ['unit_status'] });

const unitFacts = (ev, unit) => ev.verifiedFacts.filter(f => f.field === 'unit' && f.value === unit);

describe('Part 4: evidence scoping for carrier/vendor/unknown', () => {
  it('a carrier assigned only to AUVTE cannot see TURZ unit data', async () => {
    const ev = await buildEvidence({ profile: carrier(['AUVTE']), text: 'status of 111111 and 222222?' });
    // Own unit present; other carrier's unit denied (in deniedScope, not facts).
    expect(unitFacts(ev, '111111').length).toBe(1);
    expect(unitFacts(ev, '222222').length).toBe(0);
    expect(ev.deniedScope).toContain('222222');
    // No TURZ/EWR9 anything leaked into the facts.
    const blob = JSON.stringify(ev.verifiedFacts);
    expect(blob).not.toMatch(/TURZ|EWR9|WR-B/);
  });

  it('a multi-carrier contact sees only the selected carriers', async () => {
    const ev = await buildEvidence({ profile: carrier(['AUVTE', 'TURZ']), text: 'status of 111111 and 222222?' });
    expect(unitFacts(ev, '111111').length).toBe(1);
    expect(unitFacts(ev, '222222').length).toBe(1);
    expect(ev.deniedScope).toEqual([]);
  });

  it('domicile scoping: a domicile-scoped carrier sees units at that domicile', async () => {
    const ev = await buildEvidence({ profile: carrier([], ['ROC5']), text: 'status of 111111 and 222222?' });
    expect(unitFacts(ev, '111111').length).toBe(1);  // ROC5
    expect(unitFacts(ev, '222222').length).toBe(0);  // EWR9 denied
  });

  it('empty external scope reveals NO fleet information', async () => {
    const ev = await buildEvidence({ profile: carrier([], []), text: 'status of 111111 and 222222?' });
    expect(unitFacts(ev, '111111').length).toBe(0);
    expect(unitFacts(ev, '222222').length).toBe(0);
    expect(ev.deniedScope.length).toBe(2);
  });

  it('Relay Garage + offsite evidence is filtered to authorized units', async () => {
    const ev = await buildEvidence({ profile: carrier(['AUVTE']), text: 'any offsite repair update on 111111 and 222222?' });
    const blob = JSON.stringify(ev.verifiedFacts);
    expect(blob).toMatch(/WR-A/);        // own unit's relay WR visible
    expect(blob).not.toMatch(/WR-B/);    // other carrier's relay WR NOT visible
  });

  it('internal sees both units', async () => {
    const ev = await buildEvidence({ profile: internal(), text: 'status of 111111 and 222222?' });
    expect(unitFacts(ev, '111111').length).toBe(1);
    expect(unitFacts(ev, '222222').length).toBe(1);
  });

  it('disabled contact (no categories) gets no fleet facts', async () => {
    const disabled = { slackId: 'U_D', name: 'D', type: 'carrier', enabled: false, operators: ['AUVTE'], domiciles: [], allowedDataCategories: [], permittedRequestTypes: [] };
    const ev = await buildEvidence({ profile: disabled, text: 'status of 111111?' });
    expect(unitFacts(ev, '111111').length).toBe(0);
    expect(ev.deniedScope).toContain('111111');
  });

  it('case memory is scope-filtered: carrier does not see another carrier\'s case', async () => {
    // Seed a case for the TURZ unit 222222.
    caseStore.upsert(caseStore.caseIdForUnit('222222'), {
      unit: '222222', currentSummary: 'TURZ secret case', promises: [{ text: "I'll confirm TURZ ETA" }],
    }, '222222');
    // AUVTE carrier asks about their own unit; must NOT get the TURZ case/promise.
    const ev = await buildEvidence({ profile: carrier(['AUVTE']), text: 'update on 111111?' });
    const blob = JSON.stringify(ev.relatedCases) + JSON.stringify(ev.previousPromises);
    expect(blob).not.toMatch(/TURZ|222222/);
  });
});
