// tests/ready-pickup-notify.test.js
//
// Coverage for src/scrapers/ready_pickup_notify.js — when a unit TRANSITIONS
// to ready_for_pickup, message its carrier/operator channel ONCE and ask them
// to decide pickup vs tow-back.
//
// Asserts:
//   - a FRESH ready transition (prev !== ready) notifies exactly once
//   - a steady/ongoing ready unit (prev === ready) does NOT notify
//   - a unit whose operator has no mapped channel is skipped
//   - a second call for the same ready event dedupes (no re-send)
//   - re-notifies when the unit becomes ready AGAIN (new statusChangedAt)
//   - the AI prompt explicitly asks pickup-vs-tow
//   - deterministic fallback still asks pickup vs tow when the AI fails
//
// Fleet-row lookup and the dedupe ledger are injected via deps (the module
// supports deps.fleetRow / deps.loadLedger / deps.saveLedger) so the test does
// not depend on the file-backed store.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const readyNotify = require('../src/scrapers/ready_pickup_notify');

// Units that may be messaged must pass the hard gate (2026-10-28): an offsite
// Volvo/PACCAR (Decisiv) work order whose API case stage is Ready.
const DECISIV_READY = { offsiteShopEventUrl: 'https://pssmfleet.decisiv.net/fleet/estimates/21318589',
  offsiteStage: 'ready', offsiteStageDetail: 'Asset Ready', offsiteStageSince: '2026-10-14T12:00:00Z' };
const FLEET = {
  '322599': { equipmentId: '322599', operator: 'AZNG', domicileSite: 'AVP40', dealerName: 'Kenworth Northeast - Rochester', asistNotes: 'Dealer reports repairs complete and the unit ready for pickup. ASIST case 21318589 set to Asset Ready.', ...DECISIV_READY },
  'B10000': { equipmentId: 'B10000', operator: 'AZNG', domicileSite: 'ABE40', ...DECISIV_READY, offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/21350186' },
  'B20000': { equipmentId: 'B20000', operator: 'NOCHAN', domicileSite: 'ABE40', ...DECISIV_READY },
  // No offsite at all / non-Decisiv offsite / Decisiv but not Ready -> never messaged
  'N1': { equipmentId: 'N1', operator: 'AZNG', domicileSite: 'ABE40', issueSummary: 'leak continues after the shutoff valve is closed' },
  'N2': { equipmentId: 'N2', operator: 'AZNG', offsiteShopEventUrl: 'https://dtna.my.site.com/Servicetracker/s/case/500X', offsiteStage: 'ready', offsiteStageSince: '2026-10-14T12:00:00Z' },
  'N3': { equipmentId: 'N3', operator: 'AZNG', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/1', offsiteStage: 'repair', offsiteStageDetail: 'Road Test', offsiteStageSince: '2026-10-14T12:00:00Z' },
  'N4': { equipmentId: 'N4', operator: 'AZNG', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/2', offsiteStage: 'ready' },
};

let _ledger;
beforeEach(() => { _ledger = {}; });

function makeDeps(overrides = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      sendToChannel: vi.fn(async (channelId, message) => { sent.push({ channelId, message }); return { ok: true, ts: '1.1' }; }),
      askOrcha: vi.fn(async () => 'MOCK AI MESSAGE'),
      resolveOperatorEntry: vi.fn((op) => {
        if (String(op).toUpperCase() === 'AZNG') return { operator: 'AZNG', channelId: 'C_AZNG', ownerId: 'U_OWNER' };
        return null; // NOCHAN has no mapped channel
      }),
      fleetRow: (id) => FLEET[String(id)] || null,
      loadLedger: () => _ledger,
      saveLedger: (l) => { _ledger = l; },
      ...overrides,
    },
  };
}

describe('notifyReadyUnits', () => {
  it('notifies once for a fresh ready transition and tags the owner', async () => {
    const { deps, sent } = makeDeps();
    const units = {
      '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' },
    };
    const res = await readyNotify.notifyReadyUnits(units, deps);
    expect(res.notified).toBe(1);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    expect(sent[0].channelId).toBe('C_AZNG');
    expect(sent[0].message).toContain('<@U_OWNER>'); // owner tagged (safety net prepends if AI omitted)
  });

  it('does NOT notify a unit that was already ready (no transition)', async () => {
    const { deps } = makeDeps();
    const units = {
      '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'ready_for_pickup', statusChangedAt: '2026-10-14T13:00:00Z' },
    };
    const res = await readyNotify.notifyReadyUnits(units, deps);
    expect(res.notified).toBe(0);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it('skips a unit whose operator has no mapped channel', async () => {
    const { deps } = makeDeps();
    const units = {
      'B20000': { equipmentId: 'B20000', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' },
    };
    const res = await readyNotify.notifyReadyUnits(units, deps);
    expect(res.notified).toBe(0);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it('dedupes: the same ready event is not sent twice', async () => {
    const { deps } = makeDeps();
    const units = {
      '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' },
    };
    const first = await readyNotify.notifyReadyUnits(units, deps);
    const second = await readyNotify.notifyReadyUnits(units, deps);
    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);          // dedup ledger blocks the repeat
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('re-notifies when the unit becomes ready AGAIN (new statusChangedAt)', async () => {
    const { deps } = makeDeps();
    const u1 = { '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' } };
    await readyNotify.notifyReadyUnits(u1, deps);
    const u2 = { '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'awaiting_parts', statusChangedAt: '2026-10-20T09:00:00Z' } };
    const res = await readyNotify.notifyReadyUnits(u2, deps);
    expect(res.notified).toBe(1);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(2);
  });

  it('does NOT notify when the canonical record already carries carrierNotifiedAt (flap-proof)', async () => {
    // The canonical record carries carrierNotifiedAt forward across cycles even
    // while the raw status flaps. If it's set, we must never re-message.
    const { deps } = makeDeps();
    const units = {
      '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'down', statusChangedAt: '2026-10-14T17:37:24.675Z', carrierNotifiedAt: '2026-10-14T16:18:00.000Z' },
    };
    const res = await readyNotify.notifyReadyUnits(units, deps);
    expect(res.notified).toBe(0);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it('sets carrierNotifiedAt (via markCarrierNotified) after a successful send', async () => {
    const marked = [];
    const { deps } = makeDeps({ markCarrierNotified: (id, at) => marked.push({ id, at }) });
    const rec = { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' };
    const res = await readyNotify.notifyReadyUnits({ '322599': rec }, deps);
    expect(res.notified).toBe(1);
    expect(marked).toHaveLength(1);
    expect(marked[0].id).toBe('322599');
    expect(rec.carrierNotifiedAt).toBeTruthy();      // in-memory record stamped too
  });

  it('does NOT re-notify when the status merely FLAPS (ready→down→ready) within the cooldown', async () => {
    // Real-world bug: the upstream status oscillated ready_for_pickup -> down ->
    // ready_for_pickup across adjacent sync cycles (~80 min apart). The pure
    // statusChangedAt dedup saw a "new" ready event each flap and re-messaged
    // the carrier repeatedly. The cooldown must suppress the repeat.
    const { deps } = makeDeps();
    const first = { '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T16:17:54.364Z' } };
    await readyNotify.notifyReadyUnits(first, deps);
    // ~80 minutes later the same unit flaps back to ready (prev=down) — a NEW
    // statusChangedAt, but NOT a genuine new ready event.
    const flap = { '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'down', statusChangedAt: '2026-10-14T17:37:24.675Z' } };
    const res = await readyNotify.notifyReadyUnits(flap, deps);
    expect(res.notified).toBe(0);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1); // only the first ever sent
  });

  it('prompt asks pickup vs tow-back AND includes the current vendor/dealer location', () => {
    const prompt = readyNotify.buildReadyPrompt(
      { equipmentId: '322599', domicileSite: 'AVP40', make: 'Peterbilt' },
      { dealerLocation: "Bergey's Truck Centers - New Castle", dealer: "Bergey's Truck Centers - New Castle", asistCase: '21318589', offsiteUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/21318589', updateText: 'repairs complete, ready for pickup' },
      '<@U_OWNER>'
    );
    expect(prompt).toMatch(/PICK IT UP/i);
    expect(prompt).toMatch(/TOWED BACK/i);
    expect(prompt).toContain('21318589');
    expect(prompt).toContain('<@U_OWNER>');
    expect(prompt).toContain("Bergey's Truck Centers - New Castle"); // current location
    expect(prompt).toMatch(/CURRENT LOCATION/i);
    expect(prompt).toContain('decisiv.net/fleet/estimates/21318589'); // link
  });

  it('_deriveDealerLocation extracts the dealer name+location from asistNotes header', () => {
    const row = {
      dealerName: '',
      subVendor: "Bergey's Truck C...", // truncated stub — should be skipped
      asistNotes: "Notes\nJL\n\n10/13/26 06:42 pm EDT\n\nJessie Lewis - Bergey's Truck Centers - New Castle (Volvo) (Service Advisor) to\nLAURREN",
      vendor: 'Volvo (ASIST)',
    };
    expect(readyNotify._deriveDealerLocation(row)).toBe("Bergey's Truck Centers - New Castle");
  });

  it('_deriveDealerLocation prefers a clean subVendor and ignores the Fleet Estimate label', () => {
    expect(readyNotify._deriveDealerLocation({ subVendor: 'Kenworth Northeast - Rochester' })).toBe('Kenworth Northeast - Rochester');
    // asistLabel must NOT be used as a location
    expect(readyNotify._deriveDealerLocation({ vendor: 'Volvo (ASIST)', asistLabel: 'Fleet Estimate | 21318589' })).toBe('Volvo (ASIST)');
  });

  it('falls back to a deterministic message when the AI fails, still asking pickup vs tow', async () => {
    const { deps, sent } = makeDeps({ askOrcha: vi.fn(async () => { throw new Error('ai down'); }) });
    const units = {
      '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' },
    };
    const res = await readyNotify.notifyReadyUnits(units, deps);
    expect(res.notified).toBe(1);
    expect(sent[0].message).toMatch(/ready for pickup/i);
    expect(sent[0].message).toMatch(/tow/i);
  }, 15000);

  it('records the posted message ts in the ledger for reply correlation', async () => {
    const sendToChannel = vi.fn(async () => ({ ok: true, ts: '1700.5' }));
    let saved = null;
    const deps = makeDeps({ sendToChannel }).deps;
    deps.saveLedger = (l) => { saved = l; };
    const units = {
      '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-14T13:00:00Z' },
    };
    await readyNotify.notifyReadyUnits(units, deps);
    const entry = saved['322599:2026-10-14T13:00:00Z'];
    expect(entry).toBeTruthy();
    expect(entry.ts).toBe('1700.5');
    expect(entry.channelId).toBe('C_AZNG');
    expect(entry.awaitingReply).toBe(true);
  });
});

describe('handleReadyReplies (inbound carrier reply)', () => {
  const CH = { id: 'C_AZNG', name: 'carrier-azng' };
  const MY = 'U_BOT';

  function ledgerWithPending(extra = {}) {
    return {
      '322599:t1': {
        at: '2026-10-14T13:00:00Z', channelId: 'C_AZNG', ts: '1700.1', unit: '322599',
        operator: 'AZNG', dealerLocation: "Bergey's Truck Centers - New Castle",
        awaitingReply: true, answeredReplyTs: null, gate: 'decisiv-ready', ...extra,
      },
    };
  }

  function makeInboundDeps(replies, overrides = {}) {
    let ledger = ledgerWithPending();
    const sent = [];
    return {
      getLedger: () => ledger,
      sent,
      deps: {
        readThreadReplies: vi.fn(async () => replies),
        sendToChannel: vi.fn(async (channelId, text, threadTs) => { sent.push({ channelId, text, threadTs }); return { ok: true, ts: '1700.9' }; }),
        askOrcha: vi.fn(async () => 'Confirmed — thanks!'),
        myUserId: MY,
        resolveOperatorEntry: () => ({ operator: 'AZNG', channelId: 'C_AZNG', ownerId: 'U_OWNER' }),
        loadLedger: () => ledger,
        saveLedger: (l) => { ledger = l; },
        ...overrides,
      },
    };
  }

  it('answers a carrier reply in-thread and marks the notice answered', async () => {
    const { deps, sent, getLedger } = makeInboundDeps([
      { ts: '1700.1', userId: MY, text: 'Unit ready...' },          // our root message
      { ts: '1700.5', userId: 'U_CARRIER', text: "We'll pick it up tomorrow" }, // carrier reply
    ]);
    const res = await readyNotify.handleReadyReplies(CH, deps);
    expect(res.answered).toBe(1);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    expect(sent[0].threadTs).toBe('1700.1'); // in-thread under the ready message
    expect(getLedger()['322599:t1'].awaitingReply).toBe(false);
    expect(getLedger()['322599:t1'].answeredReplyTs).toBe('1700.5');
  });

  it('does nothing when the only thread message is our own ready post', async () => {
    const { deps } = makeInboundDeps([{ ts: '1700.1', userId: MY, text: 'Unit ready...' }]);
    const res = await readyNotify.handleReadyReplies(CH, deps);
    expect(res.answered).toBe(0);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not answer the same reply twice (already answered)', async () => {
    const { deps } = makeInboundDeps([
      { ts: '1700.1', userId: MY, text: 'Unit ready...' },
      { ts: '1700.5', userId: 'U_CARRIER', text: 'tow it back please' },
    ], {});
    // Pre-mark answered.
    deps.loadLedger = () => ({ '322599:t1': { channelId: 'C_AZNG', ts: '1700.1', unit: '322599', operator: 'AZNG', awaitingReply: false, answeredReplyTs: '1700.5' } });
    const res = await readyNotify.handleReadyReplies(CH, deps);
    expect(res.answered).toBe(0);
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it('reply prompt classifies pickup vs tow-back', () => {
    const prompt = readyNotify.buildReplyPrompt(
      { unit: '322599', dealerLocation: "Bergey's Truck Centers - New Castle" },
      "we'll send a driver to grab it",
      '<@U_OWNER>'
    );
    expect(prompt).toMatch(/PICK IT UP/i);
    expect(prompt).toMatch(/TOWED BACK/i);
    expect(prompt).toContain('322599');
    expect(prompt).toContain("we'll send a driver to grab it");
  });
});

// ── Dealer case stage = READY trigger (Volvo/PACCAR, Decisiv API), 2026-10-28 ──
describe('stage-ready trigger (Decisiv case stage reached Ready)', () => {
  const NOW = Date.parse('2026-10-29T12:00:00Z');
  const readyRow = (over = {}) => ({ equipmentId: '322599', operator: 'AZNG', offsiteStage: 'ready',
    offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/21350186',
    offsiteStageDetail: 'Asset Ready', offsiteStageSince: '2026-10-29T09:00:00Z', dealerName: 'Kenworth Northeast - Rochester', ...over });

  it('a fresh API Ready notifies the operator once, keyed on the Ready time', async () => {
    const { deps, sent } = makeDeps({ now: () => NOW, markCarrierNotified: () => {} });
    const res = await readyNotify.notifyStageReadyUnits([readyRow()], {}, deps);
    expect(res.notified).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0].channelId).toBe('C_AZNG');
    expect(_ledger['322599:2026-10-29T09:00:00Z']).toBeTruthy();
    // same Ready event again -> no second message
    const again = await readyNotify.notifyStageReadyUnits([readyRow()], {}, deps);
    expect(again.notified).toBe(0);
    expect(sent.length).toBe(1);
  });

  it('never fires on a screen-read guess (no offsiteStageSince) or a non-Ready stage', () => {
    expect(Object.keys(readyNotify.stageReadyCandidates([readyRow({ offsiteStageSince: '' })], {}, {}, NOW))).toEqual([]);
    expect(Object.keys(readyNotify.stageReadyCandidates([readyRow({ offsiteStage: 'repair' })], {}, {}, NOW))).toEqual([]);
  });

  it('does not blast units that have sat at Ready for days (48h window)', () => {
    expect(Object.keys(readyNotify.stageReadyCandidates([readyRow({ offsiteStageSince: '2026-10-25T09:00:00Z' })], {}, {}, NOW))).toEqual([]);
    expect(Object.keys(readyNotify.stageReadyCandidates([readyRow({ offsiteStageSince: '2026-10-28T13:00:00Z' })], {}, {}, NOW))).toEqual(['322599']);
  });

  it('no double message: skips if the notes trigger already notified (canonical flag or a recent ledger entry)', () => {
    expect(Object.keys(readyNotify.stageReadyCandidates([readyRow()], { '322599': { carrierNotifiedAt: '2026-10-29T10:00:00Z' } }, {}, NOW))).toEqual([]);
    const ledger = { '322599:2026-10-28T20:00:00Z': { unit: '322599', at: '2026-10-28T20:05:00Z', statusChangedAt: '2026-10-28T20:00:00Z' } };
    expect(Object.keys(readyNotify.stageReadyCandidates([readyRow()], {}, ledger, NOW))).toEqual([]);
  });

  it('the notes trigger skips a Ready event the stage trigger already sent', async () => {
    _ledger = { '322599:2026-10-29T09:00:00Z': { unit: '322599', at: '2026-10-25T09:05:00Z', statusChangedAt: '2026-10-25T09:00:00Z' } };
    const { deps, sent } = makeDeps({ fleetRow: () => readyRow(), markCarrierNotified: () => {} });
    const units = { '322599': { equipmentId: '322599', status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-30T13:00:00Z' } };
    const res = await readyNotify.notifyReadyUnits(units, deps);
    expect(res.notified).toBe(0);
    expect(sent.length).toBe(0);
  });

  it('onStageUpdate is a cheap no-op for non-Ready rows and never throws', async () => {
    const r1 = await readyNotify.onStageUpdate({ equipmentId: 'X', offsiteStage: 'repair', offsiteStageSince: '2026-10-29T09:00:00Z' });
    expect(r1.notified).toBe(0);
    const r2 = await readyNotify.onStageUpdate(null);
    expect(r2.notified).toBe(0);
  });

  it('onStageUpdate notifies through the shared queue', async () => {
    const { deps, sent } = makeDeps({ now: () => NOW, markCarrierNotified: () => {} });
    const res = await readyNotify.onStageUpdate(readyRow({ equipmentId: 'B10000', offsiteStageSince: '2026-10-29T08:00:00Z' }), deps);
    expect(res.notified).toBe(1);
    expect(sent.length).toBe(1);
  });
});

// ── HARD GATE: only Volvo/PACCAR offsite + Decisiv API stage Ready (2026-10-28) ──
describe('hard gate: no carrier message unless Volvo/PACCAR offsite case is Ready (API)', () => {
  const fresh = (id) => ({ [id]: { equipmentId: id, status: 'ready_for_pickup', previousStatus: 'in_repair', statusChangedAt: '2026-10-29T03:05:45Z' } });

  it('REGRESSION B12343: notes-only "ready" (no offsite) sends nothing', async () => {
    const { deps, sent } = makeDeps();
    const res = await readyNotify.notifyReadyUnits(fresh('N1'), deps);
    expect(res.notified).toBe(0);
    expect(sent.length).toBe(0);
  });
  it('a non-Volvo/PACCAR offsite (DTNA) sends nothing, even if marked ready', async () => {
    const { deps, sent } = makeDeps();
    await readyNotify.notifyReadyUnits(fresh('N2'), deps);
    expect(sent.length).toBe(0);
  });
  it('a Volvo/PACCAR case that is not at Ready sends nothing', async () => {
    const { deps, sent } = makeDeps();
    await readyNotify.notifyReadyUnits(fresh('N3'), deps);
    expect(sent.length).toBe(0);
  });
  it('a screen-read Ready (no API confirmation) sends nothing', async () => {
    const { deps, sent } = makeDeps();
    await readyNotify.notifyReadyUnits(fresh('N4'), deps);
    expect(sent.length).toBe(0);
  });
  it('gate function: Volvo + PACCAR hosts accepted, everything else refused', () => {
    expect(readyNotify.decisivReadyGate(FLEET['322599']).ok).toBe(true);
    expect(readyNotify.decisivReadyGate(FLEET['B10000']).ok).toBe(true);
    for (const id of ['N1', 'N2', 'N3', 'N4']) expect(readyNotify.decisivReadyGate(FLEET[id]).ok).toBe(false);
    expect(readyNotify.decisivReadyGate(null).ok).toBe(false);
  });
  it('a notice that did not pass the gate (e.g. the old B12343 one) never gets an auto-reply', async () => {
    const ledger = { 'b12343:x': { at: '2026-10-29T03:06:06Z', channelId: 'C_AUVTE', ts: '1793243165.982599', unit: 'B12343', awaitingReply: true, answeredReplyTs: null } };
    const sendToChannel = vi.fn();
    const res = await readyNotify.handleReadyReplies({ id: 'C_AUVTE', name: 'auvte' }, {
      readThreadReplies: vi.fn(async () => [{ ts: '1793243200.1', user: 'U_CARRIER', text: 'we will pick it up' }]),
      sendToChannel, askOrcha: vi.fn(async () => 'ok'), myUserId: 'U_ME',
      loadLedger: () => ledger, saveLedger: () => {},
    });
    expect(res.checked).toBe(0);
    expect(sendToChannel).not.toHaveBeenCalled();
  });
});
