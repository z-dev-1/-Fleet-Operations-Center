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
  it('the shipped constants leave POST_COMMENT_PARAMS unset -> not configured', () => {
    expect(C.POST_COMMENT_PARAMS).toBeNull();
    expect(writes.isPostConfigured()).toBe(false);
  });

  it('not configured -> DTNA_POST_NOT_CONFIGURED with zero aura calls', async () => {
    const aura = { callWrite: vi.fn() };
    writes._setDeps({ aura });
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
