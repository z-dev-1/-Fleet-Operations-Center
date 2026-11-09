// FEAT-B2 / AC-18 (design §15.4): the Grim Reaper / OBS launcher — shell.openPath exactly once per
// confirmed valid run, never child_process, the .bat bytes and mtime unchanged, path validation,
// the 5 s debounce, the default path from app.getPath('desktop'), and no path in logs or errors.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const cjsFs = require('fs');
const cp = require('child_process');
const pf = require('../src/config/perf-flags');

let TMP; let DESK; let logger; let restoreE; let handlers; let ctx; let fx; let now; let L;

function setup() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-launch-'));
  DESK = path.join(TMP, 'Desktop');
  fs.mkdirSync(DESK);
  require('../src/config/paths').setDataDir(path.join(TMP, 'data'));
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron();
  fx.electron.app.getPath = (n) => (n === 'desktop' ? DESK : path.join(TMP, 'other'));
  fx.electron.dialog.showMessageBox = vi.fn(async () => ({ response: 0 }));
  restoreE = installFakeElectron(require, fx.electron);
  const hub = require('../src/ipc/zoom-hub');
  handlers = new Map();
  const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
  ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: () => {} };
  hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, studio: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
  now = 1_000_000;
  L = require('../src/zoom/studio/launcher');
  L._setDeps({ now: () => now });
}

const call = (ch, payload) => handlers.get(ch)({ sender: ctx.mainWindow.webContents, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }, payload);
const pickReturns = (p) => { fx.electron.dialog.showOpenDialog = vi.fn(async () => (p === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [p] })); };

function makeDefault() {
  const dir = path.join(DESK, 'Grim Reaper Zoom Face');
  fs.mkdirSync(dir, { recursive: true });
  const bat = path.join(dir, 'Start Grim Reaper.bat');
  fs.writeFileSync(bat, '@echo off\r\nstart "" chrome --app=file:///grim.html\r\n');
  return bat;
}

beforeEach(() => setup());
afterEach(() => {
  vi.restoreAllMocks();
  try { L._resetForTests(); L._setDeps(null); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function assertNoPathInLogs(p) {
  const t = logger.text();
  expect(t.includes(TMP)).toBe(false);
  expect(t.includes(JSON.stringify(TMP).slice(1, -1))).toBe(false);
  if (p) expect(t.includes(path.basename(p))).toBe(false);
}

describe('launcher-get (default path)', () => {
  it('no config and no default file -> Not set; the default .bat on the Desktop -> isDefault', async () => {
    expect(await call('zoomStudio:launcher-get')).toEqual({ ok: true, path: null, exists: false, isDefault: false });
    const bat = makeDefault();
    expect(await call('zoomStudio:launcher-get')).toEqual({ ok: true, path: bat, exists: true, isDefault: true });
    // The username is never hard-coded: the default follows app.getPath('desktop').
    expect(fs.readFileSync(require.resolve('../src/zoom/studio/launcher.js'), 'utf8')).not.toMatch(/zilasant|C:\\\\Users/i);
  });
});

describe('launcher-run (AC-18)', () => {
  it('confirms once per path, then calls shell.openPath exactly once per run; bytes + mtime unchanged; no child_process', async () => {
    const bat = makeDefault();
    const bytes = fs.readFileSync(bat);
    const mtime = fs.statSync(bat).mtimeMs;
    const spies = ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'].map((m) => vi.spyOn(cp, m));
    const writes = ['writeFileSync', 'appendFileSync', 'openSync', 'createWriteStream', 'truncateSync', 'utimesSync'].map((m) => vi.spyOn(cjsFs, m));

    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: true });
    expect(fx.calls.openPath).toEqual([[bat]]);
    expect(fx.electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const [parent, box] = fx.electron.dialog.showMessageBox.mock.calls[0];
    expect(parent).toBe(ctx.mainWindow);
    expect(box.message).toBe('Run this file? Start Grim Reaper.bat. It starts your Grim Reaper / OBS setup outside Fleet.');
    expect(box.buttons).toEqual(['Run', 'Cancel']);
    expect(box.cancelId).toBe(1);

    // A second click within 5 s -> BUSY, no second openPath.
    now += 4000;
    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: false, code: 'BUSY' });
    expect(fx.calls.openPath.length).toBe(1);

    // After the debounce: no second confirm (stored by sha256(path)), one more openPath.
    now += 1500;
    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: true });
    expect(fx.calls.openPath.length).toBe(2);
    expect(fx.electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const cfg = require('../src/store').load('zoomStudioConfig', null);
    const hash = require('node:crypto').createHash('sha256').update(bat).digest('hex');
    expect(Object.keys(cfg.launcherConfirmed)).toEqual([hash]);
    expect(JSON.stringify(cfg).includes('Start Grim Reaper')).toBe(false);

    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const s of writes) for (const c of s.mock.calls) expect(String(c[0])).not.toBe(bat);
    expect(fs.readFileSync(bat)).toEqual(bytes);
    expect(fs.statSync(bat).mtimeMs).toBe(mtime);
    const src = fs.readFileSync(require.resolve('../src/zoom/studio/launcher.js'), 'utf8');
    expect(src).not.toMatch(/require\(['"](node:)?child_process['"]\)|\bspawn\(|\bexecFile\(|\bexec\(/);
    assertNoPathInLogs(bat);
  });

  it('Cancel on the confirm -> CANCELLED, no openPath and nothing remembered', async () => {
    makeDefault();
    fx.electron.dialog.showMessageBox = vi.fn(async () => ({ response: 1 }));
    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: false, code: 'CANCELLED' });
    expect(fx.calls.openPath).toEqual([]);
    const cfg = require('../src/store').load('zoomStudioConfig', { launcherConfirmed: {} });
    expect(cfg.launcherConfirmed || {}).toEqual({});
  });

  it('nothing configured and no default -> NOT_FOUND; openPath error string -> LAUNCH_FAILED (code only in logs)', async () => {
    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: false, code: 'NOT_FOUND' });
    const bat = makeDefault();
    fx.electron.shell.openPath = vi.fn(async (p) => 'Failed to open ' + p);
    now += 10_000;
    const r = await call('zoomStudio:launcher-run');
    expect(r).toEqual({ ok: false, code: 'LAUNCH_FAILED' });
    expect(fx.electron.shell.openPath).toHaveBeenCalledTimes(1);
    const warns = logger.lines.filter((l) => l.level === 'warn');
    expect(warns.map((w) => w.args[1])).toEqual([{ op: 'run', code: 'LAUNCH_FAILED' }]);
    assertNoPathInLogs(bat);
  });

  it('the renderer can never supply a path', async () => {
    expect(await call('zoomStudio:launcher-run', { path: 'C:\\evil.bat' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(await call('zoomStudio:launcher-pick', { path: 'C:\\evil.bat' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(fx.calls.openPath).toEqual([]);
  });
});

describe('launcher-pick + validate', () => {
  it('rejects relative, UNC, device, .exe, missing, NUL and > 260-char paths without openPath; saves a valid pick', async () => {
    const good = path.join(TMP, 'tools', 'Start Grim Reaper.cmd');
    fs.mkdirSync(path.dirname(good), { recursive: true });
    fs.writeFileSync(good, '@echo off\r\n');
    const exe = path.join(TMP, 'tools', 'thing.exe');
    fs.writeFileSync(exe, 'MZ');
    const cases = [
      ['relative\\Start.bat', 'INVALID_PATH'],
      ['\\\\server\\share\\Start.bat', 'INVALID_PATH'],
      ['\\\\?\\C:\\Start.bat', 'INVALID_PATH'],
      ['//server/share/Start.bat', 'INVALID_PATH'],
      [exe, 'INVALID_PATH'],
      [path.join(TMP, 'tools', 'missing.bat'), 'NOT_FOUND'],
      [path.join(TMP, 'tools'), 'INVALID_PATH'],
      [good + '\0.bat', 'INVALID_PATH'],
      [path.join(TMP, 'x'.repeat(260) + '.bat'), 'INVALID_PATH'],
    ];
    for (const [p, code] of cases) {
      pickReturns(p);
      expect([p.slice(0, 40), await call('zoomStudio:launcher-pick')]).toEqual([p.slice(0, 40), { ok: false, code }]);
      expect(() => L.validate(p)).toThrow();
    }
    // A directory named *.bat is not a file.
    const dirBat = path.join(TMP, 'folder.bat'); fs.mkdirSync(dirBat);
    pickReturns(dirBat);
    expect(await call('zoomStudio:launcher-pick')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.calls.openPath).toEqual([]);
    expect(require('../src/store').load('zoomStudioConfig', { launcherPath: null }).launcherPath).toBe(null);

    pickReturns(null);
    expect(await call('zoomStudio:launcher-pick')).toEqual({ ok: false, code: 'CANCELLED' });
    pickReturns(good);
    expect(await call('zoomStudio:launcher-pick')).toEqual({ ok: true, path: good });
    const [parent, opts] = fx.electron.dialog.showOpenDialog.mock.calls[0];
    expect(parent).toBe(ctx.mainWindow);
    expect(opts.filters).toEqual([{ name: 'Launcher', extensions: ['bat', 'cmd'] }]);
    makeDefault();
    // A configured path wins over the default.
    expect(await call('zoomStudio:launcher-get')).toEqual({ ok: true, path: good, exists: true, isDefault: false });
    const upper = path.join(TMP, 'tools', 'GO.BAT');
    fs.writeFileSync(upper, '@echo off\r\n');
    expect(L.validate(upper)).toBe(upper);   // the extension check is case-insensitive
    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: true });
    expect(fx.calls.openPath).toEqual([[good]]);
    // The configured file disappears: get reports exists:false, run -> NOT_FOUND without openPath.
    fs.rmSync(good);
    expect(await call('zoomStudio:launcher-get')).toEqual({ ok: true, path: good, exists: false, isDefault: false });
    now += 10_000;
    expect(await call('zoomStudio:launcher-run')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.calls.openPath.length).toBe(1);
    assertNoPathInLogs(good);
  });
});
