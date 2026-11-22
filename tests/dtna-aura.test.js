// DTNA Phase A steps 3-4: CDP capture of the portal's own aura POSTs + the Aura transport.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { fakeWebContents, emitAuraSuccess, flush, freshDtna, AURA_URL } from './fixtures/dtna/fake-electron.js';
import { CASE_ID, success, apexError, invalidSession, outOfSync, res, getItemsAction, listResult } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);

let logger;
let capture;
let aura;
beforeAll(() => {
  logger = installFakeLogger(require);
  freshDtna(require);
  capture = require('../src/dtna/capture.js');
  aura = require('../src/dtna/aura.js');
});
afterAll(() => { logger.restore(); freshDtna(require); });

const CTX = 'CTX_SENTINEL_7f3a';
const TOK = 'TOKEN_SENTINEL_91bc';
const PAGE = '/Servicetracker/s/case/Case/Default?tabset=SENTINEL';

async function seed(o = {}) {
  const wc = fakeWebContents();
  const onSuccess = vi.fn();
  const cap = capture.createCapture(wc, { onSuccess });
  cap.attach();
  emitAuraSuccess(wc, Object.assign({ context: CTX, token: TOK, pageURI: PAGE }, o));
  await flush(30);
  return { wc, cap, onSuccess };
}

function fakeSession(onForce) {
  return {
    ensureContext: vi.fn(async (o) => { if (o && o.force && onForce) await onForce(); return { ok: true }; }),
    noteResult: vi.fn(),
    getSession: () => { throw new Error('must not be used when fetch is injected'); },
  };
}

beforeEach(() => {
  capture._resetForTests();
  aura._resetForTests();
  logger.clear();
});

describe('parseEnvelope', () => {
  it('strips while(1); and */ ... /*ERROR*/ wrappers', () => {
    expect(aura.parseEnvelope('while(1);\n{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(aura.parseEnvelope('*/{"event":{"descriptor":"x"}}/*ERROR*/')).toEqual({ ok: true, value: { event: { descriptor: 'x' } } });
    expect(aura.parseEnvelope('<html>nope</html>')).toEqual({ ok: false });
    expect(aura.parseEnvelope('')).toEqual({ ok: false });
    expect(aura.parseEnvelope(null)).toEqual({ ok: false });
  });
});

describe('classify', () => {
  const env = (t) => aura.parseEnvelope(t);
  it('SUCCESS unwraps the Apex returnValue and re-parses JSON strings', () => {
    expect(aura.classify(200, env(success({ a: 1 })))).toMatchObject({ ok: true, value: { a: 1 } });
    expect(aura.classify(200, env(success('[{"Id":"x"}]')))).toMatchObject({ ok: true, value: [{ Id: 'x' }] });
    expect(aura.classify(200, env(success({ result: [1] }, { raw: true })))).toMatchObject({ ok: true, value: { result: [1] } });
  });
  it('ERROR keeps the exception type name only', () => {
    const r = aura.classify(200, env(apexError('System.QueryException', 'SENTINEL message')));
    expect(r).toEqual({ ok: false, code: 'DTNA_APEX_ERROR', status: 200, exceptionType: 'System.QueryException' });
    expect(JSON.stringify(r)).not.toMatch(/SENTINEL|stackTrace/);
  });
  it('session / sync / http codes', () => {
    expect(aura.classify(200, env(invalidSession())).code).toBe('DTNA_SESSION_EXPIRED');
    expect(aura.classify(200, env(outOfSync())).code).toBe('DTNA_OUT_OF_SYNC');
    expect(aura.classify(401, { ok: false }).code).toBe('DTNA_SESSION_EXPIRED');
    expect(aura.classify(302, { ok: false }, 'https://login.ciam.daimlertruck.com/authorize?x=1').code).toBe('DTNA_SESSION_EXPIRED');
    expect(aura.classify(302, { ok: false }, 'https://elsewhere.example/').code).toBe('DTNA_HTTP_ERROR');
    expect(aura.classify(500, { ok: false })).toEqual({ ok: false, code: 'DTNA_HTTP_ERROR', status: 500 });
    expect(aura.classify(200, { ok: false }).code).toBe('DTNA_SHAPE');
  });
});

describe('capture', () => {
  it('commits context/token/pageURI after a SUCCESS response and calls onSuccess', async () => {
    const { onSuccess, wc } = await seed();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(capture.current()).toMatchObject({ context: CTX, token: TOK, pageURI: PAGE });
    expect(capture.ageMs()).toBeLessThan(5000);
    expect(wc.debugger.version).toBe('1.3');
    expect(wc.debugger.commands.some((c) => c.method === 'Network.enable')).toBe(true);
    expect(wc.listenerNames).not.toContain('console-message');
  });

  it('reads post data through Network.getRequestPostData when it is not inline', async () => {
    await seed({ viaCdp: true });
    expect(capture.current()).toMatchObject({ context: CTX, token: TOK });
  });

  it('ERROR / invalidSession responses, other hosts, other paths and GETs commit nothing', async () => {
    await seed({ body: apexError() });
    await seed({ body: invalidSession() });
    await seed({ url: 'https://evil.example/Servicetracker/s/sfsites/aura' });
    await seed({ url: 'https://dtna.my.site.com/Servicetracker/s/other' });
    await seed({ method: 'GET' });
    expect(capture.current()).toBeNull();
    expect(capture.ageMs()).toBe(Infinity);
  });

  it('keeps the getItems action + query and the classes the page called (names only)', async () => {
    const message = {
      actions: [
        getItemsAction(),
        { id: '13;a', descriptor: 'aura://ApexActionController/ACTION$execute', params: { namespace: '', classname: 'E2E_CaseX', method: 'getCaseRecord', params: { caseId: CASE_ID } } },
      ],
    };
    await seed({ message, url: AURA_URL + '?r=5&ui-force-components-controllers-lists-selectableListDataProvider.SelectableListDataProvider.getItems=1' });
    const t = capture.getItemsTemplate();
    expect(t.query).toBe('?r=5&ui-force-components-controllers-lists-selectableListDataProvider.SelectableListDataProvider.getItems=1');
    expect(t.action.params.filterName).toBe('00B6T000007X74uUAC');
    t.action.params.pageSize = 999;
    expect(capture.getItemsTemplate().action.params.pageSize).toBe(25);
    expect(capture.classFor('getCaseRecord')).toBe('E2E_CaseX');
    const d = capture.describe();
    expect(d).toMatchObject({ hasContext: true, hasGetItems: true, observedMethods: ['getCaseRecord'] });
    expect(JSON.stringify(d)).not.toMatch(/SENTINEL|500gx/);
  });

  it('detach removes the listener and detaches but keeps the captured values; clear() drops them', async () => {
    const { cap, wc } = await seed();
    cap.detach();
    expect(wc.debugger.listenerCount('message')).toBe(0);
    expect(wc.debugger.attached).toBe(false);
    expect(capture.current()).toMatchObject({ context: CTX });
    capture.clear();
    expect(capture.current()).toBeNull();
    expect(capture.getItemsTemplate()).toBeNull();
  });
});

describe('callApex', () => {
  it('posts a form-encoded body with the captured values to the Apex execute URL', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success([{ Id: 'x' }])));
    const session = fakeSession();
    aura._setDeps({ fetch, session });
    const r = await aura.callApex('getCommentsByCaseRepairOrder', { caseId: CASE_ID });
    expect(r).toMatchObject({ ok: true, value: [{ Id: 'x' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/^https:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/sfsites\/aura\?r=\d+&aura\.ApexAction\.execute=1$/);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'manual' });
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(init.signal).toBeTruthy();
    const body = new URLSearchParams(init.body);
    expect(body.get('aura.context')).toBe(CTX);
    expect(body.get('aura.token')).toBe(TOK);
    expect(body.get('aura.pageURI')).toBe(PAGE);
    const msg = JSON.parse(body.get('message'));
    expect(msg.actions[0]).toMatchObject({
      descriptor: 'aura://ApexActionController/ACTION$execute', callingDescriptor: 'UNKNOWN',
      params: { namespace: '', classname: 'E2E_UTP_CommentController', method: 'getCommentsByCaseRepairOrder', params: { caseId: CASE_ID }, cacheable: false, isContinuation: false },
    });
    expect(session.ensureContext).toHaveBeenCalledTimes(1);
    expect(session.noteResult).toHaveBeenCalledWith('OK');
  });

  it('uses the class the page was seen calling', async () => {
    await seed({ message: { actions: [{ descriptor: 'aura://ApexActionController/ACTION$execute', params: { classname: 'E2E_RealCaseCtrl', method: 'getCaseRecord', params: { caseId: 'x' } } }] } });
    const fetch = vi.fn(async () => res(200, success({ Id: CASE_ID })));
    aura._setDeps({ fetch, session: fakeSession() });
    await aura.callApex('getCaseRecord', { caseId: CASE_ID });
    const msg = JSON.parse(new URLSearchParams(fetch.mock.calls[0][1].body).get('message'));
    expect(msg.actions[0].params.classname).toBe('E2E_RealCaseCtrl');
  });

  it('refuses non-allowlisted names, bad ids and extra keys with zero fetch calls', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({})));
    const session = fakeSession();
    aura._setDeps({ fetch, session });
    expect((await aura.callApex('postComment', { caseId: CASE_ID })).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura.callApex('toString', {})).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura.callApex('getCaseRecord', { caseId: '001xx0000000001AAA' })).code).toBe('DTNA_INVALID_INPUT');
    expect((await aura.callApex('getCaseRecord', { caseId: CASE_ID, extra: '1' })).code).toBe('DTNA_INVALID_INPUT');
    expect((await aura.callApex('getCaseRecord', null)).code).toBe('DTNA_INVALID_INPUT');
    expect((await aura.callApex('getComment', { commentId: 'x y' })).code).toBe('DTNA_INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
    expect(session.ensureContext).not.toHaveBeenCalled();
  });

  it('_callApexRaw refuses writes, non-E2E classes and non get/list/fetch methods with zero fetch calls', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({})));
    aura._setDeps({ fetch, session: fakeSession() });
    expect((await aura._callApexRaw('E2E_UTP_CommentController', 'postComment', { caseId: CASE_ID })).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura._callApexRaw('E2E_UTP_CommentController', 'setStatus', {})).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura._callApexRaw('E2E_UTP_CommentController', 'describeCase', {})).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura._callApexRaw('SomeOtherCtrl', 'getThing', {})).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura._callApexRaw('E2E_X', 'getThing', { nested: { a: 1 } })).code).toBe('DTNA_INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
    const r = await aura._callApexRaw('E2E_CaseDetailsLWCController', 'getFaultsFromDataStream', { caseId: CASE_ID });
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Phase D: {silent:true} reaches both ensureContext calls; without it the args are unchanged', async () => {
    await seed();
    const responses = [res(200, invalidSession()), res(200, success({ Id: CASE_ID }))];
    const fetch = vi.fn(async () => responses.shift());
    const session = fakeSession(() => seed());
    aura._setDeps({ fetch, session });
    expect((await aura.callApex('getCaseRecord', { caseId: CASE_ID }, { silent: true })).ok).toBe(true);
    expect(session.ensureContext.mock.calls).toEqual([[{ silent: true }], [{ force: true, silent: true }]]);
    session.ensureContext.mockClear();
    responses.push(res(200, invalidSession()), res(200, success({ Id: CASE_ID })));
    expect((await aura.callApex('getCaseRecord', { caseId: CASE_ID })).ok).toBe(true);
    expect(session.ensureContext.mock.calls).toEqual([[], [{ force: true }]]);
    session.ensureContext.mockClear();
    await seed({ message: { actions: [getItemsAction()] }, url: AURA_URL + '?r=3&ui-force-components-controllers-lists-selectableListDataProvider.SelectableListDataProvider.getItems=1' });
    responses.push(res(200, success(listResult([CASE_ID]), { raw: true })));
    await aura.replayGetItems(null, { silent: true });
    expect(session.ensureContext.mock.calls).toEqual([[{ silent: true }]]);
  });

  it('Phase D: getCaseNumberRecord posts the RecordUi getRecordWithFields action for Case.CaseNumber', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({ apiName: 'Case', id: CASE_ID, fields: { CaseNumber: { value: '15667050', displayValue: null } } }, { raw: true })));
    const session = fakeSession();
    aura._setDeps({ fetch, session });
    const r = await aura.getCaseNumberRecord(CASE_ID, { silent: true });
    expect(r).toMatchObject({ ok: true, value: { fields: { CaseNumber: { value: '15667050' } } } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/^https:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/sfsites\/aura\?r=\d+&aura\.RecordUi\.getRecordWithFields=1$/);
    const msg = JSON.parse(new URLSearchParams(init.body).get('message'));
    expect(msg.actions).toHaveLength(1);
    expect(msg.actions[0]).toMatchObject({
      descriptor: 'aura://RecordUiController/ACTION$getRecordWithFields', callingDescriptor: 'UNKNOWN',
      params: { recordId: CASE_ID, fields: ['Case.CaseNumber'], optionalFields: [] },
    });
    expect(session.ensureContext.mock.calls).toEqual([[{ silent: true }]]);
    const line = logger.lines.filter((l) => l.args[0] === '[dtna] apex').pop().args[1];
    expect(Object.keys(line).sort()).toEqual(['caseTag', 'code', 'method', 'ms', 'status']);
    expect(line).toMatchObject({ method: 'getRecordWithFields', caseTag: '4U5AAK', code: 'OK', status: 200 });
    expect(logger.text()).not.toContain('15667050');
  });

  it('Phase D: getCaseNumberRecord refuses a bad case id with zero fetch calls', async () => {
    await seed();
    const fetch = vi.fn();
    const session = fakeSession();
    aura._setDeps({ fetch, session });
    for (const bad of ['001xx0000000001AAA', '', null, 5]) expect((await aura.getCaseNumberRecord(bad)).code).toBe('DTNA_INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
    expect(session.ensureContext).not.toHaveBeenCalled();
  });

  it('expired: clears the capture, forces ensureContext once, retries once', async () => {
    await seed();
    const responses = [res(200, invalidSession()), res(200, success({ Id: CASE_ID }))];
    const fetch = vi.fn(async () => responses.shift());
    const session = fakeSession(() => seed());
    aura._setDeps({ fetch, session });
    const r = await aura.callApex('getCaseRecord', { caseId: CASE_ID });
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(session.ensureContext).toHaveBeenCalledTimes(2);
    expect(session.ensureContext.mock.calls[1][0]).toEqual({ force: true });
  });

  for (const [label, mk] of [
    ['invalidSession', () => res(200, invalidSession())],
    ['clientOutOfSync', () => res(200, outOfSync())],
    ['401', () => res(401, '')],
    ['302 to the login host', () => res(302, '', { location: 'https://login.ciam.daimlertruck.com/x' })],
  ]) {
    it(label + ' twice -> exactly one retry, then DTNA_SIGNIN_REQUIRED', async () => {
      await seed();
      const fetch = vi.fn(async () => mk());
      const session = fakeSession(() => seed());
      aura._setDeps({ fetch, session });
      const r = await aura.callApex('getCaseRecord', { caseId: CASE_ID });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('DTNA_SIGNIN_REQUIRED');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(session.ensureContext.mock.calls.filter((c) => c[0] && c[0].force)).toHaveLength(1);
      expect(session.noteResult).toHaveBeenLastCalledWith('DTNA_SIGNIN_REQUIRED');
    });
  }

  it('forced refresh failing -> DTNA_SIGNIN_REQUIRED after one request', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, invalidSession()));
    const session = { ensureContext: vi.fn(async (o) => (o && o.force ? { ok: false, code: 'DTNA_SIGNIN_REQUIRED' } : { ok: true })), noteResult: vi.fn() };
    aura._setDeps({ fetch, session });
    expect((await aura.callApex('getCaseRecord', { caseId: CASE_ID })).code).toBe('DTNA_SIGNIN_REQUIRED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ensureContext failing -> its code, zero fetch calls', async () => {
    const fetch = vi.fn();
    const session = { ensureContext: vi.fn(async () => ({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' })), noteResult: vi.fn() };
    aura._setDeps({ fetch, session });
    expect((await aura.callApex('getCaseRecord', { caseId: CASE_ID })).code).toBe('DTNA_SIGNIN_REQUIRED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('timeout -> DTNA_TIMEOUT after CALL_TIMEOUT_MS', async () => {
    await seed();
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_u, init) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted SENTINEL'), { name: 'AbortError' })));
      }));
      aura._setDeps({ fetch, session: fakeSession() });
      const p = aura.callApex('getCaseRecord', { caseId: CASE_ID });
      await vi.advanceTimersByTimeAsync(20000);
      expect((await p).code).toBe('DTNA_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('network error -> DTNA_NETWORK; logs carry no message, token or context', async () => {
    await seed();
    const fetch = vi.fn(async () => { throw new Error('net::ERR_FAILED https://dtna.my.site.com/?token=' + TOK); });
    aura._setDeps({ fetch, session: fakeSession() });
    expect((await aura.callApex('getCaseRecord', { caseId: CASE_ID })).code).toBe('DTNA_NETWORK');
    const text = logger.text();
    expect(text).not.toContain(TOK);
    expect(text).not.toContain(CTX);
    expect(text).not.toContain('ERR_FAILED');
    expect(logger.lines.some((l) => l.args.some((a) => a instanceof Error))).toBe(false);
  });

  it('one log line per call: {method, caseTag, code, status, ms}', async () => {
    await seed();
    aura._setDeps({ fetch: vi.fn(async () => res(200, apexError('System.NullPointerException', 'SENTINEL'))), session: fakeSession() });
    await aura.callApex('getRepairOrderId', { caseId: CASE_ID });
    const apexLines = logger.lines.filter((l) => l.args[0] === '[dtna] apex');
    expect(apexLines).toHaveLength(1);
    const o = apexLines[0].args[1];
    expect(Object.keys(o).sort()).toEqual(['caseTag', 'code', 'exceptionType', 'method', 'ms', 'status']);
    expect(o).toMatchObject({ method: 'getRepairOrderId', caseTag: '4U5AAK', code: 'DTNA_APEX_ERROR', status: 200, exceptionType: 'System.NullPointerException' });
    expect(logger.text()).not.toMatch(/SENTINEL/);
  });
});

describe('replayGetItems', () => {
  it('no captured template -> DTNA_NO_LIST_TEMPLATE without a request', async () => {
    await seed();
    const fetch = vi.fn();
    aura._setDeps({ fetch, session: fakeSession() });
    expect((await aura.replayGetItems()).code).toBe('DTNA_NO_LIST_TEMPLATE');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('re-sends a copy of the captured action with the captured query, mutate applied', async () => {
    await seed({ message: { actions: [getItemsAction()] }, url: AURA_URL + '?r=9&list.getItems=1' });
    const fetch = vi.fn(async () => res(200, success(listResult([CASE_ID]), { raw: true })));
    aura._setDeps({ fetch, session: fakeSession() });
    const r = await aura.replayGetItems((p) => { p.pageSize = 100; p.currentPage = 2; });
    expect(r.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(AURA_URL + '?r=9&list.getItems=1');
    const msg = JSON.parse(new URLSearchParams(init.body).get('message'));
    expect(msg.actions[0].descriptor).toMatch(/ACTION\$getItems$/);
    expect(msg.actions[0].params).toMatchObject({ pageSize: 100, currentPage: 2, filterName: '00B6T000007X74uUAC' });
    expect(capture.getItemsTemplate().action.params.pageSize).toBe(25);
  });
});

describe('static', () => {
  it('JSON.parse( appears only in src/dtna/safe-json.js; no console-message under src/dtna', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(path.dirname(require.resolve('../src/dtna/aura.js')));
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (f !== 'safe-json.js') expect(src.includes('JSON.parse('), f).toBe(false);
      expect(src.includes('console-message'), f).toBe(false);
    }
  });
});

describe('callWrite (the only DTNA write path)', () => {
  const PARAMS = { caseId: CASE_ID, commentBody: 'Hello dealer' };
  function gateTokens() {
    const live = new WeakSet();
    return {
      mint: () => { const t = {}; live.add(t); return t; },
      isApprovalToken: (t) => { if (!t || typeof t !== 'object' || !live.has(t)) return false; live.delete(t); return true; },
    };
  }

  it('no / bad / reused token -> DTNA_WRITE_NOT_APPROVED with zero fetches', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({ Id: 'a1Agx0000000099AAA' })));
    const g = gateTokens();
    const session = fakeSession();
    aura._setDeps({ fetch, session, isApprovalToken: g.isApprovalToken });
    expect(await aura.callWrite('postComment', PARAMS)).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    expect(await aura.callWrite('postComment', PARAMS, {})).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    const t = g.mint();
    expect((await aura.callWrite('postComment', PARAMS, t)).ok).toBe(true);
    expect(await aura.callWrite('postComment', PARAMS, t)).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the real write-gate token check refuses a forged token', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({})));
    aura._setDeps({ fetch, session: fakeSession() });
    expect((await aura.callWrite('postComment', PARAMS, {})).code).toBe('DTNA_WRITE_NOT_APPROVED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('unknown name -> DTNA_METHOD_NOT_ALLOWED; bad params -> DTNA_INVALID_INPUT; zero fetches', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({})));
    const g = gateTokens();
    aura._setDeps({ fetch, session: fakeSession(), isApprovalToken: g.isApprovalToken });
    expect((await aura.callWrite('deleteComment', PARAMS, g.mint())).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura.callWrite('getCaseRecord', PARAMS, g.mint())).code).toBe('DTNA_METHOD_NOT_ALLOWED');
    expect((await aura.callWrite('postComment', { caseId: 'nope', t: 'x' }, g.mint())).code).toBe('DTNA_INVALID_INPUT');
    expect((await aura.callWrite('postComment', { caseId: CASE_ID, n: { a: 1 } }, g.mint())).code).toBe('DTNA_INVALID_INPUT');
    expect((await aura.callWrite('postComment', null, g.mint())).code).toBe('DTNA_INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a valid token sends one POST to E2E_UTP_CommentController.postComment; logs carry no text', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success({ Id: 'a1Agx0000000099AAA' })));
    const g = gateTokens();
    aura._setDeps({ fetch, session: fakeSession(), isApprovalToken: g.isApprovalToken });
    const r = await aura.callWrite('postComment', PARAMS, g.mint());
    expect(r).toMatchObject({ ok: true, value: { Id: 'a1Agx0000000099AAA' } });
    const msg = JSON.parse(new URLSearchParams(fetch.mock.calls[0][1].body).get('message'));
    expect(msg.actions[0].params).toMatchObject({ classname: 'E2E_UTP_CommentController', method: 'postComment', params: PARAMS });
    expect(logger.text()).not.toContain('Hello dealer');
    expect(logger.text()).not.toContain(TOK);
  });

  it('changeStatus (Phase C) is refused by callApex and _callApexRaw, and needs a live token in callWrite', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, success(null)));
    const g = gateTokens();
    aura._setDeps({ fetch, session: fakeSession(), isApprovalToken: g.isApprovalToken });
    const SP = { recordId: CASE_ID, status: 'Closed' };
    expect(await aura.callApex('changeStatus', SP)).toEqual({ ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' });
    expect(await aura._callApexRaw('E2E_CaseDetailsLWCController', 'changeStatus', SP)).toEqual({ ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' });
    expect(await aura.callWrite('changeStatus', SP, {})).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    expect(await aura.callWrite('changeStatus', SP)).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    expect(fetch).not.toHaveBeenCalled();
    const t = g.mint();
    expect((await aura.callWrite('changeStatus', SP, t)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(new URLSearchParams(fetch.mock.calls[0][1].body).get('message'));
    expect(msg.actions[0].params).toMatchObject({ classname: 'E2E_CaseDetailsLWCController', method: 'changeStatus', params: SP });
    expect(await aura.callWrite('changeStatus', SP, t)).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.text()).not.toContain(TOK);
  });

  it('changeStatus: an expired session is not retried', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, invalidSession()));
    const g = gateTokens();
    aura._setDeps({ fetch, session: fakeSession(), isApprovalToken: g.isApprovalToken });
    expect(await aura.callWrite('changeStatus', { recordId: CASE_ID, status: 'Closed' }, g.mint())).toMatchObject({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('an expired session is not retried for a write', async () => {
    await seed();
    const fetch = vi.fn(async () => res(200, invalidSession()));
    const g = gateTokens();
    const session = fakeSession();
    aura._setDeps({ fetch, session, isApprovalToken: g.isApprovalToken });
    expect(await aura.callWrite('postComment', PARAMS, g.mint())).toMatchObject({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
