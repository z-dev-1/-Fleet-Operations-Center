// OBS FEAT-001 (plan items 1-2, design §4.2 / §4.7): OBS error codes + the hint/canLaunch whitelist (F4),
// and the pure obs-auth helpers (authString, closeCodeToError, isRefused, exeSyntaxOk, hasUuidSupport F10).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import nodeCrypto from 'node:crypto';

const require = createRequire(import.meta.url);
const errors = require('../src/zoom/errors');
const A = require('../src/zoom/studio/obs-auth');

const OBS_MESSAGES = {
  OBS_UNREACHABLE: "Can't reach OBS.",
  OBS_NOT_RUNNING: "OBS isn't running.",
  OBS_SERVER_DISABLED: 'The WebSocket server is off in OBS.',
  OBS_PASSWORD_REQUIRED: 'OBS needs its WebSocket password.',
  OBS_AUTH_FAILED: 'OBS rejected the password.',
  OBS_NOT_INSTALLED: "OBS wasn't found at that path.",
  OBS_NAME_CONFLICT: "An OBS scene or source named 'Fleet Camera' / 'Fleet Camera Feed' already exists and isn't Fleet's. Rename it in OBS.",
  OBS_REQUEST_FAILED: 'OBS refused a request.',
  OBS_CLOSED: 'OBS closed the connection.',
  OBS_UNSUPPORTED: "This OBS WebSocket version isn't supported.",
  OBS_FEED_FAILED: "Fleet couldn't start the OBS feed.",
};

describe('OBS errors', () => {
  it('errors: OBS codes have fixed messages and hint/canLaunch pass the whitelist', () => {
    for (const [code, msg] of Object.entries(OBS_MESSAGES)) {
      expect(errors.MESSAGES[code]).toBe(msg);
      expect(errors.CODES).toContain(code);
      expect(new errors.ZoomError(code).message).toBe(msg);
    }
    expect(errors.EXTRA_WHITELIST).toContain('canLaunch');
    expect(errors.EXTRA_WHITELIST).toContain('hint');
    expect(errors.fail('OBS_NOT_RUNNING', { canLaunch: true, password: 'x', token: 'y' })).toEqual({ ok: false, code: 'OBS_NOT_RUNNING', canLaunch: true });
    expect(errors.fail('OBS_SERVER_DISABLED', { hint: true })).toEqual({ ok: false, code: 'OBS_SERVER_DISABLED', hint: true });
    expect(errors.toResult(new errors.ZoomError('OBS_REQUEST_FAILED', { status: 600, reason: 'GetSceneList' })))
      .toEqual({ ok: false, code: 'OBS_REQUEST_FAILED', status: 600, reason: 'GetSceneList' });
  });
});

describe('obs-auth', () => {
  it('authString matches an independent sha256/base64 digest', () => {
    const h = (s) => nodeCrypto.createHash('sha256').update(s, 'utf8').digest('base64');
    const pw = 'supersecretpassword'; const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI='; const ch = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';
    expect(A.authString(pw, salt, ch)).toBe(h(h(pw + salt) + ch));
    expect(A.authString('a', 'b', 'c')).not.toBe(A.authString('a', 'b', 'd'));
  });

  it('closeCodeToError maps 4009, 4010 and other codes', () => {
    expect(A.closeCodeToError(4009)).toBe('OBS_AUTH_FAILED');
    expect(A.closeCodeToError(4010)).toBe('OBS_UNSUPPORTED');
    for (const c of [1000, 1006, 4000, 4011, 4012, undefined]) expect(A.closeCodeToError(c)).toBe('OBS_CLOSED');
  });

  it('isRefused handles ECONNREFUSED and AggregateError.errors[0]', () => {
    expect(A.isRefused(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    const agg = new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), new Error('b')]);
    expect(A.isRefused(agg)).toBe(true);
    expect(A.isRefused(new AggregateError([Object.assign(new Error('a'), { code: 'ETIMEDOUT' })]))).toBe(false);
    expect(A.isRefused(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
    expect(A.isRefused(null)).toBe(false);
    expect(A.isRefused(undefined)).toBe(false);
  });

  it('exeSyntaxOk accepts absolute obs64.exe and rejects UNC, relative, >260 and other basenames', () => {
    expect(A.exeSyntaxOk('C:/Program Files/obs-studio/bin/64bit/obs64.exe')).toBe(true);
    expect(A.exeSyntaxOk('C:\\Program Files\\obs-studio\\bin\\64bit\\OBS64.EXE')).toBe(true);
    expect(A.exeSyntaxOk('\\\\server\\share\\obs64.exe')).toBe(false);
    expect(A.exeSyntaxOk('//server/share/obs64.exe')).toBe(false);
    expect(A.exeSyntaxOk('obs-studio\\bin\\64bit\\obs64.exe')).toBe(false);
    expect(A.exeSyntaxOk('obs64.exe')).toBe(false);
    expect(A.exeSyntaxOk('C:/' + 'a'.repeat(250) + '/obs64.exe')).toBe(false);
    expect(A.exeSyntaxOk('C:/obs/obs32.exe')).toBe(false);
    expect(A.exeSyntaxOk('C:/obs/obs64.exe.bat')).toBe(false);
    expect(A.exeSyntaxOk('C:/obs/obs64.exe\0')).toBe(false);
    expect(A.exeSyntaxOk('')).toBe(false);
    expect(A.exeSyntaxOk(null)).toBe(false);
    expect(A.exeSyntaxOk(42)).toBe(false);
  });

  it('hasUuidSupport parses major.minor numerically; unparseable is false', () => {
    expect(A.hasUuidSupport('5.5.2')).toBe(true);
    expect(A.hasUuidSupport('5.3.0')).toBe(true);
    expect(A.hasUuidSupport('5.10.0')).toBe(true);     // numeric, not lexical
    expect(A.hasUuidSupport('6.0.0')).toBe(true);
    expect(A.hasUuidSupport('5.2.3')).toBe(false);
    expect(A.hasUuidSupport('5.0.1')).toBe(false);
    expect(A.hasUuidSupport('4.9.1')).toBe(false);
    for (const v of ['garbage', 'x.y', '', null, undefined, {}, 'five.three']) expect(A.hasUuidSupport(v)).toBe(false);
  });

  it('requires only crypto and path', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../src/zoom/studio/obs-auth.js'), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
    expect(reqs).toEqual(['crypto', 'path']);
  });
});
