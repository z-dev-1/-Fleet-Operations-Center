// tests/dev-dtna-probe.test.js — the DEV-ONLY, READ-ONLY DTNA discovery probe (src/dev/dev-dtna-probe.js,
// plan step 14). Built and tested with fakes only; never run against DTNA here. Proves:
//  - inert without FLEET_DEV_DTNA_PROBE=1 (no window, subscription or timer),
//  - armed with it, runs only after a 'connected' status and only once,
//  - _callApexRaw never receives a WRITE_RE method or postComment; needsConfirmation methods are not called,
//  - the P2 composer script is read-only,
//  - the output file lands under <dataDir>/dev with the expected keys and no auth sentinels / raw emails,
//  - a timeout closes the window and still logs done,
//  - app.js gates the require on FLEET_DEV_DTNA_PROBE === '1'.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { createFakeElectron, auraPostData, emitAuraSuccess, WT_ROOT } from './fixtures/dtna/fake-electron.js';
import {
  SENTINEL_TOKEN, SENTINEL_CONTEXT, SENTINEL_PAGEURI, SENTINEL_COOKIE, SENTINEL_EMAIL, AUTH_SENTINELS, containsSentinel,
} from './fixtures/dtna/sentinels.js';

const require = createRequire(import.meta.url);
const probe = require('../src/dev/dev-dtna-probe');
const C = require('../src/dtna/constants');

const CASE1 = '500gx000002E4U5AAK';
const CASE2 = '500gx000003ZOQoAAO';

const BUNDLE = [
  'define("c/e2eComments",["@salesforce/apex/E2E_UTP_CommentController.postComment"],function(p){',
  '  postComment({ caseId: this.recordId, repairOrderId: this.roId, commentText: this.text, commentType: this.type }).then(r=>r);',
  '  var cfg = { maxlength: 2000, types: ["Estimate", "General Comment"] };',
  '});',
  'import getEstimateDetails from "@salesforce/apex/E2E_EstimateController.getEstimateDetails"; getEstimateDetails({ repairOrderId: this.roId });',
  '{"classname":"E2E_EstimateController","method":"updateEstimate","params":{"estimateNo":x}}',
  '{"classname":"E2E_EstimateController","method":"checkApprovalStatus","params":{"caseId":x}}',
  '{"classname":"E2E_CaseDetailsLWCController","method":"getFaultsFromDataStream","params":{"caseId":x}}',
].join('\n');

function recordingLog() {
  const lines = [];
  const push = (m, o) => lines.push(String(m) + (o === undefined ? '' : ' ' + JSON.stringify(o)));
  return { lines, info: push, warn: push, error: push, debug: push };
}

function fakeSession() {
  const listeners = [];
  return {
    listeners,
    subscribed: 0,
    unsubscribed: 0,
    onStatus(fn) { this.subscribed++; listeners.push(fn); return () => { this.unsubscribed++; const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    emit(state) { for (const fn of listeners.slice()) fn({ ok: true, state }); },
  };
}

function fakeCapture() {
  return {
    attached: 0,
    createCapture() { const self = this; return { attach() { self.attached++; }, detach() {} }; },
    current: () => ({ context: SENTINEL_CONTEXT, token: SENTINEL_TOKEN, pageURI: SENTINEL_PAGEURI, capturedAt: Date.now() }),
    classFor: () => null,
  };
}

function fakeClient(o = {}) {
  const calls = [];
  return {
    calls,
    async getCaseRecord(id) {
      calls.push(['getCaseRecord', id]);
      return { ok: true, value: { Id: id, Unit_Number__c: id === CASE1 ? '122269' : '99', Serial__c: 'NP6923', Status: 'Arrived', Owner_Email__c: SENTINEL_EMAIL, Repair_Order__c: null, steps: [{ name: 'Arrived', at: '2026-11-01T10:00:00Z' }] } };
    },
    async getRepairOrderId(id) { calls.push(['getRepairOrderId', id]); return { ok: true, value: id === CASE1 ? { Id: 'a0X000000000001AAA' } : null }; },
    async getComments(id) {
      calls.push(['getComments', id]);
      return { ok: true, value: [
        { CommentType: 'Estimate', CommentText: '<p>Estimate $1,234.00 pending approval, reply to ' + SENTINEL_EMAIL + '</p>', EstimateNo: 'E123', CreatedDate: '2026-11-02T10:00:00Z' },
        { CommentType: 'General', CommentText: 'Dealer has entered the case', CreatedDate: '2026-11-01T10:00:00Z' },
      ] };
    },
    listCaseIds: o.listCaseIds || (async () => { calls.push(['listCaseIds']); return { ok: true, ids: [CASE1, CASE2] }; }),
  };
}

function fakeAura() {
  const calls = [];
  return {
    calls,
    async _callApexRaw(classname, method, params) {
      calls.push({ classname, method, params });
      return { ok: true, value: { Total_Amount__c: 1234.5, Approval_Status__c: 'Pending Approval' } };
    },
    async callApex() { throw new Error('not used'); },
  };
}

function emitScript(wc, requestId, body) {
  const dbg = wc.debugger;
  dbg.bodies.set(requestId, { body, base64Encoded: false });
  dbg.emit('message', {}, 'Network.responseReceived', { requestId, type: 'Script', response: { url: 'https://dtna.my.site.com/Servicetracker/s/sfsites/l/bundle.js', status: 200 } });
  dbg.emit('message', {}, 'Network.loadingFinished', { requestId, encodedDataLength: body.length });
}

function setup(o = {}) {
  const scripts = [];
  let n = 0;
  const fx = createFakeElectron({
    onLoad(win, url) {
      const wc = win.webContents;
      wc.executeJavaScript = async (s) => { scripts.push(s); return { roots: 2, fields: [{ tag: 'textarea', type: '', name: 'comment', label: 'Comment', maxlength: '2000', required: true }], labels: ['Comment Type'], options: ['Estimate', 'General Comment'], buttons: ['Post'] }; };
      if (n++ === 0 && url === C.LIST_URL) {
        emitScript(wc, 's1', BUNDLE);
        emitAuraSuccess(wc, {
          postData: auraPostData({
            context: SENTINEL_CONTEXT, token: SENTINEL_TOKEN, pageURI: SENTINEL_PAGEURI,
            message: { actions: [{ id: '1;a', descriptor: 'aura://ApexActionController/ACTION$execute', params: { namespace: '', classname: 'E2E_CaseDetailsLWCController', method: 'getCaseRecord', params: { caseId: CASE1 } } }] },
          }),
        });
        wc.debugger.emitRequest({ requestId: 'x1', url: C.AURA_URL, method: 'POST', headers: { cookie: 'sid=' + SENTINEL_COOKIE }, postData: auraPostData({ context: SENTINEL_CONTEXT, token: SENTINEL_TOKEN }) });
      }
    },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-probe-'));
  const deps = {
    electron: fx.electron, session: fakeSession(), capture: fakeCapture(), client: fakeClient(o), aura: fakeAura(),
    getDataDir: () => dataDir, settleMs: 0, loadTimeoutMs: 1000, timeoutMs: o.timeoutMs || 60_000,
  };
  return { fx, deps, dataDir, scripts };
}

beforeEach(() => { probe._resetForTests(); });
afterEach(() => { probe._resetForTests(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('inert without FLEET_DEV_DTNA_PROBE=1', () => {
  it('start() returns false and creates no window, subscription or timer', () => {
    const { fx, deps } = setup();
    const setSpy = vi.spyOn(global, 'setTimeout');
    for (const env of [{}, { FLEET_DEV_DTNA_PROBE: '0' }, { FLEET_DEV_DTNA_PROBE: 'true' }]) {
      expect(probe.start({ env, log: recordingLog(), _deps: deps })).toBe(false);
    }
    expect(setSpy).not.toHaveBeenCalled();
    expect(deps.session.subscribed).toBe(0);
    expect(fx.windows.length).toBe(0);
  });
});

describe('armed: one run after the first connected status', () => {
  it('subscribes, logs armed, ignores other states, runs once on connected', async () => {
    const { fx, deps } = setup();
    const log = recordingLog();
    expect(probe.start({ env: { FLEET_DEV_DTNA_PROBE: '1' }, log, _deps: deps })).toBe(true);
    expect(probe.start({ env: { FLEET_DEV_DTNA_PROBE: '1' }, log, _deps: deps })).toBe(true);
    expect(deps.session.subscribed).toBe(1);
    expect(log.lines).toContain('[dtna-probe] armed (runs after DTNA sign-in)');
    deps.session.emit('connecting');
    deps.session.emit('expired');
    expect(fx.windows.length).toBe(0);
    deps.session.emit('connected');
    expect(deps.session.unsubscribed).toBe(1);
    await probe._lastRunForTests();
    deps.session.emit('connected');
    expect(fx.windows.length).toBe(1);
    expect(fx.windows[0].options.title).toBe('DTNA discovery probe (dev, read-only)');
    expect(fx.windows[0].options.webPreferences).toMatchObject({ partition: 'persist:vendor-dtna', sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(fx.windows[0].options.webPreferences.preload).toBeUndefined();
    expect(fx.windows[0].webContents.windowOpenHandler()).toEqual({ action: 'deny' });
    expect(fx.windows[0].webContents.listenerNames).not.toContain('console-message');
    expect(fx.windows[0].loads).toEqual([
      C.LIST_URL, C.caseUrl(CASE1), C.caseUrl(CASE1) + '?tabset-032e7=5194e', C.caseUrl(CASE2), C.caseUrl(CASE2) + '?tabset-032e7=5194e',
    ]);
    expect(fx.windows[0].isDestroyed()).toBe(true);
    expect(log.lines.filter((l) => l.startsWith('[dtna-probe] done')).length).toBe(1);
  });
});

describe('read-only Apex surface', () => {
  it('never sends a WRITE_RE method or postComment to _callApexRaw; needsConfirmation methods are not called', async () => {
    const { deps } = setup();
    const r = await probe.run(Object.assign({ log: recordingLog() }, deps));
    expect(r.ok).toBe(true);
    const called = deps.aura.calls.map((c) => c.classname + '.' + c.method);
    expect(called.length).toBeGreaterThan(0);
    for (const c of deps.aura.calls) {
      expect(c.method).not.toBe('postComment');
      expect(C.WRITE_RE.test(c.method)).toBe(false);
      expect(/^(get|list|fetch)/.test(c.method)).toBe(true);
      expect(/^E2E_/.test(c.classname)).toBe(true);
    }
    expect(called).toContain('E2E_CaseDetailsLWCController.getFaultsFromDataStream');
    expect(called).toContain('E2E_EstimateController.getEstimateDetails');
    expect(called).not.toContain('E2E_EstimateController.checkApprovalStatus');
    expect(called).not.toContain('E2E_EstimateController.updateEstimate');
    expect(deps.aura.calls.length).toBeLessThanOrEqual(15);
    const est = deps.aura.calls.find((c) => c.method === 'getEstimateDetails' && c.params.repairOrderId);
    expect(est.params).toEqual({ repairOrderId: 'a0X000000000001AAA' });
  });

  it('_isSafeRead refuses writes, postComment, non-get names and non-E2E classes', () => {
    expect(probe._isSafeRead('E2E_UTP_CommentController', 'postComment')).toBe(false);
    expect(probe._isSafeRead('E2E_X', 'updateEstimate')).toBe(false);
    expect(probe._isSafeRead('E2E_X', 'checkApprovalStatus')).toBe(false);
    expect(probe._isSafeRead('SomeOther', 'getX')).toBe(false);
    expect(probe._isSafeRead('E2E_X', 'getX')).toBe(true);
    expect(probe._isSafeRead('E2E_X', 'listY')).toBe(true);
  });
});

describe('P2 composer script is read-only', () => {
  it('contains no click/submit/dispatchEvent/focus/value assignment', () => {
    const s = probe.P2_SCRIPT;
    for (const bad of ['click(', 'submit', 'dispatchEvent', 'focus(', '.value =', '.value=', 'innerHTML =', 'fetch(', 'XMLHttpRequest']) expect(s).not.toContain(bad);
  });
});

describe('output file and logs', () => {
  it('writes <dataDir>/dev/dtna-probe-<date>.json with the expected keys, no auth sentinels, masked emails', async () => {
    const { deps, dataDir, scripts } = setup();
    const log = recordingLog();
    const r = await probe.run(Object.assign({ log }, deps));
    const date = new Date().toISOString().slice(0, 10);
    expect(r.file).toBe('dtna-probe-' + date + '.json');
    const file = path.join(dataDir, 'dev', r.file);
    const text = fs.readFileSync(file, 'utf8');
    const out = JSON.parse(text);
    for (const k of ['version', 'at', 'targets', 'd0', 'd1', 'd2', 'd3', 'd4', 'p1', 'p2', 'classes']) expect(out).toHaveProperty(k);
    expect(out.version).toBe(1);
    expect(out.targets).toEqual(['4U5AAK', 'OQoAAO']);
    // D0: bundle + page census
    expect(out.d0.writes).toContain('E2E_UTP_CommentController.postComment');
    expect(out.d0.writes).toContain('E2E_EstimateController.updateEstimate');
    expect(out.d0.reads).toContain('E2E_EstimateController.getEstimateDetails');
    expect(out.d0.pageCalls[0]).toMatchObject({ classname: 'E2E_CaseDetailsLWCController', method: 'getCaseRecord', paramKeys: ['caseId'] });
    // D1
    expect(out.d1[0]).toMatchObject({ code: 'OK', unitPath: 'Unit_Number__c', serialPath: 'Serial__c' });
    expect(out.d1[0].statusValues).toContain('Arrived');
    expect(out.d1[0].nullPaths).toContain('Repair_Order__c');
    // D2
    expect(out.d2.needsConfirmation).toContain('E2E_EstimateController.checkApprovalStatus');
    expect(out.d2.calls.some((c) => c.money && c.money.length)).toBe(true);
    // D3
    expect(out.d3).toMatchObject({ code: 'OK', cases: 2, comments: 4 });
    expect(out.d3.byType.Estimate).toMatchObject({ count: 2, money: 2, estimateWords: 2 });
    expect(out.d3.systemPosts.hasEntered).toBe(2);
    // D4
    expect(out.d4.source).toBe('structured');
    // P1
    expect(out.p1.sites.length).toBeGreaterThan(0);
    expect(out.p1.sites.some((s) => s.paramKeys.includes('commentText') && s.paramKeys.includes('commentType'))).toBe(true);
    // P2
    expect(scripts.length).toBe(2);
    expect(scripts.every((s) => s === probe.P2_SCRIPT)).toBe(true);
    expect(out.p2[0]).toMatchObject({ code: 'OK', options: ['Estimate', 'General Comment'] });
    // classes
    expect(out.classes.getCaseRecord).toEqual({ classname: 'E2E_CaseDetailsLWCController', source: 'page' });
    // secrets
    expect(containsSentinel(text, AUTH_SENTINELS)).toBe(null);
    expect(containsSentinel(log.lines, AUTH_SENTINELS)).toBe(null);
    expect(text).toContain('s***@example.test');
    const done = log.lines.filter((l) => l.startsWith('[dtna-probe] done'));
    expect(done.length).toBe(1);
    expect(done[0]).toMatch(/^\[dtna-probe\] done d0=\d+ d1=2 d2=\d+ d3=2\/4 p1=\d+ p1b=\d+ p2=2 file=dtna-probe-\d{4}-\d{2}-\d{2}\.json$/);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('P1b: postComment call sites from the module factory', () => {
  const MIN = 'x;define("c/utpComments",["exports","lwc","@salesforce/apex/E2E_UTP_CommentController.postComment",'
    + '"@salesforce/apex/E2E_UTP_CommentController.getCommentsByCaseRepairOrder"],(function(e,t,n,o){'
    + 'function i(e){return e&&e.__esModule?e:{default:e}}var a=i(n);class C{handlePost(){'
    + 'const r={caseId:this.recordId,"commentBody":this.text.trim(),type:"General"};a.default(r).then(()=>{});'
    + 'n({recordId:this.recordId,body})}}}));define("c/other",[],function(n){n(1)})';

  it('maps the import to its factory param, follows the interop alias, reads object and variable args', () => {
    const r = probe.analyzeImportCalls(MIN);
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ ident: 'n', aliases: ['a'], pos: 2 });
    const keys = r[0].calls.map((c) => c.keys);
    expect(keys).toContainEqual(['recordId', 'body']);
    expect(keys).toContainEqual(['caseId', 'commentBody', 'type']);
    const v = r[0].calls.find((c) => c.argKind === 'var:r');
    expect(v.entries.find((e) => e.key === 'type').value).toBe('"General"');
    // The next module's `n(1)` is out of scope.
    expect(r[0].calls.length).toBe(2);
  });

  it('ignores the apex module own define (name, not a dependency entry)', () => {
    expect(probe.analyzeImportCalls('define("@salesforce/apex/E2E_UTP_CommentController.postComment",["exports"],function(e){e.default=1})')).toEqual([]);
  });

  it("mode 'post' loads only the RO case, makes no Apex calls and writes dtna-post-probe-<date>.json", async () => {
    const { fx, deps, dataDir } = setup();
    const log = recordingLog();
    const r = await probe.run(Object.assign({ log, mode: 'post' }, deps));
    expect(r.ok).toBe(true);
    expect(r.file).toBe('dtna-post-probe-' + new Date().toISOString().slice(0, 10) + '.json');
    expect(fx.windows[0].loads).toEqual([C.LIST_URL, C.caseUrl(CASE1), C.caseUrl(CASE1) + '?tabset-032e7=5194e']);
    expect(deps.aura.calls).toEqual([]);
    expect(deps.client.calls).toEqual([]);
    const out = JSON.parse(fs.readFileSync(path.join(dataDir, 'dev', r.file), 'utf8'));
    expect(out.mode).toBe('post');
    expect(out.targets).toEqual(['4U5AAK']);
    expect(out.p2.length).toBe(1);
    expect(out.p1b[0].ident).toBe('p');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('timeout', () => {
  it('closes the window, writes the partial file and logs done with a code', async () => {
    const { fx, deps, dataDir } = setup({ timeoutMs: 150, listCaseIds: () => new Promise(() => {}) });
    const log = recordingLog();
    const r = await probe.run(Object.assign({ log }, deps));
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DTNA_PROBE_TIMEOUT');
    expect(fx.windows[0].isDestroyed()).toBe(true);
    expect(log.lines.some((l) => l.startsWith('[dtna-probe] done') && l.endsWith('code=DTNA_PROBE_TIMEOUT'))).toBe(true);
    const out = JSON.parse(fs.readFileSync(path.join(dataDir, 'dev', r.file), 'utf8'));
    expect(out.code).toBe('DTNA_PROBE_TIMEOUT');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('app.js wiring', () => {
  const APP_SRC = fs.readFileSync(path.join(WT_ROOT, 'src/app.js'), 'utf8');
  it("is gated on FLEET_DEV_DTNA_PROBE === '1' and requires the probe only inside the gate", () => {
    expect(APP_SRC).toMatch(/if \(process\.env\.FLEET_DEV_DTNA_PROBE === '1'\)/);
    const gate = APP_SRC.indexOf("if (process.env.FLEET_DEV_DTNA_PROBE === '1')");
    const req = APP_SRC.indexOf("require('./dev/dev-dtna-probe')");
    expect(req).toBeGreaterThan(gate);
    expect(APP_SRC.split("require('./dev/dev-dtna-probe')").length).toBe(2);
    const block = APP_SRC.slice(gate, APP_SRC.indexOf('\n  }', gate));
    expect(block).toContain("require('./dev/dev-dtna-probe').start({ log })");
  });
});
