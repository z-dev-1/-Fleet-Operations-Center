import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const rp = require('../src/scrapers/repair_phase');

describe('repair_phase — vocabulary', () => {
  it('exposes the 19-value repair phase enum and the waitingOn enum', () => {
    expect(rp.REPAIR_PHASES).toHaveLength(19);
    expect(rp.REPAIR_PHASES).toContain('awaiting_approval');
    expect(rp.REPAIR_PHASES).toContain('parts_backordered');
    expect(rp.REPAIR_PHASES).toContain('ready_for_pickup');
    expect(rp.REPAIR_PHASES).toContain('reroute_required');
    expect(rp.WAITING_ON).toContain('approval');
    expect(rp.WAITING_ON).toContain('pickup');
    expect(rp.WAITING_ON).toContain('nobody');
  });

  it('validates enum membership', () => {
    expect(rp.isRepairPhase('awaiting_parts')).toBe(true);
    expect(rp.isRepairPhase('nonsense')).toBe(false);
    expect(rp.isWaitingOn('internal')).toBe(true);
    expect(rp.isWaitingOn('nonsense')).toBe(false);
  });
});

describe('repair_phase — derivePhase (grounded, no over-inference)', () => {
  // The exact spec §3 examples.
  it('"Estimate submitted, awaiting approval" -> awaiting_approval', () => {
    expect(rp.derivePhase('Estimate submitted, awaiting approval')).toBe('awaiting_approval');
  });
  it('"Parts ordered, ETA 10/25" -> awaiting_parts', () => {
    expect(rp.derivePhase('Parts ordered, ETA 10/25')).toBe('awaiting_parts');
  });
  it('"Parts backordered, no ETA" -> parts_backordered', () => {
    expect(rp.derivePhase('Parts backordered, no ETA')).toBe('parts_backordered');
  });
  it('"Unit in bay, repairs underway" -> repair_in_progress', () => {
    expect(rp.derivePhase('Unit in bay, repairs underway')).toBe('repair_in_progress');
  });
  it('"Repairs complete, ready for pickup" -> ready_for_pickup', () => {
    expect(rp.derivePhase('Repairs complete, ready for pickup')).toBe('ready_for_pickup');
  });

  it('does NOT over-infer: "preparing estimate" is awaiting_estimate, not awaiting_approval', () => {
    expect(rp.derivePhase('Diagnosis complete. Preparing estimate.')).toBe('awaiting_estimate');
  });
  it('parts_received advances past awaiting_parts', () => {
    expect(rp.derivePhase('Parts have arrived, repair resuming')).toBe('parts_received');
  });
  it('reroute: vendor cannot perform the repair', () => {
    expect(rp.derivePhase('We cannot perform this repair. Needs OEM dealer.')).toBe('reroute_required');
  });
  it('diagnosis vs diagnosis_complete', () => {
    expect(rp.derivePhase('Unit in for diagnosis')).toBe('diagnosis');
    expect(rp.derivePhase('Diagnosis complete. Turbo failed.')).toBe('diagnosis_complete');
  });

  it('tow-OUT is NEVER read as ready (repair has not started)', () => {
    expect(rp.derivePhase('Asset is ready to be towed out to the dealer')).toBe('awaiting_vendor');
    expect(rp.derivePhase('Unit staged for a tow to the shop')).toBe('awaiting_vendor');
  });

  it('closed is terminal', () => {
    expect(rp.derivePhase('Work order closed, unit picked up', { closed: true })).toBe('closed');
    expect(rp.derivePhase('Unit picked up, invoiced')).toBe('closed');
  });

  it('ambiguous / empty text -> unknown (never guess)', () => {
    expect(rp.derivePhase('')).toBe('unknown');
    expect(rp.derivePhase('some unrelated note about paperwork')).toBe('unknown');
  });
});

describe('repair_phase — deriveWaitingOn', () => {
  it('maps phases to who owes the next move', () => {
    expect(rp.deriveWaitingOn('awaiting_approval')).toBe('approval');
    expect(rp.deriveWaitingOn('awaiting_parts')).toBe('parts');
    expect(rp.deriveWaitingOn('parts_backordered')).toBe('parts');
    expect(rp.deriveWaitingOn('repair_in_progress')).toBe('vendor');
    expect(rp.deriveWaitingOn('ready_for_pickup')).toBe('pickup');
    expect(rp.deriveWaitingOn('reroute_required')).toBe('internal');
    expect(rp.deriveWaitingOn('closed')).toBe('nobody');
    expect(rp.deriveWaitingOn('unknown')).toBe('unknown');
  });
});

describe('repair_phase — backward-compat projections onto coarse canonical enums', () => {
  it('toCanonicalPhase maps fine -> coarse', () => {
    expect(rp.toCanonicalPhase('awaiting_approval')).toBe('awaiting_estimate_approval');
    expect(rp.toCanonicalPhase('awaiting_estimate')).toBe('awaiting_estimate_approval');
    expect(rp.toCanonicalPhase('parts_backordered')).toBe('awaiting_parts');
    expect(rp.toCanonicalPhase('parts_received')).toBe('in_repair');
    expect(rp.toCanonicalPhase('road_test')).toBe('in_repair');
    expect(rp.toCanonicalPhase('ready_for_pickup')).toBe('complete');
    expect(rp.toCanonicalPhase('repair_complete')).toBe('complete');
    expect(rp.toCanonicalPhase('diagnosis')).toBe('diagnosing');
    expect(rp.toCanonicalPhase('unknown')).toBe('unknown');
  });

  it('every fine phase projects to a VALID coarse phase value', () => {
    const coarse = ['none', 'diagnosing', 'awaiting_parts', 'awaiting_estimate_approval', 'in_repair', 'complete', 'unknown'];
    for (const p of rp.REPAIR_PHASES) {
      expect(coarse).toContain(rp.toCanonicalPhase(p));
    }
  });

  it('toCanonicalWaitingOn maps fine -> coarse (us/vendor/parts/approval/none)', () => {
    const coarse = ['us', 'vendor', 'parts', 'approval', 'none'];
    for (const w of rp.WAITING_ON) {
      expect(coarse).toContain(rp.toCanonicalWaitingOn(w));
    }
    expect(rp.toCanonicalWaitingOn('internal')).toBe('us');
    expect(rp.toCanonicalWaitingOn('pickup')).toBe('us');
    expect(rp.toCanonicalWaitingOn('parts')).toBe('parts');
    expect(rp.toCanonicalWaitingOn('nobody')).toBe('none');
  });
});
