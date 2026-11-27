// tests/standby-daemon-freshness.test.js — the standby fleet refresh records the
// last good build in health/fleet-freshness (lastOkAt) like the primary loaders,
// and does not on an empty or failed build.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
require('../src/config/paths').setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'standby-freshness-')));

function injectFake(rel, exportsObj) {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('../src/cluster/index', { mayLivePull: () => true, mayRunProduction: () => true });
const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const ff = require('../src/health/fleet-freshness');
const daemon = require('../src/cluster/standby-daemon');

const ROWS = [
  { equipmentId: 'A1', workRequestId: 'wr-1', lifecycleState: 'Unavailable' },
  { equipmentId: 'B2', workRequestId: 'wr-2', lifecycleState: 'Unavailable' },
  { equipmentId: 'C3', workRequestId: 'wr-3', lifecycleState: 'Unavailable' },
];

let ok;
beforeEach(() => {
  daemon._reset();
  store.save('fleetData', {}); store.save('notesStore', {}); store.save('uptakeHash', {});
  ok = vi.spyOn(ff, 'recordBuildOk').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); daemon._reset(); });

describe('standby-daemon _tickFleet -> fleet-freshness', () => {
  it('a successful build records recordBuildOk with the saved row count', async () => {
    vi.spyOn(aap, 'buildFleetDataset').mockImplementation(async () => ({ rows: ROWS.slice(), count: 3, unavailableCount: 3 }));
    await daemon._tickFleet();
    expect(store.load('fleetData', {}).count).toBe(3);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledWith({ count: 3 });
  });

  it('an empty build does not record', async () => {
    vi.spyOn(aap, 'buildFleetDataset').mockImplementation(async () => ({ rows: [], count: 0, unavailableCount: 0 }));
    await daemon._tickFleet();
    expect(ok).not.toHaveBeenCalled();
  });

  it('a failed build does not record', async () => {
    vi.spyOn(aap, 'buildFleetDataset').mockImplementation(async () => { throw new Error('AAP down'); });
    await daemon._tickFleet();
    expect(ok).not.toHaveBeenCalled();
  });

  it('the real module gets lastOkAt/lastOkCount set by a successful standby build', async () => {
    ok.mockRestore();
    ff._resetForTests();
    ff.init({ store });
    vi.spyOn(aap, 'buildFleetDataset').mockImplementation(async () => ({ rows: ROWS.slice(), count: 3, unavailableCount: 3 }));
    expect(ff.getSnapshot().lastOkAt).toBe(null);
    await daemon._tickFleet();
    const s = ff.getSnapshot();
    expect(typeof s.lastOkAt).toBe('number');
    expect(s.lastOkCount).toBe(3);
    ff._resetForTests();
  });
});
