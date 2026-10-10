import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const canonical = require('../src/orcha/canonical_state');

describe('canonical_state — deterministic baseline (computeCanonical)', () => {
  it('returns null when there is no equipmentId', () => {
    expect(canonical.computeCanonical({})).toBeNull();
    expect(canonical.computeCanonical(null)).toBeNull();
  });

  it('derives available for an in-service unit', () => {
    const rec = canonical.computeCanonical({ equipmentId: '1', lifecycleState: 'Available' });
    expect(rec.status).toBe('available');
    expect(rec.aiReconciled).toBe(false);
    expect(rec.flags).not.toContain('down');
  });

  it('derives down for an unavailable unit with no finer state', () => {
    const rec = canonical.computeCanonical({ equipmentId: '2', lifecycleState: 'Unavailable' });
    expect(rec.status).toBe('down');
    expect(rec.flags).toContain('down');
    expect(canonical.isDown({ lifecycleState: 'Unavailable' })).toBe(true);
  });

  it('prefers a specific repair state over generic down', () => {
    const parts = canonical.computeCanonical({ equipmentId: '3', lifecycleState: 'Unavailable', serviceState: 'Awaiting parts on order' });
    expect(parts.status).toBe('awaiting_parts');
    expect(parts.flags).toContain('parts');
    expect(parts.waitingOn).toBe('parts');

    const appr = canonical.computeCanonical({ equipmentId: '4', lifecycleState: 'Unavailable', serviceState: 'estimate pending approval' });
    expect(appr.status).toBe('awaiting_estimate_approval');
    expect(appr.waitingOn).toBe('approval');

    const repair = canonical.computeCanonical({ equipmentId: '5', lifecycleState: 'Unavailable', serviceState: 'In repair — teardown' });
    expect(repair.status).toBe('in_repair');
  });

  it('treats a completed-but-still-unavailable unit as ready_for_pickup', () => {
    const rec = canonical.computeCanonical({ equipmentId: '6', lifecycleState: 'Unavailable', serviceState: 'Repair complete' });
    expect(rec.status).toBe('ready_for_pickup');
    expect(rec.flags).toContain('ready');
    expect(rec.waitingOn).toBe('us');
  });

  it('flags decommissioned as terminal', () => {
    const rec = canonical.computeCanonical({ equipmentId: '7', lifecycleReason: 'Unit totaled / salvage' });
    expect(rec.status).toBe('decommissioned');
  });

  it('raises stale + high_risk flags from existing fields', () => {
    const rec = canonical.computeCanonical({
      equipmentId: '8', lifecycleState: 'Unavailable',
      riskScore: 92, asistScrapedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    expect(rec.flags).toContain('high_risk');
    expect(rec.flags).toContain('stale');
    expect(rec.stale).toBe(true);
  });

  it('picks offsite provenance when a fresh offsite thread exists', () => {
    const rec = canonical.computeCanonical({
      equipmentId: '9', lifecycleState: 'Unavailable',
      asistNotes: 'Dealer: parts arrived', asistScrapedAt: new Date().toISOString(),
    });
    expect(rec.source).toBe('offsite');
  });

  it('only emits statuses from the canonical vocabulary', () => {
    const rows = [
      { equipmentId: 'a', lifecycleState: 'Available' },
      { equipmentId: 'b', lifecycleState: 'Unavailable' },
      { equipmentId: 'c', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' },
      { equipmentId: 'd', lifecycleReason: 'retired' },
      { equipmentId: 'e' },
    ];
    for (const r of rows) {
      const rec = canonical.computeCanonical(r);
      expect(canonical.isValidStatus(rec.status)).toBe(true);
    }
  });
});

describe('canonical_state — AI upgrade (reconcileCanonical)', () => {
  const downRow = { equipmentId: '100', lifecycleState: 'Unavailable', vendor: 'Amerit' };

  it('folds an AI decision into a sharper record and marks aiReconciled', () => {
    const decision = {
      equipmentId: '100',
      currentStatus: 'Waiting on DEF pump parts, ETC next week',
      nextStep: 'Chase dealer for parts ETA',
      relayHasLatest: false,
      missingUpdate: 'Parts on order per dealer 10/14',
      isStale: false,
      followUpNeeded: true,
      lastCommentBy: 'us',
      dealerAsk: 'Any update on the DEF pump parts ETA?',
      confidence: 0.82,
    };
    const rec = canonical.reconcileCanonical(downRow, { decision });
    expect(rec.aiReconciled).toBe(true);
    expect(rec.status).toBe('awaiting_parts'); // sharpened from the decision text
    expect(rec.confidence).toBeCloseTo(0.82, 2);
    expect(rec.source).toBe('offsite');          // relay lacked the latest -> offsite trusted
    expect(rec.waitingOn).toBe('vendor');         // we spoke last -> ball in vendor's court
    expect(rec.flags).toContain('needs_followup');
    expect(rec.flags).toContain('dealer_ask');
    expect(rec.flags).toContain('relay_gap');
  });

  it('falls back to the deterministic baseline when the AI was unavailable', () => {
    const rec = canonical.reconcileCanonical(downRow, { decision: { aiUnavailable: true, isStale: true } });
    expect(rec.aiReconciled).toBe(false);
    expect(rec.status).toBe('down');
    expect(rec.flags).toContain('stale'); // staleness read still folded in
  });

  it('sets waitingOn=us when the vendor commented last', () => {
    const rec = canonical.reconcileCanonical(downRow, {
      decision: { equipmentId: '100', currentStatus: 'In repair', nextStep: 'Monitor', lastCommentBy: 'vendor', confidence: 0.7 },
    });
    expect(rec.waitingOn).toBe('us');
    expect(rec.status).toBe('in_repair');
  });
});

describe('canonical_state — buildAll + mirrorFields', () => {
  it('computes a record for every unit and upgrades only those with a decision', () => {
    const rows = [
      { equipmentId: 'A', lifecycleState: 'Available' },
      { equipmentId: 'B', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' },
      { equipmentId: 'C', lifecycleState: 'Unavailable', vendor: 'Amerit' },
      { noId: true }, // skipped
    ];
    const decisions = {
      C: { equipmentId: 'C', currentStatus: 'Repair in progress', nextStep: 'Monitor', lastCommentBy: 'vendor', confidence: 0.9 },
    };
    const { units, mirrored, counts } = canonical.buildAll(rows, { decisions });
    expect(counts.total).toBe(3);
    expect(counts.reconciled).toBe(1);
    expect(counts.baseline).toBe(2);
    expect(units.A.aiReconciled).toBe(false);
    expect(units.C.aiReconciled).toBe(true);
    // mirrored rows carry canonical* fields
    const mC = mirrored.find(r => r.equipmentId === 'C');
    expect(mC.canonicalStatus).toBe('in_repair');
    expect(mC.canonicalAiReconciled).toBe(true);
    expect(Array.isArray(mC.canonicalFlags)).toBe(true);
    // row without equipmentId is passed through untouched
    expect(mirrored.find(r => r.noId)).toBeTruthy();
  });

  it('accepts a Map of decisions as well as a plain object', () => {
    const rows = [{ equipmentId: 'X', lifecycleState: 'Unavailable' }];
    const decisions = new Map([['X', { equipmentId: 'X', currentStatus: 'ready for pickup', nextStep: 'close', confidence: 0.95, completed: true }]]);
    const { units } = canonical.buildAll(rows, { decisions });
    expect(units.X.status).toBe('ready_for_pickup');
    expect(units.X.aiReconciled).toBe(true);
  });

  it('mirrorFields produces the canonical* prefixed snapshot', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'M', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' });
    const m = canonical.mirrorFields(rec);
    expect(m.canonicalStatus).toBe('awaiting_parts');
    expect(m.canonicalWaitingOn).toBe('parts');
    expect(m).toHaveProperty('canonicalConfidence');
    expect(m).toHaveProperty('canonicalUpdatedAt');
  });
});
