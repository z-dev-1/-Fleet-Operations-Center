// tests/lifecycle-live-read.test.js
// LIVE lifecycle read (aap_lifecycle_api.getLiveLifecycle) and the unit-detail
// confirm check (lifecycleMatches / liveLifecycleText).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'lc-live-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const aap = require('../src/scrapers/aap_api');
const lifecycle = require('../src/scrapers/aap_lifecycle_api');

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const AAID = 'aaid_078a7023-b0a3-4ca2-b2b6-3620e56f3954';
const URL = 'https://aap-na.corp.amazon.com/v2/asset/' + AAID;
afterEach(() => vi.restoreAllMocks());

describe('getLiveLifecycle', () => {
  it('reads the current state/reason straight from AAP (wrapped or bare asset)', async () => {
    const spy = vi.spyOn(aap, 'getAsset').mockResolvedValue({ asset: { aaid: AAID, version: 70, lifecycleState: 'UNAVAILABLE', lifecycleStateReason: 'DAMAGED_MODERATE' } });
    const r = await lifecycle.getLiveLifecycle({ unit: '324040', assetUrl: URL });
    expect(spy).toHaveBeenCalledWith(AAID);
    expect(r.ok).toBe(true);
    expect(r.state).toBe('UNAVAILABLE');
    expect(r.reason).toBe('DAMAGED_MODERATE');
    expect(r.version).toBe(70);
    expect(r.stateLabel).toMatch(/unavailable/i);
    expect(typeof r.at).toBe('string');
  });
  it('reports a failure instead of guessing', async () => {
    vi.spyOn(aap, 'getAsset').mockRejectedValue(new Error('HTTP 401'));
    const r = await lifecycle.getLiveLifecycle({ unit: '324040', assetUrl: URL });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
  });
  it('fails cleanly when the asset id cannot be resolved', async () => {
    vi.spyOn(aap, 'searchAssets').mockResolvedValue({ assets: [] });
    const r = await lifecycle.getLiveLifecycle({ unit: 'NOPE-1', assetUrl: '' });
    expect(r.ok).toBe(false);
  });
});

describe('lifecycleMatches / liveLifecycleText (unit-detail)', async () => {
  const { lifecycleMatches, liveLifecycleText } = await import('../renderer/src/js/views/unit-detail.js');
  const live = { ok: true, state: 'UNAVAILABLE', reason: 'DAMAGED_MODERATE', stateLabel: 'Unavailable', reasonLabel: 'Damaged - Moderate' };
  it('confirms when live state + reason match the request', () => {
    expect(lifecycleMatches(live, 'Unavailable', 'DAMAGED_MODERATE')).toBe(true);
    expect(lifecycleMatches(live, 'Unavailable', '')).toBe(true);
  });
  it('does not confirm a different state or reason', () => {
    expect(lifecycleMatches(live, 'Active', 'HEALTHY')).toBe(false);
    expect(lifecycleMatches(live, 'Unavailable', 'PARTS_DELAY')).toBe(false);
  });
  it('never confirms on a failed live read', () => {
    expect(lifecycleMatches({ ok: false }, 'Unavailable', '')).toBe(false);
    expect(lifecycleMatches(null, 'Unavailable', '')).toBe(false);
  });
  it('formats the live status', () => {
    expect(liveLifecycleText(live)).toBe('Unavailable · Damaged - Moderate');
    expect(liveLifecycleText({ ok: false })).toBe('');
  });
});
