// FEAT-003 (plan item 9, design-review F6): validators for the 7 zoomStudio:obs-* channels.
// obs-auth (exeSyntaxOk) is required lazily inside the obs-config-set validator only.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { freshZoom } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);

const obsAuthLoaded = () => Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').endsWith('/src/zoom/studio/obs-auth.js'));

function load() {
  freshZoom(require);
  return require('../src/zoom/validate');
}

function fieldOf(fn) {
  try { fn(); return 'no-throw'; } catch (e) {
    expect(e.code).toBe('INVALID_INPUT');
    return e.extra && e.extra.field;
  }
}

afterEach(() => freshZoom(require));

describe('obs validators', () => {
  it('obs-config-set: host/port/exePath/password rules -> INVALID_INPUT {field}', () => {
    const V = load().validators['zoomStudio:obs-config-set'];
    const EXE = 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';
    // accepted
    expect(V(undefined)).toEqual({});
    expect(V({})).toEqual({});
    expect(V({ host: '127.0.0.1', port: 4455, exePath: null, password: null })).toEqual({ host: '127.0.0.1', port: 4455, exePath: null, password: null });
    expect(V({ host: 'localhost' })).toEqual({ host: 'localhost' });
    expect(V({ port: 1024 })).toEqual({ port: 1024 });
    expect(V({ port: 65535 })).toEqual({ port: 65535 });
    expect(V({ exePath: EXE })).toEqual({ exePath: EXE });
    expect(V({ exePath: 'C:/Program Files/obs-studio/bin/64bit/OBS64.EXE' }).exePath).toBe('C:/Program Files/obs-studio/bin/64bit/OBS64.EXE');
    expect(V({ password: '' })).toEqual({ password: '' });
    expect(V({ password: 'p'.repeat(256) }).password.length).toBe(256);
    // rejected, with the field
    expect(fieldOf(() => V(null))).toBe('payload');
    expect(fieldOf(() => V([]))).toBe('payload');
    expect(fieldOf(() => V({ url: 'ws://evil' }))).toBe('payload');
    for (const h of ['0.0.0.0', '192.168.1.5', 'LOCALHOST', '127.0.0.2', '', 1, null]) expect(fieldOf(() => V({ host: h }))).toBe('host');
    for (const p of [1023, 65536, 0, -1, 4455.5, '4455', null, NaN]) expect(fieldOf(() => V({ port: p }))).toBe('port');
    for (const x of ['obs64.exe', 'C:/obs/obs32.exe', '\\\\server\\share\\obs64.exe', '//server/share/obs64.exe',
      'C:/' + 'a'.repeat(260) + '/obs64.exe', 'C:/obs/obs64.exe\u0000', '', 5]) {
      expect(fieldOf(() => V({ exePath: x }))).toBe('exePath');
    }
    for (const pw of ['p'.repeat(257), 'a\u0000b', 5, {}, true]) expect(fieldOf(() => V({ password: pw }))).toBe('password');
  });

  it('no-payload obs channels accept only undefined or {}', () => {
    const { validators } = load();
    for (const ch of ['zoomStudio:obs-status', 'zoomStudio:obs-connect', 'zoomStudio:obs-disconnect',
      'zoomStudio:obs-start', 'zoomStudio:obs-stop', 'zoomStudio:obs-launch']) {
      const V = validators[ch];
      expect(typeof V).toBe('function');
      expect(V(undefined)).toEqual({});
      expect(V({})).toEqual({});
      for (const bad of [null, [], 'x', 1, { host: '127.0.0.1' }, { reason: 'camera-lost' }]) expect([ch, fieldOf(() => V(bad))]).toEqual([ch, 'payload']);
    }
  });

  it('F6: requiring validate.js does not load obs-auth; the obs-config-set validator loads it on first use', () => {
    freshZoom(require);
    expect(obsAuthLoaded()).toBe(false);
    const { validators } = require('../src/zoom/validate');
    expect(obsAuthLoaded()).toBe(false);
    // Other validators, including the no-payload obs ones, never load it.
    validators['zoomStudio:obs-status'](undefined);
    validators['zoomStudio:obs-start']({});
    validators['zoomStudio:media-status'](undefined);
    expect(obsAuthLoaded()).toBe(false);
    validators['zoomStudio:obs-config-set']({ port: 4455 });
    expect(obsAuthLoaded()).toBe(true);
  });
});
