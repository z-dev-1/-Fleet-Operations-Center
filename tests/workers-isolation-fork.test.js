// tests/workers-isolation-fork.test.js — real host + real worker over child_process.fork
// (nodeForkSpawner), design §11.2, review M2 parent-side start timeout.
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createHost } = require('../src/workers/isolation/host');
const { nodeForkSpawner } = require('../src/workers/isolation/spawn');
const groups = require('../src/workers/isolation/groups');
const canonical = require('../src/orcha/canonical_state');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTE = path.join(ROOT, 'tests', 'workers-isolation-fixtures', 'mute-worker.cjs');
const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {} });
const hosts = [];

function mkHost(over = {}) {
  const h = createHost(Object.assign({}, groups.canonical, over), { spawn: nodeForkSpawner, prewarmMs: 0, logger: quiet(), workerLogger: () => quiet() });
  hosts.push(h);
  h.start();
  return h;
}
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out: ' + label);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = {};
    // wall-clock stamps from buildAll's new Date() (worker vs main clock read)
    for (const k of Object.keys(v)) if (k !== 'updatedAt' && k !== 'statusChangedAt' && k !== 'at') o[k] = strip(v[k]);
    return o;
  }
  return v;
}
function rows200() {
  const stages = ['ready', 'repair', 'approval', '', 'diagnosis'];
  return Array.from({ length: 200 }, (_, i) => ({
    equipmentId: (i % 17 === 0 ? '  ' : '') + 'U' + i + (i % 23 === 0 ? '\u0000' : ''),
    lifecycleState: i % 3 ? 'Unavailable' : 'Available',
    issueSummary: i % 5 === 0 ? 'unit will be ready for pickup Friday' : 'brake job',
    offsiteStage: stages[i % stages.length],
    offsiteStageSince: i % 2 ? '2026-10-29T09:00:00Z' : '',
    vendorName: 'Vendor ' + (i % 7),
  }));
}

afterEach(() => {
  while (hosts.length) { const h = hosts.pop(); try { h.shutdown(); } catch (_) { /* ignore */ } try { h.killSync(); } catch (_) { /* ignore */ } try { h._dispose(); } catch (_) { /* ignore */ } }
});

describe('real fork', () => {
  it('hello → ready', async () => {
    const h = mkHost();
    await until(() => h.state === 'ready', 10000, 'ready');
    expect(h.hello).toMatchObject({ ops: ['canonical.buildAll'] });
    expect(h.hello.ppid).toBe(process.pid);
    expect(h.getStatusRow()).toMatchObject({ state: 'healthy', owner: 'host' });
  }, 20000);

  it('buildAll on 200 rows equals in-process', async () => {
    const h = mkHost();
    await until(() => h.state === 'ready', 10000, 'ready');
    const rows = rows200();
    const prior = { U1: { equipmentId: 'U1', status: 'in_repair', updatedAt: '2026-10-29T08:00:00Z' } };
    const r = await h.request('canonical.buildAll', { rows, prior });
    expect(r.ok).toBe(true);
    const want = canonical.buildAll(rows, { decisions: {}, prior });
    expect(strip(r.result.units)).toEqual(strip(want.units));
    expect(r.result.counts).toEqual(want.counts);
    expect(Object.keys(r.result.units)).toContain('U0');   // padded id normalized like buildAll
    expect(r.workerMs).toBeGreaterThanOrEqual(0);
  }, 20000);

  it('child.kill → backoff → ready → ok', async () => {
    const h = mkHost({ backoffMs: [200, 200, 200, 200] });
    await until(() => h.state === 'ready', 10000, 'ready');
    const pid1 = h.pid;
    h.child.kill();
    await until(() => h.state === 'backoff', 5000, 'backoff');
    expect(h.getStatusRow()).toMatchObject({ state: 'degraded', consecutiveFailures: 1 });
    await until(() => h.state === 'ready', 10000, 'ready again');
    expect(h.pid).not.toBe(pid1);
    const r = await h.request('canonical.buildAll', { rows: rows200().slice(0, 5), prior: {} });
    expect(r.ok).toBe(true);
    expect(h.getStatusRow().consecutiveFailures).toBe(0);
  }, 30000);

  it('shutdown → pid gone within 3 s', async () => {
    const h = mkHost();
    await until(() => h.state === 'ready', 10000, 'ready');
    const pid = h.pid;
    h.shutdown();
    await until(() => !alive(pid), 3000, 'pid gone');
    await until(() => h.state === 'stopped', 3000, 'stopped');
    expect(h.getStatusRow().host.lastExit).toMatchObject({ code: 0, reason: 'shutdown' });
  }, 20000);

  it('killSync leaves no live pid', async () => {
    const h = mkHost();
    await until(() => h.state === 'ready', 10000, 'ready');
    const pid = h.pid;
    expect(h.killSync()).toBe(true);
    await until(() => !alive(pid), 3000, 'pid gone');
    expect(alive(pid)).toBe(false);
  }, 20000);

  it('real fork: a worker that never sends hello is killed by the parent start timeout (M2)', async () => {
    const h = mkHost({ file: MUTE, startTimeoutMs: 1000, backoffMs: [60000, 60000, 60000, 60000] });
    await until(() => h.state === 'starting' && h.pid != null, 5000, 'starting');
    const pid = h.pid;
    expect(alive(pid)).toBe(true);
    await until(() => h.state === 'backoff', 5000, 'backoff');
    expect(h.getStatusRow().host.lastExit.reason).toBe('start-timeout');
    expect(h.getStatusRow().host.crashes).toBe(1);
    await until(() => !alive(pid), 5000, 'mute worker gone');
    let code = null;
    try { process.kill(pid, 0); } catch (e) { code = e.code; }
    expect(code).toBe('ESRCH');
  }, 20000);
});
