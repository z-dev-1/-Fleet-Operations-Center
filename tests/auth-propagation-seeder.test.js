// tests/auth-propagation-seeder.test.js — src/auth/session-seeder.js (auth.propagation
// FEAT-003, plan item 14/16, design 5.2-5.4): real src/scrapers/auth.js with the
// Phase 9 harness fake Electron (distinct vendor session), injected deps, no vi.mock.
// F6 (partition-keyed _seededThisProcess, sticky refresh) and F7 (guardedSet checks
// EVERY present host) are named by prefix. Runs with Phase 9 flags ON and OFF.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const fs = require('fs');
const auth = require('../src/scrapers/auth');
const seeder = require('../src/auth/session-seeder');

const SINGLE_FLIGHT_ON = { singleFlight: true, singleOwnerAea: true, singleOwnerReconnect: true };
const SINGLE_FLIGHT_OFF = { singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: false };
const AEA = 'amazon_enterprise_access';
const vendor = () => h.electron.fakeVendorSession;
const def = () => h.electron.session.defaultSession;
const cookieGen = () => auth._coordStats().cookieGen;
const ORIGINAL_COOKIE = fs.readFileSync(h.cookieFixturePath, 'utf8');
const ORIGINAL_TOKEN = h.posture.token;

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function recLogger() {
  const lines = [];
  const rec = (level) => (...a) => lines.push({ level, msg: a.map(String).join(' ') });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
function fakeSes() {
  const sets = [];
  return { sets, cookies: { set: async (c) => { sets.push(c); }, flushStore: async () => {}, get: async () => [] } };
}

describe.each([
  ['Phase 9 flags ON', SINGLE_FLIGHT_ON],
  ['Phase 9 flags OFF', SINGLE_FLIGHT_OFF],
])('session-seeder (%s)', (_label, flags) => {
  let log;
  const deps = () => ({ auth, electron: h.electron, logger: log });

  beforeEach(() => {
    h.electron.resetCounters();
    h.logs.length = 0;
    auth._setCoordDeps({ flags });
    seeder._reset();
    log = recLogger();
  });
  afterEach(() => {
    fs.writeFileSync(h.cookieFixturePath, ORIGINAL_COOKIE);
    h.posture.token = ORIGINAL_TOKEN;
    auth._resetCoord();
    seeder._reset();
  });

  it('seeds the vendor session with disk cookies + posture AEA and never touches defaultSession', async () => {
    const gen0 = cookieGen();
    const r = await seeder.seedSession(vendor(), { reason: 'test', partition: 'persist:vendor-uptake' }, deps());
    expect(r.ok).toBe(true);
    expect(r.aea).toBe('posture+disk');
    expect(r.blockedNonAmazon).toBe(0);
    const names = vendor().setLog.map((c) => c.name);
    expect(names).toContain('session');
    expect(names).toContain('user_name');
    const aeaDomains = vendor().setLog.filter((c) => c.name === AEA).map((c) => c.domain).sort();
    expect(aeaDomains).toEqual(['.a2z.com', '.amazon.com', '.auth.midway.aws.dev', '.aws.dev', '.corp.amazon.com']);
    expect(r.injected).toBe(vendor().sets);
    expect(def().sets).toBe(0);
    expect(cookieGen()).toBe(gen0);                     // guarded partition writes never bump the default-jar generation
    expect(log.lines.some((l) => /^\[auth-seed\] reason=test partition=persist:vendor-uptake injected=\d+ aea=posture\+disk blocked=0$/.test(l.msg))).toBe(true);
  });

  it('F6: seedSession registers the partition string in _seededThisProcess', async () => {
    expect(seeder._seededThisProcess.has('persist:vendor-uptake')).toBe(false);
    await seeder.seedSession(vendor(), { reason: 'aap:open-url', partition: 'persist:vendor-uptake' }, deps());
    expect([...seeder._seededThisProcess]).toEqual(['persist:vendor-uptake']);
  });

  it('F6: seedSession without a partition seeds but does not register', async () => {
    const r = await seeder.seedSession(vendor(), { reason: 'no-partition' }, deps());
    expect(r.ok).toBe(true);
    expect(vendor().sets).toBeGreaterThan(0);
    expect(seeder._seededThisProcess.size).toBe(0);
  });

  it('F6: refreshSticky ignores a partition never seeded this process', async () => {
    const seed = vi.fn(async () => ({ ok: true }));
    const out = await seeder.refreshSticky('recovered', { fromPartition: () => vendor(), now: () => 1000, seed });
    expect(seed).not.toHaveBeenCalled();
    expect(out.refreshed).toBe(0);
    expect(vendor().sets).toBe(0);
  });

  it('F6: refreshSticky seeds persist:vendor-uptake after a prior seed even when the store holds only expired cookies', async () => {
    await seeder.seedSession(vendor(), { reason: 'aap:open-url', partition: 'persist:vendor-uptake' }, deps());
    vendor()._clear();
    // Only an expired Midway cookie remains (Chromium's get() would not even return it).
    vendor()._store.set('session|midway-auth.amazon.com', { name: 'session', domain: 'midway-auth.amazon.com', expirationDate: 1 });
    const fromPartition = vi.fn(() => vendor());
    const out = await seeder.refreshSticky('recovered', Object.assign(deps(), { fromPartition, now: () => 5000 }));
    expect(fromPartition).toHaveBeenCalledWith('persist:vendor-uptake');
    expect(out).toEqual({ refreshed: 1, results: [{ partition: 'persist:vendor-uptake', ok: true }] });
    expect(vendor().setLog.filter((c) => c.name === AEA).length).toBe(5);
    expect(def().sets).toBe(0);
    expect(log.lines.some((l) => /reason=sticky:recovered partition=persist:vendor-uptake/.test(l.msg))).toBe(true);
  });

  it('F6: refreshSticky is rate-limited to once per 5 min per partition', async () => {
    seeder._seededThisProcess.add('persist:vendor-uptake');
    let t = 1000000;
    const seed = vi.fn(async () => ({ ok: true }));
    const d = { fromPartition: () => vendor(), now: () => t, seed };
    await seeder.refreshSticky('recovered', d);
    t += 4 * 60 * 1000;
    await seeder.refreshSticky('heartbeat', d);
    expect(seed).toHaveBeenCalledTimes(1);
    t += 61 * 1000;
    await seeder.refreshSticky('heartbeat', d);
    expect(seed).toHaveBeenCalledTimes(2);
    expect(seed.mock.calls[0][1]).toEqual({ reason: 'sticky:recovered', partition: 'persist:vendor-uptake' });
    expect(seed.mock.calls[1][1]).toEqual({ reason: 'sticky:heartbeat', partition: 'persist:vendor-uptake' });
  });

  it('F7: guardedSet rejects domain .amazon.com with url https://evil.test/', async () => {
    const s = fakeSes(); const k = {};
    const g = seeder.guardedSession(s, k, log);
    await expect(g.cookies.set({ name: 'session', domain: '.amazon.com', url: 'https://evil.test/' })).rejects.toThrow('non-amazon-host');
    expect(s.sets).toHaveLength(0);
    expect(k.blockedNonAmazon).toBe(1);
    expect(log.lines.some((l) => l.level === 'warn' && /name=session domain=\.amazon\.com/.test(l.msg))).toBe(true);
  });

  it('F7: guardedSet rejects a non-Amazon domain with an Amazon url', async () => {
    const s = fakeSes(); const k = {};
    const g = seeder.guardedSession(s, k, log);
    await expect(g.cookies.set({ name: AEA, domain: '.evil.test', url: 'https://midway-auth.amazon.com/' })).rejects.toThrow('non-amazon-host');
    expect(s.sets).toHaveLength(0);
    expect(k.blockedNonAmazon).toBe(1);
  });

  it('F7: guardedSet accepts matching domain and url', async () => {
    const s = fakeSes(); const k = {};
    const g = seeder.guardedSession(s, k, log);
    await g.cookies.set({ name: AEA, domain: '.corp.amazon.com', url: 'https://aap-na.corp.amazon.com' });
    await g.cookies.set({ name: '__Host-session', url: 'https://midway-auth.amazon.com/' });       // url only (host-only cookie)
    await g.cookies.set({ name: AEA, domain: '.auth.midway.aws.dev', url: 'https://auth.midway.aws.dev/' });
    await g.cookies.set({ name: AEA, domain: '.a2z.com', url: 'https://a2z.com' });
    await g.cookies.set({ name: 'x', domain: 'midway.amazon.dev' });                                // domain only
    expect(s.sets).toHaveLength(5);
    expect(k).toEqual({ blockedNonAmazon: 0, accepted: 5, aeaAccepted: 3 });
  });

  it('F7: guardedSet rejects an unparsable url', async () => {
    const s = fakeSes(); const k = {};
    const g = seeder.guardedSession(s, k, log);
    await expect(g.cookies.set({ name: 'session', domain: '.amazon.com', url: 'not a url' })).rejects.toThrow('non-amazon-host');
    await expect(g.cookies.set({ name: 'session' })).rejects.toThrow('non-amazon-host');           // neither host present
    await expect(g.cookies.set({ name: 'session', domain: '.amazon.com.evil.test' })).rejects.toThrow('non-amazon-host');
    expect(s.sets).toHaveLength(0);
    expect(k.blockedNonAmazon).toBe(3);
  });

  it('a poisoned cookie-file line for midway.example-evil.test is blocked and counted, never stored', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(h.cookieFixturePath, ORIGINAL_COOKIE + '#HttpOnly_midway.example-evil.test\tFALSE\t/\tTRUE\t' + exp + '\tsession\tFAKE-EVIL-VALUE\n');
    const r = await seeder.seedSession(vendor(), { reason: 'poison', partition: 'persist:vendor-roadready' }, deps());
    expect(r.blockedNonAmazon).toBe(1);
    expect(r.ok).toBe(true);
    expect([...vendor()._store.keys()].some((k) => /evil/.test(k))).toBe(false);
    expect(log.lines.some((l) => l.level === 'warn' && /blocked non-amazon cookie name=session domain=midway\.example-evil\.test/.test(l.msg))).toBe(true);
    expect(JSON.stringify(log.lines)).not.toContain('FAKE-EVIL-VALUE');
  });

  it('writes the posture AEA when the cookie file is missing', async () => {
    const moved = h.cookieFixturePath + '.moved';
    fs.renameSync(h.cookieFixturePath, moved);
    try {
      const r = await seeder.seedSession(vendor(), { reason: 'nofile', partition: 'persist:vendor-uptake' }, deps());
      expect(r.errors).toContain('cookie-file-missing');
      expect(r.aea).toBe('posture-only');
      expect(r.ok).toBe(true);
      expect(vendor().setLog.filter((c) => c.name === AEA).map((c) => c.domain).sort()).toEqual(['.a2z.com', '.amazon.com', '.aws.dev', '.corp.amazon.com']);
    } finally { fs.renameSync(moved, h.cookieFixturePath); }
  });

  it("an expired posture token -> aea 'disk-only'", async () => {
    h.posture.token = () => [b64url({ alg: 'RS256' }), b64url({ exp: Math.floor(Date.now() / 1000) - 600 }), 'FAKE-SIGNATURE'].join('.');
    const r = await seeder.seedSession(vendor(), { reason: 'expired-posture' }, deps());
    expect(r.aea).toBe('disk-only');
    expect(r.ok).toBe(true);
    expect(vendor().setLog.filter((c) => c.name === AEA).map((c) => c.domain)).toEqual(['.auth.midway.aws.dev']);
  });

  it('an invalid session object is rejected without touching any jar', async () => {
    for (const bad of [null, undefined, {}, { cookies: {} }, { cookies: { set: 'x' } }]) {
      const r = await seeder.seedSession(bad, { reason: 'bad', partition: 'persist:slack' }, deps());
      expect(r).toEqual({ ok: false, injected: 0, aea: 'none', blockedNonAmazon: 0, errors: ['invalid-session'] });
    }
    expect(def().sets + vendor().sets).toBe(0);
    expect(seeder._seededThisProcess.size).toBe(0);
  });

  it('the seeder refuses defaultSession (no cookies.set, cookieGen unchanged) and seedOrLegacy then runs the legacy lambda', async () => {
    const gen0 = cookieGen();
    const r = await seeder.seedSession(def(), { reason: 'x', partition: 'persist:vendor-uptake' }, deps());
    expect(r.errors).toEqual(['default-session-not-seeded']);
    expect(def().sets).toBe(0);
    expect(cookieGen()).toBe(gen0);
    expect(seeder._seededThisProcess.size).toBe(0);
    const legacy = vi.fn(() => auth.injectCookies());
    await seeder.seedOrLegacy(def(), { reason: 'x' }, legacy, Object.assign(deps(), { enabled: true }));
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(def().sets).toBeGreaterThan(0);              // written by the ORIGINAL unwrapped injector
    expect(cookieGen()).toBe(gen0 + 2);                 // which bumps the generation before and after
  });

  it('seedOrLegacy flag ON seeds the partition and never calls the legacy lambda', async () => {
    const legacy = vi.fn();
    const r = await seeder.seedOrLegacy(vendor(), { reason: 'slack:login', partition: 'persist:slack' }, legacy, Object.assign(deps(), { enabled: true }));
    expect(legacy).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(seeder._seededThisProcess.has('persist:slack')).toBe(true);
  });

  it("relay:open-url decision: '' -> raw injectCookies (cookieGen increments); roadready/uptake -> seeder; volvo/paccar -> nothing", async () => {
    const gen0 = cookieGen();
    expect(await seeder.seedForRelayOpen('', { auth })).toEqual({ mode: 'default' });
    expect(cookieGen()).toBe(gen0 + 2);
    expect(def().sets).toBeGreaterThan(0);
    for (const part of ['persist:vendor-roadready', 'persist:vendor-uptake']) {
      const seed = vi.fn(async () => ({ ok: true }));
      const fromPartition = vi.fn(() => vendor());
      const out = await seeder.seedForRelayOpen(part, { auth, seed, fromPartition });
      expect(out.mode).toBe('seeded');
      expect(fromPartition).toHaveBeenCalledWith(part);
      expect(seed).toHaveBeenCalledWith(vendor(), { reason: 'relay:open-url', partition: part }, expect.any(Object));
    }
    for (const part of ['persist:vendor-volvo', 'persist:vendor-paccar', 'persist:vendor-paccar-pssmfleet']) {
      const spyAuth = { injectCookies: vi.fn() };
      const seed = vi.fn();
      expect(await seeder.seedForRelayOpen(part, { auth: spyAuth, seed, fromPartition: () => vendor() })).toEqual({ mode: 'none' });
      expect(spyAuth.injectCookies).not.toHaveBeenCalled();
      expect(seed).not.toHaveBeenCalled();
    }
    expect(vendor().sets).toBe(0);
  });

  it('a real relay seed of persist:vendor-roadready goes through the guard and leaves cookieGen unchanged', async () => {
    const gen0 = cookieGen();
    const out = await seeder.seedForRelayOpen('persist:vendor-roadready', Object.assign(deps(), { fromPartition: () => vendor() }));
    expect(out.result.ok).toBe(true);
    expect(cookieGen()).toBe(gen0);
    expect(def().sets).toBe(0);
    expect(seeder._seededThisProcess.has('persist:vendor-roadready')).toBe(true);
  });

  it('MIDWAY_PARTITIONS and STICKY are the documented constants', () => {
    expect([...seeder.MIDWAY_PARTITIONS].sort()).toEqual(['persist:slack', 'persist:vendor-roadready', 'persist:vendor-uptake']);
    expect(seeder.STICKY).toEqual(['persist:vendor-uptake']);
    expect(seeder.MIDWAY_PARTITIONS.has('')).toBe(false);
  });

  it('reason is sanitised to 60 chars of [A-Za-z0-9:_ .-]', async () => {
    await seeder.seedSession(vendor(), { reason: 'x'.repeat(50) + '<script>' + 'y'.repeat(30) }, deps());
    const line = log.lines.find((l) => l.msg.startsWith('[auth-seed] reason='));
    const reason = /reason=(\S+)/.exec(line.msg)[1];
    expect(reason.length).toBeLessThanOrEqual(60);
    expect(reason).toMatch(/^[A-Za-z0-9:_.-]+$/);
    expect(reason).not.toContain('<');
  });

  it('buildInventory self-filters (fake cookies.get ignores filters)', async () => {
    const now = 1_700_000_000_000;
    const all = [
      { name: AEA, domain: '.corp.amazon.com', expirationDate: now / 1000 + 7 * 60 },
      { name: AEA, domain: '.midway-auth.amazon.com', expirationDate: now / 1000 + 91 * 60 },
      { name: AEA, domain: 'midway-auth.amazon.com', expirationDate: now / 1000 + 30 * 60 },
      { name: 'session', domain: 'midway-auth.amazon.com', expirationDate: now / 1000 + 600 * 60 },
      { name: 'user_name', domain: '.amazon.com' },
      { name: 'other', domain: '.evil.test' },
      { name: 'session', domain: 'other.amazon.com' },
    ];
    const ses = { cookies: { get: async () => all.slice() } };
    const inv = await seeder.buildInventory(ses, { now: () => now });
    expect(inv.aea).toEqual([
      { domain: '.corp.amazon.com', min: 7 },
      { domain: '.midway-auth.amazon.com', min: 91 },
      { domain: 'midway-auth.amazon.com', min: 30 },
    ]);
    expect(inv.toMidway).toEqual({ aea: 2, session: 1, other: 1 });
    expect(inv.aeaCountToMidway).toBe(2);
    expect(seeder.formatInventory(inv, 'left-healthy')).toBe('[auth-inventory] reason=left-healthy aea=[.corp.amazon.com:7m, .midway-auth.amazon.com:91m, midway-auth.amazon.com:30m] toMidway={aea:2, session:1}');
  });

  it('the seeder source never reads a cookie value', () => {
    const src = fs.readFileSync(require.resolve('../src/auth/session-seeder'), 'utf8');
    expect(src).not.toMatch(/\.value\b/);
  });
});

describe('call sites route through the seeder', () => {
  const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
  const seedCalls = (src) => src.split('\n').filter((l) => l.includes('seedOrLegacy('));

  it('F6: slack, vendor_session and credentials call sites pass the partition option', () => {
    const slack = seedCalls(read('../src/ipc/slack.js'));
    expect(slack).toHaveLength(1);
    expect(slack[0]).toContain("{ reason: 'slack:login', partition: 'persist:slack' }, () => injectCookies(ses))");
    const vs = seedCalls(read('../src/scrapers/vendor_session.js'));
    expect(vs).toHaveLength(1);
    expect(vs[0]).toContain('partition: VENDOR_PARTITIONS[hostname] || null }, () => injectCookies(win.webContents.session))');
    const cr = seedCalls(read('../src/ipc/credentials.js'));
    expect(cr).toHaveLength(1);
    expect(cr[0]).toContain('partition: VENDOR_PARTITIONS[hostname] || null }, () => injectCookies(win.webContents.session))');
    // sso-click vendors only, exactly as before.
    for (const rel of ['../src/scrapers/vendor_session.js', '../src/ipc/credentials.js']) {
      const src = read(rel);
      const i = src.indexOf('seedOrLegacy(');
      expect(src.lastIndexOf("LOGIN_STRATEGIES[hostname] === 'sso-click'", i)).toBeGreaterThan(-1);
      expect(i - src.lastIndexOf("LOGIN_STRATEGIES[hostname] === 'sso-click'", i)).toBeLessThan(400);
    }
  });

  it('aap:open-url seeds only MIDWAY_PARTITIONS (uptake as before) and never defaultSession', () => {
    const src = read('../src/ipc/misc.js');
    expect(src).toContain("if (_part === 'persist:vendor-uptake' || (_part && _seeder.isEnabled() && _seeder.MIDWAY_PARTITIONS.has(_part))) {");
    expect(src).toContain("await _seeder.seedOrLegacy(_openSession, { reason: 'aap:open-url', partition: _part }, () => injectCookies(_openSession));");
  });

  it('relay:open-url keeps the original inject line for flag off and routes flag on through seedForRelayOpen', () => {
    const src = read('../src/window/index.js');
    const start = src.indexOf("ipcMain.handle('relay:open-url'");
    const body = src.slice(start, src.indexOf('const win = new BrowserWindow', start));
    expect(body).toContain('if (_seeder.isEnabled()) {');
    expect(body).toContain("await _seeder.seedForRelayOpen(partitionForUrl(url) || '', { auth: _getAuth(), fromPartition: (p) => session.fromPartition(p) });");
    expect(body).toContain("} else\n    // Re-inject Midway cookies so AEA passes on first load\n    try { await _getAuth().injectCookies(); } catch(e) { logger.warn('[relay:open-url] Cookie inject skipped:', e.message); }");
    // uptake:open-url is unchanged (defaultSession, raw inject).
    const u = src.indexOf("ipcMain.handle('uptake:open-url'");
    expect(src.slice(u, src.indexOf("ipcMain.handle('relay:open-url'"))).not.toContain('seeder');
  });
});
