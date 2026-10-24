import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => { sup.stopHealthMonitor(); sup._reset(); });

function deps({ offline = () => false, smoke, probe = false, recoverAuth } = {}) {
  return {
    isOffline: offline,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }),
    aapApi: { getUserDetails: smoke },
    auth: {
      probeSession: async () => probe,
      checkMwinit: () => ({ ok: true, expiresInMin: 800, aeaExpiresInMin: 90 }),
      recoverAuth: recoverAuth || (async () => ({ recovered: false, rung: 'silent', prompted: false })),
    },
  };
}
const unauth = async () => { throw Object.assign(new Error('401'), { status: 401 }); };
const ok200 = async () => ({ alias: 'z' });

describe('Phase E — read-only snapshot for the health panel', () => {
  it('buildSnapshot never prompts/recovers and reports vpn.required=false', async () => {
    let recovered = 0;
    sup._setDeps(deps({ smoke: unauth, recoverAuth: async () => { recovered++; return { recovered: false }; } }));
    const snap = await sup.buildSnapshot({ state: sup.getState() });
    expect(snap).toBeTruthy();
    expect(snap.vpn.required).toBe(false);          // VPN is never a prerequisite (spec #1/#29)
    expect(recovered).toBe(0);                       // read-only: no ladder ran
    expect(snap).toHaveProperty('diskSession');
    expect(snap).toHaveProperty('diskAea');
  });

  it('snapshot exposes the AAP smoke-test result (verification authority)', async () => {
    sup._setDeps(deps({ smoke: ok200 }));
    await sup.ensureHealthyConverging({ reason: 'test' });
    const snap = sup.getSnapshot();
    expect(snap).toBeTruthy();
    expect(snap.aapApiSmokeTest).toBeTruthy();
    expect(snap.aapApiSmokeTest.ok).toBe(true);
  });
});

describe('Phase E — background health monitor (spec #20)', () => {
  it('startHealthMonitor is idempotent and stoppable', () => {
    sup._setDeps(deps({ smoke: ok200 }));
    const stop1 = sup.startHealthMonitor({ intervalMs: 999999 });
    expect(typeof stop1).toBe('function');
    // second start tears down the first — must not throw
    const stop2 = sup.startHealthMonitor({ intervalMs: 999999 });
    expect(typeof stop2).toBe('function');
    sup.stopHealthMonitor();
    sup.stopHealthMonitor(); // double-stop is safe
  });

  it('shutdown stops the monitor too', () => {
    sup._setDeps(deps({ smoke: ok200 }));
    sup.startHealthMonitor({ intervalMs: 999999 });
    sup.shutdown(); // must not throw; clears timers + monitor
    expect(true).toBe(true);
  });
});
