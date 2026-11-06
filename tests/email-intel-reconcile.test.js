// tests/email-intel-reconcile.test.js — evaluateFact precedence (design 4.3; R1.5, R3.2, R3.5, R3.7, R3.8,
// F-02, F-06, F-27, F2-01). Pure: canonical records are passed in, times are built in local time.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { LMU } from './fixtures/email-intel/canonical.js';
const require = createRequire(import.meta.url);
const rc = require('../src/email-intel/facts/reconcile');
const fk = require('../src/email-intel/facts/fact-key');

const local = (...a) => new Date(...a).toISOString();
const NOV3 = local(2026, 10, 3, 9, 0);
const ON = { capture: true, multiRecipient: true, actionsView: true, timelineWrites: true };

const fact = (o = {}) => ({ kind: 'parts_eta', item: 'turbo', value: 'Turbo ETA 11/12', state: 'eta_given', date: '2026-11-12', assertion: 'stated', amount: null, dateInvalid: false, amountUnverified: false, confidence: 0.9, confidenceValid: true, effectiveConfidence: 0.9, caps: [], ...o });
const msg = (o = {}) => ({ messageKey: 'mi_1', receivedAt: NOV3, receivedAtPrecision: 'minute', body: { status: 'complete' }, attachments: [], ...o });
const canon = (o = {}) => ({ equipmentId: '40123', status: 'down', repairPhase: 'awaiting_parts', dimensions: {}, lastMeaningfulUpdate: null, ...o });
const ctx = (o = {}) => ({ unit: '40123', scope: 'in', rosterMismatch: false, canonical: null, ledgerEntries: [], msg: msg(), flags: ON, cfg: { autoApplyUnitUpdates: true, readyDmSuggested: true }, intelCfg: {}, ...o });
const ev = (f, c) => rc.evaluateFact(fact(f), ctx(c));

describe('evaluateFact', () => {
  it('a clean, fresh, confident, in-scope fact applies', () => {
    const r = ev({}, {});
    expect(r).toMatchObject({ verdict: 'apply', reason: null });
    expect(r.keys.groupKey).toBe('40123|parts_eta');
  });

  it('R3.8 out-of-scope never written', () => {
    expect(ev({}, { scope: 'out' })).toMatchObject({ verdict: 'out-of-scope' });
    // out-of-scope wins over everything (even with every other reason present)
    expect(ev({ assertion: 'speculative', effectiveConfidence: 0 }, { scope: 'out', msg: msg({ body: { status: 'truncated' } }) }).verdict).toBe('out-of-scope');
    expect(ev({}, { scope: 'unknown' })).toMatchObject({ verdict: 'stage', reason: 'scope-unknown' });
  });

  it('R1.5 partial content stages', () => {
    for (const s of ['truncated', 'partial', 'preview-only', 'unavailable', undefined]) {
      expect(ev({}, { msg: msg({ body: { status: s } }) })).toMatchObject({ verdict: 'stage', reason: 'partial-content' });
    }
    expect(ev({}, { unprocessed: new Set(['40123']) })).toMatchObject({ verdict: 'stage', reason: 'unprocessed-window' });
  });

  it('uncertain assertions stage; a retraction points at the applied entry it contradicts', () => {
    for (const a of ['reported-secondhand', 'planned', 'requested', 'speculative']) expect(ev({ assertion: a }).reason).toBe('uncertain-assertion');
    expect(ev({ dateInvalid: true }).reason).toBe('uncertain-assertion');
    expect(ev({ amountUnverified: true }).reason).toBe('uncertain-assertion');
    const k = fk.keysOf(fact(), '40123');
    const applied = { ledgerKey: k.factKey, valueKey: k.valueKey, groupKey: k.groupKey, item: 'turbo', state: 'applied', observedAt: local(2026, 10, 2) };
    expect(ev({ assertion: 'retracted' }, { ledgerEntries: [applied] })).toMatchObject({ verdict: 'stage', reason: 'uncertain-assertion', contradicts: k.factKey });
  });

  it('duplicates, ambiguous items, ambiguous order and stale-vs-ledger', () => {
    const k = fk.keysOf(fact(), '40123');
    const e = (o) => ({ ledgerKey: 'L1', valueKey: k.valueKey, groupKey: k.groupKey, item: 'turbo', state: 'applied', observedAt: local(2026, 10, 2), ...o });
    expect(ev({ item: 'turbocharger' }, { ledgerEntries: [e()] })).toMatchObject({ verdict: 'duplicate', duplicateOf: 'L1' });
    expect(ev({ item: null }, { ledgerEntries: [e(), e({ ledgerKey: 'L2', item: 'DPF' })] })).toMatchObject({ verdict: 'stage', reason: 'ambiguous-item' });
    expect(ev({}, { ambiguousOrder: true })).toMatchObject({ verdict: 'stage', reason: 'ambiguous-order' });
    // a newer recorded ETA for the same part: the older email is evidence only
    const newer = e({ valueKey: 'other', observedAt: local(2026, 10, 4) });
    expect(ev({}, { ledgerEntries: [newer] })).toMatchObject({ verdict: 'stale' });
    // ... and an older one is superseded
    const older = e({ valueKey: 'other', ledgerKey: 'L9', observedAt: local(2026, 10, 2) });
    expect(ev({}, { ledgerEntries: [older] })).toMatchObject({ verdict: 'apply', supersedes: 'L9' });
  });

  it('ambiguousOrder flags competing facts of one group from messages under 60 s apart or without minute precision', () => {
    const m1 = msg({ messageKey: 'a', receivedAt: local(2026, 10, 3, 9, 0, 0) });
    const m2 = msg({ messageKey: 'b', receivedAt: local(2026, 10, 3, 9, 0, 30) });
    const m3 = msg({ messageKey: 'c', receivedAt: local(2026, 10, 3, 11, 0, 0) });
    const m4 = msg({ messageKey: 'd', receivedAt: local(2026, 10, 3, 15, 0, 0), receivedAtPrecision: 'day' });
    const set = rc.ambiguousOrder([
      { id: 1, unit: '40123', fact: fact({ date: '2026-11-12' }), msg: m1 },
      { id: 2, unit: '40123', fact: fact({ date: '2026-11-15' }), msg: m2 },
      { id: 3, unit: '40123', fact: fact({ date: '2026-11-15' }), msg: m3 },             // same value as 2: not competing with it
      { id: 4, unit: '40123', fact: fact({ item: 'DPF', date: '2026-11-20' }), msg: m4 }, // another part: not competing
    ]);
    expect([...set].sort()).toEqual([1, 2]);
  });

  it('R3.2 freshness vs authoritative relay/offsite change time', () => {
    // non-comparable kind (ETA): a fresher relay update about the same part conflicts; an older one does not
    const fresher = canon({ lastMeaningfulUpdate: { source: 'relay', text: 'Turbo now delayed at the dealer', at: 'Nov 4, 2026 02:00 PM' } });
    expect(ev({}, { canonical: fresher })).toMatchObject({ verdict: 'stage', reason: 'conflict-canonical', detail: 'fresher-canonical-update' });
    const older = canon({ lastMeaningfulUpdate: { source: 'relay', text: 'Turbo on order', at: 'Nov 1, 2026 02:00 PM' } });
    expect(ev({}, { canonical: older }).verdict).toBe('apply');
    // an update about something else does not block the ETA
    const other = canon({ lastMeaningfulUpdate: { source: 'offsite', text: 'Brake job finished', at: 'Nov 4, 2026 02:00 PM' } });
    expect(ev({}, { canonical: other }).verdict).toBe('apply');
    // comparable kind (repair stage): a fresher canonical phase that differs is case J
    const stageFact = { kind: 'repair_stage', item: null, value: 'Parts received', state: 'parts_received', date: null };
    const relayNewer = canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { ...LMU.relayMinute, at: 'Nov 4, 2026 02:00 PM' } });
    expect(ev(stageFact, { canonical: relayNewer })).toMatchObject({ verdict: 'stage', reason: 'conflict-canonical' });
    expect(ev(stageFact, { canonical: relayNewer }).canonicalSnapshot).toMatchObject({ status: 'down', repairPhase: 'in_repair', lastUpdateSource: 'relay', changeTimePrecision: 'minute' });
    // email newer but behind canonical (a regress): conflict, email-behind-canonical
    const relayOlder = canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { ...LMU.relayMinute, at: 'Nov 1, 2026 02:00 PM' } });
    expect(ev({ ...stageFact, state: 'awaiting_parts' }, { canonical: relayOlder })).toMatchObject({ reason: 'conflict-canonical', detail: 'email-behind-canonical' });
    // same phase: duplicate of canonical; ahead and newer: apply
    expect(ev({ ...stageFact, state: 'repair_in_progress' }, { canonical: relayOlder }).verdict).toBe('duplicate-of-canonical');
    expect(ev({ ...stageFact, state: 'road_test' }, { canonical: relayOlder }).verdict).toBe('apply');
    // day precision on the same calendar day: unprovable
    const dayCanon = canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { source: 'offsite', text: 'x', at: '11/03/26' } });
    expect(ev({ ...stageFact, state: 'road_test' }, { canonical: dayCanon })).toMatchObject({ reason: 'freshness-unprovable' });
  });

  it('R3.2 updatedAt and scrape time not used as source time', () => {
    const stageFact = { kind: 'repair_stage', item: null, value: 'Road test', state: 'road_test', date: null };
    // updatedAt is far in the future but lmu has no time: still unprovable (updatedAt is ignored)
    const noAt = canon({ repairPhase: 'in_repair', updatedAt: '2030-01-01T00:00:00.000Z', lastMeaningfulUpdate: { source: 'relay', text: 'x', at: '' } });
    expect(ev(stageFact, { canonical: noAt }).reason).toBe('freshness-unprovable');
    // at equal to the row's asistScrapedAt is a scrape time: unprovable, never compared
    const scraped = canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { ...LMU.scrapeTime } });
    expect(ev(stageFact, { canonical: scraped, row: { asistScrapedAt: LMU.scrapeTime.at } }).reason).toBe('freshness-unprovable');
  });

  it('F-02 unparseable at stages, never applies', () => {
    const stageFact = { kind: 'repair_stage', item: null, value: 'Road test', state: 'road_test', date: null };
    for (const at of ['yesterday', 'last Tuesday', '13/45/26', 'Oct 99, 2026', '']) {
      const r = ev(stageFact, { canonical: canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { source: 'relay', text: 'x', at } }) });
      expect(r.verdict, at).toBe('stage');
      expect(r.reason, at).toBe('freshness-unprovable');
    }
    // non-comparable kind with an unparseable time about the same part: unprovable too
    expect(ev({}, { canonical: canon({ lastMeaningfulUpdate: { source: 'relay', text: 'turbo delayed', at: 'yesterday' } }) }).reason).toBe('freshness-unprovable');
  });

  it('F-02 timeline-source lmu is not authoritative', () => {
    const stageFact = { kind: 'repair_stage', item: null, value: 'Road test', state: 'road_test', date: null };
    const tl = canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { ...LMU.timelineOnly, at: 'Nov 9, 2026 02:00 PM' } });
    expect(ev(stageFact, { canonical: tl }).verdict).toBe('apply');                                       // not used for freshness
    expect(ev({ ...stageFact, state: 'awaiting_parts' }, { canonical: tl })).toMatchObject({ reason: 'conflict-canonical', detail: 'email-behind-canonical' });   // phase still compared
    expect(ev({}, { canonical: canon({ lastMeaningfulUpdate: { source: 'timeline', text: 'turbo delayed', at: 'Nov 9, 2026 02:00 PM' } }) }).verdict).toBe('apply');
  });

  it('F-27 zone window stages near-simultaneous comparisons until P-TZ verified', () => {
    const stageFact = { kind: 'repair_stage', item: null, value: 'Road test', state: 'road_test', date: null };
    const c = canon({ repairPhase: 'in_repair', lastMeaningfulUpdate: { source: 'relay', text: 'x', at: 'Nov 3, 2026 03:00 PM' } });
    const m = msg({ receivedAt: local(2026, 10, 3, 20, 0) });                   // 5 h after the canonical event
    expect(ev(stageFact, { canonical: c, msg: m }).reason).toBe('freshness-unprovable');
    expect(ev(stageFact, { canonical: c, msg: m, intelCfg: { mailboxTzVerified: true } }).verdict).toBe('apply');
  });

  it('R3.5 ready vs conflicting authoritative status staged', () => {
    const ready = { kind: 'pickup_readiness', item: null, value: 'Ready for pickup', state: 'ready', date: null };
    for (const status of ['in_repair', 'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor', 'down']) {
      expect(ev(ready, { canonical: canon({ status }) }), status).toMatchObject({ verdict: 'stage', reason: 'conflict-ready' });
    }
    expect(ev(ready, { canonical: canon({ status: 'unknown', dimensions: { phase: { value: 'in_repair' } } }) }).reason).toBe('conflict-ready');
    // regardless of timestamps: even an email newer than the canonical event
    expect(ev({ kind: 'repair_stage', item: null, value: 'Done', state: 'repair_complete', date: null }, { canonical: canon({ status: 'in_repair', lastMeaningfulUpdate: { source: 'relay', text: 'x', at: 'Oct 1, 2026 01:00 PM' } }) }).reason).toBe('conflict-ready');
    expect(ev(ready, { canonical: canon({ status: 'ready_for_pickup', repairPhase: 'complete' }) })).toMatchObject({ verdict: 'apply', verifiedBy: 'canonical' });
  });

  it('R3.5 uncorroborated ready worded unverified', () => {
    const ready = { kind: 'pickup_readiness', item: null, value: 'Ready for pickup', state: 'ready', date: null };
    expect(ev(ready, { canonical: null })).toMatchObject({ verdict: 'apply', verifiedBy: 'none' });
    expect(ev(ready, { canonical: canon({ status: 'unknown', repairPhase: 'unknown' }) })).toMatchObject({ verdict: 'apply', verifiedBy: 'none' });
  });

  it('F-06 approved without amount stages', () => {
    for (const state of ['approved', 'authorized']) {
      expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate approved', state, date: null, amount: null })).toMatchObject({ verdict: 'stage', reason: 'spend-related' });
      expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate approved', state, date: null, amount: { value: 1840, currency: 'USD' } }).reason).toBe('spend-related');
    }
    expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate received', state: 'estimate_received', date: null }).reason).toBe('spend-related');
    // requested / pending / denied without attachments may auto-apply
    for (const state of ['requested', 'pending', 'denied']) expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate ' + state, state, date: null }).verdict).toBe('apply');
  });

  it('F-06 estimate with unanalyzed attachment stages', () => {
    const withFile = msg({ attachments: [{ name: 'Estimate_40123.pdf', ext: 'pdf', kind: 'document' }] });
    expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate pending', state: 'pending', date: null }, { msg: withFile })).toMatchObject({ verdict: 'stage', reason: 'spend-related' });
    const analyzed = msg({ attachments: [{ name: 'Estimate_40123.pdf', analysis: { status: 'content' } }] });
    expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate pending', state: 'pending', date: null }, { msg: analyzed }).verdict).toBe('apply');
    // other kinds are not affected by an unread attachment
    expect(ev({}, { msg: withFile }).verdict).toBe('apply');
  });

  it('Phase F (D9, design 7.7): amounts and approvals read from an attachment stage; an attachment conflict stages', () => {
    const analyzed = msg({ attachments: [{ name: 'Estimate_40123.pdf', analysis: { status: 'content' } }] });
    expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Estimate pending', state: 'pending', date: null, evidenceSource: 'attachment:0' }, { msg: analyzed })).toMatchObject({ verdict: 'stage', reason: 'spend-related' });
    expect(ev({ kind: 'parts_availability', item: 'turbo', value: 'Turbo in stock', state: 'in_stock', date: null, amount: { value: 2960, currency: 'USD' }, evidenceSource: 'attachment:0' }, { msg: analyzed }).reason).toBe('spend-related');
    // a non-money fact from an analyzed attachment follows the normal rules
    expect(ev({ evidenceSource: 'attachment:0' }, { msg: analyzed }).verdict).toBe('apply');
    expect(ev({ evidenceSource: 'body' }, { msg: analyzed }).verdict).toBe('apply');
    expect(ev({ attachmentConflict: true, evidenceSource: 'attachment:0' }, { msg: analyzed })).toMatchObject({ verdict: 'stage', reason: 'attachment-conflict' });
  });

  it('roster mismatch, low confidence and invalid confidence stage; the threshold is >= 0.75 and config only raises it', () => {
    expect(ev({}, { rosterMismatch: true }).reason).toBe('roster-mismatch');
    expect(ev({ effectiveConfidence: 0.7499 }).reason).toBe('low-confidence');
    expect(ev({ effectiveConfidence: 0.75 }).verdict).toBe('apply');
    expect(ev({ effectiveConfidence: 0.8 }, { intelCfg: { minConfidence: 0.85 } }).reason).toBe('low-confidence');
    expect(ev({ effectiveConfidence: 0.76 }, { intelCfg: { minConfidence: 0.5 } }).verdict).toBe('apply');     // config cannot lower it
    expect(ev({ effectiveConfidence: 0.74 }, { intelCfg: { minConfidence: 0.5 } }).reason).toBe('low-confidence');
    expect(ev({ effectiveConfidence: 0, caps: ['invalid-confidence'] }).reason).toBe('invalid-confidence');
    expect(ev({ effectiveConfidence: undefined }).reason).toBe('invalid-confidence');
    expect(ev({ effectiveConfidence: NaN }).reason).toBe('invalid-confidence');
  });

  it('timeline-disabled when timelineWrites is not effective (shadow mode)', () => {
    expect(ev({}, { flags: { ...ON, timelineWrites: false } })).toMatchObject({ verdict: 'stage', reason: 'timeline-disabled', detail: 'timeline writes are not enabled' });
    expect(ev({}, { flags: null }).reason).toBe('timeline-disabled');
  });

  it('F2-01 autoApplyUnitUpdates false stages every fact as timeline-disabled', () => {
    const off = { cfg: { autoApplyUnitUpdates: false, readyDmSuggested: true } };
    const facts = [
      {}, { kind: 'repair_stage', item: null, value: 'Road test', state: 'road_test', date: null },
      { kind: 'pickup_readiness', item: null, value: 'Ready', state: 'ready', date: null },
      { kind: 'estimated_completion', item: null, value: 'Done 11/15', state: 'eta_given', date: '2026-11-15' },
      { kind: 'vendor_status', item: null, value: 'Vendor working', state: 'working', date: null },
      { kind: 'blocker', item: 'access', value: 'Waiting on yard access', state: 'access', date: null },
    ];
    for (const f of facts) {
      const r = ev(f, off);
      expect(r, f.kind || 'parts_eta').toMatchObject({ verdict: 'stage', reason: 'timeline-disabled', detail: 'auto-apply is off in Email Triage settings' });
    }
    // only "auto" apply is turned off: everything that would stage for another reason keeps that reason
    expect(ev({ effectiveConfidence: 0.5 }, off).reason).toBe('low-confidence');
    expect(ev({}, { ...off, scope: 'out' }).verdict).toBe('out-of-scope');
    // undefined (older config without the key) keeps the default ON behaviour
    expect(ev({}, { cfg: {} }).verdict).toBe('apply');
  });

  it('R3.7 precedence order', () => {
    // every reason present at once: each removal reveals the next one in the fixed order
    const k = fk.keysOf(fact(), '40123');
    const dup = { ledgerKey: 'L1', valueKey: k.valueKey, groupKey: k.groupKey, item: 'turbo', state: 'applied', observedAt: local(2026, 10, 1) };
    const fresher = canon({ lastMeaningfulUpdate: { source: 'relay', text: 'turbo delayed', at: 'Nov 4, 2026 02:00 PM' } });
    const all = {
      scope: 'unknown', msg: msg({ body: { status: 'truncated' } }), ledgerEntries: [dup], canonical: fresher, rosterMismatch: true,
      flags: { ...ON, timelineWrites: false }, cfg: { autoApplyUnitUpdates: false },
    };
    const f = { assertion: 'speculative', effectiveConfidence: 0.2 };
    const order = [];
    let c = { ...all }; let fx = { ...f };
    const step = () => { const r = ev(fx, c); order.push(r.reason || r.verdict); return r; };
    step(); c.scope = 'in';
    step(); c.msg = msg();
    step(); fx = { ...fx, assertion: 'stated' };
    step(); c.ledgerEntries = [];
    step(); c.canonical = null;
    step(); c.rosterMismatch = false;
    step(); fx = { ...fx, effectiveConfidence: 0.9 };
    step(); c.flags = ON;
    step(); c.cfg = { autoApplyUnitUpdates: true };
    step();
    expect(order).toEqual(['scope-unknown', 'partial-content', 'uncertain-assertion', 'duplicate', 'conflict-canonical', 'roster-mismatch', 'low-confidence', 'timeline-disabled', 'timeline-disabled', 'apply']);
    // spend sits between canonical and roster
    expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Approved', state: 'approved', date: null }, { rosterMismatch: true }).reason).toBe('spend-related');
    expect(ev({ kind: 'approval_status', item: 'estimate', value: 'Approved', state: 'approved', date: null }, { canonical: canon({ lastMeaningfulUpdate: { source: 'relay', text: 'estimate approved', at: 'Nov 4, 2026 02:00 PM' } }) }).reason).toBe('conflict-canonical');
  });
});
