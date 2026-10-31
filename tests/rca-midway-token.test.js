// tests/rca-midway-token.test.js
//
// RCA's Midway id_token must come from the app's LIVE AAP session (the same
// one every AAP API call uses), with the cookie file only as a fallback.
// Regression: RCA failed with "Midway /SSO HTTP 403" once the AEA cookie in
// ~/.midway/cookie lapsed, while the rest of the app (live session, AEA
// keepalive) kept working.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mt = require('../src/rca/midway_token');

// A syntactically valid JWT with exp 15 min out (signature irrelevant here).
function jwt(minutes = 15) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b64({ alg: 'none' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) + minutes * 60 }) + '.sig';
}

describe('rca midway_token', () => {
  beforeEach(() => mt.clear());

  it('mints through the app session first (in-page /SSO, same as AAP)', async () => {
    const scripts = [];
    const tok = jwt();
    const aap = { evaluateInPage: async (s) => { scripts.push(s); return { status: 200, token: tok }; } };
    let fileCalls = 0;
    const t = await mt.getIdToken('aap-na.corp.amazon.com', {}, { aap, fetchFromFile: async () => { fileCalls++; return jwt(); } });
    expect(t).toBe(tok);
    expect(fileCalls).toBe(0);
    expect(scripts[0]).toContain('https://midway-auth.amazon.com/SSO?');
    expect(scripts[0]).toContain("credentials: 'include'");
    expect(scripts[0]).toContain('client_id=aap-na.corp.amazon.com');
  });

  it('falls back to the cookie file when the app session mint fails', async () => {
    const aap = { evaluateInPage: async () => ({ status: 403, body: 'Forbidden' }) };
    const fileTok = jwt();
    const t = await mt.getIdToken('aap-na.corp.amazon.com', {}, { aap, fetchFromFile: async () => fileTok });
    expect(t).toBe(fileTok);
  });

  it('falls back when the app AAP page cannot open at all', async () => {
    const aap = { evaluateInPage: async () => { throw Object.assign(new Error('AAP session expired'), { code: 'MIDWAY_SESSION_INVALID' }); } };
    const fileTok = jwt();
    expect(await mt.getIdToken('aap-na.corp.amazon.com', {}, { aap, fetchFromFile: async () => fileTok })).toBe(fileTok);
  });

  it('reuses a fresh cached token (no second mint) until near expiry; force re-mints', async () => {
    let n = 0;
    const aap = { evaluateInPage: async () => { n++; return { status: 200, token: jwt() }; } };
    await mt.getIdToken('aap-na.corp.amazon.com', {}, { aap });
    await mt.getIdToken('aap-na.corp.amazon.com', {}, { aap });
    expect(n).toBe(1);
    await mt.getIdToken('aap-na.corp.amazon.com', { force: true }, { aap });
    expect(n).toBe(2);
  });

  it('surfaces the cookie-file error if both paths fail', async () => {
    const aap = { evaluateInPage: async () => ({ status: 403 }) };
    await expect(mt.getIdToken('aap-na.corp.amazon.com', {}, {
      aap, fetchFromFile: async () => { throw Object.assign(new Error('Midway /SSO HTTP 403'), { code: 'MIDWAY_TOKEN_FAILED' }); },
    })).rejects.toThrow(/403/);
  });
});
