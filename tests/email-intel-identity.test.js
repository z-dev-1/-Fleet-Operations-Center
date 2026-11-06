// tests/email-intel-identity.test.js — R1.2 + F-03: message vs conversation identity, derived keys
// without a time component, deterministic repeats, in-place quality upgrade.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const id = require('../src/email-intel/ingest/identity');
const ledger = require('../src/email-intel/ingest/ledger');

const sender = { name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' };
const baseCap = (o = {}) => ({
  bodyText: 'Turbo ETA 11/12 for 40456.', subject: 'RE: Turbo ETA', from: sender, conversationKey: id.conversationKey('conv/a='),
  convIdRaw: 'conv/a=', legacySeed: 'conv/a=', receivedAt: '2026-11-04T14:30:00.000Z', receivedAtQuality: 'exact', receivedAtPrecision: 'minute',
  receivedAtRaw: '2026-11-04T14:30', bodyStatus: 'complete', bodySource: 'pane', folder: 'Inbox', attachments: [], flags: {}, to: [], cc: [], ...o,
});
const build = (doc, cap, ctx) => ledger.buildRecord(cap, doc, ctx);
const add = (doc, cap) => { const r = build(doc, cap); if (r.created) ledger.upsert(doc, r.record); return r; };

describe('R1.2 message identity differs from conversation identity', () => {
  it('R1.2 messageKey differs from conversationKey and both are stable', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap());
    expect(a.record.messageKey).toMatch(/^md_[0-9a-f]{20}$/);
    expect(a.record.conversationKey).toMatch(/^cv_[0-9a-f]{16}$/);
    expect(a.record.messageKey).not.toBe(a.record.conversationKey);
    expect(a.record.messageIdSource).toBe('derived');
    expect(id.conversationKey('conv/a=')).toBe(id.conversationKey('conv/a='));
    expect(id.conversationKey('conv/b=')).not.toBe(id.conversationKey('conv/a='));
    expect(a.record.legacyId).toMatch(/^em_/);
  });

  it('R1.2 reply gets a new key, same conversationKey', () => {
    const doc = ledger.emptyDoc();
    const first = add(doc, baseCap());
    const reply = add(doc, baseCap({ bodyText: 'Updated ETA is 11/14 for 40456.', receivedAt: '2026-11-04T16:00:00.000Z' }));
    expect(reply.created).toBe(true);
    expect(reply.record.messageKey).not.toBe(first.record.messageKey);
    expect(reply.record.conversationKey).toBe(first.record.conversationKey);
    expect(ledger.conversation(doc, first.record.conversationKey).map((r) => r.messageKey)).toEqual([first.record.messageKey, reply.record.messageKey]);
  });

  it('an OWA item id wins: owa-item source, stable across content changes', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap({ itemId: 'AAMk-1' }));
    expect(a.record.messageIdSource).toBe('owa-item');
    expect(a.record.messageKey).toBe(id.itemKey('AAMk-1'));
    const again = build(doc, baseCap({ itemId: 'AAMk-1', bodyText: 'different text' }));
    expect(again.created).toBe(false);
  });

  it('item id candidates: block attr, row attr, single-block URL only', () => {
    expect(id.itemIdFrom({ idAttrs: { 'data-itemid': 'I1' } })).toBe('I1');
    expect(id.itemIdFrom({ rowAttrs: { 'data-msgid': 'R1' } })).toBe('R1');
    expect(id.itemIdFrom({ url: '/mail/id/x?ItemID=U%201&x=1', blockCount: 1 })).toBe('U 1');
    expect(id.itemIdFrom({ url: '/mail/id/x?ItemID=U1', blockCount: 3 })).toBeNull();
    expect(id.itemIdFrom({})).toBeNull();
  });
});

describe('F-03 derived keys have no time component', () => {
  it('F-03 same message re-captured next day with different time token keeps the key', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap({ receivedAt: '2026-11-04T14:30:00.000Z', receivedAtQuality: 'inferred-today', receivedAtRaw: '14:30' }));
    const next = build(doc, baseCap({ receivedAt: '2026-11-04T00:00:00.000Z', receivedAtQuality: 'inferred-date', receivedAtRaw: 'Wed 11/4' }));
    expect(next.created).toBe(false);
    expect(next.record.messageKey).toBe(a.record.messageKey);
    expect(next.record.receivedAtQuality).toBe('inferred-today');   // lower quality never overwrites
  });

  it('F-03 two identical-text replies with exact timestamps 1 day apart get two keys, and rescans are stable', () => {
    const doc = ledger.emptyDoc();
    const c1 = baseCap({ receivedAt: '2026-11-03T14:30:00.000Z' });
    const c2 = baseCap({ receivedAt: '2026-11-04T14:30:00.000Z' });
    const a = add(doc, c1);
    const b = add(doc, c2);
    expect(b.created).toBe(true);
    expect(b.record.messageKey).not.toBe(a.record.messageKey);
    // Rescan in either order: same inputs resolve to the same keys.
    expect(build(doc, c1).record.messageKey).toBe(a.record.messageKey);
    expect(build(doc, c2).record.messageKey).toBe(b.record.messageKey);
    expect(build(doc, c2).created).toBe(false);
  });

  it('F-03 an identical repeat without a reliable time merges into the first (documented limitation)', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap());
    const dup = build(doc, baseCap({ receivedAt: '2026-11-04T00:00:00.000Z', receivedAtQuality: 'inferred-date' }));
    expect(dup.created).toBe(false);
    expect(dup.record.messageKey).toBe(a.record.messageKey);
  });

  it('F-03 quality upgrade updates receivedAt without re-keying', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap({ receivedAt: '2026-11-04T00:00:00.000Z', receivedAtQuality: 'inferred-date', receivedAtPrecision: 'day', receivedAtRaw: 'Wed 11/4' }));
    const key = a.record.messageKey;
    const up = build(doc, baseCap({ receivedAt: '2026-11-04T14:30:00.000Z', receivedAtQuality: 'exact', receivedAtPrecision: 'minute' }));
    expect(up.created).toBe(false);
    expect(up.upgraded).toBe(true);
    expect(up.record.messageKey).toBe(key);
    expect(doc.messages[key].receivedAt).toBe('2026-11-04T14:30:00.000Z');
    expect(doc.messages[key].receivedAtQuality).toBe('exact');
  });

  it('subject prefixes (RE:, FW:, [TEST]) and signature noise do not change the key', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap({ subject: 'Turbo ETA' }));
    const b = build(doc, baseCap({ subject: 'RE: Re: Turbo  ETA' }));
    expect(b.created).toBe(false);
    expect(b.record.messageKey).toBe(a.record.messageKey);
    expect(id.normalizeSubject('FW: Fwd: Hello  World')).toBe('hello world');
  });

  it('a quoted tail that changes does not change the key', () => {
    const doc = ledger.emptyDoc();
    const body = 'Confirmed, ETA moved to 11/14 for unit 40456.';
    const a = add(doc, baseCap({ bodyText: body + '\n\nFrom: A\nSent: Monday, November 2, 2026 9:00 AM\nTo: B\nSubject: RE: x\n\nold quote one' }));
    const b = build(doc, baseCap({ bodyText: body + '\n\nFrom: A\nSent: Monday, November 2, 2026 9:00 AM\nTo: B\nSubject: RE: x\n\nold quote two plus more' }));
    expect(b.created).toBe(false);
    expect(b.record.messageKey).toBe(a.record.messageKey);
  });

  it('contentHash normalizes case, whitespace and punctuation', () => {
    expect(id.contentHash('Turbo ETA: 11/12!')).toBe(id.contentHash('  turbo   eta 11 12 '));
    expect(id.contentHash('a')).not.toBe(id.contentHash('b'));
    expect(id.contentHash('x')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('senderNorm prefers the address, else the normalized name', () => {
    expect(id.senderNorm({ name: 'X', address: 'A@B.TEST' })).toBe('a@b.test');
    expect(id.senderNorm({ name: '  Dealer   Desk ', address: null })).toBe('dealer desk');
  });
});

describe('item id later available for a derived message', () => {
  it('the new record carries the derived key as an alias and takes its analysis state', () => {
    const doc = ledger.emptyDoc();
    const a = add(doc, baseCap());
    a.record.analysis = { status: 'done', attempts: 1, result: { x: 1 } };
    const b = build(doc, baseCap({ itemId: 'AAMk-9' }));
    expect(b.created).toBe(true);
    expect(b.record.aliases).toEqual([a.record.messageKey]);
    ledger.upsert(doc, b.record);
    expect(doc.messages[a.record.messageKey]).toBeUndefined();
    expect(id.findMessage(doc, a.record.messageKey).messageKey).toBe(b.record.messageKey);
    expect(b.record.analysis.status).toBe('done');
    expect(Object.keys(doc.messages)).toHaveLength(1);
  });
});
