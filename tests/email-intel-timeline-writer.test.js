// tests/email-intel-timeline-writer.test.js — the ledgered, intent-first timeline writer (design 4.4; R3.3,
// R3.4, R3.8, R3.9, PG-2, F-07, F-08, AC-14). Real store on a temp dir, the UNCHANGED
// email_actions.applyUnitTimelineUpdate and the REAL ipc/notes.cleanTimeline. No Outlook, no AI.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mk, person, ZILA, DEALER } from './fixtures/email-intel/emails.js';
import { recordOf } from './fixtures/email-intel/records.js';
import { factsWorld, vfact, PHASE_C } from './fixtures/email-intel/facts-harness.js';
const require = createRequire(import.meta.url);
const writer = require('../src/email-intel/facts/timeline-writer');
const fk = require('../src/email-intel/facts/fact-key');
const { cleanTimeline } = require('../src/ipc/notes');
const schema = require('../src/email-intel/understand/schema');

let w = null;
afterEach(() => { if (w) w.cleanup(); w = null; });
const msgOf = (o = {}) => recordOf(mk({ subject: 'Turbo 40123', body: 'Turbo ETA 11/12 for 40123', receivedAt: '2026-11-04T14:30:00.000Z', ...o }));
const ledger = () => w.stores.load('ledger').entries;
const stagedItems = () => Object.values(w.stores.load('staged').items);

describe('commitFact', () => {
  it('R3.3 writes via applyUnitTimelineUpdate to the fact\'s unit only', async () => {
    w = factsWorld();
    const msg = msgOf();
    const r = await writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: { verdict: 'apply' } });
    expect(r.state).toBe('applied');
    const tl = w.timeline('40123');
    expect(tl).toBe(r.line);
    expect(w.timeline('40456')).toBe('');
    // the shared writer mirrored the line into fleetData and kept the manualEntries bookkeeping
    expect(w.store.load('fleetData').rows.find((x) => x.equipmentId === '40123').repairTimeline).toBe(tl);
    expect(w.store.load('fleetData').rows.find((x) => x.equipmentId === '40456').repairTimeline).toBe('');
    expect(w.store.load('notesStore')['40123'].manualEntries).toEqual([r.line]);
  });

  it('R3.4 ledger provenance and line tag', async () => {
    w = factsWorld();
    const msg = msgOf({ from: { name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' } });
    const f = vfact();
    const r = await writer.commitFact({ fact: f, unit: '40123', msg, evalResult: { verdict: 'apply' } });
    const k = fk.keysOf(f, '40123');
    const e = ledger()[r.ledgerKey];
    expect(r.ledgerKey).toBe(k.factKey);
    expect(e).toMatchObject({
      state: 'applied', unit: '40123', kind: 'parts_eta', valueKey: k.valueKey, groupKey: '40123|parts_eta', item: 'turbo',
      messageKey: msg.messageKey, conversationKey: msg.conversationKey, source: 'email', senderName: 'Dealer Parts Desk',
      observedAt: '2026-11-04T14:30:00.000Z', confidence: 0.9, evidenceQuote: 'Turbo ETA 11/12 for 40123', marker: k.marker,
    });
    expect(e.appliedAt).toBeTruthy();
    expect(e.lineHash).toMatch(/^[0-9a-f]{16}$/);
    const d = new Date('2026-11-04T14:30:00.000Z');
    const mmdd = String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
    expect(r.line).toBe(mmdd + ' Parts ETA: Turbo ETA 11/12 (per Dealer Parts Desk email ' + mmdd + ') ' + k.marker);
    expect(r.line).not.toContain('@');
    expect(r.line.length).toBeLessThanOrEqual(240);
  });

  it('PG-2 writes without reply requirement', async () => {
    // one email to 20 people, nobody asks me anything: the fact still lands (relevance is independent of replies)
    w = factsWorld();
    const msg = msgOf({ to: Array.from({ length: 20 }, (_, i) => (i === 7 ? ZILA : person(i + 1))), body: 'Parts arrived for unit 40123, repair starts Monday.' });
    const r = await writer.commitFact({ fact: vfact({ kind: 'parts_availability', item: 'parts', value: 'Parts arrived', state: 'arrived', date: null, evidence: 'Parts arrived for unit 40123' }), unit: '40123', msg, evalResult: { verdict: 'apply' } });
    expect(r.state).toBe('applied');
    expect(w.timeline('40123')).toContain('Parts: Parts arrived');
  });

  it('R3.8 scope re-checked at commit', async () => {
    w = factsWorld();
    const r = await writer.commitFact({ fact: vfact(), unit: '40123', msg: msgOf(), evalResult: { verdict: 'apply' }, scopeOf: () => 'out' });
    expect(r.state).toBe('out-of-scope');
    expect(w.timeline('40123')).toBe('');
    expect(Object.keys(ledger())).toEqual([]);
  });

  it('R3.9 canonicalState never written, evidence separate', async () => {
    w = factsWorld();
    const canon = { units: { '40123': { status: 'down', repairPhase: 'awaiting_parts' } }, updatedAt: '2026-11-04T15:00:00.000Z' };
    w.store.save('canonicalState', canon);
    const msg = msgOf();
    const r = await writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: { verdict: 'apply' } });
    expect(r.state).toBe('applied');
    expect(w.store.load('canonicalState')).toEqual(canon);
    const ev = w.store.load('emailEvidence')['40123'];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ source: 'email', field: 'repairUpdate', usedInConclusion: true, isConflict: false, messageKeyV2: msg.messageKey, conversationKey: msg.conversationKey, factKey: r.ledgerKey, confidence: 0.9, quote: 'Turbo ETA 11/12 for 40123', receivedAt: msg.receivedAt, sender: DEALER.name });
    expect(JSON.stringify(ev)).not.toContain(DEALER.address);
    // a repeat never adds a second evidence entry
    await writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: { verdict: 'apply' } });
    expect(w.store.load('emailEvidence')['40123']).toHaveLength(1);
  });

  it('a repeat (forward, rescan) is a duplicate: corroboration only, one line', async () => {
    w = factsWorld();
    const m1 = msgOf();
    const m2 = msgOf({ subject: 'FW: Turbo 40123', body: 'FYI\nTurbo ETA 11/12 for 40123' });
    const a = await writer.commitFact({ fact: vfact(), unit: '40123', msg: m1, evalResult: {} });
    const b = await writer.commitFact({ fact: vfact({ item: 'turbocharger' }), unit: '40123', msg: m2, evalResult: {} });
    expect(b).toMatchObject({ state: 'duplicate', ledgerKey: a.ledgerKey });
    expect(ledger()[a.ledgerKey]).toMatchObject({ seenCount: 2, corroboratedBy: [m2.messageKey] });
    expect(w.timeline('40123').split('\n')).toHaveLength(1);
  });

  it('a newer value supersedes with (was <old>) and links the old entry', async () => {
    w = factsWorld();
    const m1 = msgOf();
    const a = await writer.commitFact({ fact: vfact(), unit: '40123', msg: m1, evalResult: {} });
    const old = ledger()[a.ledgerKey];
    const m2 = msgOf({ body: 'Turbocharger now ETA 11/15 for 40123', receivedAt: '2026-11-05T14:30:00.000Z' });
    const b = await writer.commitFact({ fact: vfact({ item: 'turbocharger', value: 'Turbocharger ETA 11/15', date: '2026-11-15' }), unit: '40123', msg: m2, evalResult: { supersededEntry: old, supersedes: old.ledgerKey } });
    expect(b.state).toBe('applied');
    expect(b.line).toContain('Turbocharger ETA 11/15 (was 11/12) (per ');
    expect(ledger()[a.ledgerKey]).toMatchObject({ state: 'superseded', supersededBy: b.ledgerKey });
    expect(ledger()[b.ledgerKey].supersedes).toBe(a.ledgerKey);
    expect(w.timeline('40123').split('\n')).toHaveLength(2);
  });

  it('F-07 marker without ledger entry stages possible-duplicate', async () => {
    // two-host simulation: the other host wrote the line (its ledger is not replicated), this host has an empty ledger
    w = factsWorld();
    const f = vfact();
    const marker = fk.keysOf(f, '40123').marker;
    w.store.save('notesStore', { '40123': { timeline: '11/04 Parts ETA: Turbo ETA 11/12 (per Dealer email 11/04) ' + marker, manualEntries: [] } });
    const before = w.timeline('40123');
    const r = await writer.commitFact({ fact: f, unit: '40123', msg: msgOf(), evalResult: {} });
    expect(r).toMatchObject({ state: 'staged', reason: 'possible-duplicate' });
    expect(w.timeline('40123')).toBe(before);
    expect(Object.keys(ledger())).toEqual([]);
    expect(stagedItems()).toEqual([expect.objectContaining({ stagedId: r.stagedId, reason: 'possible-duplicate', state: 'open', unit: '40123' })]);
    expect(stagedItems()[0].proposedLine).toContain(marker);
  });

  it("F-08 value containing 'requested update ... vendor' is staged, not silently applied", async () => {
    w = factsWorld();
    w.store.save('notesStore', { '40123': { timeline: '11/01 Unit arrived at the shop for diagnosis', manualEntries: [] } });
    // (1) prevention: the substitution table keeps a real fact from looking like a gap filler
    const a = await writer.commitFact({ fact: vfact({ kind: 'vendor_status', item: null, value: 'Requested update from vendor on turbo', state: 'waiting', date: null }), unit: '40123', msg: msgOf(), evalResult: {} });
    expect(a.state).toBe('applied');
    expect(a.line).toContain('Asked for info from vendor on turbo');
    expect(w.timeline('40123')).toContain(fk.keysOf({ kind: 'vendor_status', state: 'waiting', date: null }, '40123').marker);
    // (2) detection with the REAL cleaner: wording the table does not cover is dropped by cleanTimeline -> staged, never applied
    const f2 = vfact({ kind: 'blocker', item: 'approval', value: 'Vendor prerequested a preupdate approval', state: 'approval', date: null });
    const b = await writer.commitFact({ fact: f2, unit: '40123', msg: msgOf(), evalResult: {} });
    expect(b.state).toBe('filtered');
    expect(ledger()[b.ledgerKey]).toMatchObject({ state: 'write-filtered', manualEntriesOrphan: true });
    const st = stagedItems().find((x) => x.stagedId === b.stagedId);
    expect(st).toMatchObject({ reason: 'timeline-filtered', detail: 'The timeline cleaner removed this line', state: 'open' });
    expect(w.timeline('40123')).not.toContain(fk.keysOf(f2, '40123').marker);
    expect(w.store.load('emailEvidence')['40123'].filter((x) => x.factKey === b.ledgerKey)).toEqual([]);     // no evidence claims usedInConclusion
    // (3) detection when the write returns ok but the line is gone (any future cleaner rule)
    const c = await writer.commitFact({ fact: vfact({ value: 'Turbo ETA 11/20', date: '2026-11-20' }), unit: '40123', msg: msgOf(), evalResult: {}, deps: { apply: () => ({ ok: true, timeline: 'something else' }) } });
    expect(c.state).toBe('filtered');
    expect(writer.appliedMessageKeys().size).toBe(1);                                                        // only (1) counts as applied
  });

  it('F-08 every template survives the real cleanTimeline', () => {
    const msg = msgOf({ from: { name: 'Vendor Update Requests', address: 'v@example.test' } });
    const nasty = ['Requested update from vendor', 'requested repair update from vendor', 'Requested estimate submission', 'requested updated ETC', '[no update logged] vendor', 'Update requested; vendor waiting'];
    for (const kind of schema.FACT_KINDS) {
      for (const state of schema.STATE_ENUMS[kind]) {
        for (const value of nasty.concat(['Plain value 11/12'])) {
          for (const variant of [{}, { userApproved: true }, { verifiedBy: 'none' }, { supersededEntry: { ledgerKey: 'x', fact: { date: '2026-11-10', state: 'eta_given' } } }]) {
            const fact = vfact({ kind, state, value, item: 'part', date: '2026-11-12', amount: kind === 'approval_status' ? { value: 1840, currency: 'USD' } : null });
            const line = writer.buildLine(Object.assign({ fact, unit: '40123', msg }, variant));
            const marker = fk.keysOf(fact, '40123').marker;
            expect(line.endsWith(marker)).toBe(true);
            expect(line.length).toBeLessThanOrEqual(240);
            const cleaned = cleanTimeline('11/01 Unit arrived at the shop for diagnosis\n' + line);
            expect(cleaned, kind + ' ' + state + ' ' + value).toContain(marker);
          }
        }
      }
    }
  });

  it('line format: unverified ready wording, user-approved suffix, length cap, sender without address', () => {
    const ready = vfact({ kind: 'pickup_readiness', item: null, value: 'Ready for pickup', state: 'ready', date: null });
    expect(writer.buildLine({ fact: ready, unit: '40456', msg: msgOf(), verifiedBy: 'none' })).toContain('email ' );
    expect(writer.buildLine({ fact: ready, unit: '40456', msg: msgOf(), verifiedBy: 'none' })).toContain(') - not confirmed in AAP/Relay [em:');
    expect(writer.buildLine({ fact: ready, unit: '40456', msg: msgOf(), verifiedBy: 'canonical' })).not.toContain('not confirmed');
    expect(writer.buildLine({ fact: vfact(), unit: '40123', msg: msgOf(), userApproved: true })).toMatch(/ \(user-approved\) \[em:[0-9a-f]{8}\]$/);
    const long = writer.buildLine({ fact: vfact({ value: 'x'.repeat(160) }), unit: '40123', msg: msgOf({ from: { name: 'N'.repeat(80), address: 'a@b.test' } }) });
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long).toContain('(per ' + 'N'.repeat(30) + ' email');
    expect(writer.buildLine({ fact: vfact(), unit: '40123', msg: msgOf({ from: { name: 'a@b.test', address: 'a@b.test' } }) })).toContain('(per unknown sender email');
    const amt = writer.buildLine({ fact: vfact({ kind: 'approval_status', item: 'estimate', value: 'Estimate approval requested', state: 'requested', date: null, amount: { value: 1840, currency: 'USD' } }), unit: '40123', msg: msgOf() });
    expect(amt).toContain('Approval: Estimate approval asked for $1,840 (per');
  });

  it('crash simulation: a crash between the write and the applied mark is reconciled by the marker, never written twice', async () => {
    w = factsWorld();
    const actions = require('../src/scrapers/email_actions');
    const crash = { apply: (u, l) => { actions.applyUnitTimelineUpdate(u, l); throw new Error('process died'); } };
    const msg = msgOf();
    const t0 = Date.now();
    const r = await writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: {}, deps: crash, now: t0 });
    expect(r.state).toBe('error');
    const key = fk.keysOf(vfact(), '40123').factKey;
    expect(ledger()[key].state).toBe('pending');                       // intent recorded before the write
    expect(w.timeline('40123').split('\n')).toHaveLength(1);
    // a rescan sighting is blocked by the pending intent
    expect((await writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: {} })).state).toBe('duplicate');
    // too fresh: left alone; after 2 minutes the marker resolves it
    expect(await writer.reconcilePending({ now: t0 + 30_000 })).toEqual({ resolved: 0, retried: 0, failed: 0 });
    expect(await writer.reconcilePending({ now: t0 + 3 * 60_000 })).toEqual({ resolved: 1, retried: 0, failed: 0 });
    expect(ledger()[key]).toMatchObject({ state: 'applied', reconciled: true });
    expect(w.timeline('40123').split('\n')).toHaveLength(1);
    // a crash BEFORE the write: reconcile writes the stored line once
    const f2 = vfact({ value: 'Turbo ETA 11/20', date: '2026-11-20' });
    await writer.commitFact({ fact: f2, unit: '40123', msg, evalResult: {}, deps: { apply: () => { throw new Error('died early'); } }, now: t0 });
    expect(await writer.reconcilePending({ now: t0 + 3 * 60_000 })).toEqual({ resolved: 0, retried: 1, failed: 0 });
    expect(w.timeline('40123').split('\n')).toHaveLength(2);
  });

  it('write failures keep the intent pending and stage write-failed after 3 tries', async () => {
    w = factsWorld();
    const fail = { apply: () => ({ ok: false, error: 'disk' }) };
    const t0 = Date.now();
    await writer.commitFact({ fact: vfact(), unit: '40123', msg: msgOf(), evalResult: {}, deps: fail, now: t0 });
    await writer.reconcilePending({ now: t0 + 3 * 60_000, deps: fail });
    const r = await writer.reconcilePending({ now: t0 + 6 * 60_000, deps: fail });
    expect(r.failed).toBe(1);
    const e = Object.values(ledger())[0];
    expect(e).toMatchObject({ state: 'pending', attempts: 3 });
    expect(stagedItems()).toEqual([expect.objectContaining({ reason: 'write-failed', state: 'open' })]);
  });

  it('leader gate: a standby host stages standby-host and writes nothing; flag off writes nothing', async () => {
    w = factsWorld();
    const r = await writer.commitFact({ fact: vfact(), unit: '40123', msg: msgOf(), evalResult: {}, deps: { mayRunProduction: () => false } });
    expect(r.state).toBe('standby');
    expect(stagedItems()[0]).toMatchObject({ reason: 'standby-host' });
    expect(w.timeline('40123')).toBe('');
    w.flags._setForTests({ ...PHASE_C, actionsView: false });                  // timelineWrites no longer effective (F-13)
    expect((await writer.commitFact({ fact: vfact(), unit: '40123', msg: msgOf(), evalResult: {} })).state).toBe('disabled');
    expect(w.timeline('40123')).toBe('');
  });

  it('the process-wide mutex serializes concurrent commits of the same fact', async () => {
    w = factsWorld();
    const msg = msgOf();
    const [a, b] = await Promise.all([
      writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: {} }),
      writer.commitFact({ fact: vfact(), unit: '40123', msg, evalResult: {} }),
    ]);
    expect([a.state, b.state].sort()).toEqual(['applied', 'duplicate']);
    expect(w.timeline('40123').split('\n')).toHaveLength(1);
  });
});
