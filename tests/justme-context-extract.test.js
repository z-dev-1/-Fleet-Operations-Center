// Extraction: pure helpers (T-ZIPBOMB, T-HEIC-PIXELS, T-HTML-PERF, detectType, decode, PDF
// page cap, PDFJS_UNAVAILABLE routing) and T-EXTRACT through the REAL worker with real
// parser libraries.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fx, spawnRealWorker, makeLogger, allLogged } = require('./helpers/jmctx-worker.cjs');
const { detectType, verifyZip, htmlToText, heicDimensions, decodeText, extractBuffer } = require('../src/justme-context/extract');
const { extractItem } = require('../src/justme-context/extract-host');
const { VISION_PROMPT } = require('../src/justme-context/vision');
const { LIMITS, REASONS } = require('../src/justme-context/constants');

const SENTINEL = 'SENTINEL-CONTENT-7f3a';
const job = (name, buffer, mimetype = '') => ({ name, mimetype, buffer });

describe('detectType', () => {
  const table = [
    ['text.pdf', 'pdf'], ['sample.docx', 'docx'], ['sample.pptx', 'pptx'], ['sample.xlsx', 'xlsx'], ['sample.ods', 'ods'],
    ['sample.xls', 'xls'], ['sample.msg', 'msg'], ['sample.eml', 'eml'], ['sample.csv', 'csv'], ['sample.html', 'html'],
    ['sample.txt', 'text'], ['sample.js', 'text'], ['sample.json', 'text'], ['tiny.png', 'png'], ['tiny.jpg', 'jpg'],
    ['tiny.gif', 'gif'], ['tiny.webp', 'webp'], ['ok-ispe.heic', 'heic'], ['tiny.avif', 'avif'], ['unknown.bin', 'unknown'],
  ];
  for (const [name, kind] of table) it(name + ' -> ' + kind, () => { expect(detectType(fx(name), name, '').kind).toBe(kind); });
  it('magic bytes win over a wrong extension', () => { expect(detectType(fx('text.pdf'), 'renamed.txt', 'text/plain').kind).toBe('pdf'); });
  it('mimetype is the last resort', () => {
    expect(detectType(Buffer.from('a,b'), 'data', 'text/csv').kind).toBe('csv');
    expect(detectType(Buffer.from('{}'), 'data', 'application/json').kind).toBe('text');
  });
  it('OLE files are typed by extension; .doc/.ppt are unsupported', () => {
    expect(detectType(fx('sample.xls'), 'x.doc', '').kind).toBe('doc');
    expect(detectType(fx('sample.xls'), 'x.ppt', '').kind).toBe('ppt');
    expect(detectType(fx('sample.xls'), 'x', '').kind).toBe('cfb');
  });
  it('an unreadable zip with an Office extension still routes to verifyZip', () => {
    expect(detectType(fx('zip64.docx'), 'zip64.docx', '').kind).toBe('docx');
    expect(detectType(fx('zip64.docx'), 'zip64.bin', '').kind).toBe('zip');
  });
  it('heic: mif1 with avif compat brand is avif; with heic is heic', () => {
    const mk = (major, compat) => { const b = Buffer.alloc(16 + compat.length * 4); b.writeUInt32BE(b.length, 0); b.write('ftyp', 4, 'latin1'); b.write(major, 8, 'latin1'); compat.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1')); return b; };
    expect(detectType(mk('mif1', ['avif']), 'x', '').kind).toBe('avif');
    expect(detectType(mk('mif1', ['heic']), 'x', '').kind).toBe('heic');
    expect(detectType(mk('mif1', ['mp41']), 'x', '').kind).toBe('unknown');
  });
});

describe('T-ZIPBOMB', () => {
  const spies = () => ({ mammoth: { extractRawText: vi.fn(async () => ({ value: 'ok' })) }, jszip: { loadAsync: vi.fn() }, xlsx: { read: vi.fn() } });
  const rules = { 'bomb.docx': 'entry-size', 'liar.docx': 'inflate', 'zip64.docx': 'zip64', 'dupe.docx': 'duplicate', 'badmethod.docx': 'method' };
  for (const [name, rule] of Object.entries(rules)) {
    it(name + ' is rejected (' + rule + ') before any library sees it', async () => {
      const deps = spies();
      expect(verifyZip(fx(name), 'docx')).toEqual({ ok: false, rule });
      const r = await extractBuffer(job(name, fx(name)), { maxChars: 60000 }, deps);
      expect(r).toMatchObject({ ok: false, reason: 'ZIP_UNSAFE' });
      expect(r.errCode).toMatch(/^[A-Za-z0-9_]{1,40}$/);
      expect(deps.mammoth.extractRawText).not.toHaveBeenCalled();
      expect(deps.jszip.loadAsync).not.toHaveBeenCalled();
      expect(deps.xlsx.read).not.toHaveBeenCalled();
    });
  }
  it('honest files pass verifyZip and reach the library', async () => {
    for (const n of ['sample.docx', 'sample.pptx', 'sample.xlsx', 'sample.ods']) expect(verifyZip(fx(n), 'x')).toEqual({ ok: true });
    const deps = spies();
    const r = await extractBuffer(job('sample.docx', fx('sample.docx')), { maxChars: 60000 }, deps);
    expect(r).toMatchObject({ ok: true, kind: 'docx', text: 'ok' });
    expect(deps.mammoth.extractRawText).toHaveBeenCalledTimes(1);
  });
  it('a corrupt buffer is rejected, not thrown', () => {
    expect(verifyZip(Buffer.from('PK\x03\x04garbage'), 'docx').ok).toBe(false);
    expect(verifyZip(Buffer.alloc(0), 'docx').ok).toBe(false);
  });
});

describe('T-HEIC-PIXELS', () => {
  it('heicDimensions reads ispe', () => {
    expect(heicDimensions(fx('ok-ispe.heic'))).toBe(10000);
    expect(heicDimensions(fx('big-ispe.heic'))).toBe(8064 * 6048);
    expect(heicDimensions(fx('noispe.heic'))).toBe(0);
    expect(heicDimensions(Buffer.from('not a heic'))).toBe(0);
  });
  it('big and no-ispe are rejected without calling heicConvert; ok-ispe converts once', async () => {
    const heicConvert = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const deps = { heicConvert };
    expect(await extractBuffer(job('big.heic', fx('big-ispe.heic')), {}, deps)).toMatchObject({ ok: false, reason: 'HEIC_TOO_LARGE' });
    expect(await extractBuffer(job('no.heic', fx('noispe.heic')), {}, deps)).toMatchObject({ ok: false, reason: 'HEIC_FAILED' });
    expect(heicConvert).not.toHaveBeenCalled();
    const r = await extractBuffer(job('photo.heic', fx('ok-ispe.heic')), {}, deps);
    expect(heicConvert).toHaveBeenCalledTimes(1);
    expect(heicConvert.mock.calls[0][0]).toMatchObject({ format: 'JPEG', quality: 0.85 });
    expect(r).toMatchObject({ ok: true, needsVision: true, image: { name: 'photo.jpg', mimetype: 'image/jpeg' } });
  });
  it('truncated / malformed headers do not throw', () => {
    const b = fx('big-ispe.heic');
    for (let n = 0; n < b.length; n += 3) expect(() => heicDimensions(b.subarray(0, n))).not.toThrow();
  });
  it('AVIF is unsupported and nothing is converted', async () => {
    const heicConvert = vi.fn();
    expect(await extractBuffer(job('a.avif', fx('tiny.avif')), {}, { heicConvert })).toMatchObject({ ok: false, reason: 'AVIF_UNSUPPORTED' });
    expect(heicConvert).not.toHaveBeenCalled();
  });
});

describe('T-HTML-PERF', () => {
  for (const unit of ['<script', '<!--', '<a ']) {
    it('5 MB of ' + JSON.stringify(unit) + ' stays under 500 ms', () => {
      const s = unit.repeat(Math.ceil((5 * 1024 * 1024) / unit.length));
      const t0 = performance.now();
      htmlToText(s);
      expect(performance.now() - t0).toBeLessThan(500);
    });
  }
  it('unclosed script and comment', () => {
    expect(htmlToText('before<script>var x=1;')).toBe('before');
    expect(htmlToText('a<!-- never closed')).toBe('a');
    expect(htmlToText('a<script>x</script>b<style>y</style>c')).toBe('abc');
  });
  it('blocks, entities, title and meta description', () => {
    const t = htmlToText('<title>T &amp; U</title><meta name="description" content="Desc"><p>one</p><p>two&nbsp;&#65;&#x42;</p>');
    expect(t).toBe('T & U\nDesc\n\none\n\ntwo AB');
  });
  it('nested/odd tags do not loop or throw', () => {
    expect(htmlToText('<<<>>> < a <b <c>d')).toContain('d');
    expect(htmlToText('<!DOCTYPE html><html>x</html>')).toBe('x');
  });
  it('honours maxChars', () => { expect(htmlToText('<p>' + 'x'.repeat(1000) + '</p>', 100)).toHaveLength(100); });
});

describe('text decoding', () => {
  it('utf-8, BOM, windows-1252 fallback, utf-16', () => {
    expect(decodeText(Buffer.from('héllo')).text).toBe('héllo');
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom')])).text).toBe('bom');
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])).text).toBe('café');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])).text).toBe('hi');
  });
  it('NUL in the first 8 KB means binary', async () => {
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62])).binary).toBe(true);
    expect(await extractBuffer(job('x.txt', Buffer.from([0x61, 0x00, 0x62])), {}, {})).toMatchObject({ ok: false, reason: 'TEXT_BINARY' });
  });
});

describe('PDF: page cap and pdfjs unavailable (fix 13)', () => {
  const fakePdfjs = (pages, onPage) => ({
    getDocument: () => ({ promise: Promise.resolve({ numPages: pages, getPage: async (n) => { onPage(n); return { getTextContent: async () => ({ items: [{ str: 'page ' + n + ' ' + 'x'.repeat(60), hasEOL: true }] }), cleanup() {} }; }, destroy: async () => {} }) }),
  });
  it('reads at most 50 pages', async () => {
    const seen = [];
    const r = await extractBuffer(job('big.pdf', fx('text.pdf')), { maxChars: 60000 }, { importPdfjs: async () => fakePdfjs(80, (n) => seen.push(n)) });
    expect(seen).toHaveLength(LIMITS.PDF_MAX_PAGES);
    expect(r).toMatchObject({ ok: true, truncated: true, meta: { pages: 80 } });
  });
  it('stops between pages once cancelled', async () => {
    const seen = [];
    const ctx = { maxChars: 60000, cancelled: false };
    await extractBuffer(job('big.pdf', fx('text.pdf')), ctx, { importPdfjs: async () => fakePdfjs(20, (n) => { seen.push(n); if (n === 3) ctx.cancelled = true; }) });
    expect(seen).toEqual([1, 2, 3]);
  });
  it('a rejecting pdfjs import routes to vision with PDFJS_UNAVAILABLE', async () => {
    const r = await extractBuffer(job('doc.pdf', fx('text.pdf')), {}, { importPdfjs: async () => { throw Object.assign(new Error('Cannot find module SENTINEL-CONTENT-7f3a'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
    expect(r).toMatchObject({ ok: true, needsVision: true, reason: 'PDFJS_UNAVAILABLE', errCode: 'ERR_MODULE_NOT_FOUND', image: { name: 'doc.pdf', mimetype: 'application/pdf' } });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});

describe('VISION_PROMPT (AC-41)', () => {
  it('contains the ./%%NAME%% placeholder bedrock substitutes', () => { expect(VISION_PROMPT).toContain('./%%NAME%%'); });
});

// ───────────────────────── T-EXTRACT: every fixture through the REAL worker ─────────────────────────

describe('T-EXTRACT (real worker, real parsers)', () => {
  const logger = makeLogger(vi);
  const bedrock = { readFileWithVision: vi.fn(async () => ({ ok: true, text: 'VISION TEXT' })) };
  const deps = { spawnWorker: spawnRealWorker, logger, bedrock };
  const ctx = { deadline: Date.now() + 10 * 60 * 1000, visionLeft: 100, signal: undefined };
  afterAll(() => { if (ctx.session) ctx.session.close(); });
  const read = (name, mimetype) => extractItem({ buffer: fx(name), name, mimetype: mimetype || '' }, ctx, deps);

  const readable = ['text.pdf', 'sample.docx', 'sample.pptx', 'sample.xlsx', 'sample.xls', 'sample.ods', 'sample.csv', 'sample.txt', 'sample.md',
    'sample.json', 'sample.log', 'sample.js', 'sample.html', 'sample.eml', 'sample.msg'];
  for (const name of readable) {
    it(name + ' -> read, contains the sentinel', async () => {
      const it_ = await read(name);
      expect(it_.status).toBe('read');
      expect(it_.text).toContain(SENTINEL);
      expect(it_.chars).toBe(it_.text.length);
    }, 30000);
  }
  it('cid.pdf yields the CJK characters (CMap options work)', async () => {
    const it_ = await read('cid.pdf');
    expect(it_.status).toBe('read');
    expect(it_.text).toContain('中文');
    expect(it_.text).toContain(SENTINEL);
  }, 30000);
  it('pptx has slides and notes', async () => {
    const t = (await read('sample.pptx')).text;
    expect(t).toContain('## Slide 1');
    expect(t).toContain('Notes: speaker note text');
    expect(t).toContain('Second slide & more');
  });
  it('xlsx has the sheet header and csv rows', async () => { expect((await read('sample.xlsx')).text).toMatch(/## Sheet: Fleet\nunit,note\n320160,/); });
  it('html drops script/style/comments', async () => {
    const t = (await read('sample.html')).text;
    expect(t).toContain('Fixture page');
    expect(t).not.toContain('not text');
    expect(t).not.toContain('color:red');
  });
  it('eml lists headers and attachment names', async () => {
    const t = (await read('sample.eml')).text;
    expect(t).toContain('Subject: Sample email');
    expect(t).toContain('Attachments: note.txt');
  });

  it('encrypted.pdf -> failed, password-protected', async () => {
    expect(await read('encrypted.pdf')).toMatchObject({ status: 'failed', reason: REASONS.PDF_PASSWORD, text: '' });
  });
  it('scanned.pdf goes to vision as application/pdf with the ./%%NAME%% prompt', async () => {
    bedrock.readFileWithVision.mockClear();
    const it_ = await read('scanned.pdf');
    expect(it_).toMatchObject({ status: 'read', text: 'VISION TEXT', meta: expect.objectContaining({ via: 'vision' }) });
    const [file, opts] = bedrock.readFileWithVision.mock.calls[0];
    expect(file).toMatchObject({ name: 'scanned.pdf', mimetype: 'application/pdf' });
    expect(opts.prompt).toContain('./%%NAME%%');
    expect(opts).toMatchObject({ source: 'vision_document', redactLog: true });
  });
  it('scanned.pdf with vision unavailable / failing gets the scanned-PDF reasons', async () => {
    bedrock.readFileWithVision.mockResolvedValueOnce({ ok: false, error: 'claude-code not installed' });
    expect(await read('scanned.pdf')).toMatchObject({ status: 'failed', reason: REASONS.SCANNED_PDF_UNAVAILABLE });
    bedrock.readFileWithVision.mockResolvedValueOnce({ ok: false, error: 'could not read the file' });
    expect(await read('scanned.pdf')).toMatchObject({ status: 'failed', reason: REASONS.SCANNED_PDF_FAILED });
  });
  for (const name of ['tiny.png', 'tiny.jpg', 'tiny.gif', 'tiny.webp']) {
    it(name + ' is read by vision in main (no worker round trip)', async () => {
      bedrock.readFileWithVision.mockClear();
      const it_ = await read(name);
      expect(it_).toMatchObject({ status: 'read', text: 'VISION TEXT' });
      expect(bedrock.readFileWithVision.mock.calls[0][0]).toMatchObject({ name });
      expect(bedrock.readFileWithVision.mock.calls[0][1].source).toBe('vision_image');
    });
  }
  it('vision unavailable on an image -> failed with the fixed reason', async () => {
    bedrock.readFileWithVision.mockResolvedValueOnce({ ok: false, error: 'claude-code not installed' });
    expect(await read('tiny.png')).toMatchObject({ status: 'failed', reason: REASONS.VISION_UNAVAILABLE });
  });
  it('heic: oversized and header-less files fail with fixed reasons; avif is unsupported', async () => {
    expect(await read('big-ispe.heic')).toMatchObject({ status: 'failed', reason: REASONS.HEIC_TOO_LARGE });
    expect(await read('noispe.heic')).toMatchObject({ status: 'failed', reason: REASONS.HEIC_FAILED });
    expect(await read('tiny.avif')).toMatchObject({ status: 'unsupported', reason: REASONS.AVIF_UNSUPPORTED });
  });
  it('hostile zips fail with the fixed reason and the worker keeps serving', async () => {
    for (const n of ['bomb.docx', 'liar.docx', 'zip64.docx', 'dupe.docx', 'badmethod.docx']) {
      expect(await read(n)).toMatchObject({ status: 'failed', reason: REASONS.ZIP_UNSAFE });
    }
    expect((await read('sample.docx')).status).toBe('read');
  });
  it('unsupported and oversized inputs', async () => {
    expect(await read('unknown.bin')).toMatchObject({ status: 'unsupported', reason: "I can't read .bin files" });
    const hugeBuf = Buffer.alloc(26 * 1024 * 1024, 0x20);
    hugeBuf.write('%PDF-1.4', 0, 'latin1');
    const big = await extractItem({ buffer: hugeBuf, name: 'huge.pdf', mimetype: 'application/pdf' }, ctx, deps);
    expect(big).toMatchObject({ status: 'failed', reason: REASONS.TOO_LARGE });
  });
  it('a binary file named .txt fails with "looks binary"', async () => {
    expect(await extractItem({ buffer: fx('unknown.bin'), name: 'x.txt', mimetype: 'text/plain' }, ctx, deps)).toMatchObject({ status: 'failed', reason: REASONS.TEXT_BINARY });
  });
  it('no log line contains document text', () => {
    expect(allLogged(logger)).not.toContain(SENTINEL);
  });
});
