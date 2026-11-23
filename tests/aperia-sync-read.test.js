// tests/aperia-sync-read.test.js — src/aperia/sync-read.js: the sync cycle's Aperia issues read is
// session-gated, throttled to one successful read per 15 min, single-flight, and caches only the issues on
// fleet-row units plus the in-fleet "critical, no open DTNA case" cross-link. Fake session / client.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const SR = require.resolve('../src/aperia/sync-read.js');
const realClient = require('../src/aperia/client');

const ROWS = [
  { issueId: '1', fleetVehicleId: 'NP6923', domicile: 'ATL2', severity: 'CRITICAL', state: 'LEAK', muted: false, dateDetected: '2026-11-22T13:00:00Z' },
  { issueId: '2', fleetVehicleId: 'OTHER9', domicile: 'DFW5', severity: 'CRITICAL', state: 'LEAK', muted: false, dateDetected: '2026-11-22T12:00:00Z' },
  { issueId: '3', fleetVehicleId: '122269', domicile: 'DFW5', severity: 'MINOR', state: 'LEAK', muted: false, dateDetected: '2026-11-22T11:00:00Z' },
];
const FLEET = [{ equipmentId: 'np6923' }, { equipmentId: '122269' }];

let sr; let env; let session; let client; let dtnaStore;
function setup() {
  delete require.cache[SR];
  sr = require(SR);
  env = { now: Date.parse('2026-11-22T15:00:00Z'), state: 'connected' };
  session = { status: vi.fn(() => ({ ok: true, state: env.state })) };
  client = {
    listIssues: vi.fn(async () => ({ ok: true, rows: ROWS.slice(), pulledAt: '2026-11-22T15:00:00.000Z' })),
    crossLinkCriticalNoCase: vi.fn(realClient.crossLinkCriticalNoCase),
  };
  dtnaStore = { all: vi.fn(() => []) };
  sr._setDeps({ session, client, dtnaStore, now: () => env.now });
}

beforeEach(() => { logger.clear(); setup(); });

describe('aperia sync-read', () => {
  it('signed out -> no call, no cache', async () => {
    env.state = 'expired';
    expect(await sr.run({ rows: FLEET, ctx: {} })).toEqual({ skipped: 'signed-out' });
    expect(client.listIssues).not.toHaveBeenCalled();
    expect(sr.cached()).toBe(null);
  });

  it('connected -> one read; caches only fleet-row issues and the in-fleet cross-link', async () => {
    const ctx = { tag: 1 };
    expect(await sr.run({ rows: FLEET, ctx })).toEqual({ ok: true, issues: 2, critNoCase: 1 });
    expect(client.listIssues).toHaveBeenCalledWith(ctx);
    const c = sr.cached();
    expect(c.pulledAt).toBe('2026-11-22T15:00:00.000Z');
    expect(c.issues.map((r) => r.issueId)).toEqual(['1', '3']);
    expect(c.crossLink.map((r) => r.fleetVehicleId)).toEqual(['NP6923']);
    expect(c.crossLink.every((r) => r.inFleet)).toBe(true);
    c.issues.length = 0;
    expect(sr.cached().issues).toHaveLength(2);           // a copy
  });

  it('an open DTNA case hides the unit from the cross-link', async () => {
    dtnaStore.all.mockReturnValue([{ unitId: 'NP6923', caseStatus: 'Open' }]);
    await sr.run({ rows: FLEET });
    expect(sr.cached().crossLink).toEqual([]);
  });

  it('at most one read per 15 min after a success; a failure does not start the throttle', async () => {
    expect(sr.SYNC_READ_MIN_MS).toBe(15 * 60e3);
    client.listIssues.mockResolvedValueOnce({ ok: false, code: 'APERIA_HTTP' });
    expect(await sr.run({ rows: FLEET })).toEqual({ ok: false, code: 'APERIA_HTTP' });
    expect(sr.cached()).toBe(null);
    expect((await sr.run({ rows: FLEET })).ok).toBe(true);
    env.now += 14 * 60e3;
    expect(await sr.run({ rows: FLEET })).toEqual({ skipped: 'fresh' });
    expect(client.listIssues).toHaveBeenCalledTimes(2);
    env.now += 61e3;
    expect((await sr.run({ rows: FLEET })).ok).toBe(true);
    expect(client.listIssues).toHaveBeenCalledTimes(3);
  });

  it('single-flight: concurrent runs share one read', async () => {
    const a = sr.run({ rows: FLEET });
    const b = sr.run({ rows: FLEET });
    expect(a).toBe(b);
    await a;
    expect(client.listIssues).toHaveBeenCalledTimes(1);
  });

  it('no rows passed -> scope from ctx.lastData.rows', async () => {
    await sr.run({ ctx: { lastData: { rows: [{ equipmentId: 'OTHER9' }] } } });
    expect(sr.cached().issues.map((r) => r.issueId)).toEqual(['2']);
    expect(sr.cached().crossLink.map((r) => r.fleetVehicleId)).toEqual(['OTHER9']);
  });

  it('a throwing client -> APERIA_INTERNAL, never throws; the log line carries counts / code / ms only', async () => {
    client.listIssues.mockRejectedValueOnce(new Error('boom Bearer abc'));
    expect(await sr.run({ rows: FLEET })).toEqual({ ok: false, code: 'APERIA_INTERNAL' });
    await sr.run({ rows: FLEET });
    const line = logger.lines.filter((l) => l.args[0] === '[aperia] sync-read').pop();
    expect(Object.keys(line.args[1]).sort()).toEqual(['code', 'critNoCase', 'issues', 'ms', 'op', 'scoped']);
    expect(logger.text()).not.toContain('NP6923');
  });
});
