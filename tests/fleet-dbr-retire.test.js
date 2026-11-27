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
    expect(r.data.dataAsOf).toBe(new Date(2026, 10, 24, 7, 30).toISOString());
    expect(f.buildNow).toHaveBeenCalledTimes(1);
    expect(f.draftPending).toHaveBeenCalledTimes(1);
  });

  it('fleet last synced yesterday: stale, no drafts', async () => {
    const f = fake({ ok: true, model: model(new Date(2026, 10, 23, 18, 0).toISOString()) });
    expect(await dbr.pullFleetHealth({ fleetDbr: f, now: NOW })).toEqual({ ok: false, stale: true, dataAsOf: new Date(2026, 10, 23, 18, 0).toISOString() });
    expect(f.draftPending).not.toHaveBeenCalled();
  });

  // Gate = model.dataFreshness.status (the panel's rule), not the re-stamped fleetSyncedAt.
  const withFreshness = (syncedAt, df) => Object.assign(model(syncedAt), { dataFreshness: df });
  it('syncedAt today but lastOkAt (last AAP build) yesterday: stale, no drafts, dataAsOf = the build time', async () => {
    const asOf = new Date(2026, 10, 23, 18, 3).toISOString();
    const f = fake({ ok: true, model: withFreshness(new Date(2026, 10, 24, 8, 55).toISOString(),
      { v: 1, status: 'stale', reasons: ['not-today'], dataAsOf: asOf, dataAsOfSource: 'fleet-build' }) });
    expect(await dbr.pullFleetHealth({ fleetDbr: f, now: NOW })).toEqual({ ok: false, stale: true, dataAsOf: asOf });
    expect(f.draftPending).not.toHaveBeenCalled();
  });

  it('a partial status blocks too; fresh status completes with the build time as dataAsOf', async () => {
    const asOf = new Date(2026, 10, 24, 8, 30).toISOString();
    const synced = new Date(2026, 10, 24, 8, 55).toISOString();
    const p = fake({ ok: true, model: withFreshness(synced, { v: 1, status: 'partial', reasons: ['rows-differ-from-last-build'], dataAsOf: asOf, dataAsOfSource: 'fleet-build' }) });
    expect(await dbr.pullFleetHealth({ fleetDbr: p, now: NOW })).toEqual({ ok: false, stale: true, dataAsOf: asOf });
    const ok = fake({ ok: true, model: withFreshness(synced, { v: 1, status: 'fresh', reasons: [], dataAsOf: asOf, dataAsOfSource: 'fleet-build' }) });
    const r = await dbr.pullFleetHealth({ fleetDbr: ok, now: NOW });
    expect(r).toMatchObject({ ok: true, fresh: true, data: { dataAsOf: asOf } });
  });

  it('status unknown on a sync stamp (no build recorded): the old same-day rule on fleetSyncedAt', async () => {
    const df = { v: 1, status: 'unknown', reasons: [], dataAsOf: null, dataAsOfSource: 'sync-stamp' };
    const today = new Date(2026, 10, 24, 7, 0).toISOString();
    const r = await dbr.pullFleetHealth({ fleetDbr: fake({ ok: true, model: withFreshness(today, df) }), now: NOW });
    expect(r).toMatchObject({ ok: true, fresh: true, data: { dataAsOf: today } });
    const y = new Date(2026, 10, 23, 7, 0).toISOString();
    expect(await dbr.pullFleetHealth({ fleetDbr: fake({ ok: true, model: withFreshness(y, df) }), now: NOW })).toEqual({ ok: false, stale: true, dataAsOf: y });
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
