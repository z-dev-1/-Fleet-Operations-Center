import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage11-'));
  paths.setDataDir(dir);
  return dir;
}

// Stage 11 wires cluster.mayLivePull() into the recurring live-AAP refresh
// chokepoint (_loadFleetViaApiStartup in src/window/index.js). The window
// module is Electron-bound and not unit-testable here, so these tests lock in
// the exact decision contract that gate depends on — the behavior the recurring
// refresh branches on.

describe('Stage 11 — live-pull gate decision contract (what _loadFleetViaApiStartup branches on)', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} });

  it('cluster OFF → refresh PROCEEDS (legacy single-host, unchanged)', () => {
    cluster.init({ enabled: false });
    expect(cluster.mayLivePull()).toBe(true);     // gate does not skip
  });

  it('capable LEADER (laptop, browser true) → refresh PROCEEDS', () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', capabilities: { browser: true }, force: true });
    expect(cluster.mayLivePull()).toBe(true);
  });

  it('capable STANDBY (headless DevSpace w/ aapLivePull) → refresh PROCEEDS (own live reads)', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    expect(cluster.mayLivePull()).toBe(true);     // standby refreshes its own data
    // ...but still never writes:
    expect(cluster.canSideEffect('fleet-mutate').ok).toBe(false);
  });

  it('NON-capable STANDBY (headless, no live-pull) → refresh SKIPS (snapshot only)', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: false }, force: true });
    expect(cluster.mayLivePull()).toBe(false);    // gate skips the live pull
  });

  it('live-pull decision is independent of leadership (a follower standby still reads when capable)', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    expect(cluster.isLeader()).toBe(false);        // never acquired a lease
    expect(cluster.mayLivePull()).toBe(true);      // reads allowed regardless
  });

  it('DEVELOPMENT mode may still live-pull when capable (reads authorized data, writes blocked)', () => {
    cluster.init({ enabled: true, mode: 'DEVELOPMENT', capabilities: { browser: true, aapLivePull: true }, force: true });
    expect(cluster.mayLivePull()).toBe(true);
    expect(cluster.canSideEffect('fleet-mutate').ok).toBe(false);
  });

  it('toggling mode at runtime flips the gate decision live', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: false }, force: true });
    expect(cluster.mayLivePull()).toBe(false);
    // Operator declares this headless host now has live-pull (playwright ready):
    const gate = require('../src/cluster/mode-gate');
    gate.setCapabilities({ aapLivePull: true });
    expect(cluster.mayLivePull()).toBe(true);
  });
});
