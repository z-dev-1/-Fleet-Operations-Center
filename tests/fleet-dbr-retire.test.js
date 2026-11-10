// Fleet DBR retires the QuickSight DBR pull: with dbr.fleetData on, dbr_pull.pullAfp/pullDsp
// return a retired no-op (no capture, no AI, no store write); with it off they run the legacy
// path. The scheduler is untouched and still exports runDbrNow.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dbr-retire-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const qs = require('../src/scrapers/quicksight_dbr');
const dbr = require('../src/scrapers/dbr_pull');

const ENV = 'FLEET_DBR_FLEET_DATA';
let prevEnv;
let afp, dsp, save;
beforeEach(() => {
  prevEnv = process.env[ENV];
  afp = vi.spyOn(qs, 'captureAfpText').mockResolvedValue({ ok: false, error: 'capture mocked' });
  dsp = vi.spyOn(qs, 'captureDspText').mockResolvedValue({ ok: false, error: 'capture mocked' });
  save = vi.spyOn(store, 'save');
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV]; else process.env[ENV] = prevEnv;
  vi.restoreAllMocks();
});

const RETIRED = { ok: true, fresh: true, retired: true, rowCount: 0, data: { dataAsOf: null, retired: true } };

describe('dbr_pull retire gate', () => {
  it('flag on: AFP and DSP pulls are retired no-ops (no capture, no store.save)', async () => {
    process.env[ENV] = '1';
    expect(await dbr.pullAfp()).toEqual(RETIRED);
    expect(await dbr.pullDsp()).toEqual(RETIRED);
    expect(afp).not.toHaveBeenCalled();
    expect(dsp).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('default (no env, no settings) is on', async () => {
    delete process.env[ENV];
    expect(await dbr.pullAfp()).toEqual(RETIRED);
    expect(afp).not.toHaveBeenCalled();
  });

  it('flag off: the legacy QuickSight path runs (capture called; mocked failure -> ok:false)', async () => {
    process.env[ENV] = '0';
    expect(await dbr.pullAfp()).toEqual({ ok: false, error: 'capture mocked' });
    expect(await dbr.pullDsp()).toEqual({ ok: false, error: 'capture mocked' });
    expect(afp).toHaveBeenCalledTimes(1);
    expect(dsp).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('the scheduler still exports runDbrNow', () => {
    const scheduler = require('../src/scheduler');
    expect(typeof scheduler.runDbrNow).toBe('function');
  });
});
