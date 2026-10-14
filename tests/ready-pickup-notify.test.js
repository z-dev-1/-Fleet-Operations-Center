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

const FLEET = {
  '322599': { equipmentId: '322599', operator: 'AZNG', domicileSite: 'AVP40', dealerName: 'Kenworth Northeast - Rochester', asistNotes: 'Dealer reports repairs complete and the unit ready for pickup. ASIST case 21318589 set to Asset Ready.' },
  'B10000': { equipmentId: 'B10000', operator: 'AZNG', domicileSite: 'ABE40' },
  'B20000': { equipmentId: 'B20000', operator: 'NOCHAN', domicileSite: 'ABE40' },
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

  it('prompt asks the carrier to choose pickup vs tow-back', () => {
    const prompt = readyNotify.buildReadyPrompt(
      { equipmentId: '322599', domicileSite: 'AVP40', make: 'Peterbilt' },
      { dealer: 'Kenworth Northeast - Rochester', asistCase: '21318589', updateText: 'repairs complete, ready for pickup' },
      '<@U_OWNER>'
    );
    expect(prompt).toMatch(/PICK IT UP/i);
    expect(prompt).toMatch(/TOWED BACK/i);
    expect(prompt).toContain('21318589');
    expect(prompt).toContain('<@U_OWNER>');
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
});
