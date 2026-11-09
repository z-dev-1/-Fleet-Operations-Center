// tests/email-api-reconcile.test.js — uncertain send -> read-only Sent Items reconcile, never a resend
// (design 8.5, 8.6; FR-3.4, AC-15, INV-1 to INV-6, R4-M5). Temp data dir, fake net, fake token source.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { createFakeNet, fakeTokens } from './fixtures/email-api/fake-net.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = require('../src/email-intel/flags');
const stores = require('../src/email-intel/stores');
const guard = require('../src/email-intel/reply/send-guard');
const rs = require('../src/email-intel/reply/reconcile-send');
const transport = require('../src/email-intel/transport');
const sentItems = require('../src/email-intel/transport/sent-items');
const { createHttp } = require('../src/email-intel/transport/http');
const executors = require('../src/email-intel/executors');
const owaRe = require('../src/scrapers/owa-mailer');

let tmp;
const MARK = 'FOC-0123456789abcdef';
const CK = 'cv_0123456789abcdef';
const parse = (p) => new URLSearchParams(p.split('?')[1] || '');

/** Sent Items fake: items [{ Id, InternetMessageId, ConversationId, Subject, Body }]; pageSize the server's page. */
function sentRoutes(o) {
  const x = o || {};
  return [{
    method: 'GET', re: /\/mailfolders\/sentitems\/messages/, respond: (req) => {
      const q = parse(req.path);
      const f = q.get('$filter') || '';
      if (x.reject && x.reject.test(f)) return { status: 400, json: { error: { code: 'ErrorInvalidProperty' } } };
      if (x.tooLarge && x.tooLarge(q)) return { status: 200, chunks: ['x'.repeat(5 * 1024 * 1024)] };
      let m;
      let list = x.items || [];
      if ((m = /^InternetMessageId eq '(.*)'$/.exec(f))) list = list.filter((i) => i.InternetMessageId === m[1].replace(/''/g, "'"));
      else if ((m = /^ConversationId eq '(.*)'$/.exec(f))) list = list.filter((i) => i.ConversationId === m[1].replace(/''/g, "'"));
      else if ((m = /^Subject eq '(.*)'$/.exec(f))) { x.subjects = (x.subjects || []).concat([m[1]]); list = list.filter((i) => i.Subject === m[1].replace(/''/g, "'")); }
      const size = x.pageSize || Number(q.get('$top')) || 10;
      const skip = Number(q.get('$skip') || 0);
      const json = { value: list.slice(skip, skip + size) };
      if (skip + size < list.length) { q.set('$skip', String(skip + size)); json['@odata.nextLink'] = (x.linkHost || 'https://outlook.office.com') + req.path.split('?')[0] + '?' + q.toString(); }
      return { status: 200, json };
    },
  }];
}
const item = (i, o) => Object.assign({ Id: 'S' + i, InternetMessageId: '<s' + i + '@example.test>', ConversationId: 'CONV-1', Subject: 'RE: Unit 40123', Body: { Content: '<p>other</p>' } }, o || {});

function useNet(routes) {
  const fn = createFakeNet(routes);
  const http = createHttp({ electron: fn.electron, tokens: fakeTokens(), owaRe, sleep: () => Promise.resolve() });
  transport._setForTests({ http, tokens: fakeTokens() });
  return fn;
}

function attempt(o) {
  const x = Object.assign({ transport: 'api', mechanism: 'api-thread', mode: 'reply', apiRef: { subject: 'RE: Unit 40123' } }, o || {});
  const fields = { conversationKey: x.conversationKey || CK, targetMessageKey: x.target || 'mi_target', mode: x.mode, mechanism: x.mechanism, to: [{ name: 'S', address: 's@example.test' }], cc: [],
    subjectNorm: 're: unit 40123', bodyHash: 'h', bodyChars: 4, marker: MARK };
  if (x.transport) fields.transport = x.transport;
  if (x.apiRef) fields.apiRef = x.apiRef;
  const c = guard.createAttempt(fields, { now: Date.now() - 10 * 60_000 });
  guard.markSending(c.attempt.attemptId, { now: Date.now() - 9 * 60_000 });
  if (x.ref) guard.setApiRef(c.attempt.attemptId, x.ref);
  guard.finish(c.attempt.attemptId, 'delivery-uncertain', { errorCode: 'UNCONFIRMED_TIMEOUT' });
  return c.attempt.attemptId;
}
const checks = (id) => guard.get(id).reconcile.checks;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-api-rec-'));
  require('../src/config/paths').setDataDir(tmp);
  flags._setForTests({ effective: { capture: true, apiTransport: true } });
  guard._resetForTests();
});
afterEach(() => {
  transport._setForTests(null);
  flags._setForTests(null);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ }
});

describe('Sent Items search', () => {
  it('AC-15 reconcile finds by InternetMessageId, conversation + marker, or exact subject + marker', async () => {
    const items = [item(1, { InternetMessageId: '<sent@example.test>' }), item(2, { ConversationId: 'CONV-X', Body: { Content: 'hi <span>' + MARK + '</span>' } }),
      item(3, { ConversationId: 'CONV-Y', Subject: 'Re: MiXeD Case [FOC-x]', Body: { Content: MARK } })];
    const box = { items };
    useNet(sentRoutes(box));
    const a1 = attempt({ ref: { internetMessageId: '<sent@example.test>' } });
    expect(await rs.reconcileSend(a1)).toEqual({ ok: true, state: 'sent', found: true });
    expect(guard.get(a1).reconcile.resolution).toBe('confirmed-sent');
    const a2 = attempt({ conversationKey: 'cv_1111111111111111', ref: { conversationId: 'CONV-X' } });
    expect(await rs.reconcileSend(a2)).toMatchObject({ state: 'sent', found: true });
    const a3 = attempt({ conversationKey: 'cv_2222222222222222', mechanism: 'api-new', mode: 'new-message', apiRef: { subject: 'Re: MiXeD Case [FOC-x]' } });
    expect(await rs.reconcileSend(a3)).toMatchObject({ state: 'sent', found: true });
    expect(box.subjects).toContain('Re: MiXeD Case [FOC-x]');                // the exact subject, never subjectNorm
  });

  it('INV-5 reconcileQuery uses apiRef.subject and never subjectNorm', () => {
    const doc = { messages: {} };
    const q = transport.reconcileQuery({ transport: 'api', marker: MARK, subjectNorm: 're: lower', apiRef: { subject: 'RE: Exact Subject' } }, doc);
    expect(q.q.subject).toBe('RE: Exact Subject');
    expect(q.strategies).toEqual(['subject-marker']);
    const none = transport.reconcileQuery({ transport: 'api', marker: MARK, subjectNorm: 're: lower' }, doc);
    expect(none.q.subject).toBeNull();
    expect(none.strategies).toEqual([]);
    // an aliased md_ target resolves the API record's conversation id
    const doc2 = { messages: { mi_x: { messageKey: 'mi_x', conversationKey: CK, apiConversationId: 'CONV-A' } }, aliasIndex: { md_old: 'mi_x' } };
    expect(transport.reconcileQuery({ mechanism: 'owa-thread', marker: MARK, targetMessageKey: 'md_old' }, doc2).strategies).toEqual(['conversation-marker']);
  });

  it('INV-2 page cap, foreign nextLink or all-400 returns RECONCILE_INCONCLUSIVE with no check and an unchanged state', async () => {
    const many = Array.from({ length: 250 }, (_, i) => item(i));
    let fn = useNet(sentRoutes({ items: many, pageSize: 50 }));
    const id = attempt({ ref: { conversationId: 'CONV-1' }, apiRef: null });
    expect(await rs.reconcileSend(id)).toEqual({ ok: false, code: 'RECONCILE_INCONCLUSIVE', state: 'delivery-uncertain' });
    expect(fn.calls).toHaveLength(4);
    expect(checks(id)).toEqual([]);
    expect(await rs.reconcileSend(id, { onlyIfFound: true })).toMatchObject({ code: 'RECONCILE_INCONCLUSIVE' });
    expect(checks(id)).toEqual([]);
    fn = useNet(sentRoutes({ items: many.slice(0, 20), pageSize: 10, linkHost: 'https://evil.example.test' }));
    expect(await rs.reconcileSend(id)).toMatchObject({ code: 'RECONCILE_INCONCLUSIVE' });
    expect(fn.calls.every((c) => c.host === 'outlook.cloud.microsoft')).toBe(true);
    fn = useNet(sentRoutes({ items: [], reject: /./ }));
    const id2 = attempt({ conversationKey: 'cv_3333333333333333', ref: { conversationId: 'CONV-1' } });
    expect(await rs.reconcileSend(id2)).toMatchObject({ code: 'RECONCILE_INCONCLUSIVE' });
    expect(fn.calls).toHaveLength(2);
    expect(checks(id2)).toEqual([]);
    expect(guard.get(id).state).toBe('delivery-uncertain');
    // a second too-large page is inconclusive
    useNet(sentRoutes({ items: [item(1)], tooLarge: () => true }));
    expect(await rs.reconcileSend(id2)).toMatchObject({ code: 'RECONCILE_INCONCLUSIVE' });
  });

  it('INV-2 only a search with no page left records found:false', async () => {
    useNet(sentRoutes({ items: Array.from({ length: 7 }, (_, i) => item(i)) }));
    const id = attempt({ ref: { conversationId: 'CONV-1' }, apiRef: null });
    expect(await rs.reconcileSend(id)).toEqual({ ok: true, state: 'unconfirmed-not-found', found: false });
    expect(checks(id)).toEqual([expect.objectContaining({ found: false })]);
    // one strategy rejected with 400 + one complete miss -> a complete "not found"
    useNet(sentRoutes({ items: [item(1)], reject: /^Subject/ }));
    const id2 = attempt({ conversationKey: 'cv_4444444444444444', ref: { conversationId: 'CONV-1' } });
    expect(await rs.reconcileSend(id2)).toMatchObject({ ok: true, found: false });
  });

  it('pages: a match on page 3 is found and the first request asks for $top=50; a too-large page restarts at $top=10', async () => {
    const items = Array.from({ length: 25 }, (_, i) => item(i, i === 22 ? { Body: { Content: MARK } } : {}));
    let fn = useNet(sentRoutes({ items, pageSize: 10 }));
    const id = attempt({ ref: { conversationId: 'CONV-1' }, apiRef: null });
    expect(await rs.reconcileSend(id)).toMatchObject({ state: 'sent' });
    expect(parse(fn.calls[0].path).get('$top')).toBe('50');
    expect(fn.calls).toHaveLength(3);
    const items2 = Array.from({ length: 15 }, (_, i) => item(i, i === 12 ? { Body: { Content: MARK } } : {}));
    fn = useNet(sentRoutes({ items: items2, tooLarge: (q) => q.get('$top') === '50' }));
    const id2 = attempt({ conversationKey: 'cv_5555555555555555', ref: { conversationId: 'CONV-1' }, apiRef: null });
    expect(await rs.reconcileSend(id2)).toMatchObject({ state: 'sent' });
    expect(fn.calls.map((c) => parse(c.path).get('$top'))).toEqual(['50', '10', '10']);
  });

  it('INV-1 an uncertain send is never resent; reconcile issues GETs only', async () => {
    const fn = useNet(sentRoutes({ items: [item(1)] }));
    const id = attempt({ ref: { internetMessageId: '<nope@example.test>', conversationId: 'CONV-1' } });
    await rs.reconcileSend(id);
    await rs.reconcileSend(id, { onlyIfFound: true });
    expect(fn.calls.length).toBeGreaterThan(0);
    expect(fn.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(fn.calls.some((c) => /sendmail|\/send$|createreply/.test(c.path))).toBe(false);
    await expect(sentItems.findSent(null, {}, [])).rejects.toMatchObject({ name: 'RequestRefusedError' });
  });

  it('INV-3 a DOM-era compose-new attempt is RECONCILE_UNAVAILABLE with zero requests and no check; not-sent still needs the override', async () => {
    stores.update('messages', (d) => { d.messages = { mi_t: { messageKey: 'mi_t', conversationKey: CK, apiConversationId: 'CONV-1', source: 'api' } }; d.byConv = { [CK]: ['mi_t'] }; return d; });
    const fn = useNet(sentRoutes({ items: [item(1, { Body: { Content: MARK } })] }));
    const id = attempt({ transport: null, apiRef: null, mechanism: 'compose-new', mode: 'new-message', target: 'mi_t' });
    expect(await rs.reconcileSend(id)).toEqual({ ok: false, code: 'RECONCILE_UNAVAILABLE', state: 'delivery-uncertain' });
    expect(fn.calls).toHaveLength(0);
    expect(checks(id)).toEqual([]);
    expect(executors.validateResolution({ attemptId: id, resolution: 'not-sent', acknowledgeCheckedOutlook: true })).toMatchObject({ ok: false, reason: 'reconcile-first' });
    expect(executors.validateResolution({ attemptId: id, resolution: 'not-sent', acknowledgeCheckedOutlook: true, override: true }).ok).toBe(true);
    // a DOM-era owa-thread attempt with the same target runs the conversation strategy
    const id2 = attempt({ conversationKey: 'cv_6666666666666666', transport: null, apiRef: null, mechanism: 'owa-thread', target: 'mi_t' });
    expect(await rs.reconcileSend(id2)).toMatchObject({ state: 'sent' });
    expect(fn.calls.length).toBeGreaterThan(0);
  });

  it('INV-4 onlyIfFound not found records a check and leaves the state unchanged', async () => {
    useNet(sentRoutes({ items: [item(1)] }));
    const id = attempt({ ref: { conversationId: 'CONV-1' } });
    expect(await rs.reconcileSend(id, { onlyIfFound: true })).toEqual({ ok: true, state: 'delivery-uncertain', found: false });
    expect(checks(id)).toHaveLength(1);
    expect(guard.get(id).state).toBe('delivery-uncertain');
  });

  it('INV-6 overlapping reconciles return RECONCILE_IN_PROGRESS and sent is never re-opened', async () => {
    const id = attempt({ ref: { conversationId: 'CONV-1' } });
    let release;
    const find = vi.fn(() => new Promise((r) => { release = r; }));
    const p1 = rs.reconcileSend(id, { _apiFind: find });
    const find2 = vi.fn(async () => ({ ok: true, found: true }));
    expect(await rs.reconcileSend(id, { _apiFind: find2 })).toEqual({ ok: false, code: 'RECONCILE_IN_PROGRESS', state: 'delivery-uncertain' });
    expect(find2).not.toHaveBeenCalled();
    guard.resolve(id, 'sent', Date.now());                                     // a concurrent user resolution
    release({ ok: true, found: false });
    expect(await p1).toEqual({ ok: true, state: 'sent', found: false });
    expect(guard.get(id).state).toBe('sent');
    expect(checks(id)).toEqual([]);
    // the in-flight entry is cleared after a thrown find
    const id2 = attempt({ conversationKey: 'cv_7777777777777777', ref: { conversationId: 'CONV-1' } });
    await expect(rs.reconcileSend(id2, { _apiFind: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
    expect(rs.RECONCILE_IN_PROGRESS.has(id2)).toBe(false);
    expect(await rs.reconcileSend(id2, { _apiFind: async () => ({ ok: true, found: true }) })).toMatchObject({ state: 'sent' });
  });

  it('R4-M5 reconcileSend forwards signal and deadlineAt to findSentForAttempt', async () => {
    const id = attempt({ ref: { conversationId: 'CONV-1' } });
    const ac = new AbortController();
    const deadlineAt = Date.now() + 90_000;
    const find = vi.fn(async () => ({ ok: false, code: 'RECONCILE_INCONCLUSIVE' }));
    await rs.reconcileSend(id, { _apiFind: find, signal: ac.signal, deadlineAt, onlyIfFound: true });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][1]).toMatchObject({ signal: ac.signal, deadlineAt });
    // and findSentForAttempt puts them on every request spec
    const specs = [];
    const http = { get: async (p, spec) => { specs.push(spec); return { status: 200, json: { value: [] } }; } };
    transport._setForTests({ http, tokens: fakeTokens() });
    await transport.findSentForAttempt(guard.get(id), { signal: ac.signal, deadlineAt, messagesDoc: { messages: {} } });
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.signal === ac.signal && s.deadlineAt === deadlineAt)).toBe(true);
  });

  it('R4-M5 a deadline cut-off lookup returns RECONCILE_INCONCLUSIVE and records no check', async () => {
    useNet([{ method: 'GET', re: /sentitems/, respond: () => ({ status: 200, json: { value: [] }, delayMs: 19_000 }) }]);
    const id = attempt({ ref: { conversationId: 'CONV-1' } });
    const r = await rs.reconcileSend(id, { onlyIfFound: true, deadlineAt: Date.now() + 60 });
    expect(r).toEqual({ ok: false, code: 'RECONCILE_INCONCLUSIVE', state: 'delivery-uncertain' });
    expect(checks(id)).toEqual([]);
    expect(await transport.findSentForAttempt(guard.get(id), { deadlineAt: Date.now() - 1, messagesDoc: { messages: {} } })).toEqual({ ok: false, code: 'RECONCILE_INCONCLUSIVE' });
  });
});

describe('send-guard API fields', () => {
  it('createAttempt copies transport:api and apiRef.subject; setApiRef merges type-checked fields', () => {
    const c = guard.createAttempt({ conversationKey: CK, mode: 'reply', mechanism: 'api-thread', transport: 'api', apiRef: { subject: 'S'.repeat(500) }, marker: MARK });
    expect(c.attempt.transport).toBe('api');
    expect(c.attempt.apiRef.subject).toHaveLength(400);
    guard.setApiRef(c.attempt.attemptId, { internetMessageId: '<i@example.test>', conversationId: 7, subject: 'RE: Real' });
    expect(guard.get(c.attempt.attemptId).apiRef).toEqual({ subject: 'RE: Real', internetMessageId: '<i@example.test>' });
    guard.setApiRef(c.attempt.attemptId, { conversationId: 'CONV-1' });
    expect(guard.get(c.attempt.attemptId).apiRef).toEqual({ subject: 'RE: Real', internetMessageId: '<i@example.test>', conversationId: 'CONV-1' });
    const d = guard.createAttempt({ conversationKey: 'cv_8888888888888888', mode: 'reply', mechanism: 'owa-thread', transport: 'dom' });
    expect(d.attempt.transport).toBeUndefined();
    expect(d.attempt.apiRef).toBeUndefined();
  });

  it('the static rule: no transport/ file requires reply/', () => {
    const dir = path.join(ROOT, 'src/email-intel/transport');
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/require\(\s*['"][^'"]*reply\//);
  });
});
