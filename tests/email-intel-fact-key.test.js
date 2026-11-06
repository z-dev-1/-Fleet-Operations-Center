// tests/email-intel-fact-key.test.js — fact keys, supersede groups and the fuzzy item rule (design 4.2;
// R3.6, F-07, AC-13). Pure: no store, no clock.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fk = require('../src/email-intel/facts/fact-key');
const im = require('../src/email-intel/facts/item-match');

const eta = (item, date, extra = {}) => ({ kind: 'parts_eta', item, value: 'ETA ' + date, state: 'eta_given', date, assertion: 'stated', ...extra });
const entry = (fact, unit, over = {}) => {
  const k = fk.keysOf(fact, unit);
  return { ledgerKey: k.factKey, factKey: k.factKey, valueKey: k.valueKey, groupKey: k.groupKey, item: k.item, kind: fact.kind, state: 'applied', observedAt: '2026-11-03T10:00:00.000Z', ...over };
};

describe('item-match (pure)', () => {
  it('normItem drops stopwords, keeps 5 tokens, sorts; tokMatch is equality or a 3+ char prefix', () => {
    expect(im.normItem('The Turbo for unit')).toBe('turbo');
    expect(im.normItem('parts')).toBe('');
    expect(im.normItem('Front left brake caliper pads rotor bolts')).toBe('brake caliper front left pads');
    expect(im.tokMatch('turbo', 'turbocharger')).toBe(true);
    expect(im.tokMatch('ab', 'abc')).toBe(false);
    expect(im.tokMatch('dpf', 'dpf')).toBe(true);
  });
});

describe('fact keys', () => {
  it('valueKey is item-free and unit/kind scoped; factKey includes the normalized item; marker is the first 8 hex', () => {
    const a = fk.keysOf(eta('turbo', '2026-11-12'), '40123');
    const b = fk.keysOf(eta('turbocharger', '2026-11-12'), '40123');
    expect(a.valueKey).toBe(b.valueKey);
    expect(a.factKey).not.toBe(b.factKey);
    expect(a.groupKey).toBe('40123|parts_eta');
    expect(a.marker).toBe('[em:' + a.valueKey.slice(0, 8) + ']');
    expect(fk.keysOf(eta('turbo', '2026-11-12'), '40456').valueKey).not.toBe(a.valueKey);
    expect(fk.keysOf(eta('turbo', '2026-11-15'), '40123').valueKey).not.toBe(a.valueKey);
    // value text does not matter for the tuple (the model words values freely)
    expect(fk.keysOf(eta('turbo', '2026-11-12', { value: 'turbo arrives 11/12' }), '40123').valueKey).toBe(a.valueKey);
    // tuples per kind
    expect(fk.valueTuple({ kind: 'parts_eta', state: 'delayed', date: null })).toBe('delayed');
    expect(fk.valueTuple({ kind: 'approval_status', state: 'requested', amount: { value: 1840 } })).toBe('requested|1840');
    expect(fk.itemOf({ kind: 'blocker', item: null, value: 'waiting on access' })).toBe('waiting on access');
    expect(fk.itemOf({ kind: 'repair_stage', item: 'engine' })).toBeNull();
  });

  it('R3.6 forward/repeat/rescan collapse', () => {
    // the same fact in the original, a forward and a rescan: same key, the second is a duplicate (message identity is no key part)
    const orig = eta('turbo', '2026-11-12');
    const led = [entry(orig, '40123')];
    expect(fk.classify(eta('turbo', '2026-11-12'), '40123', led)).toMatchObject({ kind: 'duplicate', entry: led[0] });
    expect(fk.classify(eta('Turbo', '2026-11-12', { value: 'FW: turbo ETA 11/12' }), '40123', led).kind).toBe('duplicate');
    // a pending (intent recorded, write not confirmed) entry also blocks a second write
    expect(fk.classify(orig, '40123', [entry(orig, '40123', { state: 'pending' })]).kind).toBe('duplicate');
    // superseded / filtered entries do not count
    expect(fk.classify(orig, '40123', [entry(orig, '40123', { state: 'write-filtered' })]).kind).toBe('new');
    // other unit or kind: new
    expect(fk.classify(orig, '40456', led).kind).toBe('new');
  });

  it('F-07 fuzzy item matrix', () => {
    const one = (item, date) => [entry(eta(item, date), '40123')];
    // turbo vs turbocharger = match (same date -> duplicate, new date -> supersede)
    expect(fk.classify(eta('turbocharger', '2026-11-12'), '40123', one('turbo', '2026-11-12')).kind).toBe('duplicate');
    expect(fk.classify(eta('turbocharger', '2026-11-15'), '40123', one('turbo', '2026-11-12')).kind).toBe('supersede');
    // DPF vs DPF filter = match
    expect(im.itemsMatch('DPF', 'DPF filter')).toBe('match');
    expect(fk.classify(eta('DPF filter', '2026-11-12'), '40123', one('DPF', '2026-11-12')).kind).toBe('duplicate');
    // DPF vs turbo = differ: the same ETA for a different part is a new fact, a new date for another part does not supersede
    expect(im.itemsMatch('DPF', 'turbo')).toBe('differ');
    expect(fk.classify(eta('DPF', '2026-11-12'), '40123', one('turbo', '2026-11-12')).kind).toBe('new');
    expect(fk.classify(eta('DPF', '2026-11-15'), '40123', one('turbo', '2026-11-12')).kind).toBe('new');
    // null vs turbo with one entry = match by uniqueness
    expect(im.itemsMatch(null, 'turbo')).toBe('unknown');
    expect(fk.classify(eta(null, '2026-11-12'), '40123', one('turbo', '2026-11-12')).kind).toBe('duplicate');
    expect(fk.classify(eta(null, '2026-11-15'), '40123', one('turbo', '2026-11-12')).kind).toBe('supersede');
    // null with two entries = ambiguous-item (never guess which part)
    const two = [entry(eta('turbo', '2026-11-12'), '40123'), entry(eta('DPF', '2026-11-12'), '40123')];
    expect(fk.classify(eta(null, '2026-11-12'), '40123', two).kind).toBe('ambiguous-item');
    const twoDates = [entry(eta('turbo', '2026-11-12'), '40123'), entry(eta('DPF', '2026-11-13'), '40123')];
    expect(fk.classify(eta(null, '2026-11-20'), '40123', twoDates).kind).toBe('ambiguous-item');
    // kinds without an item supersede inside unit + kind; vendor_status never supersedes
    const stage = (state) => ({ kind: 'repair_stage', item: null, value: state, state, assertion: 'stated' });
    expect(fk.classify(stage('repair_in_progress'), '40123', [entry(stage('awaiting_parts'), '40123')]).kind).toBe('supersede');
    const vend = (state) => ({ kind: 'vendor_status', item: null, value: state, state, assertion: 'stated' });
    expect(fk.classify(vend('working'), '40123', [entry(vend('received_unit'), '40123')]).kind).toBe('new');
    // an already-superseded entry is not superseded again; the newest active one is
    const old = entry(eta('turbo', '2026-11-10'), '40123', { supersededBy: 'x', state: 'superseded' });
    const cur = entry(eta('turbo', '2026-11-12'), '40123', { observedAt: '2026-11-04T10:00:00.000Z' });
    expect(fk.classify(eta('turbo', '2026-11-15'), '40123', [old, cur])).toMatchObject({ kind: 'supersede', entry: cur });
  });
});
