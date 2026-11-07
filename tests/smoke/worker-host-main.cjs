'use strict';
// tests/smoke/worker-host-main.cjs — Electron smoke for Phase 8 worker isolation (design §11.4).
// Run: npm run test:smoke:workers (also chained from npm run test:smoke:electron).
// It does not touch the Fleet app: userData is a temp dir, no window is opened, and it
// only ever kills processes it started itself (by pid). Exits 0 only if every check passes.
//
//  1. real utilityProcess fork through defaultSpawner(spec, { electron: recElectron }) (N2):
//     fork options, minimal env (hello.diag), getAppMetrics type 'Utility', ppid/parentPid
//  2. canonical.buildAll parity with in-process buildAll (timestamps ignored)
//  3. child.kill() → backoff → ready → request ok; main's event loop keeps ticking
//  4. RSS cap: a hog worker with rssCapMb 200 is killed with reason 'rss', row 'degraded'
//  5. graceful: isolation.onBeforeQuit() → worker pid gone within 3 s
//  6–8. child Electron app (worker-orphan-main.cjs): app.exit(0), relaunch-like, taskkill /F
//     of the child main (no /T) → its worker pid gone within 10 s each

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { app, utilityProcess } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-worker-smoke-userdata-'));
app.setPath('userData', userData);

const spawnMod = require(path.join(ROOT, 'src', 'workers', 'isolation', 'spawn.js'));
const { createHost } = require(path.join(ROOT, 'src', 'workers', 'isolation', 'host.js'));
const groups = require(path.join(ROOT, 'src', 'workers', 'isolation', 'groups.js'));
const canonical = require(path.join(ROOT, 'src', 'orcha', 'canonical_state.js'));

const summary = { versions: {}, checks: {}, failures: [], pids: [], hello: null, metric: null, orphan: {} };
const check = (name, ok, detail) => { summary.checks[name] = ok ? 'pass' : 'FAIL' + (detail ? ': ' + detail : ''); if (!ok) summary.failures.push(name); };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const lines = [];
const logger = { debug() {}, info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return !!fn(); }
async function goneWithin(pid, ms) { const t0 = Date.now(); const ok = await until(() => !alive(pid), ms); return { ok, ms: Date.now() - t0 }; }

// Production fork, wrapped only to record the options and the child (as justme-libs-main.cjs).
const forks = [];
const recElectron = {
  app,
  utilityProcess: { fork(file, args, opts) { const child = utilityProcess.fork(file, args, opts); forks.push({ file, args, opts, child }); return child; } },
};
const hosts = [];
function mkHost(spec, extra) {
  const h = createHost(spec, Object.assign({ spawn: (s) => spawnMod.defaultSpawner(s, { electron: recElectron }), electron: recElectron,
    prewarmMs: 0, logger, workerLogger: () => quiet }, extra || {}));
  hosts.push(h);
  h.start();
  return h;
}
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (!['updatedAt', 'statusChangedAt', 'at'].includes(k)) o[k] = strip(v[k]); return o; }
  return v;
}
const ROWS = Array.from({ length: 60 }, (_, i) => ({ equipmentId: (i % 9 === 0 ? ' ' : '') + 'S' + i, lifecycleState: i % 2 ? 'Unavailable' : 'Available',
  issueSummary: i % 4 ? 'brake job' : 'ready for pickup', offsiteStage: ['ready', 'repair', ''][i % 3], offsiteStageSince: i % 2 ? '2026-10-29T09:00:00Z' : '' }));

async function main() {
  summary.versions = { electron: process.versions.electron, node: process.versions.node };
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 50);

  // 1. spawn options, env, metrics
  const spec = Object.assign({}, groups.canonical, { backoffMs: [300, 300, 300, 300] });
  const h = mkHost(spec, { diag: true });
  const ready1 = await until(() => h.state === 'ready', 15000);
  check('1: canonical worker reaches ready (utilityProcess)', ready1, h.state);
  const f = forks[0] || { opts: {} };
  const o = f.opts || {};
  summary.spawnOptions = { serviceName: o.serviceName, execArgv: o.execArgv, stdio: o.stdio, partition: o.partition, envKeys: Object.keys(o.env || {}).sort() };
  const expectEnv = ['NODE_ENV', 'SystemRoot', 'TEMP', 'TMP', 'windir'].filter((k) => k in spawnMod.workerEnv()).sort();
  check('1: spawnOptions (serviceName, execArgv, stdio, partition, env keys) via deps.electron (N2)', f.file === spec.file && o.serviceName === 'fleet-worker-canonical'
    && JSON.stringify(o.execArgv) === JSON.stringify(['--max-old-space-size=384']) && o.stdio === 'ignore' && o.partition === 'fleet-worker-canonical'
    && JSON.stringify(summary.spawnOptions.envKeys) === JSON.stringify(expectEnv), JSON.stringify(summary.spawnOptions));
  const hello = h.hello || {};
  summary.hello = { pid: hello.pid, ppid: hello.ppid, initParentPid: process.pid, envKeys: hello.diag ? hello.diag.envKeys : null, execArgv: hello.diag ? hello.diag.execArgv : null };
  if (Number.isInteger(h.pid)) summary.pids.push(h.pid);
  check('1: hello.diag.envKeys carries no secrets', !!(hello.diag && hello.diag.envKeys.every((k) => !/TOKEN|SLACK|AWS|FLEET_|SECRET|COOKIE/i.test(k))), JSON.stringify(summary.hello.envKeys));
  const m = app.getAppMetrics().find((x) => x.pid === h.pid);
  summary.metric = m ? { pid: m.pid, type: m.type, serviceName: m.serviceName, name: m.name, workingSetKB: m.memory && m.memory.workingSetSize } : { missing: true, pid: h.pid };
  check('1: getAppMetrics lists the worker pid as Utility', !!m && m.type === 'Utility', JSON.stringify(summary.metric));

  // 2. parity
  const r = await h.request('canonical.buildAll', { rows: ROWS, prior: {} });
  const want = canonical.buildAll(ROWS, { decisions: {}, prior: {} });
  check('2: canonical.buildAll equals in-process (timestamps ignored)', r.ok && JSON.stringify(strip(r.result.units)) === JSON.stringify(strip(want.units))
    && JSON.stringify(r.result.counts) === JSON.stringify(want.counts), r.ok ? 'mismatch' : r.code);
  summary.workerMs = r.workerMs;

  // 3. crash containment
  const pid1 = h.pid;
  const ticks0 = ticks;
  h.child.kill();
  const sawBackoff = await until(() => h.state === 'backoff', 5000);
  const ready2 = await until(() => h.state === 'ready', 15000);
  const r2 = ready2 ? await h.request('canonical.buildAll', { rows: ROWS.slice(0, 5), prior: {} }) : { ok: false, code: 'not ready' };
  if (Number.isInteger(h.pid)) summary.pids.push(h.pid);
  check('3: child.kill → backoff → ready → request ok, new pid', sawBackoff && ready2 && r2.ok && h.pid !== pid1 && !alive(pid1),
    JSON.stringify({ sawBackoff, ready2, ok: r2.ok, pid1, pid2: h.pid }));
  check('3: main event loop kept ticking', ticks - ticks0 >= 3, String(ticks - ticks0));

  // 4. RSS cap
  const hogSpec = Object.assign({}, groups.canonical, { group: 'hog', name: 'isoHog', label: 'Hog (smoke)', file: path.join(__dirname, 'worker-hog-worker.cjs'),
    serviceName: 'fleet-worker-hog', ops: ['hog'], rssCapMb: 200, rssPollBusyMs: 250, requestTimeoutMs: 60000, validateResult: null, backoffMs: [60000, 60000, 60000, 60000] });
  const hog = mkHost(hogSpec);
  const hogReady = await until(() => hog.state === 'ready', 15000);
  const hogPid = hog.pid;
  if (Number.isInteger(hogPid)) summary.pids.push(hogPid);
  const hr = hogReady ? await hog.request('hog', {}, { timeoutMs: 60000 }) : { ok: false, code: 'not ready' };
  await until(() => hog.getStatusRow().host.lastExit != null, 5000);   // the kill's exit event propagates to the row
  const hogRow = hog.getStatusRow();
  summary.rss = { code: hr.code, lastExit: hogRow.host.lastExit, rowState: hogRow.state, rssMb: hogRow.host.rssMb };
  check('4: RSS cap kills with reason rss, row degraded', hr.code === 'RSS_LIMIT' && hogRow.host.lastExit && hogRow.host.lastExit.reason === 'rss' && hogRow.state === 'degraded',
    JSON.stringify(summary.rss));
  const hogGone = await goneWithin(hogPid, 5000);
  check('4: hog worker pid gone', hogGone.ok, JSON.stringify(hogGone));
  hog.shutdown();

  // 5. graceful through the registry + supervisor wiring (as app.js)
  h.shutdown();
  await until(() => h.state === 'stopped', 3000);
  const sup = require(path.join(ROOT, 'src', 'workers', 'supervisor.js'));
  const iso = require(path.join(ROOT, 'src', 'workers', 'isolation', 'index.js'));
  sup.init({ flags: { supervisorEnabled: true, supervised: {} }, logger: quiet });
  iso.init({ flags: { enabled: true, groups: { canonical: true } }, supervisor: sup, logger,
    deps: { spawn: (s) => spawnMod.defaultSpawner(s, { electron: recElectron }), electron: recElectron, prewarmMs: 0, workerLogger: () => quiet } });
  const ih = iso.getHost('canonical');
  const ready3 = await until(() => ih && ih.state === 'ready', 15000);
  const gpid = ih && ih.pid;
  if (Number.isInteger(gpid)) summary.pids.push(gpid);
  const statusRow = sup.getStatus().workers.find((w) => w.name === 'isoCanonical');
  check('5: host row in supervisor.getStatus (Worker Health)', !!statusRow && statusRow.owner === 'host' && statusRow.state === 'healthy', JSON.stringify(statusRow && statusRow.state));
  sup.onBeforeQuit();
  const g = ready3 ? await goneWithin(gpid, 3000) : { ok: false };
  summary.graceful = g;
  check('5: graceful onBeforeQuit → worker pid gone within 3 s', ready3 && g.ok, JSON.stringify(g));
  sup.onWillQuit();

  // 6–8. orphan scenarios in a child Electron app
  for (const mode of ['exit', 'relaunch-like', 'wait']) summary.orphan[mode] = await orphanRun(mode);
  check('6: app.exit(0) → worker gone within 10 s', summary.orphan.exit.ok, JSON.stringify(summary.orphan.exit));
  check('7: relaunch-like (before-quit + app.exit same tick) → worker gone within 10 s', summary.orphan['relaunch-like'].ok, JSON.stringify(summary.orphan['relaunch-like']));
  check('8: taskkill /F of main (no /T) → worker gone within 10 s', summary.orphan.wait.ok, JSON.stringify(summary.orphan.wait));

  clearInterval(ticker);
  // Final sweep: every worker pid this smoke saw is gone.
  await sleep(500);
  const live = summary.pids.filter(alive);
  check('no live worker pids at the end', live.length === 0, live.join(','));
}

function orphanRun(mode) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-orphan-'));
    const res = { mode, ok: false };
    let outBuf = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(__dirname, 'worker-orphan-main.cjs'), '--mode=' + mode, '--user-data=' + tmp], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    res.childMainPid = child.pid;
    const finish = async () => {
      if (settled) return;
      settled = true;
      try { if (alive(child.pid)) process.kill(child.pid); } catch (_) { /* ignore */ }
      await sleep(300);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EBUSY')) { await sleep(500); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
      }
      resolve(res);
    };
    const guard = setTimeout(() => { res.error = 'timeout'; finish(); }, 45000);
    child.stdout.on('data', async (d) => {
      outBuf += d;
      const mm = outBuf.match(/WORKER_PID (\d+) MAIN_PID (\d+)/);
      if (!mm || res.workerPid) return;
      res.workerPid = Number(mm[1]);
      summary.pids.push(res.workerPid);
      if (mode === 'wait') {
        await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/F'], { windowsHide: true }, () => r()));
      }
      const t0 = Date.now();
      const early = await until(() => !alive(res.workerPid), 2500);
      const g = early ? { ok: true } : await goneWithin(res.workerPid, 7500);
      res.ok = early || g.ok;
      res.goneMs = Date.now() - t0;
      res.goneBefore2500ms = early;
      clearTimeout(guard);
      finish();
    });
    child.on('exit', (code) => { res.childExit = code; if (!res.workerPid) { res.error = 'child exited without a worker pid: ' + outBuf.slice(0, 200); clearTimeout(guard); finish(); } });
  });
}

const hardStop = setTimeout(() => {
  process.stdout.write('SMOKE TIMEOUT\n' + JSON.stringify(summary, null, 2) + '\n');
  for (const h of hosts) { try { h.killSync(); } catch (_) { /* ignore */ } }
  app.exit(2);
}, 120000);

app.on('window-all-closed', () => {});
app.whenReady().then(main).then(() => {
  clearTimeout(hardStop);
  for (const h of hosts) { try { h.killSync(); } catch (_) { /* ignore */ } }
  process.stdout.write('WORKER_SMOKE_SUMMARY ' + JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write((summary.failures.length ? 'SMOKE FAILED: ' + summary.failures.join('; ') : 'SMOKE OK') + '\n');
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  app.exit(summary.failures.length ? 1 : 0);
}).catch((e) => {
  process.stdout.write('SMOKE ERROR ' + (e && (e.code || e.name)) + ' ' + (e && e.stack) + '\n' + JSON.stringify(summary, null, 2) + '\n');
  for (const h of hosts) { try { h.killSync(); } catch (_) { /* ignore */ } }
  app.exit(1);
});
