// tests/loader-facts.test.js — relay-extract §12.3 / AC27 "fresh on every path": the
// standalone loaders (ipc/aap-api.js fleet:load-via-api, the inline fleet:set-data-source
// branch, cluster/standby-daemon _tickFleet) keep the previous fleetData's fact blocks for
// the same WR only and recompute the mirrors before save + push; flag off, the saved
// payload equals today's (AC24). window/index.js cannot be loaded in a unit test
// (top-level Electron + closure state), so its four call sites are pinned statically.
// Idempotence of refreshRowFacts closes the file.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import * as R39 from './fixtures/extract/relay-39582-volvo.js';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(os.tmpdir(), 'loader-facts-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

const handlers = {};
function injectFake(rel, exportsObj) {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
injectFake('../src/cluster/index', { mayLivePull: () => true, mayRunProduction: () => true });
const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const relay = require('../src/scrapers/relay');
const mapper = require('../src/scrapers/aap_api_mapper');
const X = require('../src/repair-intel/wo-extract');
const woFacts = require('../src/repair-intel/wo-facts');
const daemon = require('../src/cluster/standby-daemon');
const pushed = [];
const ctx = { pushData: (d) => pushed.push(d), mergeRelayIntoRows: relay.mergeRelayIntoRows, mergeUptakeIntoRows: (rows) => rows, lastData: null };
require('../src/ipc/aap-api').registerAapApiIPC(ctx);
const call = (ch, arg) => handlers[ch]({}, arg);

const NOW = Date.parse('2026-11-11T15:00:00Z');
const RF = mapper.toFleetRow({ id: 'svc-39582', workRequestId: 'wr-39582', assetDisplayName: '39582', vendor: 'VOLVO',
  scheduledDateTime: Date.parse('2026-09-23T18:04:00Z') }, null, R39.serviceDetail, { extract: { enabled: true }, now: NOW }).relayFacts;
const OF = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', wrCreatedAt: N.WR_CREATED_AT, now: NOW });
const HIST = [{ stage: 'repair', status: 'Hold (parts)', at: '2026-11-01T10:00:00-04:00' }];
const PREV = () => ({ rows: [
  { equipmentId: '39582', workRequestId: 'wr-39582', relayFacts: RF, relayFactsWr: 'wr-39582', offsiteFacts: OF, offsiteStageHistory: HIST, _offsiteWrId: 'wr-39582' },
  { equipmentId: 'B1', workRequestId: 'wr-OLD', relayFacts: RF, relayFactsWr: 'wr-OLD', offsiteFacts: OF, _offsiteWrId: 'wr-OLD' },
] });
// Bulk rows as buildFleetDataset returns them (withComments:false -> no blocks).
const DS = () => ({ rows: [
  { equipmentId: '39582', workRequestId: 'wr-39582', vendor: 'Volvo (ASIST)', created: '2026-09-23T18:04:00.000Z', lifecycleState: 'Unavailable' },
  { equipmentId: 'B1', workRequestId: 'wr-NEW', vendor: 'TA', created: '2026-11-10T12:00:00.000Z', lifecycleState: 'Unavailable' },
], count: 2, unavailableCount: 2 });
const strip = (p) => JSON.parse(JSON.stringify(Object.assign({}, p, { syncedAt: null, scrapedAt: null })));

beforeEach(() => {
  pushed.length = 0; ctx.lastData = null; delete process.env.FLEET_EXTRACT;
  store.save('fleetData', PREV()); store.save('notesStore', {}); store.save('uptakeHash', {});
  vi.spyOn(aap, 'buildFleetDataset').mockImplementation(async () => DS());
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.FLEET_EXTRACT; });

function expectCarried(rows) {
  const a = rows.find((r) => r.equipmentId === '39582');
  const b = rows.find((r) => r.equipmentId === 'B1');
  expect(a.relayFacts.v).toBe(2);
  expect(a.offsiteFacts.v).toBe(2);
  expect(a.offsiteStageHistory).toEqual(HIST);
  expect(a.partNumbers).toBe('85152780');
  expect(a._factEtc && typeof a._factEtc.state).toBe('string');
  expect(a._factsOn).toBe(true);
  expect('relayFacts' in b).toBe(false);          // WR changed -> no carried block
  expect('offsiteFacts' in b).toBe(false);
  expect(b.partNumbers).toBe('');
}

describe('fleet:load-via-api (AC27 #4b)', () => {
  it('saved and pushed rows carry the same-WR blocks with fresh mirrors', async () => {
    const r = await call('fleet:load-via-api', {});
    expect(r.ok).toBe(true);
    expectCarried(store.load('fleetData', {}).rows);
    expectCarried(pushed[0].rows);
  });
  it('flag off: the saved payload equals today\'s (merge only, no carry, no mirrors)', async () => {
    process.env.FLEET_EXTRACT = '0';
    await call('fleet:load-via-api', {});
    const saved = store.load('fleetData', {});
    const today = { rows: relay.mergeRelayIntoRows(DS().rows, {}, {}), count: 2, unavailableCount: 2, syncedAt: null, scrapedAt: null, stale: false, source: 'aap-api' };
    expect(strip(saved)).toEqual(strip(today));
  });
});

describe('inline API load branch (AC27 #4)', () => {
  it('fleet:set-data-source without the window loader carries + refreshes', async () => {
    const r = await call('fleet:set-data-source', { source: 'api' });
    expect(r && r.ok !== false).toBe(true);
    expectCarried(store.load('fleetData', {}).rows);
  });
});

describe('standby-daemon fleet refresh (AC27 #5)', () => {
  it('carries the same-WR blocks and recomputes mirrors before the save', async () => {
    await daemon._tickFleet();
    expectCarried(store.load('fleetData', {}).rows);
  });
  it('flag off: no carry, no mirrors', async () => {
    process.env.FLEET_EXTRACT = '0';
    await daemon._tickFleet();
    const rows = store.load('fleetData', {}).rows;
    expect('relayFacts' in rows[0]).toBe(false);
    expect('partNumbers' in rows[0]).toBe(false);
  });
});

describe('window/index.js call sites (static, AC27 bulk + hydrate + PM fill)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/window/index.js'), 'utf8');
  it('bulk: refreshFleetFacts after the carry-forward, before the save', () => {
    const carry = src.indexOf("logger.warn('[data-source] carry-forward merge skipped: '");
    const refresh = src.indexOf("require('../repair-intel/wo-facts').refreshFleetFacts(rows, _xf)", carry);
    const save = src.indexOf("store.save('fleetData', payload);", carry);
    expect(carry).toBeGreaterThan(0);
    expect(refresh).toBeGreaterThan(carry);
    expect(save).toBeGreaterThan(refresh);
  });
  it('bulk carry-forward: same-WR relayFacts, PM keys incl. pmSchedule ([] is blank)', () => {
    expect(src).toContain("if (!row.relayFacts && p.relayFacts && p.relayFactsWr === row.workRequestId) {");
    expect(src).toContain("'pmADue','washDue','apuDue','svrDue','stateInspDue','r360Due','semiannualLiftDue','pmSchedule'");
    expect(src).toContain('const blankV = (v) => blank(v) || (Array.isArray(v) && !v.length);');
  });
  it('hydrate: copies the WR keys for the same WR and refreshes after overlayDeepScanFields, before the save', () => {
    expect(src).toContain("for (const k of ['relayFacts', 'relayFactsWr', 'createdBy', 'needBy', 'alternativeId', 'cause', 'correction', 'totalCost', 'salesforceCase', 'salesforceCaseUrl'])");
    const ov = src.indexOf("overlayDeepScanFields(payload.rows || [], _cur);");
    const refresh = src.indexOf("refreshFleetFacts(payload.rows || [], _xf)", ov);
    const save = src.indexOf("store.save('fleetData', payload);", ov);
    expect(refresh).toBeGreaterThan(ov);
    expect(save).toBeGreaterThan(refresh);
  });
  it('PM fill: {all, now}, extended _hasPm, refreshRowFacts per overlaid row before the save', () => {
    expect(src).toContain("mapper.pmDueFields(full, xf.enabled ? { all: true, now: Date.now() } : undefined)");
    expect(src).toContain("|| pmRaw.semiannualLiftDue || (Array.isArray(pmRaw.pmSchedule) && pmRaw.pmSchedule.length);");
    const ap = src.indexOf('const _applyToStore = () => {');
    const rr = src.indexOf('woFacts.refreshRowFacts(row, xf);', ap);
    const save = src.indexOf("store.save('fleetData', cur);", ap);
    expect(rr).toBeGreaterThan(ap);
    expect(save).toBeGreaterThan(rr);
  });
  it('DOM table: an ellipsized Last geofences cell reads its title (§15.4)', () => {
    expect(src).toContain("if (h[i] === 'Last geofences' && /(\\.\\.\\.|\\u2026)$/.test(txt)) {");
    expect(src).toContain('if (tt.length > txt.length - 3) txt = tt;');
  });
});

describe('idempotence', () => {
  it('refreshRowFacts(refreshRowFacts(row)) deep-equals refreshRowFacts(row)', () => {
    const flags = { enabled: true, aiOutput: true };
    const once = woFacts.refreshRowFacts({ equipmentId: '39582', workRequestId: 'wr-39582', relayFacts: RF, relayFactsWr: 'wr-39582', offsiteFacts: OF,
      created: '2026-09-23T18:04:00.000Z', offsiteStageHistory: HIST }, flags, '2026-11-11');
    const snap = JSON.parse(JSON.stringify(once));
    expect(JSON.parse(JSON.stringify(woFacts.refreshRowFacts(once, flags, '2026-11-11')))).toEqual(snap);
  });
});
