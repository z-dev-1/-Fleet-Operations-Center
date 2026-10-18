import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage10-'));
  paths.setDataDir(dir);
  return dir;
}

describe('Stage 10 — browser_provider cookie mapping (auth.js → Playwright shape)', () => {
  const provider = require('../src/scrapers/browser_provider');

  it('maps a standard cookie to domain+path with capitalized sameSite + numeric expires', () => {
    const [pw] = provider._toPwCookies([{
      url: 'https://aap-na.corp.amazon.com/', domain: '.corp.amazon.com', path: '/',
      name: 'session', value: 'abc', secure: true, httpOnly: true,
      expirationDate: 1800000000, sameSite: 'no_restriction',
    }]);
    expect(pw.name).toBe('session');
    expect(pw.value).toBe('abc');
    expect(pw.secure).toBe(true);
    expect(pw.httpOnly).toBe(true);
    expect(pw.sameSite).toBe('None');          // no_restriction → None
    expect(pw.expires).toBe(1800000000);
    expect(pw.domain).toBe('.corp.amazon.com');
    expect(pw.path).toBe('/');
    expect(pw.url).toBeUndefined();            // non-__Host- uses domain, not url
  });

  it('maps a __Host- cookie as host-only (url, never domain) — same contract as the Electron injector', () => {
    const [pw] = provider._toPwCookies([{
      url: 'https://midway-auth.amazon.com/', domain: 'midway-auth.amazon.com', path: '/',
      name: '__Host-session', value: 'xyz', secure: true, httpOnly: true,
      expirationDate: 1800000000, sameSite: 'lax',
    }]);
    expect(pw.name).toBe('__Host-session');
    expect(pw.url).toBe('https://midway-auth.amazon.com/');
    expect(pw.domain).toBeUndefined();         // host-only: NO domain
    expect(pw.path).toBeUndefined();
    expect(pw.sameSite).toBe('Lax');
  });

  it('defaults sameSite to None and omits expires for a session cookie', () => {
    const [pw] = provider._toPwCookies([{
      url: 'https://x.amazon.com/', domain: '.amazon.com', path: '/',
      name: 'tok', value: 'v', secure: false, httpOnly: false,
    }]);
    expect(pw.sameSite).toBe('None');
    expect('expires' in pw).toBe(false);
  });
});

describe('Stage 10 — browser_provider engine selection', () => {
  const provider = require('../src/scrapers/browser_provider');

  it('_isSSO detects a midway-auth / SSO redirect URL', () => {
    expect(provider._isSSO('https://midway-auth.amazon.com/SSO/redirect?x=1')).toBe(true);
    expect(provider._isSSO('https://aap-na.corp.amazon.com/v2/page/abc')).toBe(false);
    expect(provider._isSSO('')).toBe(false);
  });

  it('kind() is "none" on a headless host that has NOT opted into Playwright', () => {
    // In the vitest/node runtime there is no Electron display. Without the
    // opt-in env the provider must not silently use Playwright.
    const prev = process.env.FLEET_HEADLESS_BROWSER;
    process.env.FLEET_HEADLESS_BROWSER = '0';
    try {
      // Node test runtime has no electron display → not 'electron';
      // opt-out → not 'playwright'.
      expect(['none', 'electron']).toContain(provider.kind());
      if (provider.kind() !== 'electron') expect(provider.kind()).toBe('none');
    } finally {
      if (prev === undefined) delete process.env.FLEET_HEADLESS_BROWSER;
      else process.env.FLEET_HEADLESS_BROWSER = prev;
    }
  });

  it('openPage rejects with NO_BROWSER_PROVIDER when no engine is available', async () => {
    const prev = process.env.FLEET_HEADLESS_BROWSER;
    process.env.FLEET_HEADLESS_BROWSER = '0';
    try {
      if (provider.kind() === 'none') {
        await expect(provider.openPage('https://aap-na.corp.amazon.com/')).rejects.toMatchObject({
          code: 'NO_BROWSER_PROVIDER',
        });
      }
    } finally {
      if (prev === undefined) delete process.env.FLEET_HEADLESS_BROWSER;
      else process.env.FLEET_HEADLESS_BROWSER = prev;
    }
  });
});

describe('Stage 10 — mode-gate live-pull capability (READ gate, not a side-effect)', () => {
  const gate = require('../src/cluster/mode-gate');
  beforeEach(() => gate._reset());
  afterEach(() => gate._reset());

  it('flag OFF → live pull allowed (legacy single-host)', () => {
    expect(gate.canLivePull().ok).toBe(true);
  });

  it('STANDBY with aapLivePull:true MAY live-pull but may NOT write', () => {
    gate.setEnabled(true);
    gate.setMode('STANDBY');
    gate.setCapabilities({ browser: false, aapLivePull: true });   // headless DevSpace w/ Playwright
    expect(gate.canLivePull().ok).toBe(true);                       // reads OK
    expect(gate.canSideEffect('fleet-mutate').ok).toBe(false);      // writes still closed
    expect(gate.canSideEffect('sp-push').ok).toBe(false);
  });

  it('headless host without live-pull capability fails the read gate closed', () => {
    gate.setEnabled(true);
    gate.setMode('STANDBY');
    gate.setCapabilities({ browser: false, aapLivePull: false });
    expect(gate.canLivePull().ok).toBe(false);
  });

  it('aapLivePull undefined derives from browser (laptop case)', () => {
    gate.setEnabled(true);
    gate.setMode('ACTIVE');
    gate.setCapabilities({ browser: true });        // aapLivePull undefined
    expect(gate.canLivePull().ok).toBe(true);
    gate.setCapabilities({ browser: false, aapLivePull: undefined });
    expect(gate.canLivePull().ok).toBe(false);
  });

  it('live pull is permitted in DEVELOPMENT mode when capable (read authorized data)', () => {
    gate.setEnabled(true);
    gate.setMode('DEVELOPMENT');
    gate.setCapabilities({ browser: false, aapLivePull: true });
    expect(gate.canLivePull().ok).toBe(true);
    // but DEVELOPMENT still writes nothing:
    expect(gate.canSideEffect('fleet-mutate').ok).toBe(false);
  });
});

describe('Stage 10 — cluster facade mayLivePull()', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} });

  it('flag OFF → mayLivePull true (legacy)', () => {
    cluster.init({ enabled: false });
    expect(cluster.mayLivePull()).toBe(true);
  });

  it('enabled STANDBY with explicit aapLivePull:true → mayLivePull true, writes still closed', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    expect(cluster.mayLivePull()).toBe(true);
    expect(cluster.canSideEffect('fleet-mutate').ok).toBe(false);
  });

  it('enabled STANDBY on a non-capable headless host → mayLivePull false', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: false }, force: true });
    expect(cluster.mayLivePull()).toBe(false);
  });

  it('mayLivePull is independent of leadership (a non-leader standby can still read)', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    expect(cluster.isLeader()).toBe(false);     // standby, no lease
    expect(cluster.mayLivePull()).toBe(true);   // but reads are allowed
  });
});
