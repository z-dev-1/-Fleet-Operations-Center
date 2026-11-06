// tests/email-intel-attach-policy.test.js — attachment policy (design 7.3, 7.5; R6.2, R6.5, F-24, F-28).
// Pure policy checks plus the real extractItem with a stubbed vision backend (bedrock) and a fake worker
// session: no file leaves the test, no model is called.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { att } from './fixtures/email-intel/attach.js';
const require = createRequire(import.meta.url);
const policy = require('../src/email-intel/attach/policy');
const ex = require('../src/email-intel/attach/extract');
const cfgMod = require('../src/email-intel/config');
const { REASONS } = require('../src/justme-context/constants');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.4\n%scanned page without a text layer\n');
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function budgetOf(over = {}, now = 1_000) {
  const cfg = cfgMod.normalize({ attachments: Object.assign({}, cfgMod.defaults().attachments, over) });
  return policy.createBudget(policy.policyOf(cfg), { now });
}

describe('R6.2 policy gates', () => {
  it('R6.2 allowlist, host, https, no redirect, flag', () => {
    const b = budgetOf();
    // flag OFF: every attachment stays filename-only and nothing is fetched
    expect(policy.decide(att('Estimate_40123.pdf'), b, { flagOn: false, now: 1_000 })).toEqual({ allow: false, status: 'filename-only', reason: 'flag-off' });
    expect(policy.enabled({ attachments: false })).toBe(false);
    expect(policy.enabled({ attachments: true })).toBe(true);
    // placeholders (a paperclip without a name) are never fetched
    expect(policy.decide({ placeholder: true, name: null, hasDownloadHandle: true }, b, { flagOn: true, now: 1_000 })).toMatchObject({ allow: false, status: 'filename-only', reason: 'no-name' });
    // extension allowlist (eml / msg / exe are not on the default list)
    expect(policy.policyOf({}).allowedExt).toEqual(['pdf', 'docx', 'xlsx', 'xls', 'png', 'jpg', 'jpeg']);
    for (const n of ['fwd.eml', 'note.msg', 'tool.exe', 'archive.zip']) expect(policy.decide(att(n), b, { flagOn: true, now: 1_000 })).toMatchObject({ allow: false, status: 'skipped', reason: 'extension-not-allowed' });
    // only the chip's own download link: no handle -> unreadable no-handle (labelled filename only)
    expect(policy.decide(att('Estimate_40123.pdf', { hasDownloadHandle: false }), b, { flagOn: true, now: 1_000 })).toMatchObject({ allow: false, status: 'unreadable', reason: 'no-handle' });
    expect(policy.decide(att('Estimate_40123.pdf'), b, { flagOn: true, now: 1_000 })).toMatchObject({ allow: true, ext: 'pdf' });
  });
});

describe('R6.2 fetch rules (attach/fetch.js)', () => {
  const fetchMod = require('../src/email-intel/attach/fetch');

  /** Runs the page script against a fake DOM (one chip) and a scripted fetch. */
  async function runPage(chip, respond, o = {}) {
    const seen = [];
    const doc = { querySelectorAll: () => [chip] };
    const fakeFetch = async (url, init) => { seen.push({ url, init }); return respond(url, init); };
    const script = fetchMod.buildFetchScript(Object.assign({ name: 'Estimate_40123.pdf', attId: '', maxBytes: 1000, timeoutMs: 30_000 }, o));
    // eslint-disable-next-line no-new-func
    const out = await new Function('document', 'location', 'fetch', 'btoa', 'return ' + script)(doc, { href: 'https://outlook.office.com/mail/inbox' }, fakeFetch, (s) => Buffer.from(s, 'latin1').toString('base64'));
    return { out: JSON.parse(out), seen };
  }
  const chipWith = (href, label = 'Estimate_40123.pdf 120 KB') => {
    const a = { getAttribute: (k) => (k === 'href' ? href : null) };
    return { tagName: 'DIV', innerText: label, getAttribute: (k) => (k === 'title' ? 'Estimate_40123.pdf' : null), querySelectorAll: () => (href ? [a] : []) };
  };
  const body = (bytes) => ({ getReader() { let done = false; return { read: async () => { if (done) return { done: true }; done = true; return { done: false, value: new Uint8Array(bytes) }; } }; } });
  const resp = (o) => Object.assign({ type: 'basic', status: 200, ok: true, url: '', headers: { get: () => null }, body: body([37, 80, 68, 70]) }, o);

  it('R6.2 host, https, no redirect: only the chip link on an Outlook host is fetched, never a constructed or service URL', async () => {
    const good = 'https://attachments.office.net/x';
    expect(fetchMod.hrefAllowed('https://outlook.office.com/mail/attach/AAMk1').ok).toBe(true);
    expect(fetchMod.hrefAllowed('https://outlook.office365.com/owa/attachment.ashx?id=1').ok).toBe(true);
    for (const bad of ['http://outlook.office.com/a', good, 'https://evil.example/?h=outlook.office.com', 'https://outlook.office.com.evil.example/a', 'https://user:pw@outlook.office.com/a', 'https://outlook.office.com:8443/a', 'javascript:alert(1)', '']) {
      expect(fetchMod.hrefAllowed(bad), bad).toEqual({ ok: false, reason: 'bad-host' });
    }
    for (const svc of ['https://outlook.office.com/owa/x.svc/s/GetFileAttachment', 'https://outlook.office.com/api/v1/me', 'https://outlook.office.com/EWS/Exchange.asmx']) {
      expect(fetchMod.hrefAllowed(svc).reason, svc).toBe('service-endpoint');
    }
    // the page script: chip link only, credentials of the existing session, redirect manual
    const ok = await runPage(chipWith('https://outlook.office.com/mail/attach/1'), () => resp({ url: 'https://outlook.office.com/mail/attach/1' }));
    expect(ok.out).toMatchObject({ status: 'ok', bytes: 4, mimetype: '' });
    expect(Buffer.from(ok.out.base64, 'base64').toString('latin1')).toBe('%PDF');
    expect(ok.seen).toHaveLength(1);
    expect(ok.seen[0].init).toMatchObject({ credentials: 'include', redirect: 'manual' });
    // no link on the chip -> no-handle, nothing fetched; a wrong host -> bad-host, nothing fetched
    const none = await runPage(chipWith(null), () => resp({}));
    expect([none.out.status, none.seen.length]).toEqual(['no-handle', 0]);
    const off = await runPage(chipWith('https://files.example.test/e.pdf'), () => resp({}));
    expect([off.out.status, off.seen.length]).toEqual(['bad-host', 0]);
    const svc = await runPage(chipWith('https://outlook.office.com/owa/a.svc/x'), () => resp({}));
    expect([svc.out.status, svc.seen.length]).toEqual(['service-endpoint', 0]);
    // a redirect is never followed
    expect((await runPage(chipWith('https://outlook.office.com/a'), () => resp({ type: 'opaqueredirect', status: 0, ok: false }))).out.status).toBe('redirect');
    expect((await runPage(chipWith('https://outlook.office.com/a'), () => resp({ status: 302, ok: false }))).out.status).toBe('redirect');
    // byte counting aborts above maxBytes (also when content-length lies)
    expect((await runPage(chipWith('https://outlook.office.com/a'), () => resp({ body: body(new Array(1001).fill(1)) }))).out.status).toBe('too-large');
    expect((await runPage(chipWith('https://outlook.office.com/a'), () => resp({ headers: { get: (k) => (k === 'content-length' ? '5000' : null) } }))).out.status).toBe('too-large');
    // a chip for another file is not used
    expect((await runPage(chipWith('https://outlook.office.com/a', 'Other.pdf'), () => resp({}), { name: 'Missing.pdf' })).out.status).toBe('no-chip');
  });

  it('R6.2 main-side fetch result checks (size, base64, auth wall, page errors)', async () => {
    const ctx = (r) => ({ alive: () => true, state: {}, execJson: async () => r });
    const b64 = Buffer.from('%PDF-1.4 x').toString('base64');
    expect(await fetchMod.fetchAttachment(ctx({ status: 'ok', base64: b64, mimetype: 'application/pdf' }), { name: 'a.pdf' }, { maxBytes: 100 })).toMatchObject({ ok: true, mimetype: 'application/pdf', bytes: 10 });
    expect(await fetchMod.fetchAttachment(ctx({ status: 'ok', base64: b64 }), { name: 'a.pdf' }, { maxBytes: 5 })).toEqual({ ok: false, reason: 'too-large' });
    expect(await fetchMod.fetchAttachment(ctx({ status: 'ok', base64: '<script>' }), { name: 'a.pdf' }, { maxBytes: 100 })).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(await fetchMod.fetchAttachment(ctx({ status: 'redirect' }), { name: 'a.pdf' }, { maxBytes: 100 })).toEqual({ ok: false, reason: 'redirect' });
    expect(await fetchMod.fetchAttachment(ctx({ status: 'weird page text' }), { name: 'a.pdf' }, { maxBytes: 100 })).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(await fetchMod.fetchAttachment(ctx(null), { name: 'a.pdf' }, { maxBytes: 100 })).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(await fetchMod.fetchAttachment({ alive: () => true, state: { authBlocked: true }, execJson: async () => ({ status: 'ok', base64: b64 }) }, { name: 'a.pdf' }, { maxBytes: 100 })).toEqual({ ok: false, reason: 'auth-wall' });
    expect(await fetchMod.fetchAttachment({ alive: () => false, execJson: async () => ({}) }, { name: 'a.pdf' }, {})).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(await fetchMod.fetchAttachment(ctx({}), { name: null }, {})).toEqual({ ok: false, reason: 'no-chip' });
  });
});

describe('R6.5 bounds', () => {
  it('R6.5 size/time/count caps', () => {
    const p = policy.policyOf({});
    expect(p).toMatchObject({ maxBytes: 6_000_000, maxPerMessage: 3, maxPerScan: 8, timeBudgetMs: 120_000, maxVision: 2, visionNoticeAcknowledged: false, fetchTimeoutMs: 30_000 });
    // configuration cannot pass the hard caps
    const hard = policy.policyOf({ attachments: { maxBytes: 50_000_000, maxPerMessage: 99, maxPerScan: 99, timeBudgetMs: 9_999_999, maxVision: 9 } });
    expect(hard).toMatchObject({ maxBytes: 10_000_000, maxPerMessage: 5, maxPerScan: 12, timeBudgetMs: 240_000, maxVision: 4 });
    const b = budgetOf();
    // known size from the chip text over 6 MB
    expect(policy.decide(att('big.pdf', { sizeBytes: 6_000_001 }), b, { flagOn: true, now: 1_000 })).toMatchObject({ status: 'skipped', reason: 'over-size' });
    expect(policy.decide(att('ok.pdf', { sizeBytes: 6_000_000 }), b, { flagOn: true, now: 1_000 })).toMatchObject({ allow: true });
    // per message: 3, then message-limit
    expect(policy.decide(att('4th.pdf'), b, { flagOn: true, perMessageUsed: 3, now: 1_000 })).toMatchObject({ status: 'skipped', reason: 'message-limit' });
    // per scan: 8, then scan-limit
    for (let i = 0; i < 8; i++) b.take();
    expect(policy.decide(att('9th.pdf'), b, { flagOn: true, now: 1_000 })).toMatchObject({ status: 'skipped', reason: 'scan-limit' });
    // time budget 120 s from scan start
    const t = budgetOf();
    expect(policy.decide(att('late.pdf'), t, { flagOn: true, now: 1_000 + 120_000 })).toMatchObject({ status: 'skipped', reason: 'time-budget' });
    expect(policy.decide(att('early.pdf'), t, { flagOn: true, now: 1_000 + 119_999 })).toMatchObject({ allow: true });
    // reason texts are fixed strings (never built from names or content)
    for (const code of ['flag-off', 'extension-not-allowed', 'over-size', 'message-limit', 'scan-limit', 'time-budget', 'no-handle', 'vision-notice-pending']) expect(policy.reasonText(code)).toMatch(/^[a-zA-Z' ,().-]+$/);
  });
});

describe('F-28 vision notice', () => {
  it('F-28 no vision call before notice acknowledged', async () => {
    const vision = { n: 0 };
    const bedrock = { readFileWithVision: async () => { vision.n++; return { ok: true, text: 'Estimate total $1,840 for unit 40123' }; } };
    // a fake worker session: the scanned PDF has no text layer and asks for vision
    const session = { extract: async () => ({ ok: true, kind: 'pdf', text: '', truncated: false, needsVision: true, reason: 'SCANNED_PDF_UNAVAILABLE', image: { name: 'scan.pdf', mimetype: 'application/pdf', buffer: PDF } }), close() {} };
    const deps = { bedrock, logger: quietLogger, session };
    const files = { 'photo.png': PNG, 'scan.pdf': PDF };
    const fetchOne = async (a) => ({ ok: true, buffer: files[a.name], mimetype: a.name.endsWith('.png') ? 'image/png' : 'application/pdf' });
    const list = [att('photo.png'), att('scan.pdf')];

    // not acknowledged: visionLeft 0, the image is not even fetched, the scanned PDF ends skipped; no vision call
    const pending = budgetOf({}, Date.now());
    expect(pending.visionLeft).toBe(0);
    expect(pending.noticePending).toBe(true);
    const r1 = await ex.analyzeAttachments({ attachments: list, budget: pending, flagOn: true, fetchOne, deps });
    expect(vision.n).toBe(0);
    expect(r1.attachments.map((a) => [a.analysis.status, a.analysis.reason])).toEqual([['skipped', 'vision-notice-pending'], ['skipped', 'vision-notice-pending']]);
    expect(r1.excerpts).toEqual([]);

    // acknowledged with "Turn off image reading" (maxVision 0): still no vision call
    const off = budgetOf({ visionNoticeAcknowledged: true, maxVision: 0 }, Date.now());
    expect(off.visionLeft).toBe(0);
    const r2 = await ex.analyzeAttachments({ attachments: list, budget: off, flagOn: true, fetchOne, deps });
    expect(vision.n).toBe(0);
    expect(r2.attachments.map((a) => [a.analysis.status, a.analysis.reason])).toEqual([['skipped', 'vision-off'], ['skipped', 'vision-off']]);

    // acknowledged with OK: the existing vision reader is used, at most maxVision times; output is content
    const ok = budgetOf({ visionNoticeAcknowledged: true }, Date.now());
    expect(ok.visionLeft).toBe(2);
    const r3 = await ex.analyzeAttachments({ attachments: list, budget: ok, flagOn: true, fetchOne, deps });
    expect(vision.n).toBe(2);
    expect(r3.attachments.map((a) => a.analysis.status)).toEqual(['content', 'content']);
    expect(r3.attachments[0].analysis.via).toBe('vision');
    expect(ok.visionLeft).toBe(0);
    // a third image in the same scan is refused before any fetch
    expect(policy.decide(att('third.jpg'), ok, { flagOn: true, now: Date.now() })).toMatchObject({ allow: false, reason: 'vision-limit' });
    expect(REASONS.VISION_CAP).toBeTruthy();
  });
});
