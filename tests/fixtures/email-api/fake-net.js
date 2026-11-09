// tests/fixtures/email-api/fake-net.js — route-table fake for electron.net.request (Outlook REST transport tests).
// No network. Each request is matched against `routes` in order (method + regex on the decoded path+query).
//   route = { method, re, respond(req) -> { status, headers, json | raw, delayMs, hang, error, redirect, chunks } }
//   req   = { method, path, decoded, headers (values, in memory only), body (parsed JSON), n }
// `calls` records method, path, decoded path, header NAMES and the parsed body (never header values).
// Responses are delivered on timers (setTimeout), so vi.useFakeTimers() can drive them.
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };

export function createFakeNet(routes, opts) {
  const o = opts || {};
  const calls = [];
  const list = Array.isArray(routes) ? routes : [];
  let n = 0;
  const net = {
    request(ro) {
      const url = new URL(ro.url);
      const req = new EventEmitter();
      const headers = {};
      let body = '';
      let aborted = false; let ended = false;
      const path = url.pathname + url.search;
      const rec = { method: ro.method, host: url.hostname, path, decoded: dec(path), headerNames: [], body: undefined, options: { session: ro.session, useSessionCookies: ro.useSessionCookies, credentials: ro.credentials, redirect: ro.redirect } };
      req.setHeader = (k, v) => { headers[String(k).toLowerCase()] = v; if (!rec.headerNames.includes(String(k).toLowerCase())) rec.headerNames.push(String(k).toLowerCase()); };
      req.write = (chunk) => { body += String(chunk); };
      req.abort = () => { if (aborted) return; aborted = true; setTimeout(() => req.emit('abort'), 0); };
      req.end = () => {
        if (ended) return;
        ended = true;
        rec.body = body ? JSON.parse(body) : undefined;
        rec.n = ++n;
        rec.at = Date.now();
        calls.push(rec);
        const r = { method: ro.method, path, decoded: rec.decoded, headers, body: rec.body, n: rec.n };
        const route = list.find((x) => (!x.method || x.method === ro.method) && x.re.test(rec.decoded));
        let res;
        try { res = route ? route.respond(r) : (o.fallback ? o.fallback(r) : { status: 404, json: { error: { code: 'ErrorItemNotFound' } } }); } catch (e) { res = { error: true }; }
        Promise.resolve(res).then((x) => deliver(x || { status: 200, json: {} }));
      };
      const deliver = (x) => {
        if (x.hang) return;
        const fire = () => {
          if (aborted) return;
          if (x.error) { req.emit('error', new Error('net::ERR_FAILED')); return; }
          if (x.redirect) { req.emit('redirect', x.status || 302, ro.method, x.redirect); return; }
          const res = new EventEmitter();
          res.statusCode = x.status || 200;
          res.headers = x.headers || {};
          req.emit('response', res);
          const raw = x.raw !== undefined ? x.raw : (x.json !== undefined ? JSON.stringify(x.json) : '');
          const chunks = x.chunks || (raw ? [raw] : []);
          for (const c of chunks) { if (aborted) return; res.emit('data', Buffer.from(c)); }
          if (!aborted) res.emit('end');
        };
        setTimeout(fire, x.delayMs || 0);
      };
      return req;
    },
  };
  const electron = { net, session: { defaultSession: { id: 'default' } } };
  return { net, electron, calls, routes: list, count: (re) => calls.filter((c) => re.test(c.decoded)).length };
}

/**
 * apiEnv({ flags, routes, tokens, httpOpts }) — a temp data dir with email-intel flags set (default capture +
 * apiTransport), the transport wired to fake net (transport._setForTests) and helpers to seed ledger records.
 *   env.addApi(restMsg, extra) / env.addDom(cap, now) -> the stored record
 *   env.cleanup()
 */
export function apiEnv(o) {
  const x = o || {};
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-api-'));
  require('../../../src/config/paths').setDataDir(tmp);
  const flags = require('../../../src/email-intel/flags');
  flags._setForTests(x.flags || { effective: { capture: true, apiTransport: true } });
  const stores = require('../../../src/email-intel/stores');
  const ledger = require('../../../src/email-intel/ingest/ledger');
  const map = require('../../../src/email-intel/transport/map');
  const transport = require('../../../src/email-intel/transport');
  const guard = require('../../../src/email-intel/reply/send-guard');
  guard._resetForTests();
  const fn = createFakeNet(x.routes || []);
  const tokens = x.tokens || fakeTokens();
  const { createHttp } = require('../../../src/email-intel/transport/http');
  const owaRe = require('../../../src/scrapers/owa-mailer');
  const http = createHttp(Object.assign({ electron: fn.electron, tokens, owaRe, sleep: () => Promise.resolve(), log: { info() {}, warn() {} } }, x.httpOpts || {}));
  transport._setForTests({ http, tokens });
  if (x.me !== false) stores.update('config', (d) => Object.assign({}, d, { me: { names: ['Me Person'], addresses: ['me@example.test'], distributionLists: [], fasName: '' } }));
  const add = (cap, now) => {
    let rec = null;
    stores.update('messages', (doc) => {
      ledger.ensureDoc(doc);
      const r = ledger.buildRecord(cap, doc, { now: now || Date.now(), lookbackDays: 14 });
      if (r.created) ledger.upsert(doc, r.record);
      rec = doc.messages[r.record.messageKey] || r.record;
      return doc;
    });
    return rec;
  };
  return {
    tmp, fn, tokens, http, flags, stores, ledger, transport, guard,
    addApi(msg, extra) { return add(Object.assign(map.toCapture(msg, { folderLabel: 'Inbox', isLatest: true }), extra || {})); },
    addDom(cap, now) { return add(cap, now); },
    cleanup() {
      transport._setForTests(null); flags._setForTests(null); guard._resetForTests();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ }
    },
  };
}

// A minimal fake token source: getAuth/peek/invalidate/alternate/describe with generations.
export function fakeTokens(o) {
  const opt = o || {};
  let gen = opt.gen || 1;
  let expMs = opt.expMs || (Date.now() + 3600_000);
  let present = opt.present !== false;
  const t = {
    calls: { getAuth: 0, peek: 0, invalidate: 0, alternate: 0, refresh: 0 },
    opts: [],
    async getAuth(a) {
      t.calls.getAuth++; t.opts.push(a || {});
      if (opt.getAuthError) throw opt.getAuthError();
      if (!present) { t.calls.refresh++; if (opt.refreshSame) { present = true; } else { gen++; present = true; } if (opt.onRefresh) opt.onRefresh(t); }
      return { headers: { authorization: 'Bearer SENTINEL.TOKEN.' + gen, 'x-anchormailbox': 'SENTINEL-ANCHOR' }, expMs: typeof opt.exp === 'function' ? opt.exp() : expMs, gen };
    },
    peek() {
      t.calls.peek++;
      if (!present || opt.peekError) { const E = require('../../../src/email-intel/transport/errors'); throw new E.TokenUnavailableError('no-cache'); }
      return { headers: { authorization: 'Bearer SENTINEL.TOKEN.' + gen, 'x-anchormailbox': 'SENTINEL-ANCHOR' }, expMs, gen };
    },
    invalidate(_r, g) { t.calls.invalidate++; if (g === gen) present = false; },
    alternate(g) { t.calls.alternate++; if (opt.alternate && g === gen) { gen++; return { headers: { authorization: 'Bearer SENTINEL.ALT.' + gen, 'x-anchormailbox': 'SENTINEL-ANCHOR' }, expMs, gen, rank: 1 }; } return null; },
    describe() { return { present, ttlBucket: present ? '>30m' : 'none', hold: false, rank: 2, lastRefreshAt: null, refreshCount: t.calls.refresh, lastResult: 'ok' }; },
    setExp(ms) { expMs = ms; },
    drop() { present = false; },
    get gen() { return gen; },
  };
  return t;
}
