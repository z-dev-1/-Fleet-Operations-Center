// DTNA Chatter + Files: src/dtna/estimate-pdf.js — text from an estimate PDF through the REAL isolated
// extraction worker (pdfjs, plain Node child here; an Electron utilityProcess in the app) and the
// best-effort line-item / total parsing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/dtna/estimate-pdf.js');
const { makeEstimatePdf } = require('./helpers/dtna-estimate-pdf.cjs');
const { spawnRealWorker, fx, pidAlive } = require('./helpers/jmctx-worker.cjs');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
// A loaded machine (the full suite in parallel) can take > 20 s to start pdfjs in the real worker.
const SLOW = { PARSE_TIMEOUT_MS: 100000 };

describe('parseEstimateText', () => {
  const TEXT = [
    'Dealer estimate E101048154',
    'Brake chamber 30/30 P/N K123-456  $245.10',
    'Labor 2.5 hrs  $312.50',
    'Shop supplies  $25.00',
    'Sales Tax  $40.00',
    'Parts Total  $365.10',
    'Labor Total  $312.50',
    'Grand Total  $1,234.56',
  ].join('\n');

  it('labelled grand total, parts / labor subtotals and line-item kinds', () => {
    const r = E.parseEstimateText(TEXT);
    expect(r.total).toBe(1234.56);
    expect(r.totalLabeled).toBe(true);
    expect(r.partsTotal).toBe(365.1);
    expect(r.laborTotal).toBe(312.5);
    expect(r.lineItems).toEqual([
      { desc: 'Brake chamber 30/30 P/N K123-456', amount: 245.1, kind: 'part' },
      { desc: 'Labor 2.5 hrs', amount: 312.5, kind: 'labor' },
      { desc: 'Shop supplies', amount: 25, kind: 'other' },
    ]);
  });

  it('"Grand Total" beats a generic label; the last occurrence of the strongest label wins', () => {
    expect(E.parseEstimateText('Total Due $10.00\nGrand Total $20.00\nEstimate Total $30.00').total).toBe(20);
    expect(E.parseEstimateText('Grand Total $20.00\nrevised\nGrand Total: $25.50').total).toBe(25.5);
    expect(E.parseEstimateText('Estimate Total - $1,000.00').total).toBe(1000);
  });

  it('live dealer layout: line items whose amount is followed by a short word column (made-up values)', () => {
    const r = E.parseEstimateText([
      'Brake chamber 30/30 1 Ea 11/20/26 1234567 Parts $245.10 Pending',
      'Diagnose air leak 2 Hr 11/20/26 1234568 Labor $312.50 Approved',
      'Shop supplies $25.00 Y N',
      'Note about $10.00 deposit taken',
    ].join('\n'));
    expect(r.lineItems).toEqual([
      { desc: 'Brake chamber 30/30 1 Ea 11/20/26 1234567 Parts', amount: 245.1, kind: 'part' },
      { desc: 'Diagnose air leak 2 Hr 11/20/26 1234568 Labor', amount: 312.5, kind: 'labor' },
      { desc: 'Shop supplies', amount: 25, kind: 'other' },
    ]);
  });

  it('unlabelled amounts only -> total null (the largest $ value is never the total)', () => {
    const r = E.parseEstimateText('Brake chamber $245.10\nSomething $9,999.99');
    expect(r.total).toBeNull();
    expect(r.totalLabeled).toBe(false);
    expect(r.lineItems.length).toBe(2);
    expect(E.parseEstimateText('').total).toBeNull();
  });

  it('isEstimateName ranks estimate / revision / invoice names', () => {
    expect(E.isEstimateName('Dealer estimate E101048154.pdf')).toBe(true);
    expect(E.isEstimateName('R101048154.pdf')).toBe(true);
    expect(E.isEstimateName('photo.pdf')).toBe(false);
  });
});

describe('openExtractor (real worker)', () => {
  it('extracts the fixture estimate PDF text and its parsed $ total; the worker is killed on close()', async () => {
    let child = null;
    const spawnWorker = (file) => { child = spawnRealWorker(file); return child; };
    const ex = E.openExtractor({ spawnWorker, logger: quietLogger, getChildRss: () => undefined, limits: SLOW });
    let r;
    try {
      r = await ex.extract(makeEstimatePdf(), 'Dealer estimate E101048154.pdf');
    } finally {
      ex.close();
    }
    expect(r.ok).toBe(true);
    expect(r.status).toBe('read');
    expect(r.text).toContain('Grand Total');
    expect(r.text).toContain('Dealer estimate E101048154');
    expect(r.pages).toBe(1);
    const p = E.parseEstimateText(r.text);
    expect(p.total).toBe(1234.56);
    expect(p.totalLabeled).toBe(true);
    expect(p.lineItems.some((x) => x.kind === 'labor')).toBe(true);
    expect(child).not.toBeNull();
    for (let i = 0; i < 50 && pidAlive(child.pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(pidAlive(child.pid)).toBe(false);
  }, 120000);

  it('a long estimate: text is clipped to ATTACHMENT_TEXT_MAX, fullText keeps the grand total past the clip', async () => {
    const C = require('../src/dtna/constants.js');
    const filler = Array.from({ length: 260 }, (_, i) => 'Line ' + i + ' inspection note without an amount');
    const ex = E.openExtractor({ spawnWorker: spawnRealWorker, logger: quietLogger, getChildRss: () => undefined, limits: SLOW });
    let r;
    try {
      r = await ex.extract(makeEstimatePdf(filler.concat(['Brake chamber 1 Ea 11/20/26 1234567 Parts $245.10 Pending', 'Grand Total  $1,234.56'])), 'long.pdf');
    } finally {
      ex.close();
    }
    expect(r.status).toBe('read');
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(C.ATTACHMENT_TEXT_MAX);
    expect(r.text).not.toContain('Grand Total');
    expect(r.fullText.length).toBeGreaterThan(C.ATTACHMENT_TEXT_MAX);
    expect(E.parseEstimateText(r.text).total).toBeNull();
    const p = E.parseEstimateText(r.fullText);
    expect(p.total).toBe(1234.56);
    expect(p.lineItems).toEqual([{ desc: 'Brake chamber 1 Ea 11/20/26 1234567 Parts', amount: 245.1, kind: 'part' }]);
  }, 120000);

  it('a scanned PDF (no text layer) -> status scanned, no text', async () => {
    const ex = E.openExtractor({ spawnWorker: spawnRealWorker, logger: quietLogger, getChildRss: () => undefined, limits: SLOW });
    try {
      const r = await ex.extract(fx('scanned.pdf'), 'scan.pdf');
      expect(r.ok).toBe(true);
      expect(r.status).toBe('scanned');
      expect(r.text).toBe('');
    } finally {
      ex.close();
    }
  }, 120000);

  it('a worker failure -> status failed with a DTNA_PDF_ code', async () => {
    const { EventEmitter } = require('node:events');
    const spawnWorker = () => {
      const c = new EventEmitter();
      c.pid = 1;
      c.postMessage = (m) => setImmediate(() => c.emit('message', { id: m.id, ok: false, text: '', truncated: false, reason: 'PDF_FAILED' }));
      c.kill = () => true;
      return c;
    };
    const ex = E.openExtractor({ spawnWorker, logger: quietLogger, getChildRss: () => undefined });
    try {
      const r = await ex.extract(Buffer.from('%PDF-1.4 broken'), 'x.pdf');
      expect(r).toMatchObject({ ok: false, status: 'failed', text: '' });
      expect(r.code).toMatch(/^DTNA_PDF_/);
    } finally {
      ex.close();
    }
  });
});
