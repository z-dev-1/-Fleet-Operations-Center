// tests/fixtures/jobs-repair-intel-fixture.js — shared fixture for the Phase 7
// repair-intel flags-off golden (generator: tests/jobs-repair-intel-baseline.gen.test.js,
// consumer: tests/jobs-adopt-repair-intel.test.js).
//
// require-cache stubs for everything background._cycle touches: cluster,
// repair-intel/schema|store|fetch|analysis, the JSON store (fleetData roster),
// orcha/relay.getStatus and the logger. No SQLite (for repair-intel), AAP or
// AI. Only `Date` is frozen. Logger lines carry no timestamps/durations, so
// they are recorded verbatim (namespace 'repair-intel' only).
import { vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export const FIXED = Date.parse('2026-11-02T15:04:05.000Z');
export function setupClock() { vi.useFakeTimers({ toFake: ['Date'], now: FIXED }); }

function inject(relFromTests, exportsObj) {
  const resolved = require.resolve('../../' + relFromTests);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

export const rec = {
  logs: [], sync: [], analyze: [],
  roster: [], checkpoints: {}, syncImpl: null, analyzeImpl: null,
  onSync: null, onAnalyze: null,
};

export function resetRecorders() {
  rec.logs = []; rec.sync = []; rec.analyze = [];
  rec.roster = []; rec.checkpoints = {}; rec.syncImpl = null; rec.analyzeImpl = null;
  rec.onSync = null; rec.onAnalyze = null;
}

function fakeLogger(ns) {
  const r = (level) => (...a) => rec.logs.push({ ns, level, msg: a.map(String).join(' ') });
  return { debug: r('debug'), info: r('info'), warn: r('warn'), error: r('error'), log: r('info') };
}
fakeLogger.createLogger = fakeLogger;
fakeLogger.setLogDir = () => {};
fakeLogger.setLevel = () => {};
fakeLogger.setSilent = () => {};
fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export function installStubs() {
  inject('src/utils/logger', fakeLogger);
  inject('src/cluster', { mayRunProduction: () => true });
  inject('src/repair-intel/schema', { ensureSchema: () => true });
  inject('src/repair-intel/store', { getCheckpoint: (id) => rec.checkpoints[id] || null });
  inject('src/repair-intel/fetch', {
    syncUnit: async (id, opts) => {
      rec.sync.push([id, opts]);
      if (rec.onSync) rec.onSync(id);
      return rec.syncImpl(id);
    },
  });
  inject('src/repair-intel/analysis', {
    analyzeUnit: async (id, opts) => {
      rec.analyze.push([id, opts]);
      if (rec.onAnalyze) rec.onAnalyze(id);
      return rec.analyzeImpl ? rec.analyzeImpl(id) : { ok: true };
    },
  });
  inject('src/store', {
    load: (k, d) => (k === 'fleetData' ? { rows: rec.roster.map((id) => ({ equipmentId: id })) } : d),
    save: () => {},
  });
  inject('src/orcha/relay', { getStatus: () => ({ backends: { orcha: true } }) });
}

// Scenarios: roster + checkpoints + syncUnit behavior.
const FRESH = () => ({ last_incr_sync_at: FIXED - 60 * 1000 });
export const SCENARIOS = {
  changed: { roster: ['U1', 'U2', 'U3'], sync: (id) => (id === 'U1' ? { ok: true, added: 1 } : { ok: true, added: 0, updated: 0 }) },
  nullResult: { roster: ['U1', 'U2', 'U3'], sync: (id) => (id === 'U2' ? null : { ok: true, added: 0 }) },
  throwing: { roster: ['U1', 'U2', 'U3'], sync: (id) => { if (id === 'U2') throw new Error('AAP 503'); return { ok: true, updated: id === 'U3' ? 2 : 0 }; } },
  unchanged: { roster: ['U1', 'U2'], sync: () => ({ ok: true, added: 0, updated: 0 }) },
  allFresh: { roster: ['U1', 'U2'], fresh: true, sync: () => ({ ok: true, added: 1 }) },
};

export function applyScenario(name) {
  const s = SCENARIOS[name];
  rec.roster = s.roster.slice();
  rec.checkpoints = {};
  if (s.fresh) for (const id of s.roster) rec.checkpoints[id] = FRESH();
  rec.syncImpl = s.sync;
}

export function collect() {
  const ri = rec.logs.filter((l) => l.ns === 'repair-intel');
  return {
    sync: rec.sync.map((x) => x[0]),
    syncOpts: rec.sync.map((x) => x[1]),
    analyze: rec.analyze,
    warn: ri.filter((l) => l.level === 'warn' || l.level === 'error').map((l) => l.msg),
    info: ri.filter((l) => l.level === 'info').map((l) => l.msg),
  };
}

export async function runScenario(bg, name) {
  resetRecorders();
  applyScenario(name);
  const ret = await bg.runOnce();
  return Object.assign(collect(), { ret: ret === undefined ? '<undefined>' : ret });
}
