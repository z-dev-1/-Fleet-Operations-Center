// OBS FEAT-001 (plan item 5, design §4.5): obs-launch with a fake child_process / fs — exe validation via
// exeSyntaxOk, tasklist parsing, spawn with an args array (no shell), the already-running path, spawn
// errors and the 5 s debounce. Nothing real is spawned.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const EXE = 'C:/Program Files/obs-studio/bin/64bit/obs64.exe';
const RUNNING_CSV = '"obs64.exe","12345","Console","1","180,000 K"\r\n';
const NONE = 'INFO: No tasks are running which match the specified criteria.\r\n';

let L; let logger; let cp; let fsFake; let now;

function makeCp() {
  const st = { execFile: [], spawn: [], tasklist: { out: NONE }, spawnMode: 'ok' };
  st.execFile = [];
  const api = {
    execFile(file, args, opts, cb) {
      st.execFile.push({ file, args, opts });
      const t = st.tasklist;
      setImmediate(() => (t.err ? cb(t.err, '', '') : cb(null, t.out, '')));
      return new EventEmitter();
    },
    spawn(file, args, opts) {
      const child = new EventEmitter();
      child.unrefCalls = 0;
      child.unref = () => { child.unrefCalls++; };
      st.spawn.push({ file, args, opts, child });
      if (st.spawnMode === 'throw') throw Object.assign(new Error('spawn EACCES ' + file), { code: 'EACCES' });
      setImmediate(() => (st.spawnMode === 'error' ? child.emit('error', Object.assign(new Error('spawn ENOENT ' + file), { code: 'ENOENT' })) : child.emit('spawn')));
      return child;
    },
  };
  return { api, st };
}

function makeFs(files) {
  return {
    statSync(p) {
      if (!(p in files)) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
      return { isFile: () => files[p] === 'file' };
    },
  };
}

beforeEach(() => {
  freshZoom(require);
  logger = installFakeLogger(require);
  L = require('../src/zoom/studio/obs-launch');
  cp = makeCp();
  fsFake = makeFs({ [EXE]: 'file', 'C:/obs/bin/obs64.exe': 'dir' });
  now = 100000;
  L._setDeps({ child_process: cp.api, fs: fsFake, now: () => now });
});
afterEach(() => {
  L._resetForTests(); L._setDeps(null);
  logger.restore(); freshZoom(require);
});

const codeOf = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code; } };

describe('obs-launch', () => {
  it('validateExe: INVALID_PATH via exeSyntaxOk; OBS_NOT_INSTALLED when not a file', () => {
    expect(L.DEFAULT_EXE).toBe(EXE);
    expect(L.validateExe(EXE)).toBe(EXE);
    expect(L.validateExe(null)).toBe(EXE);   // default path
    expect(codeOf(() => L.validateExe('\\\\srv\\share\\obs64.exe'))).toBe('INVALID_PATH');
    expect(codeOf(() => L.validateExe('obs64.exe'))).toBe('INVALID_PATH');
    expect(codeOf(() => L.validateExe('C:/Windows/System32/cmd.exe'))).toBe('INVALID_PATH');
    expect(codeOf(() => L.validateExe('C:/obs/bin/obs64.exe'))).toBe('OBS_NOT_INSTALLED');     // a directory
    expect(codeOf(() => L.validateExe('D:/missing/obs64.exe'))).toBe('OBS_NOT_INSTALLED');     // ENOENT
  });

  it('isRunning parses tasklist CSV and returns null on error', async () => {
    cp.st.tasklist = { out: RUNNING_CSV };
    expect(await L.isRunning()).toBe(true);
    expect(cp.st.execFile[0]).toEqual({ file: 'tasklist', args: ['/FI', 'IMAGENAME eq obs64.exe', '/NH', '/FO', 'CSV'], opts: { windowsHide: true, timeout: 3000 } });
    cp.st.tasklist = { out: '"OBS64.EXE","1","Console","1","1 K"\r\n' };
    expect(await L.isRunning()).toBe(true);
    cp.st.tasklist = { out: NONE };
    expect(await L.isRunning()).toBe(false);
    cp.st.tasklist = { out: '"notobs64.exe.bak","1"\r\n' };
    expect(await L.isRunning()).toBe(false);
    cp.st.tasklist = { err: Object.assign(new Error('tasklist failed'), { code: 'ENOENT' }) };
    expect(await L.isRunning()).toBe(null);
  });

  it('launch spawns with an args array, cwd = bin dir, detached, stdio ignore, shell:false and unref', async () => {
    const r = await L.launch(EXE);
    expect(r).toEqual({ ok: true, already: false });
    expect(cp.st.spawn).toHaveLength(1);
    const s = cp.st.spawn[0];
    expect(s.file).toBe(EXE);
    expect(s.args).toEqual(['--minimize-to-tray', '--disable-shutdown-check']);
    expect(s.opts).toEqual({ cwd: 'C:/Program Files/obs-studio/bin/64bit', detached: true, stdio: 'ignore', shell: false });
    expect(s.child.unrefCalls).toBe(1);
    expect(logger.text()).not.toContain('obs-studio');
  });

  it('launch when already running -> {ok:true, already:true} and no spawn', async () => {
    cp.st.tasklist = { out: RUNNING_CSV };
    expect(await L.launch(EXE)).toEqual({ ok: true, already: true });
    expect(cp.st.spawn).toHaveLength(0);
  });

  it('spawn error -> LAUNCH_FAILED; second launch within 5 s -> BUSY', async () => {
    cp.st.spawnMode = 'error';
    expect(await L.launch(EXE)).toEqual({ ok: false, code: 'LAUNCH_FAILED' });
    now += 4999;
    expect(await L.launch(EXE)).toEqual({ ok: false, code: 'BUSY' });
    expect(cp.st.spawn).toHaveLength(1);
    now += 1;
    cp.st.spawnMode = 'throw';
    expect(await L.launch(EXE)).toEqual({ ok: false, code: 'LAUNCH_FAILED' });
    now += 5000;
    expect(await L.launch('C:/x/cmd.exe')).toEqual({ ok: false, code: 'INVALID_PATH' });
    now += 5000;
    expect(await L.launch('D:/missing/obs64.exe')).toEqual({ ok: false, code: 'OBS_NOT_INSTALLED' });
    const t = logger.text();
    expect(t).not.toContain('obs-studio');
    expect(t).not.toContain('missing');
  });
});
