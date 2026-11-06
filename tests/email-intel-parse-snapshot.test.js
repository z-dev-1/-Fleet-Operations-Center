// tests/email-intel-parse-snapshot.test.js — R1.1, R1.5: snapshot -> MessageCapture with quality flags.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { block, snapshot, rowDesc, att, phaseA, ZILA, DEALER, COWORKER } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);
const ps = require('../src/email-intel/capture/parse-snapshot');
const C = require('../src/email-intel/constants');
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'email-intel', 'owa-snapshots');
const NOW = Date.UTC(2026, 10, 4, 20, 0, 0);
const row = rowDesc({ i: 1, convId: 'conv/x=', from: 'Dealer Parts', subject: 'Turbo ETA 40456', time: '14:30', preview: 'Turbo ETA 11/12 for 40456' });
const parse = (snap, r = row, o = {}) => ps.parseSnapshot(snap, r, NOW, Object.assign({ tzMinutes: 0, folder: 'Inbox' }, o));

describe('R1.1 captures from/to/cc/subject/ids/time/body/attachment metadata with quality flags', () => {
  it('R1.1 captures from/to/cc/subject/ids/time/body/attachment metadata with quality flags', () => {
    const snap = snapshot({
      subject: 'Turbo ETA 40456', from: DEALER, to: [ZILA, COWORKER], cc: [{ name: 'Boss', address: 'boss@example.test' }], convId: 'conv/x=', itemId: 'AAMk-1',
      text: 'From: Dealer Parts Desk\nTo: Zila Santiago\n\nTurbo ETA 11/12 for 40456.\nThanks', time: '2026-11-04T14:30:00-05:00',
      attachments: [att('Quote_40456.pdf')],
    });
    const { captures, stubs } = parse(snap);
    expect(stubs).toBe(0);
    expect(captures).toHaveLength(1);
    const c = captures[0];
    expect(c.from).toEqual({ name: 'Dealer Parts Desk', address: 'parts@dealer.example.test', quality: 'ok' });
    expect(c.to.map((r) => r.address)).toEqual(['zila.santiago@example.test', 'mike.rivera@example.test']);
    expect(c.cc.map((r) => r.address)).toEqual(['boss@example.test']);
    expect(c.toCount).toBe(2); expect(c.ccCount).toBe(1);
    expect(c.recipientsKnown).toBe(true);
    expect(c.subject).toBe('Turbo ETA 40456');
    expect(c.itemId).toBe('AAMk-1');
    expect(c.convIdRaw).toBe('conv/x='); expect(c.conversationKey).toMatch(/^cv_[0-9a-f]{16}$/);
    expect(c.receivedAt).toBe('2026-11-04T19:30:00.000Z'); expect(c.receivedAtQuality).toBe('exact');
    expect(c.bodyText).toBe('Turbo ETA 11/12 for 40456.\nThanks');
    expect(c.bodyStatus).toBe('complete');
    expect(c.attachments).toEqual([expect.objectContaining({ name: 'Quote_40456.pdf', ext: 'pdf', kind: 'document', placeholder: false, sizeBytes: 122880, analysis: { status: 'filename-only' } })]);
  });

  it('R1.1 missing To/CC sets recipientsKnown false and never infers recipients', () => {
    const b = block({ to: [], cc: [], header: 'From: Dealer', text: 'Hello' });
    const c = parse(snapshot({ blocks: [b] })).captures[0];
    expect(c.recipientsKnown).toBe(false);
    expect(c.to).toEqual([]); expect(c.cc).toEqual([]); expect(c.toCount).toBe(0);
    const explicit = parse(snapshot({ blocks: [block({ to: [], header: 'To: Undisclosed-recipients', text: 'Hello' })] })).captures[0];
    expect(explicit.recipientsKnown).toBe(true);
  });

  it('a 20-recipient To list is parsed fully; a name-only sender is flagged name-only', () => {
    const c = parse(phaseA.multi20to()).captures[0];
    expect(c.toCount).toBe(20); expect(c.to).toHaveLength(20);
    expect(c.to.some((r) => r.address === ZILA.address)).toBe(true);
    const b = block({ text: 'Hi' }); b.fromCandidates = [{ title: '', aria: '', text: 'Some Sender', href: '' }];
    const n = parse(snapshot({ blocks: [b] })).captures[0];
    expect(n.from).toEqual({ name: 'Some Sender', address: null, quality: 'name-only' });
  });

  it('recipients are capped at 200 but the count is kept', () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ name: 'P' + i, address: 'p' + i + '@example.test' }));
    const c = parse(snapshot({ to: many, text: 'x' })).captures[0];
    expect(c.to).toHaveLength(C.RECIPIENTS_CAP);
    expect(c.toCount).toBe(230);
  });

  it('parseAddressList handles quotes, angle brackets, semicolons and comma lists', () => {
    const l = ps.parseAddressList('"Doe, Jane" <jane@example.test>; Bob Smith (bob@example.test); a@example.test, b@example.test; Name Only; jane@example.test');
    expect(l.map((r) => r.address)).toEqual(['jane@example.test', 'bob@example.test', 'a@example.test', 'b@example.test', null]);
    expect(l[0].name).toBe('Doe, Jane');
    expect(l[4].name).toBe('Name Only');
  });

  it('attachments: placeholders for paperclip-only rows, size parsing, allowed download handles, item id from pane URL', () => {
    const { captures } = parse(phaseA.attachmentMeta());
    const a = captures[0].attachments;
    expect(a.map((x) => x.name)).toEqual(['Estimate_40123.pdf', 'photo1.jpg', null]);
    expect(a[1].sizeBytes).toBe(Math.round(2.5 * 1024 * 1024));
    expect(a[1].hasDownloadHandle).toBe(true); expect(a[0].hasDownloadHandle).toBe(false);
    expect(a[2]).toMatchObject({ placeholder: true, attId: 'AT1' });
    const paperclip = parse(snapshot({ text: 'x' }), rowDesc({ i: 2, hasAttach: true, convId: 'c2' })).captures[0].attachments;
    expect(paperclip).toEqual([expect.objectContaining({ name: null, placeholder: true })]);
    const one = parse(Object.assign(snapshot({ text: 'x' }), { url: '/mail/id/x?ItemID=ZZ9' }));
    expect(one.captures[0].itemId).toBe('ZZ9');
  });

  it('received time falls back from the datetime attribute to header text to the row token', () => {
    const noTime = block({ text: 'x', time: null, header: 'From: A\nSent: Wednesday, November 4, 2026 2:14 PM\nTo: B' });
    expect(parse(snapshot({ blocks: [noTime] })).captures[0]).toMatchObject({ receivedAt: '2026-11-04T14:14:00.000Z', receivedAtQuality: 'parsed-header' });
    const none = block({ text: 'x', time: null, header: 'From: A' });
    expect(parse(snapshot({ blocks: [none] })).captures[0]).toMatchObject({ receivedAt: '2026-11-04T14:30:00.000Z', receivedAtQuality: 'inferred-today' });   // row token 14:30
    const unk = parse(snapshot({ blocks: [none] }), rowDesc({ i: 3, time: 'Yesterday' })).captures[0];
    expect(unk).toMatchObject({ receivedAt: null, receivedAtQuality: 'unknown' });
  });
});

describe('R1.5 bodyStatus matrix', () => {
  const snap = (b, extra) => Object.assign(snapshot({ blocks: [b] }), extra || {});
  it('R1.5 bodyStatus matrix', () => {
    expect(ps.bodyStatusOf(block({ text: 'hello' }), snap(block({ text: 'hello' })), true)).toBe('complete');
    expect(ps.bodyStatusOf(block({ text: 'hello' }), snap(block({ text: 'hello' })), false)).toBe('preview-only');
    expect(ps.bodyStatusOf(block({ text: '  ' }), snap(block({ text: '' })), true)).toBe('unavailable');
    expect(ps.bodyStatusOf(block({ text: 'hello', collapsed: true }), snap(block({ text: 'x' })), true)).toBe('collapsed');
    expect(ps.bodyStatusOf(block({ text: 'hello' }), snap(block({ text: 'x' }), { paneFallback: true }), true)).toBe('low-quality');
    expect(ps.bodyStatusOf(block({ text: 'hello', textLen: C.RAW_BODY_CAP + 1 }), snap(block({ text: 'x' })), true)).toBe('truncated-cap');
    expect(ps.bodyStatusOf(block({ text: 'hello', controls: ['Show more'] }), snap(block({ text: 'x' })), true)).toBe('truncated-ui');
    expect(ps.bodyStatusOf(block({ text: 'hello', controls: ['Reply'] }), snap(block({ text: 'x' })), true)).toBe('complete');
    // first match wins: collapsed beats truncated-ui; unavailable beats collapsed
    expect(ps.bodyStatusOf(block({ text: 'hello', collapsed: true, controls: ['Show more'] }), snap(block({ text: 'x' })), true)).toBe('collapsed');
    expect(ps.bodyStatusOf(block({ text: '', collapsed: true }), snap(block({ text: 'x' })), true)).toBe('unavailable');
  });

  it('a truncated pane keeps the text and says so; truncated-cap records where it was cut', () => {
    const t = parse(phaseA.truncatedBody()).captures[0];
    expect(t.bodyStatus).toBe('truncated-ui');
    expect(t.bodyText).toContain('Unit 40123 update follows');
    const big = parse(snapshot({ text: 'a'.repeat(1000), textLen: C.RAW_BODY_CAP + 500 })).captures[0];
    expect(big).toMatchObject({ bodyStatus: 'truncated-cap', truncatedAt: C.RAW_BODY_CAP });
  });

  it('an unreadable pane yields ONE preview-only capture from the row, never invented fields', () => {
    for (const bad of [null, undefined, 'garbage', { error: 'no-pane' }, { blocks: [] }]) {
      const { captures } = parse(bad);
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({ bodyStatus: 'preview-only', bodySource: 'preview', recipientsKnown: false, itemId: null });
      expect(captures[0].bodyText).toContain('Turbo ETA 11/12');
      expect(captures[0].from.address).toBeNull();
    }
  });

  it('collapsed blocks yield stubs; expanded blocks yield one capture each (thread completeness)', () => {
    const snap2 = snapshot({ blocks: [block({ text: 'old one', collapsed: true }), block({ text: 'Middle message about 40123 text here' }), block({ text: 'Newest reply on 40123 is here' })] });
    const { captures, stubs } = parse(snap2);
    expect(stubs).toBe(1);
    expect(captures).toHaveLength(3);
    expect(captures[0]).toMatchObject({ stub: true, bodyStatus: 'collapsed' });
    expect(captures.filter((c) => !c.stub).map((c) => c.blockIndex)).toEqual([1, 2]);
    expect(captures[2].isLatest).toBe(true);
  });

  it('at most MAX_PANE_BLOCKS blocks are read from a first-seen conversation', () => {
    const snap2 = snapshot({ blocks: Array.from({ length: 20 }, (_, i) => block({ text: 'message ' + i + ' text body here' })) });
    expect(parse(snap2).captures).toHaveLength(C.MAX_PANE_BLOCKS);
  });

  it('rows without a data-convid derive the conversation key from the aria text', () => {
    const r = rowDesc({ i: 4, convId: '' });
    const c = parse(snapshot({ text: 'x' }), r).captures[0];
    expect(c.convIdSource).toBe('derived');
    expect(c.conversationKey).toMatch(/^cv_[0-9a-f]{16}$/);
  });
});

describe('recorded-shape snapshot fixtures (owa-snapshots/*.json)', () => {
  it('every fixture file parses into at least one capture without throwing', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const r = parse(j.snapshot, j.row || row);
      expect(r.captures.length, f).toBeGreaterThan(0);
    }
  });
});
