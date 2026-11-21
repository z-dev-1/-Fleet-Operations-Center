// DTNA Phase A step 10: no token / context / pageURI / cookie / email / login URL in any log line,
// dtna:* IPC result, sendToWindow payload, dtnaCaseCache or fleetData; comment text only in the cache
// and the row (decision 6); static guards that keep DTNA network code user-initiated only.
process.env.TZ = 'America/New_York';
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { createFakeElectron, emitAuraSuccess, auraPostData, freshDtna, AURA_URL, WT_ROOT } from './fixtures/dtna/fake-electron.js';
import {
  CASE_ID, NO_RO_CASE_ID, CASE_RECORD, NO_RO_RECORD, RO_LIST, COMMENTS, NO_RO_COMMENTS,
  success, apexError, invalidSession, outOfSync, getItemsAction, listResult,
} from './fixtures/dtna/aura-responses.js';
import {
  SENTINEL_TOKEN, SENTINEL_CONTEXT, SENTINEL_PAGEURI, SENTINEL_COOKIE, SENTINEL_EMAIL, SENTINEL_COMMENT,
  SENTINEL_FROM, SENTINEL_LOGIN_URL, AUTH_SENTINELS, containsSentinel,
} from './fixtures/dtna/sentinels.js';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-redaction-'));
const DATA = path.join(TMP, 'data');
const DOWNLOADS = path.join(TMP, 'downloads');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
require('../src/config/paths').setDataDir(DATA);
const store = require('../src/store');

const caseUrl = (id) => 'https://dtna.my.site.com/Servicetracker/s/case/' + id + '/detail';
const APEX = 'aura://ApexActionController/ACTION$execute';

let logger; let fx; let handlers; let ctx; let session; let mode;

const SENT_COMMENTS = [
  { CommentId: 'a1Agx0000000004AAA', CommentType: 'General', FromName: SENTINEL_FROM, CommentText: 'Update ' + SENTINEL_COMMENT, CreatedDate: '2026-09-25T09:00:00.000Z' },
].concat(COMMENTS);

function headers() {
  return { get: (k) => { const n = String(k).toLowerCase(); if (n === 'set-cookie') return 'sid=' + SENTINEL_COOKIE; if (n === 'location') return mode === 'redirect' ? SENTINEL_LOGIN_URL : null; return null; } };
}
function resp(status, body) { return { status, type: 'basic', headers: headers(), text: async () => body }; }

async function fetchImpl(_url, init) {
  if (mode === 'reject') throw Object.assign(new Error('net::ERR_FAILED ' + SENTINEL_LOGIN_URL + ' ' + SENTINEL_COOKIE + ' ' + SENTINEL_TOKEN), { code: 'ERR_FAILED' });
  if (mode === 'redirect') return resp(302, '');
  if (mode === 'invalid') return resp(200, invalidSession());
  if (mode === 'sync') return resp(200, outOfSync());
  if (mode === 'apexError') return resp(200, apexError('System.QueryException', 'no rows ' + SENTINEL_TOKEN + ' ' + SENTINEL_COMMENT + ' ' + SENTINEL_EMAIL));
  const body = new URLSearchParams(String(init.body));
  const action = JSON.parse(body.get('message')).actions[0];
  if (/ACTION\$getItems$/.test(action.descriptor)) return resp(200, success(listResult([CASE_ID, NO_RO_CASE_ID]), { raw: true }));
  const { method, params } = action.params;
  const isMain = params.caseId === CASE_ID;
  if (method === 'getCaseRecord') {
    const rec = Object.assign({}, isMain ? CASE_RECORD : NO_RO_RECORD, { CreatedBy: { Email: SENTINEL_EMAIL }, Portal_User_Email__c: SENTINEL_EMAIL });
    return resp(200, success(rec));
  }
  if (method === 'getRepairOrderId') return resp(200, success(isMain ? RO_LIST : []));
  if (method === 'getCommentsByCaseRepairOrder') return resp(200, success(isMain ? SENT_COMMENTS : NO_RO_COMMENTS));
  return resp(200, success(null));
}

// Every DTNA window (sign-in or hidden refresh) sees the page's own aura POST carrying the auth values.
function onLoad(win) {
  emitAuraSuccess(win.webContents, {
    url: AURA_URL + '?r=3&ui-force-components-controllers-lists-selectableListDataProvider.SelectableListDataProvider.getItems=1',
    postData: auraPostData({
      context: SENTINEL_CONTEXT, token: SENTINEL_TOKEN, pageURI: SENTINEL_PAGEURI,
      message: { actions: [getItemsAction(), { id: '2;a', descriptor: APEX, params: { classname: 'E2E_UTP_CommentController', method: 'getCommentsByCaseRepairOrder', params: { caseId: CASE_ID } } }] },
    }),
    body: { actions: [{ id: '12;a', state: 'SUCCESS', returnValue: { user: SENTINEL_EMAIL, sid: SENTINEL_COOKIE, logout: SENTINEL_LOGIN_URL } }] },
  });
}

function setup() {
  logger = installFakeLogger(require);
  freshDtna(require);
  delete require.cache[require.resolve('../src/ipc/dtna.js')];
  fx = createFakeElectron({ fetch: fetchImpl, onLoad });
  fx.electron.app.getPath = (k) => (k === 'downloads' ? DOWNLOADS : TMP);
  session = require('../src/dtna/session');
  session._setDeps({ electron: fx.electron, autoLogin: { attachAutoLogin() {} } });
  handlers = new Map();
  ctx = { mainWindow: null, lastData: { rows: [] }, sendToWindow: (ch, p) => ctx.sent.push([ch, p]), sent: [], pushData: (p) => ctx.pushed.push(p), pushed: [], pushStatus: null };
  require('../src/ipc/dtna.js').registerDtnaIPC(ctx, {
    handle: (ch, fn) => handlers.set(ch, fn),
    electron: fx.electron,
    deepScan: { rebuildUnitTimeline: async () => ({ ok: true }) },
  });
  store.save('dtnaCaseCache', { version: 1, cases: {} });
  store.save('fleetData', { rows: [{ equipmentId: '122269', workRequestId: 'WR1', vendor: 'HORWITH FREIGHTLINER', offsiteShopEventUrl: caseUrl(CASE_ID) }] });
  mode = 'ok';
}

const call = (ch, p) => handlers.get(ch)({}, p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(5); } }

function assertClean(results) {
  expect(containsSentinel(logger.text())).toBe(null);
  const payloads = results.concat(ctx.sent.map((s) => s[1]));
  for (const r of payloads) {
    expect(containsSentinel(r)).toBe(null);
    expect(r).not.toHaveProperty('error');
    expect(r).not.toHaveProperty('message');
    expect(r).not.toHaveProperty('stack');
  }
  for (const l of logger.lines) {
    for (const a of l.args) {
      expect(a instanceof Error).toBe(false);
      if (a && typeof a === 'object') { expect(a).not.toHaveProperty('message'); expect(a).not.toHaveProperty('stack'); }
    }
  }
  for (const w of fx.windows) expect(w.webContents.listenerNames).not.toContain('console-message');
}

function assertStoresHaveNoAuth() {
  expect(containsSentinel(store.load('dtnaCaseCache', {}), AUTH_SENTINELS)).toBe(null);
  expect(containsSentinel(store.load('fleetData', {}), AUTH_SENTINELS)).toBe(null);
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else expect(containsSentinel(fs.readFileSync(p, 'utf8'), AUTH_SENTINELS)).toBe(null);
    }
  };
  walk(DATA);
  walk(DOWNLOADS);
}

async function signIn() {
  const r = await call('dtna:login');
  expect(r).toEqual({ ok: true, state: 'connected' });
  return r;
}

afterEach(() => {
  try { session._resetForTests(); } catch (_) {}
  logger.restore();
  freshDtna(require);
});

describe('DTNA redaction', () => {
  it('sign-in capture, status, pull-unit, bulk-pull + progress and export: no secret anywhere; comment text only in cache + row', async () => {
    setup();
    const results = [];
    results.push(await call('dtna:status'));
    results.push(await signIn());
    results.push(await call('dtna:status'));
    expect(results[2].state).toBe('connected');

    const p = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(p).toMatchObject({ ok: true, caseId: CASE_ID, joinedWr: 'WR1' });
    results.push(p);

    const b = await call('dtna:bulk-pull', { includeComments: true });
    expect(b.ok).toBe(true);
    results.push(b);
    await until(() => ctx.sent.some((s) => s[0] === 'dtna:progress' && s[1].finished));
    const fin = ctx.sent.filter((s) => s[0] === 'dtna:progress').pop()[1];
    expect(fin).toMatchObject({ jobId: b.jobId, total: 2, failed: 0, finished: true, cancelled: false });
    results.push(await call('dtna:list-cases', {}));
    for (const format of ['tsv', 'xls']) for (const m of ['cases', 'comments']) results.push(await call('dtna:export', { jobId: b.jobId, format, mode: m }));
    expect(results.slice(-4).every((r) => r.ok && Object.keys(r).join() === 'ok,filename')).toBe(true);
    expect(ctx.sent.some((s) => s[0] === 'dtna:status-changed')).toBe(true);
    expect(ctx.pushed).toHaveLength(1);
    expect(containsSentinel(ctx.pushed, AUTH_SENTINELS)).toBe(null);

    expect(logger.lines.some((l) => l.args[0] === '[dtna] apex')).toBe(true);   // the logger did see the calls
    assertClean(results);
    assertStoresHaveNoAuth();
    // Decision 6: comment text IS the business data in dtnaCaseCache and the row.
    expect(JSON.stringify(store.load('dtnaCaseCache', {}))).toContain(SENTINEL_COMMENT);
    const row = store.load('fleetData', {}).rows.find((r) => r.equipmentId === '122269');
    expect(row.asistNotes).toContain(SENTINEL_COMMENT);
    expect(row.asistNotes).toContain(SENTINEL_FROM);
    expect(JSON.stringify(store.load('dtnaCaseCache', {}))).not.toContain('Portal_User_Email__c');
  });

  it('Apex ERROR with sentinels in its message -> code only', async () => {
    setup();
    await signIn();
    mode = 'apexError';
    const r = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(r).toEqual({ ok: false, code: 'DTNA_APEX_ERROR' });
    assertClean([r]);
    assertStoresHaveNoAuth();
  });

  for (const m of ['invalid', 'sync', 'redirect']) {
    it(`${m}: one forced hidden refresh, then DTNA_SIGNIN_REQUIRED, clean`, async () => {
      setup();
      await signIn();
      mode = m;
      const before = fx.windows.length;
      const r = await call('dtna:pull-unit', { equipmentId: '122269' });
      expect(r).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
      expect(fx.windows.length).toBe(before + 1);
      expect(fx.windows[fx.windows.length - 1].isDestroyed()).toBe(true);
      const s = await call('dtna:status');
      assertClean([r, s]);
      assertStoresHaveNoAuth();
    });
  }

  it('fetch rejecting with a sentinel message -> DTNA_NETWORK, clean; bulk stops with the code', async () => {
    setup();
    await signIn();
    mode = 'reject';
    const r = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(r).toEqual({ ok: false, code: 'DTNA_NETWORK' });
    const b = await call('dtna:bulk-pull', {});
    await until(() => ctx.sent.some((s) => s[0] === 'dtna:progress' && s[1].finished));
    const fin = ctx.sent.filter((s) => s[0] === 'dtna:progress').pop()[1];
    expect(fin).toMatchObject({ finished: true, code: 'DTNA_NETWORK' });
    assertClean([r, b]);
    assertStoresHaveNoAuth();
  });
});

describe('DTNA static guards', () => {
  const SRC = path.join(WT_ROOT, 'src');
  const files = (d) => {
    const out = [];
    const walk = (x) => { for (const f of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) out.push(p); } };
    walk(d);
    return out;
  };
  const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/');

  it('no JSON.parse( under src/dtna/** outside safe-json.js', () => {
    const offenders = files(path.join(SRC, 'dtna')).filter((p) => !p.endsWith('safe-json.js') && fs.readFileSync(p, 'utf8').includes('JSON.parse('));
    expect(offenders).toEqual([]);
    expect(fs.readFileSync(path.join(SRC, 'dtna', 'safe-json.js'), 'utf8')).toContain('JSON.parse(');
  });

  it("no 'console-message' under src/dtna/** or src/dev/dev-dtna-probe.js", () => {
    const list = files(path.join(SRC, 'dtna'));
    const probe = path.join(SRC, 'dev', 'dev-dtna-probe.js');
    if (fs.existsSync(probe)) list.push(probe);
    expect(list.filter((p) => fs.readFileSync(p, 'utf8').includes('console-message'))).toEqual([]);
  });

  it('src/ipc/dtna.js does not contain _callApexRaw', () => {
    expect(fs.readFileSync(path.join(SRC, 'ipc', 'dtna.js'), 'utf8')).not.toContain('_callApexRaw');
  });

  it('only src/ipc/dtna.js, src/dev/dev-dtna-probe.js and src/dtna/** require dtna/client|aura|session|capture', () => {
    const RE = /require\(\s*['"][^'"]*dtna\/(client|aura|session|capture)(\.js)?['"]\s*\)/;
    const allowed = (r) => r === 'ipc/dtna.js' || r === 'dev/dev-dtna-probe.js' || r.startsWith('dtna/');
    const offenders = files(SRC).filter((p) => RE.test(fs.readFileSync(p, 'utf8'))).map(rel).filter((r) => !allowed(r));
    expect(offenders).toEqual([]);
    // The facade deep-scan uses reads the cache store only.
    const facade = fs.readFileSync(path.join(SRC, 'scrapers', 'dtna_enrich.js'), 'utf8');
    expect(facade).toContain("require('../dtna/store')");
    expect(facade).not.toMatch(RE);
  });
});
