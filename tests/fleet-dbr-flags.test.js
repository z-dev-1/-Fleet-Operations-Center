// Fleet DBR flags (default ON/ON, env '0'/'1' wins, junk ignored, never throws) and the
// perf-flags Zoom Meet restore (the module must load and export resolveZoomMeetFlags).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const flags = require('../src/config/perf-flags');
const { resolveFleetDbrFlags, loadFleetDbr, FLEET_DBR_ENV } = flags;

describe('resolveFleetDbrFlags', () => {
  it('defaults to enabled + aiDraft', () => {
    expect(resolveFleetDbrFlags({}, {})).toEqual({ enabled: true, aiDraft: true });
    expect(resolveFleetDbrFlags(undefined, undefined)).toEqual({ enabled: true, aiDraft: true });
    expect(resolveFleetDbrFlags({ dbr: {} }, {})).toEqual({ enabled: true, aiDraft: true });
  });
  it('dbr.fleetData:false turns both off', () => {
    expect(resolveFleetDbrFlags({ dbr: { fleetData: false } }, {})).toEqual({ enabled: false, aiDraft: false });
    expect(resolveFleetDbrFlags({ dbr: { fleetData: false, fleetDataAi: true } }, {})).toEqual({ enabled: false, aiDraft: false });
  });
  it('dbr.fleetDataAi:false turns only aiDraft off', () => {
    expect(resolveFleetDbrFlags({ dbr: { fleetDataAi: false } }, {})).toEqual({ enabled: true, aiDraft: false });
  });
  it("env '0'/'1' wins over settings", () => {
    expect(resolveFleetDbrFlags({}, { FLEET_DBR_FLEET_DATA: '0' })).toEqual({ enabled: false, aiDraft: false });
    expect(resolveFleetDbrFlags({ dbr: { fleetData: false } }, { FLEET_DBR_FLEET_DATA: '1' })).toEqual({ enabled: true, aiDraft: true });
    expect(resolveFleetDbrFlags({}, { FLEET_DBR_FLEET_DATA_AI: '0' })).toEqual({ enabled: true, aiDraft: false });
    expect(resolveFleetDbrFlags({ dbr: { fleetDataAi: false } }, { FLEET_DBR_FLEET_DATA_AI: '1' })).toEqual({ enabled: true, aiDraft: true });
  });
  it('junk env values are ignored', () => {
    for (const v of ['yes', 'true', '', 'off', '2']) {
      expect(resolveFleetDbrFlags({ dbr: { fleetData: false } }, { FLEET_DBR_FLEET_DATA: v }).enabled).toBe(false);
      expect(resolveFleetDbrFlags({}, { FLEET_DBR_FLEET_DATA: v, FLEET_DBR_FLEET_DATA_AI: v })).toEqual({ enabled: true, aiDraft: true });
    }
  });
  it('exports the env names', () => {
    expect(FLEET_DBR_ENV).toEqual({ enabled: 'FLEET_DBR_FLEET_DATA', ai: 'FLEET_DBR_FLEET_DATA_AI' });
  });
});

describe('loadFleetDbr', () => {
  it('reads settings through the injected load', () => {
    expect(loadFleetDbr({ env: {}, load: () => ({ dbr: { fleetDataAi: false } }) })).toEqual({ enabled: true, aiDraft: false });
  });
  it('load throwing -> ON/ON', () => {
    expect(loadFleetDbr({ env: {}, load: () => { throw new Error('boom'); } })).toEqual({ enabled: true, aiDraft: true });
  });
  it('null settings -> ON/ON; env still applies', () => {
    expect(loadFleetDbr({ env: { FLEET_DBR_FLEET_DATA: '0' }, load: () => null })).toEqual({ enabled: false, aiDraft: false });
  });
  it('is not memoized', () => {
    let s = {};
    const deps = { env: {}, load: () => s };
    expect(loadFleetDbr(deps).enabled).toBe(true);
    s = { dbr: { fleetData: false } };
    expect(loadFleetDbr(deps).enabled).toBe(false);
  });
});

describe('perf-flags loadability (NFR5: the module itself is not modified)', () => {
  it('loads and exposes the Zoom Meet, Zoom (OBS) and Fleet DBR resolvers', () => {
    const fresh = require('../src/config/perf-flags');
    for (const k of ['resolveZoomMeetFlags', 'loadZoomMeet', 'resolveZoomFlags', 'loadZoom', 'resolveFleetDbrFlags', 'loadFleetDbr']) {
      expect(typeof fresh[k], k).toBe('function');
    }
  });
  it('dbr.fleetDataAi:false -> aiDraft false', () => {
    expect(resolveFleetDbrFlags({ dbr: { fleetDataAi: false } }, {}).aiDraft).toBe(false);
  });
});

describe('perf-flags Zoom Meet restore', () => {
  it('module loads and resolveZoomMeetFlags / loadZoomMeet are functions', () => {
    expect(typeof flags.resolveZoomMeetFlags).toBe('function');
    expect(typeof flags.loadZoomMeet).toBe('function');
    expect(flags.ZOOM_MEET_ENV).toBe('FLEET_ZOOM_ENABLED');
    expect(flags.resolveZoomMeetFlags({}, {})).toEqual({
      enabled: false, portalHost: 'amazon.zoom.us', webAppHost: 'app.zoom.us', miniPlayer: 'corner',
    });
  });
});
