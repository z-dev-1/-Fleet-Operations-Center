// tests/workers-isolation-benchmark.test.js — main-thread lag: a synthetic CPU-heavy job
// in-process vs in an isolated worker (design §11.3, review N6).
//  - always (npm test): ms=500, n=4; isolated p50 interval drift <= in-process p50 / 4
//  - FLEET_BENCH=1 (npm run test:bench:workers): ms=250, n=8; in-process max >= 200 ms,
//    isolated max < 150 ms
import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import v8 from 'v8';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createHost } = require('../src/workers/isolation/host');
const { nodeForkSpawner } = require('../src/workers/isolation/spawn');
const groups = require('../src/workers/isolation/groups');
const canonical = require('../src/orcha/canonical_state');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPIN = path.join(ROOT, 'tests', 'workers-isolation-fixtures', 'spin-worker.cjs');
const { spinSync } = require(SPIN);
const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {} });
const SPEC = Object.assign({}, groups.canonical, {
  group: 'spin', name: 'isoSpin', label: 'Spin (bench)', file: SPIN, ops: ['spin'], validateResult: null, requestTimeoutMs: 60000,
});

let host = null;
afterAll(() => { if (host) { try { host.shutdown(); host.killSync(); host._dispose(); } catch (_) { /* ignore */ } } });

async function readyHost() {
  if (host && host.state === 'ready') return host;
  host = createHost(SPEC, { spawn: nodeForkSpawner, prewarmMs: 0, logger: quiet(), workerLogger: () => quiet() });
  host.start();
  const end = Date.now() + 15000;
  while (host.state !== 'ready' && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (host.state !== 'ready') throw new Error('spin host not ready: ' + host.state);
  return host;
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

/** Measure main-thread lag while `job()` runs: 10 ms interval drift + event-loop delay histogram. */
async function measure(job) {
  const drifts = [];
  let last = performance.now();
  const iv = setInterval(() => { const t = performance.now(); drifts.push(Math.max(0, t - last - 10)); last = t; }, 10);
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t0 = performance.now();
  try { await job(); } finally { h.disable(); clearInterval(iv); }
  return {
    ms: Math.round(performance.now() - t0),
    samples: drifts.length,
    p50Drift: Math.round(pct(drifts, 50) * 10) / 10,
    maxDrift: Math.round(Math.max(0, ...drifts) * 10) / 10,
    elMaxMs: Math.round(h.max / 1e6),
    elP50Ms: Math.round(h.percentile(50) / 1e6),
  };
}

async function inProcess(ms, n) {
  for (let i = 0; i < n; i++) {
    spinSync(ms);
    await new Promise((r) => setImmediate(r));   // yield between slices, like the worker's progress points
  }
}

async function run(ms, n) {
  const h = await readyHost();
  const inproc = await measure(() => inProcess(ms, n));
  const isolated = await measure(async () => {
    const r = await h.request('spin', { ms, n }, { timeoutMs: 60000 });
    if (!r.ok) throw new Error('isolated spin failed: ' + r.code);
  });
  const out = { ms, n, inProcess: inproc, isolated };
  process.stdout.write('[bench] ' + JSON.stringify(out) + '\n');
  return out;
}

describe('main-thread lag: in-process vs isolated worker', () => {
  it('npm test: isolated p50 interval drift <= in-process p50 / 4 (ms=500, n=4) (N6)', async () => {
    const r = await run(500, 4);
    expect(r.inProcess.p50Drift).toBeGreaterThan(0);
    expect(r.isolated.p50Drift).toBeLessThanOrEqual(r.inProcess.p50Drift / 4);
    // informational only in npm test: the in-process max is logged, never asserted
    process.stdout.write('[bench] in-process max drift ' + r.inProcess.maxDrift + ' ms, isolated max drift ' + r.isolated.maxDrift + ' ms\n');
  }, 60000);

  it.skipIf(process.env.FLEET_BENCH !== '1')('FLEET_BENCH: absolute max-lag thresholds (N6)', async () => {
    const r = await run(250, 8);
    expect(r.inProcess.maxDrift).toBeGreaterThanOrEqual(200);
    expect(r.isolated.maxDrift).toBeLessThan(150);
  }, 60000);

  it('clone + commit main-thread cost of a ~1 MB canonical payload (informational)', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      equipmentId: 'U' + i, lifecycleState: i % 2 ? 'Unavailable' : 'Available', issueSummary: 'x'.repeat(300),
      asistNotes: 'note '.repeat(60), offsiteStage: 'repair', offsiteStageSince: '2026-10-29T09:00:00Z', vendorName: 'Vendor ' + (i % 9),
    }));
    const payload = { rows, prior: {} };
    const bytes = v8.serialize(payload).length;
    const t0 = performance.now();
    const cloned = v8.deserialize(v8.serialize(payload));
    const cloneMs = performance.now() - t0;
    const built = canonical.buildAll(cloned.rows, { decisions: {}, prior: {} });
    const result = { units: built.units, counts: built.counts };
    const t1 = performance.now();
    const back = v8.deserialize(v8.serialize(result));
    const resultMs = performance.now() - t1;
    const t2 = performance.now();
    const mirrored = rows.map((r) => { const rec = back.units[r.equipmentId]; return rec ? Object.assign({}, r, canonical.mirrorFields(rec)) : r; });
    JSON.stringify(mirrored);
    const commitMs = performance.now() - t2;
    process.stdout.write('[bench] payload ' + Math.round(bytes / 1024) + ' KB: clone out ' + cloneMs.toFixed(1) + ' ms, clone back ' + resultMs.toFixed(1) + ' ms, mirror+stringify ' + commitMs.toFixed(1) + ' ms\n');
    expect(bytes).toBeGreaterThan(500 * 1024);
    expect(Object.keys(back.units)).toHaveLength(1500);
  });
});
