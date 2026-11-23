// DTNA Chatter + Files: extracted estimate-PDF text feeds the unit timeline / AI context —
// src/dtna/estimate-text.js (bounded, newest first), src/dtna/row-apply.js (row.dtnaEstimateText),
// src/repair-intel/wo-extract.js extractDtnaFeed({ attachments }) and src/orcha/ai-context.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ET = require('../src/dtna/estimate-text.js');
const { applyCaseToRow } = require('../src/dtna/row-apply.js');
const { extractDtnaFeed } = require('../src/repair-intel/wo-extract.js');
const C = require('../src/dtna/constants.js');

const CASE_ID = '500gx000002E4U5AAK';
const pdf = (o) => Object.assign({ kind: 'pdf', status: 'read', name: 'E101048154.pdf', createdAt: '2026-11-20T10:00:00.000Z', text: 'Grand Total $500.00', total: 500, totalLabeled: true, lineItems: [] }, o);

describe('estimateContextText', () => {
  it("'' when there is no read PDF", () => {
    expect(ET.estimateContextText({})).toBe('');
    expect(ET.estimateContextText({ attachments: [pdf({ status: 'scanned' }), pdf({ status: 'failed' }), { kind: 'jpg', status: 'skipped-type' }] })).toBe('');
  });

  it('newest first, with the grand total, line items and the text', () => {
    const e = { attachments: [
      pdf({ name: 'E101.pdf', createdAt: '2026-11-20T10:00:00.000Z', text: 'OLD ESTIMATE', total: 500 }),
      pdf({ name: 'R101.pdf', createdAt: '2026-11-22T10:00:00.000Z', text: 'REVISED ESTIMATE', total: 1234.56, lineItems: [{ desc: 'Brake chamber', amount: 245.1, kind: 'part' }] }),
    ] };
    const t = ET.estimateContextText(e);
    expect(t.indexOf('R101.pdf')).toBeLessThan(t.indexOf('E101.pdf'));
    expect(t).toContain('[R101.pdf, 2026-11-22] Grand total $1,234.56 (labelled)');
    expect(t).toContain('- Brake chamber  $245.10 (part)');
    expect(t).toContain('REVISED ESTIMATE');
    expect(t).toContain('OLD ESTIMATE');
  });

  it('bounded by ESTIMATE_CONTEXT_MAX (and an explicit max)', () => {
    const e = { attachments: [pdf({ text: 'x'.repeat(7000) }), pdf({ name: 'b.pdf', text: 'y'.repeat(7000) })] };
    expect(ET.estimateContextText(e).length).toBe(C.ESTIMATE_CONTEXT_MAX);
    expect(ET.estimateContextText(e, 100).length).toBe(100);
  });
});

describe('row-apply: dtnaEstimateText on the fleet row', () => {
  const row = () => ({ equipmentId: '122269', vendor: 'FREIGHTLINER', workRequestId: 'WR1' });

  it('sets the bounded estimate text from the cache entry; cleared when the entry has none', () => {
    const r = row();
    expect(applyCaseToRow(r, { caseId: CASE_ID, attachments: [pdf()] }, { now: Date.now() }).applied).toBe(true);
    expect(r.dtnaEstimateText).toContain('Grand Total $500.00');
    applyCaseToRow(r, { caseId: CASE_ID, attachments: [] }, { now: Date.now() });
    expect(r.dtnaEstimateText).toBe('');
  });

  it('extract: the PDF text runs through extractDtnaFeed into offsiteFacts', () => {
    const r = row();
    applyCaseToRow(r, { caseId: CASE_ID, thread: '', attachments: [pdf({ text: 'Brake chamber Part # K1234567 qty 1. RO # R101048154. Grand Total $1,234.56' })] }, { now: Date.now(), extract: true });
    expect(r.offsiteFacts.counts.attachments).toBe(1);
    expect(r.offsiteFacts.facts.length).toBeGreaterThan(0);
  });
});

describe('extractDtnaFeed({ attachments })', () => {
  const THREAD = 'September 24, 2026 at 6:56 AM — HORWITH FREIGHTLINER: [General] unit arrived';

  it('PDF text yields dealer-side facts from the estimate; nothing changes without attachments', () => {
    const base = extractDtnaFeed(THREAD, { now: 0 });
    const same = extractDtnaFeed(THREAD, { now: 0, attachments: [] });
    expect(JSON.stringify(same)).toBe(JSON.stringify(base));
    expect(base.counts.attachments).toBeUndefined();
    const withPdf = extractDtnaFeed(THREAD, { now: 0, attachments: [pdf({ text: 'Brake chamber Part # K1234567 qty 1. RO # R101048154. Grand Total $1,234.56' })] });
    expect(withPdf.counts.attachments).toBe(1);
    expect(withPdf.facts.length).toBeGreaterThan(base.facts.length);
    const fromPdf = withPdf.facts.filter((f) => /estimate PDF/.test(String(f.author || '')));
    expect(fromPdf.length).toBeGreaterThan(0);
    expect(fromPdf.every((f) => f.side === 'dealer' && f.source === 'dtna')).toBe(true);
  });

  it('scanned / failed PDFs and empty text are ignored', () => {
    const r = extractDtnaFeed(THREAD, { now: 0, attachments: [pdf({ status: 'scanned' }), pdf({ text: '  ' })] });
    expect(r.counts.attachments).toBeUndefined();
  });
});

describe('ai-context unit detail', () => {
  it('includes the extracted estimate text (source check, clipped)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'orcha', 'ai-context.js'), 'utf8');
    expect(src).toContain("if (row.dtnaEstimateText) detail += '  DTNA estimate PDFs (extracted):\\n' + String(row.dtnaEstimateText).slice(0, 1500)");
  });
});
