// tests/autopilot-load.bench.test.js — Autopilot V2 opt-in load bench (NFR-2, AC-36, design §12.1).
// Runs only with FLEET_AP_LOAD=1 (describe.skip otherwise). Synthetic fleets of 263, 1000 and 5000
// rows go through the real controller detection pass (fake ports, stub investigation pool, real
// temp SQLite). Measures the detection pass, applyPass writes, pickQueued, slice evaluation at 1000
// and 5000 cases, the RSS delta and the event-loop p99 (perf_hooks.monitorEventLoopDelay), and
// prints one JSON document. It asserts only that every stage completes; it makes no capacity claim.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi } from 'vitest';
import { performance, monitorEventLoopDelay } from 'perf_hooks';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 600000 });

const RUN = process.env.FLEET_AP_LOAD === '1';
const d = RUN ? describe : describe.skip;

const FLEETS = [263, 1000, 5000];
const SLICE_CASES = [1000, 5000];
const DOMS = ['ABE40', 'ROC5', 'EWR45', 'PHL40', 'DFW7', 'SEA1', 'ATL9', 'ORD3', 'IND2', 'LAX9', 'MIA4', 'DEN3'];
const OPS = ['TUZR', 'KNXP', 'SWFT', 'JBHT', 'WRNR', 'PRIM', 'SCHN', 'CRST'];

function synthRows(n, F) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const k = i % 100;
    let assetType = 'tractor';
    let bodyType = 'Day Cab';
    if (k >= 80 && k < 88) assetType = 'boxTruck';
    else if (k >= 88 && k < 94) assetType = 'trailer';
    else if (k >= 94 && k < 97) assetType = 'hostler';
    else if (k >= 97 && k < 99) assetType = '';
    else if (k === 99) bodyType = 'Reefer Trailer';
    rows.push(F.baseRow({
      equipmentId: 'S' + String(i).padStart(5, '0'), domicileSite: DOMS[i % DOMS.length], operator: OPS[i % OPS.length],
      owner: OPS[(i + 3) % OPS.length], assetType, bodyType,
      lifecycleState: i % 20 < 11 ? 'Unavailable' : 'Active',
      _serviceId: 'svc-' + i, workRequestId: 'wr-' + i, workDuration: (2 + (i % 30)) + 'd 2h 0m',
      vendor: 'Vendor ' + (i % 40),
    }));
  }
  return rows;
}

const ms = (t) => Math.round((performance.now() - t) * 10) / 10;
// Let the event-loop delay timer fire so a blocking stage is recorded before the histogram is read.
const yieldLoop = () => new Promise((r) => setTimeout(r, 30));
const mb = (b) => Math.round((b / 1048576) * 10) / 10;

d('Autopilot V2 load bench (FLEET_AP_LOAD=1)', () => {
  it('detection pass, applyPass, pickQueued, slice evaluation, RSS and event-loop p99', async () => {
    const F = require('./helpers/autopilot-fakes.cjs');
    const cs = F.cs;
    const slices = require('../src/autopilot/slices');
    const os = require('os');
    const out = {
      bench: 'autopilot-v2-load', node: process.version, platform: process.platform, cpus: os.cpus().length,
      cpuModel: (os.cpus()[0] || {}).model || null, totalMemMb: mb(os.totalmem()), fleets: [], slices: [],
    };

    for (const n of FLEETS) {
      F.freshDb('load' + n);
      if (global.gc) global.gc();
      const rss0 = process.memoryUsage().rss;
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      const applyMs = [];
      const timedStore = Object.assign({}, cs, {
        applyPass: (...a) => { const t = performance.now(); try { return cs.applyPass(...a); } finally { applyMs.push(ms(t)); } },
      });
      const world = F.mkWorld({ rows: synthRows(n, F) });
      const runInvestigation = async (caseId) => ({ ok: true, caseId, outcome: 'noop' });
      const env = F.mkEnv({ world, caseStore: timedStore, runInvestigation, autopilot: { scope: { mode: 'fleet' }, queue: { maxStartsPerTick: 1 } } });

      let t = performance.now();
      const r1 = await env.ctl.runOnce({ forceDetect: true });
      const tick1Ms = ms(t);
      await yieldLoop();
      env.clock.advance(40 * 60000);
      t = performance.now();
      const r2 = await env.ctl.runOnce({ forceDetect: true });
      const tick2Ms = ms(t);
      await yieldLoop();
      const pass = cs.coverage(env.clock.now()).pass;

      const picks = [];
      for (let i = 0; i < 20; i++) { t = performance.now(); cs.pickQueued(4, env.clock.now(), { boost: 2, cap: 40 }); picks.push(ms(t)); }
      picks.sort((a, b) => a - b);
      h.disable();
      const rss1 = process.memoryUsage().rss;
      const open = cs.listOpen().length;
      out.fleets.push({
        rows: n, eligible: pass.eligible, downEligible: pass.down_eligible, casesOpen: open, reconcileOk: pass.reconcile_ok === 1,
        detected: r1.detected, tickMs: [tick1Ms, tick2Ms], applyPassMs: applyMs,
        pickQueuedMs: { p50: picks[10], max: picks[picks.length - 1], queued: cs.queueStats(env.clock.now()).queued },
        rssDeltaMb: mb(rss1 - rss0), eventLoopP99Ms: Math.round((h.percentile(99) / 1e6) * 10) / 10,
        eventLoopMaxMs: Math.round((h.max / 1e6) * 10) / 10,
      });
      expect(r1.detected).toBeGreaterThan(0);
      expect(r2).toBeTruthy();
      expect(applyMs.length).toBe(2);
    }

    // Slice evaluation (the controller's per-case monitoring step) over K cases, pure, fake ports.
    for (const k of SLICE_CASES) {
      const world = F.mkWorld({ rows: synthRows(k, F) });
      const ports = F.fakePorts(world);
      const now = F.T0;
      const prev = new Map();
      for (const row of world.rows) prev.set(row.equipmentId, slices.forCase({ row, unit: row.equipmentId, docs: world.docs, ports, now, aperiaIssues: null }));
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      const t = performance.now();
      let changed = 0;
      for (const row of world.rows) {
        const next = slices.forCase({ row, unit: row.equipmentId, docs: world.docs, ports, now, aperiaIssues: null });
        if (slices.changedSlices(prev.get(row.equipmentId), next).length) changed++;
      }
      const total = ms(t);
      await yieldLoop();
      h.disable();
      out.slices.push({ cases: k, totalMs: total, perCaseUs: Math.round((total * 1000) / k), changed, eventLoopP99Ms: Math.round((h.percentile(99) / 1e6) * 10) / 10 });
      expect(changed).toBe(0);
    }

    process.stdout.write('AUTOPILOT_LOAD_BENCH ' + JSON.stringify(out) + '\n');
    expect(out.fleets.length).toBe(FLEETS.length);
    expect(out.slices.length).toBe(SLICE_CASES.length);
  });
});
