// tests/email-api-token.test.js — transport/token-source.js on a fake token window and a fake clock
// (design 4.3; FR-1.3 to FR-1.6, FR-5.2, NFR-4, AC-2, AC-3, R4-L6, R4-L7).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { createTokenWorld, jwt, mailboxSteps } from './fixtures/email-api/fake-token-window.js';
const require = createRequire(import.meta.url);
const { createTokenSource, isAuthUrl, isOutlookUrl } = require('../src/email-intel/transport/token-source');
const E = require('../src/email-intel/transport/errors');
const { TC } = require('../src/email-intel/transport/constants');
const owaRe = require('../src/scrapers/owa-mailer');

const sec = (ms) => Math.floor((Date.now() + ms) / 1000);
const quiet = { info() {}, warn() {} };
function source(steps, extra) {
  const world = createTokenWorld(Object.assign({ steps }, extra || {}));
  const ts = createTokenSource({ electron: world.electron, owaRe, log: quiet });
  return { world, ts };
}
async function settle(p, ms) {
  let out; let err;
  p.then((v) => { out = v; }, (e) => { err = e; });
  await vi.advanceTimersByTimeAsync(ms);
  if (err) throw err;
  return out;
}

beforeEach(() => { vi.useFakeTimers({ now: Date.parse('2026-11-07T08:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

describe('token capture', () => {
  it('AC-2 one hidden window on defaultSession captures bearer and anchor via CDP, then detaches and closes', async () => {
    const { world, ts } = source(() => mailboxSteps({ rank: 3, expSec: sec(3600_000) }));
    const a = await settle(ts.getAuth(), 1000);
    expect(a.headers.authorization).toMatch(/^Bearer /);
    expect(a.headers['x-anchormailbox']).toBe('SENTINEL-ANCHOR');
    expect(a.gen).toBe(1);
    expect(world.created()).toBe(1);
    const w = world.windows[0];
    expect(w.options).toEqual({ width: 1280, height: 900, show: false, x: -32000, y: -32000, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, session: world.electron.session.defaultSession } });
    expect(w.options.webPreferences.sandbox).toBeUndefined();
    expect(w.openHandler()).toEqual({ action: 'deny' });
    expect(w.loadedUrl).toBe(TC.TOKEN_PAGE_URL);
    expect(w.webContents.debugger.attachCount).toBe(1);
    expect(w.webContents.debugger.commands).toEqual(['Network.enable']);
    expect(w.webContents.debugger.detachCount).toBe(1);
    expect(w.destroyed).toBe(true);
  });

  it('prefers /api/v2.0 over /api/ over /owa/; a rank-2 capture settles after BEARER_SETTLE_MS', async () => {
    const t2 = jwt(sec(3600_000), 'r2'); const t1 = jwt(sec(3600_000), 'r1');
    const steps = [{ at: 10, load: 'https://outlook.cloud.microsoft/mail/inbox' },
      { at: 20, cdp: { url: 'https://outlook.cloud.microsoft/owa/x', headers: { authorization: t1, 'x-anchormailbox': 'A' } } },
      { at: 30, cdp: { url: 'https://outlook.cloud.microsoft/api/beta/me/x', headers: { authorization: t2, 'x-anchormailbox': 'A' } } },
      { at: 40, cdp: { url: 'https://outlook.office.com/api/v2.0/me/x', headers: { authorization: jwt(sec(3600_000), 'foreign'), 'x-anchormailbox': 'A' } } }];
    const { world, ts } = source(steps);
    const p = ts.getAuth();
    await vi.advanceTimersByTimeAsync(1000);
    expect(world.closed()).toBe(0);                      // still settling
    const a = await settle(p, TC.BEARER_SETTLE_MS);
    expect(a.headers.authorization).toBe(t2);
    expect(a.rank).toBe(2);
  });

  it('a capture with less than 60 s left is ignored; no bearer after the mailbox loaded -> no-bearer', async () => {
    const steps = [{ at: 10, load: 'https://outlook.cloud.microsoft/mail/inbox' },
      { at: 20, cdp: { url: 'https://outlook.cloud.microsoft/api/v2.0/me/x', headers: { authorization: jwt(sec(30_000)), 'x-anchormailbox': 'A' } } }];
    const { ts } = source(steps);
    await expect(settle(ts.getAuth(), TC.BEARER_WAIT_MS + 100)).rejects.toMatchObject({ name: 'TokenUnavailableError', reason: 'no-bearer' });
  });

  it('AC-2 five concurrent callers share one window', async () => {
    const { world, ts } = source(() => mailboxSteps({ rank: 3, expSec: sec(3600_000) }));
    const ps = [1, 2, 3, 4, 5].map(() => ts.getAuth());
    await vi.advanceTimersByTimeAsync(1000);
    const all = await Promise.all(ps);
    expect(world.created()).toBe(1);
    expect(new Set(all.map((a) => a.gen))).toEqual(new Set([1]));
  });

  it('AC-3 under 5 min refreshes once; over 5 min is reused with no window', async () => {
    let n = 0;
    const { world, ts } = source(() => { n++; return mailboxSteps({ rank: 3, token: jwt(sec(3600_000), 't' + n) }); });
    await settle(ts.getAuth(), 1000);
    for (let i = 0; i < 5; i++) await ts.getAuth();
    expect(world.created()).toBe(1);
    vi.advanceTimersByTime(56 * 60_000);                  // 4 minutes left
    const a = await settle(ts.getAuth(), 1000);
    expect(world.created()).toBe(2);
    expect(a.gen).toBe(2);
    await ts.getAuth();
    expect(world.created()).toBe(2);
  });

  it('AC-3 a 4-minute refresh plus 10 requests opens one window until the 60 s hold ends', async () => {
    const tok = jwt(sec(4 * 60_000), 'short');
    const { world, ts } = source(() => mailboxSteps({ rank: 3, token: tok }));
    const a = await settle(ts.getAuth({ minTtlMs: TC.SEND_MIN_TTL_MS }), 1000);   // accepted although below 10 min
    expect(a.expMs - Date.now()).toBeLessThan(TC.REFRESH_MARGIN_MS);
    expect(ts.describe().hold).toBe(true);
    for (let i = 0; i < 10; i++) await ts.getAuth();
    expect(world.created()).toBe(1);
    vi.advanceTimersByTime(TC.REFRESH_COOLDOWN_MS + 1);
    const b = await settle(ts.getAuth(), 1000);
    expect(world.created()).toBe(2);
    expect(b.gen).toBe(a.gen);                           // the same JWT keeps its generation
    expect(ts.describe().hold).toBe(true);               // and sets the hold again
  });

  it('a same-gen invalidate clears the hold; a stale invalidate is a no-op; peek never opens a window', async () => {
    const { world, ts } = source(() => mailboxSteps({ rank: 3, token: jwt(sec(4 * 60_000), 'short') }));
    expect(() => ts.peek()).toThrow(E.TokenUnavailableError);
    expect(world.created()).toBe(0);
    const a = await settle(ts.getAuth(), 1000);
    ts.invalidate('401', a.gen + 7);
    expect(ts.peek().gen).toBe(a.gen);
    expect(ts.describe().hold).toBe(true);
    ts.invalidate('401', a.gen);
    expect(ts.describe()).toMatchObject({ present: false, hold: false });
    expect(() => ts.peek()).toThrow(E.TokenUnavailableError);
    await settle(ts.getAuth(), 1000);
    expect(world.created()).toBe(2);
  });

  it('a failed refresh cools down for 60 s (no second window)', async () => {
    const { world, ts } = source(() => [{ at: 10, load: 'https://outlook.cloud.microsoft/mail/inbox' }]);
    await expect(settle(ts.getAuth(), TC.BEARER_WAIT_MS + 100)).rejects.toMatchObject({ reason: 'no-bearer' });
    await expect(ts.getAuth()).rejects.toMatchObject({ reason: 'cooldown' });
    expect(world.created()).toBe(1);
  });
});

describe('sign-in wall and hard stop (review 2 #1)', () => {
  it('AC-2 a 20 s sign-in stay with Stay signed in then the mailbox captures a token', async () => {
    const steps = [{ at: 10, nav: 'https://login.microsoftonline.com/common/oauth2/authorize' }, { at: 15_000, nav: 'https://login.microsoftonline.com/kmsi' },
      { at: 20_000, nav: 'https://outlook.cloud.microsoft/mail/' }].concat(mailboxSteps({ rank: 3, expSec: sec(3600_000) }).map((s) => Object.assign({}, s, { at: 20_000 + s.at })));
    const { world, ts } = source(steps);
    const a = await settle(ts.getAuth(), 21_000);
    expect(a.gen).toBe(1);
    expect(world.windows[0].scripts.some((s) => s.includes('idSIButton9') && !/value\s*=\s*['"][^'"]+['"]\s*;/.test(s))).toBe(true);   // click only, never types
  });

  it('AC-2 a 46 s sign-in stay raises ApiAuthBlockedError', async () => {
    const { world, ts } = source([{ at: 10, nav: 'https://login.microsoftonline.com/common/oauth2/authorize' }, { at: 30_000, nav: 'https://adfs.example.test/adfs/ls' }]);
    const p = ts.getAuth();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(TC.TOKEN_AUTH_WALL_MS - 100);
    expect(world.closed()).toBe(0);                       // the second auth hop did not restart the 45 s timer
    await expect(settle(p, 200)).rejects.toBeInstanceOf(E.ApiAuthBlockedError);
    expect(world.closed()).toBe(1);
    expect(ts.describe().lastResult).toBe('auth-blocked');
  });

  it('auth -> Outlook -> auth again starts a fresh timer; an unlisted SSO hop is never cancelled', async () => {
    const steps = [{ at: 10, nav: 'https://login.microsoftonline.com/x' }, { at: 30_000, nav: 'https://sso.idp.example.test/saml' }, { at: 31_000, nav: 'https://outlook.office.com/owa/' },
      { at: 40_000, nav: 'https://login.microsoftonline.com/y' }];
    const { world, ts } = source(steps);
    const p = ts.getAuth();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(50_000);
    expect(world.closed()).toBe(0);                       // the 45 s wall from 10 ms was cleared on the Outlook host
    expect(world.windows[0].url).toBe('https://login.microsoftonline.com/y');
    await expect(settle(p, 11_000)).rejects.toBeInstanceOf(E.ApiAuthBlockedError);   // the hard stop on an auth host
  });

  it('AC-2 a 60 s stop on an Outlook host is token unavailable, not blocked', async () => {
    const { ts } = source([{ at: 10, nav: 'https://outlook.cloud.microsoft/owa/' }]);
    await expect(settle(ts.getAuth(), TC.TOKEN_WINDOW_HARD_MS + 10)).rejects.toMatchObject({ name: 'TokenUnavailableError', reason: 'timeout' });
  });

  it('NFR-4 the token window lives at most 60 s', async () => {
    const { world, ts } = source([{ at: 10, nav: 'https://sso.idp.example.test/wait' }]);
    const p = ts.getAuth();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(TC.TOKEN_WINDOW_HARD_MS - 1);
    expect(world.closed()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(world.closed()).toBe(1);
    await expect(p).rejects.toMatchObject({ reason: 'timeout' });
    expect(Object.keys(TC)).not.toContain('AUTH_GRACE_MS');
  });

  it('FR-5.2 the token window never touches windows it did not create', async () => {
    const { world, ts } = source(() => mailboxSteps({ rank: 3, expSec: sec(3600_000) }));
    await settle(ts.getAuth(), 1000);
    expect(world.touched.other).toBe(0);                  // getAllWindows, other windows' load / close never called
    expect(world.windows.every((w) => w.webContents.debugger.attachCount === 1)).toBe(true);
    const src = require('fs').readFileSync(require.resolve('../src/email-intel/transport/token-source'), 'utf8');
    expect(src).not.toMatch(/getAllWindows|webRequest|cookies\.|clearStorageData|warmOwaSession|will-navigate|will-redirect/);
  });
});

describe('R4-L6 URL classification', () => {
  it('R4-L6 a login URL with redirect_uri to Outlook is an auth URL', () => {
    const u = 'https://login.microsoftonline.com/common/oauth2/authorize?redirect_uri=https%3A%2F%2Foutlook.cloud.microsoft%2F';
    expect(isAuthUrl(u, owaRe)).toBe(true);
    expect(isOutlookUrl(u, owaRe)).toBe(false);
  });
  it('R4-L6 an Outlook URL with a login_hint=adfs query is an Outlook URL', () => {
    const u = 'https://outlook.cloud.microsoft/mail/?login_hint=adfs';
    expect(isOutlookUrl(u, owaRe)).toBe(true);
    expect(isAuthUrl(u, owaRe)).toBe(false);
    expect(isOutlookUrl('https://outlook.office.com.evil.example.test/', owaRe)).toBe(false);
    expect(isAuthUrl('https://sts.example.test/adfs/ls/?x=1', owaRe)).toBe(true);    // path pattern on the URL without its query
  });
});

describe('R4-L7 rank diagnostics and the alternate capture', () => {
  const twoRanks = (t2, t1) => [{ at: 10, load: 'https://outlook.cloud.microsoft/mail/inbox' },
    { at: 20, cdp: { url: 'https://outlook.cloud.microsoft/api/beta/me/x', headers: { authorization: t2, 'x-anchormailbox': 'SENTINEL-ANCHOR' } } },
    { at: 30, cdp: { url: 'https://outlook.cloud.microsoft/owa/x', headers: { authorization: t1, 'x-anchormailbox': 'SENTINEL-ANCHOR' } } }];

  it('R4-L7 alternate(usedGen) returns the other-rank capture with a fresh gen', async () => {
    const t2 = jwt(sec(3600_000), 'rank2'); const t1 = jwt(sec(3600_000), 'rank1');
    const { world, ts } = source(twoRanks(t2, t1));
    const a = await settle(ts.getAuth(), TC.BEARER_SETTLE_MS + 100);
    expect(a.rank).toBe(2);
    expect(a.headers.authorization).toBe(t2);
    const alt = ts.alternate(a.gen);
    expect(alt).toMatchObject({ rank: 1, gen: a.gen + 1 });
    expect(alt.headers.authorization).toBe(t1);
    expect(ts.alternate(a.gen)).toBeNull();               // stale gen
    expect(ts.alternate(alt.gen)).toBeNull();             // no third capture
    expect(world.created()).toBe(1);                      // never an extra window
  });

  it('R4-L7 describe() reports the rank enum and no header value', async () => {
    const t2 = jwt(sec(3600_000), 'rank2');
    const { ts } = source(twoRanks(t2, jwt(sec(3600_000), 'rank1')));
    await settle(ts.getAuth(), TC.BEARER_SETTLE_MS + 100);
    const d = ts.describe();
    expect(d).toMatchObject({ present: true, rank: 2, ttlBucket: '>30m', refreshCount: 1, lastResult: 'ok' });
    expect([0, 1, 2, 3]).toContain(d.rank);
    const s = JSON.stringify(d);
    expect(s).not.toContain(t2.slice(7, 30));
    expect(s).not.toContain('SENTINEL-ANCHOR');
    expect(s).not.toMatch(/Bearer/);
  });
});
