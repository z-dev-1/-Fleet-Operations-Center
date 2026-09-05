import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-unitauthz-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const executor = require('../src/orcha/fas/executor');

const INTERNAL = { slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: ['*'], permittedRequestTypes: ['follow_up','lifecycle_change','create_wr','unit_status'] };
// Carrier permitted to REQUEST follow-ups, scoped to operator TUZR.
const CARRIER_TUZR = { slackId: 'U_C', name: 'Carrier', type: 'carrier', operators: ['TUZR'], domiciles: [],
  allowedDataCategories: ['unit_status'], permittedRequestTypes: ['unit_status','follow_up'] };

function seed(mode) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active' }, // TUZR
    { equipmentId: '622072', operator: 'SAPB', domicileSite: 'EWR45', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active' }, // SAPB (out of carrier scope)
  ] });
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('notesStore', {});
  store.save('fasIdempotency', {});
  store.save('fasConfig', { enabled: true, mode: mode || 'approval', approvedAutomaticActions: [] });
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 11: unit-level action authorization', () => {
  it('carrier can request a follow-up on THEIR OWN unit (in scope)', async () => {
    const r = await executor.routeAction('ADD_TIMELINE', { unit: '320160', entry: 'note' }, { profile: CARRIER_TUZR });
    expect(r.outcome).toBe('queued'); // permitted + in scope -> queued (approval mode)
  });

  it('carrier is DENIED a follow-up on another operator\'s unit (out of scope)', async () => {
    const r = await executor.routeAction('ADD_TIMELINE', { unit: '622072', entry: 'note' }, { profile: CARRIER_TUZR });
    expect(r.outcome).toBe('blocked');
    expect(r.detail).toMatch(/scope/i);
  });

  it('carrier is DENIED an unknown unit (not found / not in scope)', async () => {
    const r = await executor.routeAction('ADD_TIMELINE', { unit: '999999', entry: 'note' }, { profile: CARRIER_TUZR });
    expect(r.outcome).toBe('blocked');
  });

  it('lifecycle change (MOVE_UNIT) requires internal — carrier blocked even with lifecycle permission', async () => {
    // Even a carrier explicitly granted may_request for lifecycle is blocked
    // from INITIATING the mutation directly — MOVE_UNIT is operator-only. (The
    // carrier can REQUEST it; an operator then approves — see requester-auth.)
    const carrierWithLC = { ...CARRIER_TUZR, permittedRequestTypes: ['unit_status','follow_up','lifecycle_change'], lifecyclePermission: 'may_request' };
    const r = await executor.routeAction('MOVE_UNIT', { unit: '320160', state: 'Active' }, { profile: carrierWithLC });
    expect(r.outcome).toBe('blocked');
    expect(r.detail).toMatch(/internal/i);
  });

  it('internal user is NOT blocked on a unit missing from the local cache', async () => {
    const r = await executor.routeAction('ADD_TIMELINE', { unit: 'NOT-IN-CACHE', entry: 'note' }, { profile: INTERNAL });
    expect(r.outcome).toBe('queued'); // internal has fleet-wide authority
  });

  it('execution-time re-check blocks an out-of-scope carrier action', async () => {
    // Even if something reached executeVerified directly, the re-check denies it.
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '622072', entry: 'x' }, { profile: CARRIER_TUZR });
    expect(res.status).toBe('blocked');
  });

  it('queued action stores a permission snapshot', async () => {
    await executor.routeAction('ADD_TIMELINE', { unit: '320160', entry: 'note' }, { profile: CARRIER_TUZR });
    const q = executor.getQueue('pending');
    expect(q[0].permissionSnapshot).toBeTruthy();
    expect(q[0].permissionSnapshot.operators).toContain('TUZR');
  });
});
