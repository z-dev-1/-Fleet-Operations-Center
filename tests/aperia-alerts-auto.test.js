// tests/aperia-alerts-auto.test.js — src/aperia/alerts-auto.js + alerts-pref.js: Tire Alerts start on their own
// once Aperia is connected (fresh data dir = ON), wait for a 'connected' status, and a saved OFF stays off,
// also after a module reload (next launch). Fake session / watcher; real pref file in a temp data dir.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const paths = require('../src/config/paths');
const AUTO = require.resolve('../src/aperia/alerts-auto.js');
const PREF = require.resolve('../src/aperia/alerts-pref.js');

function fresh() {
  for (const id of [AUTO, PREF]) delete require.cache[id];
  return { auto: require(AUTO), pref: require(PREF) };
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

let tmp;
let state;
let alerts;
let listeners;
function fakes() {
  const session = {
    status: vi.fn(() => ({ ok: true, state, secondsLeft: 100 })),
    onStatus: vi.fn((fn) => { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; }),
  };
  const watcher = {
    status: vi.fn(() => ({ alerts })),
    start: vi.fn(async () => { alerts = 'polling'; return { ok: true, status: { alerts } }; }),
  };
  return { session, watcher };
}
const emit = (s) => { for (const fn of listeners.slice()) fn(s); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-alerts-auto-'));
  paths.setDataDir(tmp);
  state = 'connected';
  alerts = 'off';
  listeners = [];
  logger.clear();
});
afterEach(() => {
  try { require(AUTO)._resetForTests(); } catch (_) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('aperia alerts-pref', () => {
  it('missing or corrupt -> enabled:true; save is atomic and round-trips', () => {
    const { pref } = fresh();
    expect(pref.filePath()).toBe(path.join(tmp, 'aperia_alerts_pref.json'));
    expect(pref.load()).toEqual({ enabled: true });
    fs.writeFileSync(pref.filePath(), '{bad');
    expect(pref.load()).toEqual({ enabled: true });
    expect(pref.save(false)).toBe(true);
    expect(fs.existsSync(pref.filePath() + '.tmp')).toBe(false);
    expect(JSON.parse(fs.readFileSync(pref.filePath(), 'utf8'))).toEqual({ version: 1, enabled: false });
    expect(pref.load()).toEqual({ enabled: false });
    expect(pref.save(true)).toBe(true);
    expect(pref.load()).toEqual({ enabled: true });
  });
});

describe('aperia alerts-auto', () => {
  it('fresh data dir and connected -> watcher.start once with ctx; repeated ensure / status does not start again', async () => {
    const { auto } = fresh();
    const f = fakes();
    const ctx = { tag: 'ctx' };
    expect(auto.start(ctx, f)).toEqual({ ok: true });
    expect(auto.start(ctx, f)).toEqual({ ok: true, already: true });
    await flush();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
    expect(f.watcher.start).toHaveBeenCalledWith({ ctx });
    emit({ state: 'connected' });
    await auto.ensure();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
    expect(logger.lines.some((l) => l.args[0] === '[aperia] alerts-auto' && l.args[1].op === 'start' && l.args[1].code === 'OK')).toBe(true);
  });

  it('concurrent ensure calls share one start', async () => {
    const { auto } = fresh();
    const f = fakes();
    let release;
    f.watcher.start = vi.fn(() => new Promise((r) => { release = () => { alerts = 'polling'; r({ ok: true }); }; }));
    auto.start({}, f);
    auto.ensure(); auto.ensure();
    emit({ state: 'connected' });
    await flush();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  it('not connected -> no start until an onStatus connected event', async () => {
    state = 'signed-out';
    const { auto } = fresh();
    const f = fakes();
    auto.start({}, f);
    await flush();
    expect(f.watcher.start).not.toHaveBeenCalled();
    emit({ state: 'connecting' });
    await flush();
    expect(f.watcher.start).not.toHaveBeenCalled();
    state = 'connected';
    emit({ state: 'connected' });
    await flush();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
  });

  it('a failed start is retried on the next connected status', async () => {
    const { auto } = fresh();
    const f = fakes();
    f.watcher.start.mockResolvedValueOnce({ ok: false, code: 'APERIA_HTTP' });
    auto.start({}, f);
    await flush();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
    emit({ state: 'connected' });
    await flush();
    expect(f.watcher.start).toHaveBeenCalledTimes(2);
  });

  it('a saved OFF -> never started, also after re-requiring the module (next launch)', async () => {
    let m = fresh();
    m.pref.save(false);
    let f = fakes();
    m.auto.start({}, f);
    emit({ state: 'connected' });
    await m.auto.ensure();
    expect(f.watcher.start).not.toHaveBeenCalled();
    m.auto._resetForTests();
    m = fresh();
    f = fakes();
    m.auto.start({}, f);
    emit({ state: 'connected' });
    await m.auto.ensure();
    expect(f.watcher.start).not.toHaveBeenCalled();
    // The user's ON (saved by start-alerts) lets it start again.
    m.pref.save(true);
    await m.auto.ensure();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
  });

  it('ensure before start() and after stop() is a no-op', async () => {
    const { auto } = fresh();
    const f = fakes();
    await auto.ensure();
    auto.start({}, f);
    await flush();
    alerts = 'off';
    auto.stop();
    expect(listeners).toHaveLength(0);
    await auto.ensure();
    expect(f.watcher.start).toHaveBeenCalledTimes(1);
  });

  it('static: no timers; app.js starts it once right after the Aperia auto-auth start; auto-auth stays watcher-free', () => {
    const ROOT = path.resolve(path.dirname(AUTO), '..', '..');
    const src = fs.readFileSync(AUTO, 'utf8');
    for (const bad of ['setInterval', 'setTimeout(']) expect(src, bad).not.toContain(bad);
    const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const call = "require('./aperia/alerts-auto').start(_ctx)";
    expect(app.split(call).length - 1).toBe(1);
    expect(app.indexOf(call)).toBeGreaterThan(app.indexOf("require('./aperia/auto-auth').start(_ctx)"));
    expect(fs.readFileSync(path.join(ROOT, 'src', 'aperia', 'auto-auth.js'), 'utf8')).not.toContain('watcher');
  });
});
