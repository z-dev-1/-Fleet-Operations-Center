import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'rr-scenarios-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const reconcile = require('../src/scrapers/relay_reconcile');
const apply = require('../src/scrapers/relay_reconcile_apply');
const canonical = require('../src/orcha/canonical_state');

const CFG = { ...reconcile.getConfig(), staleDays: 3, minConfidence: 0.5 };
const fresh = new Date(Date.now() - 1 * 86400000).toISOString();

function decide(row, raw) {
  return reconcile._normalizeDecision(reconcile._unitBrief(row), raw, CFG);
}

beforeEach(() => {
  store.save('relayReconcilePending', { items: [] });
  store.save('relayReconcileLog', {});
});

// Spec §35 scenario coverage (the ones testable deterministically).
describe('spec §35 scenarios', () => {
  it('Offsite newer than Relay -> internal gap-fill only (no vendor chase)', async () => {
    const d = decide(
      { equipmentId: 'S1', _workRequestId: 'wr', asistScrapedAt: fresh,
        asistNotes: 'Diagnosis complete. Turbo failed. Parts ordered. ETA 10/23.' },
      { relayHasLatest: false, missingUpdate: 'Turbo failed; parts on order ETA 10/23',
        currentStatus: 'Turbo failed; parts on order', repairPhase: 'awaiting_parts', waitingOn: 'parts',
        nextActionType: 'post_to_relay', lastCommentBy: 'vendor',
        relayNote: 'Dealer diagnosed a failed turbo; parts on order with ETA 10/23.', dealerAsk: '', confidence: 0.9 });
    expect(d.nextActionType).toBe('post_to_relay');
    expect(d.dealerAsk).toBe('');
    const res = await apply.applyReconcile(d, { cfg: { ...CFG, autoPostToRelay: false } });
    const kinds = res.posts.map(p => p.kind);
    expect(kinds).toContain('gap-fill');
    expect(kinds).not.toContain('dealer-ask');
  });

  it('Fresh vendor update -> no unnecessary "please update"', () => {
    const d = decide(
      { equipmentId: 'S2', asistScrapedAt: fresh, asistNotes: 'Parts arrived today, repair underway.' },
      { relayHasLatest: true, currentStatus: 'Repair underway', repairPhase: 'repair_in_progress',
        waitingOn: 'vendor', nextActionType: 'none', lastCommentBy: 'vendor', isStale: false, confidence: 0.9 });
    expect(d.isStale).toBe(false);
    expect(d.followUpNeeded).toBe(false);
    expect(d.dealerAsk).toBe('');
  });

  it('We spoke last -> vendor owes the next response (we do not re-ask)', () => {
    const relayWeLast = [
      'Conversation',
      'Stephanie - Kenworth (Advisor) to', 'Z SANTIAGO - Amazon', 'Oct 5, 2026 09:00 AM', 'Parts on order.', 'Vendor',
      'Z SANTIAGO - Amazon Logistics', 'Oct 6, 2026 02:00 PM', 'Thanks, please send the revised ETC when known.', 'Internal Only',
    ].join('\n');
    const d = decide(
      { equipmentId: 'S3', vendor: 'Kenworth', workDuration: '6d', asistScrapedAt: new Date(Date.now() - 5 * 86400000).toISOString(), fullConversation: relayWeLast },
      { relayHasLatest: true, currentStatus: 'Awaiting revised ETC', repairPhase: 'awaiting_parts',
        waitingOn: 'vendor', nextActionType: 'request_update', lastCommentBy: 'us', isStale: true,
        dealerAsk: 'Following up on the revised ETC you were going to send — any update?', confidence: 0.8 });
    expect(d.lastCommentBy).toBe('us');       // grounded by convo_parse
    expect(d.waitingOn).toBe('vendor');       // they owe us
    expect(d.nextActionType).toBe('request_update');
  });

  it('Approval granted -> advance phase (no longer awaiting_approval)', () => {
    const d = decide(
      { equipmentId: 'S4', asistScrapedAt: fresh, asistNotes: 'Estimate approved. Dealer authorized to proceed. Parts ordered.' },
      { currentStatus: 'Estimate approved; parts ordered', repairPhase: 'awaiting_parts', waitingOn: 'parts',
        nextActionType: 'post_to_relay', lastCommentBy: 'vendor', confidence: 0.9 });
    expect(d.repairPhase).not.toBe('awaiting_approval');  // advanced past approval
    expect(d.repairPhase).toBe('awaiting_parts');
  });

  it('Conflicting ETCs -> conflict recorded on the canonical record', () => {
    const d = decide(
      { equipmentId: 'S5', lifecycleState: 'Unavailable', asistScrapedAt: fresh, asistNotes: 'ETC 10/23.', repairTimeline: 'ETC 10/18' },
      { currentStatus: 'ETC conflict', repairPhase: 'awaiting_parts', waitingOn: 'parts', nextActionType: 'post_to_relay',
        lastCommentBy: 'vendor', confidence: 0.8,
        conflicts: [{ field: 'eta', positions: [{ source: 'relay', value: '10/18' }, { source: 'offsite', value: '10/23' }], resolution: 'offsite', reason: 'fresher' }] });
    const rec = canonical.reconcileCanonical({ equipmentId: 'S5', lifecycleState: 'Unavailable', asistNotes: 'ETC 10/23', asistScrapedAt: fresh }, { decision: d });
    expect(Array.isArray(rec.conflicts)).toBe(true);
    expect(rec.conflicts.some(c => c.field === 'eta')).toBe(true);
  });

  it('Same dealer-ask twice -> second is deduped within the re-ask window', async () => {
    const d = decide(
      { equipmentId: 'S6', _workRequestId: 'wr6', vendor: 'Rush', workDuration: '9d',
        asistScrapedAt: new Date(Date.now() - 6 * 86400000).toISOString(), asistNotes: 'DEF pump, no update.' },
      { relayHasLatest: true, currentStatus: 'Awaiting DEF pump update', repairPhase: 'awaiting_parts',
        waitingOn: 'vendor', nextActionType: 'request_update', lastCommentBy: 'us', isStale: true,
        dealerAsk: 'Following up on the DEF pump — can you confirm status and ETC?', confidence: 0.8 });
    const cfg = { ...CFG, autoPostToRelay: false };
    const r1 = await apply.applyReconcile(d, { cfg });
    expect(r1.posts.find(p => p.kind === 'dealer-ask').action).toBe('staged');
    const r2 = await apply.applyReconcile(d, { cfg });
    expect(r2.posts.find(p => p.kind === 'dealer-ask').action).toBe('duplicate');
  });

  it('REGRESSION: approval blocker is NOT misclassified as a vendor blocker', () => {
    // "estimate submitted, waiting for approval" must be waitingOn=approval (we
    // are the blocker) and must NOT produce a vendor chase.
    const d = decide(
      { equipmentId: 'S7', asistScrapedAt: fresh, asistNotes: 'Estimate submitted. Waiting for approval.' },
      { relayHasLatest: false, currentStatus: 'Estimate awaiting approval', repairPhase: 'awaiting_approval',
        waitingOn: 'approval', nextActionType: 'post_to_relay', lastCommentBy: 'vendor',
        relayNote: 'Dealer submitted estimate awaiting approval; internal review required.', dealerAsk: '', confidence: 0.9 });
    expect(d.waitingOn).toBe('approval');
    expect(d.waitingOn).not.toBe('vendor');
    expect(d.followUpNeeded).toBe(false);
    expect(d.dealerAsk).toBe('');
  });
});
