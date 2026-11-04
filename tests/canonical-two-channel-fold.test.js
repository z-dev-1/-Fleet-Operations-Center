import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const canonical = require('../src/orcha/canonical_state');

const downRow = {
  equipmentId: '520099',
  lifecycleState: 'Unavailable',
  lifecycleReason: 'Offsite shop repair',
  vendor: 'Volvo',
  asistNotes: 'Diagnosis complete. Turbo failed. Parts ordered. ETA 10/23.',
  asistScrapedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
};

describe('canonical_state — two-channel reconcile fields fold onto the record', () => {
  it('carries repairPhase / waitingOnFine / actionDetail / threadOfRecordFine from the decision', () => {
    const decision = {
      equipmentId: '520099',
      currentStatus: 'Turbo failed; parts on order ETA 10/23',
      nextStep: 'Await turbo parts',
      repairPhase: 'awaiting_parts',
      waitingOn: 'parts',
      actionDetail: 'post_internal_update',
      nextActionType: 'post_to_relay',
      threadOfRecord: 'offsite',
      relayHasLatest: false,
      missingUpdate: 'Turbo failed; parts on order ETA 10/23',
      relayNote: 'Dealer diagnosed a failed turbo; replacement parts are on order with ETA 10/23.',
      decisionRequired: false,
      confidence: 0.88,
    };
    const rec = canonical.reconcileCanonical(downRow, { decision });
    expect(rec.aiReconciled).toBe(true);
    expect(rec.repairPhase).toBe('awaiting_parts');
    expect(rec.waitingOnFine).toBe('parts');
    expect(rec.actionDetail).toBe('post_internal_update');
    expect(rec.threadOfRecordFine).toBe('offsite');
    expect(rec.threadOfRecord).toBe('offsite');          // coarse alias preserved
    expect(rec.relayNote).toMatch(/turbo/i);
    // The fine phase projects onto the coarse phase axis.
    expect(rec.dimensions.phase.value).toBe('awaiting_parts');
  });

  it('projects a FINE phase onto the coarse phase axis (parts_backordered -> awaiting_parts)', () => {
    const rec = canonical.reconcileCanonical(downRow, { decision: {
      equipmentId: '520099', currentStatus: 'Parts backordered', repairPhase: 'parts_backordered',
      waitingOn: 'parts', nextActionType: 'post_to_relay', threadOfRecord: 'offsite', confidence: 0.8,
    } });
    expect(rec.repairPhase).toBe('parts_backordered');
    expect(rec.dimensions.phase.value).toBe('awaiting_parts'); // coarse projection
  });

  it('surfaces a human decision on the record', () => {
    const rec = canonical.reconcileCanonical(downRow, { decision: {
      equipmentId: '520099', currentStatus: 'Vendor needs $475 freight approval',
      repairPhase: 'awaiting_approval', waitingOn: 'internal', nextActionType: 'reply_to_vendor',
      weOweReply: true, awaitingReply: 'Approve $475 expedited freight?',
      decisionRequired: true, decisionQuestion: 'Approve $475 expedited freight?',
      threadOfRecord: 'offsite', confidence: 0.8,
    } });
    expect(rec.decisionRequired).toBe(true);
    expect(rec.decisionQuestion).toMatch(/\$475/);
    expect(rec.flags).toContain('question_open');
  });

  it('the deterministic (no-AI) record still has the fields with safe defaults', () => {
    const rec = canonical.computeCanonical(downRow);
    expect(rec.repairPhase).toBe('unknown');
    expect(rec.waitingOnFine).toBe('unknown');
    expect(rec.actionDetail).toBe('none');
    expect(rec.decisionRequired).toBe(false);
    expect(rec.threadOfRecordFine).toBe('');
  });
});
