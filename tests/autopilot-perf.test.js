// tests/autopilot-perf.test.js — fleet-autopilot NFR-3 (soft): a tick with no changes over 300
// fleet rows and 30 open cases stays under 200 ms of CPU (process.cpuUsage).
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });   // multi-tick integration tests; the CI host can be loaded
const F = require('./helpers/autopilot-fakes.cjs');

describe('NFR-3 no-change tick', () => {
  it('300 rows, 30 open cases -> cpu < 200 ms', { retry: 2 }, async () => {
    F.freshDb('perf');
    const rows = [];
    const units = [];
    for (let i = 0; i < 300; i++) {
      const down = i < 30;
      const u = String(500000 + i);
      if (down) units.push(u);
      rows.push(F.baseRow({ equipmentId: u, domicileSite: down ? 'ABE40' : 'XYZ' + (i % 7), lifecycleState: down ? 'Unavailable' : 'Active', _serviceId: 'svc-' + i, workRequestId: 'wr-' + i }));
    }
    const world = F.mkWorld({ rows });
    const env = F.mkEnv({ world, autopilot: { maxCasesPerTick: 5, scope: { units: [], domicile: 'ABE40' } } });
    for (let i = 0; i < 8; i++) { await env.ctl.runOnce(); env.clock.advance(60000); }
    const open = F.cs.listCases({ limit: 200 }).items;
    expect(open.length).toBe(30);
    expect(open.every((c) => c.state !== 'QUEUED')).toBe(true);
    env.clock.advance(60000);
    const before = process.cpuUsage();
    const r = await env.ctl.runOnce();
    const cpu = process.cpuUsage(before);
    const ms = (cpu.user + cpu.system) / 1000;
    expect(r.investigated.length).toBe(0);
    expect(r.cpuMs).toBeLessThan(200);
    expect(ms).toBeLessThan(200);
  });
});
