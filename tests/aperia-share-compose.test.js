// tests/aperia-share-compose.test.js — src/aperia/share-compose.js + src/aperia/geocode.js: the share
// message carries only the alerted tire's facts (+ street address when resolvable), never coordinates,
// '$' or another tire; AI output that breaks a rule falls back to the deterministic line.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { VEHICLE_DETAIL, NOW } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const P = require('../src/aperia/parsers');
const SC = require('../src/aperia/share-compose');
const G = require('../src/aperia/geocode');

const COORD = /-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/;
const unit = () => P.parseVehicleDetail(JSON.parse(JSON.stringify(VEHICLE_DETAIL)), { now: NOW }).unit;
const ALERT = { id: '9001', severity: 'CRITICAL', fleetVehicleId: 'NP6923', state: 'UNDERINFLATION', positionName: 'Right Steer', vehicleId: '104' };
const ADDRESS = '1 Sentinel Way, Testville, PA 18000';

beforeEach(() => { logger.clear(); });

describe('isShareable', () => {
  it('only UNDERINFLATION and UNDERINFLATION_AND_LEAK (case/space normalized)', () => {
    for (const s of ['UNDERINFLATION', 'UNDERINFLATION_AND_LEAK', 'underinflation', 'Underinflation and leak', ' UNDERINFLATION AND  LEAK ']) expect(SC.isShareable(s), s).toBe(true);
    for (const s of ['LEAK', 'HIGH_TEMP', 'OVERINFLATION', 'UNDERINFLATION_AND', '', null, undefined, 'SENSOR_FAULT', 'CRITICAL_UNDERINFLATION']) expect(SC.isShareable(s), String(s)).toBe(false);
  });
});

describe('alertFacts', () => {
  it('picks the alerted tire by issue id and keeps only its fields', () => {
    const f = SC.alertFacts(unit(), ALERT);
    expect(f).toMatchObject({
      unit: 'NP6923', positionName: 'Right Steer', shortPosition: 'R1I', pressure: 70, setPoint: 100, deltaPsi: -30,
      state: 'UNDERINFLATION', severity: 'CRITICAL', resolveBy: 'immediately',
    });
    expect(f.actions[0]).toBe('Inflate the tire to the set point.');
    expect(f.otherTires).toContain('Right Steer Outer');
    expect(f.otherTires).toContain('L3I');
    expect(f.otherTires).not.toContain('Right Steer');
    expect(Object.keys(f).sort()).toEqual(['actions', 'deltaPsi', 'otherTires', 'positionName', 'pressure', 'resolveBy', 'setPoint', 'severity', 'shortPosition', 'state', 'unit']);
  });

  it('falls back to position, then positionName; state/severity from the detail issue when the alert lacks them', () => {
    const u = unit();
    const byPos = SC.alertFacts(u, { id: 'zzz', position: 'R1IC' });
    expect(byPos.positionName).toBe('Right Steer');
    expect(byPos.state).toBe('UNDERINFLATION');
    expect(byPos.severity).toBe('CRITICAL');
    expect(SC.alertFacts(u, { id: 'zzz', positionName: 'right steer outer' }).pressure).toBe(80);
  });
});

describe('prompt and fallback', () => {
  it('the prompt has the alert fields and the address, and no coordinates or other tires', () => {
    const f = SC.alertFacts(unit(), ALERT);
    const p = SC.buildPrompt(f, ADDRESS);
    for (const s of ['NP6923', 'Right Steer', '70 PSI', '100 PSI', '-30 PSI', 'UNDERINFLATION', 'CRITICAL', 'immediately', 'Inflate the tire', ADDRESS]) expect(p).toContain(s);
    expect(p).not.toMatch(COORD);
    expect(p).not.toContain('32.89');
    for (const o of ['Right Steer Outer', 'Left Rear Inner', 'Right Drive Inner', 'L3I']) expect(p).not.toContain(o);
    expect(SC.buildPrompt(f, null)).not.toContain('Location:');
  });

  it('fallback text is deterministic with and without the address', () => {
    const f = SC.alertFacts(unit(), ALERT);
    expect(SC.fallbackText(f, null)).toBe('\u{1F6DE} NP6923 \u2014 Right Steer: 70 PSI vs 100 target (-30 PSI). UNDERINFLATION (CRITICAL). Action: Inflate the tire to the set point (resolve immediately).');
    expect(SC.fallbackText(f, ADDRESS)).toBe(SC.fallbackText(f, null) + ' Location: ' + ADDRESS + '.');
    expect(SC.validate(SC.fallbackText(f, ADDRESS), f)).toBe(true);
  });

  it('validate rejects coords, $, another tire, missing position, empty and too long', () => {
    const f = SC.alertFacts(unit(), ALERT);
    const ok = 'NP6923 Right Steer is at 70 PSI vs 100 target. Inflate it immediately.';
    expect(SC.validate(ok, f)).toBe(true);
    expect(SC.validate(ok + ' GPS 40.62660, -75.44570', f)).toBe(false);
    expect(SC.validate(ok + ' Cost about $40.', f)).toBe(false);
    expect(SC.validate(ok + ' Right Steer Outer is fine.', f)).toBe(false);
    expect(SC.validate(ok + ' Check L3I too.', f)).toBe(false);
    expect(SC.validate('NP6923 tire is low.', f)).toBe(false);
    expect(SC.validate('', f)).toBe(false);
    expect(SC.validate(ok + 'x'.repeat(700), f)).toBe(false);
  });
});

describe('compose', () => {
  it('uses valid AI text (string or { text }) via askWithTimeout options', async () => {
    const f = SC.alertFacts(unit(), ALERT);
    const ai = 'NP6923 Right Steer is at 70 PSI against a 100 PSI target. Inflate it to the set point immediately. It is near ' + ADDRESS + '.';
    const ask = vi.fn(async () => ai);
    expect(await SC.compose(f, ADDRESS, { ask })).toEqual({ text: ai, aiWritten: true });
    expect(ask.mock.calls[0][1]).toEqual({ timeoutMs: 30000, timeoutResult: '', source: 'aperia_share' });
    expect(ask.mock.calls[0][0]).toContain(ADDRESS);
    expect(await SC.compose(f, null, { ask: async () => ({ text: 'Right Steer low on NP6923, 70 vs 100 PSI.' }) })).toEqual({ text: 'Right Steer low on NP6923, 70 vs 100 PSI.', aiWritten: true });
  });

  it('AI text with coordinates, another tire, empty or a throw -> fallback', async () => {
    const f = SC.alertFacts(unit(), ALERT);
    for (const ask of [
      async () => 'NP6923 Right Steer low at 40.62660, -75.44570.',
      async () => 'NP6923 Right Steer low; Left Rear Inner also high.',
      async () => '',
      async () => { throw new Error('AI down'); },
    ]) {
      const r = await SC.compose(f, null, { ask });
      expect(r).toEqual({ text: SC.fallbackText(f, null), aiWritten: false });
    }
  });
});

describe('geocode wrapper', () => {
  it('formats locLabel or street/city/state zip; never logs coordinates or address', async () => {
    const rg = vi.fn(async () => ({ locLabel: ADDRESS }));
    expect(await G.reverseGeocode(40.6266, -75.4457, {}, { reverseGeocodeGps: rg })).toBe(ADDRESS);
    expect(rg).toHaveBeenCalledWith(40.6266, -75.4457);
    expect(await G.reverseGeocode(40.6266, -75.4457, {}, { reverseGeocodeGps: async () => ({ locStreet: '1 Sentinel Way', locCity: 'Testville', locState: 'PA', locZip: '18000' }) })).toBe(ADDRESS);
    expect(logger.text()).not.toContain('40.6266');
    expect(logger.text()).not.toContain('Sentinel');
    expect(logger.lines.some((l) => l.args[0] === '[aperia] share' && l.args[1].op === 'geocode' && l.args[1].ok === true)).toBe(true);
  });

  it('invalid, 0,0 and the placeholder point -> null with no geocoder call', async () => {
    const rg = vi.fn(async () => ({ locLabel: ADDRESS }));
    for (const [a, b] of [[NaN, 1], [0, 0], [-11.11111, 11.11111], [null, null], ['x', 'y']]) expect(await G.reverseGeocode(a, b, {}, { reverseGeocodeGps: rg })).toBe(null);
    expect(rg).not.toHaveBeenCalled();
  });

  it('null result, throw, or timeout -> null; compose then omits the location entirely', async () => {
    vi.useFakeTimers();
    try {
      expect(await G.reverseGeocode(40.6, -75.4, {}, { reverseGeocodeGps: async () => null })).toBe(null);
      expect(await G.reverseGeocode(40.6, -75.4, {}, { reverseGeocodeGps: async () => { throw new Error('HERE 401'); } })).toBe(null);
      const p = G.reverseGeocode(40.6, -75.4, { timeoutMs: 8000 }, { reverseGeocodeGps: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(8000);
      expect(await p).toBe(null);
    } finally { vi.useRealTimers(); }
    const f = SC.alertFacts(unit(), ALERT);
    const r = await SC.compose(f, null, { ask: async () => '' });
    expect(r.text).not.toContain('Location');
    expect(r.text).not.toMatch(COORD);
  });
});
