import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-idemrec-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const executor = require('../src/orcha/fas/executor');
const actions = require('../src/orcha/fas/action-registry');

const INTERNAL = { slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: ['*'], permittedRequestTypes: ['follow_up','lifecycle_change','create_wr','unit_status'] };

function reset() {
  store.save('notesStore', {}); store.save('reminders', []);
  store.save('fasAuditLog', []); store.save('fasIdempotency', {});
}
beforeEach(() => { reset(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const idemKey = (name, args) => actions.getAction(name).idempotencyKey(args);

describe('Part 4: in-flight protection + lease recovery + reconciliation', () => {
  it('blocks a duplicate while an action is claimed/executing (live lease)', () => {
    const key = idemKey('ADD_TIMELINE', { unit: '320160', entry: 'x' });
    // Simulate a live in-flight claim.
    store.save('fasIdempotency', { [key]: { status: 'executing', at: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60000).toISOString() } });
    const block = executor._idemBlock(key);
    expect(block.blocked).toBe(true);
    expect(block.reason).toMatch(/in-flight/i);
  });

  it('does NOT re-run a verifying action (awaiting read-back)', () => {
    const key = idemKey('MOVE_UNIT', { unit: '320160', state: 'Active', reason: 'x' });
    store.save('fasIdempotency', { [key]: { status: 'verifying', at: new Date().toISOString() } });
    expect(executor._idemBlock(key).blocked).toBe(true);
    expect(executor._claimIdem(key)).toBe(false); // cannot re-claim
  });

  it('an EXPIRED lease is recoverable (not permanently blocked)', () => {
    const key = idemKey('ADD_TIMELINE', { unit: '320160', entry: 'x' });
    store.save('fasIdempotency', { [key]: { status: 'executing', at: new Date(Date.now() - 10 * 60000).toISOString(), leaseUntil: new Date(Date.now() - 5 * 60000).toISOString() } });
    expect(executor._idemBlock(key).blocked).toBe(false); // lease expired -> recoverable
    expect(executor._claimIdem(key)).toBe(true);          // can be re-claimed
  });

  it('reconcileInFlight marks expired in-flight claims recoverable after restart', () => {
    const key = idemKey('ADD_TIMELINE', { unit: '320160', entry: 'x' });
    store.save('fasIdempotency', { [key]: { status: 'claimed', at: new Date(Date.now() - 10 * 60000).toISOString(), leaseUntil: new Date(Date.now() - 60000).toISOString() } });
    const res = executor.reconcileInFlight();
    expect(res.expired).toBe(1);
    expect(store.load('fasIdempotency', {})[key].status).toBe('recoverable');
  });

  it('a completed action stays blocked (no re-apply)', async () => {
    const r1 = await executor.executeVerified('ADD_TIMELINE', { unit: '320160', entry: 'parts ordered' }, { profile: INTERNAL });
    expect(r1.status).toBe('done');
    const r2 = await executor.executeVerified('ADD_TIMELINE', { unit: '320160', entry: 'parts ordered' }, { profile: INTERNAL });
    expect(r2.idempotent).toBe(true);
    expect(r2.status).toBe('done');
    const tl = store.load('notesStore', {})['320160'].timeline.split('\n').filter(l => l.includes('parts ordered'));
    expect(tl.length).toBe(1); // not duplicated
  });

  it('clearIdem allows manual retry of a FAILED action but not a done one', () => {
    const key = idemKey('ADD_TIMELINE', { unit: '320160', entry: 'x' });
    store.save('fasIdempotency', { [key]: { status: 'failed', at: new Date().toISOString() } });
    executor.clearIdem(key);
    expect(store.load('fasIdempotency', {})[key]).toBeUndefined(); // cleared -> retryable
    // done is protected from clearing
    store.save('fasIdempotency', { [key]: { status: 'done', at: new Date().toISOString() } });
    executor.clearIdem(key);
    expect(store.load('fasIdempotency', {})[key].status).toBe('done');
  });
});
