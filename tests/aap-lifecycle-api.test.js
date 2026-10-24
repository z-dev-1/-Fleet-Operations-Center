import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'aap-lifecycle-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const lifecycle = require('../src/scrapers/aap_lifecycle_api');

const AAID = 'aaid_078a7023-b0a3-4ca2-b2b6-3620e56f3954';

function seedFleet() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '324040', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/' + AAID, lifecycleState: 'Unavailable', workRequestId: 'WR-77' },
  ] });
}

// A mutable fake asset the mocked API reads/writes so read-back verification is real.
let FAKE_ASSET;
function resetAsset(state, reason) {
  FAKE_ASSET = {
    aaid: AAID, assetType: 'tractor', fleetId: 'ba97eda1-cb03-446e-a907-474084194777', version: 64,
    lifecycleState: state || 'UNAVAILABLE', lifecycleStateReason: reason || 'OFFSITE_SHOP_REPAIR',
    attributesText: { bodyType: 'SLEEPER', vehicleId: '324040', lifecycleState: state || 'UNAVAILABLE', lifecycleStateReason: reason || 'OFFSITE_SHOP_REPAIR' },
  };
}

beforeEach(() => {
  seedFleet();
  resetAsset('UNAVAILABLE', 'OFFSITE_SHOP_REPAIR');
  // getAsset returns the current fake asset.
  vi.spyOn(aap, 'getAsset').mockImplementation(async () => ({ ...FAKE_ASSET, attributesText: { ...FAKE_ASSET.attributesText } }));
  // apiPut applies the lifecycle change to the fake asset (version bump) + echoes it.
  vi.spyOn(aap, 'apiPut').mockImplementation(async (p, body) => {
    const a = (body && body.asset) || {};
    FAKE_ASSET.lifecycleState = a.lifecycleState;
    FAKE_ASSET.lifecycleStateReason = a.lifecycleStateReason;
    FAKE_ASSET.version += 1;
    FAKE_ASSET.attributesText = { ...FAKE_ASSET.attributesText, lifecycleState: a.lifecycleState, lifecycleStateReason: a.lifecycleStateReason };
    return { ...FAKE_ASSET };
  });
  // Valid fields endpoint.
  vi.spyOn(aap, 'apiGet').mockImplementation(async (p) => {
    if (/userInterface\/fields/.test(p)) return { userInterfaceFieldDefinitionMap: {
      lifecycleState: { values: ['ACTIVE', 'UNAVAILABLE', 'ORDERED', 'END_OF_LIFE'] },
      lifecycleStateReason: { values: lifecycle.SUPPORTED_REASONS.concat(['LEGAL_HOLD']) },
    } };
    throw new Error('unexpected apiGet ' + p);
  });
});
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('aap_lifecycle_api — resolution + valid values', () => {
  it('resolves an equipment number to aaid via the fleet cache', async () => {
    const r = await lifecycle.resolveAaid('324040');
    expect(r.aaid).toBe(AAID);
  });
  it('accepts an aaid directly', async () => {
    const r = await lifecycle.resolveAaid(AAID);
    expect(r.aaid).toBe(AAID);
  });
  it('resolves from a passed assetUrl WITHOUT any network call (manual-button path)', async () => {
    // Even with no fleet cache + no network, an assetUrl resolves locally.
    store.save('fleetData', { rows: [] });
    const searchSpy = vi.spyOn(aap, 'searchAssets');
    const r = await lifecycle.resolveAaid('122149', { assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/' + AAID });
    expect(r.aaid).toBe(AAID);
    expect(searchSpy).not.toHaveBeenCalled();   // no network search needed
  });
  it('END_OF_LIFE is never an allowed state', async () => {
    const states = await lifecycle.getValidStates('fleet');
    expect(states).not.toContain('END_OF_LIFE');
    expect(states).toContain('ACTIVE');
  });
  it('auto-remembers AAP live reasons and flags new ones', async () => {
    const v = await lifecycle.refreshValidValues('fleet');
    expect(v.reasons).toContain('HEALTHY');
    expect(v.newReasons).toContain('LEGAL_HOLD'); // live but not in supported set
  });
});

describe('aap_lifecycle_api — flip with verified read-back', () => {
  it('flips UNAVAILABLE -> ACTIVE and verifies via source read-back', async () => {
    const r = await lifecycle.setLifecycleApi({ unit: '324040', state: 'ACTIVE', reason: 'HEALTHY' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('done');
    expect(r.verified).toBe(true);
    expect(r.to.state).toBe('ACTIVE');
    expect(r.sourceReadback.state).toBe('ACTIVE');       // confirmed from a fresh GET
    expect(FAKE_ASSET.version).toBe(65);                  // version bumped
  });

  it('BLOCKS END_OF_LIFE', async () => {
    const r = await lifecycle.setLifecycleApi({ unit: '324040', state: 'END_OF_LIFE' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('blocked');
  });

  it('is an idempotent no-op when already in the target state', async () => {
    resetAsset('ACTIVE', 'HEALTHY');
    const r = await lifecycle.setLifecycleApi({ unit: '324040', state: 'ACTIVE', reason: 'HEALTHY' });
    expect(r.status).toBe('noop');
    expect(r.verified).toBe(true);
  });

  it('rejects a reason AAP does not consider valid', async () => {
    const r = await lifecycle.setLifecycleApi({ unit: '324040', state: 'UNAVAILABLE', reason: 'NONSENSE_REASON' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
  });

  it('returns EXECUTION_UNCERTAIN when the read-back does not confirm', async () => {
    // Make the write a no-op so the read-back disagrees with the requested state.
    aap.apiPut.mockImplementationOnce(async () => ({ ...FAKE_ASSET })); // did NOT apply change
    const r = await lifecycle.setLifecycleApi({ unit: '324040', state: 'ACTIVE', reason: 'HEALTHY' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('execution_uncertain');
    expect(r.verified).toBe(false);
  });
});

describe('aap_lifecycle_api — DVIR read + clear', () => {
  it('reads open DVIRs and clears a blocking one, verifying hasOpenIssues:false', async () => {
    // Override apiGet to serve an open DVIR, and apiPost to clear it.
    const openResp = { components: [{ name: 'TIRES', items: [{ dvirId: 'dv1', component: 'TIRES', condition: 'NOT_DRIVABLE', lifecycle: 'OPEN_ISSUE', dvirVersion: 7 }] }] };
    const clearedResp = { components: [] };
    let cleared = false;
    aap.apiGet.mockImplementation(async (p) => {
      if (/userInterface\/fields/.test(p)) return { userInterfaceFieldDefinitionMap: {} };
      if (/\/dvir\//.test(p) && /openIssuesOnly=true/.test(p)) return cleared ? clearedResp : openResp;
      return { components: [] };
    });
    let postedBody = null;
    vi.spyOn(aap, 'apiPost').mockImplementation(async (p, body) => {
      if (/\/dvir\/dv1\/component\/TIRES/.test(p)) { cleared = true; postedBody = body; return { id: 'dv1', condition: 'DRIVABLE', lifecycle: 'CLOSED_NO_DRIVER_INSPECTION_REQUIRED', hasOpenIssues: false, version: 8 }; }
      return {};
    });

    const open = await lifecycle.getOpenDvirs(AAID);
    expect(open.ok).toBe(true);
    expect(open.blocking.length).toBe(1);
    expect(open.blocking[0].component).toBe('TIRES');
    expect(open.blocking[0].version).toBe(7);            // dvirVersion threaded through

    // No WR supplied -> auto-pulls the unit's REAL open WR from fleet data (option 3).
    const clr = await lifecycle.clearAllOpenDvirs(AAID);
    expect(clr.ok).toBe(true);
    expect(clr.cleared.length).toBe(1);
    expect(clr.remaining).toBe(0);                        // confirmed clear via re-read
    // The POST body matches the CONFIRMED capture shape; workOrderNumber is the
    // unit's real open WR (WR-77 from fleet data), not a placeholder.
    expect(postedBody).toEqual({
      aaid: AAID, version: 7, lifecycle: 'CLOSED_NO_DRIVER_INSPECTION_REQUIRED',
      outcome: 'REPAIRS_MADE', workOrderNumber: 'WR-77', comment: 'Cleared on return to service',
    });
  });

  it('auto-clear needs a work order: errors (needsWorkOrder) when the unit has no open WR and none supplied', async () => {
    // Remove the WR from the seeded unit.
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
      { equipmentId: '324040', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/' + AAID, lifecycleState: 'Unavailable' },
    ] });
    const openResp = { components: [{ name: 'TIRES', items: [{ dvirId: 'dv1', component: 'TIRES', condition: 'NOT_DRIVABLE', lifecycle: 'OPEN_ISSUE', dvirVersion: 7 }] }] };
    aap.apiGet.mockImplementation(async (p) => {
      if (/userInterface\/fields/.test(p)) return { userInterfaceFieldDefinitionMap: {} };
      if (/\/dvir\//.test(p) && /openIssuesOnly=true/.test(p)) return openResp;
      return { components: [] };
    });
    const clr = await lifecycle.clearAllOpenDvirs(AAID);
    expect(clr.ok).toBe(false);
    expect(clr.needsWorkOrder).toBe(true);
  });

  it('clearDvir REJECTS when a required field (workOrderNumber / comment) is missing', async () => {
    const r1 = await lifecycle.clearDvir({ aaid: AAID, dvirId: 'dv1', component: 'TIRES', version: 1, outcome: 'REPAIRS_MADE', comment: 'x' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/workOrderNumber required/);
    const r2 = await lifecycle.clearDvir({ aaid: AAID, dvirId: 'dv1', component: 'TIRES', version: 1, outcome: 'REPAIRS_MADE', workOrderNumber: 'WR-1' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/comment required/);
    const r3 = await lifecycle.clearDvir({ aaid: AAID, dvirId: 'dv1', component: 'TIRES', version: 1, workOrderNumber: 'WR-1', comment: 'x' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/outcome required/);
  });

  it('setLifecycleActiveWithDvir clears a blocking DVIR then flips to ACTIVE', async () => {
    let dvirCleared = false;
    let putAttempts = 0;
    const openResp = { components: [{ name: 'TIRES', items: [{ dvirId: 'dv1', component: 'TIRES', condition: 'NOT_DRIVABLE', lifecycle: 'OPEN_ISSUE', dvirVersion: 2 }] }] };
    aap.apiGet.mockImplementation(async (p) => {
      if (/userInterface\/fields/.test(p)) return { userInterfaceFieldDefinitionMap: { lifecycleState: { values: ['ACTIVE', 'UNAVAILABLE'] }, lifecycleStateReason: { values: lifecycle.SUPPORTED_REASONS } } };
      if (/\/dvir\//.test(p) && /openIssuesOnly=true/.test(p)) return dvirCleared ? { components: [] } : openResp;
      return { components: [] };
    });
    vi.spyOn(aap, 'apiPost').mockImplementation(async () => { dvirCleared = true; return { hasOpenIssues: false, lifecycle: 'CLOSED_NO_DRIVER_INSPECTION_REQUIRED' }; });
    // First PUT (before DVIR clear) succeeds here too, but we simulate the real
    // sequence: the module clears DVIRs when the first flip isn't verified.
    aap.apiPut.mockImplementation(async (p, body) => {
      putAttempts++;
      const a = body.asset;
      // Simulate AAP refusing the flip until the DVIR is cleared.
      if (!dvirCleared) return { ...FAKE_ASSET }; // unchanged -> not verified -> triggers DVIR clear
      FAKE_ASSET.lifecycleState = a.lifecycleState; FAKE_ASSET.lifecycleStateReason = a.lifecycleStateReason; FAKE_ASSET.version += 1;
      return { ...FAKE_ASSET };
    });

    const r = await lifecycle.setLifecycleActiveWithDvir({ unit: '324040', reason: 'HEALTHY' });
    expect(r.status).toBe('done');
    expect(r.verified).toBe(true);
    expect(r.to.state).toBe('ACTIVE');
    expect(dvirCleared).toBe(true);                       // DVIR was cleared as a pre-step
    expect(putAttempts).toBeGreaterThanOrEqual(2);        // flip retried after clear
  });
});
