import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-d-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const executor = require('../src/orcha/fas/executor');
const actions = require('../src/orcha/fas/action-registry');

const INTERNAL = { slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: ['*'], permittedRequestTypes: ['follow_up','lifecycle_change','create_wr','report','unit_status'] };
const CARRIER_NO_LC = { slackId: 'U_C', name: 'Carrier', type: 'carrier', operators: ['TUZR'], domiciles: ['ABE40'],
  allowedDataCategories: ['unit_status'], permittedRequestTypes: ['unit_status','follow_up'] };

function reset() {
  store.save('notesStore', {});
  store.save('reminders', []);
  store.save('fasApprovalQueue', []);
  store.save('fasAuditLog', []);
  store.save('fasConfig', null);
  store.save('fasCases', {});
  // Seed the units used by the MOVE_UNIT routing tests as power units (Day Cab)
  // so the code-level power-unit gate passes and these tests exercise ROUTING.
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '1', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active' },
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active' },
  ] });
}
beforeEach(() => { reset(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS Stage D — action registry + levels', () => {
  it('classifies action risk levels correctly', () => {
    expect(actions.actionLevel('ADD_TIMELINE')).toBe('low');
    expect(actions.actionLevel('MOVE_UNIT')).toBe('approval');
    expect(actions.actionLevel('SUBMIT_WORK_REQUEST')).toBe('approval');
    expect(actions.actionLevel('SEND_SLACK_MESSAGE')).toBe('approval');
  });
});

describe('FAS Stage D — executeVerified runs then verifies', () => {
  it('ADD_TIMELINE writes and verifies by reading back', async () => {
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '320160', entry: '09/02 - parts ordered' }, { profile: INTERNAL });
    expect(res.status).toBe('done');
    expect(res.verified).toBe(true);
    const ns = store.load('notesStore', {});
    expect(ns['320160'].timeline).toContain('parts ordered');
  });

  it('reports failed (not done) when the action run fails', async () => {
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '', entry: '' }, { profile: INTERNAL });
    expect(res.status).toBe('failed');
    expect(res.verified).toBeUndefined();
  });
});

describe('FAS Stage D — routing by mode + level + authorization', () => {
  it('shadow mode executes nothing (records only)', async () => {
    config.save({ enabled: true, mode: 'shadow' });
    const r = await executor.routeAction('ADD_TIMELINE', { unit: '1', entry: 'x' }, { profile: INTERNAL });
    expect(r.outcome).toBe('shadow');
    expect(store.load('notesStore', {})['1']).toBeUndefined(); // not written
  });

  it('approval mode queues every action (nothing auto-executed)', async () => {
    config.save({ enabled: true, mode: 'approval' });
    const r = await executor.routeAction('ADD_TIMELINE', { unit: '1', entry: 'x' }, { profile: INTERNAL });
    expect(r.outcome).toBe('queued');
    expect(store.load('notesStore', {})['1']).toBeUndefined(); // not executed yet
    expect(executor.getQueue('pending')).toHaveLength(1);
  });

  it('autonomous auto-runs a low-risk action ONLY if whitelisted', async () => {
    config.save({ enabled: true, mode: 'autonomous', approvedAutomaticActions: [] });
    let r = await executor.routeAction('ADD_TIMELINE', { unit: '1', entry: 'x' }, { profile: INTERNAL });
    expect(r.outcome).toBe('queued'); // not whitelisted -> still queued
    config.save({ approvedAutomaticActions: ['ADD_TIMELINE'] });
    r = await executor.routeAction('ADD_TIMELINE', { unit: '2', entry: 'y' }, { profile: INTERNAL });
    expect(r.outcome).toBe('executed');
    expect(r.detail.status).toBe('done');
  });

  it('approval-level action is queued even in autonomous mode', async () => {
    config.save({ enabled: true, mode: 'autonomous', approvedAutomaticActions: ['MOVE_UNIT'] });
    const r = await executor.routeAction('MOVE_UNIT', { unit: '1', state: 'Active' }, { profile: INTERNAL });
    expect(r.outcome).toBe('queued'); // approval-level never auto-runs
  });

  it('blocks an action the sender is not authorized to request', async () => {
    config.save({ enabled: true, mode: 'approval' });
    const r = await executor.routeAction('MOVE_UNIT', { unit: '1', state: 'Active' }, { profile: CARRIER_NO_LC });
    expect(r.outcome).toBe('blocked'); // carrier lacks lifecycle_change permission
  });
});

describe('FAS Stage D — approve / reject queue flow', () => {
  it('approving a queued low-risk action executes + verifies it', async () => {
    config.save({ enabled: true, mode: 'approval' });
    await executor.routeAction('ADD_TIMELINE', { unit: '55', entry: '09/02 - towed in' }, { profile: INTERNAL });
    const q = executor.getQueue('pending');
    expect(q).toHaveLength(1);
    const res = await executor.approveQueued(q[0].id, { profile: INTERNAL });
    expect(res.ok).toBe(true);
    expect(store.load('notesStore', {})['55'].timeline).toContain('towed in');
    expect(executor.getQueue('done')).toHaveLength(1);
  });

  it('rejecting a queued action does not execute it', async () => {
    config.save({ enabled: true, mode: 'approval' });
    await executor.routeAction('ADD_TIMELINE', { unit: '77', entry: 'x' }, { profile: INTERNAL });
    const q = executor.getQueue('pending');
    executor.rejectQueued(q[0].id);
    expect(store.load('notesStore', {})['77']).toBeUndefined();
    expect(executor.getQueue('rejected')).toHaveLength(1);
  });
});
