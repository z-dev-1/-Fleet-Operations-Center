import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => sup._reset());

describe('supervisor — classifyFailure (spec #17)', () => {
  it('offline wins over everything', () => {
    sup._setDeps({ isOffline: () => true });
    expect(sup.classifyFailure(new Error('AAP API 401'))).toBe(sup.FAIL.NETWORK_OFFLINE);
  });
  it('MIDWAY_SESSION_INVALID code → AAP_API_UNAUTHORIZED', () => {
    sup._setDeps({ isOffline: () => false });
    expect(sup.classifyFailure(Object.assign(new Error('x'), { code: 'MIDWAY_SESSION_INVALID' }))).toBe(sup.FAIL.AAP_API_UNAUTHORIZED);
  });
  it('401/403 → AAP_API_UNAUTHORIZED', () => {
    sup._setDeps({ isOffline: () => false });
    expect(sup.classifyFailure(Object.assign(new Error('x'), { status: 403 }))).toBe(sup.FAIL.AAP_API_UNAUTHORIZED);
  });
  it('AAP HTTP 500 is a SERVER error, NOT an auth failure (critical #17)', () => {
    sup._setDeps({ isOffline: () => false });
    expect(sup.classifyFailure(Object.assign(new Error('AAP API 500: boom'), { status: 500 }))).toBe(sup.FAIL.AAP_SERVER_ERROR);
    expect(sup.classifyFailure(new Error('AAP API 503: service unavailable'))).toBe(sup.FAIL.AAP_SERVER_ERROR);
  });
  it('DNS vs timeout vs unreachable are distinct NETWORK classes', () => {
    sup._setDeps({ isOffline: () => false });
    expect(sup.classifyFailure(new Error('getaddrinfo ENOTFOUND aap'))).toBe(sup.FAIL.NETWORK_DNS);
    expect(sup.classifyFailure(new Error('request ETIMEDOUT'))).toBe(sup.FAIL.NETWORK_TIMEOUT);
    expect(sup.classifyFailure(new Error('connect ECONNREFUSED'))).toBe(sup.FAIL.TARGET_UNREACHABLE);
  });
  it('SSO wall + session-expired messages classify correctly', () => {
    sup._setDeps({ isOffline: () => false });
    expect(sup.classifyFailure(new Error('settled on SSO login wall — session rejected'))).toBe(sup.FAIL.SSO_LOGIN_WALL);
    expect(sup.classifyFailure(new Error('Midway session cookie expired or missing — run mwinit'))).toBe(sup.FAIL.MIDWAY_SESSION_EXPIRED);
  });
});

describe('supervisor — apiSmokeTest (spec #16)', () => {
  it('offline → not ok, NETWORK_OFFLINE, no API call', async () => {
    let called = false;
    sup._setDeps({ isOffline: () => true, aapApi: { getUserDetails: async () => { called = true; return {}; } } });
    const r = await sup.apiSmokeTest();
    expect(r.ok).toBe(false);
    expect(r.class).toBe(sup.FAIL.NETWORK_OFFLINE);
    expect(called).toBe(false);
  });
  it('200 user object → ok (authenticated)', async () => {
    sup._setDeps({ isOffline: () => false, aapApi: { getUserDetails: async () => ({ alias: 'zilasant', name: 'Z' }) } });
    const r = await sup.apiSmokeTest();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });
  it('401 (MIDWAY_SESSION_INVALID) → not ok, unauthorized class', async () => {
    sup._setDeps({ isOffline: () => false, aapApi: { getUserDetails: async () => { throw Object.assign(new Error('AAP API 401 (session rejected)'), { code: 'MIDWAY_SESSION_INVALID', status: 401 }); } } });
    const r = await sup.apiSmokeTest();
    expect(r.ok).toBe(false);
    expect(r.class).toBe(sup.FAIL.AAP_API_UNAUTHORIZED);
  });
  it('500 → not ok but classified SERVER error (not auth)', async () => {
    sup._setDeps({ isOffline: () => false, aapApi: { getUserDetails: async () => { throw Object.assign(new Error('AAP API 500: boom'), { status: 500 }); } } });
    const r = await sup.apiSmokeTest();
    expect(r.ok).toBe(false);
    expect(r.class).toBe(sup.FAIL.AAP_SERVER_ERROR);
  });
});

describe('supervisor — verifyHealthy (spec #5/#6: real target is authority)', () => {
  it('API smoke passes → HEALTHY via aap-api-smoke (no probe needed)', async () => {
    let probed = false;
    sup._setDeps({ isOffline: () => false,
      aapApi: { getUserDetails: async () => ({ alias: 'z' }) },
      auth: { probeSession: async () => { probed = true; return true; } } });
    const r = await sup.verifyHealthy();
    expect(r.healthy).toBe(true);
    expect(r.via).toContain('aap-api-smoke');
    expect(probed).toBe(false);
  });
  it('API smoke fails but browser probe lands on AAP → HEALTHY via probe', async () => {
    sup._setDeps({ isOffline: () => false,
      aapApi: { getUserDetails: async () => { throw Object.assign(new Error('401'), { status: 401 }); } },
      auth: { probeSession: async () => true } });
    const r = await sup.verifyHealthy();
    expect(r.healthy).toBe(true);
    expect(r.via).toContain('aap-probe');
  });
  it('both fail → NOT healthy with a failure class', async () => {
    sup._setDeps({ isOffline: () => false,
      aapApi: { getUserDetails: async () => { throw Object.assign(new Error('401'), { status: 401 }); } },
      auth: { probeSession: async () => false } });
    const r = await sup.verifyHealthy();
    expect(r.healthy).toBe(false);
    expect(r.class).toBe(sup.FAIL.AAP_API_UNAUTHORIZED);
  });
  it('offline → not healthy, offline flag, no false success', async () => {
    sup._setDeps({ isOffline: () => true });
    const r = await sup.verifyHealthy();
    expect(r.healthy).toBe(false);
    expect(r.offline).toBe(true);
  });
  it('cookie existence is NOT sufficient — a passing file but failing AAP = not healthy', async () => {
    // Even with a "valid" disk session, if AAP rejects, verifyHealthy must say unhealthy.
    sup._setDeps({ isOffline: () => false,
      aapApi: { getUserDetails: async () => { throw Object.assign(new Error('session rejected'), { code: 'MIDWAY_SESSION_INVALID' }); } },
      auth: { probeSession: async () => false, checkMwinit: () => ({ ok: true, expiresInMin: 1196 }) } });
    const r = await sup.verifyHealthy();
    expect(r.healthy).toBe(false);
  });
});

describe('supervisor — buildSnapshot (spec #7: no secrets, VPN never required)', () => {
  it('VPN is always required:false and only context', async () => {
    sup._setDeps({ isOffline: () => false, auth: { checkMwinit: () => ({ ok: true, expiresInMin: 800, aeaExpiresInMin: null }) } });
    const s = await sup.buildSnapshot({ state: sup.STATE.DEGRADED });
    expect(s.vpn.required).toBe(false);
    expect(s.internet.online).toBe(true);
    expect(s.diskSession.present).toBe(true);
    expect(s.diskAea.present).toBe(false);   // aeaExpiresInMin null => missing
    expect(s.state).toBe('DEGRADED');
  });
  it('snapshot carries no cookie values / tokens', async () => {
    sup._setDeps({ isOffline: () => false, auth: { checkMwinit: () => ({ ok: true, expiresInMin: 800, aeaExpiresInMin: 60 }) } });
    const s = await sup.buildSnapshot({});
    const json = JSON.stringify(s).toLowerCase();
    expect(json).not.toMatch(/cookie.*value|__host-session|amazon_enterprise_access|token":|secret/);
    expect(s.diskAea.present).toBe(true);
    expect(s.diskAea.expiresInMin).toBe(60);
  });
});
