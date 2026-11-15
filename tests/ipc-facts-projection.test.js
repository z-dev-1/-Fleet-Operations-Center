// tests/ipc-facts-projection.test.js — relay-extract §12.5 / AC38: renderer IPC results
// never carry the fact blocks. aap-api:refresh-unit returns rendererRow(refreshRowFacts(row))
// (mirrors kept); relay:refresh-unit returns projected unit + cache while the stored
// fleetData row and relayCache[id] keep the blocks; app.js _pushData sends
// rendererView(d) on fleet:data (static check, Electron-bound module). Flag off: rows pass
// through unchanged (AC24).
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
const tmpDir = path.join(os.tmpdir(), 'ipc-facts-projection-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

const handlers = {};
function injectFake(rel, exportsObj) {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow: function () {}, session: {} });
const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const relay = require('../src/scrapers/relay');
const mapper = require('../src/scrapers/aap_api_mapper');
const X = require('../src/repair-intel/wo-extract');
const woFacts = require('../src/repair-intel/wo-facts');
const pushed = [];
const ctx = { pushData: (d) => pushed.push(d), lastData: null };
require('../src/ipc/aap-api').registerAapApiIPC(ctx);
require('../src/ipc/scrapers').registerScrapersIPC(ctx);
const call = (ch, ...args) => handlers[ch]({}, ...args);

const NOW = Date.parse('2026-11-11T15:00:00Z');
const RF = mapper.toFleetRow({ id: 'svc-39582', workRequestId: 'wr-39582', assetDisplayName: '39582', vendor: 'VOLVO',
  scheduledDateTime: Date.parse('2026-09-23T18:04:00Z') }, null, R39.serviceDetail, { extract: { enabled: true }, now: NOW });
const OF = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', wrCreatedAt: N.WR_CREATED_AT, now: NOW });

beforeEach(() => { pushed.length = 0; ctx.lastData = null; delete process.env.FLEET_EXTRACT; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.FLEET_EXTRACT; });

describe('aap-api:refresh-unit (AC38)', () => {
  it('returns mirrors but no relayFacts/offsiteFacts', async () => {
    vi.spyOn(aap, 'refreshUnit').mockResolvedValue(Object.assign({}, RF, { offsiteFacts: OF }));
    const r = await call('aap-api:refresh-unit', { unit: '39582' });
    expect(r.ok).toBe(true);
    expect('relayFacts' in r.row).toBe(false);
    expect('offsiteFacts' in r.row).toBe(false);
    expect(r.row.partNumbers).toBe('85152780');
    expect(r.row.repairEtc).toBe('2026-11-11');
  });
  it('flag off: the refreshUnit row comes back unchanged', async () => {
    process.env.FLEET_EXTRACT = '0';
    const row = { equipmentId: '1', vendor: 'TA' };
    vi.spyOn(aap, 'refreshUnit').mockResolvedValue(row);
    const r = await call('aap-api:refresh-unit', { unit: '1' });
    expect(r.row).toBe(row);
    expect(r.row).toEqual({ equipmentId: '1', vendor: 'TA' });
  });
});

describe('relay:refresh-unit (AC38)', () => {
  it('unit and cache projected; stored fleetData row and relayCache keep the blocks', async () => {
    store.save('fleetData', { rows: [{ equipmentId: '39582', workRequestId: 'wr-39582', created: '2026-09-23T18:04:00.000Z' }] });
    store.save('relayCache', {});
    const entry = { workRequestId: 'wr-39582', vendor: 'Volvo (ASIST)', relayFacts: RF.relayFacts, relayFactsWr: 'wr-39582',
      offsiteFacts: OF, asistNotes: 'x', asistScrapedAt: '2026-11-11T10:00:00Z', _cachedAt: Date.now() };
    vi.spyOn(relay, 'scrapeUnitPage').mockResolvedValue(entry);
    const r = await call('relay:refresh-unit', '39582', { reconcile: false, rebuildTimeline: false });
    expect(r.ok).toBe(true);
    for (const k of ['relayFacts', 'offsiteFacts']) {
      expect(k in r.unit).toBe(false);
      expect(k in r.cache).toBe(false);
    }
    expect(r.unit.partNumbers).toBe('85152780');
    const saved = store.load('fleetData', {}).rows[0];
    expect(saved.relayFacts.v).toBe(2);
    expect(saved.offsiteFacts.v).toBe(2);
    expect(store.load('relayCache', {})['39582'].relayFacts.v).toBe(2);
    // The partial push is the full row; _pushData projects it (see the static check below).
    expect(pushed[0].partialMerge).toBe(true);
  });
});

describe('app.js _pushData (static, Electron-bound)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const body = src.slice(src.indexOf('function _pushData(d)'), src.indexOf('function _pushData(d)') + 2500);
  it('fleet:data gets rendererView(d) with a fallback to d; the hooks keep d', () => {
    expect(body).toContain("_view = require('./repair-intel/wo-facts').rendererView(d)");
    expect(body).toContain("catch (_) { _view = d; }");
    expect(body).toContain("_send('fleet:data',   _view);");
    expect(body).not.toContain("_send('fleet:data',   d);");
    expect(body).toContain('briefing.process(rows, _send)');
    expect(body).toContain("const rows = (d && d.rows) || [];");
  });
  it('rendererView strips the blocks shallowly and leaves d untouched', () => {
    const d = { rows: [Object.assign({}, RF, { offsiteFacts: OF }), { equipmentId: 'plain' }], syncedAt: 'x' };
    const v = woFacts.rendererView(d);
    expect('relayFacts' in v.rows[0]).toBe(false);
    expect('offsiteFacts' in v.rows[0]).toBe(false);
    expect(v.rows[1]).toBe(d.rows[1]);
    expect(d.rows[0].relayFacts.v).toBe(2);
    const plain = { rows: [{ equipmentId: 'a' }] };
    expect(woFacts.rendererView(plain)).toBe(plain);
  });
});
