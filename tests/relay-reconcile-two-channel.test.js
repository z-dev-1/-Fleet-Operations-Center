import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const reconcile = require('../src/scrapers/relay_reconcile');

const CFG = { ...reconcile.getConfig(), staleDays: 3 };

// Build a brief + normalized decision from a raw AI verdict, for one unit.
function decide(row, raw) {
  const brief = reconcile._unitBrief(row);
  return reconcile._normalizeDecision(brief, raw, CFG);
}

const freshOffsite = new Date(Date.now() - 1 * 86400000).toISOString();
const staleOffsite = new Date(Date.now() - 6 * 86400000).toISOString();

describe('two-channel reconcile — repairPhase + waitingOn are first-class', () => {
  it('estimate submitted, awaiting approval -> awaiting_approval / approval (no vendor chase)', () => {
    const d = decide(
      { equipmentId: '111', vendor: 'Rush', asistScrapedAt: freshOffsite,
        asistNotes: 'Estimate submitted for $8,420. Waiting on approval.' },
      { relayHasLatest: false, currentStatus: 'Estimate submitted, awaiting approval',
        repairPhase: 'awaiting_approval', waitingOn: 'approval', nextActionType: 'post_to_relay',
        lastCommentBy: 'vendor', relayNote: 'Dealer submitted a $8,420 estimate awaiting approval; internal review required.',
        dealerAsk: '', confidence: 0.9 });
    expect(d.repairPhase).toBe('awaiting_approval');
    expect(d.waitingOn).toBe('approval');
    expect(d.nextActionType).toBe('post_to_relay');
    expect(d.dealerAsk).toBe('');          // NEVER chase the vendor when WE are the blocker
    expect(d.vendorMessage).toBe('');      // alias
    expect(d.followUpNeeded).toBe(false);
    expect(d.actionDetail).toBe('review_estimate');
  });

  it('parts ordered, fresh -> awaiting_parts / parts, no unnecessary vendor chase', () => {
    const d = decide(
      { equipmentId: '222', vendor: 'Kenworth', asistScrapedAt: freshOffsite,
        asistNotes: 'Parts ordered, ETA Friday.' },
      { relayHasLatest: false, currentStatus: 'Parts on order, ETA Friday', repairPhase: 'awaiting_parts',
        waitingOn: 'parts', nextActionType: 'post_to_relay', lastCommentBy: 'vendor',
        relayNote: 'Dealer advised required parts are on order with ETA Friday.', dealerAsk: '', confidence: 0.85 });
    expect(d.repairPhase).toBe('awaiting_parts');
    expect(d.waitingOn).toBe('parts');
    expect(d.isStale).toBe(false);
    expect(d.dealerAsk).toBe('');
  });

  it('parts backordered -> parts_backordered / parts', () => {
    const d = decide(
      { equipmentId: '333', vendor: 'Volvo', asistScrapedAt: freshOffsite, asistNotes: 'Parts backordered until 10/25.' },
      { currentStatus: 'Parts backordered', repairPhase: 'parts_backordered', waitingOn: 'parts',
        nextActionType: 'post_to_relay', lastCommentBy: 'vendor', confidence: 0.8 });
    expect(d.repairPhase).toBe('parts_backordered');
    expect(d.waitingOn).toBe('parts');
  });

  it('parts received -> advances to parts_received', () => {
    const d = decide(
      { equipmentId: '444', asistScrapedAt: freshOffsite, asistNotes: 'Compressor arrived, installation started.' },
      { currentStatus: 'Parts received, repair resuming', repairPhase: 'parts_received', waitingOn: 'vendor',
        nextActionType: 'post_to_relay', lastCommentBy: 'vendor', confidence: 0.8 });
    expect(d.repairPhase).toBe('parts_received');
    expect(d.waitingOn).toBe('vendor');
  });

  it('ready for pickup -> ready_for_pickup / pickup', () => {
    const d = decide(
      { equipmentId: '555', asistScrapedAt: freshOffsite, asistNotes: 'Repairs complete. Passed road test. Ready for pickup.' },
      { currentStatus: 'Ready for pickup', repairPhase: 'ready_for_pickup', waitingOn: 'pickup',
        nextActionType: 'none', lastCommentBy: 'vendor', confidence: 0.9 });
    expect(d.repairPhase).toBe('ready_for_pickup');
    expect(d.waitingOn).toBe('pickup');
    expect(d.actionDetail).toBe('arrange_pickup');
  });

  it('vendor cannot repair -> reroute_required / internal', () => {
    const d = decide(
      { equipmentId: '666', asistScrapedAt: freshOffsite, asistNotes: 'We cannot perform this repair. Needs OEM dealer.' },
      { currentStatus: 'Vendor cannot complete; needs OEM dealer', repairPhase: 'reroute_required', waitingOn: 'internal',
        nextActionType: 'post_to_relay', lastCommentBy: 'vendor', confidence: 0.85 });
    expect(d.repairPhase).toBe('reroute_required');
    expect(d.waitingOn).toBe('internal');
    expect(d.actionDetail).toBe('reroute_vendor');
  });
});

describe('two-channel reconcile — stale parts triggers a vendor follow-up', () => {
  it('parts update stale -> request_update with a vendor chase', () => {
    const d = decide(
      { equipmentId: '777', vendor: 'Kenworth', workDuration: '8d', asistScrapedAt: staleOffsite,
        asistNotes: 'Turbo parts ordered, ETA 10/18.' },
      { relayHasLatest: true, currentStatus: 'Awaiting turbo parts (ETA 10/18 passed)', repairPhase: 'awaiting_parts',
        waitingOn: 'vendor', nextActionType: 'request_update', lastCommentBy: 'us', isStale: true,
        dealerAsk: 'Following up on the turbo parts expected 10/18 — can you confirm arrival and a revised ETC?',
        relayNote: 'Turbo parts were due 10/18; current status and revised ETC requested from dealer. Update requested, pending response.',
        confidence: 0.8 });
    expect(d.nextActionType).toBe('request_update');
    expect(d.followUpNeeded).toBe(true);
    expect(d.dealerAsk).toMatch(/revised etc|confirm/i);
    expect(d.actionDetail).toBe('request_vendor_update');
  });
});

describe('two-channel reconcile — vendor question handling', () => {
  it('unanswered vendor question we can answer -> reply_to_vendor with answer', () => {
    const d = decide(
      { equipmentId: '888', asistScrapedAt: freshOffsite, asistNotes: 'Can we proceed with expedited freight (no extra cost)?' },
      { currentStatus: 'Vendor asked about expedited freight', repairPhase: 'awaiting_parts', waitingOn: 'internal',
        nextActionType: 'reply_to_vendor', weOweReply: true, lastCommentBy: 'vendor',
        awaitingReply: 'Proceed with expedited freight?',
        dealerAsk: 'Yes, please proceed with expedited freight.', confidence: 0.85 });
    expect(d.nextActionType).toBe('reply_to_vendor');
    expect(d.weOweReply).toBe(true);
    expect(d.waitingOn).toBe('internal');     // we owe the move, not the vendor
    expect(d.dealerAsk).toBeTruthy();
    expect(d.decisionRequired).toBe(false);   // we had a safe answer
  });

  it('unanswered vendor question requiring judgment -> decisionRequired, empty vendorMessage', () => {
    const d = decide(
      { equipmentId: '999', asistScrapedAt: freshOffsite, asistNotes: 'Need approval for $475 expedited freight. Additional cost.' },
      { currentStatus: 'Vendor needs approval for $475 expedited freight', repairPhase: 'awaiting_approval', waitingOn: 'internal',
        nextActionType: 'reply_to_vendor', weOweReply: true, lastCommentBy: 'vendor',
        awaitingReply: 'Approve $475 expedited freight?',
        dealerAsk: '', confidence: 0.8 });
    expect(d.weOweReply).toBe(true);
    expect(d.dealerAsk).toBe('');             // no grounded answer -> no vendor message
    expect(d.decisionRequired).toBe(true);    // inferred: open question, no answer
    expect(d.decisionQuestion).toMatch(/\$475|expedited freight/i);
  });
});

describe('two-channel reconcile — threadOfRecord + integrated-vendor detection', () => {
  it('offsite portal present -> threadOfRecord offsite', () => {
    const d = decide(
      { equipmentId: 'A1', asistScrapedAt: freshOffsite, asistNotes: 'Dealer: parts on order.' },
      { nextActionType: 'post_to_relay', lastCommentBy: 'vendor', confidence: 0.8 });
    expect(d.threadOfRecord).toBe('offsite');
    expect(d.threadOfRecordLegacy).toBe('offsite');
  });

  it('no offsite, Relay thread has VENDOR comments -> relay_integrated_vendor', () => {
    const relayVendor = [
      'Conversation',
      'Stephanie Bean - Kenworth of PA (Technician) to', 'Z SANTIAGO - Amazon Logistics', 'Oct 6, 2026 10:27 AM',
      'Parts backordered until 10/25.', 'Vendor',
    ].join('\n');
    const d = decide({ equipmentId: 'A2', vendor: 'Kenworth', fullConversation: relayVendor },
      { nextActionType: 'post_to_relay', lastCommentBy: 'vendor', confidence: 0.8 });
    expect(d.threadOfRecord).toBe('relay_integrated_vendor');
    expect(d.threadOfRecordLegacy).toBe('relay');
  });

  it('no offsite, Relay thread internal-only -> relay_internal', () => {
    const relayInternal = [
      'Conversation',
      'carolddu - Amazon', 'Sep 30, 2026 10:00 AM', 'Logged unit at shop, awaiting diagnosis.', 'Internal Only',
    ].join('\n');
    const d = decide({ equipmentId: 'A3', fullConversation: relayInternal },
      { nextActionType: 'none', lastCommentBy: 'us', confidence: 0.6 });
    expect(d.threadOfRecord).toBe('relay_internal');
  });

  it('nothing to reconcile -> threadOfRecord none', () => {
    const d = decide({ equipmentId: 'A4' }, { nextActionType: 'none', confidence: 0.5 });
    expect(d.threadOfRecord).toBe('none');
  });

  it('_relayHasVendorComments detects a vendor-authored relay comment', () => {
    const brief = reconcile._unitBrief({ equipmentId: 'A5', fullConversation: [
      'Conversation',
      'Jose Mallen - Hunter Truck (Service Advisor) to', 'Z SANTIAGO - Amazon', 'Oct 9, 2026 06:07 PM',
      'Waiting on a clamp on backorder.', 'Vendor',
    ].join('\n') });
    expect(reconcile._relayHasVendorComments(brief)).toBe(true);
  });
});

describe('two-channel reconcile — backward-compat aliases + rich action fold', () => {
  it('a RICH nextActionType from the AI folds to the core routing value', () => {
    const d = decide(
      { equipmentId: 'B1', asistScrapedAt: freshOffsite, asistNotes: 'Estimate submitted awaiting approval.' },
      { nextActionType: 'review_estimate', repairPhase: 'awaiting_approval', waitingOn: 'approval',
        relayNote: 'Estimate awaiting approval.', lastCommentBy: 'vendor', confidence: 0.85 });
    expect(d.nextActionType).toBe('post_to_relay');   // folded core value (routing-safe)
    expect(d.actionDetail).toBe('review_estimate');   // rich value preserved
  });

  it('vendorMessage aliases dealerAsk; relayMessage aliases relayNote', () => {
    const d = decide(
      { equipmentId: 'B2', vendor: 'Rush', workDuration: '9d', asistScrapedAt: staleOffsite, asistNotes: 'DEF pump repair, no update.' },
      { nextActionType: 'request_update', repairPhase: 'awaiting_parts', waitingOn: 'vendor', isStale: true, lastCommentBy: 'us',
        dealerAsk: 'Following up on the DEF pump — can you confirm status and ETC?',
        relayNote: 'DEF pump repair; no update in 6 days. Update requested, pending response.', confidence: 0.8 });
    expect(d.vendorMessage).toBe(d.dealerAsk);
    expect(d.relayMessage).toBe(d.relayNote);
  });

  it('completed WO -> none action, no open question, phase complete/closed', () => {
    const d = decide(
      { equipmentId: 'B3', serviceState: 'Completed', completed: '10/10', asistNotes: 'Repairs complete.' },
      { nextActionType: 'none', repairPhase: 'repair_complete', lastCommentBy: 'vendor', confidence: 0.9 });
    expect(d.nextActionType).toBe('none');
    expect(d.followUpNeeded).toBe(false);
    expect(['repair_complete', 'ready_for_pickup', 'closed']).toContain(d.repairPhase);
  });
});
