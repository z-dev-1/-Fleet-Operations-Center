// DBR DATA pull = 📊 DBR — Fleet Health: dbr_pull.pullFleetHealth rebuilds today's Fleet
// Health snapshot (ipc/fleet-dbr buildNow), blocks as stale until fleet data synced today,
// then AI-drafts pending rows (draftPending). The QuickSight scraper is gone.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dbr-retire-'));
require('../src/config/paths').setDataDir(tmpDir);
const dbr = require('../src/scrapers/dbr_pull');

const NOW = new Date(2026, 10, 24, 9, 0, 0);
const model = (syncedAt) => ({
  builtAt: NOW.toISOString(), fleetSyncedAt: syncedAt,
  rows: [{ key: 'A|X', pair: { total: 3, down: 1 } }, { key: 'A|Y', pair: { total: 2, down: 0 } }],
});
const fake = (buildRes, draftRes) => ({
  buildNow: vi.fn(() => buildRes),
  draftPending: vi.fn(async () => draftRes || { ok: true, eligible: 1, drafted: 1, failed: 0, busy: 0 }),
});

describe('dbr_pull.pullFleetHealth', () => {
  it('fleet synced today: builds, drafts, reports rows', async () => {
    const f = fake({ ok: true, model: model(new Date(2026, 10, 24, 7, 30).toISOString()) });
    const r = await dbr.pullFleetHealth({ fleetDbr: f, now: NOW });
    expect(r).toMatchObject({ ok: true, fresh: true, rowCount: 2, downRows: 1, drafts: { drafted: 1, eligible: 1 } });
    expect(r.data.dataAsOf).toBe('2026-11-24');
    expect(f.buildNow).toHaveBeenCalledTimes(1);
    expect(f.draftPending).toHaveBeenCalledTimes(1);
  });

  it('fleet last synced yesterday: stale, no drafts', async () => {
    const f = fake({ ok: true, model: model(new Date(2026, 10, 23, 18, 0).toISOString()) });
    expect(await dbr.pullFleetHealth({ fleetDbr: f, now: NOW })).toEqual({ ok: false, stale: true, dataAsOf: '2026-11-23' });
    expect(f.draftPending).not.toHaveBeenCalled();
  });

  it('no fleet data yet: stale (the sweep retries)', async () => {
    const f = fake({ ok: false, code: 'no-fleet-data' });
    expect(await dbr.pullFleetHealth({ fleetDbr: f, now: NOW })).toEqual({ ok: false, stale: true, dataAsOf: null });
  });

  it('Fleet Health off: error, no drafts', async () => {
    const f = fake({ ok: false, code: 'off' });
    const r = await dbr.pullFleetHealth({ fleetDbr: f, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Fleet Health is off/);
    expect(f.draftPending).not.toHaveBeenCalled();
  });

  it('a draft failure still completes the pull', async () => {
    const f = fake({ ok: true, model: model(new Date(2026, 10, 24, 8, 0).toISOString()) });
    f.draftPending = vi.fn(async () => { throw new Error('ai down'); });
    const r = await dbr.pullFleetHealth({ fleetDbr: f, now: NOW });
    expect(r).toMatchObject({ ok: true, drafts: { ok: false, code: 'draft-error' } });
  });

  it('keeps the Pending Estimates "mine" helpers and drops the QuickSight pulls', () => {
    expect(typeof dbr._loadMySitesAndCarriers).toBe('function');
    expect(typeof dbr._rowIsMine).toBe('function');
    expect(dbr.pullAfp).toBeUndefined();
    expect(dbr.pullDsp).toBeUndefined();
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'scrapers', 'quicksight_dbr.js'))).toBe(false);
  });

  it('the scheduler still exports runDbrNow and the pipeline runs one DBR job', () => {
    expect(typeof require('../src/scheduler').runDbrNow).toBe('function');
    const p = require('../src/scheduler/pipeline');
    expect(typeof p.runDbrJob).toBe('function');
    expect(p.runDbrAfpJob).toBeUndefined();
    expect(p.runDbrDspJob).toBeUndefined();
  });
});
