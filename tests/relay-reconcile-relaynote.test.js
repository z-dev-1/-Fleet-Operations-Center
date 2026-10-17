import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const reconcile = require('../src/scrapers/relay_reconcile');

// A down unit where the vendor DID reply (so "no vendor engagement" would be wrong)
// and we are chasing a parts update.
const brief520063 = reconcile._unitBrief({
  equipmentId: '520063',
  lifecycleState: 'Unavailable',
  lifecycleReason: 'Offsite shop repair',
  vendor: 'Kenworth',
  workDuration: '10d',
  asistScrapedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
  fullConversation: [
    'Conversation',
    'carolddu', 'Sep 30, 2026 10:00AM', 'Exhaust clamp and gasket on order, no ETA.', 'Internal Only',
  ].join('\n'),
  asistNotes: [
    'STEPHANIE BEAN - Kenworth of PA - Dunmore (Technician) to',
    'CAROLINA DUARTE - Amazon Terminal Phl6 (Other) and 1 MORE CONTACT',
    '10/06/26 10:27 am EDT',
    'We are currently waiting on a clamp in order for us to continue repairs. This clamp is currently on backorder.',
  ].join('\n'),
});

describe('relay_reconcile — relayNote is a distinct internal-voice field', () => {
  it('_normalizeDecision threads relayNote through, separate from dealerAsk', () => {
    const raw = {
      relayHasLatest: false,
      currentStatus: 'Awaiting backordered clamp',
      nextStep: 'Chase Kenworth for clamp ETA',
      nextActionType: 'request_update',
      lastCommentBy: 'vendor',
      isStale: true,
      dealerAsk: 'Following up on 520063 — can you confirm the clamp arrival ETA and when repairs + DOT will complete?',
      relayNote: 'Exhaust clamp and gasket on order since 09/30, no ETA. Per Kenworth of PA (Stephanie Bean) 10/06, awaiting a clamp currently on backorder. 10 days down; final repairs and DOT inspection pending. Update requested, pending response.',
      confidence: 0.85,
    };
    const d = reconcile._normalizeDecision(brief520063, raw, reconcile.getConfig());
    // Both exist and are DIFFERENT.
    expect(d.relayNote).toBeTruthy();
    expect(d.dealerAsk).toBeTruthy();
    expect(d.relayNote).not.toBe(d.dealerAsk);
    // Relay note is factual/internal: no second-person vendor-chase phrasing.
    expect(d.relayNote).not.toMatch(/can you confirm|please advise|provide an eta/i);
    // Relay note CREDITS the vendor update (not "no vendor engagement").
    expect(d.relayNote).toMatch(/kenworth|stephanie|backorder/i);
    expect(d.relayNote).not.toMatch(/no vendor (engagement|response)/i);
    // The vendor-facing dealerAsk IS allowed to be a request.
    expect(d.dealerAsk).toMatch(/can you confirm|eta/i);
  });

  it('_fallbackDecision (no AI) synthesizes a factual relayNote, not a vendor chase', () => {
    const cfg = { ...reconcile.getConfig(), staleDays: 3 };
    const d = reconcile._fallbackDecision(brief520063, cfg);
    if (d.relayNote) {
      expect(d.relayNote).not.toMatch(/can you confirm|please advise/i);
      expect(d.relayNote.toLowerCase()).toContain('update requested');
    }
    // dealerAsk (vendor-facing) may still be a request.
    expect(typeof d.dealerAsk).toBe('string');
  });
});
