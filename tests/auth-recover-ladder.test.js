import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Mock electron so auth.js can be required in a plain node/vitest context
// without a real BrowserWindow/session. Only the surface auth.js touches.
vi.mock('electron', () => ({
  session: { defaultSession: { cookies: { get: async () => [], set: async () => {}, flushStore: async () => {} } } },
  BrowserWindow: class { constructor() {} loadURL() {} destroy() {} webContents = { on() {}, getURL: () => '' }; },
  net: { isOnline: () => true },
}));

const auth = require('../src/scrapers/auth');

describe('auth.recoverAuth — ladder gates the mwinit prompt', () => {
  it('is exported as a function', () => {
    expect(typeof auth.recoverAuth).toBe('function');
  });

  it('rung 1 OFFLINE: defers without prompting', async () => {
    // Force the offline module to report offline.
    const offline = require('../src/orcha/offline');
    const spy = vi.spyOn(offline, 'isOffline').mockReturnValue(true);
    try {
      const res = await auth.recoverAuth('test:offline');
      expect(res.rung).toBe('offline');
      expect(res.prompted).toBe(false);
      expect(res.recovered).toBe(false);
    } finally { spy.mockRestore(); }
  });

  // NOTE: the deeper rungs (VPN -> silent AEA refresh -> mwinit) each open a
  // real Electron BrowserWindow (probeSession) and are not dependency-injected,
  // so they can't be isolated in a plain vitest context without refactoring
  // working auth code purely for testability. Those rungs are verified by the
  // live-log watch after restart (the real proof for auth behavior): we confirm
  // the ladder logs "recoverAuth rung=silent ... recovered" and does NOT spawn
  // mwinit while the session is valid. The offline short-circuit above is the
  // single most important invariant to lock in a unit test — offline must NEVER
  // prompt — and it is covered.
});
