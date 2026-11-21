// DTNA Phase A step 6: client (normalize, pull, list, resolve, bulk, TSV) + row-apply.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDtna } from './fixtures/dtna/fake-electron.js';
import {
  CASE_ID, NO_RO_CASE_ID, RO_ID, CASE_RECORD, NO_RO_RECORD, RO_LIST, COMMENTS, NO_RO_COMMENTS, getItemsAction, listResult,
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
    callApex: vi.fn(async (name, p) => {
      a.calls.push([name, p.caseId || p.commentId]);
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
    replayGetItems: vi.fn(async (mutate) => {
      const action = getItemsAction(o.listParams || {});
      if (mutate) mutate(action.params);
      a.lastParams = Object.assign({}, action.params);
      if (o.listFail) return { ok: false, code: o.listFail };
      const ids = o.ids || [CASE_ID, NO_RO_CASE_ID];
      if (!('pageSize' in action.params)) return { ok: true, value: listResult(ids) };
      const start = (action.params.currentPage || 0) * action.params.pageSize;
      return { ok: true, value: listResult(ids.slice(start, start + action.params.pageSize)) };
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

  it('invalid case id -> DTNA_INVALID_INPUT with zero calls', async () => {
    const a = useAura(fakeAura());
    expect(await client.pullCase('nope')).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
    expect(a.callApex).not.toHaveBeenCalled();
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
