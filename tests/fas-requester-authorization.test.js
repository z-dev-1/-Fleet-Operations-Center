import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-reqauth-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const executor = require('../src/orcha/fas/executor');

const APPROVER = { slackId: 'operator', name: 'Operator', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: ['*'], permittedRequestTypes: ['unit_status','repair_update','follow_up','report','process_question','lifecycle_change','create_wr'] };

function snap(overrides) {
  return Object.assign({ slackId: 'U_C', contactId: 'c1', identityType: 'carrier', enabled: true,
    operators: ['TUZR'], domiciles: [], permittedRequestTypes: ['unit_status','repair_update','follow_up','lifecycle_change'],
    lifecyclePermission: 'not_allowed' }, overrides || {});
}

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' },
    { equipmentId: '999999', operator: 'SAPB', domicileSite: 'EWR9', lifecycleState: 'Active' },
  ] });
  store.save('fasAuditLog', []); store.save('fasIdempotency', {}); store.save('notesStore', {});
}
beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const AAP = 'https://aap-na.corp.amazon.com/v2/asset/x';

describe('Part 5: original-requester authorization (operator Approve cannot bypass it)', () => {
  it('carrier with lifecyclePermission=not_allowed: BLOCKED even when the operator approves', async () => {
    const res = await executor.executeVerified('MOVE_UNIT', { unit: '320160', state: 'Active', assetUrl: AAP },
      { profile: APPROVER, requesterSnapshot: snap({ lifecyclePermission: 'not_allowed' }) });
    expect(res.status).toBe('blocked');
    expect(res.error).toMatch(/requester not authorized/i);
    expect(res.requesterResult).toBe('lifecycle:not_allowed');
  });

  it('carrier with lifecyclePermission=may_request: requester gate passes (execution then subject to verify)', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT', { unit: '320160', state: 'Active', assetUrl: AAP },
      { profile: APPROVER, requesterSnapshot: snap({ lifecyclePermission: 'may_request' }) });
    // Requester gate passed -> not blocked-requester. Verification defers
    // (no live AAP read-back in tests) -> verifying, NOT a false success.
    expect(res.status).not.toBe('blocked');
    expect(['verifying', 'done']).toContain(res.status);
  });

  it('trusted_autonomous requester gate also passes (explicit per-contact)', async () => {
    const sl = require('../src/scrapers/setLifecycle');
    vi.spyOn(sl, 'setLifecycleState').mockResolvedValue({ success: true });
    const res = await executor.executeVerified('MOVE_UNIT', { unit: '320160', state: 'Active', assetUrl: AAP },
      { profile: APPROVER, requesterSnapshot: snap({ lifecyclePermission: 'trusted_autonomous' }) });
    expect(res.status).not.toBe('blocked');
  });

  it('operator Approve cannot execute for a requester who lacks the request type (follow_up)', async () => {
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '320160', entry: 'note' },
      { profile: APPROVER, requesterSnapshot: snap({ permittedRequestTypes: ['unit_status'] }) }); // no follow_up
    expect(res.status).toBe('blocked');
    expect(res.requesterResult).toBe('request-type:denied');
  });

  it('requester out of scope is blocked even if the operator approves', async () => {
    // TUZR carrier requesting an action on a SAPB unit (999999).
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '999999', entry: 'x' },
      { profile: APPROVER, requesterSnapshot: snap({ permittedRequestTypes: ['unit_status','follow_up'], operators: ['TUZR'] }) });
    expect(res.status).toBe('blocked');
    expect(res.requesterResult).toMatch(/scope/);
  });

  it('internal operator-initiated action (no requester snapshot) proceeds normally', async () => {
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '320160', entry: 'internal note' },
      { profile: APPROVER });
    expect(res.status).toBe('done');
  });

  it('a permitted requester follow-up on their own unit runs and audits the chain', async () => {
    const res = await executor.executeVerified('ADD_TIMELINE', { unit: '320160', entry: 'carrier note' },
      { profile: APPROVER, requesterSnapshot: snap({ permittedRequestTypes: ['unit_status','follow_up'], operators: ['TUZR'] }) });
    expect(res.status).toBe('done');
    const audit = store.load('fasAuditLog', []);
    const done = audit.find(a => a.action === 'ADD_TIMELINE' && a.status === 'done');
    expect(done).toBeTruthy();
    expect(done.requester).toBe('U_C');
    expect(done.contactId).toBe('c1');
    expect(done.identityType).toBe('carrier');
    expect(done.approver).toBe('operator');
  });
});
