// T-SMOKE (Node): the real libraries load at their pinned versions and the real worker reads
// a CID-font PDF (CJK needs the CMap options). Fast feedback in `npm test`; the Electron
// variant is tests/smoke/justme-libs-main.cjs.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const { createWorkerSession } = require('../src/justme-context/extract-host');

// Read package.json from node_modules directly: some packages (xlsx) do not export it.
const pkgVersion = (n) => require('fs').existsSync(new URL('../node_modules/' + n + '/package.json', import.meta.url))
  ? JSON.parse(require('fs').readFileSync(new URL('../node_modules/' + n + '/package.json', import.meta.url), 'utf8')).version : 'missing';

describe('pinned libraries', () => {
  it('versions match the exact pins', () => {
    expect(pkgVersion('pdfjs-dist')).toBe('6.4.299');
    expect(pkgVersion('mammoth')).toBe('1.13.0');
    expect(pkgVersion('xlsx')).toBe('0.20.3');
    expect(pkgVersion('mailparser')).toBe('3.14.1');
    expect(pkgVersion('@kenjiuno/msgreader')).toBe('1.29.0');
    expect(pkgVersion('@napi-rs/canvas')).toBe('1.1.0');
  });
  it('every library loads', async () => {
    expect(typeof require('mammoth').extractRawText).toBe('function');
    expect(typeof require('xlsx').read).toBe('function');
    expect(typeof require('mailparser').simpleParser).toBe('function');
    const msg = require('@kenjiuno/msgreader');
    expect(typeof (msg.default || msg)).toBe('function');
    expect(typeof require('heic-convert')).toBe('function');
    expect(typeof require('jszip').loadAsync).toBe('function');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    expect(typeof pdfjs.getDocument).toBe('function');
  }, 30000);   // loading pdfjs + SheetJS can take several seconds under a full parallel run
});

describe('real worker, real libraries', () => {
  const session = createWorkerSession({ spawnWorker: H.spawnRealWorker, logger: H.makeLogger(vi), getChildRss: () => 1 });
  afterAll(() => session.close());
  const run = (name) => session.extract({ name, mimetype: '', buffer: H.fx(name) });

  it('cid.pdf: CJK text comes out (predefined CMap) next to the sentinel', async () => {
    const r = await run('cid.pdf');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('中文');
    expect(r.text).toContain('SENTINEL-CONTENT-7f3a');
  }, 30000);
  it('the worker refuses an oversized job with INVALID_JOB and keeps serving', async () => {
    const r = await session.extract({ name: 'huge.pdf', mimetype: '', buffer: Buffer.alloc(26 * 1024 * 1024) });
    expect(r).toMatchObject({ ok: false, reason: 'INVALID_JOB' });
    expect((await run('sample.txt')).ok).toBe(true);
  }, 30000);
  it('one worker serves several formats in a row', async () => {
    for (const n of ['sample.docx', 'sample.xlsx', 'sample.msg', 'sample.eml', 'text.pdf']) {
      const r = await run(n);
      expect(r.ok, n).toBe(true);
      expect(r.text, n).toContain('SENTINEL-CONTENT-7f3a');
    }
  }, 30000);
});
