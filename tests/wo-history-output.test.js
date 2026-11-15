// tests/wo-history-output.test.js — Relay history trend in the outputs: the fact-sheet line (no
// requester logins; passes the shared gate for cited dates / amounts), the create-only line, the
// repair-intel digest, Trends etcSlipsByVendor, analysis._factsLine, and the fetch paths: the bulk
// buildFleetDataset never reads /history, refreshUnit reads it once, the per-unit repair-intel
// hydrate reads it only when extract is enabled. The AAP API is a fake browser_provider.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as V from './fixtures/extract/relay-vendors.js';
import * as H from './fixtures/extract/history-shapes.js';
import * as T from './fixtures/extract/ri-trends-3.js';
const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-history-output-'));
require('../src/config/paths').setDataDir(tmpDir);
const engine = require('../src/store/sqlite_engine');
const X = require('../src/repair-intel/wo-extract');
const W = require('../src/repair-intel/wo-facts');
const O = require('../src/repair-intel/wo-fact-output');
const G = require('../src/dbr/fleet-dbr-gate');
const store = require('../src/repair-intel/store');
const trends = require('../src/repair-intel/trends');
const analysis = require('../src/repair-intel/analysis');
const riFetch = require('../src/repair-intel/fetch');
const aap = require('../src/scrapers/aap_api');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';
const relay = (sd, o = {}) => X.extractRelay(sd, Object.assign({ now: NOW }, o));
const rowOf = (rf) => ({ equipmentId: 'U1', relayFacts: rf, created: '2026-11-01T12:00:00Z' });
const fsOf = (rf) => W.buildFactSet(rowOf(rf), { today: TODAY });
const verdict = (g) => (g.ok ? 'kept' : g.code);
afterAll(() => {
  try { engine.close(); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
const LOGINS = ['fasuser1', 'fasuser2', 'fasuser3', 'RelayGarage-PendingAssignmentAutomation'];

describe('fact sheet history line', () => {
  const fsB = fsOf(relay(V.relayB12195, { history: H.histB12195Full, vendor: 'COX' }));
  const sheetB = O.factSheet(fsB, { purpose: 'dbr', row: rowOf(null) });
  const fsI = fsOf(relay(V.relayIND260261, { history: H.histIND260261, vendor: 'TA' }));
  const sheetI = O.factSheet(fsI, { purpose: 'dbr', row: rowOf(null) });
  const lineOf = (s) => s.lines.find((l) => /Relay history:/.test(l)) || '';
  it('B12195: ETC path, vendor change, open state; no requester login', () => {
    const l = lineOf(sheetB);
    expect(l).toContain('ETC revised 2\u00d7 (slipped 1\u00d7, pulled in 1\u00d7): 11/9 \u2192 11/8 \u2192 11/10 (latest vendor-set)');
    expect(l).toContain('vendor UNASSIGNED \u2192 COX 11/7');
    expect(l).toMatch(/in WORK_IN_PROGRESS \d+(\.\d)?d/);
    for (const who of LOGINS) expect(sheetB.text).not.toContain(who);
  });
  it('IND260261: estimate path and decisions with reasons; no requester login', () => {
    const l = lineOf(sheetI);
    expect(l).toContain('estimate $28,895.94 \u2192 $28,984.94 \u2192 $24,715.13 \u2192 $24,804.13');
    expect(l).toContain('decisions: rejected 10/31 (Line item cost above expected), rejected 11/2 (Question/Concern), rejected 11/4 (Question/Concern), approved 11/5');
    expect(l).toContain('no ETC change recorded');
    for (const who of LOGINS) expect(sheetI.text).not.toContain(who);
  });
  it('timeline purpose omits the $ path', () => {
    expect(lineOf(O.factSheet(fsI, { purpose: 'timeline', row: rowOf(null) }))).not.toContain('$');
  });
  it('Decisiv create-only: the fixed limitation line', () => {
    const fsV = fsOf(relay(V.relay322355, { history: H.hist39582CreateOnly }));
    expect(lineOf(O.factSheet(fsV, { purpose: 'dbr', row: rowOf(null) })))
      .toContain('Relay history: work request created only (dealer-integrated; ETC/estimate revisions are not recorded in Relay)');
  });
  it('no history: no history line', () => {
    const fsN = fsOf(relay(V.relayB12195, { vendor: 'COX' }));
    expect(lineOf(O.factSheet(fsN, { purpose: 'dbr', row: rowOf(null) }))).toBe('');
  });
  it('the shared gate accepts prose citing the sheet\'s 11/10 and $24,804.13; a planted amount drops', () => {
    const cB = O.factContext(fsB, { promptText: '', sheetText: sheetB.text, rowDates: sheetB.rowDates, today: TODAY });
    expect(verdict(G.gateEntry('Vendor moved the ETC to 11/10 after an earlier pull-in', undefined, ['U'], cB, { field: 'details' }))).toBe('kept');
    const cI = O.factContext(fsI, { promptText: '', sheetText: sheetI.text, rowDates: sheetI.rowDates, today: TODAY });
    expect(verdict(G.gateEntry('Estimate approved 11/5 at $24,804.13 after three rejections', undefined, ['U'], cI, { field: 'details' }))).toBe('kept');
    expect(verdict(G.gateEntry('Estimate approved 11/5 at $24,999.13', undefined, ['U'], cI, { field: 'details' }))).not.toBe('kept');
  });
});

describe('digest, trends, analysis line', () => {
  beforeAll(() => { engine.close(); });
  it('digestForRi carries history (slips, seq, decisions); createOnly flag', () => {
    const d = W.digestForRi(fsOf(relay(V.relayB12195, { history: H.histB12195Full })));
    expect(d.history.etcSlipCount).toBe(1);
    expect(d.history.etcSeq).toHaveLength(3);
    expect(d.history.vendorChanges.some((v) => v.to === 'COX')).toBe(true);
    expect(d.history.createOnly).toBe(false);
    const di = W.digestForRi(fsOf(relay(V.relayIND260261, { history: H.histIND260261, vendor: 'TA' })));
    expect(di.history.decisions.map((x) => x.outcome)).toEqual(['rejected', 'rejected', 'rejected', 'approved']);
    expect(di.history.estimateRevisions).toHaveLength(4);
    expect(W.digestForRi(fsOf(relay(V.relay322355, { history: H.hist39582CreateOnly }))).history.createOnly).toBe(true);
  });
  it('trends etcSlipsByVendor from digests with history; analysis._factsLine says ETC moved', () => {
    const rf = relay(V.relayB12195, { history: H.histB12195Full, vendor: 'COX' });
    const wo = { workRequestId: 'SB12195', assetDisplayName: 'B12195', vendor: 'COX', category: 'Unplanned Repair',
      status: { description: { value: 'OPEN' } }, suggestedItems: [{ level1: 'Engine' }], damageDescription: 'no start',
      reportedDateTime: '2026-11-07T20:54:59Z', createdDateTime: '2026-11-07T20:54:59Z', lastModifiedDateTime: '2026-11-10T00:00:00Z' };
    T.seed(store, [{ sid: 'SB12195', unit: 'B12195', wo, row: { relayFacts: rf, created: '2026-11-07T20:54:59Z' }, history: null }]);
    const x = trends.buildTrends({ sinceMs: 0 }).extracted;
    expect(x.etcSlipsByVendor[0]).toMatchObject({ key: 'COX', slips: 1, wos: 1 });
    const ev = store.eventsForUnit('B12195', { includeExcluded: true }).find((e) => e.source_id === 'SB12195');
    expect(analysis._factsLine(ev.extracted_facts)).toContain('ETC moved 1\u00d7');
  });
});

// ── fake AAP backend (pattern of tests/relay-refresh-unit-facts.test.js) ────────
let BACKEND;
const calls = [];
const WO = { id: 'svc-B12195', workRequestId: 'wr-B12195', assetDisplayName: 'B12195', aaid: 'aaid_b12195', vendor: 'COX',
  lifecycleState: 'UNAVAILABLE', status: { description: { value: 'WORK_IN_PROGRESS', displayText: 'In Progress' } },
  scheduledDateTime: Date.parse('2026-11-07T21:00:00Z'), modifiedTimestamp: 1762800000000, vendorWorkOrderIds: ['03398831'] };
function backend() {
  return (method, url) => {
    if (method === 'POST' && /\/assets\/search$/.test(url)) return { assets: [{ asset: { aaid: 'aaid_b12195', displayName: 'B12195', lifecycleState: 'UNAVAILABLE' } }] };
    if (method === 'POST' && /\/serviceaggregates\/search$/.test(url)) return { serviceAggregates: [WO] };
    if (method === 'GET' && /\/serviceaggregates\/[^/]+\/history$/.test(url)) return { serviceChangeLogs: H.histB12195Full };
    if (method === 'GET' && /\/serviceaggregates\/[^/]+$/.test(url)) return V.relayB12195;
    if (method === 'GET' && /\/assets\/[^/]+$/.test(url)) return { asset: { lifecycleState: 'UNAVAILABLE', attributesText: {} } };
    return { __fail: 404 };
  };
}
aap._setProviderForTest({
  kind: () => 'electron',
  shutdown() {},
  openPage: async () => ({
    url: () => 'https://aap-na.corp.amazon.com/v2/page/x',
    close() {},
    evaluate: async (script) => {
      if (script.includes('__aapHookInstalled')) return null;
      if (script.includes('var deadline')) return 'tok';
      const m = /xhr\.open\("(\w+)", "([^"]+)"/.exec(script);
      if (!m) return { ok: false, status: -1, error: 'unparsed' };
      calls.push(m[1] + ' ' + m[2].replace('https://aap-na.corp.amazon.com', ''));
      const json = BACKEND(m[1], m[2]);
      if (json && json.__fail) return { ok: false, status: json.__fail, text: 'err' };
      return { ok: true, status: 200, json };
    },
  }),
});
aap._setAuthReporterForTest({ isEnabled: () => false, report() {} });
const historyCalls = () => calls.filter((c) => /\/history$/.test(c)).length;

describe('fetch paths: per-unit only', () => {
  beforeEach(() => { calls.length = 0; aap._resetHistoryCacheForTest(); delete process.env.FLEET_EXTRACT; BACKEND = backend(); });
  afterEach(() => { delete process.env.FLEET_EXTRACT; });
  it('buildFleetDataset (bulk) never requests /history, with or without comments', async () => {
    await aap.buildFleetDataset({ domiciles: ['TST1'], withComments: false, maxPages: 1 });
    expect(calls.some((c) => /serviceaggregates\/search$/.test(c))).toBe(true);
    expect(historyCalls()).toBe(0);
    calls.length = 0;
    await aap.buildFleetDataset({ domiciles: ['TST1'], withComments: true, maxPages: 1 });
    expect(calls.some((c) => /GET \/api\/v1\/serviceaggregates\/svc-B12195$/.test(c))).toBe(true);
    expect(historyCalls()).toBe(0);
  });
  it('refreshUnit requests /history exactly once', async () => {
    const row = await aap.refreshUnit('B12195');
    expect(historyCalls()).toBe(1);
    expect(row.relayFacts.historyTrend.etc.slipCount).toBe(1);
  });
  it('repair-intel hydrate: one /history per hydrated WO when extract is on; zero when off', async () => {
    engine.close();
    const on = await riFetch.syncUnit('B12195', { hydrateDetail: true, skipPartsExtract: true });
    expect(on.ok).toBe(true);
    expect(on.detail.hydrated).toBe(1);
    expect(historyCalls()).toBe(1);
    const ev = store.eventsForUnit('B12195', { includeExcluded: true }).find((e) => e.source_id === 'wr-B12195');
    expect(JSON.parse(ev.extracted_facts).history.etcSlipCount).toBe(1);
    calls.length = 0; aap._resetHistoryCacheForTest();
    process.env.FLEET_EXTRACT = '0';
    // A new WO for the unit, so the hydrate runs again (stored WOs with an unchanged stamp are skipped).
    BACKEND = (m, u) => (/\/serviceaggregates\/search$/.test(u) ? { serviceAggregates: [Object.assign({}, WO, { workRequestId: 'wr-B12195-2' })] } : backend()(m, u));
    const off = await riFetch.syncUnit('B12195', { hydrateDetail: true, skipPartsExtract: true });
    expect(off.ok).toBe(true);
    expect(off.detail.hydrated).toBe(1);
    expect(calls.some((c) => /GET \/api\/v1\/serviceaggregates\/wr-B12195-2$/.test(c))).toBe(true);
    expect(historyCalls()).toBe(0);
  });
});
