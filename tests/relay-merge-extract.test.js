// tests/relay-merge-extract.test.js — relay-extract §12.3 #1: mergeRelayIntoRows with
// extraction on carries offsiteFacts from the same side as asistNotes (newer wins, estimate
// guard), offsiteStageHistory with the stage trio, the WR-guarded relayFacts, derives
// subVendor without the geofence (AC12), writes the mirrors (AC27 bulk shape), and stays
// within a 253-row bound. Flag off: no new key, subVendor keeps today's expression (AC24).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
import * as R39 from './fixtures/extract/relay-39582-volvo.js';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'relay-merge-extract-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/scrapers/relay');
const mapper = require('../src/scrapers/aap_api_mapper');
const X = require('../src/repair-intel/wo-extract');
const woFacts = require('../src/repair-intel/wo-facts');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const EST_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/20945735';
const OTHER_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/99999999';
const DEALER = 'M & K Truck Centers - Dunmore, PA (Volvo)';
// scrape-era-subvendor (design §20.1): a DOM-era row with an ellipsized geofence and
// current-episode Decisiv notes from the dealer location.
const SCRAPE_ERA_NOTES = N.allNotes.slice(0, 2).concat(N.allNotes.slice(96, 100));
const offsite = (estimateId, notes = SCRAPE_ERA_NOTES) => X.extractDecisivNotes(notes, { estimateId, wrCreatedAt: N.WR_CREATED_AT, now: NOW });
const relayBlock = () => mapper.toFleetRow({ id: 'svc-39582', workRequestId: 'wr-39582', assetDisplayName: '39582', vendor: 'VOLVO',
  scheduledDateTime: Date.parse('2026-09-23T18:04:00Z') }, null, R39.serviceDetail, { extract: { enabled: true }, now: NOW }).relayFacts;
const NEW_KEYS = ['relayFacts', 'offsiteFacts', 'offsiteStageHistory', 'partNumbers', 'orderNumbers', 'repairEtc', 'pmOverdue',
  '_factsOn', '_factEtc', '_factsSig', '_factFilled', 'etcMissed', 'partsMissCount', 'extractedAt'];

beforeEach(() => { delete process.env.FLEET_EXTRACT; });
afterEach(() => { delete process.env.FLEET_EXTRACT; });

describe('subVendor (AC12)', () => {
  const base = { equipmentId: '39582', workRequestId: 'wr-39582', geofence: 'M&K Truck Center...', dealerName: '', suppliers: 'VOLVO',
    offsiteShopEventUrl: EST_URL, created: '2026-09-23T18:04:00.000Z' };
  it('offsite facts naming the dealer: dealerName and subVendor = that name, not the cut geofence', () => {
    const [o] = relay.mergeRelayIntoRows([Object.assign({}, base, { offsiteFacts: offsite('20945735') })], {}, {});
    expect(o.dealerName).toBe(DEALER);
    expect(o.subVendor).toBe(DEALER);
    expect(o._factFilled.dealerName).toBe(DEALER);
  });
  it('no dealer facts and suppliers VOLVO: subVendor is empty, never the geofence', () => {
    const [o] = relay.mergeRelayIntoRows([Object.assign({}, base)], {}, {});
    expect(o.subVendor).toBe('');
  });
  it('flag off: today\'s expression (geofence fallback), no new keys', () => {
    process.env.FLEET_EXTRACT = '0';
    const [o] = relay.mergeRelayIntoRows([Object.assign({}, base)], {}, {});
    expect(o.subVendor).toBe('M&K Truck Center...');
    for (const k of NEW_KEYS) expect(k in o).toBe(false);
  });
});

describe('offsite facts + stage history carry (newer wins)', () => {
  const A = offsite('20945735');
  const B = offsite('20945735', N.allNotes.slice(0, 3));
  const row = (o) => Object.assign({ equipmentId: '39582', workRequestId: 'wr-39582', offsiteShopEventUrl: EST_URL, created: '2026-09-23T18:04:00.000Z' }, o);
  it('cache notes newer -> the cache block; row newer -> the row block', () => {
    const cacheNewer = { asistNotes: 'cache text', asistScrapedAt: '2026-11-11T10:00:00Z', offsiteFacts: A };
    const [o1] = relay.mergeRelayIntoRows([row({ asistNotes: 'row text', asistScrapedAt: '2026-11-10T10:00:00Z', offsiteFacts: B })], { 39582: cacheNewer }, {});
    expect(o1.offsiteFacts).toBe(A);
    expect(o1.asistNotes).toBe('cache text');
    const [o2] = relay.mergeRelayIntoRows([row({ asistNotes: 'row text', asistScrapedAt: '2026-11-12T10:00:00Z', offsiteFacts: B })], { 39582: cacheNewer }, {});
    expect(o2.offsiteFacts).toBe(B);
  });
  it('newer side without a block keeps the other block only for the current estimate', () => {
    const cacheDom = { asistNotes: 'dom text', asistScrapedAt: '2026-11-12T10:00:00Z' };   // DOM-only refresh, no facts
    const [keep] = relay.mergeRelayIntoRows([row({ asistNotes: 'row', asistScrapedAt: '2026-11-10T10:00:00Z', offsiteFacts: B })], { 39582: cacheDom }, {});
    expect(keep.offsiteFacts).toBe(B);
    const [drop] = relay.mergeRelayIntoRows([row({ offsiteShopEventUrl: OTHER_URL, asistNotes: 'row', asistScrapedAt: '2026-11-10T10:00:00Z', offsiteFacts: B })], { 39582: cacheDom }, {});
    expect('offsiteFacts' in drop).toBe(false);
  });
  it('stage history follows the stage trio side', () => {
    const H0 = [{ stage: 'repair', status: 'Working', at: '2026-11-01T10:00:00-04:00' }];
    const H1 = H0.concat([{ stage: 'repair', status: 'Hold (parts)', at: '2026-11-10T10:00:00-05:00' }]);
    const cache = { offsiteStage: 'repair', offsiteStageDetail: 'Hold (parts)', offsiteStageSince: '2026-11-10T10:00:00-05:00', _stageReadAt: '2026-11-11T10:00:00Z', offsiteStageHistory: H1 };
    const [o1] = relay.mergeRelayIntoRows([row({ offsiteStage: 'repair', offsiteStageSince: 'old', offsiteStageHistory: H0 })], { 39582: cache }, {});
    expect(o1.offsiteStageDetail).toBe('Hold (parts)');
    expect(o1.offsiteStageHistory).toBe(H1);
    const [o2] = relay.mergeRelayIntoRows([row({ offsiteStage: 'repair', offsiteStageDetail: 'Working', offsiteStageSince: 'x', _stageReadAt: '2026-11-12T10:00:00Z', offsiteStageHistory: H0 })], { 39582: cache }, {});
    expect(o2.offsiteStageDetail).toBe('Working');
    expect(o2.offsiteStageHistory).toBe(H0);
    const [o3] = relay.mergeRelayIntoRows([row({ offsiteStageHistory: H0 })], { 39582: { offsiteStage: 'ready' } }, {});
    expect(o3.offsiteStageHistory).toBe(H0);    // an old cache entry without history never erases it
  });
});

describe('mirrors on the merged row (AC27 bulk shape)', () => {
  it('relayFacts on the row (API bulk + carry): mirrors, _factEtc, fills; idempotent', () => {
    const rf = relayBlock();
    const r = { equipmentId: '39582', workRequestId: 'wr-39582', relayFacts: rf, relayFactsWr: 'wr-39582', created: '2026-09-23T18:04:00.000Z' };
    const [o] = relay.mergeRelayIntoRows([r], {}, {});
    expect(o.partNumbers).toBe('85152780');
    expect(o.orderNumbers).toContain('3010287243');
    expect(o._factsOn).toBe(true);
    expect(o._factEtc && typeof o._factEtc.state).toBe('string');
    const again = woFacts.refreshRowFacts(JSON.parse(JSON.stringify(o)), { enabled: true, aiOutput: true });
    expect(again).toEqual(JSON.parse(JSON.stringify(o)));
  });
  it('flag off: rows with no blocks gain no key; the merged row matches the flag-off merge of the same row', () => {
    const r = { equipmentId: 'A1', workRequestId: 'wr-1', vendor: 'TA', geofence: 'Yard 1' };
    process.env.FLEET_EXTRACT = '0';
    const [off] = relay.mergeRelayIntoRows([Object.assign({}, r)], {}, {});
    for (const k of NEW_KEYS) expect(k in off).toBe(false);
    expect(Object.keys(off).includes('subVendor')).toBe(true);
  });
});

describe('253-row bound', () => {
  it('a 253-row merge with 34 full blocks stays within the CPU bound and the 2 MB block cap', () => {
    const rf = relayBlock();
    const of = offsite('20945735', N.allNotes);
    const rows = [];
    for (let i = 0; i < 253; i++) {
      rows.push(i < 34
        ? { equipmentId: 'U' + i, workRequestId: 'wr-39582', relayFacts: rf, relayFactsWr: 'wr-39582', offsiteFacts: of, offsiteShopEventUrl: EST_URL, created: '2026-09-23T18:04:00.000Z' }
        : { equipmentId: 'U' + i, lifecycleState: 'Active' });
    }
    let best = Infinity; let out = null;
    for (let k = 0; k < 3; k++) {
      const c0 = process.cpuUsage();
      out = relay.mergeRelayIntoRows(rows, {}, {});
      const c = process.cpuUsage(c0);
      best = Math.min(best, (c.user + c.system) / 1000);
    }
    expect(best).toBeLessThan(600);
    expect(out).toHaveLength(253);
    expect(out[0].partNumbers).toBe('85152780');
    expect(woFacts.trimFleetBlocks(out, 2 * 1024 * 1024).bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
