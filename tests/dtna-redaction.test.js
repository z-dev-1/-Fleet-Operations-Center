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

let fetchCount = 0;
let postCalls = [];
async function fetchImpl(_url, init) {
  fetchCount++;
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
  if (method === 'postComment') {
    postCalls.push(params);
    // The real portal (userInput key) returns 201; mode 'reject201' returns a failure status.
    if ('userInput' in params) return resp(200, success(mode === 'reject201' ? 500 : 201));
    return resp(200, success({ Id: 'a1Agx0000000099AAA' }));
  }
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

// ── Phase B: AI draft + the approval-gated, dealer-visible post (findings §4, §10) ──
describe('DTNA redaction: draft-comment and post-comment', () => {
  const gate = require('../src/writes/write-gate');
  const POST_CFG = { classname: 'E2E_UTP_CommentController', params: { caseId: '$caseId', roId: '$repairOrderId', body: '$text' } };
  const TEXT = 'Please share the ETA ' + SENTINEL_COMMENT;
  let approvals; let prompts;

  async function phaseBSetup({ configured = true } = {}) {
    setup();
    approvals = [];
    prompts = [];
    postCalls = [];
    gate._setDepsForTest({
      flags: { requireApproval: false },   // dealer-visible: must still be gated
      notify: () => {},
      log: (m) => logger.lines.push({ ns: 'write-gate', level: 'info', args: [m] }),
    });
    gate.setWindowGetter(() => ({ isDestroyed: () => false, webContents: { send: (ch, d) => { if (ch === 'relayWrites:approval-request') approvals.push(d); } } }));
    require('../src/dtna/writes')._setDeps(configured === 'shipped' ? {} : { config: configured ? POST_CFG : null });
    require('../src/dtna/comment-draft')._setDepsForTest({ ask: async (p) => { prompts.push(p); return 'Could you share an ETA for the repair?'; } });
    await signIn();
    const p = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(p.ok).toBe(true);
    logger.clear();
    fetchCount = 0;
  }

  afterEach(() => { gate._setDepsForTest({}); gate.setWindowGetter(null); });

  it('(a) draft-comment: the AI sees the cached thread, logs carry none of it, result keys are text-only', async () => {
    await phaseBSetup();
    const r = await call('dtna:draft-comment', { equipmentId: '122269', caseId: CASE_ID });
    expect(Object.keys(r).sort()).toEqual(['aiDrafted', 'draft', 'droppedCount', 'noUpdate', 'ok']);
    expect(r).toMatchObject({ ok: true, aiDrafted: true, draft: 'Could you share an ETA for the repair?' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(SENTINEL_COMMENT);           // the DTNA thread went to the AI lane
    expect(containsSentinel(prompts[0], AUTH_SENTINELS)).toBe(null);
    expect(fetchCount).toBe(0);                              // drafting makes no DTNA call
    expect(containsSentinel(logger.text())).toBe(null);
    expect(logger.text()).not.toContain('Could you share');
    expect(r).not.toHaveProperty('error');
    expect(r).not.toHaveProperty('message');
    expect(r).not.toHaveProperty('stack');
  });

  it('(b) post-comment: gated even with requireApproval:false; one aura POST after approval; logs carry len and caseTag only', async () => {
    await phaseBSetup();
    const pending = call('dtna:post-comment', { equipmentId: '122269', caseId: CASE_ID, text: TEXT, aiDrafted: true });
    await until(() => approvals.length === 1);
    expect(postCalls).toHaveLength(0);                       // nothing sent before approval
    expect(approvals[0].kind).toBe('dtnaComment');
    expect(approvals[0].preview).toContain('Visibility: VISIBLE TO THE DEALER (DTNA)');
    expect(approvals[0].preview).toContain(TEXT);            // the user approves the exact text
    gate.respond(approvals[0].id, true);
    const r = await pending;
    expect(r).toEqual({ ok: true, outcome: 'sent', id: approvals[0].id, commentId: 'a1Agx0000000099AAA' });
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual({ caseId: CASE_ID, roId: 'a0Xgx0000012345AAA', body: TEXT });
    const t = logger.text();
    expect(t).toContain('len=' + TEXT.length);
    expect(t).toContain(CASE_ID.slice(-6));
    expect(t).not.toContain(SENTINEL_COMMENT);
    expect(t).not.toContain('Please share the ETA');
    assertClean([r]);
    assertStoresHaveNoAuth();
  });

  it('(b2) shipped POST_COMMENT_PARAMS: approval first, one postComment with the composer keys, 201 -> sent, non-201 -> send-failed', async () => {
    await phaseBSetup({ configured: 'shipped' });
    const pending = call('dtna:post-comment', { equipmentId: '122269', caseId: CASE_ID, text: TEXT });
    await until(() => approvals.length === 1);
    expect(postCalls).toHaveLength(0);
    gate.respond(approvals[0].id, true);
    const r = await pending;
    expect(r).toEqual({ ok: true, outcome: 'sent', id: approvals[0].id });
    expect(postCalls).toEqual([{ caseId: CASE_ID, userInput: TEXT, userName: 'AFP FAS', files: [] }]);
    expect(logger.text()).not.toContain(SENTINEL_COMMENT);
    assertClean([r]);

    mode = 'reject201';
    const p2 = call('dtna:post-comment', { equipmentId: '122269', caseId: CASE_ID, text: TEXT });
    await until(() => approvals.length === 2);
    gate.respond(approvals[1].id, true);
    const r2 = await p2;
    expect(r2).toEqual({ ok: false, outcome: 'send-failed', id: approvals[1].id, code: 'DTNA_POST_REJECTED' });
    expect(postCalls).toHaveLength(2);
    assertClean([r2]);
    assertStoresHaveNoAuth();
  });

  it('(c) unconfigured POST_COMMENT_PARAMS -> DTNA_POST_NOT_CONFIGURED, no approval prompt, zero fetches', async () => {
    await phaseBSetup({ configured: false });
    const r = await call('dtna:post-comment', { equipmentId: '122269', caseId: CASE_ID, text: TEXT });
    expect(r).toEqual({ ok: false, code: 'DTNA_POST_NOT_CONFIGURED' });
    expect(approvals).toHaveLength(0);
    expect(fetchCount).toBe(0);
    assertClean([r]);
  });

  it('(d) an Apex ERROR with sentinels -> send-failed with the DTNA_APEX_ERROR code only', async () => {
    await phaseBSetup();
    mode = 'apexError';
    const pending = call('dtna:post-comment', { equipmentId: '122269', caseId: CASE_ID, text: TEXT });
    await until(() => approvals.length === 1);
    gate.respond(approvals[0].id, true);
    const r = await pending;
    expect(r).toEqual({ ok: false, outcome: 'send-failed', id: approvals[0].id, code: 'DTNA_APEX_ERROR' });
    expect(logger.text()).not.toContain('Please share the ETA');
    assertClean([r]);
    assertStoresHaveNoAuth();
  });
});

describe('DTNA static guards', () => {
  it('the Pending Estimates collector and src/dtna/pending.js never require a DTNA network module', () => {
    const RE = /require\(\s*['"][^'"]*dtna\/(client|aura|session|capture)(\.js)?['"]\s*\)/;
    for (const f of [['scrapers', 'pending_est_sources.js'], ['dtna', 'pending.js'], ['dtna', 'comment-draft.js']]) {
      expect(fs.readFileSync(path.join(WT_ROOT, 'src', ...f), 'utf8'), f.join('/')).not.toMatch(RE);
    }
    expect(fs.readFileSync(path.join(WT_ROOT, 'src', 'dtna', 'pending.js'), 'utf8')).not.toMatch(/require\(\s*['"]\.\/(aura|client|session|capture|writes)['"]\s*\)/);
  });

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
