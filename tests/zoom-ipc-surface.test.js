// FEAT-A1 / AC-23 (+ review F-1): preload zoomHub block, bridge zoomHub export and CHANNELS agree;
// 40 invoke + 3 events = 43 preload keys; every invoke method is arity-1 (payload) => invoke(ch, payload).
// OBS FEAT-003 (design-review F7): CHANNELS.obs (7) + the // B3 (OBS) REAL block + zoomStudio:obs-state.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const hub = require('../src/ipc/zoom-hub');
const preload = fs.readFileSync(require.resolve('../preload.js'), 'utf8');
const bridge = fs.readFileSync(require.resolve('../renderer/src/js/bridge.js'), 'utf8');

const ALL = [].concat(hub.CHANNELS.hub, hub.CHANNELS.data, hub.CHANNELS.studio, hub.CHANNELS.obs);

function preloadBlock() {
  const start = preload.indexOf("expose('zoomHub', {");
  expect(start).toBeGreaterThan(-1);
  const end = preload.indexOf('});', start);
  return preload.slice(start, end);
}

function bridgeBlock() {
  const start = bridge.indexOf('export const zoomHub = {');
  expect(start).toBeGreaterThan(-1);
  const end = bridge.indexOf('};', start);
  return bridge.slice(start, end);
}

describe('Zoom hub IPC surface', () => {
  it('CHANNELS has 1 hub + 17 data + 15 studio + 7 obs = 40 invoke channels and 3 events', () => {
    expect(hub.CHANNELS.hub).toEqual(['zoomHub:flags']);
    expect(hub.CHANNELS.data.length).toBe(17);
    expect(hub.CHANNELS.studio.length).toBe(15);
    expect(hub.CHANNELS.obs.length).toBe(7);
    expect(new Set(ALL).size).toBe(40);
    expect(hub.EVENTS).toEqual(['zoomData:auth-changed', 'zoomData:summary-progress', 'zoomStudio:obs-state']);
  });

  it('preload: 43 keys; every invoke uses the arity-1 zi(ch) wrapper; channels match CHANNELS exactly', () => {
    expect(preload).toContain('const zi = (ch) => (payload) => ipcRenderer.invoke(ch, payload);');
    const block = preloadBlock();
    const invokes = [...block.matchAll(/^\s*(\w+):\s*zi\('([^']+)'\),\s*$/gm)].map((m) => [m[1], m[2]]);
    const events = [...block.matchAll(/^\s*(\w+):\s*\(cb\) => on\('([^']+)', cb\),\s*$/gm)].map((m) => [m[1], m[2]]);
    const keys = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(keys.length).toBe(43);
    expect(invokes.length).toBe(40);
    expect(events.length).toBe(3);
    expect(invokes.map(([, ch]) => ch).sort()).toEqual(ALL.slice().sort());
    expect(events.map(([, ch]) => ch)).toEqual(hub.EVENTS);
    expect(events.map(([k]) => k)).toEqual(['onAuthChanged', 'onSummaryProgress', 'onObsState']);
  });

  it('preload zi() wrapper is arity-1 and forwards exactly one payload', async () => {
    const calls = [];
    const ipcRenderer = { invoke: (...a) => { calls.push(a); return Promise.resolve(a); } };
    // eslint-disable-next-line no-new-func
    const zi = new Function('ipcRenderer', 'return (ch) => (payload) => ipcRenderer.invoke(ch, payload);')(ipcRenderer);
    const fn = zi('zoomData:join');
    expect(fn.length).toBe(1);
    await fn({ key: 'abc' }, 'extra-ignored');
    expect(calls).toEqual([['zoomData:join', { key: 'abc' }]]);
  });

  it('bridge: same 43 method names as preload; UNAVAILABLE fallback; on* return a no-op unsubscribe', () => {
    const pkeys = [...preloadBlock().matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    const block = bridgeBlock();
    const bkeys = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(bkeys).toEqual(pkeys);
    const wrapped = [...block.matchAll(/^\s*(\w+):\s*_zh\('(\w+)'\),\s*$/gm)];
    expect(wrapped.length).toBe(40);
    for (const m of wrapped) expect(m[1]).toBe(m[2]);
    expect(bridge).toContain("Promise.resolve({ ok: false, code: 'UNAVAILABLE' })");
    expect(bridge).toMatch(/const _zh = \(name\) => \(payload\) =>/);
    expect(block).toMatch(/onAuthChanged:\s*\(cb\) => \(window\.zoomHub \? window\.zoomHub\.onAuthChanged\(cb\) : \(\) => \{\}\)/);
    expect(block).toMatch(/onObsState:\s*\(cb\) => \(window\.zoomHub \? window\.zoomHub\.onObsState\(cb\) : \(\) => \{\}\)/);
  });

  it('every CHANNELS entry is registered (both flag states)', () => {
    const pf = require('../src/config/perf-flags');
    for (const zoom of [{}, { enabled: true, data: true, studio: true, write: true, obs: true }]) {
      const seen = [];
      const ctx = { mainWindow: null };
      hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom }, {}), handle: (ch) => seen.push(ch) });
      expect(seen.slice().sort()).toEqual(ALL.slice().sort());
    }
  });

  it('REAL is ordered in A1 / A2 / B1 / B2 / B3 blocks; A1 fills 7, A2 10, B1 2, B2 the 13 remaining studio channels and B3 the 7 obs channels', () => {
    const src = fs.readFileSync(require.resolve('../src/ipc/zoom-hub.js'), 'utf8');
    const i1 = src.indexOf('  // A1\n'.replace('\n', src.includes('\r\n') ? '\r\n' : '\n'));
    const i2 = src.indexOf('  // A2');
    const i3 = src.indexOf('  // B1');
    const i4 = src.indexOf('  // B2');
    const i5 = src.indexOf('  // B3');
    expect(i1).toBeGreaterThan(-1);
    expect(i1 < i2 && i2 < i3 && i3 < i4 && i4 < i5).toBe(true);
    const block = (a, b) => (src.slice(a, b).match(/'(zoomData:[a-z-]+)':/g) || []).map((s) => s.slice(1, -2)).sort();
    expect(block(i1, i2)).toEqual([
      'zoomData:connect', 'zoomData:get-meeting', 'zoomData:join', 'zoomData:list-meetings',
      'zoomData:list-recordings', 'zoomData:recording-info', 'zoomData:status',
    ]);
    expect(block(i2, i3)).toEqual([
      'zoomData:ai-consent', 'zoomData:get-summary', 'zoomData:get-transcript', 'zoomData:import-transcript',
      'zoomData:link', 'zoomData:link-targets', 'zoomData:links', 'zoomData:summarize', 'zoomData:unlink', 'zoomData:write-open',
    ]);
    const sblock = (a, b) => (src.slice(a, b).match(/'(zoom(?:Data|Studio):[a-z-]+)':/g) || []).map((s) => s.slice(1, -2)).sort();
    expect(sblock(i3, i4)).toEqual(['zoomStudio:media-status', 'zoomStudio:open-privacy']);
    expect(sblock(i4, i5)).toEqual(hub.CHANNELS.studio.filter((c) => c !== 'zoomStudio:media-status' && c !== 'zoomStudio:open-privacy').slice().sort());
    expect(sblock(i4, i5).length).toBe(13);
    const b3 = src.indexOf('// B3', i4);
    const end = src.indexOf('};', b3);
    expect(sblock(b3, end)).toEqual(hub.CHANNELS.obs.slice().sort());
    // Every CHANNELS entry now has a REAL handler when its area is on: no NOT_IMPLEMENTED left.
    expect(Object.keys(hub.REAL).sort()).toEqual(hub.CHANNELS.data.concat(hub.CHANNELS.studio, hub.CHANNELS.obs).sort());
    for (const k of Object.keys(hub.REAL)) expect(ALL).toContain(k);
  });
});
