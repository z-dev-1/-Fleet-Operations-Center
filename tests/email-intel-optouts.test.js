// tests/email-intel-optouts.test.js — F2-01 (plan Section 2.1): the existing Email Triage opt-outs
// autoApplyUnitUpdates and readyDmSuggested are honored by the intel path. Four-combination matrix at
// runIntelScan level, plus the user-approval and read-once rules. Flags: Phase C (timelineWrites effective).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { phaseCWorld, fact } from './fixtures/email-intel/phase-c.js';
const require = createRequire(import.meta.url);
const triage = require('../src/scrapers/email_triage');

let w = null;
afterEach(() => { if (w) w.cleanup(); w = null; vi.restoreAllMocks(); });

const READY_FACT = (unit) => fact({ kind: 'pickup_readiness', item: null, value: 'Ready for pickup', state: 'ready', date: null, evidence: 'unit ' + unit + ' is ready for pickup' });
const AUTO_OFF = 'auto-apply is off in Email Triage settings';

/** One scan with two ready emails: 40456 is confirmed ready by canonical state, 40999 has no canonical record. */
async function scenario(autoApplyUnitUpdates, readyDmSuggested) {
  w = phaseCWorld(undefined, { triageConfig: { autoApplyUnitUpdates, readyDmSuggested } });
  w.store.save('canonicalState', { units: { '40456': { status: 'ready_for_pickup', repairPhase: 'complete' } } });
  w.rules.push({ unit: '40456', fact: READY_FACT('40456') }, { unit: '40999', fact: READY_FACT('40999') });
  const res = await w.scan([
    w.cap({ subject: 'Unit 40456', conversationId: 'conv-r1', body: 'Good news, unit 40456 is ready for pickup at the dealer.' }),
    w.cap({ subject: 'Unit 40999', conversationId: 'conv-r2', body: 'Good news, unit 40999 is ready for pickup at the dealer.' }),
  ]);
  const ref = (unit) => res.emails.flatMap((e) => e.unitRefs).find((u) => u.unit === unit);
  return { res, ref };
}

describe('F2-01 opt-out matrix (autoApplyUnitUpdates x readyDmSuggested)', () => {
  it('F2-01 autoApply=on readyDm=on: fact written, ready offered only when verified by canonical', async () => {
    const { res, ref } = await scenario(true, true);
    expect(w.lines('40456')).toHaveLength(1);
    expect(w.lines('40456')[0]).not.toContain('not confirmed');
    expect(w.lines('40999')).toHaveLength(1);
    expect(w.lines('40999')[0]).toContain(' - not confirmed in AAP/Relay');      // unverified ready is worded as such
    expect(ref('40456')).toMatchObject({ ready: true });
    expect(ref('40999')).toMatchObject({ ready: false, readyUnverified: true });
    expect(res.emails.every((e) => e.unitUpdateApplied)).toBe(true);
    expect(w.staged()).toEqual([]);
  });

  it('F2-01 autoApply=off readyDm=on: nothing written, fact staged timeline-disabled with the auto-apply detail, ready offered only when verified', async () => {
    const { res, ref } = await scenario(false, true);
    expect(w.timeline('40456')).toBe('');
    expect(w.timeline('40999')).toBe('');
    expect(w.ledger()).toEqual([]);
    const st = w.staged();
    expect(st).toHaveLength(2);
    for (const s of st) expect(s).toMatchObject({ reason: 'timeline-disabled', detail: AUTO_OFF, state: 'open' });
    expect(ref('40456')).toMatchObject({ ready: true });
    expect(ref('40999')).toMatchObject({ ready: false });
    expect(res.emails.some((e) => e.unitUpdateApplied)).toBe(false);
  });

  it('F2-01 autoApply=on readyDm=off: fact written, unitRefs ready forced false', async () => {
    const { ref } = await scenario(true, false);
    expect(w.lines('40456')).toHaveLength(1);
    expect(w.lines('40999')).toHaveLength(1);
    expect(ref('40456')).toMatchObject({ ready: false, update: 'Pickup: Ready for pickup' });   // the fact stays, the DM offer goes
    expect(ref('40999')).toMatchObject({ ready: false });
  });

  it('F2-01 autoApply=off readyDm=off: nothing written, staged, ready false', async () => {
    const { ref } = await scenario(false, false);
    expect(w.timeline('40456')).toBe('');
    expect(w.staged().map((s) => s.reason)).toEqual(['timeline-disabled', 'timeline-disabled']);
    expect(ref('40456')).toMatchObject({ ready: false });
    expect(ref('40999')).toMatchObject({ ready: false });
  });
});

describe('F2-01 rules around the matrix', () => {
  it('F2-01 user-approved staged item still writes when autoApply is off', async () => {
    await scenario(false, true);
    const confirm = require('../src/email-intel/confirm');
    confirm._resetForTests();
    require('../src/email-intel/executors').registerAll();
    const item = w.staged().find((s) => s.unit === '40456');
    const prep = confirm.prepare('approve-staged', { stagedId: item.stagedId });
    expect(prep.ok).toBe(true);
    expect(prep.summary.detailText).toContain('Line to write: ' + item.proposedLine);
    const r = await confirm.confirm(prep.token, { _dialog: { showMessageBox: async () => ({ response: 1 }) } });
    expect(r).toMatchObject({ ok: true, state: 'applied' });
    expect(w.lines('40456')).toHaveLength(1);
    expect(w.lines('40456')[0]).toMatch(/ \(user-approved\) \[em:[0-9a-f]{8}\]$/);
    expect(w.staged().find((s) => s.stagedId === item.stagedId)).toMatchObject({ state: 'approved', decidedBy: 'user' });
    expect(w.ledger()[0]).toMatchObject({ state: 'applied', userApproved: true });
    // a cancelled native dialog writes nothing
    const other = w.staged().find((s) => s.unit === '40999');
    const p2 = confirm.prepare('approve-staged', { stagedId: other.stagedId });
    expect(await confirm.confirm(p2.token, { _dialog: { showMessageBox: async () => ({ response: 0 }) } })).toEqual({ ok: false, code: 'USER_CANCELLED' });
    expect(w.timeline('40999')).toBe('');
    // the opt-out still holds for later automatic writes
    w.rules.push({ unit: '40123', fact: fact() });
    await w.scan([w.cap({ subject: 'Turbo 40123', conversationId: 'conv-t', body: 'Turbo ETA 11/12 for 40123.' })]);
    expect(w.timeline('40123')).toBe('');
    confirm._resetForTests();
  });

  it('F2-01 config read once per scan', async () => {
    w = phaseCWorld(undefined, { triageConfig: { autoApplyUnitUpdates: false, readyDmSuggested: true } });
    w.rules.push({ unit: '40123', fact: fact() }, { unit: '40456', fact: fact({ evidence: 'Turbo ETA 11/12 for 40456' }) });
    const spy = vi.spyOn(triage, 'getConfig');
    await w.scan([
      w.cap({ subject: 'Turbo 40123', conversationId: 'conv-o1', body: 'Turbo ETA 11/12 for 40123.' }),
      w.cap({ subject: 'Turbo 40456', conversationId: 'conv-o2', body: 'Turbo ETA 11/12 for 40456.' }),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.staged()).toHaveLength(2);                                          // every fact saw the same scan-start value
    // a change made during the scan is used by the NEXT scan only
    spy.mockClear();
    w.store.save('emailTriageConfig', Object.assign({}, triage.DEFAULT_CONFIG, { autoApplyUnitUpdates: true }));
    w.rules.push({ unit: '40789', fact: fact({ evidence: 'Turbo ETA 11/12 for 40789' }) });
    await w.scan([w.cap({ subject: 'Turbo 40789', conversationId: 'conv-o3', body: 'Turbo ETA 11/12 for 40789.' })]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(w.lines('40789')).toHaveLength(1);
  });
});
