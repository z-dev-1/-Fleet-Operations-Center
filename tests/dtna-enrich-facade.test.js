// DTNA Phase A step 9 / Phase D: src/scrapers/dtna_enrich.js reads a DTNA case through the session-gated
// src/dtna/auto.js (live while signed in and stale, else the dtnaCaseCache entry). No electron.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
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
const HOUR = 3600e3;

let tmp;
let enrich;
let dstore;
let auto;
let prevElectron;
let open;
let pullCase;
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
  auto = require('../src/dtna/auto');
});
afterAll(() => {
  auto._resetForTests();
  if (prevElectron) require.cache[electronId] = prevElectron; else delete require.cache[electronId];
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});
beforeEach(() => {
  require('../src/store').save('dtnaCaseCache', { version: 1, cases: {} });
  open = true;
  pullCase = vi.fn(async (id) => {
    const e = dstore.put({ caseId: id, unitId: '122269', caseNumber: '15667050', caseStatus: 'In Repair', stageSince: '2026-11-21T10:00:00.000Z',
      offsiteText: 'LIVE THREAD', thread: 'LIVE RAW', offsiteStage: 'repair', pulledAt: new Date().toISOString() });
    return { ok: true, entry: e };
  });
  auto._resetForTests();
  auto._setDeps({ client: { pullCase }, session: { canAutoSync: () => open }, store: dstore });
});
afterEach(() => { delete process.env.DTNA_ENRICH; });

describe('dtna_enrich facade', () => {
  it('fresh cache hit (within freshMs) returns the full shape with rawThread and makes no pull', async () => {
    const pulledAt = new Date().toISOString();
    dstore.put({ caseId: CASE_ID, unitId: '122269', caseNumber: '15667050', caseStatus: 'In Repair', stageSince: '2026-11-20T12:00:00.000Z',
      offsiteText: 'Sep 24, 2026 — AFP FAS: [General] hello', thread: 'FULL THREAD', offsiteStage: 'repair', pulledAt });
    const r = await enrich.enrichDtna(caseUrl(CASE_ID), { freshMs: 2 * HOUR });
    expect(r).toEqual({
      ok: true, caseUrl: caseUrl(CASE_ID), source: 'dtna', scrapedAt: pulledAt,
      offsiteText: 'Sep 24, 2026 — AFP FAS: [General] hello', statusText: 'Sep 24, 2026 — AFP FAS: [General] hello',
      estimateComments: 'Sep 24, 2026 — AFP FAS: [General] hello', offsiteStage: 'repair',
      offsiteStageDetail: 'In Repair', offsiteStageSince: '2026-11-20T12:00:00.000Z', dtnaCaseNumber: '15667050',
      bestUrl: caseUrl(CASE_ID), bestLabel: 'DTNA Case', error: null, rawThread: 'FULL THREAD',
      estimateText: '', attachments: [],
    });
    expect(pullCase).not.toHaveBeenCalled();
  });

  it('Chatter + Files: returns the bounded estimateText and the read PDFs from the cache entry', async () => {
    dstore.put({ caseId: CASE_ID, unitId: '122269', offsiteText: 'T', thread: 'T', pulledAt: new Date().toISOString(), attachments: [
      { versionId: '068gx000001AbCdAAK', kind: 'pdf', status: 'read', name: 'R101048154.pdf', createdAt: '2026-11-21T09:00:00.000Z', text: 'Grand Total $1,234.56', total: 1234.56, totalLabeled: true },
      { versionId: '068gx000001AbCeAAK', kind: 'pdf', status: 'scanned', name: 'scan.pdf', text: '' },
    ] });
    const r = await enrich.enrichDtna(caseUrl(CASE_ID), { freshMs: 2 * HOUR });
    expect(r.estimateText).toContain('[R101048154.pdf, 2026-11-21] Grand total $1,234.56 (labelled)');
    expect(r.estimateText).toContain('Grand Total $1,234.56');
    expect(r.attachments.map((a) => a.name)).toEqual(['R101048154.pdf']);
  });

  it('stale cache while signed in -> one live pull, the live entry is returned', async () => {
    dstore.put({ caseId: CASE_ID, unitId: '122269', offsiteText: 'OLD', thread: 'OLD', pulledAt: new Date(Date.now() - 3 * HOUR).toISOString() });
    const r = await enrich.enrichDtna(caseUrl(CASE_ID), { freshMs: 2 * HOUR });
    expect(pullCase).toHaveBeenCalledTimes(1);
    expect(pullCase).toHaveBeenCalledWith(CASE_ID, { silent: true });
    expect(r).toMatchObject({ ok: true, offsiteText: 'LIVE THREAD', rawThread: 'LIVE RAW', dtnaCaseNumber: '15667050', offsiteStageDetail: 'In Repair' });
  });

  it('signed out -> the cached entry with no pull; no entry -> "DTNA signed out"', async () => {
    open = false;
    dstore.put({ caseId: CASE_ID, unitId: '122269', offsiteText: 'CACHED', thread: 'CACHED', pulledAt: new Date(Date.now() - 3 * HOUR).toISOString() });
    expect(await enrich.enrichDtna(caseUrl(CASE_ID), { freshMs: 2 * HOUR })).toMatchObject({ ok: true, offsiteText: 'CACHED' });
    const miss = await enrich.enrichDtna(caseUrl(NO_RO_CASE_ID), { freshMs: 2 * HOUR });
    expect(miss).toMatchObject({ ok: false, caseUrl: caseUrl(NO_RO_CASE_ID), source: 'dtna', offsiteText: '', statusText: '', estimateComments: '', offsiteStage: '', error: 'DTNA signed out' });
    expect(pullCase).not.toHaveBeenCalled();
  });

  it('signed in, the live read fails and nothing is cached -> "no DTNA pull yet"', async () => {
    pullCase.mockResolvedValue({ ok: false, code: 'DTNA_APEX_ERROR' });
    expect(await enrich.enrichDtna(caseUrl(NO_RO_CASE_ID))).toMatchObject({ ok: false, error: 'no DTNA pull yet' });
  });

  it('DTNA_ENRICH=0 disables it (no auto call)', async () => {
    process.env.DTNA_ENRICH = '0';
    const r = await enrich.enrichDtna(caseUrl(CASE_ID));
    expect(r).toMatchObject({ ok: false, error: 'dtna enrich disabled' });
    expect(pullCase).not.toHaveBeenCalled();
  });

  it('a non-DTNA URL keeps today\'s message', async () => {
    expect(await enrich.enrichDtna('https://volvopg.asist.decisiv.net/fleet/estimates/123')).toMatchObject({ ok: false, error: 'not a DTNA Servicetracker case URL' });
    expect(await enrich.enrichDtna('')).toMatchObject({ ok: false, source: 'none', error: 'not a DTNA Servicetracker case URL' });
    expect(pullCase).not.toHaveBeenCalled();
  });

  it('exports only enrichDtna and DTNA_CASE_RE', () => {
    expect(Object.keys(enrich).sort()).toEqual(['DTNA_CASE_RE', 'enrichDtna']);
  });

  it('source reaches DTNA only through ../dtna/auto: no electron, BrowserWindow, executeJavaScript, logger or network module', () => {
    const src = fs.readFileSync(FACADE, 'utf8');
    expect(src).toContain("require('../dtna/auto')");
    expect(src).not.toMatch(/require\(['"]electron['"]\)/);
    expect(src).not.toMatch(/require\([^)]*auto-login/);
    expect(src).not.toMatch(/BrowserWindow/);
    expect(src).not.toMatch(/executeJavaScript/);
    expect(src).not.toMatch(/logger/);
    expect(src).not.toMatch(/require\(\s*['"][^'"]*dtna\/(client|aura|session|capture)(\.js)?['"]\s*\)/);
  });
});
