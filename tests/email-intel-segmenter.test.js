// tests/email-intel-segmenter.test.js — AC-6 / R1.4: conservative quote, signature and banner handling.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { phaseA } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);
const { segment, unitsIn } = require('../src/email-intel/ingest/segmenter');

const squash = (s) => String(s).replace(/\s+/g, '');
const concat = (r) => r.segments.map((s) => s.text).join('\n');

describe('R1.4 newest content is never removed', () => {
  it('R1.4 newest content never removed: Outlook header quote is stripped, the new reply stays', () => {
    const f = phaseA.quotedReply();
    const r = segment(f.text);
    expect(r.newContent).toBe(f.expectNew);
    expect(r.flags.quoted).toBe(true);
    expect(r.segments.map((s) => s.kind)).toEqual(['new', 'quoted']);
    expect(squash(concat(r))).toBe(squash(f.text));
  });

  it('R1.4 other quote boundaries: Original Message, underscore divider, "On ... wrote:", wrapped wrote, ">" run', () => {
    const head = 'The dealer confirmed the part is in for 40123 and shipping today.';
    const tails = [
      '\n\n-----Original Message-----\nFrom: A\nSent: x\n\nolder text',
      '\n\n________________________________\nFrom: A <a@example.test>\nSent: Monday\n\nolder text',
      '\n\nOn Mon, Nov 2, 2026 at 9:00 AM Dealer <d@example.test> wrote:\n> older text\n> more',
      '\n\nOn Mon, Nov 2, 2026 at 9:00 AM Someone Long <someone.long@example.test>\nwrote:\n> older text\n> more',
      '\n\n> older one\n> older two\n> older three',
    ];
    for (const t of tails) {
      const r = segment(head + t);
      expect(r.newContent, t).toBe(head);
      expect(r.flags.quoted).toBe(true);
    }
  });

  it('R1.4 inline and bottom-post replies are kept whole', () => {
    const inline = segment(phaseA.inlineReply().text);
    expect(inline.flags.inlineReply).toBe(true);
    expect(inline.newContent).toContain('Yes, approved by management');
    expect(inline.newContent).toContain('ETA is 11/14 per the dealer.');
    expect(inline.newContent).toContain('Is unit 40123 approved');
    const bottom = segment(phaseA.bottomPost().text);
    expect(bottom.flags.inlineReply).toBe(true);
    expect(bottom.newContent).toContain('Confirmed, thanks for the update on 40123');
  });

  it('R1.4 stripping that would leave almost nothing is skipped', () => {
    const t = 'ok\n\nFrom: A <a@example.test>\nSent: Monday, November 2, 2026 9:00 AM\nTo: B\nSubject: x\n\nUnit 40123 is on order, ETA 11/12.';
    const r = segment(t);
    expect(r.flags.stripSkippedEmpty).toBe(true);
    expect(r.newContent).toContain('ETA 11/12');
  });

  it('forwarded content is kept (it carries the facts) and labelled', () => {
    const r = segment(phaseA.forwarded().text);
    expect(r.flags.forwarded).toBe(true);
    expect(r.segments.map((s) => s.kind)).toEqual(['new', 'forwarded']);
    expect(r.newContent).toContain('Unit 40456 is repaired and ready for pickup.');
    expect(r.newContent).toContain('FYI see below.');
    expect(r.unitsOnlyInQuoted).toEqual([]);
  });

  it('an Outlook header-style forward is kept when the subject is FW:', () => {
    const t = 'See below for the dealer update on this unit.\n\nFrom: Dealer <d@example.test>\nSent: Monday, November 2, 2026 9:00 AM\nTo: Mike\nSubject: Unit 40456 ready\n\nUnit 40456 is ready for pickup.';
    const r = segment(t, { subject: 'FW: Unit 40456 ready' });
    expect(r.flags.forwarded).toBe(true);
    expect(r.newContent).toContain('ready for pickup');
    expect(segment(t, { subject: 'RE: Unit 40456 ready' }).newContent).not.toContain('ready for pickup');
  });
});

describe('R1.4 signatures and banners', () => {
  it('R1.4 signature with unit/amount/question/date is kept', () => {
    const r = segment(phaseA.signatureUnit().text);
    expect(r.flags.signatureStripped).toBe(false);
    expect(r.newContent).toContain('Unit 40123 follow up');
    for (const sig of ['Thanks,\nMike Rivera\nFleet Manager | 555-123-4567\nEstimate is $1,840', 'Thanks,\nMike\nFleet Manager 555-123-4567\nCan you call?', 'Thanks,\nMike\nFleet Manager 555-123-4567\nETA 11/12']) {
      const out = segment('Please check the DPF on the truck today.\n\n' + sig);
      expect(out.flags.signatureStripped, sig).toBe(false);
      expect(out.newContent).toContain(sig.split('\n').pop());
    }
  });

  it('a plain trailing signature block is stripped from newContent but stored as a segment', () => {
    const r = segment(phaseA.signaturePlain().text);
    expect(r.flags.signatureStripped).toBe(true);
    expect(r.newContent).toBe('Please check the DPF on the truck today, it keeps derating.');
    expect(r.segments.map((s) => s.kind)).toEqual(['new', 'signature']);
  });

  it('the external-sender banner is removed only at the very top or bottom', () => {
    const r = segment(phaseA.banner().text);
    expect(r.flags.bannerStripped).toBe(true);
    expect(r.newContent).toBe('Parts for 40123 are in stock and ship tomorrow.');
    const mid = segment('Hello there team.\nCAUTION: This email originated from outside of the organization\nParts for 40123 ship tomorrow.');
    expect(mid.flags.bannerStripped).toBe(false);
    expect(mid.newContent).toContain('CAUTION');
  });

  it('configured banners are honored', () => {
    const r = segment('[Company Confidential Footer]\nBody about 40123 here, long enough text.', { banners: ['[Company Confidential Footer]'] });
    expect(r.newContent.startsWith('Body about')).toBe(true);
  });
});

describe('R1.4 units only in quoted text are reported, never dropped', () => {
  it('R1.4 units only in quote reported', () => {
    const t = 'Thanks, we will look into it today and respond.\n\nFrom: A <a@example.test>\nSent: Monday, November 2, 2026 9:00 AM\nTo: B\nSubject: x\n\nUnit 40999 has a leak and unit 40123 needs parts.';
    const r = segment(t);
    expect(r.newContent).not.toContain('40999');
    expect(r.unitsOnlyInQuoted.sort()).toEqual(['40123', '40999']);
  });

  it('a unit mentioned in both new and quoted text is not "only in quoted"', () => {
    const t = 'Unit 40123 is fixed, thanks everyone for the quick help.\n\n> Unit 40123 needs parts\n> second\n> third';
    expect(segment(t).unitsOnlyInQuoted).toEqual([]);
  });

  it('phone numbers are not unit ids', () => {
    expect(Array.from(unitsIn('call 555-123-4567 or 40123')).sort()).toContain('40123');
  });
});

describe('segmenter invariants (property tests over generated messages)', () => {
  const pieces = {
    head: ['Parts arrived for unit 40123, repair starts Monday.', 'Quick update only.', 'ok', 'Can you confirm 40456 is ready? Thanks'],
    quote: [
      '\n\nFrom: A <a@example.test>\nSent: Monday, November 2, 2026 9:00 AM\nTo: B\nSubject: x\n\nold unit 51888 text',
      '\n\nOn Mon, Nov 2, 2026 at 9:00 AM A wrote:\n> old line 40999\n> two\n> three',
      '\n\n-----Original Message-----\nFrom: A\nSent: x\n\nold 62100',
      '',
    ],
    sig: ['', '\n\nThanks,\nMike Rivera\nFleet Manager | 555-123-4567', '\n\n--\nMike\n555-123-4567'],
    banner: ['', 'CAUTION: This email originated from outside of the organization\n'],
  };
  it('concatenated segments equal the input modulo whitespace; every unit id survives; newContent is never empty', () => {
    let n = 0;
    for (const b of pieces.banner) for (const h of pieces.head) for (const s of pieces.sig) for (const q of pieces.quote) {
      const text = b + h + s + q;
      const r = segment(text);
      n++;
      expect(squash(concat(r)), JSON.stringify(text)).toBe(squash(text));
      expect(r.newContent.length).toBeGreaterThan(0);
      const inAll = new Set([...unitsIn(r.newContent), ...r.unitsOnlyInQuoted]);
      for (const u of unitsIn(text.replace(/555-123-4567/g, ' '))) expect(inAll.has(u), u + ' in ' + JSON.stringify(text)).toBe(true);
    }
    expect(n).toBe(2 * 4 * 3 * 4);
  });

  it('empty and whitespace-only input', () => {
    expect(segment('').newContent).toBe('');
    expect(segment('   \n ').segments).toHaveLength(1);
  });
});
