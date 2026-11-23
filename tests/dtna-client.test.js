// DTNA Phase A step 6: client (normalize, pull, list, resolve, bulk, TSV) + row-apply.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDtna } from './fixtures/dtna/fake-electron.js';
import {
  CASE_ID, NO_RO_CASE_ID, RO_ID, CASE_RECORD, NO_RO_RECORD, RO_LIST, COMMENTS, NO_RO_COMMENTS, getItemsAction, listResult, CASE_NUMBER,
} from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);

let tmp;
let client;
let rowApply;
let dstore;
let store;
let OFFSITE_FIELDS;
let parseDtnaFeedLines;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-client-'));
  require('../src/config/paths').setDataDir(tmp);
  freshDtna(require);
  store = require('../src/store');
  client = require('../src/dtna/client.js');
  rowApply = require('../src/dtna/row-apply.js');
  dstore = require('../src/dtna/store.js');
  OFFSITE_FIELDS = require('../src/utils/offsite-owner.js').OFFSITE_FIELDS;
  parseDtnaFeedLines = require('../src/repair-intel/wo-extract.js').parseDtnaFeedLines;
});
afterAll(() => { freshDtna(require); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const id = (n) => '500gx' + String(n).padStart(13, '0');
const caseUrl = (c) => 'https://dtna.my.site.com/Servicetracker/s/case/' + c + '/detail';

const RECORDS = { [CASE_ID]: CASE_RECORD, [NO_RO_CASE_ID]: NO_RO_RECORD };

function fakeAura(o = {}) {
  const a = {
    calls: [],
    inflight: 0,
    maxInflight: 0,
    txs: [],
    callApex: vi.fn(async (name, p, tx) => {
      a.calls.push([name, p.caseId || p.commentId]);
      a.txs.push(tx);
      a.inflight++;
      a.maxInflight = Math.max(a.maxInflight, a.inflight);
      try {
        if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
        if (o.fail && o.fail(name, p)) return o.fail(name, p);
        if (name === 'getCaseRecord') {
          const rec = RECORDS[p.caseId] || (o.records && o.records[p.caseId]) || { Id: p.caseId, Status: 'Open', Unit_Id__c: 'U' + p.caseId.slice(-4) };
          return { ok: true, value: rec };
        }
        if (name === 'getRepairOrderId') return p.caseId === CASE_ID ? { ok: true, value: RO_LIST } : { ok: true, value: [] };
        if (name === 'getCommentsByCaseRepairOrder') return { ok: true, value: p.caseId === CASE_ID ? COMMENTS : (p.caseId === NO_RO_CASE_ID ? NO_RO_COMMENTS : []) };
        return { ok: true, value: null };
      } finally {
        a.inflight--;
      }
    }),
    // Phase D: Case.CaseNumber read (RecordUi getRecordWithFields). o.caseNumbers[id] | o.numberFail.
    getCaseNumberRecord: vi.fn(async (caseId, tx) => {
      a.numberCalls.push([caseId, tx]);
      if (o.numberFail) return { ok: false, code: o.numberFail };
      const v = o.caseNumbers && o.caseNumbers[caseId] != null ? o.caseNumbers[caseId] : null;
      return { ok: true, value: { apiName: 'Case', id: caseId, fields: { CaseNumber: { value: v, displayValue: null } } } };
    }),
    numberCalls: [],
    replayGetItems: vi.fn(async (mutate, tx) => {
      a.listTx = tx;
      const action = getItemsAction(o.listParams || {});
      if (mutate) mutate(action.params);
      a.lastParams = Object.assign({}, action.params);
      if (o.listFail) return { ok: false, code: o.listFail };
      const ids = o.ids || [CASE_ID, NO_RO_CASE_ID];
      if (!('pageSize' in action.params)) return { ok: true, value: listResult(ids, o.listNumbers) };
      const start = (action.params.currentPage || 0) * action.params.pageSize;
      return { ok: true, value: listResult(ids.slice(start, start + action.params.pageSize), o.listNumbers) };
    }),
  };
  return a;
}

let session;
function useAura(a) {
  session = { notePulled: vi.fn() };
  client._setDeps({ aura: a, session, now: () => NOW, sleep: async () => {} });
  return a;
}

beforeEach(() => {
  client._resetForTests();
  store.save('dtnaCaseCache', { version: 1, cases: {} });
});

describe('normalizeCase', () => {
  it('maps the case record, repair order and comments', () => {
    const e = client.normalizeCase(CASE_RECORD, RO_LIST[0], COMMENTS, { caseId: CASE_ID, now: NOW });
    expect(e).toMatchObject({
      caseId: CASE_ID, caseNumber: '05123456', unitId: '122269', serial: 'NP6923', vinTail: 'NP6923',
      dealerCode: 'HF041', dealerName: 'HORWITH FREIGHTLINER', caseStatus: 'In Repair',
      repairOrderId: RO_ID, repairOrderNo: 'R101048154', estimateNo: 'E-77881',
      commentCount: 3, lastCommentAt: '2026-09-24T12:30:00.000Z', lastCommentType: 'General',
      offsiteStage: 'repair', stageSince: '2026-09-23T14:00:00.000Z', pulledAt: new Date(NOW).toISOString(), source: 'aura',
    });
    expect(e.comments.map((c) => c.from)).toEqual(['AFP FAS', 'HORWITH FREIGHTLINER', 'API User']);
    expect(e.comments[1]).toEqual({ id: 'a1Agx0000000002AAA', type: 'Estimate', at: '2026-09-24T10:56:00.000Z', from: 'HORWITH FREIGHTLINER', text: 'Estimate sent & pending approval Total parts listed' });
    expect(e.steps).toEqual([
      { name: 'Arrived', status: 'Complete', at: '2026-09-22T13:00:00.000Z' },
      { name: 'In Repair', status: 'Current', at: '2026-09-23T14:00:00.000Z' },
    ]);
    expect(parseDtnaFeedLines(e.thread)).toHaveLength(3);
    expect(e.offsiteText).toBe(e.thread);
  });

  it('no-RO case: empty repair order, closed -> ready', () => {
    const e = client.normalizeCase(NO_RO_RECORD, null, NO_RO_COMMENTS, { caseId: NO_RO_CASE_ID, now: NOW });
    expect(e).toMatchObject({ caseId: NO_RO_CASE_ID, unitId: '133001', serial: 'PK1111', repairOrderId: '', repairOrderNo: '', offsiteStage: 'ready', commentCount: 1 });
  });

  it('tolerant key search when the candidate keys are absent', () => {
    const e = client.normalizeCase({ Id: CASE_ID, My_Unit_Num__c: 'A-77', Truck_Serial__c: 'ZZ9999', Chassis_VIN__c: '1FUJ00000000ZZ9999' }, null, [], { now: NOW });
    expect(e).toMatchObject({ caseId: CASE_ID, unitId: 'A-77', serial: 'ZZ9999', vinTail: 'ZZ9999', commentCount: 0, thread: '' });
  });
});

describe('reads', () => {
  it('getRepairOrderId -> first {Id, Name} or null', async () => {
    useAura(fakeAura());
    expect(await client.getRepairOrderId(CASE_ID)).toEqual({ ok: true, value: { Id: RO_ID, Name: 'R101048154' } });
    expect(await client.getRepairOrderId(NO_RO_CASE_ID)).toEqual({ ok: true, value: null });
  });
});

describe('pullCase', () => {
  it('reads case, RO and comments, stores the entry, notes the pull', async () => {
    const a = useAura(fakeAura());
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(a.calls.map((c) => c[0])).toEqual(['getCaseRecord', 'getRepairOrderId', 'getCommentsByCaseRepairOrder']);
    expect(dstore.get(CASE_ID)).toEqual(r.entry);
    expect(r.entry.commentCount).toBe(3);
    expect(session.notePulled).toHaveBeenCalledWith(r.entry.pulledAt);
  });

  it('includeComments:false skips comments and keeps the cached thread', async () => {
    const a = useAura(fakeAura());
    await client.pullCase(CASE_ID);
    a.calls.length = 0;
    const r = await client.pullCase(CASE_ID, { includeComments: false });
    expect(a.calls.map((c) => c[0])).toEqual(['getCaseRecord', 'getRepairOrderId']);
    expect(r.entry.commentCount).toBe(3);
    expect(r.entry.thread).toBeTruthy();
  });

  it('a non-auth RO / comments error is tolerated; a case error or sign-in error fails', async () => {
    useAura(fakeAura({ fail: (n) => (n === 'getRepairOrderId' ? { ok: false, code: 'DTNA_APEX_ERROR' } : null) }));
    expect((await client.pullCase(NO_RO_CASE_ID)).ok).toBe(true);
    useAura(fakeAura({ fail: (n) => (n === 'getCaseRecord' ? { ok: false, code: 'DTNA_APEX_ERROR' } : null) }));
    expect(await client.pullCase(CASE_ID)).toEqual({ ok: false, code: 'DTNA_APEX_ERROR' });
    useAura(fakeAura({ fail: (n) => (n === 'getCommentsByCaseRepairOrder' ? { ok: false, code: 'DTNA_SIGNIN_REQUIRED' } : null) }));
    expect(await client.pullCase(CASE_ID)).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
  });

  it('a failed comment read keeps the last-good cached thread (commentsStale)', async () => {
    useAura(fakeAura());
    const first = await client.pullCase(CASE_ID);
    expect(first.entry.commentCount).toBe(3);
    expect(first.commentsStale).toBeUndefined();
    useAura(fakeAura({ fail: (n) => (n === 'getCommentsByCaseRepairOrder' ? { ok: false, code: 'DTNA_APEX_ERROR' } : null) }));
    const r = await client.pullCase(CASE_ID);
    expect(r).toMatchObject({ ok: true, commentsStale: true, commentsCode: 'DTNA_APEX_ERROR' });
    const stored = dstore.get(CASE_ID);
    expect(stored.commentCount).toBe(3);
    expect(stored.thread).toBe(first.entry.thread);
    expect(stored.comments).toEqual(first.entry.comments);
  });

  it('an ok but empty comment read over a cached thread keeps it (DTNA_COMMENTS_EMPTY)', async () => {
    useAura(fakeAura());
    const first = await client.pullCase(CASE_ID);
    useAura(fakeAura({ fail: (n) => (n === 'getCommentsByCaseRepairOrder' ? { ok: true, value: [] } : null) }));
    const r = await client.pullCase(CASE_ID);
    expect(r).toMatchObject({ ok: true, commentsStale: true, commentsCode: 'DTNA_COMMENTS_EMPTY' });
    expect(dstore.get(CASE_ID).commentCount).toBe(3);
    expect(dstore.get(CASE_ID).thread).toBe(first.entry.thread);
  });

  it('no previous entry and a failed comment read -> empty thread, commentsCode set, not stale', async () => {
    useAura(fakeAura({ fail: (n) => (n === 'getCommentsByCaseRepairOrder' ? { ok: false, code: 'DTNA_APEX_ERROR' } : null) }));
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(r.entry.commentCount).toBe(0);
    expect(r.commentsCode).toBe('DTNA_APEX_ERROR');
    expect(r.commentsStale).toBeFalsy();
  });

  it('bulkPull over a case with a failing comment read keeps that case\'s cached thread', async () => {
    useAura(fakeAura({ ids: [CASE_ID] }));
    const first = await client.pullCase(CASE_ID);
    client._resetForTests();
    useAura(fakeAura({ ids: [CASE_ID], fail: (n) => (n === 'getCommentsByCaseRepairOrder' ? { ok: false, code: 'DTNA_APEX_ERROR' } : null) }));
    const r = await client.bulkPull({ includeComments: true });
    expect(r.ok).toBe(true);
    expect(dstore.get(CASE_ID).commentCount).toBe(3);
    expect(dstore.get(CASE_ID).thread).toBe(first.entry.thread);
  });

  it('invalid case id -> DTNA_INVALID_INPUT with zero calls', async () => {
    const a = useAura(fakeAura());
    expect(await client.pullCase('nope')).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(a.callApex).not.toHaveBeenCalled();
  });
});

describe('Chatter + Files: getChatterEnabled', () => {
  it('parses a nested isChatterEnabled; null when absent; read codes pass through', async () => {
    const a = fakeAura();
    a.getFeedModel = vi.fn(async () => ({ ok: true, value: { model: { feed: { config: { isChatterEnabled: false } } } } }));
    useAura(a);
    expect(await client.getChatterEnabled(CASE_ID)).toEqual({ ok: true, value: false });
    a.getFeedModel.mockResolvedValueOnce({ ok: true, value: [{ x: 1 }, { isChatterEnabled: true }] });
    expect(await client.getChatterEnabled(CASE_ID)).toEqual({ ok: true, value: true });
    a.getFeedModel.mockResolvedValueOnce({ ok: true, value: { isChatterEnabled: 'yes' } });
    expect(await client.getChatterEnabled(CASE_ID)).toEqual({ ok: true, value: null });
    a.getFeedModel.mockResolvedValueOnce({ ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' });
    expect(await client.getChatterEnabled(CASE_ID)).toEqual({ ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' });
    a.getFeedModel.mockResolvedValueOnce({ ok: true, value: {} });
    expect(await client.getChatterEnabled(CASE_ID, { silent: true })).toEqual({ ok: true, value: null });
    expect(a.getFeedModel.mock.calls.at(-1)).toEqual([CASE_ID, { silent: true }]);
  });
});

describe('Chatter + Files: attachments inside pullCase', () => {
  const V = (n) => '068gx0000' + String(n).padStart(6, '0') + 'AAK';
  const att = (n, o = {}) => Object.assign({ versionId: V(n), documentId: '', name: 'E10' + n + '.pdf', ext: 'pdf', size: 1000 + n, createdAt: '2026-09-2' + n + 'T10:00:00.000Z' }, o);
  const TEXT = 'Dealer estimate\nBrake chamber P/N K123-456 $245.10\nGrand Total $1,234.56';
  let files;
  let extractor;
  let opened;
  function useFiles(list, o = {}) {
    const a = fakeAura();
    opened = 0;
    extractor = { extract: vi.fn(async () => (o.extract ? o.extract() : { ok: true, status: 'read', text: TEXT, truncated: false })), close: vi.fn() };
    files = {
      listAttachments: vi.fn(async () => (o.listResult || { ok: true, list })),
      downloadPdf: vi.fn(async (x) => (o.download ? o.download(x) : { ok: true, buffer: Buffer.from('%PDF-1.4 SENTINEL_BYTES') })),
      isPdf: require('../src/dtna/files.js').isPdf,
    };
    const estimatePdf = { openExtractor: () => { opened++; return extractor; }, parseEstimateText: require('../src/dtna/estimate-pdf.js').parseEstimateText };
    session = { notePulled: vi.fn() };
    client._setDeps({ aura: a, session, now: () => (o.now || NOW), sleep: async () => {}, files, estimatePdf });
    return a;
  }

  it('unconfigured list (shipped) -> pull identical plus attachments: [], no download, no extractor', async () => {
    useAura(fakeAura());
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(r.entry.attachments).toEqual([]);
    expect(r.entry.attachmentsCode).toBe('DTNA_ATTACHMENTS_NOT_CONFIGURED');
    expect(r.entry.commentCount).toBe(3);
  });

  it('stores attachments[] with text, line items and the labelled total; one extractor, closed after use', async () => {
    useFiles([att(1), att(2), { versionId: V(9), name: 'photo.jpg', ext: 'jpg', size: 5 }]);
    const r = await client.pullCase(CASE_ID);
    expect(files.listAttachments).toHaveBeenCalledTimes(1);
    expect(files.listAttachments.mock.calls[0][0]).toBe(CASE_ID);
    expect(files.downloadPdf).toHaveBeenCalledTimes(2);
    expect(opened).toBe(1);
    expect(extractor.close).toHaveBeenCalledTimes(1);
    const list = dstore.get(CASE_ID).attachments;
    expect(list.map((a) => a.name)).toEqual(['E102.pdf', 'E101.pdf', 'photo.jpg']);
    expect(list[0]).toMatchObject({ kind: 'pdf', status: 'read', textLen: TEXT.length, total: 1234.56, totalLabeled: true });
    expect(list[0].text).toBe(TEXT);
    expect(list[0].lineItems[0]).toEqual({ desc: 'Brake chamber P/N K123-456', amount: 245.1, kind: 'part' });
    expect(list[2]).toMatchObject({ status: 'skipped-type', kind: 'jpg' });
    expect(JSON.stringify(dstore.get(CASE_ID))).not.toContain('SENTINEL_BYTES');
  });

  it('an unchanged attachment set within 7 days -> zero downloads on the next pull', async () => {
    useFiles([att(1)]);
    await client.pullCase(CASE_ID);
    useFiles([att(1)], { now: NOW + 6 * 864e5 });
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).not.toHaveBeenCalled();
    expect(opened).toBe(0);
    expect(dstore.get(CASE_ID).attachments[0].text).toBe(TEXT);
  });

  it('a changed size, a new versionId or a stale (8 days) extraction -> re-download', async () => {
    useFiles([att(1)]);
    await client.pullCase(CASE_ID);
    useFiles([att(1, { size: 9999 })]);
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).toHaveBeenCalledTimes(1);
    useFiles([att(1, { size: 9999 }), att(3)]);
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).toHaveBeenCalledTimes(1);
    expect(files.downloadPdf.mock.calls[0][0].versionId).toBe(V(3));
    useFiles([att(1, { size: 9999 }), att(3)], { now: NOW + 8 * 864e5 });
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).toHaveBeenCalledTimes(2);
  });

  it('a failed download is retried on the next pull', async () => {
    useFiles([att(1)], { download: () => ({ ok: false, code: 'DTNA_HTTP_ERROR' }) });
    await client.pullCase(CASE_ID);
    expect(dstore.get(CASE_ID).attachments[0]).toMatchObject({ status: 'failed', code: 'DTNA_HTTP_ERROR' });
    useFiles([att(1)]);
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).toHaveBeenCalledTimes(1);
    expect(dstore.get(CASE_ID).attachments[0].status).toBe('read');
  });

  it('at most ATTACHMENT_MAX_PER_PULL downloads per pull, newest first; the rest are pending', async () => {
    const C = require('../src/dtna/constants.js');
    useFiles([1, 2, 3, 4, 5, 6].map((n) => att(n)));
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).toHaveBeenCalledTimes(C.ATTACHMENT_MAX_PER_PULL);
    expect(files.downloadPdf.mock.calls.map((c) => c[0].versionId)).toEqual([V(6), V(5), V(4), V(3)]);
    expect(dstore.get(CASE_ID).attachments.filter((a) => a.status === 'pending').length).toBe(2);
  });

  it('only the newest ATTACHMENT_KEEP_TEXT PDFs keep their text', async () => {
    const C = require('../src/dtna/constants.js');
    useFiles([1, 2, 3, 4].map((n) => att(n)));
    await client.pullCase(CASE_ID);
    useFiles([1, 2, 3, 4, 5, 6].map((n) => att(n)));
    await client.pullCase(CASE_ID);
    const list = dstore.get(CASE_ID).attachments;
    expect(list.filter((a) => a.text).length).toBe(C.ATTACHMENT_KEEP_TEXT);
    expect(list[list.length - 1].text).toBe('');
    expect(list[list.length - 1].total).toBe(1234.56);
  });

  it('a declared size over 15MB is skipped-size with no download', async () => {
    useFiles([att(1, { size: 16 * 1024 * 1024 })]);
    await client.pullCase(CASE_ID);
    expect(files.downloadPdf).not.toHaveBeenCalled();
    expect(dstore.get(CASE_ID).attachments[0].status).toBe('skipped-size');
  });

  it('a FATAL download code stops the attachment step but the case pull succeeds', async () => {
    useFiles([att(1), att(2)], { download: () => ({ ok: false, code: 'DTNA_SESSION_EXPIRED' }) });
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(r.entry.commentCount).toBe(3);
    expect(files.downloadPdf).toHaveBeenCalledTimes(1);
    expect(r.entry.attachmentsCode).toBe('DTNA_SESSION_EXPIRED');
  });

  it('includeComments:false keeps the previous attachments (no list read)', async () => {
    useFiles([att(1)]);
    await client.pullCase(CASE_ID);
    useFiles([att(1), att(2)]);
    const r = await client.pullCase(CASE_ID, { includeComments: false });
    expect(files.listAttachments).not.toHaveBeenCalled();
    expect(r.entry.attachments.map((a) => a.versionId)).toEqual([V(1)]);
  });

  it('a throwing extractor never fails the pull; logs carry counts only', async () => {
    useFiles([att(1)], { extract: () => { throw new Error('boom SENTINEL_MSG'); } });
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(dstore.get(CASE_ID).attachments[0].status).toBe('failed');
    expect(extractor.close).toHaveBeenCalledTimes(1);
  });
});

describe('Phase D: case number + silent pulls', () => {
  // The real getCaseRecord value has no CaseNumber (probe D1).
  const { CaseNumber: _drop, ...REAL_RECORD } = CASE_RECORD;
  const realRecord = (n) => (n === 'getCaseRecord' ? { ok: true, value: REAL_RECORD } : null);

  it('first pull of 500gx000002E4U5AAK stores caseNumber 15667050; a second pull makes no number read', async () => {
    const a = useAura(fakeAura({ fail: realRecord, caseNumbers: { [CASE_ID]: CASE_NUMBER } }));
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(r.entry.caseNumber).toBe('15667050');
    expect(dstore.get(CASE_ID).caseNumber).toBe('15667050');
    expect(r.entry.repairOrderNo).toBe('R101048154'); // the RO stays its own field
    expect(a.numberCalls).toEqual([[CASE_ID, undefined]]);
    await client.pullCase(CASE_ID);
    expect(a.numberCalls).toHaveLength(1);
  });

  it('an empty or failed case-number read still saves the entry with caseNumber "" and is not retried this run', async () => {
    const a = useAura(fakeAura({ fail: realRecord }));
    const r = await client.pullCase(CASE_ID);
    expect(r.ok).toBe(true);
    expect(r.entry.caseNumber).toBe('');
    await client.pullCase(CASE_ID);
    expect(a.numberCalls).toHaveLength(1);
    client._resetForTests();
    store.save('dtnaCaseCache', { version: 1, cases: {} });
    useAura(fakeAura({ fail: realRecord, numberFail: 'DTNA_APEX_ERROR' }));
    const r2 = await client.pullCase(CASE_ID);
    expect(r2.ok).toBe(true);
    expect(dstore.get(CASE_ID).caseNumber).toBe('');
  });

  it('a sign-in failure on the case-number read fails the pull (same rule as the RO read)', async () => {
    useAura(fakeAura({ fail: realRecord, numberFail: 'DTNA_SIGNIN_REQUIRED' }));
    expect(await client.pullCase(CASE_ID)).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
  });

  it('only digits are accepted as a case number', async () => {
    useAura(fakeAura({ fail: realRecord, caseNumbers: { [CASE_ID]: '500gx000002E4U5AAK' } }));
    expect((await client.pullCase(CASE_ID)).entry.caseNumber).toBe('');
  });

  it('silent:true is forwarded to every read; a manual pull passes no transport options', async () => {
    const a = useAura(fakeAura({ fail: realRecord, caseNumbers: { [CASE_ID]: CASE_NUMBER } }));
    await client.pullCase(CASE_ID, { silent: true });
    expect(a.txs).toEqual([{ silent: true }, { silent: true }, { silent: true }]);
    expect(a.numberCalls[0][1]).toEqual({ silent: true });
    a.txs.length = 0;
    await client.pullCase(CASE_ID);
    expect(a.txs).toEqual([undefined, undefined, undefined]);
    await client.listCaseIds({ silent: true });
    expect(a.listTx).toEqual({ silent: true });
  });

  it('the list harvest fills caseNumber without a per-case number read', async () => {
    const a = useAura(fakeAura({ fail: realRecord, listNumbers: { [CASE_ID]: CASE_NUMBER } }));
    await client.listCaseIds();
    expect(client.caseNumberFromList(CASE_ID)).toBe('15667050');
    const r = await client.pullCase(CASE_ID);
    expect(r.entry.caseNumber).toBe('15667050');
    expect(a.numberCalls).toHaveLength(0);
  });
});

describe('listCaseIds', () => {
  it('pages with pageSize 100 when the captured params have paging, memoized 30 min', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => id(i));
    const a = useAura(fakeAura({ ids }));
    const r = await client.listCaseIds();
    expect(r.ok).toBe(true);
    expect(r.ids).toHaveLength(205);
    expect(a.replayGetItems).toHaveBeenCalledTimes(3);
    expect(a.lastParams.pageSize).toBe(100);
    await client.listCaseIds();
    expect(a.replayGetItems).toHaveBeenCalledTimes(3);
  });

  it('ListViewDataManager offset paging: offset 0, 50, 100 with the page size 50, stops on a short page', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => id(i));
    const a = useAura(fakeAura({ ids }));
    const offsets = [];
    a.replayGetItems.mockImplementation(async (mutate) => {
      const p = { filterName: '00B6T000007X74uUAC', entityName: 'Case', pageSize: 50, layoutType: 'LIST', sortBy: null, getCount: false, enableRowActions: false, offset: 0 };
      mutate(p);
      offsets.push(p.offset);
      a.lastParams = p;
      return { ok: true, value: { records: ids.slice(p.offset, p.offset + p.pageSize).map((x) => ({ Id: x })) } };
    });
    const r = await client.listCaseIds({ force: true });
    expect(r.ids).toHaveLength(120);
    expect(offsets).toEqual([0, 50, 100]);
    expect(a.lastParams.pageSize).toBe(50);
    expect(a.lastParams.filterName).toBe('00B6T000007X74uUAC');
  });

  it('ListViewDataManager response: ids from recordIdActionsList[].recordId, pages while hasMoreData (173 -> 4 pages)', async () => {
    const ids = Array.from({ length: 173 }, (_, i) => id(i));
    const a = useAura(fakeAura({ ids }));
    const offsets = [];
    a.replayGetItems.mockImplementation(async (mutate) => {
      const p = { filterName: '00B6T000007X74uUAC', entityName: 'Case', pageSize: 50, layoutType: 'LIST', sortBy: null, getCount: false, enableRowActions: false, offset: 0 };
      mutate(p);
      offsets.push(p.offset);
      const slice = ids.slice(p.offset, p.offset + p.pageSize);
      return { ok: true, value: {
        orderedByInfo: [], scope: 'everything', filteredByLabels: [], columnWidthMapping: {}, wrappedColumns: [], fields: [],
        recordIdActionsList: slice.map((recordId) => ({ recordId, actions: [] })),
        totalCount: 173, offset: p.offset, hasMoreData: p.offset + p.pageSize < 173, filterTitle: 'All Open Cases', isErrorListView: false, entityLabelPlural: 'Cases',
      } };
    });
    const r = await client.listCaseIds({ force: true });
    expect(r.ids).toHaveLength(173);
    expect(new Set(r.ids)).toEqual(new Set(ids));
    expect(offsets).toEqual([0, 50, 100, 150]);
  });

  it('hasMoreData true on a short page keeps paging; false on a full page stops', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => id(i));
    const a = useAura(fakeAura({ ids }));
    const offsets = [];
    a.replayGetItems.mockImplementation(async (mutate) => {
      const p = { entityName: 'Case', pageSize: 50, offset: 0 };
      mutate(p);
      offsets.push(p.offset);
      const page = offsets.length === 1 ? ids.slice(0, 30) : ids.slice(30, 60);
      return { ok: true, value: { recordIdActionsList: page.map((recordId) => ({ recordId })), totalCount: 60, hasMoreData: offsets.length === 1 } };
    });
    expect((await client.listCaseIds({ force: true })).ids).toHaveLength(60);
    expect(offsets).toEqual([0, 50]);
  });

  it('_listShape: key paths, array lengths and id counts only (id-like keys masked, no values)', () => {
    const v = { result: [{ record: { Id: '500ABCDEFGHIJKL', CaseNumber: '01234567', Unit__c: 'UNIT-SECRET' } }], byId: { '500ABCDEFGHIJKLMNO': { x: 1 } }, totalCount: 1 };
    const s = client._listShape(v);
    expect(s).toMatchObject({ type: 'object', top: ['result', 'byId', 'totalCount'], ids18: 0, ids15: 1 });
    expect(s.arrays).toEqual([{ path: '.result', len: 1 }]);
    expect(s.idPaths).toEqual(['.result[].record.Id']);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/500ABC|01234567|UNIT-SECRET/);
    expect(client._listShape({ byId: { '500ABCDEFGHIJKLMNO': ['500ABCDEFGHIJKLMNO'] } }).arrays).toEqual([{ path: '.byId.<id>', len: 1 }]);
  });

  it('one verbatim replay when the template has no paging; filterId sets filterName', async () => {
    const a = useAura(fakeAura({ listParams: { pageSize: undefined } }));
    a.replayGetItems.mockImplementation(async (mutate) => {
      const p = { entityNameOrId: 'Case', filterName: 'x' };
      mutate(p);
      a.lastParams = p;
      return { ok: true, value: listResult([CASE_ID, CASE_ID, 'a0X000000000000AAA']) };
    });
    const r = await client.listCaseIds({ filterId: '00B6T000007X74uUAC' });
    expect(r.ids).toEqual([CASE_ID]);
    expect(a.replayGetItems).toHaveBeenCalledTimes(1);
    expect(a.lastParams.filterName).toBe('00B6T000007X74uUAC');
  });

  it('list failure -> its code', async () => {
    useAura(fakeAura({ listFail: 'DTNA_NO_LIST_TEMPLATE' }));
    expect(await client.listCaseIds()).toEqual({ ok: false, code: 'DTNA_NO_LIST_TEMPLATE' });
  });

  it('an empty list is not memoized: the next call replays getItems again', async () => {
    const a = useAura(fakeAura({ ids: [] }));
    expect(await client.listCaseIds()).toEqual({ ok: true, ids: [] });
    expect(await client.listCaseIds()).toEqual({ ok: true, ids: [] });
    expect(a.replayGetItems).toHaveBeenCalledTimes(2);
  });

  it('a non-empty list is memoized', async () => {
    const a = useAura(fakeAura({ ids: [CASE_ID] }));
    await client.listCaseIds();
    expect((await client.listCaseIds()).ids).toEqual([CASE_ID]);
    expect(a.replayGetItems).toHaveBeenCalledTimes(1);
  });

  it('no filterId -> the all-open-cases list view filterName is sent', async () => {
    const a = useAura(fakeAura({ ids: [CASE_ID], listParams: { filterName: '__Recent' } }));
    await client.listCaseIds();
    expect(a.lastParams.filterName).toBe('00B6T000007X74uUAC');
  });

  it('an empty default pass falls back once to a verbatim replay of the captured filter', async () => {
    const a = useAura(fakeAura({ listParams: { filterName: 'x' } }));
    const seen = [];
    a.replayGetItems.mockImplementation(async (mutate) => {
      const p = getItemsAction({ filterName: 'x' }).params;
      mutate(p);
      seen.push(p.filterName);
      return { ok: true, value: listResult(p.filterName === 'x' ? [CASE_ID] : []) };
    });
    const r = await client.listCaseIds();
    expect(seen).toEqual(['00B6T000007X74uUAC', 'x']);
    expect(r.ids).toEqual([CASE_ID]);
  });

  it('an explicit filterId still wins (no fallback)', async () => {
    const custom = 'a0B000000000001AAA';
    const a = useAura(fakeAura({ ids: [], listParams: { filterName: 'x' } }));
    await client.listCaseIds({ filterId: custom });
    expect(a.replayGetItems).toHaveBeenCalledTimes(1);
    expect(a.lastParams.filterName).toBe(custom);
  });
});

describe('resolveCaseForRow', () => {
  it('row offsite case id first (no calls), then cache, then list scan, else not found', async () => {
    const a = useAura(fakeAura({ ids: [id(1), id(2), CASE_ID, id(3)] }));
    expect(await client.resolveCaseForRow({ equipmentId: '122269', offsiteShopEventUrl: caseUrl(NO_RO_CASE_ID) })).toEqual({ ok: true, caseId: NO_RO_CASE_ID, via: 'offsite' });
    expect(a.callApex).not.toHaveBeenCalled();

    const r = await client.resolveCaseForRow({ equipmentId: ' #122269 ' });
    expect(r).toEqual({ ok: true, caseId: CASE_ID, via: 'list' });
    expect(a.maxInflight).toBeLessThanOrEqual(3);
    expect(dstore.get(id(1))).toBeTruthy(); // each scanned case is cached

    a.callApex.mockClear();
    expect(await client.resolveCaseForRow({ equipmentId: '122269' })).toEqual({ ok: true, caseId: CASE_ID, via: 'cache' });
    expect(a.callApex).not.toHaveBeenCalled();

    expect((await client.resolveCaseForRow({ equipmentId: 'NOPE' })).code).toBe('DTNA_CASE_NOT_FOUND');
  });
});

describe('bulkPull', () => {
  it('never more than 3 case pulls at once; progress after every case', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => id(i));
    const a = useAura(fakeAura({ ids, delay: 2 }));
    let inflightCases = 0;
    let maxCases = 0;
    const orig = a.callApex.getMockImplementation();
    a.callApex.mockImplementation(async (name, p) => {
      if (name === 'getCaseRecord') { inflightCases++; maxCases = Math.max(maxCases, inflightCases); }
      try { return await orig(name, p); } finally { if (name === 'getCommentsByCaseRepairOrder') inflightCases--; }
    });
    const progress = [];
    const r = await client.bulkPull({ includeComments: true, onProgress: (p) => progress.push(p) });
    expect(r).toMatchObject({ ok: true, total: 10, failed: 0, cancelled: false });
    expect(r.results).toHaveLength(10);
    expect(maxCases).toBeLessThanOrEqual(3);
    expect(maxCases).toBeGreaterThan(1);
    expect(progress).toHaveLength(10);
    expect(progress[9]).toEqual({ done: 10, total: 10, failed: 0 });
  });

  it('abort stops scheduling new batches', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => id(i));
    const a = useAura(fakeAura({ ids }));
    const ac = new AbortController();
    const progress = [];
    const r = await client.bulkPull({ signal: ac.signal, onProgress: (p) => { progress.push(p); if (p.done === 3) ac.abort(); } });
    expect(r.cancelled).toBe(true);
    expect(r.results).toHaveLength(3);
    expect(progress).toHaveLength(3);
    expect(a.calls.filter((c) => c[0] === 'getCaseRecord')).toHaveLength(3);
  });

  it('failed pulls are counted; a sign-in failure stops scheduling', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => id(i));
    useAura(fakeAura({ ids, fail: (n, p) => (n === 'getCaseRecord' && p.caseId === id(1) ? { ok: false, code: 'DTNA_APEX_ERROR' } : null) }));
    const r1 = await client.bulkPull({});
    expect(r1).toMatchObject({ ok: true, total: 6, failed: 1 });
    client._resetForTests();
    const a = useAura(fakeAura({ ids, fail: (n) => (n === 'getCaseRecord' ? { ok: false, code: 'DTNA_SIGNIN_REQUIRED' } : null) }));
    const r2 = await client.bulkPull({});
    expect(r2).toMatchObject({ ok: false, code: 'DTNA_SIGNIN_REQUIRED', failed: 3 });
    expect(a.calls.filter((c) => c[0] === 'getCaseRecord')).toHaveLength(3);
  });

  it('list failure -> ok:false with its code', async () => {
    useAura(fakeAura({ listFail: 'DTNA_SIGNIN_REQUIRED' }));
    expect(await client.bulkPull({})).toMatchObject({ ok: false, code: 'DTNA_SIGNIN_REQUIRED', total: 0 });
  });
});

describe('toTSV', () => {
  const entry = () => client.normalizeCase(CASE_RECORD, RO_LIST[0], COMMENTS, { caseId: CASE_ID, now: NOW });

  it('cases header, CRLF line ends, blank estimate columns', () => {
    const t = client.toTSV([entry()], { mode: 'cases' });
    const lines = t.split('\r\n');
    expect(lines[0]).toBe(client.CASE_COLUMNS.join('\t'));
    expect(lines[0]).toBe('caseId\tcaseNumber\tunitId\tserial\tdealerCode\tdealerName\tcaseStatus\trepairOrderNo\testimateNo\testimateStatus\testimateTotal\tcommentCount\tlastCommentAt\tlastCommentType\tlastCommentText\trgWorkRequestId\trgVendor\trgSite\tcaseUrl');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const cells = lines[1].split('\t');
    expect(cells).toHaveLength(19);
    expect(cells[0]).toBe(CASE_ID);
    expect(cells[9]).toBe('');
    expect(cells[10]).toBe('');
    expect(cells[14]).toBe('Please send an ETA for unit 122269');
    expect(cells[18]).toBe(caseUrl(CASE_ID));
  });

  it("prefixes ' for values starting with = + - @ and flattens tabs / newlines", () => {
    const e = entry();
    e.dealerName = '=HYPERLINK("x")';
    e.caseNumber = '+123';
    e.serial = '-1';
    e.unitId = '@SUM';
    e.caseStatus = 'In\tRepair\r\nnow';
    const cells = client.toTSV([e]).split('\r\n')[1].split('\t');
    expect(cells[5]).toBe('\'=HYPERLINK("x")');
    expect(cells[1]).toBe("'+123");
    expect(cells[3]).toBe("'-1");
    expect(cells[2]).toBe("'@SUM");
    expect(cells[6]).toBe('In Repair now');
  });

  it('comments mode: one row per comment', () => {
    const t = client.toTSV([entry()], { mode: 'comments' });
    const lines = t.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(client.COMMENT_COLUMNS.join('\t'));
    expect(lines).toHaveLength(4);
    expect(lines[1].split('\t')[4]).toBe('General');
  });
});

describe('applyCaseToRow', () => {
  const entry = () => client.normalizeCase(CASE_RECORD, RO_LIST[0], COMMENTS, { caseId: CASE_ID, now: NOW });

  it('refuses a Decisiv offsite and changes nothing', () => {
    const row = { equipmentId: '122269', workRequestId: 'w1', offsiteShopEventUrl: 'https://fleet.decisiv.net/estimates/1', asistNotes: 'keep' };
    const before = JSON.stringify(row);
    expect(rowApply.applyCaseToRow(row, entry(), { now: NOW })).toEqual({ applied: false, reason: 'non-dtna-offsite' });
    expect(JSON.stringify(row)).toBe(before);
  });

  it('sets the offsite fields, _offsiteWrId, parseable asistNotes; touches only OFFSITE_FIELDS + _offsiteWrId', () => {
    const row = { equipmentId: '122269', workRequestId: 'w1', vendor: 'FREIGHTLINER', dealerName: 'Existing Dealer', other: 'x', created: '2026-09-21T00:00:00Z' };
    const before = Object.assign({}, row);
    const r = rowApply.applyCaseToRow(row, entry(), { now: NOW, extract: true });
    expect(r).toEqual({ applied: true, reason: 'ok' });
    expect(row).toMatchObject({
      offsiteShopEventUrl: caseUrl(CASE_ID), savedOffsiteUrl: caseUrl(CASE_ID), asistSrUrl: caseUrl(CASE_ID),
      asistSource: 'dtna', asistLabel: 'DTNA Case', asistScrapedAt: new Date(NOW).toISOString(),
      offsiteStage: 'repair', offsiteStageDetail: 'In Repair', offsiteStageSince: '2026-09-23T14:00:00.000Z',
      _stageReadAt: new Date(NOW).toISOString(), dealerName: 'Existing Dealer', dealerCode: 'HF041', _offsiteWrId: 'w1',
    });
    expect(parseDtnaFeedLines(row.asistNotes)).toHaveLength(3);
    expect(row.offsiteFacts && Array.isArray(row.offsiteFacts.events)).toBe(true);
    expect(row.offsiteFacts.events).toHaveLength(3);
    const allowed = new Set(OFFSITE_FIELDS.concat(['_offsiteWrId']));
    for (const k of Object.keys(row)) {
      if (!allowed.has(k)) expect(row[k]).toBe(before[k]);
    }
  });

  it('keeps a matching DTNA URL, replaces a different DTNA case, uses the given wrId, no facts without extract', () => {
    const same = caseUrl(CASE_ID).replace('/detail', '/detail?tab=1');
    const row = { equipmentId: '122269', workRequestId: 'w1', offsiteShopEventUrl: same, savedOffsiteUrl: caseUrl(NO_RO_CASE_ID) };
    rowApply.applyCaseToRow(row, entry(), { now: NOW, wrId: 'w9' });
    expect(row.offsiteShopEventUrl).toBe(same);
    expect(row.savedOffsiteUrl).toBe(caseUrl(CASE_ID));
    expect(row._offsiteWrId).toBe('w9');
    expect(row.offsiteFacts).toBeUndefined();
  });
});
