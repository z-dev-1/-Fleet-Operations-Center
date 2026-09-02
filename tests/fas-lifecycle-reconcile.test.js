import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-lcrec-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const executor = require('../src/orcha/fas/executor');
const actions = require('../src/orcha/fas/action-registry');

const key = actions.getAction('MOVE_UNIT').idempotencyKey({ unit: '320160', state: 'Active', reason: 'repair complete' });

beforeEach(() => { store.save('fasIdempotency', {}); store.save('fasAuditLog', []); store.save('fleetData', {}); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 5: MOVE_UNIT verifying reconcile against synced fleet data', () => {
  it('resolves a verifying MOVE_UNIT to DONE when synced lifecycle matches', () => {
    store.save('fasIdempotency', { [key]: { status: 'verifying', at: new Date().toISOString(), action: 'MOVE_UNIT', target: { unit: '320160', state: 'Active' } } });
    store.save('fleetData', { rows: [{ equipmentId: '320160', lifecycleState: 'Active', lifecycleReason: 'Healthy' }] });
    const rec = executor.reconcileVerifyingLifecycle();
    expect(rec.resolved).toBe(1);
    expect(store.load('fasIdempotency', {})[key].status).toBe('done');
  });

  it('resolves to FAILED when synced lifecycle disagrees', () => {
    store.save('fasIdempotency', { [key]: { status: 'verifying', at: new Date().toISOString(), action: 'MOVE_UNIT', target: { unit: '320160', state: 'Active' } } });
    store.save('fleetData', { rows: [{ equipmentId: '320160', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair' }] });
    const rec = executor.reconcileVerifyingLifecycle();
    expect(rec.failed).toBe(1);
    expect(store.load('fasIdempotency', {})[key].status).toBe('failed');
  });

  it('leaves it verifying when the unit is not yet in synced data', () => {
    store.save('fasIdempotency', { [key]: { status: 'verifying', at: new Date().toISOString(), action: 'MOVE_UNIT', target: { unit: '320160', state: 'Active' } } });
    store.save('fleetData', { rows: [] });
    const rec = executor.reconcileVerifyingLifecycle();
    expect(rec.resolved).toBe(0);
    expect(rec.failed).toBe(0);
    expect(store.load('fasIdempotency', {})[key].status).toBe('verifying');
  });
});

describe('Part 5: readLifecycle module', () => {
  it('exports readLifecycle and returns null for a non-AAP url (no session/electron in tests)', async () => {
    const mod = require('../src/scrapers/readLifecycle');
    expect(typeof mod.readLifecycle).toBe('function');
    const r = await mod.readLifecycle('https://evil.example/x');
    expect(r).toBeNull(); // rejects non-aap url up front
  });
});
