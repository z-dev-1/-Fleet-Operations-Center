// tests/health-snapshot-fleet.test.js — src/health/snapshot.js fleet section +
// apiFleetRefresh overlay (plan.md D6). The apiFleetRefresh tick never rejects,
// so the supervisor reports it healthy while every AAP call times out; the
// snapshot must not show that as healthy idle. Uses the REAL fleet-freshness
// module (injected) and the deps-fake style of tests/health-snapshot.test.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const health = require('../src/health/snapshot');
const ff = require('../src/health/fleet-freshness');

const T = 1763000000000;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function worker(name, extra) {
  return Object.assign({
    name, group: 'fleet', label: 'Worker ' + name, state: 'healthy', waitingOn: null, disabledReason: null,
    breakerState: 'ok', lastHeartbeatAt: T - 5000, lastStartAt: T - 6000, lastEndAt: T - 5000, lastDurationMs: 1000,
    currentJob: null, counts: { runs: 3, ok: 3, fail: 0, skip: 0, timeout: 0 },
    skipReasons: { busy: 0, self: 0, dependency: {} }, consecutiveFailures: 0, lastError: null,
    restarts: 0, maxRestarts: 3, isolations: 0, isolationReason: null, isolatedUntil: null, notified: false,
    nextRunAt: T + 60000, intervalMs: 300000, timeoutMs: 600000, maxFailures: 3, cooldownMs: 1800000,
    dependsOn: [], idempotent: true, owner: 'supervisor',
  }, extra || {});
}

function mkDeps(extra) {
  return Object.assign({
    now: () => T,
    logger: quiet,
    supervisor: {
      getStatus: () => ({ enabled: true, shuttingDown: false, workers: [worker('apiFleetRefresh'), worker('other')] }),
      getSummary: () => ({ count: 2, byState: { healthy: 2, busy: 0, waiting: 0, degraded: 0, isolated: 0, disabled: 0 }, fails: 0, lastErrorAt: null }),
    },
    telemetry: { latestSample: () => null },
  }, extra || {});
}

function initFf(aapStats, lastOkAt) {
  ff._resetForTests();
  ff.init({ store: { load: () => null, save: () => {} }, now: () => T, getIntervalMs: () => 300000, getAapStats: () => aapStats });
  if (lastOkAt != null) ff.recordBuildOk({ count: 100, at: lastOkAt });
}

beforeEach(() => { health._resetForTests(); });

describe('snapshot fleet section', () => {
  it('AAP timeout streak: fleet unhealthy and the healthy apiFleetRefresh row is reported degraded', () => {
    initFf({ consecutiveTimeouts: 5, timeouts: 5 }, T - 60000);
    const s = health.buildSnapshot(mkDeps({ fleetFreshness: ff }));
    expect(s.fleet).toMatchObject({ status: 'ok', level: 'red', health: 'unhealthy', reasons: ['aap-timeouts'], lastOkAt: T - 60000 });
    expect(s.fleet.aap).toEqual({ timeouts: 5, consecutiveTimeouts: 5, lastTimeoutAt: null });
    const row = s.workers.list.find((w) => w.name === 'apiFleetRefresh');
    expect(row.state).toBe('degraded');
    expect(row.degradedReason).toContain('AAP calls timing out');
    expect(s.workers.summary.byState).toMatchObject({ healthy: 1, degraded: 1 });
    const other = s.workers.list.find((w) => w.name === 'other');
    expect(other).toEqual(health._worker(worker('other')));
    expect('degradedReason' in other).toBe(false);
  });

  it('age > 2x interval: degraded with "no successful fleet push in Nm"', () => {
    initFf(null, T - 11 * 60000);
    const s = health.buildSnapshot(mkDeps({ fleetFreshness: ff }));
    expect(s.fleet.health).toBe('degraded');
    const row = s.workers.list.find((w) => w.name === 'apiFleetRefresh');
    expect(row.degradedReason).toBe('no successful fleet push in 11m');
  });

  it('healthy freshness leaves the row byte-identical (no degradedReason key)', () => {
    initFf({ consecutiveTimeouts: 0, timeouts: 2 }, T - 60000);
    const s = health.buildSnapshot(mkDeps({ fleetFreshness: ff }));
    expect(s.fleet.health).toBe('healthy');
    const row = s.workers.list.find((w) => w.name === 'apiFleetRefresh');
    expect(row).toEqual(health._worker(worker('apiFleetRefresh')));
    expect(s.workers.summary.byState).toMatchObject({ healthy: 2, degraded: 0 });
  });

  it('isolated rows are not overlaid', () => {
    initFf({ consecutiveTimeouts: 5, timeouts: 5 }, T - 60000);
    const deps = mkDeps({ fleetFreshness: ff });
    deps.supervisor.getStatus = () => ({ enabled: true, workers: [worker('apiFleetRefresh', { state: 'isolated' })] });
    const s = health.buildSnapshot(deps);
    expect(s.workers.list[0].state).toBe('isolated');
    expect('degradedReason' in s.workers.list[0]).toBe(false);
  });

  it('module not injected and not loaded -> no fleet key', () => {
    const s = health.buildSnapshot(mkDeps({ fleetFreshness: null }));
    expect('fleet' in s).toBe(false);
  });

  it('evaluate throwing -> fleet unavailable, workers unchanged', () => {
    const bad = { getSnapshot: () => ({}), evaluate: () => { throw new Error('nope'); } };
    const s = health.buildSnapshot(mkDeps({ fleetFreshness: bad }));
    expect(s.fleet).toMatchObject({ status: 'unavailable' });
    const row = s.workers.list.find((w) => w.name === 'apiFleetRefresh');
    expect(row).toEqual(health._worker(worker('apiFleetRefresh')));
  });
});
