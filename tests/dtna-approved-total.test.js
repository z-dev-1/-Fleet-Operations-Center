// DTNA Total: the amount of the newest approval post in the case comments (best-effort text extraction).
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { freshDtna } from './fixtures/dtna/fake-electron.js';

const require = createRequire(import.meta.url);
let P;
let client;
let dstore;
beforeAll(() => {
  freshDtna(require);
  P = require('../src/dtna/pending.js');
  client = require('../src/dtna/client.js');
  dstore = require('../src/dtna/store.js');
});

const CASE_ID = '500AB00000ABCDEFGH';
const feed = [
  { CommentId: 'c3', CommentType: 'General', CreatedDate: '2026-11-22T15:00:00.000Z', FromName: 'Dealer', CommentText: 'Approved for $3,778.83 per PO - Approver One' },
  { CommentId: 'c2', CommentType: 'Estimate', CreatedDate: '2026-11-20T15:00:00.000Z', FromName: 'Dealer', CommentText: 'Estimate Approved - $3,531.02 (Approver Two)' },
  { CommentId: 'c1', CommentType: 'General', CreatedDate: '2026-11-19T15:00:00.000Z', FromName: 'Dealer', CommentText: 'Status Pre-Repair to Ready for Pickup' },
];

describe('approvedTotalOf', () => {
  it('newest approval post wins: 3778.83 over the older 3531.02', () => {
    const e = client.normalizeCase({ Id: CASE_ID, Status: 'In-repair' }, null, feed, { caseId: CASE_ID, now: Date.parse('2026-11-23T00:00:00Z') });
    expect(e.approvedTotal).toBe(3778.83);
    expect(e.approvedAt).toBe('2026-11-22T15:00:00.000Z');
    expect(P.offsiteRecord(e)).toMatchObject({ total: 3778.83, totalSource: 'approved' });
  });

  it('order of the list does not matter; the newest date wins', () => {
    const rev = feed.slice().reverse().map((c) => ({ text: c.CommentText, at: c.CreatedDate }));
    expect(P.approvedTotalOf(rev)).toEqual({ total: 3778.83, at: '2026-11-22T15:00:00.000Z' });
  });

  it('variants: "Approved $X", amounts without cents or commas', () => {
    expect(P.approvedTotalOf([{ text: 'Approved $950', at: '' }])).toEqual({ total: 950, at: '' });
    expect(P.approvedTotalOf([{ text: 'estimate approved: $12,000.5', at: '' }]).total).toBe(12000.5);
  });

  it('no approval post -> null total (shown as a dash), totalSource none', () => {
    const e = client.normalizeCase({ Id: CASE_ID, Status: 'In-repair' }, null, [feed[2]], { caseId: CASE_ID });
    expect(e.approvedTotal).toBeNull();
    expect(P.offsiteRecord(e)).toMatchObject({ total: null, totalSource: 'none' });
    expect(P.approvedTotalOf([{ text: 'Not approved yet, waiting on $ figure' }])).toBeNull();
  });

  it('an entry cached before the field existed still gets its total from the cached comments', () => {
    const e = { caseId: CASE_ID, comments: [{ text: 'Approved for $1,200.00', at: '2026-11-21T00:00:00Z' }] };
    expect(P.offsiteRecord(e).total).toBe(1200);
  });

  it('the store keeps approvedTotal / approvedAt', () => {
    const s = dstore.sanitize({ caseId: CASE_ID, approvedTotal: 3778.83, approvedAt: '2026-11-22T15:00:00.000Z' });
    expect(s).toMatchObject({ approvedTotal: 3778.83, approvedAt: '2026-11-22T15:00:00.000Z' });
  });
});

describe('DTNA Total precedence: labelled estimate PDF grand total > approval amount > dash', () => {
  const pdf = (o) => Object.assign({ kind: 'pdf', status: 'read', name: 'E101.pdf', createdAt: '2026-11-20T10:00:00.000Z', total: 1234.56, totalLabeled: true }, o);
  const base = { caseId: CASE_ID, approvedTotal: 3778.83, approvedAt: '2026-11-22T15:00:00.000Z' };

  it('a labelled PDF grand total beats the approval amount (totalSource pdf)', () => {
    const e = Object.assign({}, base, { attachments: [pdf()] });
    expect(P.dtnaTotal(e)).toEqual({ total: 1234.56, source: 'pdf', at: '2026-11-20T10:00:00.000Z' });
    expect(P.offsiteRecord(e)).toMatchObject({ total: 1234.56, totalSource: 'pdf' });
  });

  it('the newest labelled PDF wins over an older one (R101 revision after E101); ties keep list order', () => {
    const e = { caseId: CASE_ID, attachments: [pdf({ name: 'E101.pdf', total: 1000 }), pdf({ name: 'R101.pdf', createdAt: '2026-11-21T10:00:00.000Z', total: 1500 })] };
    expect(P.estimatePdfTotalOf(e.attachments)).toEqual({ total: 1500, at: '2026-11-21T10:00:00.000Z', name: 'R101.pdf' });
    const tie = [pdf({ name: 'a.pdf', total: 10 }), pdf({ name: 'b.pdf', total: 20 })];
    expect(P.estimatePdfTotalOf(tie).name).toBe('a.pdf');
  });

  it('an unlabelled-only PDF amount -> the approval amount', () => {
    const e = Object.assign({}, base, { attachments: [pdf({ totalLabeled: false, total: 9999 })] });
    expect(P.offsiteRecord(e)).toMatchObject({ total: 3778.83, totalSource: 'approved' });
  });

  it('scanned / failed PDFs and non-PDF rows are ignored', () => {
    const e = Object.assign({}, base, { attachments: [pdf({ status: 'scanned' }), pdf({ status: 'failed' }), pdf({ kind: 'jpg' }), pdf({ total: null })] });
    expect(P.dtnaTotal(e).source).toBe('approved');
  });

  it('no PDF and no approval -> null / none', () => {
    expect(P.dtnaTotal({ caseId: CASE_ID })).toEqual({ total: null, source: 'none', at: '' });
    expect(P.offsiteRecord({ caseId: CASE_ID, attachments: [] })).toMatchObject({ total: null, totalSource: 'none' });
  });
});
