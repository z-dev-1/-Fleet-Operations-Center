import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'aap-esc-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

// Capture IPC handlers by faking electron.ipcMain in the require cache BEFORE
// loading the IPC module (same harness as tests/fas-contacts-ipc.test.js).
const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });

const aap = require('../src/scrapers/aap_api');
require('../src/ipc/aap-api').registerAapApiIPC({});
const call = (ch, arg) => handlers[ch]({}, arg);

const USER_ON = { userName: 'zilasant', activeFeatures: ['ESCALATE_SERVICE'] };
const USER_OFF = { userName: 'zilasant', activeFeatures: [] };
const OPTIONS = [{ value: 'MCS_LEAD', displayText: 'MCS Lead' }, { value: 'FAS', displayText: 'FAS' }];

afterEach(() => { vi.restoreAllMocks(); });

describe('aap-api:escalation-options', () => {
  it('feature off -> enabled:false without fetching teams', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_OFF);
    const opts = vi.spyOn(aap, 'getEscalationOptions').mockResolvedValue(OPTIONS);
    const r = await call('aap-api:escalation-options', { aaid: 'aaid_1', workRequestId: 'WR-1' });
    expect(r).toEqual({ ok: true, enabled: false, options: [], current: [] });
    expect(opts).not.toHaveBeenCalled();
  });

  it('resolves fleetId from a wrapped asset and reads current from the service', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    const getAsset = vi.spyOn(aap, 'getAsset').mockResolvedValue({ asset: { fleetId: 'fleet-A' } });
    const opts = vi.spyOn(aap, 'getEscalationOptions').mockResolvedValue(OPTIONS);
    vi.spyOn(aap, 'getService').mockResolvedValue({ escalations: ['FAS'] });
    const r = await call('aap-api:escalation-options', { aaid: 'aaid_1', workRequestId: 'WR-1' });
    expect(getAsset).toHaveBeenCalledWith('aaid_1');
    expect(opts).toHaveBeenCalledWith('fleet-A');
    expect(r).toEqual({ ok: true, enabled: true, fleetId: 'fleet-A', options: OPTIONS, current: ['FAS'] });
  });

  it('resolves fleetId from a bare asset; no WR -> current []', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    vi.spyOn(aap, 'getAsset').mockResolvedValue({ fleetId: 'fleet-B' });
    vi.spyOn(aap, 'getEscalationOptions').mockResolvedValue(OPTIONS);
    const svc = vi.spyOn(aap, 'getService');
    const r = await call('aap-api:escalation-options', { aaid: 'aaid_1' });
    expect(r.fleetId).toBe('fleet-B');
    expect(r.current).toEqual([]);
    expect(svc).not.toHaveBeenCalled();
  });

  it('accepts a bare fleetId string; getService failure -> current [] + currentError', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    const getAsset = vi.spyOn(aap, 'getAsset');
    vi.spyOn(aap, 'getEscalationOptions').mockResolvedValue(OPTIONS);
    const r1 = await call('aap-api:escalation-options', 'fleet-C');
    expect(r1).toMatchObject({ ok: true, enabled: true, fleetId: 'fleet-C' });
    vi.spyOn(aap, 'getService').mockRejectedValue(new Error('500'));
    const r2 = await call('aap-api:escalation-options', { fleetId: 'fleet-C', workRequestId: 'WR-1' });
    expect(r2.current).toEqual([]);
    expect(r2.currentError).toBe('500');
    expect(getAsset).not.toHaveBeenCalled();
  });

  it('no fleetId on the asset -> NO_FLEET_ID', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    vi.spyOn(aap, 'getAsset').mockResolvedValue({});
    const r = await call('aap-api:escalation-options', { aaid: 'aaid_1' });
    expect(r).toEqual({ ok: false, error: 'Could not resolve fleetId', code: 'NO_FLEET_ID' });
  });
});

describe('aap-api:update-escalations', () => {
  it('passes the server alias as createdBy and ignores payload.createdBy', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    const upd = vi.spyOn(aap, 'updateEscalations').mockResolvedValue({ ok: true, response: { status: 'OK' }, add: ['MCS_LEAD'], remove: [] });
    vi.spyOn(aap, 'getService').mockResolvedValue({ escalations: ['MCS_LEAD'] });
    const r = await call('aap-api:update-escalations', {
      workRequestId: 'WR-1', aaid: 'aaid_1', add: ['MCS_LEAD'], comment: 'Needs lead', createdBy: 'evil',
    });
    expect(upd).toHaveBeenCalledWith({ workRequestId: 'WR-1', aaid: 'aaid_1', add: ['MCS_LEAD'], remove: [], comment: 'Needs lead', createdBy: 'zilasant' });
    expect(r).toEqual({ ok: true, current: ['MCS_LEAD'], response: { status: 'OK' } });
  });

  it('feature off blocks the update', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_OFF);
    const upd = vi.spyOn(aap, 'updateEscalations').mockResolvedValue({ ok: true });
    const r = await call('aap-api:update-escalations', { workRequestId: 'WR-1', aaid: 'aaid_1', add: ['MCS_LEAD'], comment: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'ESCALATE_NOT_ENABLED' });
    expect(upd).not.toHaveBeenCalled();
  });

  it('no alias -> NO_USER_ALIAS', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue({ activeFeatures: ['ESCALATE_SERVICE'] });
    const upd = vi.spyOn(aap, 'updateEscalations').mockResolvedValue({ ok: true });
    const r = await call('aap-api:update-escalations', { workRequestId: 'WR-1', aaid: 'aaid_1', add: ['MCS_LEAD'], comment: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'NO_USER_ALIAS' });
    expect(upd).not.toHaveBeenCalled();
  });

  it('rejects non-array add', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    const upd = vi.spyOn(aap, 'updateEscalations').mockResolvedValue({ ok: true });
    const r = await call('aap-api:update-escalations', { workRequestId: 'WR-1', aaid: 'aaid_1', add: 'MCS_LEAD', comment: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'ESCALATION_INVALID' });
    expect(upd).not.toHaveBeenCalled();
  });

  it('invalid change surfaces ESCALATION_INVALID (real updateEscalations rejects in validation)', async () => {
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue(USER_ON);
    // Call-through spy: the REAL updateEscalations runs and must reject with
    // ESCALATION_INVALID during body validation (before any POST).
    const upd = vi.spyOn(aap, 'updateEscalations');
    const r = await call('aap-api:update-escalations', { workRequestId: 'WR-1', aaid: 'aaid_1', add: ['MCS_LEAD'], comment: '' });
    expect(r).toMatchObject({ ok: false, code: 'ESCALATION_INVALID' });
    expect(upd).toHaveBeenCalledTimes(1);
    await expect(upd.mock.results[0].value).rejects.toMatchObject({ code: 'ESCALATION_INVALID' });
  });
});

describe('aap-api:escalation-suggest', () => {
  it('returns team:null without calling AI when every option is already applied', async () => {
    const r = await call('aap-api:escalation-suggest', { unit: '320160', options: OPTIONS, current: ['MCS_LEAD', 'FAS'] });
    expect(r.ok).toBe(true);
    expect(r.suggestion.team).toBeNull();
    expect(r.suggestion.source).toBe('rules');
  });
  it('rejects a missing unit', async () => {
    const r = await call('aap-api:escalation-suggest', { options: OPTIONS });
    expect(r.ok).toBe(false);
  });
});
