import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-idmodel-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const profiles = require('../src/orcha/fas/sender-profiles');
const cb = require('../src/services/contact-book');
const executor = require('../src/orcha/fas/executor');

function seedFleet() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' },
    { equipmentId: '999999', operator: 'SAPB', domicileSite: 'EWR9', lifecycleState: 'Active' },
  ] });
  store.save('fasAuditLog', []); store.save('fasIdempotency', {}); store.save('notesStore', {});
}
beforeEach(() => { store.save('contacts', []); store.save('contactsTombstones', []); seedFleet(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Simplified 4-identity permission model', () => {
  it('only four identities are valid; manager is dropped', () => {
    expect(cb.VALID_IDENTITY).toEqual(['internal', 'carrier', 'vendor', 'unknown']);
    // A submitted 'manager' is coerced to unknown.
    const r = cb.upsert({ slackId: 'U1', identityType: 'manager' });
    expect(store.load('contacts', []).find(c => c.id === r.id).identityType).toBe('unknown');
  });

  it("unknown resolves to ALL scope ('*') and matches every unit", () => {
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U_UNK', name: 'X', identityType: 'unknown' }]);
    const p = profiles.resolveSender('U_UNK');
    expect(p.operators).toEqual(['*']);
    expect(profiles.scopeUnitForSender(p, { operator: 'TUZR', domicileSite: 'ABE40' })).toBe(true);
    expect(profiles.scopeUnitForSender(p, { operator: 'SAPB', domicileSite: 'EWR9' })).toBe(true);
    // ...but unknown may NOT change lifecycle or create WRs automatically.
    expect(profiles.canRequest(p, 'lifecycle_change')).toBe(false);
    expect(profiles.canRequest(p, 'create_wr')).toBe(false);
  });

  it('carrier with EMPTY scope sees NO units (empty external scope = no access)', () => {
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U_C', name: 'C', identityType: 'carrier', operators: [], domiciles: [] }]);
    const p = profiles.resolveSender('U_C');
    expect(profiles.scopeUnitForSender(p, { operator: 'TUZR', domicileSite: 'ABE40' })).toBe(false);
  });

  it('internal with no scope defaults to all fleet, but can be narrowed', () => {
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U_I', name: 'I', identityType: 'internal' }]);
    let p = profiles.resolveSender('U_I');
    expect(profiles.scopeUnitForSender(p, { operator: 'SAPB', domicileSite: 'EWR9' })).toBe(true);
    // Narrow internal to TUZR only -> SAPB now denied.
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U_I', name: 'I', identityType: 'internal', operators: ['TUZR'] }]);
    p = profiles.resolveSender('U_I');
    expect(profiles.scopeUnitForSender(p, { operator: 'TUZR', domicileSite: 'ABE40' })).toBe(true);
    expect(profiles.scopeUnitForSender(p, { operator: 'SAPB', domicileSite: 'EWR9' })).toBe(false);
  });

  it('vendor: lifecycle + create-WR are LOCKED to not_allowed even if set otherwise', () => {
    store.save('contacts', [{ id: 'c1', type: 'slack', slackId: 'U_V', name: 'V', identityType: 'vendor',
      operators: ['TUZR'], lifecyclePermission: 'trusted_autonomous', createWrPermission: 'trusted_autonomous' }]);
    const p = profiles.resolveSender('U_V');
    expect(p.lifecyclePermission).toBe('not_allowed');
    expect(p.createWrPermission).toBe('not_allowed');
    expect(profiles.canRequest(p, 'lifecycle_change')).toBe(false);
    expect(profiles.canRequest(p, 'create_wr')).toBe(false);
    // ...but a scoped vendor still sees data for its scope.
    expect(profiles.scopeUnitForSender(p, { operator: 'TUZR', domicileSite: 'ABE40' })).toBe(true);
    expect(profiles.scopeUnitForSender(p, { operator: 'SAPB', domicileSite: 'EWR9' })).toBe(false);
  });

  it('the service sanitize also forces the vendor lock at write time', () => {
    const r = cb.upsert({ slackId: 'U_V2', identityType: 'vendor', lifecyclePermission: 'may_request', createWrPermission: 'may_request' });
    const c = store.load('contacts', []).find(x => x.id === r.id);
    expect(c.lifecyclePermission).toBe('not_allowed');
    expect(c.createWrPermission).toBe('not_allowed');
  });

  it('createWrPermission is a valid 3-state; bad values coerce to not_allowed', () => {
    const r = cb.upsert({ slackId: 'U_W', identityType: 'carrier', createWrPermission: 'god_mode' });
    expect(store.load('contacts', []).find(x => x.id === r.id).createWrPermission).toBe('not_allowed');
    cb.update({ id: r.id, createWrPermission: 'trusted_autonomous' });
    expect(store.load('contacts', []).find(x => x.id === r.id).createWrPermission).toBe('trusted_autonomous');
  });

  it("scope stores '*' as the all wildcard (collapses mixed input)", () => {
    const r = cb.upsert({ slackId: 'U_A', identityType: 'internal', operators: ['tuzr', '*', 'sapb'] });
    expect(store.load('contacts', []).find(x => x.id === r.id).operators).toEqual(['*']);
  });

  const APPROVER = { slackId: 'op', name: 'Op', type: 'internal', operators: [], domiciles: [],
    allowedDataCategories: ['*'], permittedRequestTypes: ['unit_status','repair_update','follow_up','report','process_question','lifecycle_change','create_wr'] };
  const snap = (o) => Object.assign({ slackId: 'U_C', contactId: 'c', identityType: 'carrier', enabled: true,
    operators: ['TUZR'], domiciles: [], permittedRequestTypes: ['unit_status','create_wr'],
    lifecyclePermission: 'not_allowed', createWrPermission: 'not_allowed' }, o || {});

  it('requester create-WR is gated by createWrPermission (not the request-type list)', async () => {
    // create_wr in permittedRequestTypes but createWrPermission not_allowed -> blocked.
    const res = await executor.executeVerified('SUBMIT_WORK_REQUEST', { unit: '320160', payload: {} },
      { profile: APPROVER, requesterSnapshot: snap({ createWrPermission: 'not_allowed' }) });
    expect(res.status).toBe('blocked');
    expect(res.requesterResult).toBe('create_wr:not_allowed');
  });

  it('requester create-WR with may_request passes the requester gate', async () => {
    const res = await executor.executeVerified('SUBMIT_WORK_REQUEST', { unit: '320160', payload: {} },
      { profile: APPROVER, requesterSnapshot: snap({ createWrPermission: 'may_request' }) });
    // Requester gate passed -> not a requester-block (execution may still fail
    // downstream in the test env, but it must NOT be 'create_wr:not_allowed').
    expect(res.requesterResult).not.toBe('create_wr:not_allowed');
  });
});
