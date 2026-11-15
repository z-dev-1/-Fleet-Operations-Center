// tests/relay-refresh-unit-facts.test.js — relay-extract §9.1 / §11.3: the single-unit
// API path (getWorkOrderDetailViaApi -> _relayCacheFromApi -> mergeRelayIntoRows) carries
// Relay facts for a non-ASIST vendor (AC37), refreshUnit's asset-is-truth clear blanks the
// ten WR keys (AC29), totalCost stays a string (AC42), the history cache, and the flag-off
// byte identity of the returned object and cache entry (AC24).
//
// The AAP API is served by a fake browser_provider (aap_api._setProviderForTest): its page
// answers the in-page XHR scripts from fixtures, so every real request path runs.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as V from './fixtures/extract/relay-vendors.js';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'relay-refresh-unit-facts-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const aap = require('../src/scrapers/aap_api');
const mapper = require('../src/scrapers/aap_api_mapper');
const relay = require('../src/scrapers/relay');
const woFacts = require('../src/repair-intel/wo-facts');

// ── fake AAP backend ────────────────────────────────────────────────────────
let BACKEND;
const calls = [];
function backend({ wo, detail, history, asset, historyFails }) {
  return (method, url) => {
    if (method === 'POST' && /\/serviceaggregates\/search$/.test(url)) return { serviceAggregates: wo ? [wo] : [] };
    if (method === 'GET' && /\/serviceaggregates\/[^/]+\/history$/.test(url)) {
      if (historyFails) return { __fail: 500 };
      return { serviceChangeLogs: history || [] };
    }
    if (method === 'GET' && /\/serviceaggregates\/[^/]+$/.test(url)) return detail;
    if (method === 'GET' && /\/assets\/[^/]+$/.test(url)) return asset || null;
    return { __fail: 404 };
  };
}
const fakeProvider = {
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
};
aap._setProviderForTest(fakeProvider);
aap._setAuthReporterForTest({ isEnabled: () => false, report() {} });

const WO_322355 = { id: 'svc-322355', workRequestId: 'wr-322355', assetDisplayName: '322355', aaid: 'aaid_322355', vendor: 'AMERIT',
  lifecycleState: 'UNAVAILABLE', status: { description: { value: 'IN_PROGRESS', displayText: 'In Progress' } },
  scheduledDateTime: Date.parse('2026-11-10T12:00:00Z'), modifiedTimestamp: 1762800000000, vendorWorkOrderIds: ['891-00011598'] };
const WO_IND = { id: 'svc-IND260261', workRequestId: 'wr-IND260261', assetDisplayName: 'IND260261', aaid: 'aaid_ind', vendor: 'TA',
  lifecycleState: 'UNAVAILABLE', status: { description: { value: 'IN_PROGRESS' } }, scheduledDateTime: Date.parse('2026-10-27T12:00:00Z'),
  modifiedTimestamp: 1762500000000, vendorWorkOrderIds: ['TA-77120'] };

// The getWorkOrderDetailViaApi return keys and the _relayCacheFromApi keys on 1eabe04.
const TODAY_DETAIL_KEYS = ['equipmentId', 'workRequestId', 'serviceUrl', '_serviceUUID', 'vendor', 'serviceState', 'subState', 'category',
  'urgent', 'needBy', 'created', 'completed', 'createdBy', 'lifecycleState', 'lifecycleReason', 'issueDetails', 'level1', 'level2', 'level3',
  'altId', 'alternativeId', 'vendorWorkOrderId', 'cause', 'correction', 'totalCost', 'offsiteShopEvent', 'offsiteShopEventUrl',
  'fullConversation', 'source', 'scrapedAt'];
const TODAY_CACHE_KEYS = ['vendor', 'serviceState', 'subState', 'category', 'issueDetails', 'urgent', 'needBy', 'created', 'completed',
  'createdBy', 'lifecycleReason', 'alternativeId', 'workRequestId', 'pageUrl', 'vendorWorkOrderId', 'fullConversation', 'offsiteShopEvent',
  'offsiteShopEventUrl', '_serviceUUID', '_cachedAt', '_via'];
const SEVEN = ['relayFacts', 'relayFactsWr', 'cause', 'correction', 'totalCost', 'salesforceCase', 'salesforceCaseUrl'];

beforeEach(() => { calls.length = 0; aap._resetHistoryCacheForTest(); delete process.env.FLEET_EXTRACT; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.FLEET_EXTRACT; });

describe('single-unit refresh carries Relay facts (AC37)', () => {
  it('getWorkOrderDetailViaApi returns relayFacts, relayFactsWr, cause/correction for a non-ASIST vendor', async () => {
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: V.history322355 });
    const api = await aap.getWorkOrderDetailViaApi('322355');
    expect(api.relayFacts && api.relayFacts.v).toBe(2);
    expect(api.relayFactsWr).toBe('wr-322355');
    expect(api.cause).toContain('DEAD BATTERIES');
    expect(api.correction).toContain('BATTERIES NEED TO BE REPLACED');
    expect(calls.filter((c) => /\/history$/.test(c))).toHaveLength(1);
    // Structured history reached the extractor (ETC revisions as history facts).
    expect(api.relayFacts.facts.some((f) => f.via === 'history')).toBe(true);
  });
  it('_relayCacheFromApi keeps the seven keys; the merge refreshes mirrors on the same WR only', async () => {
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: V.history322355 });
    const api = await aap.getWorkOrderDetailViaApi('322355');
    const cache = relay._relayCacheFromApi(api);
    for (const k of SEVEN) expect(k in cache).toBe(true);
    expect(cache.relayFacts).toBe(api.relayFacts);
    const [same] = relay.mergeRelayIntoRows([{ equipmentId: '322355', workRequestId: 'wr-322355' }], { 322355: cache }, {});
    expect(same.relayFacts).toBe(api.relayFacts);
    expect(same.vendorDelayReason).toBe('SOURCING_PARTS');
    expect(same.roNumbers).toContain('891-00011598');
    const own = { v: 2, facts: [], events: [], counts: {}, at: '2026-11-01T00:00:00.000Z', wr: 'wr-OTHER' };
    const [other] = relay.mergeRelayIntoRows([{ equipmentId: '322355', workRequestId: 'wr-OTHER', relayFacts: own, relayFactsWr: 'wr-OTHER' }], { 322355: cache }, {});
    expect(other.relayFacts).toBe(own);
    expect(other.vendorDelayReason).toBe('');
  });
  it('history cache: same modified stamp skips the call; an error is cached and not retried', async () => {
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: V.history322355 });
    await aap.getWorkOrderDetailViaApi('322355');
    await aap.getWorkOrderDetailViaApi('322355');
    expect(calls.filter((c) => /\/history$/.test(c))).toHaveLength(1);
    aap._resetHistoryCacheForTest(); calls.length = 0;
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, historyFails: true });
    const a = await aap.getWorkOrderDetailViaApi('322355');
    expect(a.relayFacts.v).toBe(2);                       // facts without history
    await aap.getWorkOrderDetailViaApi('322355');
    expect(calls.filter((c) => /\/history$/.test(c))).toHaveLength(1);
  });
  it('flag off: exactly today\'s keys on the result and the cache entry; no history GET', async () => {
    process.env.FLEET_EXTRACT = '0';
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: V.history322355 });
    const api = await aap.getWorkOrderDetailViaApi('322355');
    expect(Object.keys(api)).toEqual(TODAY_DETAIL_KEYS);
    expect(Object.keys(relay._relayCacheFromApi(api))).toEqual(TODAY_CACHE_KEYS);
    expect(calls.some((c) => /\/history$/.test(c))).toBe(false);
    const [m] = relay.mergeRelayIntoRows([{ equipmentId: '322355', workRequestId: 'wr-322355' }], { 322355: relay._relayCacheFromApi(api) }, {});
    expect('relayFacts' in m).toBe(false);
    expect('partNumbers' in m).toBe(false);
  });
});

describe('totalCost on the single-unit path is a string (AC42)', () => {
  it('IND260261 -> $24,804.13', async () => {
    BACKEND = backend({ wo: WO_IND, detail: V.relayIND260261, history: [] });
    const api = await aap.getWorkOrderDetailViaApi('IND260261');
    expect(api.totalCost).toBe('$24,804.13');
  });
  it('mapper throws -> the reduce sum formatted by _usd, never a number; or \'\'', async () => {
    vi.spyOn(mapper, 'toFleetRow').mockImplementation(() => { throw new Error('boom'); });
    const detail = Object.assign({}, V.relayIND260261, { workOrderLineItems: [{ id: 'a', cost: 100.5 }, { id: 'b', amount: 20 }] });
    BACKEND = backend({ wo: WO_IND, detail, history: [] });
    const api = await aap.getWorkOrderDetailViaApi('IND260261');
    expect(api.totalCost).toBe('$120.50');
    expect(api.relayFacts).toBe(null);
    BACKEND = backend({ wo: WO_IND, detail: V.relayIND260261, history: [] });
    const api2 = await aap.getWorkOrderDetailViaApi('IND260261');
    expect(api2.totalCost).toBe('');
  });
});

describe('refreshUnit (AC29 asset-is-truth, history, PM)', () => {
  it('Unavailable unit: relayFacts + fills from the live thread, history read once', async () => {
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: V.history322355,
      asset: { asset: { lifecycleState: 'UNAVAILABLE', attributesText: {} } } });
    const row = await aap.refreshUnit('322355');
    expect(row.relayFacts.v).toBe(2);
    expect(row.relayFactsWr).toBe('wr-322355');
    expect(row.cause).toContain('DEAD BATTERIES');
    expect(calls.filter((c) => /\/history$/.test(c))).toHaveLength(1);
  });
  it('Active unit with a stale WO: the ten WR keys come back blank, then blank mirrors', async () => {
    const stale = Object.assign({}, WO_322355, { lifecycleState: 'ACTIVE' });
    BACKEND = backend({ wo: stale, detail: V.relay322355, history: V.history322355,
      asset: { asset: { lifecycleState: 'ACTIVE', attributesText: {} } } });
    const row = await aap.refreshUnit('322355');
    expect(row.relayFacts).toBe(null);
    for (const k of ['relayFactsWr', 'createdBy', 'needBy', 'alternativeId', 'cause', 'correction', 'totalCost', 'salesforceCase', 'salesforceCaseUrl']) {
      expect(row[k]).toBe('');
    }
    const r = woFacts.refreshRowFacts(row, { enabled: true, aiOutput: true }, '2026-11-11');
    expect(r.partNumbers).toBe('');
    expect(r.vendorDelayReason).toBe('');
    expect(r.roNumbers).toBe('');
    expect('_factsOn' in r).toBe(false);
  });
  it('PM block passes {all}: pmSchedule + new raw keys reach the row', async () => {
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: [],
      asset: { asset: { lifecycleState: 'UNAVAILABLE', attributesText: {}, maintenanceScheduleStatuses: [
        { maintenanceType: 'PM_A', nextDueDate: '2025-11-19', dueDateDisplayFormat: 'DATE' },
        { maintenanceType: 'WASH', nextDueDate: '2026-01-31', dueDateDisplayFormat: 'DATE' }] } } });
    const row = await aap.refreshUnit('322355');
    expect(row.pmADue).toBe('Nov 19, 2025');
    expect(row.washDue).toBe('Jan 31, 2026');
    expect(row.pmSchedule).toHaveLength(2);
  });
  it('flag off: no history GET, no fact keys, legacy PM only', async () => {
    process.env.FLEET_EXTRACT = '0';
    BACKEND = backend({ wo: WO_322355, detail: V.relay322355, history: V.history322355,
      asset: { asset: { lifecycleState: 'UNAVAILABLE', attributesText: {}, maintenanceScheduleStatuses: [
        { maintenanceType: 'PM_A', nextDueDate: '2025-11-19' }, { maintenanceType: 'DOT', nextDueDate: '2026-11-01' }] } } });
    const row = await aap.refreshUnit('322355');
    expect(calls.some((c) => /\/history$/.test(c))).toBe(false);
    for (const k of SEVEN.concat(['pmADue', 'pmSchedule'])) expect(k in row).toBe(false);
    expect(row.dotDue).toBe('Nov 1, 2026');
  });
});
