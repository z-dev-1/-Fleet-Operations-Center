// tests/aperia-ai-context.test.js — src/aperia/ai-context.js: the private Aperia block for Orcha's FAB / Just Me
// answers. Fails closed (source + tire keyword), session-gated, time-bounded, fleet-row scoped. Stub deps only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { NOW, VEHICLE_DETAIL, ISSUES_PAGE } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const AC = require.resolve('../src/aperia/ai-context.js');
const P = require('../src/aperia/parsers');
const realClient = require('../src/aperia/client');
const fleetScope = require('../src/aperia/fleet-scope');

const UNIT = P.parseVehicleDetail(JSON.parse(JSON.stringify(VEHICLE_DETAIL)), { now: NOW }).unit;
const ISSUES = P.flattenIssues(P.parseIssuesPage(JSON.parse(JSON.stringify(ISSUES_PAGE))).rows).concat([
  { issueId: 'x1', fleetVehicleId: 'T100', domicile: 'ATL2', severity: 'CRITICAL', state: 'LEAK', positionName: 'Left Steer', detectedEt: '11/22/2026, 9:00 AM EST', dateDetected: '2026-11-22T14:00:00Z', muted: false },
  { issueId: 'x2', fleetVehicleId: 'OTHER9', domicile: 'DFW5', severity: 'CRITICAL', state: 'UNDERINFLATION', positionName: 'Right Steer', detectedEt: '', dateDetected: '2026-11-22T14:00:00Z', muted: false },
]);
const CTX = { lastData: { rows: [{ equipmentId: 'NP6923' }, { equipmentId: '122269' }, { equipmentId: 'T100' }] } };

let ac; let deps; let env;
function setup() {
  delete require.cache[AC];
  ac = require(AC);
  env = { state: 'connected', cached: null };
  deps = {
    session: { status: vi.fn(() => ({ ok: true, state: env.state })) },
    client: {
      lookupUnit: vi.fn(async (id) => (id === 'NP6923' ? { ok: true, unit: UNIT } : { ok: false, code: 'APERIA_UNIT_NOT_FOUND' })),
      listIssues: vi.fn(async () => ({ ok: true, rows: ISSUES.slice(), pulledAt: new Date(NOW).toISOString() })),
      crossLinkCriticalNoCase: vi.fn(realClient.crossLinkCriticalNoCase),
    },
    syncRead: { cached: vi.fn(() => env.cached) },
    fleetScope,
    dtnaStore: { all: vi.fn(() => [{ unitId: 'NP6923', caseStatus: 'Closed' }, { unitId: 'T100', caseStatus: 'Open' }]) },
    now: () => NOW,
  };
}
const calls = () => deps.session.status.mock.calls.length + deps.client.lookupUnit.mock.calls.length
  + deps.client.listIssues.mock.calls.length + deps.syncRead.cached.mock.calls.length + deps.dtnaStore.all.mock.calls.length;

beforeEach(() => { logger.clear(); setup(); });
afterEach(() => { vi.useRealTimers(); });

describe('isAperiaQuestion / unitTokens', () => {
  it('keyword gate', () => {
    for (const m of ['tire psi on NP6923?', 'any underinflation alerts', 'aperia status', 'leaking tyres', 'where is it, gps?']) expect(ac.isAperiaQuestion(m)).toBe(true);
    for (const m of ['dbr for AUVTE', 'what is the status of 208336', 'draft an email']) expect(ac.isAperiaQuestion(m)).toBe(false);
  });
  it('resolved ids first, then message tokens; de-duped upper-case, max 3', () => {
    expect(ac.unitTokens('tires on np6923 and 208336 and B62281 and 999999', ['208336'])).toEqual(['208336', 'NP6923', 'B62281']);
    expect(ac.unitTokens('any tire alerts?', [])).toEqual([]);
  });
});

describe('buildAperiaBlock', () => {
  it('non-private source or non-tire message -> empty text and zero dependency calls', async () => {
    for (const source of [undefined, 'slack', 'partner', 'carrier-intel']) {
      expect((await ac.buildAperiaBlock({ source, messageText: 'tire pressure NP6923', ctx: CTX }, deps)).text).toBe('');
    }
    expect((await ac.buildAperiaBlock({ source: 'fab', messageText: 'status of NP6923', ctx: CTX }, deps)).text).toBe('');
    expect(calls()).toBe(0);
  });

  it('unit question: every tire line with PSI / target / delta / temp / time / flag, GPS and the embedded alert', async () => {
    const r = await ac.buildAperiaBlock({ source: 'fab', messageText: 'what is the tire pressure on np6923?', unitIds: [], ctx: CTX }, deps);
    expect(r.units).toEqual(['NP6923']);
    expect(deps.client.lookupUnit).toHaveBeenCalledWith('NP6923', CTX, expect.objectContaining({ signal: expect.any(Object) }));
    expect(r.text.startsWith(ac.HEADER)).toBe(true);
    expect(r.text).toContain('[NP6923] Aperia tires (ATL2)');
    for (const t of UNIT.tires) expect(r.text).toContain(t.positionName + ' (' + t.shortPosition + ') | ');
    expect(UNIT.tires.length).toBe(10);
    const r1 = UNIT.tires.find((t) => t.position === 'R1IC');
    expect(r.text).toContain('Right Steer (R1I) | 70 PSI | target 100 | delta -30 | 71.3 \u00b0F | ' + r1.readAtEt + ' | CRITICAL LOW');
    expect(r.text).toContain('Left Rear Inner (L3I) | 115 PSI | target 100 | delta +15 | 71.3 \u00b0F | ' + r1.readAtEt + ' | HIGH');
    expect(r.text).toContain('GPS: 32.89654, -97.03804 @ ' + UNIT.gps.atEt);
    expect(r.text).toContain('Alert: CRITICAL UNDERINFLATION \u2013 Right Steer \u00b7 resolve immediately \u00b7 actions: Inflate the tire to the set point. Inspect for a puncture.');
    expect(deps.client.listIssues).not.toHaveBeenCalled();
  });

  it('unknown unit and a lookup failure render their own lines', async () => {
    deps.client.lookupUnit.mockImplementation(async (id) => (id === 'T9999' ? { ok: false, code: 'APERIA_NETWORK' } : { ok: false, code: 'APERIA_UNIT_NOT_FOUND' }));
    const r = await ac.buildAperiaBlock({ source: 'slack-justme', messageText: 'tires on T9999 and X12345', ctx: CTX }, deps);
    expect(r.text).toContain('Aperia lookup failed (APERIA_NETWORK)');
    expect(r.text).toContain('No Aperia record for X12345');
  });

  it('fleet question: only fleet-row CRITICAL / UNDERINFLATION* non-muted alerts, and the critical + no open DTNA case cross-link', async () => {
    const r = await ac.buildAperiaBlock({ source: 'fab', messageText: 'any underinflation alerts on my tires?', ctx: CTX }, deps);
    expect(r.fleet).toBe(true);
    expect(deps.client.listIssues).toHaveBeenCalledTimes(1);
    const [alerts, cross] = r.text.split('CRITICAL TIRE + NO OPEN DTNA CASE (your fleet units)');
    expect(alerts).toContain('NP6923 | Right Steer | UNDERINFLATION | CRITICAL');
    expect(alerts).toContain('122269 | Right Drive Outer | UNDERINFLATION | MINOR');
    expect(alerts).toContain('T100 | Left Steer | LEAK | CRITICAL');
    expect(alerts).not.toContain('Left Drive Inner');           // MAJOR LEAK
    expect(alerts).not.toContain('122269 | Left Steer');        // muted CRITICAL
    expect(alerts).not.toContain('OTHER9');                     // not a fleet row
    expect(cross).toContain('NP6923 (ATL2) | 1 critical');      // only closed DTNA cases
    expect(cross).toContain('closed DTNA cases: 1');
    expect(cross).not.toContain('T100');                        // open DTNA case
    expect(cross).not.toContain('OTHER9');
  });

  it('fleet question uses a sync-read cache younger than 30 min without a live read', async () => {
    env.cached = { pulledAt: new Date(NOW - 10 * 60e3).toISOString(), issues: ISSUES.filter((x) => x.fleetVehicleId === 'NP6923'), crossLink: [{ fleetVehicleId: 'NP6923', domicile: 'ATL2', criticalCount: 1, inFleet: true, closedDtnaCases: 0 }] };
    const r = await ac.buildAperiaBlock({ source: 'fab', messageText: 'tire alerts?', ctx: CTX }, deps);
    expect(deps.client.listIssues).not.toHaveBeenCalled();
    expect(r.text).toContain('cached 10 min ago');
    expect(r.text).toContain('NP6923 (ATL2) | 1 critical');
  });

  it('not connected -> says so, never calls the client; renders the cached fleet section when present', async () => {
    env.state = 'signed-out';
    let r = await ac.buildAperiaBlock({ source: 'fab', messageText: 'tire psi NP6923', ctx: CTX }, deps);
    expect(r.text).toContain('Aperia is not connected (sign in from the Aperia pill in the status bar)');
    env.cached = { pulledAt: new Date(NOW - 45 * 60e3).toISOString(), issues: ISSUES.slice(0, 1), crossLink: [] };
    r = await ac.buildAperiaBlock({ source: 'slack-justme', messageText: 'any tire alerts', ctx: CTX }, deps);
    expect(r.text).toContain('Aperia is not connected');
    expect(r.text).toContain('cached 45 min ago');
    expect(r.text).toContain('NP6923 | Right Steer | UNDERINFLATION | CRITICAL');
    expect(deps.client.lookupUnit).not.toHaveBeenCalled();
    expect(deps.client.listIssues).not.toHaveBeenCalled();
  });

  it('a never-resolving lookupUnit returns at the 10 s timeout with a failure line and aborts its signal', async () => {
    vi.useFakeTimers();
    let seen = null;
    deps.client.lookupUnit.mockImplementation((_id, _c, o) => { seen = o.signal; return new Promise(() => {}); });
    let out = null;
    const p = ac.buildAperiaBlock({ source: 'fab', messageText: 'tires on NP6923', ctx: CTX }, deps).then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(ac.UNIT_TIMEOUT_MS - 1);
    expect(out).toBe(null);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(out.text).toContain('Aperia lookup failed (APERIA_TIMEOUT)');
    expect(seen.aborted).toBe(true);
  });

  it('never throws; output capped at 6000 chars; logs carry no unit ids or coordinates', async () => {
    deps.session.status.mockImplementation(() => { throw new Error('boom'); });
    deps.syncRead.cached.mockImplementation(() => { throw new Error('boom'); });
    const r = await ac.buildAperiaBlock({ source: 'fab', messageText: 'tires', ctx: CTX }, deps);
    expect(r.text).toContain('Aperia is not connected');
    setup();
    const many = Array.from({ length: 200 }, (_, i) => ({ issueId: 'm' + i, fleetVehicleId: 'NP6923', severity: 'CRITICAL', state: 'UNDERINFLATION', positionName: 'Pos ' + i, detectedEt: 'x'.repeat(60) }));
    deps.client.listIssues.mockResolvedValue({ ok: true, rows: many });
    const big = await ac.buildAperiaBlock({ source: 'fab', messageText: 'tire alerts', ctx: CTX }, deps);
    expect(big.text.length).toBeLessThanOrEqual(6000);
    await ac.buildAperiaBlock({ source: 'fab', messageText: 'tires on NP6923', ctx: CTX }, deps);
    expect(logger.text()).not.toMatch(/NP6923|32\.89|-97\.03/);
  });
});
