// tests/workers-app-wiring.test.js — Phase 5 app.js wiring for the worker
// supervisor (init before registerAllIPC, before-quit → onBeforeQuit,
// will-quit → onWillQuit, never preventDefault). app.js requires electron at
// top level, so it is checked as text; the hooks themselves are exercised on
// an uninitialized supervisor (the all-flags-off default).
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const APP_SRC = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Text of the `app.on('<event>', () => { … });` handler body.
function handlerBody(event) {
  const start = APP_SRC.indexOf(`app.on('${event}'`);
  if (start < 0) return null;
  const end = APP_SRC.indexOf('\n});', start);
  const lineEnd = APP_SRC.indexOf('\n', start);
  // single-line handler
  if (APP_SRC.slice(start, lineEnd).trim().endsWith('});')) return APP_SRC.slice(start, lineEnd);
  return APP_SRC.slice(start, end + 4);
}

describe('workers app wiring', () => {
  it('init runs before registerAllIPC', () => {
    const iInit = APP_SRC.indexOf("require('./workers/supervisor').init(");
    const iIpc = APP_SRC.indexOf('registerAllIPC(_ctx)');
    expect(iInit).toBeGreaterThan(0);
    expect(iIpc).toBeGreaterThan(0);
    expect(iInit).toBeLessThan(iIpc);
    expect(APP_SRC).toContain('notify: (n) => _ctx.pushBubbleNotification(n)');
    expect(APP_SRC).toContain("log.debug('[workers] supervisor disabled (all loops on legacy timers)')");
  });

  it('before-quit calls onBeforeQuit exactly once, after cluster.stop', () => {
    expect(APP_SRC.split("app.on('before-quit'").length - 1).toBe(1);
    const body = stripComments(handlerBody('before-quit'));
    expect(body.split('onBeforeQuit()').length - 1).toBe(1);
    expect(body.indexOf("require('./cluster').stop()")).toBeGreaterThan(0);
    expect(body.indexOf('onBeforeQuit()')).toBeGreaterThan(body.indexOf("require('./cluster').stop()"));
    expect(body).toContain("require.cache[p]");
  });

  it('one will-quit listener calling onWillQuit', () => {
    expect(APP_SRC.split("app.on('will-quit'").length - 1).toBe(1);
    const body = handlerBody('will-quit');
    expect(body.split('onWillQuit()').length - 1).toBe(1);
    expect(body).toContain("require.cache[p]");
  });

  it('no preventDefault in either hook', () => {
    expect(stripComments(handlerBody('before-quit'))).not.toMatch(/preventDefault/);
    expect(stripComments(handlerBody('will-quit'))).not.toMatch(/preventDefault/);
    // the restart path named in the comment is Ctrl+R, never Ctrl+Shift+R
    expect(handlerBody('before-quit')).toContain('Ctrl+R');
    expect(handlerBody('before-quit')).not.toContain('Ctrl+Shift+R');
  });

  it('onBeforeQuit/onWillQuit are silent no-ops when uninitialized', async () => {
    const logPath = require.resolve('../src/utils/logger');
    const supPath = require.resolve('../src/workers/supervisor');
    const realLog = require.cache[logPath];
    const calls = [];
    const fake = (ns) => {
      const rec = (level) => (...a) => calls.push({ ns, level, a });
      return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
    };
    fake.createLogger = fake; fake.setLogDir = () => {}; fake.setLevel = () => {}; fake.setSilent = () => {};
    fake.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: fake };
    delete require.cache[supPath];
    vi.useFakeTimers();
    try {
      const sup = require('../src/workers/supervisor');
      const before = sup.getStatus();
      expect(sup.onBeforeQuit()).toBeUndefined();
      expect(sup.onWillQuit()).toBeUndefined();
      expect(sup.getStatus()).toEqual(before);
      expect(before).toEqual({ enabled: false, workers: [] });
      expect(vi.getTimerCount()).toBe(0);
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      delete require.cache[supPath];
      if (realLog) require.cache[logPath] = realLog; else delete require.cache[logPath];
    }
  });
});
