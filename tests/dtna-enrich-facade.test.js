// DTNA Phase A step 9: src/scrapers/dtna_enrich.js is a no-network facade over dtnaCaseCache.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_ID, NO_RO_CASE_ID } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACADE = path.join(ROOT, 'src', 'scrapers', 'dtna_enrich.js');
const caseUrl = (id) => 'https://dtna.my.site.com/Servicetracker/s/case/' + id + '/detail';

let tmp;
let enrich;
let dstore;
let prevElectron;
const electronId = require.resolve('electron');

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-facade-'));
  require('../src/config/paths').setDataDir(tmp);
  // "No electron": any touch of the electron module throws.
  prevElectron = require.cache[electronId];
  const boom = new Proxy({}, { get(_t, k) { if (k === '__esModule' || typeof k === 'symbol') return undefined; throw new Error('electron touched: ' + String(k)); } });
  require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: boom };
  delete require.cache[require.resolve('../src/scrapers/dtna_enrich')];
  enrich = require('../src/scrapers/dtna_enrich');
  dstore = require('../src/dtna/store');
});
afterAll(() => {
  if (prevElectron) require.cache[electronId] = prevElectron; else delete require.cache[electronId];
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});
afterEach(() => { delete process.env.DTNA_ENRICH; });

describe('dtna_enrich facade', () => {
  it('cache hit returns the full shape with rawThread', async () => {
    const pulledAt = new Date().toISOString();
    dstore.put({ caseId: CASE_ID, unitId: '122269', offsiteText: 'Sep 24, 2026 — AFP FAS: [General] hello', thread: 'FULL THREAD', offsiteStage: 'repair', pulledAt });
    const r = await enrich.enrichDtna(caseUrl(CASE_ID));
    expect(r).toEqual({
      ok: true, caseUrl: caseUrl(CASE_ID), source: 'dtna', scrapedAt: pulledAt,
      offsiteText: 'Sep 24, 2026 — AFP FAS: [General] hello', statusText: 'Sep 24, 2026 — AFP FAS: [General] hello',
      estimateComments: 'Sep 24, 2026 — AFP FAS: [General] hello', offsiteStage: 'repair', bestUrl: caseUrl(CASE_ID),
      bestLabel: 'DTNA Case', error: null, rawThread: 'FULL THREAD',
    });
  });

  it('cache miss -> ok:false, error "no DTNA pull yet"', async () => {
    const r = await enrich.enrichDtna(caseUrl(NO_RO_CASE_ID));
    expect(r).toMatchObject({ ok: false, caseUrl: caseUrl(NO_RO_CASE_ID), source: 'dtna', offsiteText: '', statusText: '', estimateComments: '', offsiteStage: '', error: 'no DTNA pull yet' });
  });

  it('DTNA_ENRICH=0 disables it', async () => {
    process.env.DTNA_ENRICH = '0';
    const r = await enrich.enrichDtna(caseUrl(CASE_ID));
    expect(r).toMatchObject({ ok: false, error: 'dtna enrich disabled' });
  });

  it('a non-DTNA URL keeps today\'s message', async () => {
    expect(await enrich.enrichDtna('https://volvopg.asist.decisiv.net/fleet/estimates/123')).toMatchObject({ ok: false, error: 'not a DTNA Servicetracker case URL' });
    expect(await enrich.enrichDtna('')).toMatchObject({ ok: false, source: 'none', error: 'not a DTNA Servicetracker case URL' });
  });

  it('exports only enrichDtna and DTNA_CASE_RE', () => {
    expect(Object.keys(enrich).sort()).toEqual(['DTNA_CASE_RE', 'enrichDtna']);
  });

  it('source has no electron, auto-login, BrowserWindow or executeJavaScript', () => {
    const src = fs.readFileSync(FACADE, 'utf8');
    expect(src).not.toMatch(/require\(['"]electron['"]\)/);
    expect(src).not.toMatch(/auto-login/);
    expect(src).not.toMatch(/BrowserWindow/);
    expect(src).not.toMatch(/executeJavaScript/);
    expect(src).not.toMatch(/logger/);
  });
});
