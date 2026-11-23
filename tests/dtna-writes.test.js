// DTNA Phase B: src/dtna/writes.js — postComment param building, the not-configured guard and the
// single caller of aura.callWrite. aura is a fake; nothing reaches the network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { freshDtna, WT_ROOT } from './fixtures/dtna/fake-electron.js';
import { CASE_ID, RO_ID } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);
let logger;
let writes;
let C;
beforeAll(() => {
  logger = installFakeLogger(require);
  freshDtna(require);
  delete require.cache[require.resolve('../src/dtna/writes.js')];
  writes = require('../src/dtna/writes.js');
  C = require('../src/dtna/constants.js');
});
afterAll(() => { logger.restore(); writes._setDeps({}); freshDtna(require); });

const CFG = { classname: 'E2E_UTP_CommentController', params: { caseId: '$caseId', roId: '$repairOrderId', body: '$text', isPublic: true, kind: null } };
const PAYLOAD = { caseId: CASE_ID, repairOrderId: RO_ID, repairOrderNo: 'R101048154', text: 'Please send the ETA' };

beforeEach(() => { writes._setDeps({}); logger.clear(); });

describe('buildPostParams', () => {
  it('maps $ placeholders and literals', () => {
    expect(writes.buildPostParams(CFG, PAYLOAD)).toEqual({ caseId: CASE_ID, roId: RO_ID, body: 'Please send the ETA', isPublic: true, kind: null });
  });
  it('rejects missing / bad configs and payloads', () => {
    expect(writes.buildPostParams(null, PAYLOAD)).toBeNull();
    expect(writes.buildPostParams({ params: { caseId: '$caseId' } }, PAYLOAD)).toBeNull();               // no $text
    expect(writes.buildPostParams({ params: { body: '$text' } }, PAYLOAD)).toBeNull();                   // no case / RO key
    expect(writes.buildPostParams({ params: { caseId: '$caseId', body: '$text', x: '$other' } }, PAYLOAD)).toBeNull();
    expect(writes.buildPostParams({ params: { caseId: '$caseId', body: '$text', x: { a: 1 } } }, PAYLOAD)).toBeNull();
    expect(writes.buildPostParams({ params: { 'bad key': '$caseId', body: '$text' } }, PAYLOAD)).toBeNull();
    expect(writes.buildPostParams(CFG, Object.assign({}, PAYLOAD, { caseId: 'nope' }))).toBeNull();
    expect(writes.buildPostParams(CFG, Object.assign({}, PAYLOAD, { repairOrderId: '' }))).toBeNull();
  });
});

describe('isPostConfigured / postApprovedComment', () => {
  it('the shipped POST_COMMENT_PARAMS match the portal composer (c:e2E_CaseComments handleCommentSubmit)', () => {
    expect(C.POST_COMMENT_PARAMS).toEqual({
      classname: 'E2E_UTP_CommentController', method: 'postComment',
      params: { caseId: '$caseId', userInput: '$text', userName: 'AFP FAS', files: [] },
      successValue: 201,
    });
    expect(writes.isPostConfigured()).toBe(true);
    expect(writes.buildPostParams(C.POST_COMMENT_PARAMS, PAYLOAD)).toEqual({ caseId: CASE_ID, userInput: 'Please send the ETA', userName: 'AFP FAS', files: [] });
  });

  it('shipped config: 201 -> sent once with the composer params; any other returnValue -> DTNA_POST_REJECTED', async () => {
    const token = {};
    const aura = { callWrite: vi.fn(async () => ({ ok: true, value: 201 })) };
    writes._setDeps({ aura });
    expect(await writes.postApprovedComment(PAYLOAD, token)).toEqual({ ok: true, commentId: '' });
    expect(aura.callWrite).toHaveBeenCalledTimes(1);
    expect(aura.callWrite.mock.calls[0]).toEqual(['postComment', { caseId: CASE_ID, userInput: 'Please send the ETA', userName: 'AFP FAS', files: [] }, token]);
    for (const v of [500, 400, null, 'Error', { Id: 'a1Agx0000000099AAA' }]) {
      aura.callWrite.mockResolvedValueOnce({ ok: true, value: v });
      expect(await writes.postApprovedComment(PAYLOAD, token)).toEqual({ ok: false, code: 'DTNA_POST_REJECTED' });
    }
    expect(logger.text()).not.toContain('Please send the ETA');
  });

  it('buildPostParams accepts only an EMPTY array literal', () => {
    expect(writes.buildPostParams({ params: { caseId: '$caseId', body: '$text', files: [] } }, PAYLOAD)).toEqual({ caseId: CASE_ID, body: 'Please send the ETA', files: [] });
    expect(writes.buildPostParams({ params: { caseId: '$caseId', body: '$text', files: ['x'] } }, PAYLOAD)).toBeNull();
  });

  it('not configured -> DTNA_POST_NOT_CONFIGURED with zero aura calls', async () => {
    const aura = { callWrite: vi.fn() };
    writes._setDeps({ aura, config: null });
    expect(await writes.postApprovedComment(PAYLOAD, {})).toEqual({ ok: false, code: 'DTNA_POST_NOT_CONFIGURED' });
    expect(aura.callWrite).not.toHaveBeenCalled();
  });

  it('configured: passes the params and the token through; returns the comment id', async () => {
    const token = {};
    const aura = { callWrite: vi.fn(async () => ({ ok: true, value: { Id: 'a1Agx0000000099AAA' } })) };
    writes._setDeps({ aura, config: CFG });
    expect(writes.isPostConfigured()).toBe(true);
    expect(await writes.postApprovedComment(PAYLOAD, token)).toEqual({ ok: true, commentId: 'a1Agx0000000099AAA' });
    expect(aura.callWrite).toHaveBeenCalledTimes(1);
    expect(aura.callWrite.mock.calls[0]).toEqual(['postComment', { caseId: CASE_ID, roId: RO_ID, body: 'Please send the ETA', isPublic: true, kind: null }, token]);
    expect(logger.text()).not.toContain('Please send the ETA');
    expect(logger.text()).toContain('len');
  });

  it('invalid input / too long / aura failure -> codes only', async () => {
    const aura = { callWrite: vi.fn(async () => ({ ok: false, code: 'DTNA_APEX_ERROR', status: 200 })) };
    writes._setDeps({ aura, config: Object.assign({ maxLen: 10 }, CFG) });
    expect(await writes.postApprovedComment(Object.assign({}, PAYLOAD, { caseId: 'x' }), {})).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(await writes.postApprovedComment(Object.assign({}, PAYLOAD, { text: '   ' }), {})).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(await writes.postApprovedComment(PAYLOAD, {})).toEqual({ ok: false, code: 'DTNA_TEXT_TOO_LONG' });
    expect(aura.callWrite).not.toHaveBeenCalled();
    writes._setDeps({ aura, config: CFG });
    expect(await writes.postApprovedComment(PAYLOAD, {})).toEqual({ ok: false, code: 'DTNA_APEX_ERROR' });
  });
});

describe('stage change (Phase C)', () => {
  // Test-only config (other key names on purpose, to exercise the placeholder resolution).
  const SCFG = {
    classname: 'E2E_CaseDetailsLWCController', method: 'changeStatus',
    params: { recordId: '$caseId', newStatus: '$status' },
    statusValues: { Arrived: 'Arrived', 'In-Repair': 'In Repair', 'Ready for Pickup': 'Ready for Pickup', Closed: 'Closed' },
  };
  const SP = { caseId: CASE_ID, fromStage: 'In-Repair', toStage: 'Closed', repairOrderNo: 'R101048154' };

  it('shipped STAGE_CHANGE_PARAMS (from the portal c:e2E_RecordPath call site): configured, one changeStatus with { caseId, status }', async () => {
    expect(C.STAGE_CHANGE_PARAMS.classname).toBe('E2E_CaseDetailsLWCController');
    expect(C.STAGE_CHANGE_PARAMS.method).toBe('changeStatus');
    expect(Object.keys(C.STAGE_CHANGE_PARAMS.params)).toEqual(['caseId', 'status']);
    expect(C.STAGE_CHANGE_PARAMS.successValue).toBeUndefined();
    expect(Object.keys(C.STAGE_CHANGE_PARAMS.statusValues)).toEqual(C.CASE_STAGES);
    for (const s of C.CASE_STAGES) expect(C.STAGE_CHANGE_PARAMS.statusValues[s]).toBe(s);
    expect(writes.buildStageParams(C.STAGE_CHANGE_PARAMS, SP)).toEqual({ caseId: CASE_ID, status: 'Closed' });
    expect(writes.buildStageParams(C.STAGE_CHANGE_PARAMS, Object.assign({}, SP, { fromStage: 'Arrived', toStage: 'In-Repair' })))
      .toEqual({ caseId: CASE_ID, status: 'In-Repair' });
    const aura = { callWrite: vi.fn(async () => ({ ok: true, status: 200, value: { Status: 'Closed' } })) };
    writes._setDeps({ aura });
    expect(writes.isStageConfigured()).toBe(true);
    expect(writes.stageTargets('In-Repair')).toEqual(['Post-Repair', 'Ready for Pickup', 'Closed']);
    const token = {};
    expect(await writes.postApprovedStageChange(SP, token)).toEqual({ ok: true, toStage: 'Closed' });
    expect(aura.callWrite.mock.calls).toEqual([['changeStatus', { caseId: CASE_ID, status: 'Closed' }, token]]);
  });

  it('STAGE_CHANGE_PARAMS null: not configured, zero aura calls', async () => {
    expect(C.WRITE_METHODS.changeStatus).toEqual({ classname: 'E2E_CaseDetailsLWCController' });
    expect(Object.keys(C.WRITE_METHODS)).toEqual(['postComment', 'changeStatus']);
    const aura = { callWrite: vi.fn() };
    writes._setDeps({ aura, stageConfig: null });
    expect(writes.isStageConfigured()).toBe(false);
    expect(await writes.postApprovedStageChange(SP, {})).toEqual({ ok: false, code: 'DTNA_STAGE_NOT_CONFIGURED' });
    expect(aura.callWrite).not.toHaveBeenCalled();
    // Unconfigured: every later pipeline stage is listed (the UI disables Submit).
    expect(writes.stageTargets('In-Repair')).toEqual(['Post-Repair', 'Ready for Pickup', 'Closed']);
  });

  it('buildStageParams: placeholders, unknown placeholder, unmapped target, wrong classname / method', () => {
    expect(writes.buildStageParams(SCFG, SP)).toEqual({ recordId: CASE_ID, newStatus: 'Closed' });
    expect(writes.buildStageParams(Object.assign({}, SCFG, { params: { recordId: '$caseId', newStatus: '$status', prev: '$fromStatus', force: false } }), SP))
      .toEqual({ recordId: CASE_ID, newStatus: 'Closed', prev: 'In Repair', force: false });
    expect(writes.buildStageParams(Object.assign({}, SCFG, { params: { recordId: '$caseId', newStatus: '$status', x: '$other' } }), SP)).toBeNull();
    expect(writes.buildStageParams(SCFG, Object.assign({}, SP, { toStage: 'Post-Repair' }))).toBeNull();
    expect(writes.buildStageParams(Object.assign({}, SCFG, { classname: 'E2E_UTP_CommentController' }), SP)).toBeNull();
    expect(writes.buildStageParams(Object.assign({}, SCFG, { method: 'postComment' }), SP)).toBeNull();
    expect(writes.buildStageParams(Object.assign({}, SCFG, { params: { newStatus: '$status' } }), SP)).toBeNull();
    expect(writes.buildStageParams(SCFG, Object.assign({}, SP, { caseId: 'nope' }))).toBeNull();
    expect(writes.buildStageParams(null, SP)).toBeNull();
  });

  it('configured: stageTargets lists only mapped later stages; Closed and unknown -> []', () => {
    writes._setDeps({ stageConfig: SCFG });
    expect(writes.isStageConfigured()).toBe(true);
    expect(writes.stageTargets('In-Repair')).toEqual(['Ready for Pickup', 'Closed']);
    expect(writes.stageTargets('Pre-Repair')).toEqual(['Arrived', 'In-Repair', 'Ready for Pickup', 'Closed']);
    expect(writes.stageTargets('Closed')).toEqual([]);
    expect(writes.stageTargets('Bogus')).toEqual([]);
  });

  it('same or earlier stage -> DTNA_STAGE_NOT_FORWARD with zero calls; bad input -> DTNA_INVALID_INPUT', async () => {
    const aura = { callWrite: vi.fn() };
    writes._setDeps({ aura, stageConfig: SCFG });
    for (const toStage of ['In-Repair', 'Arrived', 'Pre-Repair']) {
      expect(await writes.postApprovedStageChange(Object.assign({}, SP, { toStage }), {})).toEqual({ ok: false, code: 'DTNA_STAGE_NOT_FORWARD' });
    }
    expect(await writes.postApprovedStageChange(Object.assign({}, SP, { toStage: 'Bogus' }), {})).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(await writes.postApprovedStageChange(Object.assign({}, SP, { caseId: 'x' }), {})).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(aura.callWrite).not.toHaveBeenCalled();
  });

  it('forward: ONE callWrite(changeStatus) with the params and the token; failure codes pass through', async () => {
    const token = {};
    const aura = { callWrite: vi.fn(async () => ({ ok: true, value: null, status: 200 })) };
    writes._setDeps({ aura, stageConfig: SCFG });
    expect(await writes.postApprovedStageChange(SP, token)).toEqual({ ok: true, toStage: 'Closed' });
    expect(aura.callWrite).toHaveBeenCalledTimes(1);
    expect(aura.callWrite.mock.calls[0]).toEqual(['changeStatus', { recordId: CASE_ID, newStatus: 'Closed' }, token]);
    aura.callWrite.mockResolvedValueOnce({ ok: false, code: 'DTNA_APEX_ERROR', status: 200 });
    expect(await writes.postApprovedStageChange(SP, token)).toEqual({ ok: false, code: 'DTNA_APEX_ERROR' });
    aura.callWrite.mockRejectedValueOnce(new Error('boom'));
    expect(await writes.postApprovedStageChange(SP, token)).toEqual({ ok: false, code: 'DTNA_INTERNAL' });
  });

  it('successValue mismatch -> DTNA_STAGE_REJECTED', async () => {
    const aura = { callWrite: vi.fn(async () => ({ ok: true, value: 'Error' })) };
    writes._setDeps({ aura, stageConfig: Object.assign({ successValue: 'Success' }, SCFG) });
    expect(await writes.postApprovedStageChange(SP, {})).toEqual({ ok: false, code: 'DTNA_STAGE_REJECTED' });
    aura.callWrite.mockResolvedValueOnce({ ok: true, value: 'Success' });
    expect(await writes.postApprovedStageChange(SP, {})).toEqual({ ok: true, toStage: 'Closed' });
  });

  it('logs only method, caseTag, from, to, code, status, ms', async () => {
    const aura = { callWrite: vi.fn(async () => ({ ok: true, value: null, status: 200 })) };
    writes._setDeps({ aura, stageConfig: SCFG });
    await writes.postApprovedStageChange(SP, {});
    const lines = logger.lines.filter((l) => l.args[0] === '[dtna] change-stage');
    expect(lines).toHaveLength(1);
    const o = lines[0].args[1];
    expect(Object.keys(o).sort()).toEqual(['caseTag', 'code', 'from', 'method', 'ms', 'status', 'to']);
    expect(o).toMatchObject({ method: 'changeStatus', caseTag: CASE_ID.slice(-6), from: 'In-Repair', to: 'Closed', code: 'OK', status: 200 });
    expect(logger.text()).not.toContain(CASE_ID);
  });
});

describe('Chatter post (postApprovedChatter)', () => {
  const AURA_CFG = {
    transport: 'aura', descriptor: 'serviceComponent://ui.chatter.components.aura.components.forceChatter.publisher.PublisherController/ACTION$postFeedElement',
    query: '?r=1&x=1', params: { subjectId: '$caseId', body: { messageSegments: [{ type: 'Text', text: '$text' }] }, visibility: 'AllUsers' },
    success: { idPath: 'id' },
  };
  const APEX_CFG = { transport: 'apex', classname: 'E2E_UTP_ChatterController', method: 'postToFeed', params: { caseId: '$caseId', body: '$text', files: [] }, success: { value: 201 } };
  const CP = { caseId: CASE_ID, repairOrderNo: 'R101048154', text: 'Chatter hello SENTINEL_TEXT' };
  const FEED_ID = '0D5gx000000AbCdCAK';

  it('shipped CHATTER_POST_PARAMS is null -> not configured, zero aura calls', async () => {
    expect(C.CHATTER_POST_PARAMS).toBeNull();
    const aura = { callChatterWrite: vi.fn() };
    writes._setDeps({ aura });
    expect(writes.isChatterConfigured()).toBe(false);
    expect(await writes.postApprovedChatter(CP, {})).toEqual({ ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' });
    expect(aura.callChatterWrite).not.toHaveBeenCalled();
  });

  it('buildChatterParams: nested substitution (aura and apex shapes)', () => {
    expect(writes.buildChatterParams(AURA_CFG, CP)).toEqual({ subjectId: CASE_ID, body: { messageSegments: [{ type: 'Text', text: CP.text }] }, visibility: 'AllUsers' });
    expect(writes.buildChatterParams(APEX_CFG, CP)).toEqual({ caseId: CASE_ID, body: CP.text, files: [] });
  });

  it('buildChatterParams: unknown placeholder, missing $text / $caseId, bad key, bad case id -> null', () => {
    expect(writes.buildChatterParams({ params: { subjectId: '$caseId', body: '$text', x: '$other' } }, CP)).toBeNull();
    expect(writes.buildChatterParams({ params: { subjectId: '$caseId' } }, CP)).toBeNull();
    expect(writes.buildChatterParams({ params: { body: '$text' } }, CP)).toBeNull();
    expect(writes.buildChatterParams({ params: { 'bad key': '$caseId', body: '$text' } }, CP)).toBeNull();
    expect(writes.buildChatterParams(AURA_CFG, Object.assign({}, CP, { caseId: 'nope' }))).toBeNull();
    let deep = '$text';
    for (let i = 0; i < 8; i++) deep = { n: deep };
    expect(writes.buildChatterParams({ params: { subjectId: '$caseId', deep } }, CP)).toBeNull();
  });

  it('isChatterConfigured needs a valid transport (REST is not one)', () => {
    writes._setDeps({ chatterConfig: AURA_CFG });
    expect(writes.isChatterConfigured()).toBe(true);
    writes._setDeps({ chatterConfig: APEX_CFG });
    expect(writes.isChatterConfigured()).toBe(true);
    writes._setDeps({ chatterConfig: Object.assign({}, AURA_CFG, { transport: 'rest' }) });
    expect(writes.isChatterConfigured()).toBe(false);
    writes._setDeps({ chatterConfig: Object.assign({}, APEX_CFG, { classname: 'Other' }) });
    expect(writes.isChatterConfigured()).toBe(false);
  });

  it('success.idPath: a FeedItem id -> sent with feedItemId; anything else -> DTNA_CHATTER_REJECTED; the token passes through untouched', async () => {
    const token = {};
    const aura = { callChatterWrite: vi.fn(async () => ({ ok: true, value: { id: FEED_ID } })) };
    writes._setDeps({ aura, chatterConfig: AURA_CFG });
    expect(await writes.postApprovedChatter(CP, token)).toEqual({ ok: true, feedItemId: FEED_ID });
    expect(aura.callChatterWrite).toHaveBeenCalledTimes(1);
    expect(aura.callChatterWrite.mock.calls[0][1]).toBe(token);
    expect(aura.callChatterWrite.mock.calls[0][0]).toEqual(writes.buildChatterParams(AURA_CFG, CP));
    aura.callChatterWrite.mockResolvedValueOnce({ ok: true, value: { id: 'a1Agx0000000099AAA' } });
    expect(await writes.postApprovedChatter(CP, token)).toEqual({ ok: false, code: 'DTNA_CHATTER_REJECTED' });
    expect(logger.text()).not.toContain('SENTINEL_TEXT');
    expect(logger.text()).toContain('[dtna] post-chatter');
  });

  it('success.value: match -> sent; mismatch -> DTNA_CHATTER_REJECTED; transport codes pass through', async () => {
    const aura = { callChatterWrite: vi.fn(async () => ({ ok: true, value: 201 })) };
    writes._setDeps({ aura, chatterConfig: APEX_CFG });
    expect(await writes.postApprovedChatter(CP, {})).toEqual({ ok: true, feedItemId: '' });
    aura.callChatterWrite.mockResolvedValueOnce({ ok: true, value: 500 });
    expect(await writes.postApprovedChatter(CP, {})).toEqual({ ok: false, code: 'DTNA_CHATTER_REJECTED' });
    aura.callChatterWrite.mockResolvedValueOnce({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    expect(await writes.postApprovedChatter(CP, {})).toEqual({ ok: false, code: 'DTNA_WRITE_NOT_APPROVED' });
    aura.callChatterWrite.mockRejectedValueOnce(new Error('boom'));
    expect(await writes.postApprovedChatter(CP, {})).toEqual({ ok: false, code: 'DTNA_INTERNAL' });
  });

  it('too long / empty / bad case id are refused before any call', async () => {
    const aura = { callChatterWrite: vi.fn() };
    writes._setDeps({ aura, chatterConfig: AURA_CFG });
    expect(await writes.postApprovedChatter(Object.assign({}, CP, { text: 'x'.repeat(C.CHATTER_POST_MAX + 1) }), {})).toEqual({ ok: false, code: 'DTNA_TEXT_TOO_LONG' });
    expect(await writes.postApprovedChatter(Object.assign({}, CP, { text: '  ' }), {})).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(await writes.postApprovedChatter(Object.assign({}, CP, { caseId: 'x' }), {})).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(aura.callChatterWrite).not.toHaveBeenCalled();
  });
});

describe('static: callChatterWrite has one caller', () => {
  it('under src/, only src/dtna/writes.js calls callChatterWrite( outside src/dtna/aura.js', () => {
    const SRC = path.join(WT_ROOT, 'src');
    const hits = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('callChatterWrite(')) hits.push(path.relative(SRC, p).replace(/\\/g, '/'));
      }
    };
    walk(SRC);
    expect(hits.filter((h) => h !== 'dtna/aura.js')).toEqual(['dtna/writes.js']);
  });
});

describe('static: callWrite has one caller', () => {
  it('under src/, only src/dtna/writes.js calls callWrite( outside src/dtna/aura.js', () => {
    const SRC = path.join(WT_ROOT, 'src');
    const hits = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('callWrite(')) hits.push(path.relative(SRC, p).replace(/\\/g, '/'));
      }
    };
    walk(SRC);
    expect(hits.filter((h) => h !== 'dtna/aura.js')).toEqual(['dtna/writes.js']);
  });
});
