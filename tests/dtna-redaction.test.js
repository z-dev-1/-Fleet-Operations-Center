// DTNA Phase A step 10: no token / context / pageURI / cookie / email / login URL in any log line,
// dtna:* IPC result, sendToWindow payload, dtnaCaseCache or fleetData; comment text only in the cache
// and the row (decision 6); static guards that keep DTNA network code user-initiated only.
process.env.TZ = 'America/New_York';
import { describe, it, expect, afterEach, vi } from 'vitest';
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

// Chatter + Files sentinels: file name, extracted PDF text, a $ amount and the ContentVersion id.
const CF_FILE_NAME = 'SENTINEL_FILE_NAME_fn3q';
const CF_PDF_TEXT = 'SENTINEL_PDF_TEXT_pt7w';
const CF_AMOUNT = '$987,654.32';
const CF_VERSION_ID = '068gx000009ZzYyAAK';
const cf = {
  feedReads: 0, chatterCalls: [], downloads: [], chatterOn: true,
  pdf: require('./helpers/dtna-estimate-pdf.cjs').makeEstimatePdf([
    'Dealer estimate E101048154 for unit 122269 at the dealer repair location',
    CF_PDF_TEXT + ' brake chamber P/N K123-456  $245.10',
    'Labor 2.5 hrs  $312.50',
    'Grand Total  ' + CF_AMOUNT,
  ]),
};

let fetchCount = 0;
let postCalls = [];
let stageCalls = [];
let stageMoved = false;
// SessionTimeServlet body (Phase C): carries an id token + email the app must never keep.
const SERVLET_BODY = 'while(1);{"sp":28800,"sr":27120,"oidcIdToken":"' + SENTINEL_TOKEN + '","email":"' + SENTINEL_EMAIL + '"}';
async function fetchImpl(_url, init) {
  fetchCount++;
  if (mode === 'reject') throw Object.assign(new Error('net::ERR_FAILED ' + SENTINEL_LOGIN_URL + ' ' + SENTINEL_COOKIE + ' ' + SENTINEL_TOKEN), { code: 'ERR_FAILED' });
  if (mode === 'redirect') return resp(302, '');
  if (String(_url).includes('/SessionTimeServlet')) {
    // Phase E: one expired reading (the pre-flight then runs a hidden background sign-in).
    if (mode === 'servletExpiredOnce') { mode = 'ok'; return resp(200, SERVLET_BODY.replace('"sr":27120', '"sr":0')); }
    return resp(200, SERVLET_BODY);
  }
  // Chatter + Files: the authenticated PDF download (bytes carry the sentinel text, name and amount).
  if (String(_url).includes('/version/download/')) {
    cf.downloads.push(_url);
    const buf = cf.pdf;
    return { status: 200, type: 'basic', headers: headers(), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  if (mode === 'invalidOnce') { mode = 'ok'; return resp(200, invalidSession()); }
  if (mode === 'invalid') return resp(200, invalidSession());
  if (mode === 'sync') return resp(200, outOfSync());
  if (mode === 'apexError') return resp(200, apexError('System.QueryException', 'no rows ' + SENTINEL_TOKEN + ' ' + SENTINEL_COMMENT + ' ' + SENTINEL_EMAIL));
  const body = new URLSearchParams(String(init.body));
  const action = JSON.parse(body.get('message')).actions[0];
  if (/ACTION\$getItems$/.test(action.descriptor)) return resp(200, success(listResult([CASE_ID, NO_RO_CASE_ID]), { raw: true }));
  // Phase D: the Case.CaseNumber read (RecordUi), with a sentinel in another field.
  if (/RecordUiController\/ACTION\$getRecordWithFields$/.test(action.descriptor)) {
    return resp(200, success({ apiName: 'Case', id: action.params.recordId, fields: { CaseNumber: { value: '15667050', displayValue: null }, Owner: { value: SENTINEL_EMAIL } } }, { raw: true }));
  }
  // Chatter + Files: the feed config read (sentinels next to isChatterEnabled) and the Chatter post.
  if (/ACTION\$getModel$/.test(action.descriptor)) {
    cf.feedReads++;
    return resp(200, success({ feed: { isChatterEnabled: cf.chatterOn, title: SENTINEL_COMMENT, owner: SENTINEL_EMAIL, token: SENTINEL_TOKEN } }, { raw: true }));
  }
  if (/ACTION\$postFeedElement$/.test(action.descriptor)) {
    cf.chatterCalls.push(action.params);
    return resp(200, success({ id: '0D5gx000000AbCdCAK', body: { text: SENTINEL_COMMENT }, actor: SENTINEL_EMAIL }, { raw: true }));
  }
  const { method, params } = action.params;
  if (method === 'getFilesOnCase') {
    return resp(200, success([{ ContentVersionId: CF_VERSION_ID, Title: CF_FILE_NAME + '.pdf', FileExtension: 'pdf', ContentSize: cf.pdf.length, CreatedDate: '2026-09-25T08:00:00.000Z', Owner: SENTINEL_EMAIL }]));
  }
  const isMain = params.caseId === CASE_ID;
  if (method === 'getCaseRecord') {
    const rec = Object.assign({}, isMain ? CASE_RECORD : NO_RO_RECORD, { CreatedBy: { Email: SENTINEL_EMAIL }, Portal_User_Email__c: SENTINEL_EMAIL },
      isMain && stageMoved ? { Status: 'Closed', steps: [] } : {});
    if (mode === 'noCaseNumber') delete rec.CaseNumber;   // the real record has none (probe D1)
    return resp(200, success(rec));
  }
  if (method === 'changeStatus') {
    stageCalls.push(params);
    stageMoved = true;
    return resp(200, success(null));
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

function setup(fxExtra) {
  logger = installFakeLogger(require);
  freshDtna(require);
  delete require.cache[require.resolve('../src/ipc/dtna.js')];
  fx = createFakeElectron(Object.assign({ fetch: fetchImpl, onLoad }, fxExtra || {}));
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
  stageMoved = false;
  stageCalls = [];
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

  it('(b3) Phase E: an expired pre-flight runs ONE hidden background sign-in, then the approval is still requested; clean', async () => {
    await phaseBSetup();
    const before = fx.windows.length;
    mode = 'servletExpiredOnce';
    const pending = call('dtna:post-comment', { equipmentId: '122269', caseId: CASE_ID, text: TEXT });
    await until(() => approvals.length === 1);
    expect(postCalls).toHaveLength(0);                       // still nothing sent before approval
    expect(fx.windows.length).toBe(before + 1);
    const bg = fx.windows[fx.windows.length - 1];
    expect(bg.options.show).toBe(false);
    expect(bg.isDestroyed()).toBe(true);
    gate.respond(approvals[0].id, true);
    const r = await pending;
    expect(r).toMatchObject({ ok: true, outcome: 'sent' });
    expect(postCalls).toHaveLength(1);
    expect(logger.lines.some((l) => l.args[0] === '[dtna] auth' && l.args[1].op === 'background-login' && l.args[1].reason === 'preflight' && l.args[1].code === 'OK')).toBe(true);
    expect(logger.text()).not.toContain('oidcIdToken');
    assertClean([r]);
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

// ── Phase C: the approval-gated stage change and the session-time read ──
describe('DTNA redaction: change-stage and session-time', () => {
  const gate = require('../src/writes/write-gate');
  const SCFG = {
    classname: 'E2E_CaseDetailsLWCController', method: 'changeStatus',
    params: { recordId: '$caseId', newStatus: '$status' },
    statusValues: { 'Post-Repair': 'Post Repair', 'Ready for Pickup': 'Ready for Pickup', Closed: 'Closed' },
  };
  const STAGE_LOG_KEYS = ['method', 'caseTag', 'from', 'to', 'code', 'status', 'ms'];
  let approvals;

  async function stageSetup({ configured = true } = {}) {
    setup();
    approvals = [];
    gate._setDepsForTest({
      flags: { requireApproval: false },   // dealer-visible: must still be gated
      notify: () => {},
      log: (m) => logger.lines.push({ ns: 'write-gate', level: 'info', args: [m] }),
    });
    gate.setWindowGetter(() => ({ isDestroyed: () => false, webContents: { send: (ch, d) => { if (ch === 'relayWrites:approval-request') approvals.push(d); } } }));
    require('../src/dtna/writes')._setDeps(configured ? { stageConfig: SCFG } : { stageConfig: null });
    await signIn();
    const p = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(p.ok).toBe(true);
    logger.clear();
    fetchCount = 0;
  }

  afterEach(() => { gate._setDepsForTest({}); gate.setWindowGetter(null); });

  it('(c1) change-stage: gated with requireApproval:false; one changeStatus after approval; read back; clean logs and stores', async () => {
    await stageSetup();
    const pending = call('dtna:change-stage', { equipmentId: '122269', caseId: CASE_ID, target: 'Closed' });
    await until(() => approvals.length === 1);
    expect(stageCalls).toHaveLength(0);                      // nothing sent before approval
    expect(approvals[0].kind).toBe('dtnaStage');
    expect(approvals[0].preview).toContain('CHANGE DTNA CASE STAGE: In-Repair -> Closed');
    expect(approvals[0].preview).toContain('VISIBLE TO THE DEALER (DTNA)');
    gate.respond(approvals[0].id, true);
    const r = await pending;
    expect(r).toEqual({ ok: true, outcome: 'sent', id: approvals[0].id, fromStage: 'In-Repair', toStage: 'Closed', currentStage: 'Closed', confirmed: true });
    expect(stageCalls).toEqual([{ recordId: CASE_ID, newStatus: 'Closed' }]);
    const stageLines = logger.lines.filter((l) => l.args[0] === '[dtna] change-stage');
    expect(stageLines.length).toBeGreaterThanOrEqual(2);
    for (const l of stageLines) for (const k of Object.keys(l.args[1] || {})) expect(STAGE_LOG_KEYS).toContain(k);
    expect(stageLines.some((l) => l.args[1].method === 'changeStatus' && l.args[1].from === 'In-Repair' && l.args[1].to === 'Closed')).toBe(true);
    expect(logger.text()).not.toContain(CASE_ID);
    const pend = store.load('relayWritesPending', { items: [] });
    expect(containsSentinel(pend, AUTH_SENTINELS)).toBe(null);
    expect(pend.items.find((i) => i.id === r.id)).toMatchObject({ kind: 'dtnaStage', state: 'sent' });
    assertClean([r]);
    assertStoresHaveNoAuth();
  });

  it('(c2) unconfigured STAGE_CHANGE_PARAMS -> DTNA_STAGE_NOT_CONFIGURED, no prompt, zero fetches', async () => {
    await stageSetup({ configured: false });
    const r = await call('dtna:change-stage', { equipmentId: '122269', caseId: CASE_ID, target: 'Closed' });
    expect(r).toEqual({ ok: false, code: 'DTNA_STAGE_NOT_CONFIGURED' });
    expect(approvals).toHaveLength(0);
    expect(fetchCount).toBe(0);
    assertClean([r]);
  });

  it('(c3) session-time: only integers leave the servlet body; status and pushes stay clean', async () => {
    await stageSetup();
    const r = await call('dtna:session-time');
    expect(r).toEqual({ ok: true, remainingSec: 27120, periodSec: 28800, expired: false });
    expect(fetchCount).toBe(1);
    const s = await call('dtna:status');
    expect(s).toMatchObject({ state: 'connected', expiresInSec: 27120 });
    expect(Object.values(s).every((v) => v === null || ['number', 'string', 'boolean'].includes(typeof v))).toBe(true);
    const t = logger.text();
    expect(t).toContain('[dtna] session-time');
    expect(t).not.toContain('SessionTimeServlet');
    expect(t).not.toContain('oidcIdToken');
    expect(JSON.stringify(ctx.sent)).not.toContain('oidcIdToken');
    assertClean([r, s]);
    assertStoresHaveNoAuth();
  });
});

describe('DTNA redaction: sync pass (Phase D)', () => {
  const st = (value) => ({ type: 'Neutral', description: { value, displayText: value } });
  const collectorDeps = () => ({
    searchAllPages: async () => [{ workRequestId: 'WR1', aaid: 'aaid-1', assetDisplayName: '122269', assetDomicileSite: 'DAB1', vendor: 'FREIGHTLINER',
      status: st('ESTIMATE_PENDING_APPROVAL'), modifiedTimestamp: 1, scheduledDateTime: Date.parse('2026-11-20T12:00:00Z'), vendorWorkOrderIds: [] }],
    getService: async () => ({ workRequest: { comments: [{ text: 'DTNA case ' + caseUrl(CASE_ID), timestamp: '2026-11-20T12:00:00Z' }] } }),
    getAsset: async () => ({ asset: { attributesText: { operator: 'OPX', domicileSite: 'DAB1' } } }),
    getCasePage: async () => { throw new Error('no Decisiv call expected'); },
    getCaseStatusSummary: async () => { throw new Error('no Decisiv call expected'); },
    fasFor: () => '', loadMine: () => ({ mySites: new Set(), myCarriers: new Set() }), rowIsMine: () => false,
    fleetRows: () => store.load('fleetData', {}).rows,
  });
  const PRIMITIVE = (v) => v === null || v === undefined || ['number', 'string', 'boolean'].includes(typeof v);

  it('signed in: auto pull (with the case-number read), discovery, the facade and a collector scan leak nothing', async () => {
    setup();
    await signIn();
    mode = 'noCaseNumber';
    const auto = require('../src/dtna/auto');
    const r1 = await auto.pullIfStale(CASE_ID, { freshMs: 60e3 });
    expect(r1).toMatchObject({ ok: true, live: true, entry: { caseNumber: '15667050' } });
    const r2 = await auto.discover({ units: ['133001'], budget: 5 });
    expect(r2).toEqual({ pulled: 1, code: 'OK' });
    const f = await require('../src/scrapers/dtna_enrich').enrichDtna(caseUrl(CASE_ID));
    expect(f).toMatchObject({ ok: true, dtnaCaseNumber: '15667050' });
    store.save('dtnaCaseCache', { version: 1, cases: {} });
    const src = require('../src/scrapers/pending_est_sources');
    src._resetForTests();
    const scan = await src.scanTeamPending({ force: true }, collectorDeps());
    expect(scan).toMatchObject({ ok: true, dtnaAuto: 'ok' });
    expect(scan.rows.find((r) => r.key === 'wr:WR1')).toMatchObject({ dtnaCaseId: CASE_ID, dtnaCaseNumber: '15667050' });

    const t = logger.text();
    expect(t).toContain('[dtna] auto');
    expect(t).toContain('getRecordWithFields');
    expect(containsSentinel(t)).toBe(null);
    expect(t).not.toContain('15667050');
    expect(t).not.toContain('R101048154');
    for (const l of logger.lines.filter((x) => x.ns === 'dtna')) {
      for (const a of l.args.slice(1)) {
        if (a && typeof a === 'object') expect(Object.values(a).every(PRIMITIVE), JSON.stringify(Object.keys(a))).toBe(true);
      }
    }
    // Comment text is business data in the entry and the facade's thread; no auth value anywhere.
    expect(containsSentinel([r1, f], AUTH_SENTINELS)).toBe(null);
    assertClean([r2, scan, store.load('pendingEstScan', {})]);
    assertStoresHaveNoAuth();
  });

  it('the [dtna] list and sync-discover lines carry counts and fixed strings only (no case id, list-view id or unit)', async () => {
    setup();
    await signIn();
    store.save('dtnaCaseCache', { version: 1, cases: {} });
    const auto = require('../src/dtna/auto');
    const r = await auto.discoverForRows([{ equipmentId: '133001', vendor: 'FREIGHTLINER' }]);
    expect(r).toMatchObject({ code: 'OK', units: 1 });
    const list = logger.lines.filter((l) => l.args[0] === '[dtna] list');
    const sync = logger.lines.filter((l) => l.args[0] === '[dtna] auto' && l.args[1] && l.args[1].op === 'sync-discover');
    expect(list).toHaveLength(1);
    expect(sync).toHaveLength(1);
    expect(list[0].args[1]).toMatchObject({ count: 2, filter: 'default', fallback: false, entity: 'Case', listFilter: 'default' });
    const text = JSON.stringify(list.concat(sync));
    expect(text).not.toMatch(/500[A-Za-z0-9]{12}/);
    expect(text).not.toMatch(/00B[A-Za-z0-9]{12}/);
    expect(text).not.toContain('133001');
    expect(containsSentinel(text)).toBe(null);
  });

  it('signed out (fresh run), the hidden sign-in fails: one hidden window, no DTNA fetch, from every sync-pass entry', async () => {
    setup({ attachThrows: true });
    const before = fetchCount;
    const auto = require('../src/dtna/auto');
    store.save('dtnaCaseCache', { version: 1, cases: {} });
    expect(await auto.pullIfStale(CASE_ID, { freshMs: 60e3 })).toMatchObject({ live: false, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(await auto.discover({ units: ['122269'], budget: 5 })).toMatchObject({ pulled: 0, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(await require('../src/scrapers/dtna_enrich').enrichDtna(caseUrl(CASE_ID))).toMatchObject({ ok: false, error: 'DTNA signed out' });
    const src = require('../src/scrapers/pending_est_sources');
    src._resetForTests();
    const scan = await src.scanTeamPending({ force: true }, collectorDeps());
    expect(scan.dtnaAuto).toBe('signed-out');
    expect(fetchCount).toBe(before);
    expect(fx.windows).toHaveLength(1);                     // one gated attempt for the whole pass
    expect(fx.windows[0].options.show).toBe(false);
    expect(fx.windows[0].isDestroyed()).toBe(true);
    const skips = logger.lines.filter((l) => l.args[0] === '[dtna] auto');
    expect(skips).toEqual([{ ns: 'dtna', level: 'info', args: ['[dtna] auto', { op: 'skip', code: 'DTNA_AUTO_SIGNED_OUT' }] }]);
    assertClean([scan]);
  });
});

describe('DTNA redaction: background sign-in (Phase E)', () => {
  it('(a) startup trigger: the hidden window captures the sentinel context/token in memory only; pushes and logs clean', async () => {
    setup();
    const auth = require('../src/dtna/auto-auth');
    const C = require('../src/dtna/constants');
    // Only the startup timer runs (at once); the expiry timer is left unarmed.
    auth.start(ctx, { electron: fx.electron, setTimeout: (fn, ms) => { if (ms === C.BG_STARTUP_DELAY_MS) Promise.resolve().then(fn); return {}; }, clearTimeout: () => {} });
    await until(() => session.status().state === 'connected' && Number.isFinite(session.status().expiresInSec));
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows[0].options.show).toBe(false);
    expect(fx.windows[0].isDestroyed()).toBe(true);
    expect(require('../src/dtna/capture').current()).toBeTruthy();
    const s = await call('dtna:status');
    expect(s).toMatchObject({ state: 'connected', expiresInSec: 27120 });
    expect(ctx.sent.some((x) => x[0] === 'dtna:status-changed' && x[1].state === 'connected')).toBe(true);
    expect(logger.lines.some((l) => l.args[0] === '[dtna] auto-auth' && l.args[1].reason === 'startup' && l.args[1].code === 'OK')).toBe(true);
    expect(logger.text()).not.toContain('oidcIdToken');
    auth._resetForTests();
    assertClean([s]);
    assertStoresHaveNoAuth();
  });

  it('(b) signed in, one invalid-session Aura response during the sync pass -> one hidden re-login, the read retries live; clean', async () => {
    setup();
    await signIn();
    const before = fx.windows.length;
    mode = 'invalidOnce';
    const auto = require('../src/dtna/auto');
    const r = await auto.pullIfStale(CASE_ID, { freshMs: 60e3 });
    expect(r).toMatchObject({ ok: true, live: true, entry: { caseId: CASE_ID } });
    expect(fx.windows.length).toBe(before + 1);
    expect(fx.windows[fx.windows.length - 1].options.show).toBe(false);
    expect(fx.windows[fx.windows.length - 1].isDestroyed()).toBe(true);
    assertClean([]);
    assertStoresHaveNoAuth();
  });

  it('(c) the hidden auto-login hits a challenge on a sign-in URL with a query: action needed pushed, no URL or query in any log', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setup({ urlFor: () => SENTINEL_LOGIN_URL, onLoad: () => {} });
      session._setDeps({ electron: fx.electron, autoLogin: { attachAutoLogin: (_w, _u, o) => { if (o && o.onDone) o.onDone({ success: false, url: SENTINEL_LOGIN_URL, error: 'bad_credentials' }); } } });
      let r = null;
      session.backgroundLogin({ reason: 'startup' }).then((x) => { r = x; });
      await vi.advanceTimersByTimeAsync(5100);
      expect(r).toEqual({ ok: false, code: 'DTNA_SIGNIN_ACTION_NEEDED' });
      expect(session.status().actionNeeded).toBe(true);
      expect(ctx.sent.filter((x) => x[0] === 'dtna:status-changed' && x[1].actionNeeded === true)).toHaveLength(1);
      expect(fx.windows.every((w) => w.options.show === false)).toBe(true);
      const t = logger.text();
      expect(t).not.toContain(SENTINEL_LOGIN_URL);
      expect(t).not.toContain('client_id');
      assertClean([r, session.status()]);
    } finally { vi.useRealTimers(); }
  });

  it('static: the startup / expiry trigger modules never show a window, schedule a repeat or listen to the console', () => {
    for (const f of [['dtna', 'auto-auth.js'], ['aperia', 'auto-auth.js']]) {
      const src = fs.readFileSync(path.join(WT_ROOT, 'src', ...f), 'utf8');
      for (const bad of ['console-message', 'setInterval', 'openLoginWindow', 'show: true']) expect(src, f.join('/') + ' ' + bad).not.toContain(bad);
    }
    const sess = fs.readFileSync(path.join(WT_ROOT, 'src', 'dtna', 'session.js'), 'utf8');
    expect(sess).not.toContain('console-message');
  });
});

// ── Chatter + Files: the channel probe, the gated Chatter post and the estimate-PDF pull ──
describe('DTNA redaction: Chatter + attachments', () => {
  const gate = require('../src/writes/write-gate');
  const FEED = { descriptor: 'serviceComponent://ui.chatter.components.aura.components.forceChatter.chatter.ForceCommunityFeedController/ACTION$getModel', query: '?r=1&getModel=1', params: { subjectId: '$caseId' }, enabledKey: 'isChatterEnabled' };
  const POST = {
    transport: 'aura', descriptor: 'serviceComponent://ui.chatter.components.aura.components.forceChatter.publisher.PublisherController/ACTION$postFeedElement',
    query: '?r=1&postFeedElement=1', params: { subjectId: '$caseId', body: { text: '$text' } }, success: { idPath: 'id' },
  };
  const LIST = { source: 'apex', classname: 'E2E_UTP_CommentController', method: 'getFilesOnCase', params: { caseId: '$caseId' },
    fields: { versionId: 'ContentVersionId', name: 'Title', ext: 'FileExtension', size: 'ContentSize', createdAt: 'CreatedDate' } };
  const DL = { urlTemplate: 'https://dtna.my.site.com/Servicetracker/sfc/servlet.shepherd/version/download/{versionId}' };
  const TEXT = 'Chatter update ' + SENTINEL_COMMENT;
  // Strings that must never reach a log, an IPC result or a sendToWindow payload.
  const FILE_SENTINELS = [CF_FILE_NAME, CF_PDF_TEXT, CF_AMOUNT, '987654.32', CF_VERSION_ID, 'servlet.shepherd', '%PDF-', 'BaseFont'];
  let approvals;

  async function cfSetup({ configured = true } = {}) {
    setup();
    approvals = [];
    cf.feedReads = 0; cf.chatterCalls = []; cf.downloads = []; cf.chatterOn = true;
    gate._setDepsForTest({
      flags: { requireApproval: false },   // dealer-visible: must still be gated
      notify: () => {},
      log: (m) => logger.lines.push({ ns: 'write-gate', level: 'info', args: [m] }),
    });
    gate.setWindowGetter(() => ({ isDestroyed: () => false, webContents: { send: (ch, d) => { if (ch === 'relayWrites:approval-request') approvals.push(d); } } }));
    if (configured) {
      require('../src/dtna/aura')._setDeps({ chatterFeedRead: FEED, chatterConfig: POST, attachmentListRead: LIST });
      require('../src/dtna/writes')._setDeps({ chatterConfig: POST });
      require('../src/dtna/files')._setDeps({ listConfig: LIST, downloadConfig: DL });
      // Real pdfjs worker; a longer parse timer so a loaded machine (full suite) does not time it out.
      require('../src/dtna/client')._setDeps({ extractorDeps: { spawnWorker: require('./helpers/jmctx-worker.cjs').spawnRealWorker, getChildRss: () => undefined, limits: { PARSE_TIMEOUT_MS: 100000 } } });
    }
    await signIn();
  }

  afterEach(() => { gate._setDepsForTest({}); gate.setWindowGetter(null); });

  function assertNoFileData(results) {
    const t = logger.text();
    for (const s of FILE_SENTINELS) expect(t, s).not.toContain(s);
    for (const r of results.concat(ctx.sent.map((x) => x[1]))) {
      const j = JSON.stringify(r);
      for (const s of FILE_SENTINELS) expect(j, s).not.toContain(s);
    }
  }

  it('pull-unit downloads + extracts the estimate PDF: text only in the cache entry and the row; no name, text, $ or bytes in logs / IPC / status', async () => {
    await cfSetup();
    const r = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(r).toMatchObject({ ok: true, caseId: CASE_ID });
    expect(cf.downloads).toHaveLength(1);
    const entry = store.load('dtnaCaseCache', {}).cases[CASE_ID];
    expect(entry.attachments[0]).toMatchObject({ status: 'read', kind: 'pdf', total: 987654.32, totalLabeled: true });
    expect(entry.attachments[0].text).toContain(CF_PDF_TEXT);
    const row = store.load('fleetData', {}).rows.find((x) => x.equipmentId === '122269');
    expect(row.dtnaEstimateText).toContain(CF_PDF_TEXT);
    expect(row.dtnaEstimateText).toContain(CF_AMOUNT);
    // The pushed partial row is the row itself (allowed); it carries no auth value.
    expect(containsSentinel(ctx.pushed, AUTH_SENTINELS)).toBe(null);
    // The cache stores no bytes and no download URL.
    const cacheText = JSON.stringify(store.load('dtnaCaseCache', {}));
    expect(cacheText).not.toContain('%PDF-');
    expect(cacheText).not.toContain('servlet.shepherd');
    expect(logger.lines.some((l) => l.args[0] === '[dtna] attachments')).toBe(true);
    expect(logger.lines.some((l) => l.args[0] === '[dtna] attachment')).toBe(true);
    const s = await call('dtna:status');
    assertClean([r, s]);
    assertNoFileData([r, s]);
    assertStoresHaveNoAuth();
    // A second pull of the unchanged set re-uses the extraction (no second download).
    await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(cf.downloads).toHaveLength(1);
  }, 120000);

  it('channels + post-chatter: gated with requireApproval:false, one Chatter write after approval; logs and results clean', async () => {
    await cfSetup();
    expect((await call('dtna:pull-unit', { equipmentId: '122269' })).ok).toBe(true);
    logger.clear();
    const ch = await call('dtna:channels', { equipmentId: '122269', caseId: CASE_ID });
    expect(ch).toEqual({ ok: true, auto: 'chatter', chatter: { available: true, reason: '' }, comment: { available: true, reason: '' } });
    const pending = call('dtna:post-chatter', { equipmentId: '122269', caseId: CASE_ID, text: TEXT, aiDrafted: true });
    await until(() => approvals.length === 1);
    expect(cf.chatterCalls).toHaveLength(0);                 // nothing sent before approval
    expect(approvals[0].kind).toBe('dtnaChatter');
    expect(approvals[0].preview).toContain('Channel: Chatter (case feed)');
    expect(approvals[0].preview).toContain('VISIBLE TO THE DEALER (DTNA)');
    expect(approvals[0].preview).toContain(TEXT);
    gate.respond(approvals[0].id, true);
    const r = await pending;
    expect(r).toEqual({ ok: true, outcome: 'sent', id: approvals[0].id, feedItemId: '0D5gx000000AbCdCAK' });
    expect(cf.chatterCalls).toEqual([{ subjectId: CASE_ID, body: { text: TEXT } }]);
    const t = logger.text();
    expect(t).toContain('len=' + TEXT.length);
    expect(t).not.toContain('Chatter update');
    assertClean([ch, r]);
    assertNoFileData([ch, r]);
    assertStoresHaveNoAuth();
    // External communication off: the case comment is the auto choice and post-chatter asks nothing.
    cf.chatterOn = false;
    const ch2 = await call('dtna:channels', { equipmentId: '122269', caseId: CASE_ID });
    expect(ch2).toMatchObject({ auto: 'comment', chatter: { available: false, reason: 'DTNA_CHATTER_DISABLED' } });
    expect(await call('dtna:post-chatter', { equipmentId: '122269', caseId: CASE_ID, text: TEXT })).toEqual({ ok: false, code: 'DTNA_CHATTER_DISABLED' });
    expect(approvals).toHaveLength(1);
    expect(cf.chatterCalls).toHaveLength(1);
    assertClean([ch2]);
  }, 120000);

  it('unconfigured (shipped) Chatter and files: no prompt, zero feed / file fetches; the pull is unchanged', async () => {
    await cfSetup({ configured: false });
    const p = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(p.ok).toBe(true);
    expect(cf.downloads).toHaveLength(0);
    expect(store.load('dtnaCaseCache', {}).cases[CASE_ID].attachments).toEqual([]);
    fetchCount = 0;
    const ch = await call('dtna:channels', { equipmentId: '122269', caseId: CASE_ID });
    expect(ch).toMatchObject({ auto: 'comment', chatter: { available: false, reason: 'DTNA_CHATTER_NOT_CONFIGURED' } });
    const r = await call('dtna:post-chatter', { equipmentId: '122269', caseId: CASE_ID, text: TEXT });
    expect(r).toEqual({ ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' });
    expect(approvals).toHaveLength(0);
    expect(fetchCount).toBe(0);
    expect(cf.feedReads).toBe(0);
    assertClean([p, ch, r]);
  });
});

describe('DTNA static guards', () => {
  it('Chatter + Files: files.js / estimate-pdf.js have no JSON.parse( or console-message; pending.js / estimate-text.js require no network module; only files.js downloads', () => {
    const D = path.join(WT_ROOT, 'src', 'dtna');
    for (const f of ['files.js', 'estimate-pdf.js']) {
      const src = fs.readFileSync(path.join(D, f), 'utf8');
      expect(src, f).not.toContain('JSON.parse(');
      expect(src, f).not.toContain('console-message');
    }
    const NET = /require\(\s*['"]\.\/(aura|client|session|capture|files|writes)(\.js)?['"]\s*\)/;
    for (const f of ['pending.js', 'estimate-text.js']) expect(fs.readFileSync(path.join(D, f), 'utf8'), f).not.toMatch(NET);
    const shepherd = fs.readdirSync(D).filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(D, f), 'utf8').includes('servlet.shepherd'));
    expect(shepherd.filter((f) => f !== 'files.js')).toEqual([]);
    // The only GET of file bytes under src/dtna is files.js downloadPdf; estimate-pdf.js never fetches.
    expect(fs.readFileSync(path.join(D, 'estimate-pdf.js'), 'utf8')).not.toMatch(/\.fetch\(|getSession\(/);
    expect(fs.readFileSync(path.join(D, 'files.js'), 'utf8')).toContain("method: 'GET'");
  });

  it('no src/**/*.js names the OIDC user-info handler (the app never reads the OIDC id token)', () => {
    const SRC = path.join(WT_ROOT, 'src');
    const out = [];
    const walk = (x) => { for (const f of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) out.push(p); } };
    walk(SRC);
    expect(out.filter((p) => /OIDCLogoutHandler|getUserInfo/.test(fs.readFileSync(p, 'utf8')))).toEqual([]);
    const st = fs.readFileSync(path.join(SRC, 'dtna', 'session-time.js'), 'utf8');
    expect(st).not.toContain('JSON.parse(');
    expect(st).not.toContain('console-message');
  });

  it('the Pending Estimates collector and src/dtna/pending.js never require a DTNA network module', () => {
    const RE = /require\(\s*['"][^'"]*dtna\/(client|aura|session|capture)(\.js)?['"]\s*\)/;
    for (const f of [['scrapers', 'pending_est_sources.js'], ['dtna', 'pending.js'], ['dtna', 'comment-draft.js']]) {
      expect(fs.readFileSync(path.join(WT_ROOT, 'src', ...f), 'utf8'), f.join('/')).not.toMatch(RE);
    }
    expect(fs.readFileSync(path.join(WT_ROOT, 'src', 'dtna', 'pending.js'), 'utf8')).not.toMatch(/require\(\s*['"]\.\/(aura|client|session|capture|writes)['"]\s*\)/);
    // Phase D: the collector reaches DTNA only through the session-gated sync-pass module.
    expect(fs.readFileSync(path.join(WT_ROOT, 'src', 'scrapers', 'pending_est_sources.js'), 'utf8')).toContain("require('../dtna/auto')");
  });

  it('Phase D: src/dtna/auto.js never opens a sign-in, auto-logs-in, schedules or requires electron', () => {
    const src = fs.readFileSync(path.join(WT_ROOT, 'src', 'dtna', 'auto.js'), 'utf8');
    for (const bad of ['openLoginWindow', 'attachAutoLogin', 'setInterval', 'setTimeout(', 'setPulling', "require('electron')"]) expect(src, bad).not.toContain(bad);
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
    // Fleet Autopilot V1: autopilot/ports.js requires dtna/session to pick only status() (its pinned picks
    // are enforced by tests/autopilot-no-write.test.js; no sign-in or context function is reachable).
    const allowed = (r) => r === 'ipc/dtna.js' || r === 'dev/dev-dtna-probe.js' || r.startsWith('dtna/') || r === 'autopilot/ports.js';
    const offenders = files(SRC).filter((p) => RE.test(fs.readFileSync(p, 'utf8'))).map(rel).filter((r) => !allowed(r));
    expect(offenders).toEqual([]);
    // The facade deep-scan uses reaches the network only through src/dtna/auto.js (Phase D).
    const facade = fs.readFileSync(path.join(SRC, 'scrapers', 'dtna_enrich.js'), 'utf8');
    expect(facade).toContain("require('../dtna/auto')");
    expect(facade).not.toMatch(RE);
  });
});
