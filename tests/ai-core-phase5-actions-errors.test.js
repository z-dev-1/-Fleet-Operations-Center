import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-phase5-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const errors = require('../src/ai/errors');
const actions = require('../src/ai/actions');
const profiles = require('../src/orcha/fas/sender-profiles');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '321060', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/x', openUnplanned: '0', openPlanned: '0' },
    { equipmentId: '321099', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/y' },
    { equipmentId: '321077', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active', lifecycleReason: 'Healthy', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/z', openUnplanned: '1' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Z', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('aiActionReceipts', []);
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const INT = () => profiles.resolveSender('U_INT');

describe('Phase 5 — typed errors (spec §30)', () => {
  it('exposes the standard codes and builds typed errors', () => {
    expect(errors.CODES.EXECUTION_UNCERTAIN).toBe('EXECUTION_UNCERTAIN');
    const e = errors.make('EVIDENCE_INSUFFICIENT');
    expect(e.isAiError).toBe(true);
    expect(errors.is(e, 'EVIDENCE_INSUFFICIENT')).toBe(true);
    expect(errors.is(e, 'TOOL_TIMEOUT')).toBe(false);
  });
  it('normalizes arbitrary errors to typed codes', () => {
    expect(errors.normalize(new Error('request timeout')).code).toBe('TOOL_TIMEOUT');
    expect(errors.normalize(new Error('permission denied')).code).toBe('TOOL_PERMISSION_DENIED');
    expect(errors.normalize(new Error('no backend reachable')).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });
});

describe('Phase 5 — action simulation / dry-run (spec §18)', () => {
  it('simulates a MOVE_UNIT flip: what changes, source, idempotency, no side effect', () => {
    const before = JSON.stringify(store.load('fleetData', {}));
    const sim = actions.simulate({ type: 'MOVE_UNIT', args: { unit: '321060', state: 'Active', reason: 'Healthy' } }, { profile: INT() });
    expect(sim.mutatesSource).toMatch(/AAP/);
    expect(sim.currentState.state).toBe('Unavailable');
    expect(sim.targetState.state).toBe('Active');
    expect(sim.wouldChange).toBe(true);
    expect(sim.idempotent).toBe(false);
    // No side effect.
    expect(JSON.stringify(store.load('fleetData', {}))).toBe(before);
  });

  it('flags a blocked hold state (PM Failed) as a blocker and not allowed', () => {
    const sim = actions.simulate({ type: 'MOVE_UNIT', args: { unit: '321099', state: 'Active' } }, { profile: INT() });
    expect(sim.blockers.some((b) => /PM Failed/i.test(b))).toBe(true);
    expect(sim.allowed).toBe(false);
  });

  it('detects an idempotent no-op when already in target state', () => {
    const sim = actions.simulate({ type: 'MOVE_UNIT', args: { unit: '321077', state: 'Active' } }, { profile: INT() });
    expect(sim.idempotent).toBe(true);
    expect(sim.wouldChange).toBe(false);
  });

  it('flags a possible duplicate WR when the unit already has an open order', () => {
    const sim = actions.simulate({ type: 'SUBMIT_WORK_REQUEST', args: { unit: '321077', payload: {} } }, { profile: INT() });
    expect(sim.blockers.some((b) => /open work order/i.test(b))).toBe(true);
  });
});

describe('Phase 5 — plan validation / expiration (spec §28)', () => {
  it('a fresh plan validates; an expired plan is STALE_PLAN', () => {
    const plan = actions.makePlan({ goal: 'flip', actions: [{ type: 'MOVE_UNIT', args: { unit: '321060', state: 'Active' } }] }, { ttlMs: 10000 });
    expect(actions.validatePlan(plan).ok).toBe(true);
    const expired = { ...plan, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const v = actions.validatePlan(expired);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('STALE_PLAN');
    expect(v.revalidate).toBe(true);
  });

  it('detects evidence drift between planning and execution', () => {
    const ev1 = [{ ok: true, data: { facts: [{ field: 'lifecycleState', value: 'Unavailable', source: 'AAP' }] } }];
    const ev2 = [{ ok: true, data: { facts: [{ field: 'lifecycleState', value: 'Active', source: 'AAP' }] } }];
    const plan = actions.makePlan({ goal: 'x', actions: [], evidence: ev1 });
    expect(actions.validatePlan(plan, { currentEvidence: ev1 }).ok).toBe(true);
    const drift = actions.validatePlan(plan, { currentEvidence: ev2 });
    expect(drift.ok).toBe(false);
    expect(drift.code).toBe('STALE_PLAN');
  });
});

describe('Phase 5 — action receipts (spec §19)', () => {
  it('records a durable receipt and reflects verified=false for an unverified result', () => {
    const r = actions.receiptFromExecutorResult(
      { type: 'MOVE_UNIT', equipmentId: '321060', requestedBy: 'Slack U_INT' },
      { status: 'verifying', verified: false, deferred: true, error: 'awaiting read-back' }
    );
    expect(r.actionId).toBeTruthy();
    expect(r.verified).toBe(false);
    expect(r.status).toBe('verifying');
    expect(actions.getReceipt(r.actionId).equipmentId).toBe('321060');
  });

  it('a verified executor result yields verified=true with source readback', () => {
    const r = actions.receiptFromExecutorResult(
      { type: 'MOVE_UNIT', equipmentId: '321060' },
      { status: 'done', verified: true, evidence: 'AAP read-back confirms lifecycle=Active' }
    );
    expect(r.verified).toBe(true);
    expect(r.sourceReadback.evidence).toMatch(/read-back/);
  });
});
