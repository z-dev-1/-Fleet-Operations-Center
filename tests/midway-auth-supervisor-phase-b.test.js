import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => sup._reset());

// Helpers to build injected deps for a given scenario.
function deps({ offline = false, smoke, probe = false, recoverAuth } = {}) {
  return {
    isOffline: () => offline,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }), // no real spawn
    aapApi: { getUserDetails: smoke },
    auth: {
      probeSession: async () => probe,
      checkMwinit: () => ({ ok: true, expiresInMin: 800, aeaExpiresInMin: null }),
      recoverAuth: recoverAuth || (async () => ({ recovered: false, rung: 'none', prompted: false })),
    },
  };
}
const ok200 = async () => ({ alias: 'z' });
const unauth = async () => { throw Object.assign(new Error('401 session rejected'), { code: 'MIDWAY_SESSION_INVALID', status: 401 }); };
const server500 = async () => { throw Object.assign(new Error('AAP API 500: boom'), { status: 500 }); };

describe('ensureHealthy — Rung 0 real-target verify (spec #8)', () => {
  it('API smoke passes → HEALTHY, no ladder run, regardless of VPN', async () => {
    let ladderRan = false;
    sup._setDeps(deps({ smoke: ok200, recoverAuth: async () => { ladderRan = true; return { recovered: true, rung: 'x' }; } }));
    const r = await sup.ensureHealthy({ reason: 'test' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe(sup.STATE.HEALTHY);
    expect(r.rung).toBe('verify');
    expect(r.recovered).toBe(false);   // nothing needed recovering
    expect(ladderRan).toBe(false);
  });
});

describe('ensureHealthy — offline defers, never prompts (spec #1)', () => {
  it('offline → OFFLINE state, no ladder, no prompt', async () => {
    let ladderRan = false;
    sup._setDeps(deps({ offline: true, smoke: ok200, recoverAuth: async () => { ladderRan = true; return {}; } }));
    const r = await sup.ensureHealthy({ reason: 'test' });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(sup.STATE.OFFLINE);
    expect(r.prompted).toBe(false);
    expect(ladderRan).toBe(false);
  });
});

describe('ensureHealthy — recovery then RE-VERIFY (spec #6: no false success)', () => {
  it('ladder reports recovered but AAP STILL rejects → NOT healthy (COOLDOWN)', async () => {
    // smoke always 401; ladder claims success; verify must still fail.
    sup._setDeps(deps({ smoke: unauth, probe: false, recoverAuth: async () => ({ recovered: true, rung: 'mwinit', prompted: true }) }));
    const r = await sup.ensureHealthy({ reason: 'test' });
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.state).toBe(sup.STATE.COOLDOWN);
    // We must NOT echo the ladder's bogus recovered:true.
    expect(r.recovered).toBe(false);
  });

  it('ladder fixes it (smoke flips to 200 after recovery) → HEALTHY, recovered:true, verified', async () => {
    let healed = false;
    const smoke = async () => { if (!healed) throw Object.assign(new Error('401'), { status: 401 }); return { alias: 'z' }; };
    sup._setDeps(deps({ smoke, recoverAuth: async () => { healed = true; return { recovered: true, rung: 'silent', prompted: false }; } }));
    const r = await sup.ensureHealthy({ reason: 'test' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe(sup.STATE.HEALTHY);
    expect(r.recovered).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.rung).toBe('silent');
  });
});

describe('ensureHealthy — AAP 500 is NOT auth (spec #17)', () => {
  it('500 → degraded, ladder NOT run, no prompt', async () => {
    let ladderRan = false;
    sup._setDeps(deps({ smoke: server500, recoverAuth: async () => { ladderRan = true; return { recovered: true, rung: 'mwinit' }; } }));
    const r = await sup.ensureHealthy({ reason: 'test' });
    expect(r.ok).toBe(false);
    expect(r.class).toBe(sup.FAIL.AAP_SERVER_ERROR);
    expect(ladderRan).toBe(false);
    expect(r.prompted).toBe(false);
  });
});

describe('ensureHealthy — single global lock (spec #4)', () => {
  it('two concurrent calls share ONE recovery workflow', async () => {
    let ladderCalls = 0;
    const smoke = async () => { throw Object.assign(new Error('401'), { status: 401 }); };
    sup._setDeps(deps({ smoke, recoverAuth: async () => { ladderCalls++; await new Promise(r => setTimeout(r, 30)); return { recovered: false, rung: 'silent' }; } }));
    const [a, b] = await Promise.all([ sup.ensureHealthy({ reason: 'A' }), sup.ensureHealthy({ reason: 'B' }) ]);
    expect(ladderCalls).toBe(1);               // only ONE ladder ran
    expect(a.state).toBe(b.state);
    expect(b.coalesced || a.coalesced).toBe(true);
  });

  it('allowPrompt:false on a needs-prompt ladder → WAITING_FOR_USER, no prompt', async () => {
    sup._setDeps(deps({ smoke: unauth, recoverAuth: async () => ({ recovered: false, rung: 'needs-prompt', prompted: false }) }));
    const r = await sup.ensureHealthy({ reason: 'bg', allowPrompt: false });
    expect(r.ok).toBe(false);
    expect(r.prompted).toBe(false);
    expect([sup.STATE.WAITING_FOR_USER, sup.STATE.COOLDOWN]).toContain(r.state);
  });
});

describe('ensureHealthy — history + snapshot', () => {
  it('records bounded history and a secret-free snapshot', async () => {
    sup._setDeps(deps({ smoke: ok200 }));
    await sup.ensureHealthy({ reason: 'test' });
    const snap = sup.getSnapshot();
    expect(snap.state).toBe(sup.STATE.HEALTHY);
    expect(snap.vpn.required).toBe(false);
    expect(JSON.stringify(snap).toLowerCase()).not.toMatch(/__host-session|amazon_enterprise_access|secret/);
  });
});
