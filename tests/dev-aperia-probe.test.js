// tests/dev-aperia-probe.test.js — the DEV-ONLY, READ-ONLY Aperia discovery probe (src/dev/dev-aperia-probe.js)
// and the Aperia redact helpers (src/aperia/redact.js). Fakes only; never run against Aperia here. Proves:
//  - redactText / redactDeep / buildOutput / describeFrame / analyzeBundle drop sentinel token, cookie, JWT,
//    email and phone values while business data (unit ids, ISO times, severities) survives,
//  - a POST mint is never sent; a GET with literal params is planned once,
//  - run() with fake transport + CDP observer writes <dataDir>/dev/aperia-probe-<date>.json with no sentinel,
//    calls GET paths only (never a forbidden endpoint), and logs counts only,
//  - start() is inert without FLEET_DEV_APERIA_PROBE=1; app.js gates the require on it.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = require('../src/dev/dev-aperia-probe');
const R = require('../src/aperia/redact');
const C = require('../src/aperia/constants');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const SENT_JWT = 'eyJhbGciOiJIUzI1NiJ9.' + b64({ sub: 'halo-alert-actioning@amazon.com', scope: 'WEB', iat: 1000, exp: 1000 + 8 * 3600 }) + '.SENTINELjwtSIG';
const SENT_BEARER = 'SENTINELbearerTOKEN0123456789abcdef';
const SENT_WS = 'eyJhbGciOiJIUzI1NiJ9.' + b64({ sub: 'x', scope: 'WEB', iat: 1, exp: 2 }) + '.SENTINELwsSIG';
const SENT_COOKIE = 'SENTINELcookieVALUE42';
const SENT_EMAIL = 'sentinel.person@example.com';
const SENT_PHONES = ['(555) 867-5309', '555-867-5309', '+1 555.867.5309', '+15558675309'];
const SENTINELS = [SENT_JWT, SENT_BEARER, SENT_WS, SENT_COOKIE, SENT_EMAIL, 'SENTINELjwtSIG', 'SENTINELwsSIG', 'sentinel.person', '867-5309', '867.5309', '5558675309'];
const hasSentinel = (s) => SENTINELS.filter((x) => String(s).includes(x));

afterEach(() => { probe._resetForTests(); });

describe('redact helpers', () => {
  it('redactText removes Bearer, x-authorization, cookies, JWTs, emails and phones', () => {
    const s = [
      'Authorization: Bearer ' + SENT_BEARER,
      'wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + SENT_WS + '&a=1',
      'Cookie: SESSION=' + SENT_COOKIE + '; other=1',
      'set-cookie=' + SENT_COOKIE,
      'raw ' + SENT_JWT,
      'mail ' + SENT_EMAIL,
    ].concat(SENT_PHONES.map((p) => 'call ' + p)).join('\n');
    expect(hasSentinel(R.redactText(s))).toEqual([]);
  });

  it('keeps business data: unit ids, ISO times, VIN-like strings, severities', () => {
    const s = 'unit 122269 at 2026-11-22T14:05:33Z vin 1FUJGLDR5CLBP1234 CRITICAL UNDERINFLATION L1IC 105.5';
    expect(R.redactText(s)).toBe(s);
  });

  it('redactDeep drops sensitive keys and scrubs every string; secrets list removes opaque tokens', () => {
    const v = {
      account: { id: 7, name: 'DFW5' },
      contacts: [{ email: SENT_EMAIL, phoneNumber: SENT_PHONES[0], firstName: 'Sentinelfirst' }],
      manager: { email: SENT_EMAIL, mobile: SENT_PHONES[1] },
      token: SENT_WS, authorization: 'Bearer ' + SENT_BEARER, note: 'opaque ' + SENT_BEARER,
      list: ['x ' + SENT_EMAIL, { cookie: SENT_COOKIE }],
    };
    const out = JSON.stringify(R.redactDeep(v, [SENT_BEARER]));
    expect(hasSentinel(out)).toEqual([]);
    expect(out).not.toContain('Sentinelfirst');
    expect(out).toContain('DFW5');
  });

  it('redactUrl keeps query names only', () => {
    expect(R.redactUrl('wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + SENT_WS)).toBe('wss://amazon.aperiatech.com/api/ws/events?x-authorization');
  });
});

describe('probe pure helpers', () => {
  it('describeFrame (JSON, STOMP, text) leaves no sentinel and keeps event field names', () => {
    const json = JSON.stringify({ type: 'ISSUE_CREATED', payload: { fleetVehicleId: '122269', severity: 'CRITICAL', createdBy: SENT_EMAIL, token: SENT_WS, phone: SENT_PHONES[2] } });
    const d = probe.describeFrame(json, 1, [SENT_BEARER]);
    expect(d.kind).toBe('json');
    expect(d.eventFields.type).toBe('ISSUE_CREATED');
    expect(d.eventFields['payload.severity']).toBe('CRITICAL');
    const stomp = 'CONNECT\nAuthorization:Bearer ' + SENT_BEARER + '\nx-authorization:' + SENT_WS + '\ndestination:/topic/alerts\n\n' + JSON.stringify({ who: SENT_EMAIL }) + '\u0000';
    const s = probe.describeFrame(stomp, 1, []);
    expect(s.kind).toBe('stomp');
    expect(s.headers.destination).toBe('/topic/alerts');
    const t = probe.describeFrame('hello ' + SENT_EMAIL + ' ' + SENT_PHONES[3] + ' ' + SENT_JWT, 1, []);
    expect(hasSentinel(JSON.stringify([d, s, t]))).toEqual([]);
  });

  it('analyzeBundle reads the mint call site with redacted excerpts; mintPlan never sends a POST', () => {
    const postBundle = 'var a="' + SENT_JWT + '";const s="' + SENT_EMAIL + '";function m(){return h.post("/api/v1/notifications/token",{scope:"WEB"})}'
      + 'new WebSocket(`wss://amazon.aperiatech.com/api/ws/events?x-authorization=${t}`);';
    const a = probe.analyzeBundle(postBundle);
    expect(a.mint.length).toBe(1);
    expect(a.mint[0].method).toBe('POST');
    expect(Object.keys(a.sites)).toEqual(expect.arrayContaining(['notifications/token', 'ws/events', 'new WebSocket']));
    expect(hasSentinel(JSON.stringify(a))).toEqual([]);
    expect(probe.mintPlan(a.mint)).toMatchObject({ send: false, reason: 'WRITE_METHOD_NOT_SENT' });

    const getBundle = 'function m(){return h.get("/api/v1/notifications/token",{params:{type:"WEB",ttl:8}})}';
    const plan = probe.mintPlan(probe.analyzeBundle(getBundle).mint);
    expect(plan).toMatchObject({ send: true, method: 'GET', path: '/api/v1/notifications/token?type=WEB&ttl=8' });
    const varBundle = 'function m(e){return h.get("/api/v1/notifications/token",{params:{type:e}})}';
    expect(probe.mintPlan(probe.analyzeBundle(varBundle).mint)).toMatchObject({ send: false, reason: 'PARAM_VALUES_NOT_LITERAL' });
    expect(probe.mintPlan([])).toMatchObject({ send: false, reason: 'NO_CALL_SITE' });
  });

  it('buildOutput scrubs nested sentinels with the secrets list', () => {
    const raw = { a: { b: ['Bearer ' + SENT_BEARER, SENT_BEARER, { email: SENT_EMAIL }, 'c=' + SENT_COOKIE] }, url: '?x-authorization=' + SENT_WS };
    expect(hasSentinel(JSON.stringify(probe.buildOutput(raw, [SENT_BEARER, SENT_COOKIE])))).toEqual([]);
  });
});

describe('run() with fakes', () => {
  function fakeWc(bodies) {
    let fn = null;
    const dbg = {
      on(ev, f) { if (ev === 'message') fn = f; },
      removeListener() { fn = null; },
      async sendCommand(m, p) { if (m === 'Network.getResponseBody') return { body: bodies[p.requestId] || '', base64Encoded: false }; return {}; },
    };
    return { wc: { debugger: dbg }, emit: (m, p) => fn && fn({}, m, p) };
  }

  it('writes a sentinel-free file, GETs only allowed paths, logs counts only', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-probe-'));
    const bundle = 'x="' + SENT_JWT + '";y.get("/api/v1/notifications/token",{params:{type:"WEB"}});z="' + SENT_EMAIL + '"';
    const mintResp = JSON.stringify({ token: SENT_WS, owner: SENT_EMAIL });
    const fx = fakeWc({ s1: bundle, m1: mintResp });
    const obs = probe.createObserver(fx.wc, () => [SENT_BEARER]);
    const wsUrl = 'wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + SENT_WS;
    fx.emit('Network.responseReceived', { requestId: 's1', type: 'Script', response: { url: 'https://amazon.aperiatech.com/assets/index-AbC123.js', status: 200 } });
    fx.emit('Network.loadingFinished', { requestId: 's1', encodedDataLength: bundle.length });
    fx.emit('Network.requestWillBeSent', { requestId: 'm1', request: { url: 'https://amazon.aperiatech.com/api/v1/notifications/token?type=WEB', method: 'GET', headers: { Authorization: 'Bearer ' + SENT_BEARER, Cookie: 'a=' + SENT_COOKIE } } });
    fx.emit('Network.responseReceived', { requestId: 'm1', response: { url: 'https://amazon.aperiatech.com/api/v1/notifications/token', status: 200 } });
    fx.emit('Network.loadingFinished', { requestId: 'm1' });
    fx.emit('Network.webSocketCreated', { requestId: 'w1', url: wsUrl });
    fx.emit('Network.webSocketHandshakeResponseReceived', { requestId: 'w1', response: { status: 101 } });
    fx.emit('Network.webSocketFrameSent', { requestId: 'w1', response: { opcode: 1, payloadData: JSON.stringify({ action: 'SUBSCRIBE', auth: SENT_WS }) } });
    fx.emit('Network.webSocketFrameReceived', { requestId: 'w1', response: { opcode: 1, payloadData: JSON.stringify({ type: 'ALERT', data: { fleetVehicleId: '122269', user: SENT_EMAIL, phone: SENT_PHONES[0], echo: SENT_BEARER } }) } });

    const calls = [];
    const transport = {
      async getJson(p) {
        calls.push(p);
        if (p.startsWith('/api/v1/issues/by/vehicle')) return { ok: true, status: 200, value: { content: [{ id: 99, fleetVehicleId: '122269', account: { id: 1, name: 'DFW5' }, contacts: [{ email: SENT_EMAIL }], issues: [{ id: 5, severity: 'CRITICAL', state: 'LEAK' }] }], totalElements: 1, totalPages: 1 } };
        if (p.startsWith('/api/v1/vehicles?')) return { ok: true, status: 200, value: { vehicles: [{ id: 99, fleetVehicleId: '122269', vin: 'V' }], totalElements: 8811, totalPages: 18, totalUnfilteredElements: 8811 } };
        if (p === '/api/v1/vehicles/99') return { ok: true, status: 200, value: { id: 99, sensors: [{ id: 1, position: 'L1IC', pressure: 100, setPoint: 105, faulted: false, issue: { id: 5, severity: 'CRITICAL', actions: ['Inflate'] } }], latestGeoTag: { latitude: 32.9, longitude: -97.0 } } };
        if (p.startsWith('/api/v1/notifications/token')) return { ok: true, status: 200, value: { token: SENT_WS } };
        return { ok: false, code: 'UNEXPECTED' };
      },
    };
    const lines = [];
    const log = { info: (s) => lines.push(String(s)), warn: (s) => lines.push(String(s)), error: (s) => lines.push(String(s)) };
    const r = await probe.run({
      log, observer: obs, transport, capture: { current: () => SENT_BEARER },
      session: { loginWindow: () => null, getSession: () => ({}) },
      getDataDir: () => TMP, now: () => Date.parse('2026-11-22T12:00:00Z'), wsWatchMs: 0, timeoutMs: 20000,
    });
    expect(r).toMatchObject({ ok: true, file: 'aperia-probe-2026-11-22.json' });
    const text = fs.readFileSync(path.join(TMP, 'dev', 'aperia-probe-2026-11-22.json'), 'utf8');
    expect(hasSentinel(text)).toEqual([]);
    expect(hasSentinel(lines.join('\n'))).toEqual([]);
    const out = JSON.parse(text);
    expect(out.rest.vehicles).toMatchObject({ code: 'OK', rows: 1, totalElements: 8811 });
    expect(out.rest.vehicle).toMatchObject({ code: 'OK', sensors: 1, sensorsWithIssue: 1, from: 'issues' });
    expect(out.rest.issues).toMatchObject({ code: 'OK', rows: 1, issues: 1, bySeverity: { CRITICAL: 1 } });
    expect(out.mint.plan).toMatchObject({ send: true, method: 'GET' });
    expect(out.mint.attempt).toMatchObject({ code: 'OK', tokenLike: 1 });
    expect(out.mint.portalCalls[0]).toMatchObject({ method: 'GET', queryNames: ['type'], status: 200 });
    expect(out.ws.sockets[0]).toMatchObject({ url: 'wss://amazon.aperiatech.com/api/ws/events?x-authorization', status: 101, received: 1, sent: 1 });
    expect(out.ws.frames.received[0].eventFields.type).toBe('ALERT');
    expect(lines.some((l) => l.startsWith('[aperia-probe] done '))).toBe(true);
    // GET paths only, never a forbidden endpoint.
    expect(calls.every((p) => p.startsWith('/api/v1/') && !C.isForbiddenPath(p.split('?')[0]))).toBe(true);
    expect(calls.length).toBe(4);
  });
});

describe('gating', () => {
  it('start() is inert without FLEET_DEV_APERIA_PROBE=1', () => {
    for (const env of [{}, { FLEET_DEV_APERIA_PROBE: '0' }, { FLEET_DEV_APERIA_PROBE: 'true' }]) {
      expect(probe.start({ env, log: { info() {}, warn() {} } })).toBe(false);
    }
  });

  it("app.js requires the probe only inside the FLEET_DEV_APERIA_PROBE === '1' gate", () => {
    const APP_SRC = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const gate = APP_SRC.indexOf("if (process.env.FLEET_DEV_APERIA_PROBE === '1')");
    const req = APP_SRC.indexOf("require('./dev/dev-aperia-probe')");
    expect(gate).toBeGreaterThan(0);
    expect(req).toBeGreaterThan(gate);
    expect(APP_SRC.split("require('./dev/dev-aperia-probe')").length).toBe(2);
  });

  it('transport refuses forbidden endpoints and non-api paths before any network', async () => {
    const T = require('../src/aperia/transport');
    for (const p of ['/api/v1/vehicles/1/tires', '/api/v1/vehicles/1/sensors', '/api/v1/vehicles/1/pressures', '/api/v1/vehicles/1/telemetry']) {
      expect((await T.getJson(p)).code).toBe('APERIA_FORBIDDEN_ENDPOINT');
    }
    expect((await T.getJson('https://evil.example/api/v1/x')).code).toBe('INVALID_INPUT');
  });
});
