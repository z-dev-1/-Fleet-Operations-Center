// tests/scheduler-freshness.test.js
//
// Task #4 — pre-job freshness gate. Proves separate SP/email policies, the
// HARD-BLOCK-for-production decision on stale/incomplete/failed sync, that
// cached data is never presented as fresh, and that Test Mode allows-with-
// banner (never silently blocks the pipeline) while still refusing when there
// is nothing safe to send.
//
// Isolated temp data dir via setDataDir so no real settings/app data touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-fresh-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const freshness = require('../src/scheduler/freshness');

function freshSync(over = {}) {
  return {
    ok: true, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    rowCount: 120, syncedAt: new Date().toISOString(), dataAgeMs: 0,
    sourcesUpdated: ['aap', 'uptake', 'relay'], sourcesFailed: [], usedCache: false, errors: [], ...over,
  };
}

beforeEach(() => { store.save('settings', {}); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('fresh data passes for production', () => {
  it('allows a fresh live sync (sharepoint)', () => {
    const d = freshness.evaluate(freshSync(), { channel: 'sharepoint', testMode: false });
    expect(d.allow).toBe(true);
    expect(d.block).toBe(false);
    expect(d.banner).toBeNull();
  });
  it('allows a fresh live sync (email)', () => {
    const d = freshness.evaluate(freshSync(), { channel: 'email', testMode: false });
    expect(d.allow).toBe(true);
  });
});

describe('production HARD-BLOCK on degraded data', () => {
  it('blocks when data used cache (never present cache as fresh)', () => {
    const d = freshness.evaluate(freshSync({ usedCache: true }), { channel: 'email', testMode: false });
    expect(d.block).toBe(true);
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/cache/i);
  });
  it('blocks when data too old', () => {
    const d = freshness.evaluate(freshSync({ dataAgeMs: 90 * 60000 }), { channel: 'email', testMode: false });
    expect(d.block).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/age/i);
  });
  it('blocks when row count below minimum', () => {
    const d = freshness.evaluate(freshSync({ rowCount: 1 }), { channel: 'sharepoint', testMode: false });
    expect(d.block).toBe(true);
  });
  it('blocks when authoritative source (aap) failed', () => {
    const d = freshness.evaluate(freshSync({ sourcesFailed: ['aap'], ok: false }), { channel: 'email', testMode: false });
    expect(d.block).toBe(true);
    expect(d.failedAuthoritative).toContain('aap');
  });
  it('does NOT block solely because a non-authoritative source (uptake) degraded', () => {
    const d = freshness.evaluate(freshSync({ sourcesFailed: ['uptake'] }), { channel: 'email', testMode: false });
    expect(d.allow).toBe(true);
    expect(d.failedOther).toContain('uptake');
  });
});

describe('Test Mode allow-with-banner', () => {
  it('allows slightly-stale data with a banner instead of blocking', () => {
    const d = freshness.evaluate(freshSync({ dataAgeMs: 90 * 60000, usedCache: true }), { channel: 'email', testMode: true });
    expect(d.allow).toBe(true);
    expect(d.block).toBe(false);
    expect(d.banner).toMatch(/STALE/);
  });
  it('still blocks in test mode when there is nothing safe to send', () => {
    const d = freshness.evaluate(freshSync({ ok: false, rowCount: 0, dataAgeMs: null, syncedAt: null }), { channel: 'email', testMode: true });
    expect(d.allow).toBe(false);
    expect(d.block).toBe(true);
  });
});

describe('configurable per-channel policy', () => {
  it('respects a stricter email maxDataAgeMin override', () => {
    store.save('settings', { schedulerFreshness: { email: { maxDataAgeMin: 5 } } });
    const d = freshness.evaluate(freshSync({ dataAgeMs: 10 * 60000 }), { channel: 'email', testMode: false });
    expect(d.block).toBe(true);
    expect(d.policy.maxDataAgeMin).toBe(5);
  });
  it('sp and email policies are independent', () => {
    store.save('settings', { schedulerFreshness: { sp: { minRows: 500 } } });
    const sp = freshness.evaluate(freshSync({ rowCount: 120 }), { channel: 'sharepoint', testMode: false });
    const em = freshness.evaluate(freshSync({ rowCount: 120 }), { channel: 'email', testMode: false });
    expect(sp.block).toBe(true);   // 120 < 500
    expect(em.allow).toBe(true);   // email min still default 3
  });
});
