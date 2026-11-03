// tests/auth-coord-impl-bodies.test.js — Phase 9 REQUIRED FIX 3 acceptance check.
// The rename-and-wrap must keep the wrapped bodies BYTE-FOR-BYTE identical to
// base d57e9b5. Body = the lines after the declaration line through the first
// following line that is exactly "}" (CR stripped, LF-joined). The SHA-256
// constants were computed from `git show d57e9b5:src/scrapers/auth.js` during
// planning — never recompute them from the edited file. The scripted twin is
// `node tests/helpers/check-impl-bodies.cjs d57e9b5` (prints a line diff).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { extractBody } = require('./helpers/check-impl-bodies.cjs');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(HERE, '..', 'src', 'scrapers', 'auth.js'), 'utf8').replace(/\r/g, '');

const EXPECTED = [
  ['async function _injectCookiesImpl(targetSession, opts) {', '796a98c62c3aa5a7f11d9ea4dd8fefc015eedf54364421330df4395a652d70a4'],
  ['async function _injectAeaFromPostureTokenImpl(targetSession) {', 'ac3ea22ba0d1129005c9d2d0117e9e57761a487c603d97891df2c9c4e5860a21'],
  ['async function _probeSessionImpl() {', 'b70806ea1531871d8e11c099847b72cc7a63516e2c5f857fac39a14dbe44fbfa'],
  ['async function _refreshAeaSilentlyImpl() {', 'e46d6acf3fb2039f5ed4be3486dad5e84887d0b3bbde8e92b4353f68f5e55eff'],
  ['function runMwinit(force) {', '968933cc208742ace1f5954aa157b0c0f67ec2d600e8661604cb9b72dcd742ff'],
];

function wrapperSource(decl) {
  const lines = SRC.split('\n');
  const i = lines.indexOf(decl);
  if (i < 0) return null;
  const out = [];
  for (let j = i; j < lines.length; j++) { out.push(lines[j]); if (lines[j] === '}') break; }
  return out.join('\n');
}

describe('FIX 3 — impl bodies unchanged vs d57e9b5', () => {
  for (const [decl, sha] of EXPECTED) {
    it(decl, () => {
      const body = extractBody(SRC, decl);
      expect(body).not.toBeNull();
      expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(sha);
    });
  }

  it('the old declarations exist only as thin wrappers around the impls', () => {
    const ic = wrapperSource('async function injectCookies(targetSession, opts) {');
    expect(ic).not.toBeNull();
    expect(ic.match(/_bumpIfDefault\(targetSession\)/g)).toHaveLength(2);
    expect(ic).toContain('return await _injectCookiesImpl(targetSession, opts);');
    const ia = wrapperSource('async function injectAeaFromPostureToken(targetSession) {');
    expect(ia).not.toBeNull();
    expect(ia.match(/_bumpIfDefault\(targetSession\)/g)).toHaveLength(2);
    expect(ia).toContain('return await _injectAeaFromPostureTokenImpl(targetSession);');
  });

  it('recoverAuth: VPN rung probe and r2 pass { fresh: true }; rung 3 keeps no opts', () => {
    const rec = wrapperSource('async function recoverAuth(reason, opts) {');
    expect(rec).toContain('if (await probeSession({ fresh: true })) {');
    expect(rec).toContain('const r2 = await refreshAeaSilently({ fresh: true });');
    expect(rec).toContain('const r = await refreshAeaSilently();');
  });
});
