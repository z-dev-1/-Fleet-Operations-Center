// tests/carrier-intel-gaps.test.js — carrier-intel design B9: the gap catalog. AC-23, AC-24
// (gap half), the G-DRIVER / G-CND variants, G-DSPHOLD on `why`, G-PMA, G-STALE, G-NOFACTS,
// G-FASID, cue vs data classification and order, the data-gap cap.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const C = require('../src/carrier-intel/context');
const Gp = require('../src/carrier-intel/gaps');
const Fx = require('../src/carrier-intel/facts');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const fleet = load('auvte-scac-rows.json');
const repairHistory = load('auvte-repair-history.json');
const TODAY = '2026-11-17';
const NOW = Date.parse('2026-11-17T18:00:00Z');
const ALL_CUES = { arrival: true, reassign: true, driver: true, cnd: true, symptom: true, dsp: true, uptime: true, why: true };

const built = (over = {}) => C.buildContext(Object.assign({
  scac: 'AUVTE', rows: fleet.rows, fleetRows: fleet.rows, stats: { total: 29, down: 7, uptime: 75.9 }, repairHistory,
  today: TODAY, now: NOW, cues: {}, userMsg: 'AUVTE trends', fd: fleet, fasAlias: '',
}, over));
const AUVTE = built();
const sel = (cues, model = AUVTE.model, fd = fleet, now = NOW) => Gp.selectGaps({ cues, model, stats: model.stats, fd, now }).gaps;
const gap = (gaps, id) => (gaps.find((g) => g.id === id) || {}).text;

describe('AC-24 G-ARRIVAL from computed values', () => {
  it('n = 4, median 6.2 h, range 3.8 h to 34.3 h on the AUVTE fixture; the roll-up line carries the same figures', () => {
    const recs = AUVTE.model.records;
    const ids = ['B12195', 'B12263', 'B12267', 'B62059'];
    expect(ids.map((id) => recs.find((r) => r.id === id).arrival.hours)).toEqual([34.3, 4.0, 3.8, 8.4]);
    const t = gap(sel({ arrival: true }), 'G-ARRIVAL');
    expect(t).toBe(Gp.GAP_TEXT['G-ARRIVAL'].replace('{n}', '4').replace('{median}', '6.2').replace('{min}', '3.8').replace('{max}', '34.3'));
    expect(t).toContain('on 4 unit(s)');
    expect(t).toContain('median 6.2 h, range 3.8 h to 34.3 h');
    const line = AUVTE.model.rollupText.split('\n').find((l) => l.startsWith('tech arrival ('));
    expect(line).toContain('n = 4');
    expect(line).toContain('median 6.2 h · range 3.8 h to 34.3 h');
  });
  it('cue uptime adds the trigger only when a record has an arrival', () => {
    expect(gap(sel({ uptime: true }), 'G-ARRIVAL')).toBeTruthy();
    const model = Object.assign({}, AUVTE.model, { records: AUVTE.model.records.map((r) => Object.assign({}, r, { arrival: null })) });
    expect(gap(sel({ uptime: true }, model), 'G-ARRIVAL')).toBeUndefined();
  });
  it('n = 0 template has no hour figure', () => {
    const model = Object.assign({}, AUVTE.model, { records: AUVTE.model.records.map((r) => Object.assign({}, r, { arrival: null })) });
    const t = gap(sel({ arrival: true }, model), 'G-ARRIVAL');
    expect(t).toBe(Gp.GAP_TEXT['G-ARRIVAL-NONE'].replace('{SCAC}', 'AUVTE'));
    expect(t).not.toMatch(/\d+(?:\.\d+)?\s*h\b/);
  });
  it("'wr'-basis arrivals are left out of n, median and range; their record line says 'from WR creation'", () => {
    const recs = AUVTE.model.records.map((r) => (r.id === 'B12195' ? Object.assign({}, r, { arrival: Object.assign({}, r.arrival, { basis: 'wr' }) }) : r));
    expect(Gp.arrivalStats(recs)).toEqual({ n: 3, median: '4.0', min: '3.8', max: '8.4' });
    const t = gap(sel({ arrival: true }, Object.assign({}, AUVTE.model, { records: recs })), 'G-ARRIVAL');
    expect(t).toContain('on 3 unit(s)');
    expect(t).not.toContain('34.3');
    expect(Fx.renderRecord(recs.find((r) => r.id === 'B12195'))).toMatch(/tech arrival: tech on site .* · 34\.3 h from WR creation \(no vendor assignment recorded\)/);
  });
});

describe('cue gaps', () => {
  it('AC-23 G-REASSIGN is the verbatim catalog line', () => {
    expect(gap(sel({ reassign: true }), 'G-REASSIGN')).toBe(Gp.GAP_TEXT['G-REASSIGN']);
    expect(gap(sel({}), 'G-REASSIGN')).toBeUndefined();
  });
  it('G-DRIVER hits variant quotes "10/5 B62053: …" itself and points nowhere else', () => {
    const t = gap(sel({ driver: true }), 'G-DRIVER');
    expect(t.startsWith('Driver-reported conditions (cold start, after fueling, under load) aren\'t structured fields. Free-text mentions: ')).toBe(true);
    expect(t).toContain('"10/5 B62053: ');
    expect(t).toMatch(/"10\/5 B62053: [^"]*after fueling/);
    expect(t).not.toContain('Trends');
  });
  it('G-DRIVER no-hits variant', () => {
    const model = Object.assign({}, AUVTE.model, { themes: { hits: {} } });
    expect(gap(sel({ driver: true }, model), 'G-DRIVER')).toBe(Gp.GAP_TEXT['G-DRIVER-NONE'].replace('{SCAC}', 'AUVTE'));
  });
  it('G-CND no-hits variant adds the nearest "system OK" finding', () => {
    expect(gap(sel({ cnd: true }), 'G-CND')).toBe('"Could not duplicate" doesn\'t appear in AUVTE\'s current conversations or repair summaries. The nearest is a vendor "system OK"-type finding on B62059.');
    const model = Object.assign({}, AUVTE.model, { themes: { hits: { 'could not duplicate': [{ id: 'B12271', date: '2026-11-10', quote: 'could not duplicate' }, { id: 'B12271', date: '2026-11-09', quote: 'x' }] } } });
    expect(gap(sel({ cnd: true }, model), 'G-CND')).toBe('"Could not duplicate"-type outcomes appear on 1 unit(s): B12271.');
  });
  it('G-SYMPTOM on cue symptom', () => {
    expect(gap(sel({ symptom: true }), 'G-SYMPTOM')).toBe(Gp.GAP_TEXT['G-SYMPTOM']);
  });
  it('G-DSPHOLD on cue dsp, or on uptime / why with a DSP-managed unit', () => {
    expect(gap(sel({ why: true }), 'G-DSPHOLD')).toBe(Gp.GAP_TEXT['G-DSPHOLD']);
    expect(gap(sel({ uptime: true }), 'G-DSPHOLD')).toBe(Gp.GAP_TEXT['G-DSPHOLD']);
    expect(gap(sel({ dsp: true }), 'G-DSPHOLD')).toBe(Gp.GAP_TEXT['G-DSPHOLD']);
    const noDsp = Object.assign({}, AUVTE.model, { records: AUVTE.model.records.filter((r) => r.owner !== 'DSP') });
    expect(gap(sel({ why: true }, noDsp), 'G-DSPHOLD')).toBeUndefined();
    expect(gap(sel({}), 'G-DSPHOLD')).toBeUndefined();
  });
});

describe('data gaps', () => {
  it('G-NOFACTS names only B62064 on the fixture', () => {
    expect(gap(sel({}), 'G-NOFACTS')).toBe('1 unit(s) have no extracted Relay facts yet (B62064); their lines use AAP fields only.');
  });
  it('G-FASID only without a cached alias', () => {
    expect(gap(sel({}), 'G-FASID')).toBe(Gp.GAP_TEXT['G-FASID']);
    expect(gap(sel({}, built({ fasAlias: 'fasuser6' }).model), 'G-FASID')).toBeUndefined();
  });
  it('G-PMA: each half only when its count is > 0', () => {
    expect(gap(sel({}), 'G-PMA')).toBe('AAP shows PM A overdue on 3 unit(s) that completed a later PM B/X. These look like stale AAP schedules, not missed PMs.');
    const cb = new Map([['pmaStale', 9], ['washStale', 4]]);
    expect(gap(sel({}, Object.assign({}, AUVTE.model, { countBy: cb, washLast: '9/23/2023' })), 'G-PMA'))
      .toBe('AAP shows PM A overdue on 9 unit(s) that completed a later PM B/X, and Wash overdue on 4 unit(s) last recorded 9/23/2023. These look like stale AAP schedules, not missed PMs.');
    expect(gap(sel({}, Object.assign({}, AUVTE.model, { countBy: new Map([['washStale', 4]]), washLast: null })), 'G-PMA'))
      .toBe('AAP shows Wash overdue on 4 unit(s). These look like stale AAP schedules, not missed PMs.');
    expect(gap(sel({}, Object.assign({}, AUVTE.model, { countBy: new Map() })), 'G-PMA')).toBeUndefined();
  });
  it('G-STALE from fd.syncedAt older than 4 h, whole hours; missing / unparseable -> none', () => {
    const six = Date.parse(fleet.syncedAt) + 6.5 * 3600 * 1000;
    expect(gap(sel({}, AUVTE.model, fleet, six), 'G-STALE')).toBe('\u26a0 Fleet data is 6 h old.');
    expect(gap(sel({}, AUVTE.model, fleet, Date.parse(fleet.syncedAt) + 3 * 3600 * 1000), 'G-STALE')).toBeUndefined();
    expect(gap(sel({}, AUVTE.model, {}, six), 'G-STALE')).toBeUndefined();
    expect(gap(sel({}, AUVTE.model, { syncedAt: 'nope' }, six), 'G-STALE')).toBeUndefined();
  });
  it('G-FILTER when the box-truck filter matched nothing', () => {
    const rows = fleet.rows.map((r) => Object.assign({}, r, { assetType: 'van', bodyType: 'Van' }));
    const b = built({ rows, fleetRows: rows, assetFilter: 'boxTruck' });
    expect(gap(b.gaps, 'G-FILTER')).toBe('No AUVTE units are tagged box truck, so this covers all AUVTE units.');
    expect(b.model.records.length).toBe(7);
    expect(gap(built({ assetFilter: 'boxTruck' }).gaps, 'G-FILTER')).toBeUndefined();
  });
});

describe('classification, order and caps', () => {
  it('render order: G-STALE, G-FASID, cue gaps in table order, remaining data gaps; all six cue gaps kept', () => {
    const stale = Date.parse(fleet.syncedAt) + 6 * 3600 * 1000;
    const gaps = sel(ALL_CUES, AUVTE.model, fleet, stale);
    expect(gaps.map((g) => g.id)).toEqual(['G-STALE', 'G-FASID', 'G-ARRIVAL', 'G-REASSIGN', 'G-DRIVER', 'G-CND', 'G-SYMPTOM', 'G-DSPHOLD', 'G-NOFACTS', 'G-PMA']);
    expect(gaps.filter((g) => g.kind === 'cue').map((g) => g.id)).toEqual(Gp.CUE_ORDER.slice());
    expect(gaps.filter((g) => g.kind === 'data').length).toBeLessThanOrEqual(Gp.DATA_GAPS_MAX);
  });
  it('cue gaps are never capped; data gaps are capped at 6', () => {
    expect(Gp.CUE_ORDER.length).toBe(6);
    expect(Gp.DATA_ORDER).toEqual(['G-STALE', 'G-FASID', 'G-NOFACTS', 'G-NODETAIL', 'G-FILTER', 'G-PMA']);
    expect(Gp.DATA_GAPS_MAX).toBe(6);
  });
  it('quotes in gap lines are defanged', () => {
    const model = Object.assign({}, AUVTE.model, { themes: { hits: { 'after fueling': [{ id: 'B62053', date: '2026-10-05', quote: 'dies after fueling <!channel>' }] } } });
    const t = gap(sel({ driver: true }, model), 'G-DRIVER');
    expect(t).not.toContain('<!channel>');
    expect(t).toContain('"10/5 B62053: dies after fueling @');
  });
});
