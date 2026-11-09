// tests/email-api-send.test.js — Outlook REST sends: transport/mail-actions (reply / reply-all / sendmail) and the
// send-reply executor behind the confirmation gate (design 8.1-8.4; FR-1.5, FR-3.1 to FR-3.3, AC-12 to AC-15,
// INV-7, INV-8, R4-M1, R4-M4, R4-L12). Fake net only; NO live sends.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { createFakeNet, fakeTokens, apiEnv } from './fixtures/email-api/fake-net.js';
import { restMessage, mailServerRoutes, WK } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mailActions = require('../src/email-intel/transport/mail-actions');
const { createHttp } = require('../src/email-intel/transport/http');
const { compareSets } = require('../src/email-intel/reply/recipients');
const { TC } = require('../src/email-intel/transport/constants');
const owaRe = require('../src/scrapers/owa-mailer');

const MARK = 'FOC-00112233aabbccdd';
const SHOP = { name: 'Shop Desk', address: 'shop@example.test' };
const LEAD = { name: 'Lead', address: 'lead@example.test' };
const ORIG = restMessage({ Id: 'ORIG-1', ConversationId: 'CONV-1', InternetMessageId: '<orig1@example.test>', Subject: 'Unit 40123', CcRecipients: [{ EmailAddress: { Name: 'Lead', Address: 'lead@example.test' } }] });
const html = '<div style="font-family:Calibri">Thanks, on it.</div><span style="display:none">' + MARK + '</span>';

function mk(s, o) {
  const opt = o || {};
  const server = Object.assign({ originals: { 'ORIG-1': ORIG } }, s || {});
  const fn = createFakeNet((opt.routes || []).concat(mailServerRoutes(server)));
  const tokens = opt.tokens || fakeTokens();
  const timers = { setTimeout: (f, ms) => setTimeout(f, ms >= TC.POST_TIMEOUT_MS ? 400 : ms), clearTimeout: (t) => clearTimeout(t) };
  const http = createHttp({ electron: fn.electron, tokens, owaRe, sleep: opt.sleep || (() => Promise.resolve()), timers, log: { info() {}, warn() {} } });
  const events = [];
  const deps = { http, tokens, folders: null };
  const hooks = { beforeSend: vi.fn(() => { events.push('sending'); return opt.persist !== false; }) };
  return { fn, server, http, tokens, deps, hooks, events };
}
const reply = (x, extra) => mailActions.apiReply(Object.assign({
  deps: x.deps, compareSets, itemId: 'ORIG-1', internetMessageId: '<orig1@example.test>', mode: 'reply', expected: { to: [SHOP], cc: [] }, html, marker: MARK,
  subject: 'RE: Unit 40123', conversationId: 'CONV-1', attemptHooks: x.hooks, onRef: vi.fn(), sleep: () => Promise.resolve(), verifyTimeoutMs: 10, verifyPollMs: 1,
}, extra || {}));
const of = (x, re, m) => x.fn.calls.filter((c) => (!m || c.method === m) && re.test(c.decoded));

describe('mail-actions: reply / reply-all', () => {
  it('AC-12 reply and reply-all use createreply/createreplyall, PATCH, sending, send, verify', async () => {
    const x = mk();
    const onRef = vi.fn();
    const r = await reply(x, { onRef });
    expect(r).toEqual({ status: 'sent', detail: { sentItemsMatch: { found: true, matchedBy: 'imid' } } });
    expect(x.fn.calls.map((c) => c.method + ' ' + c.decoded.split('?')[0].replace('/api/v2.0/me', ''))).toEqual([
      'POST /messages/ORIG-1/createreply', 'GET /messages/DRAFT-1', 'PATCH /messages/DRAFT-1', 'GET /messages/DRAFT-1', 'POST /messages/DRAFT-1/send', 'GET /mailfolders/sentitems/messages']);
    const patch = of(x, /DRAFT-1$/, 'PATCH')[0].body;
    expect(patch.Body.ContentType).toBe('HTML');
    expect(patch.Body.Content.indexOf(MARK)).toBeLessThan(patch.Body.Content.indexOf('id="quote"'));     // above the quote
    expect(x.fn.calls[1].decoded).toContain('$select=Subject,ToRecipients,CcRecipients,Body,InternetMessageId,ConversationId');
    expect(onRef).toHaveBeenCalledWith({ internetMessageId: '<draft1@example.test>', conversationId: 'CONV-1', subject: 'RE: Unit 40123' });
    expect(onRef.mock.invocationCallOrder[0]).toBeLessThan(x.hooks.beforeSend.mock.invocationCallOrder[0]);
    const y = mk();
    const r2 = await reply(y, { mode: 'reply-all', expected: { to: [SHOP], cc: [LEAD] } });
    expect(r2.status).toBe('sent');
    expect(y.fn.calls[0].decoded).toMatch(/\/createreplyall$/);
  });

  it('PATCH verification passes when Exchange rewrites the HTML and fails when the quote is dropped', async () => {
    const x = mk({ rewrite: (h) => h.replace(/<div style="font-family:Calibri">/, '<div class="elementToProof" style="font-family: Calibri, sans-serif;">\n') });
    expect((await reply(x)).status).toBe('sent');
    const y = mk({ dropQuote: true });
    expect(await reply(y)).toEqual({ status: 'failed-before-send', detail: { code: 'INSERT_UNVERIFIED' } });
    expect(of(y, /\/send$/, 'POST')).toHaveLength(0);
    expect(of(y, /DRAFT-1$/, 'DELETE')).toHaveLength(1);
  });

  it('R4-M4 To-only recipient difference returns recipient-mismatch, deletes the draft, sends nothing', async () => {
    const x = mk({ draftTo: [{ EmailAddress: { Name: 'Reply To', Address: 'replyto@example.test' } }] });
    const r = await reply(x);
    expect(r.status).toBe('recipient-mismatch');
    expect(r.detail.code).toBe('RECIPIENT_MISMATCH');
    expect(r.detail.diff).toEqual({ missing: [{ name: 'Shop Desk', address: 'shop@example.test', role: 'to' }], extra: [{ name: 'Reply To', address: 'replyto@example.test', role: 'to' }] });
    expect(of(x, /DRAFT-1$/, 'DELETE')).toHaveLength(1);
    expect(of(x, /\/send$/, 'POST')).toHaveLength(0);
    expect(of(x, /DRAFT-1$/, 'PATCH')).toHaveLength(0);
    expect(x.hooks.beforeSend).not.toHaveBeenCalled();
  });

  it('R4-M4 CC-only recipient difference returns recipient-mismatch, deletes the draft, sends nothing', async () => {
    const x = mk({ draftCc: [{ EmailAddress: { Name: 'Lead', Address: 'lead@example.test' } }, { EmailAddress: { Name: 'Extra', Address: 'extra@example.test' } }] });
    const r = await reply(x, { mode: 'reply-all', expected: { to: [SHOP], cc: [LEAD] } });
    expect(r.status).toBe('recipient-mismatch');
    expect(r.detail.diff).toEqual({ missing: [], extra: [{ name: 'Extra', address: 'extra@example.test', role: 'cc' }] });
    expect(of(x, /DRAFT-1$/, 'DELETE')).toHaveLength(1);
    expect(of(x, /\/send$/, 'POST')).toHaveLength(0);
  });

  it('R4-M4 missing compareSets returns failed-before-send REFUSED with zero requests', async () => {
    const x = mk();
    expect(await reply(x, { compareSets: undefined })).toEqual({ status: 'failed-before-send', detail: { code: 'REFUSED' } });
    expect(await reply(x, { compareSets: 'nope' })).toEqual({ status: 'failed-before-send', detail: { code: 'REFUSED' } });
    expect(x.fn.calls).toHaveLength(0);
    expect(x.tokens.calls.getAuth).toBe(0);
  });

  it('FR-1.5 after sending there is no refresh, window or slot wait before the final POST', async () => {
    const x = mk();
    const t = x.tokens;
    const getAuth = t.getAuth.bind(t); const peek = t.peek.bind(t);
    t.getAuth = (a) => { x.events.push('getAuth'); return getAuth(a); };
    t.peek = () => { x.events.push('peek'); return peek(); };
    const calls0 = x.fn.calls;
    const r = await reply(x);
    expect(r.status).toBe('sent');
    const i = x.events.indexOf('sending');
    expect(x.events.slice(i + 1, i + 2)).toEqual(['peek']);                  // the final POST uses the cached token
    const sendIdx = calls0.findIndex((c) => /\/send$/.test(c.decoded));
    expect(calls0[sendIdx - 1].method).toBe('GET');                          // nothing between the verify GET and the send
    expect(t.calls.refresh).toBe(0);
  });

  it('INV-8 a paused gate or TOKEN_SHORT is failed-before-send with zero final POSTs and the draft deleted', async () => {
    const sleeps = [];
    const x = mk({}, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, routes: [{ method: 'GET', re: /mailfolders\/inbox\/messages/, respond: () => ({ status: 429, headers: { 'retry-after': '30' } }) }] });
    await x.http.get(require('../src/email-intel/transport/endpoints').probe(), { op: 'probe' }).catch(() => {});
    expect(x.http.pausedUntil()).toBeGreaterThan(Date.now());
    const before = sleeps.length;
    const r = await reply(x);
    expect(r).toEqual({ status: 'failed-before-send', detail: { code: 'THROTTLED' } });
    expect(of(x, /\/send$/, 'POST')).toHaveLength(0);
    expect(of(x, /DRAFT-1$/, 'DELETE')).toHaveLength(1);
    expect(sleeps.slice(before).every((ms) => ms > 0)).toBe(true);
    // TOKEN_SHORT: nothing is created
    const y = mk({}, { tokens: fakeTokens({ expMs: Date.now() + 2 * 60_000 }) });
    expect(await reply(y)).toEqual({ status: 'failed-before-send', detail: { code: 'TOKEN_SHORT' } });
    expect(y.fn.calls).toHaveLength(0);
    // the cache was dropped between steps: peek fails before writing; no token window after `sending`
    const z = mk();
    const r3 = await reply(z, { onRef: () => z.tokens.drop() });
    expect(r3).toEqual({ status: 'failed-before-send', detail: { code: 'TOKEN_UNAVAILABLE' } });
    expect(of(z, /\/send$/, 'POST')).toHaveLength(0);
    expect(z.tokens.calls.refresh).toBe(0);
  });

  it('definitive 4xx / 429 on send delete the draft once; 401 leaves it (blocked-auth)', async () => {
    const x = mk({ send: { status: 400, json: { error: { code: 'ErrorInvalidRecipients' } } } });
    expect(await reply(x)).toEqual({ status: 'failed-before-send', detail: { code: 'HTTP_400' } });
    expect(of(x, /DRAFT-1$/, 'DELETE')).toHaveLength(1);
    const y = mk({ send: { status: 429 } });
    expect((await reply(y)).detail.code).toBe('THROTTLED');
    expect(of(y, /\/send$/, 'POST')).toHaveLength(1);
    const z = mk({ send: { status: 401 } });
    expect(await reply(z)).toEqual({ status: 'blocked-auth', detail: {} });
    expect(of(z, /DRAFT-1$/, 'DELETE')).toHaveLength(0);
  });

  it('AC-15 a timeout, network error or 5xx after the final POST is delivery-uncertain with one POST', async () => {
    for (const [send, code] of [[{ hang: true }, 'UNCONFIRMED_TIMEOUT'], [{ error: true }, 'UNCONFIRMED_NETWORK'], [{ status: 503 }, 'UNCONFIRMED_HTTP_503'], [{ status: 500 }, 'UNCONFIRMED_HTTP_500']]) {
      const x = mk({ send });
      const r = await reply(x);
      expect(r, code).toEqual({ status: 'delivery-uncertain', detail: { code } });
      expect(of(x, /\/send$/, 'POST')).toHaveLength(1);
      expect(of(x, /DRAFT-1$/, 'DELETE')).toHaveLength(0);
    }
    const v = mk({ sentHidden: true });
    expect(await reply(v)).toEqual({ status: 'delivery-uncertain', detail: { code: 'NOT_IN_SENT_ITEMS' } });
  });

  it('a 404 on createreply retries once by InternetMessageId, else mechanism-unavailable', async () => {
    const x = mk({}, { routes: [{ method: 'GET', re: /\/me\/messages\?\$filter=InternetMessageId eq/, respond: () => ({ status: 200, json: { value: [{ Id: 'ORIG-1' }] } }) }] });
    expect((await reply(x, { itemId: 'MOVED-OLD' })).status).toBe('sent');
    const y = mk({}, { routes: [{ method: 'GET', re: /\/me\/messages\?\$filter=InternetMessageId eq/, respond: () => ({ status: 200, json: { value: [] } }) }] });
    expect(await reply(y, { itemId: 'MOVED-OLD' })).toEqual({ status: 'mechanism-unavailable', detail: { code: 'ITEM_NOT_FOUND' } });
    expect(of(y, /\/send$/)).toHaveLength(0);
  });
});

describe('mail-actions: sendmail', () => {
  it('AC-13 the sendmail payload is exactly the confirmed To, HTML, marker and SaveToSentItems', async () => {
    const x = mk();
    const onRef = vi.fn();
    const r = await mailActions.apiSendMail({ deps: x.deps, to: [SHOP], subject: 'Re: Unit 40123', html, marker: MARK, attemptHooks: x.hooks, onRef, sleep: () => Promise.resolve(), verifyTimeoutMs: 10, verifyPollMs: 1 });
    expect(r.status).toBe('sent');
    const post = of(x, /\/sendmail$/, 'POST');
    expect(post).toHaveLength(1);
    expect(post[0].body).toEqual({ Message: { Subject: 'Re: Unit 40123', Body: { ContentType: 'HTML', Content: html }, ToRecipients: [{ EmailAddress: { Address: 'shop@example.test', Name: 'Shop Desk' } }] }, SaveToSentItems: true });
    expect(onRef).toHaveBeenCalledWith({ internetMessageId: expect.stringMatching(/^<sm\d+@example\.test>$/) });
    const y = mk();
    expect(await mailActions.apiSendMail({ deps: y.deps, to: [{ name: 'X', address: null }], subject: 's', html, marker: MARK, attemptHooks: y.hooks })).toEqual({ status: 'failed-before-send', detail: { code: 'NO_ADDRESS' } });
    expect(y.fn.calls).toHaveLength(0);
  });
});

describe('send-reply executor (apiTransport)', () => {
  let env; let confirm; let executors; let guard;
  const dialog = (response) => ({ showMessageBox: vi.fn(async () => ({ response })) });
  beforeEach(() => {
    const server = { originals: { 'ORIG-1': ORIG } };
    env = apiEnv({ routes: mailServerRoutes(server) });
    env.server = server;
    confirm = require('../src/email-intel/confirm');
    executors = require('../src/email-intel/executors');
    guard = require('../src/email-intel/reply/send-guard');
    confirm._resetForTests();
    executors.registerAll();
    env.rec = env.addApi(ORIG);
  });
  afterEach(() => { vi.restoreAllMocks(); confirm._resetForTests(); env.cleanup(); });
  const payload = (o) => Object.assign({ conversationKey: env.rec.conversationKey, mode: 'reply', bodyText: 'Thanks, on it.' }, o || {});
  const sendPosts = () => env.fn.calls.filter((c) => c.method === 'POST' && /\/send$|\/sendmail$/.test(c.decoded));

  it('AC-14 no send request without a prepare token and an accepted dialog; Cancel sends nothing', async () => {
    expect(await confirm.confirm('0'.repeat(32), { _dialog: dialog(1) })).toEqual({ ok: false, code: 'TOKEN_UNKNOWN' });
    const p1 = confirm.prepare('send-reply', payload());
    expect(p1.ok).toBe(true);
    expect(p1.summary.mechanism).toBe('api-thread');
    expect(await confirm.confirm(p1.token, { _dialog: dialog(0) })).toEqual({ ok: false, code: 'USER_CANCELLED' });
    expect(env.fn.calls).toHaveLength(0);
    expect(await confirm.confirm(p1.token, { _dialog: dialog(1) })).toEqual({ ok: false, code: 'TOKEN_USED' });
    const p2 = confirm.prepare('send-reply', payload());
    const r = await confirm.confirm(p2.token, { _dialog: dialog(1) });
    expect(r).toMatchObject({ ok: true, status: 'sent', mechanism: 'api-thread' });
    expect(sendPosts()).toHaveLength(1);
    const a = guard.get(r.attemptId);
    expect(a).toMatchObject({ transport: 'api', state: 'sent', mechanism: 'api-thread' });
  });

  it('R4-M4 the executor injects reply/recipients.compareSets into apiReply', async () => {
    const spy = vi.spyOn(mailActions, 'apiReply');
    const deps = vi.spyOn(env.transport, 'deps');
    const p = confirm.prepare('send-reply', payload());
    await confirm.confirm(p.token, { _dialog: dialog(1) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].compareSets).toBe(compareSets);
    expect(spy.mock.calls[0][0].deps.tokens).toBe(env.tokens);              // one token source (transport.deps())
    expect(deps).toHaveBeenCalled();
    expect(fs.readFileSync(path.join(ROOT, 'src/email-intel/transport/mail-actions.js'), 'utf8')).not.toMatch(/require\([^)]*reply\//);
  });

  it('the attempt stores the exact draft subject before it is marked sending', async () => {
    env.server.draftSubject = 'RE: [EXT] Unit 40123';
    let seen = null;
    const real = guard.markSending;
    vi.spyOn(guard, 'markSending').mockImplementation((id, o) => { seen = guard.get(id).apiRef; return real(id, o); });
    const p = confirm.prepare('send-reply', payload());
    const r = await confirm.confirm(p.token, { _dialog: dialog(1) });
    expect(r.status).toBe('sent');
    expect(seen).toMatchObject({ subject: 'RE: [EXT] Unit 40123', internetMessageId: '<draft1@example.test>', conversationId: 'CONV-1' });
  });

  it("R4-L12 INSERT_UNVERIFIED keeps fallback:'new-message' from executors.js:549 with no second send", async () => {
    env.server.dropQuote = true;
    const p = confirm.prepare('send-reply', payload());
    const r = await confirm.confirm(p.token, { _dialog: dialog(1) });
    expect(r).toMatchObject({ ok: false, status: 'failed-before-send', code: 'INSERT_UNVERIFIED', fallback: 'new-message' });
    expect(sendPosts()).toHaveLength(0);
    expect(guard.get(r.attemptId).state).toBe('failed-before-send');
  });

  it('R4-M1 validateSendReply picks the newest api record over a leftover md_ record', () => {
    const conv = env.rec.conversationKey;
    const dom = env.addDom({ itemId: null, conversationKey: conv, convIdRaw: env.rec.convIdRaw, convIdSource: 'owa', legacySeed: env.rec.convIdRaw, folder: 'Inbox', subject: 'RE: something else entirely',
      from: { name: 'Other Person', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'collapsed preview', bodyStatus: 'complete' }, Date.now() + 3600_000);
    const recs = env.ledger.conversation(env.stores.load('messages'), conv);
    expect(recs[recs.length - 1].messageKey).toBe(dom.messageKey);          // the md_ twin sorts last
    const v = executors.validateSendReply(payload());
    expect(v.ok).toBe(true);
    expect(v.latest.messageKey).toBe(env.rec.messageKey);
    expect(v.mechanism).toBe('api-thread');
    expect(executors._apiLatest(recs).messageKey).toBe(env.rec.messageKey);
  });

  it('validateSendReply: an unreconciled attempt still wins over no-api-id; a derived record is no-api-id', () => {
    const d = env.addDom({ itemId: null, conversationKey: 'cv_' + 'a'.repeat(16), convIdRaw: '', convIdSource: 'derived', legacySeed: 'x', folder: 'Inbox', subject: 'Hello',
      from: { name: 'Someone', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'hi', bodyStatus: 'complete' });
    expect(executors.validateSendReply({ conversationKey: d.conversationKey, mode: 'reply', bodyText: 'x' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-api-id' });
    const c = guard.createAttempt({ conversationKey: d.conversationKey, mode: 'reply', mechanism: 'api-thread' });
    guard.markSending(c.attempt.attemptId);
    expect(executors.validateSendReply({ conversationKey: d.conversationKey, mode: 'reply', bodyText: 'x' })).toMatchObject({ ok: false, code: 'UNRECONCILED_ATTEMPT' });
  });
});
