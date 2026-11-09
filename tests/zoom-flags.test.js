// FEAT-A1 / AC-2: Zoom flag resolver matrix, alias, env precedence, effective chain, warnings, loadZoom fallback.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');
const zflags = require('../src/zoom/flags');

const S = (zoom) => ({ zoom });

describe('resolveZoomFlags', () => {
  it('defaults every flag OFF with no settings and no env', () => {
    const f = pf.resolveZoomFlags({}, {});
    expect(f).toMatchObject({ enabled: false, data: false, studio: false, write: false });
    expect(f.effective).toEqual({ enabled: false, data: false, studio: false, write: false });
    expect(f.warnings).toEqual([]);
  });

  it('exports ZOOM_ENV names', () => {
    expect(pf.ZOOM_ENV).toEqual({ enabled: 'FLEET_ZOOM', data: 'FLEET_ZOOM_DATA', studio: 'FLEET_ZOOM_STUDIO', write: 'FLEET_ZOOM_WRITE' });
    expect(typeof pf.loadZoom).toBe('function');
  });

  it('settings values must be === true', () => {
    const f = pf.resolveZoomFlags(S({ enabled: 'true', data: 1, studio: {}, write: true }), {});
    expect(f.enabled).toBe(false);
    expect(f.data).toBe(false);
    expect(f.studio).toBe(false);
    expect(f.write).toBe(true);
    expect(f.effective.write).toBe(false);
  });

  const matrix = [
    // [settings.zoom, effective]
    [{ enabled: true }, { enabled: true, data: false, studio: false, write: false }],
    [{ enabled: true, data: true }, { enabled: true, data: true, studio: false, write: false }],
    [{ enabled: true, studio: true }, { enabled: true, data: false, studio: true, write: false }],
    [{ enabled: true, data: true, write: true }, { enabled: true, data: true, studio: false, write: true }],
    [{ enabled: true, studio: true, write: true }, { enabled: true, data: false, studio: true, write: false }],
    [{ data: true, studio: true, write: true }, { enabled: false, data: false, studio: false, write: false }],
    [{ enabled: true, data: true, studio: true, write: true }, { enabled: true, data: true, studio: true, write: true }],
  ];
  for (const [z, eff] of matrix) {
    it('effective chain for ' + JSON.stringify(z), () => {
      expect(pf.resolveZoomFlags(S(z), {}).effective).toEqual(eff);
    });
  }

  it('env wins over settings in both directions', () => {
    const on = pf.resolveZoomFlags({}, { FLEET_ZOOM: '1', FLEET_ZOOM_DATA: '1', FLEET_ZOOM_STUDIO: '1', FLEET_ZOOM_WRITE: '1' });
    expect(on.effective).toEqual({ enabled: true, data: true, studio: true, write: true });
    const off = pf.resolveZoomFlags(S({ enabled: true, data: true, studio: true, write: true }), { FLEET_ZOOM: '0' });
    expect(off.effective).toEqual({ enabled: false, data: false, studio: false, write: false });
    expect(off.data).toBe(true);
  });

  it('env values other than 0/1 are ignored', () => {
    const f = pf.resolveZoomFlags(S({ enabled: true, data: true }), { FLEET_ZOOM: 'yes', FLEET_ZOOM_DATA: 'true' });
    expect(f.effective.data).toBe(true);
  });

  it('FLEET_ZOOM_ENABLED is an alias used only when FLEET_ZOOM is unset', () => {
    expect(pf.resolveZoomFlags({}, { FLEET_ZOOM_ENABLED: '1', FLEET_ZOOM_DATA: '1' }).effective.data).toBe(true);
    expect(pf.resolveZoomFlags({}, { FLEET_ZOOM: '0', FLEET_ZOOM_ENABLED: '1', FLEET_ZOOM_DATA: '1' }).effective.enabled).toBe(false);
    expect(pf.resolveZoomFlags(S({ enabled: true }), { FLEET_ZOOM_ENABLED: '0' }).enabled).toBe(false);
  });

  it('warnings: write-needs-data and enabled-without-area', () => {
    expect(pf.resolveZoomFlags(S({ enabled: true, write: true }), {}).warnings).toEqual(['write-needs-data', 'enabled-without-area']);
    expect(pf.resolveZoomFlags(S({ enabled: true }), {}).warnings).toEqual(['enabled-without-area']);
    expect(pf.resolveZoomFlags(S({ enabled: true, studio: true }), {}).warnings).toEqual([]);
    expect(pf.resolveZoomFlags(S({ write: true }), {}).warnings).toEqual(['write-needs-data']);
  });
});

describe('loadZoom', () => {
  it('reads settings through deps.load and env through deps.env', () => {
    const f = pf.loadZoom({ load: () => ({ zoom: { enabled: true, data: true } }), env: {} });
    expect(f.effective.data).toBe(true);
  });
  it('falls back to all-OFF when the store throws', () => {
    const f = pf.loadZoom({ load: () => { throw new Error('boom'); }, env: {} });
    expect(f.effective).toEqual({ enabled: false, data: false, studio: false, write: false });
  });
  it('falls back to all-OFF when env access throws', () => {
    const env = new Proxy({}, { get() { throw new Error('env'); } });
    const f = pf.loadZoom({ load: () => ({ zoom: { enabled: true, data: true } }), env });
    expect(f.effective.data).toBe(false);
  });
  it('the test setup forces the FLEET_ZOOM* env OFF', () => {
    for (const k of ['FLEET_ZOOM', 'FLEET_ZOOM_ENABLED', 'FLEET_ZOOM_DATA', 'FLEET_ZOOM_STUDIO', 'FLEET_ZOOM_WRITE']) expect(process.env[k]).toBe('0');
  });
});

describe('src/zoom/flags memo', () => {
  afterEach(() => zflags._setForTests(null));
  it('_prime sets once; _setForTests replaces; get() memoizes', () => {
    const a = pf.resolveZoomFlags(S({ enabled: true, data: true }), {});
    const b = pf.resolveZoomFlags({}, {});
    zflags._prime(a);
    zflags._prime(b);
    expect(zflags.get()).toBe(a);
    zflags._setForTests(b);
    expect(zflags.get()).toBe(b);
    zflags._setForTests(null);
    const g = zflags.get();
    expect(zflags.get()).toBe(g);
    expect(g.effective.data).toBe(false);
  });
});
