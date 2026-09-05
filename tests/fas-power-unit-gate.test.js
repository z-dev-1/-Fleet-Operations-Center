// tests/fas-power-unit-gate.test.js
//
// Spec v2: a CODE-LEVEL power-unit gate must block MOVE_UNIT / SUBMIT_WORK_REQUEST
// for any equipment that is not a box truck, day-cab tractor, or sleeper-cab
// tractor — determined ONLY from the verified unit record, and enforced even if
// the AI proposes the action. Power units still pass. Unresolved type blocks
// (research/clarify, never act).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-pug-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const executor = require('../src/orcha/fas/executor');

const INTERNAL = { slackId: 'op', name: 'Op', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: ['*'], permittedRequestTypes: ['unit_status','repair_update','follow_up','report','process_question','lifecycle_change','create_wr'] };
const AAP = 'https://aap-na.corp.amazon.com/v2/asset/x';

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: 'DAYCAB1', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Unavailable' },
    { equipmentId: 'BOX1', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Box Truck', bodyType: 'Box Truck', lifecycleState: 'Unavailable' },
    { equipmentId: 'SLEEP1', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Sleeper', lifecycleState: 'Unavailable' },
    { equipmentId: 'TRAILER1', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Trailer', bodyType: '', lifecycleState: 'Unavailable' },
    { equipmentId: 'HOSTLER1', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Hostler', bodyType: '', lifecycleState: 'Unavailable' },
    { equipmentId: 'NOTYPE1', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' }, // no assetType/bodyType
  ] });
  store.save('fasAuditLog', []); store.save('fasIdempotency', {}); store.save('notesStore', {});
}
beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('classifyEquipment — from the verified record only', () => {
  it('classifies power units and non-power-units correctly', () => {
    expect(executor.classifyEquipment({ assetType: 'Tractor', bodyType: 'Day Cab' })).toMatchObject({ powerUnit: true, klass: 'day-cab' });
    expect(executor.classifyEquipment({ bodyType: 'Box Truck' })).toMatchObject({ powerUnit: true, klass: 'box-truck' });
    expect(executor.classifyEquipment({ bodyType: 'Sleeper' })).toMatchObject({ powerUnit: true, klass: 'sleeper-cab' });
    expect(executor.classifyEquipment({ assetType: 'Trailer' })).toMatchObject({ powerUnit: false, klass: 'trailer' });
    expect(executor.classifyEquipment({ assetType: 'Hostler' })).toMatchObject({ powerUnit: false, klass: 'hostler' });
    expect(executor.classifyEquipment({ assetType: 'Container' })).toMatchObject({ powerUnit: false, klass: 'container' });
    expect(executor.classifyEquipment({})).toMatchObject({ powerUnit: false, resolved: false });
  });
});

describe('power-unit gate blocks MOVE_UNIT on non-power-units (even if AI proposes it)', () => {
  it('MOVE_UNIT on a TRAILER is blocked at execution', async () => {
    const res = await executor.executeVerified('MOVE_UNIT', { unit: 'TRAILER1', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.status).toBe('blocked');
    expect(res.powerUnitBlock).toBe('power-unit:not-in-scope');
    expect(res.klass).toBe('trailer');
  });
  it('MOVE_UNIT on a HOSTLER is blocked (out of Zila power-unit scope)', async () => {
    const res = await executor.executeVerified('MOVE_UNIT', { unit: 'HOSTLER1', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.status).toBe('blocked');
    expect(res.klass).toBe('hostler');
  });
  it('SUBMIT_WORK_REQUEST on a trailer is blocked', async () => {
    const res = await executor.executeVerified('SUBMIT_WORK_REQUEST', { unit: 'TRAILER1', payload: {} }, { profile: INTERNAL });
    expect(res.status).toBe('blocked');
    expect(res.powerUnitBlock).toBe('power-unit:not-in-scope');
  });
  it('routeAction (proposal path) also blocks a non-power-unit before queueing', async () => {
    store.save('fasConfig', { enabled: true, mode: 'approval' });
    const res = await executor.routeAction('MOVE_UNIT', { unit: 'HOSTLER1', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.outcome).toBe('blocked');
    expect(res.powerUnitBlock).toBe('power-unit:not-in-scope');
  });
});

describe('power-unit gate: unresolved equipment type does NOT act', () => {
  it('MOVE_UNIT on a unit with no recorded type is blocked as unresolved (research first)', async () => {
    const res = await executor.executeVerified('MOVE_UNIT', { unit: 'NOTYPE1', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.status).toBe('blocked');
    expect(res.powerUnitBlock).toBe('power-unit:unresolved');
  });
  it('MOVE_UNIT on a unit not in fleet data is blocked as unresolved (never inferred)', async () => {
    const res = await executor.executeVerified('MOVE_UNIT', { unit: 'GHOST9', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.status).toBe('blocked');
    expect(res.powerUnitBlock).toBe('power-unit:unresolved');
  });
});

describe('power units still pass the gate (not blocked by power-unit reason)', () => {
  it('MOVE_UNIT on a day cab passes the power-unit gate (proceeds to verify)', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT', { unit: 'DAYCAB1', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.status).not.toBe('blocked');
    expect(res.powerUnitBlock).toBeUndefined();
  });
  it('MOVE_UNIT on a box truck passes the power-unit gate', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT', { unit: 'BOX1', state: 'Active', assetUrl: AAP }, { profile: INTERNAL });
    expect(res.status).not.toBe('blocked');
  });
});

describe('non-fleet-mutating actions are NOT power-unit gated', () => {
  it('ADD_TIMELINE on any unit is not blocked by the power-unit gate', async () => {
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: 'TRAILER1', entry: 'note' }, { profile: INTERNAL });
    // ADD_TIMELINE is not a fleet mutation; the power-unit gate must not touch it.
    expect(res.powerUnitBlock).toBeUndefined();
    expect(res.status).toBe('done');
  });
});
