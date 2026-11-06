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

describe('reader wiring (capture/owa_capture.js)', () => {
  it('attachments are fetched only when the flag is effective, for the newest message of the row; the excerpt rides on the capture only', async () => {
    const { createWorld, warmOk, noSleep } = await import('./fixtures/email-intel/fake-owa.js');
    const E = await import('./fixtures/email-intel/emails.js');
    const cap = require('../src/email-intel/capture/owa_capture');
    const href = ['https://outlook.office.com/mail/attach/AAMk1'];
    const snap = E.snapshot({ subject: 'Estimate 40123', blocks: [
      E.block({ text: 'Older message for 40123.', convId: 'conv/inbox/0=', attachments: [E.att('Old.pdf', { hrefs: href })] }),
      E.block({ text: 'Estimate attached for 40123.', convId: 'conv/inbox/0=', attachments: [E.att('Estimate_40123.pdf', { hrefs: href })] }),
    ] });
    const run = async (attachments) => {
      const { electron } = createWorld({ Inbox: { rows: [E.rowDesc({ i: 0, hasAttach: true })], snapshots: { 'conv/inbox/0=': snap } } });
      const batches = [];
      const fetched = [];
      const res = await cap.readMailbox({
        folders: ['Inbox'], onBatch: async (_f, items) => { batches.push(...items); }, _electron: electron, _warm: warmOk, _sleep: noSleep, authGraceMs: 20, now: Date.parse('2026-11-04T20:00:00Z'),
        attachments: attachments ? Object.assign({ flagOn: true, budget: budget(), unitIds: ['40123'], fetchOne: async (_ctx, a) => { fetched.push(a.name); return { ok: true, buffer: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf' }; } }, attachments) : undefined,
      });
      return { res, batches, fetched };
    };
    const extract = stubExtract({ 'Estimate_40123.pdf': read('pdf', 'Estimate total $1,840 for unit 40123'), 'Old.pdf': read('pdf', 'old') });
    // flag OFF (no attachments option): no fetch at all, every attachment filename-only
    const off = await run(null);
    expect(off.fetched).toEqual([]);
    const offCaps = off.batches.flatMap((b) => b.captures);
    expect(offCaps.flatMap((c) => c.attachments.map((a) => a.analysis.status))).toEqual(['filename-only', 'filename-only']);
    expect(offCaps.some((c) => c.attachmentExcerpts)).toBe(false);
    // flag ON: only the newest block's attachment is fetched and extracted
    const on = await run({ deps: { extractItem: extract } });
    expect(on.res.ok).toBe(true);
    expect(on.fetched).toEqual(['Estimate_40123.pdf']);
    const caps = on.batches.flatMap((b) => b.captures);
    const latest = caps.find((c) => c.isLatest);
    expect(latest.attachments[0].analysis).toMatchObject({ status: 'content', via: 'pdf-text' });
    expect(latest.attachmentExcerpts).toEqual([{ index: 0, status: 'content', text: 'Estimate total $1,840 for unit 40123', cut: false }]);
    expect(caps.find((c) => !c.isLatest).attachments[0].analysis.status).toBe('filename-only');
    // the ledger record built from the capture keeps only the status (memory-only excerpt, F-14)
    const ledger = require('../src/email-intel/ingest/ledger');
    const doc = ledger.emptyDoc();
    const rec = ledger.buildRecord(latest, doc, { me: { names: [], addresses: [] }, now: Date.now() }).record;
    expect(JSON.stringify(rec)).not.toContain('$1,840');
    expect(rec.attachments[0].analysis.status).toBe('content');
  });
});

describe('F-14 memory-only excerpts and pending re-extract', () => {
  it('F-14 at runIntelScan level: excerpt never persisted, unfinished analysis marks pending-reextract, the next scan re-fetches and analyzes with it', async () => {
    const fsMod = await import('fs');
    const pathMod = await import('path');
    const { phaseCWorld } = await import('./fixtures/email-intel/phase-c.js');
    const { PHASE_F, attReader } = await import('./fixtures/email-intel/attach.js');
    const w = phaseCWorld(PHASE_F);
    try {
      const SENT = 'XCERPT-SENTINEL-7781';
      const extract = stubExtract({ 'Estimate_40123.pdf': read('pdf', 'Repair estimate for unit 40123. ' + SENT + ' Parts ETA 11/12. Total $1,840.') });
      const c = w.cap({ subject: 'Estimate 40123', conversationId: 'conv-f14', body: 'Hi Zila, the estimate for 40123 is attached.', attachments: [att('Estimate_40123.pdf')] });
      w.relay.available = false;                                   // the lane is down: analysis cannot finish this scan
      const r1 = attReader([c], { extract });
      await w.scan([c], { _readMailbox: r1 });
      expect(r1.calls.fetch).toBe(1);
      expect(w.relay.calls).toHaveLength(0);
      const m1 = Object.values(w.messages())[0];
      expect(m1.analysis.status).toBe('pending');
      expect(m1.attachments[0].analysis.status).toBe('pending-reextract');
      const files = () => fsMod.readdirSync(w.tmp).filter((f) => f.endsWith('.json')).map((f) => fsMod.readFileSync(pathMod.join(w.tmp, f), 'utf8')).join('\n');
      expect(files()).not.toContain(SENT);
      // next scan: lane back; the pending attachment is re-fetched (re-extract pass), the excerpt reaches the prompt, analysis finishes
      w.relay.available = true;
      const r3 = attReader([], { extract });
      await w.scan([], { _readMailbox: r3 });
      expect(r3.calls.reextractTargets).toBe(1);
      expect(r3.calls.fetch).toBe(1);
      const prompts = w.relay.calls.map((x) => x.prompt);
      expect(prompts.some((p) => p.includes('<<<UNTRUSTED_ATTACHMENT id=') && p.includes(SENT))).toBe(true);
      const m2 = Object.values(w.messages())[0];
      expect(m2.analysis.status).toBe('ok');
      expect(m2.attachments[0].analysis.status).toBe('content');
      expect(files()).not.toContain(SENT);
      // a later scan does not fetch again (analysis finished)
      const r4 = attReader([], { extract });
      await w.scan([], { _readMailbox: r4 });
      expect([r4.calls.reextractTargets, r4.calls.fetch]).toEqual([0, 0]);
    } finally { w.cleanup(); }
  }, 30_000);

  it('F-14 a message that cannot be found again ends unreadable: not-found and is analyzed on its body', async () => {
    const { phaseCWorld } = await import('./fixtures/email-intel/phase-c.js');
    const { PHASE_F, attReader } = await import('./fixtures/email-intel/attach.js');
    const w = phaseCWorld(PHASE_F);
    try {
      const extract = stubExtract({ 'Estimate_40123.pdf': read('pdf', 'Repair estimate for unit 40123. Total $1,840.') });
      const c = w.cap({ subject: 'Estimate 40123', conversationId: 'conv-f14b', body: 'Hi Zila, the estimate for 40123 is attached.', attachments: [att('Estimate_40123.pdf')] });
      w.relay.available = false;
      await w.scan([c], { _readMailbox: attReader([c], { extract }) });
      expect(Object.values(w.messages())[0].attachments[0].analysis.status).toBe('pending-reextract');
      w.relay.available = true;
      const r = attReader([], { extract, notFound: true });
      await w.scan([], { _readMailbox: r });
      const m = Object.values(w.messages())[0];
      expect(m.attachments[0].analysis).toMatchObject({ status: 'unreadable', reason: 'not-found' });
      expect(m.analysis.status).toBe('ok');
      expect(w.relay.calls.some((x) => x.prompt.includes('<<<UNTRUSTED_ATTACHMENT id='))).toBe(false);
    } finally { w.cleanup(); }
  }, 30_000);
});

describe('F-14 memory-only excerpts and pending re-extract (unit)', () => {
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
