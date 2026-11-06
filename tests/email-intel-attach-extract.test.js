// tests/email-intel-attach-extract.test.js — extraction, status mapping, excerpts, session close and the
// F-14 memory-only / pending-reextract rules (design 7.2, 7.5, 7.6; R6.1, R6.3, R6.5, R6.6).
// extractItem is stubbed (no worker, no vision model); fetches are scripted.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { att, stubExtract, REASONS } from './fixtures/email-intel/attach.js';
const require = createRequire(import.meta.url);
const ex = require('../src/email-intel/attach/extract');
const excerpt = require('../src/email-intel/attach/excerpt');
const policy = require('../src/email-intel/attach/policy');

const budget = (over = {}) => policy.createBudget(policy.policyOf({ attachments: Object.assign({ visionNoticeAcknowledged: true }, over) }), { now: Date.now() });
const okFetch = (calls) => async () => { if (calls) calls.n++; return { ok: true, buffer: Buffer.from('bytes'), mimetype: 'application/pdf' }; };
const read = (kind, text, extra = {}) => Object.assign({ kind, status: 'read', text, truncated: false, reason: '', meta: {} }, extra);

describe('R6.1 / R6.3 statuses and labels', () => {
  it('R6.1 pdf/docx/xlsx/image statuses', () => {
    expect(ex.mapItem(read('pdf', 'Estimate total $1,840'))).toMatchObject({ analysis: { status: 'content', via: 'pdf-text', chars: 21 }, text: 'Estimate total $1,840' });
    expect(ex.mapItem(read('docx', 'Parts ETA 11/12', { status: 'truncated', truncated: true })).analysis).toMatchObject({ status: 'content-partial', via: 'docx' });
    expect(ex.mapItem(read('xlsx', 'Labor 4h'))).toMatchObject({ analysis: { status: 'content', via: 'xlsx' } });
    expect(ex.mapItem(read('jpg', 'Photo text', { meta: { via: 'vision' } })).analysis).toMatchObject({ status: 'content', via: 'vision' });
    expect(ex.mapItem({ kind: 'xlsx', status: 'failed', reason: REASONS.SHEET_FAILED, text: '' })).toEqual({ analysis: { status: 'unreadable', via: 'xlsx', reason: 'sheet-failed', reasonText: REASONS.SHEET_FAILED }, text: null });
    expect(ex.mapItem({ kind: 'pdf', status: 'failed', reason: REASONS.SCANNED_PDF_UNAVAILABLE }).analysis).toMatchObject({ status: 'unreadable', reason: 'scanned-pdf-unavailable', reasonText: REASONS.SCANNED_PDF_UNAVAILABLE });
    expect(ex.mapItem({ kind: 'doc', status: 'unsupported', reason: REASONS.UNSUPPORTED }).analysis).toMatchObject({ status: 'unreadable', reason: 'unsupported' });
    expect(ex.mapItem({ kind: 'pdf', status: 'skipped', reason: REASONS.BUDGET }).analysis).toMatchObject({ status: 'skipped', reason: 'budget' });
    expect(ex.mapItem({ kind: 'pdf', status: 'read', text: '   ' }).analysis).toMatchObject({ status: 'unreadable', reason: 'empty' });
    // the content hash and counts are kept, never the text
    const m = ex.mapItem(read('pdf', 'x'.repeat(50)));
    expect(m.analysis.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(m.analysis)).not.toContain('xxxx');
  });

  it('R6.3 analyzed vs filename-only labels', async () => {
    const extract = stubExtract({ 'Estimate.pdf': read('pdf', 'Estimate total $1,840 for 40123'), 'Scan.pdf': { kind: 'pdf', status: 'failed', reason: REASONS.SCANNED_PDF_UNAVAILABLE } });
    const list = [att('Estimate.pdf'), att('Scan.pdf'), { attId: null, name: null, ext: '', placeholder: true, hasDownloadHandle: false, analysis: { status: 'filename-only' } }, att('NoLink.pdf', { hasDownloadHandle: false })];
    // flag OFF: every attachment is filename-only, nothing fetched or extracted
    const calls = { n: 0 };
    const off = await ex.analyzeAttachments({ attachments: list, budget: budget(), flagOn: false, fetchOne: okFetch(calls), deps: { extractItem: extract } });
    expect(off.attachments.map((a) => a.analysis.status)).toEqual(['filename-only', 'filename-only', 'filename-only', 'filename-only']);
    expect(calls.n).toBe(0);
    expect(extract.calls.n).toBe(0);
    // flag ON: analyzed vs unreadable vs filename-only (placeholder) vs no download handle
    const on = await ex.analyzeAttachments({ attachments: list, budget: budget(), flagOn: true, fetchOne: okFetch(calls), deps: { extractItem: extract } });
    expect(on.attachments.map((a) => [a.analysis.status, a.analysis.reason || null])).toEqual([
      ['content', null], ['unreadable', 'scanned-pdf-unavailable'], ['filename-only', 'no-name'], ['unreadable', 'no-handle'],
    ]);
    expect(calls.n).toBe(2);
    expect(on.excerpts).toEqual([{ index: 0, status: 'content', text: 'Estimate total $1,840 for 40123', cut: false }]);
    // the input is not mutated
    expect(list[0].analysis).toEqual({ status: 'filename-only' });
  });
});

describe('R6.5 safety and bounds', () => {
  it('R6.5 unreadable and password files safe, session closed', async () => {
    const calls = { n: 0, closed: 0 };
    const extract = stubExtract({
      'locked.pdf': { kind: 'pdf', status: 'failed', reason: REASONS.PDF_PASSWORD },
      'huge.pdf': { kind: 'pdf', status: 'failed', reason: REASONS.TOO_LARGE },
      'boom.pdf': () => { throw new Error('worker crashed with SECRET-TEXT'); },
      'creds.docx': read('docx', 'aws_secret_access_key = abc123 CREDS-SENTINEL'),
    }, calls);
    const list = [att('locked.pdf'), att('huge.pdf'), att('boom.pdf')];
    const r = await ex.analyzeAttachments({ attachments: list, budget: budget(), flagOn: true, fetchOne: okFetch(), deps: { extractItem: extract } });
    expect(r.attachments.map((a) => [a.analysis.status, a.analysis.reason])).toEqual([['unreadable', 'pdf-password'], ['unreadable', 'too-large'], ['unreadable', 'parse-failed']]);
    expect(JSON.stringify(r)).not.toContain('SECRET-TEXT');
    expect(calls.closed).toBe(1);                       // one session per message, closed once
    // secret-like extracted text is withheld and discarded
    const s = await ex.analyzeAttachments({ attachments: [att('creds.docx')], budget: budget(), flagOn: true, fetchOne: okFetch(), deps: { extractItem: extract } });
    expect(s.attachments[0].analysis).toMatchObject({ status: 'unreadable', reason: 'sensitive-content-withheld' });
    expect(s.excerpts).toEqual([]);
    expect(JSON.stringify(s)).not.toContain('CREDS-SENTINEL');
    expect(calls.closed).toBe(2);
    // a throwing fetch, an oversize download and a fetch timeout are unreadable with a reason; the session still closes
    const f = await ex.analyzeAttachments({
      attachments: [att('a.pdf'), att('b.pdf'), att('c.pdf')], budget: budget(), flagOn: true, deps: { extractItem: stubExtract({}, calls) },
      fetchOne: async (a) => { if (a.name === 'a.pdf') throw new Error('net'); return { ok: false, reason: a.name === 'b.pdf' ? 'too-large' : 'timeout' }; },
    });
    expect(f.attachments.map((a) => a.analysis.reason)).toEqual(['fetch-failed', 'too-large', 'timeout']);
    // withExtractSession closes on success, on a throw and when the fn never opened a session
    let closed = 0;
    await ex.withExtractSession(async (ctx) => { ctx.session = { close() { closed++; } }; return 1; });
    await expect(ex.withExtractSession(async (ctx) => { ctx.session = { close() { closed++; } }; throw new Error('x'); })).rejects.toThrow('x');
    await ex.withExtractSession(async () => 2);
    await ex.withExtractSession(async (ctx) => { ctx.session = { close() { closed++; throw new Error('already gone'); } }; });
    expect(closed).toBe(3);
  });

  it('R6.5 9th attachment skipped (8 per scan, 3 per message), excerpts bounded', async () => {
    const b = budget();
    const extract = stubExtract(new Proxy({}, { get: () => read('pdf', 'Total ' + 'line of an estimate. '.repeat(600) + ' parts ETA 11/12 for unit 40123 labor 2h') }));
    const msgs = [0, 1, 2].map((m) => [0, 1, 2, 3].map((i) => att('m' + m + '-' + i + '.pdf')));
    const out = [];
    for (const list of msgs) out.push(await ex.analyzeAttachments({ attachments: list, budget: b, flagOn: true, fetchOne: okFetch(), unitIds: ['40123'], deps: { extractItem: extract } }));
    const st = out.map((r) => r.attachments.map((a) => a.analysis.status === 'skipped' ? a.analysis.reason : a.analysis.status));
    expect(st[0]).toEqual(['content', 'content', 'content', 'message-limit']);
    expect(st[1]).toEqual(['content', 'content', 'content', 'message-limit']);
    expect(st[2]).toEqual(['content', 'content', 'scan-limit', 'scan-limit']);       // the 9th allowed attachment is skipped
    expect(b.used).toBe(8);
    for (const r of out) {
      for (const x of r.excerpts) expect(x.text.length).toBeLessThanOrEqual(excerpt.PER_ATTACHMENT);
      expect(r.excerpts.reduce((a, x) => a + x.text.length, 0)).toBeLessThanOrEqual(excerpt.PER_MESSAGE);
    }
    // the keyword window past the head is kept (unit id, ETA, labor)
    expect(out[0].excerpts[0].text).toContain('parts ETA 11/12 for unit 40123');
    expect(out[0].excerpts[0].text.startsWith('Total line of an estimate.')).toBe(true);
  });

  it('excerpt selection is deterministic and bounded', () => {
    const t = 'A'.repeat(4000) + ' estimate total $4,200 ' + 'B'.repeat(4000) + ' unit 40999 ready ' + 'C'.repeat(4000);
    const a = excerpt.selectExcerpt(t, { unitIds: ['40999'] });
    expect(a).toBe(excerpt.selectExcerpt(t, { unitIds: ['40999'] }));
    expect(a.length).toBeLessThanOrEqual(6000);
    expect(a.slice(0, 3000)).toBe('A'.repeat(3000));
    expect(a).toContain('estimate total $4,200');
    expect(a).toContain('unit 40999 ready');
    expect(excerpt.selectExcerpt('short text')).toBe('short text');
    const many = excerpt.messageExcerpts([{ index: 0, text: 'x'.repeat(6000) }, { index: 1, text: 'y'.repeat(6000) }, { index: 2, text: 'z'.repeat(10) }]);
    expect(many.map((x) => x.text.length)).toEqual([6000, 4000]);
  });
});

describe('F-14 memory-only excerpts and pending re-extract', () => {
  it('F-14 excerpt never persisted; pending-reextract re-fetches on retry', async () => {
    const SENT = 'EXCERPT-SENTINEL-5150 estimate total $1,840';
    const extract = stubExtract({ 'Estimate.pdf': read('pdf', SENT) });
    const calls = { n: 0 };
    const r = await ex.analyzeAttachments({ attachments: [att('Estimate.pdf')], budget: budget(), flagOn: true, fetchOne: okFetch(calls), deps: { extractItem: extract } });
    // what a caller may persist (the attachment records) carries status, hash and counts only
    expect(JSON.stringify(r.attachments)).not.toContain('EXCERPT-SENTINEL');
    expect(r.excerpts[0].text).toContain('EXCERPT-SENTINEL');
    // the message analysis did not finish: the analyzed attachment becomes pending-reextract
    const stored = JSON.parse(JSON.stringify(r.attachments));
    expect(ex.markPendingReextract(stored)).toBe(1);
    expect(stored[0].analysis.status).toBe('pending-reextract');
    expect(ex.hasPendingReextract({ attachments: stored })).toBe(true);
    // targets: re-open by the real conversation id; a derived id is unreachable
    const doc = { messages: {
      m1: { messageKey: 'm1', conversationKey: 'cv_1', convIdRaw: 'AAQk-1', convIdSource: 'owa', folder: 'Inbox', receivedAt: '2026-11-04T10:00:00Z', attachments: stored },
      m2: { messageKey: 'm2', conversationKey: 'cv_2', convIdRaw: '', convIdSource: 'derived', folder: 'Inbox', attachments: JSON.parse(JSON.stringify(stored)) },
    } };
    const t = ex.reextractTargets(doc, { max: 8 });
    expect(t.targets).toEqual([{ messageKey: 'm1', conversationKey: 'cv_1', convIdRaw: 'AAQk-1', folder: 'Inbox', indexes: [0] }]);
    expect(t.unreachable).toEqual(['m2']);
    expect(ex.markNotFound(doc.messages.m2.attachments)).toBe(1);
    expect(doc.messages.m2.attachments[0].analysis).toMatchObject({ status: 'unreadable', reason: 'not-found' });
    // retry: the attachment is fetched and extracted again (the excerpt comes back in memory only)
    const again = await ex.analyzeAttachments({ attachments: stored, only: new Set([0]), reextract: true, budget: budget(), flagOn: true, fetchOne: okFetch(calls), deps: { extractItem: extract } });
    expect(calls.n).toBe(2);
    expect(again.attachments[0].analysis.status).toBe('content');
    expect(again.excerpts[0].text).toContain('EXCERPT-SENTINEL');
    // failed re-fetches count; the third failure ends unreadable: reextract-exhausted
    let cur = stored;
    const states = [];
    for (let i = 0; i < 3; i++) {
      const f = await ex.analyzeAttachments({ attachments: cur, only: new Set([0]), reextract: true, budget: budget(), flagOn: true, fetchOne: async () => ({ ok: false, reason: 'timeout' }), deps: { extractItem: extract } });
      cur = f.attachments;
      states.push([cur[0].analysis.status, cur[0].analysis.reextractAttempts]);
    }
    expect(states).toEqual([['pending-reextract', 1], ['pending-reextract', 2], ['unreadable', 3]]);
    expect(cur[0].analysis.reason).toBe('reextract-exhausted');
    // a failure to re-open the message counts the same way
    const o2 = JSON.parse(JSON.stringify(stored));
    ex.recordReextractFailure(o2, null, 'open-failed'); ex.recordReextractFailure(o2, null); ex.recordReextractFailure(o2, null);
    expect(o2[0].analysis).toMatchObject({ status: 'unreadable', reason: 'reextract-exhausted', reextractAttempts: 3 });
  });
});
