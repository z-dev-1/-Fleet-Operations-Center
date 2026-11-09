// tests/email-api-reply-recipients.test.js — "To (0): none" fix: reply recipients resolved through the Outlook REST
// API (reply/resolve-recipients, reply/target, draft + IPC wiring) with the confirm gate and the uncertain-send
// reconcile unchanged, and flag-off parity. Fake net and fake stored records only; NO live network, NO live sends.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { apiEnv } from './fixtures/email-api/fake-net.js';
import { restMessage, mailboxRoutes, mailServerRoutes } from './fixtures/email-api/rest-messages.js';
import { installLogSpy, restoreLogSpy, leaks, clearLog } from './fixtures/email-intel/log-spy.js';
const require = createRequire(import.meta.url);

const handlers = {};
const electronStub = { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow: { getAllWindows: () => [] } };
beforeAll(() => {
  const p = require.resolve('electron');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: electronStub };
});
const call = (ch, ...a) => handlers[ch]({ sender: {} }, ...a);

const EA = (Name, Address) => ({ EmailAddress: { Name, Address } });
const ME = EA('Me Person', 'me@example.test');
const SHOP = EA('Shop Desk', 'shop@example.test');
const OTHER = EA('Other Tech', 'other@example.test');
const BOSS = EA('Boss Lead', 'boss@example.test');
const ON = { effective: { capture: true, threadReplies: true, apiTransport: true } };
const OFF_API = { effective: { capture: true, threadReplies: true } };

let env; let world; let server;
function boot(o) {
  const x = o || {};
  world = { msgs: x.msgs || [] };
  server = Object.assign({ originals: {} }, x.server || {});
  for (const m of world.msgs) server.originals[m.Id] = m;
  env = apiEnv({ flags: x.flags || ON, routes: (x.routes || []).concat(mailServerRoutes(server), mailboxRoutes(world)) });
  return env;
}
afterEach(() => {
  vi.restoreAllMocks();
  try { require('../src/email-intel/confirm')._resetForTests(); } catch (_) { /* not loaded */ }
  if (env) env.cleanup();
  env = null; delete electronStub.dialog;
});

const mods = () => ({
  R: require('../src/email-intel/reply/resolve-recipients'),
  T: require('../src/email-intel/reply/target'),
  D: require('../src/email-intel/reply/draft'),
  X: require('../src/email-intel/executors'),
  map: require('../src/email-intel/transport/map'),
  identity: require('../src/email-intel/ingest/identity'),
  endpoints: require('../src/email-intel/transport/endpoints'),
});
const conv = (ck) => env.ledger.conversation(env.ledger.ensureDoc(env.stores.load('messages')), ck);
const addrs = (list) => list.map((e) => e.address);

/** A DOM-era record with no addresses (parse-snapshot shape) in the conversation of a REST conversation id. */
function addLegacyDom(restConvId, o) {
  const { map, identity } = mods();
  const x = o || {};
  const convIdRaw = x.derived ? '' : map.legacyConvId(restConvId);
  const ck = x.derived ? 'cv_' + 'b'.repeat(16) : identity.conversationKey(convIdRaw);
  return env.addDom({
    itemId: null, conversationKey: ck, convIdRaw, convIdSource: x.derived ? 'derived' : 'owa', legacySeed: convIdRaw || 'seed-x', folder: 'Inbox',
    subject: x.subject || 'Unit 40123 status', from: { name: 'Shop Desk', address: null, quality: 'name-only' }, to: [], cc: [], toCount: 0, ccCount: 0,
    recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: x.text || 'Unit 40123 is in repair, ETA Friday.', bodyStatus: 'complete',
  }, x.now);
}
function saveLegacyCard(ck, legacyId, extra) {
  require('../src/store').save('emailTriageResults', { emails: [Object.assign({ id: legacyId, subject: 'Unit 40123 status', from: 'Shop Desk', replyState: 'drafted', replyDraft: 'Thanks',
    intel: { conversationKey: ck, recipientsKnown: false } }, extra || {})], ranAt: null });
}
const loadCard = () => require('../src/store').load('emailTriageResults', null).emails[0];

describe('replyTarget (one rule for draft, resolve and send)', () => {
  it('prefers the newest API record under apiTransport, the last record otherwise; empty -> null', () => {
    const { T } = mods();
    const api = { messageKey: 'mi_a', source: 'api' }; const dom = { messageKey: 'md_b' };
    expect(T.replyTarget([api, dom], true)).toBe(api);
    expect(T.replyTarget([api, dom], false)).toBe(dom);
    expect(T.replyTarget([dom], true)).toBe(dom);
    expect(T.replyTarget([], true)).toBeNull();
    expect(T.replyTarget(null, false)).toBeNull();
  });
});

describe('transport building blocks', () => {
  it('messageRecipients is a body-less allowed GET; restConvId inverts legacyConvId', () => {
    const { endpoints, map } = mods();
    const p = endpoints.messageRecipients('A/B=+');
    expect(p).toBe('/api/v2.0/me/messages/' + encodeURIComponent('A/B=+') + '?$select=' + encodeURIComponent(endpoints.SELECT_RCPT));
    expect(endpoints.assertAllowed('GET', p)).toBe(true);
    expect(endpoints.SELECT_RCPT).not.toMatch(/Body/);
    for (const x of ['AAQkCONV-7_a=', 'A-B_C-D_']) expect(map.restConvId(map.legacyConvId(x))).toBe(x);
    for (const y of ['AAQk/x+y=', '/+/+']) expect(map.legacyConvId(map.restConvId(y))).toBe(y);
    expect(map.restConvId(null)).toBe('');
  });

  it('ledger.refreshRecipients updates only the recipient fields, fromMe and recipientsCheckedAt', () => {
    boot();
    const ledger = env.ledger;
    const rec = env.addApi(restMessage({ Id: 'R-1', ConversationId: 'CONV-R', InternetMessageId: '<r1@example.test>', From: SHOP, ToRecipients: [ME] }));
    const now = Date.parse('2026-11-09T10:00:00Z');
    let out;
    env.stores.update('messages', (doc) => {
      const before = JSON.stringify({ k: doc.messages[rec.messageKey].messageKey, b: doc.messages[rec.messageKey].body, a: doc.messages[rec.messageKey].analysis });
      const cap = { from: { name: 'Shop Desk', address: 'shop@example.test', quality: 'ok' }, to: [{ name: 'Me Person', address: 'me@example.test' }, { name: 'Other Tech', address: 'other@example.test' }], cc: [], toCount: 2, ccCount: 0 };
      out = ledger.refreshRecipients(doc, rec.messageKey, cap, { addresses: ['me@example.test'], names: [] }, now);
      const r = doc.messages[rec.messageKey];
      expect(JSON.stringify({ k: r.messageKey, b: r.body, a: r.analysis })).toBe(before);
      expect(addrs(r.to)).toEqual(['me@example.test', 'other@example.test']);
      expect(r).toMatchObject({ toCount: 2, recipientsKnown: true, recipientsCheckedAt: '2026-11-09T10:00:00.000Z' });
      expect(r.flags.fromMe).toBe(false);
      expect(ledger.refreshRecipients(doc, rec.messageKey, cap, { addresses: ['me@example.test'] }, now)).toEqual({ refreshed: true, changed: false });
      expect(ledger.refreshRecipients(doc, 'mi_nope', cap, {}, now)).toEqual({ refreshed: false, changed: false });
      return doc;
    });
    expect(out).toEqual({ refreshed: true, changed: true });
  });
});

describe('resolveReplyRecipients', () => {
  it('API record: refreshes stale stored recipients; Reply = From only; Reply All = From + To + CC minus me, deduped; GETs only, no Body', async () => {
    const live = restMessage({ Id: 'ORIG-1', ConversationId: 'CONV-1', InternetMessageId: '<o1@example.test>', From: SHOP, ToRecipients: [ME, OTHER, SHOP], CcRecipients: [BOSS, ME] });
    boot({ msgs: [live] });
    const { R, endpoints } = mods();
    const rec = env.addApi(restMessage({ Id: 'ORIG-1', ConversationId: 'CONV-1', InternetMessageId: '<o1@example.test>', From: SHOP, ToRecipients: [ME] }));
    const r = await R.resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply' });
    expect(r).toMatchObject({ ok: true, mode: 'reply', source: 'api', sendable: true, replyAllAvailable: true, basedOnMessageKey: rec.messageKey });
    expect(r.recipients.to).toEqual([{ name: 'Shop Desk', address: 'shop@example.test', role: 'sender' }]);
    expect(r.recipients.cc).toEqual([]);
    const all = await R.resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply-all' });
    expect(addrs(all.recipients.to)).toEqual(['shop@example.test', 'other@example.test']);
    expect(addrs(all.recipients.cc)).toEqual(['boss@example.test']);
    const stored = conv(rec.conversationKey)[0];
    expect(addrs(stored.to)).toEqual(['me@example.test', 'other@example.test', 'shop@example.test']);
    expect(addrs(stored.cc)).toEqual(['boss@example.test', 'me@example.test']);
    expect(env.fn.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(env.fn.calls.every((c) => c.decoded.includes('$select=' + endpoints.SELECT_RCPT))).toBe(true);
  });

  it('legacy DOM record with no addresses resolves through the conversation id and is ingested as an API record', async () => {
    const live = restMessage({ Id: 'ORIG-7', ConversationId: 'AAQkCONV-7_a=', InternetMessageId: '<o7@example.test>', From: SHOP, ToRecipients: [ME], CcRecipients: [BOSS] });
    boot({ msgs: [live] });
    const { R } = mods();
    const dom = addLegacyDom('AAQkCONV-7_a=');
    saveLegacyCard(dom.conversationKey, dom.legacyId);
    const r = await R.resolveReplyRecipients({ conversationKey: dom.conversationKey, mode: 'reply' });
    expect(r).toMatchObject({ ok: true, source: 'api', sendable: true, replyAllAvailable: true });
    expect(r.recipients.to).toEqual([{ name: 'Shop Desk', address: 'shop@example.test', role: 'sender' }]);
    const recs = conv(dom.conversationKey);
    const api = recs.find((x) => x.source === 'api');
    expect(api).toMatchObject({ itemId: 'ORIG-7', recipientsKnown: true });
    expect(r.basedOnMessageKey).toBe(api.messageKey);
    expect(loadCard().intel.recipientsKnown).toBe(true);                  // Reply All follows on the card
    expect(env.fn.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a 404 on the stored REST id falls back to the InternetMessageId (a moved message)', async () => {
    const live = restMessage({ Id: 'NEW-1', ConversationId: 'CONV-9', InternetMessageId: '<m9@example.test>', From: SHOP, ToRecipients: [ME, OTHER] });
    boot({ msgs: [live] });
    const { R } = mods();
    const rec = env.addApi(restMessage({ Id: 'OLD-1', ConversationId: 'CONV-9', InternetMessageId: '<m9@example.test>', From: SHOP, ToRecipients: [ME] }));
    const r = await R.resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply-all' });
    expect(r).toMatchObject({ ok: true, source: 'api' });
    expect(addrs(r.recipients.to)).toEqual(['shop@example.test', 'other@example.test']);
    expect(conv(rec.conversationKey)[0].itemId).toBe('NEW-1');
  });

  it('unresolvable: no ids -> no network; conversation not in Outlook -> not-found; nothing fabricated', async () => {
    boot({ msgs: [] });
    const { R } = mods();
    const d = addLegacyDom(null, { derived: true });
    const a = await R.resolveReplyRecipients({ conversationKey: d.conversationKey, mode: 'reply' });
    expect(a).toEqual({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'no-ids', sendable: false, replyAllAvailable: false, recipients: { to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' } });
    expect(env.fn.calls).toHaveLength(0);
    const g = addLegacyDom('AAQkGONE-1=', { subject: 'Gone' });
    const b = await R.resolveReplyRecipients({ conversationKey: g.conversationKey, mode: 'reply-all' });
    expect(b).toMatchObject({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'not-found', sendable: false });
    expect(b.recipients).toEqual({ to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' });
    expect(conv(g.conversationKey).every((x) => x.source !== 'api')).toBe(true);
    expect(await R.resolveReplyRecipients({ conversationKey: 'cv_' + 'c'.repeat(16), mode: 'reply' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('transient failures keep stored API recipients (sendable); a DOM target is unavailable; a sign-in wall is blocked-auth', async () => {
    const fail500 = { method: 'GET', re: /\/me\/messages/, respond: () => ({ status: 500 }) };
    boot({ msgs: [], routes: [fail500] });
    const { R } = mods();
    const rec = env.addApi(restMessage({ Id: 'ORIG-2', ConversationId: 'CONV-2', InternetMessageId: '<o2@example.test>', From: SHOP, ToRecipients: [ME] }));
    const a = await R.resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply' });
    expect(a).toMatchObject({ ok: true, source: 'stored', sendable: true });
    expect(addrs(a.recipients.to)).toEqual(['shop@example.test']);
    const dom = addLegacyDom('AAQkCONV-8=');
    expect(await R.resolveReplyRecipients({ conversationKey: dom.conversationKey, mode: 'reply' })).toMatchObject({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'unavailable', sendable: false });
    env.cleanup();
    boot({ msgs: [], routes: [{ method: 'GET', re: /\/me\/messages/, respond: () => ({ status: 401 }) }] });
    const rec2 = env.addApi(restMessage({ Id: 'ORIG-3', ConversationId: 'CONV-3', InternetMessageId: '<o3@example.test>', From: SHOP, ToRecipients: [ME] }));
    expect(await mods().R.resolveReplyRecipients({ conversationKey: rec2.conversationKey, mode: 'reply' })).toMatchObject({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'blocked-auth', sendable: false });
  });

  it('self-addressed message: Reply goes to me (sendable), Reply All has no one besides me', async () => {
    const live = restMessage({ Id: 'SELF-1', ConversationId: 'CONV-S', InternetMessageId: '<s1@example.test>', From: ME, ToRecipients: [ME], Subject: 'test' });
    boot({ msgs: [live] });
    const { R } = mods();
    const rec = env.addApi(live);
    const r = await R.resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply' });
    expect(r).toMatchObject({ ok: true, sendable: true, replyAllAvailable: false });
    expect(r.recipients.to).toEqual([{ name: 'Me Person', address: 'me@example.test', role: 'to' }]);
    const all = await R.resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply-all' });
    expect(all).toMatchObject({ ok: true, sendable: false });
    expect(all.recipients).toMatchObject({ to: [], cc: [], blocked: 'NO_RECIPIENTS' });
  });

  it('logs enums and counts only (no address, subject or id)', async () => {
    installLogSpy();
    try {
      clearLog();
      const live = restMessage({ Id: 'SENTINEL-ID-77', ConversationId: 'CONV-SENT', InternetMessageId: '<sentinel77@example.test>', From: SHOP, ToRecipients: [ME], Subject: 'SENTINEL SUBJECT 77' });
      boot({ msgs: [live] });
      const rec = env.addApi(live);
      await require('../src/email-intel/reply/resolve-recipients').resolveReplyRecipients({ conversationKey: rec.conversationKey, mode: 'reply' });
      expect(leaks(['@', 'SENTINEL', 'CONV-SENT', 'Shop Desk'])).toEqual([]);
    } finally { restoreLogSpy(); }
  });
});

describe('send validator under apiTransport', () => {
  it('self-addressed: reply validates to me; reply-all no-recipients; flag off -> no-recipients exactly as today', () => {
    const live = restMessage({ Id: 'SELF-2', ConversationId: 'CONV-S2', InternetMessageId: '<s2@example.test>', From: ME, ToRecipients: [ME] });
    boot({ msgs: [live] });
    const { X } = mods();
    const rec = env.addApi(live);
    const p = (mode) => ({ conversationKey: rec.conversationKey, mode, bodyText: 'Thanks.' });
    const v = X.validateSendReply(p('reply'));
    expect(v.ok).toBe(true);
    expect(addrs(v.to)).toEqual(['me@example.test']);
    expect(X.validateSendReply(p('reply-all'))).toEqual({ ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-recipients' });
    env.flags._setForTests(OFF_API);
    expect(X.validateSendReply(p('reply'))).toEqual({ ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-recipients' });
  });
});

describe('draftThreadReply under apiTransport', () => {
  const ask = async () => ({ ok: true, text: 'Thanks.' });

  it('legacy DOM conversation: recipients come from the API, sendable, based on the new API record', async () => {
    const live = restMessage({ Id: 'ORIG-7', ConversationId: 'AAQkCONV-7_a=', InternetMessageId: '<o7@example.test>', From: SHOP, ToRecipients: [ME] });
    boot({ msgs: [live] });
    const { D } = mods();
    const dom = addLegacyDom('AAQkCONV-7_a=');
    const r = await D.draftThreadReply({ conversationKey: dom.conversationKey, mode: 'reply' }, { _ask: ask });
    expect(r).toMatchObject({ ok: true, recipientsSource: 'api', sendable: true });
    expect(r.recipients.to).toEqual([{ name: 'Shop Desk', address: 'shop@example.test', role: 'sender' }]);
    const api = conv(dom.conversationKey).find((x) => x.source === 'api');
    expect(r.basedOnMessageKey).toBe(api.messageKey);
    expect(r).not.toHaveProperty('unresolved');
  });

  it('a DOM twin sorted last: the draft and the send validator answer the same API message', async () => {
    const live = restMessage({ Id: 'ORIG-1', ConversationId: 'CONV-1', InternetMessageId: '<o1@example.test>', From: SHOP, ToRecipients: [ME] });
    boot({ msgs: [live] });
    const { D, X } = mods();
    const rec = env.addApi(live);
    env.addDom({ itemId: null, conversationKey: rec.conversationKey, convIdRaw: rec.convIdRaw, convIdSource: 'owa', legacySeed: rec.convIdRaw, folder: 'Inbox', subject: 'RE: other words',
      from: { name: 'Other Person', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'collapsed preview', bodyStatus: 'complete' }, Date.now() + 3600_000);
    const recs = conv(rec.conversationKey);
    expect(recs[recs.length - 1].source).not.toBe('api');
    const r = await D.draftThreadReply({ conversationKey: rec.conversationKey, mode: 'reply' }, { _ask: ask });
    const v = X.validateSendReply({ conversationKey: rec.conversationKey, mode: 'reply', bodyText: 'Thanks.' });
    expect(r.basedOnMessageKey).toBe(rec.messageKey);
    expect(v.latest.messageKey).toBe(r.basedOnMessageKey);
    expect(addrs(v.to)).toEqual(addrs(r.recipients.to));
  });

  it('unresolvable: still drafts, empty To/CC, sending off; reply-all is not refused as RECIPIENTS_UNKNOWN', async () => {
    boot({ msgs: [] });
    const { D } = mods();
    const g = addLegacyDom('AAQkGONE-2=');
    for (const mode of ['reply', 'reply-all']) {
      const r = await D.draftThreadReply({ conversationKey: g.conversationKey, mode }, { _ask: ask });
      expect(r).toMatchObject({ ok: true, mode, recipientsSource: null, sendable: false, replyAllAvailable: false, unresolved: { reason: 'not-found' } });
      expect(r.recipients).toEqual({ to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' });
    }
  });

  it('flag-off parity: no resolve, no network, no new keys, self-addressed reply still NO_RECIPIENTS', async () => {
    const live = restMessage({ Id: 'SELF-3', ConversationId: 'CONV-S3', InternetMessageId: '<s3@example.test>', From: ME, ToRecipients: [ME] });
    boot({ msgs: [live], flags: OFF_API });
    const { D } = mods();
    const rec = env.addApi(live);
    const spy = vi.fn(async () => ({ ok: true }));
    const r = await D.draftThreadReply({ conversationKey: rec.conversationKey, mode: 'reply' }, { _ask: ask, _resolve: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(env.fn.calls).toHaveLength(0);
    expect(Object.keys(r).sort()).toEqual(['aiUnavailable', 'basedOnMessageKey', 'draft', 'mode', 'ok', 'recipients', 'replyAllAvailable', 'warnings']);
    expect(r.recipients).toMatchObject({ to: [], blocked: 'NO_RECIPIENTS' });
  });
});

describe('IPC: emailIntel:resolve-reply-recipients and the unchanged confirm gate', () => {
  function bootIpc(o) {
    boot(o);
    require('../src/email-intel/confirm')._resetForTests();
    require('../src/ipc/email-intel').registerEmailIntelIPC({});
  }
  const accept = () => { electronStub.dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }; return electronStub.dialog; };
  const cancel = () => { electronStub.dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }; return electronStub.dialog; };
  const sendPosts = () => env.fn.calls.filter((c) => c.method === 'POST' && /\/send$|\/sendmail$/.test(c.decoded));
  const LIVE7 = () => restMessage({ Id: 'ORIG-7', ConversationId: 'AAQkCONV-7_a=', InternetMessageId: '<o7@example.test>', From: SHOP, ToRecipients: [ME], CcRecipients: [BOSS], Subject: 'Unit 40123 status' });

  it('inert when the gate or apiTransport is off; BAD_ARG for bad payloads', async () => {
    bootIpc({ msgs: [LIVE7()], flags: OFF_API });
    const dom = addLegacyDom('AAQkCONV-7_a=');
    expect(await call('emailIntel:resolve-reply-recipients', { conversationKey: dom.conversationKey, mode: 'reply' })).toEqual({ ok: true, enabled: false });
    env.flags._setForTests({ effective: { capture: true, apiTransport: true } });
    expect(await call('emailIntel:resolve-reply-recipients', { conversationKey: dom.conversationKey, mode: 'reply' })).toEqual({ ok: true, enabled: false });
    expect(env.fn.calls).toHaveLength(0);
    env.flags._setForTests(ON);
    expect(await call('emailIntel:resolve-reply-recipients', { conversationKey: 'nope', mode: 'reply' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'conversationKey' });
    expect(await call('emailIntel:resolve-reply-recipients', { conversationKey: dom.conversationKey, mode: 'new-message' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'mode' });
    expect(await call('emailIntel:resolve-reply-recipients', null)).toEqual({ ok: false, code: 'BAD_ARG', field: 'payload' });
  });

  it('legacy record: resolve -> prepare summary shows the same To and CC -> Cancel sends nothing -> Accept sends once', async () => {
    bootIpc({ msgs: [LIVE7()] });
    const dom = addLegacyDom('AAQkCONV-7_a=');
    const r = await call('emailIntel:resolve-reply-recipients', { conversationKey: dom.conversationKey, mode: 'reply-all' });
    expect(r).toMatchObject({ ok: true, source: 'api', sendable: true });
    expect(addrs(r.recipients.to)).toEqual(['shop@example.test']);
    expect(addrs(r.recipients.cc)).toEqual(['boss@example.test']);
    const payload = { conversationKey: dom.conversationKey, mode: 'reply-all', bodyText: 'Thanks, on it.' };
    const p1 = await call('emailIntel:prepare-action', 'send-reply', payload);
    expect(p1.ok).toBe(true);
    expect(addrs(p1.summary.to)).toEqual(addrs(r.recipients.to));
    expect(addrs(p1.summary.cc)).toEqual(addrs(r.recipients.cc));
    expect(p1.summary.detailText).toContain('CC (1) - check these people:');
    const c = cancel();
    expect(await call('emailIntel:confirm-action', p1.token)).toEqual({ ok: false, code: 'USER_CANCELLED' });
    expect(c.showMessageBox).toHaveBeenCalledTimes(1);
    expect(sendPosts()).toHaveLength(0);
    const p2 = await call('emailIntel:prepare-action', 'send-reply', payload);
    accept();
    expect(await call('emailIntel:confirm-action', p2.token)).toMatchObject({ ok: true, status: 'sent', mechanism: 'api-thread' });
    expect(sendPosts()).toHaveLength(1);
  });

  it('recipient verification unchanged: Outlook draft recipients that differ -> recipient-mismatch, nothing sent', async () => {
    bootIpc({ msgs: [LIVE7()], server: { draftTo: [OTHER] } });
    const dom = addLegacyDom('AAQkCONV-7_a=');
    await call('emailIntel:resolve-reply-recipients', { conversationKey: dom.conversationKey, mode: 'reply' });
    const p = await call('emailIntel:prepare-action', 'send-reply', { conversationKey: dom.conversationKey, mode: 'reply', bodyText: 'Thanks.' });
    accept();
    expect(await call('emailIntel:confirm-action', p.token)).toMatchObject({ ok: false, status: 'recipient-mismatch' });
    expect(sendPosts()).toHaveLength(0);
  });

  it('uncertain-send reconcile unchanged: a 500 on send is delivery-uncertain and the conversation stays blocked', async () => {
    bootIpc({ msgs: [LIVE7()], server: { send: { status: 500 } } });
    const dom = addLegacyDom('AAQkCONV-7_a=');
    await call('emailIntel:resolve-reply-recipients', { conversationKey: dom.conversationKey, mode: 'reply' });
    const payload = { conversationKey: dom.conversationKey, mode: 'reply', bodyText: 'Thanks.' };
    const p = await call('emailIntel:prepare-action', 'send-reply', payload);
    accept();
    const s = await call('emailIntel:confirm-action', p.token);
    expect(s).toMatchObject({ ok: false, status: 'delivery-uncertain' });
    expect(sendPosts()).toHaveLength(1);
    expect(await call('emailIntel:prepare-action', 'send-reply', payload)).toMatchObject({ ok: false, code: 'UNRECONCILED_ATTEMPT', attemptId: s.attemptId });
    const rc = await call('emailIntel:reconcile-send', s.attemptId);
    expect(['unconfirmed-not-found', 'delivery-uncertain']).toContain(rc.state);
    expect(await call('emailIntel:prepare-action', 'send-reply', payload)).toMatchObject({ ok: false, code: 'UNRECONCILED_ATTEMPT' });
    expect(sendPosts()).toHaveLength(1);
  });

  it('an unresolvable conversation is refused at prepare (no-api-id) and the dialog never opens', async () => {
    bootIpc({ msgs: [] });
    const g = addLegacyDom('AAQkGONE-3=');
    expect(await call('emailIntel:resolve-reply-recipients', { conversationKey: g.conversationKey, mode: 'reply' })).toMatchObject({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'not-found' });
    const d = accept();
    expect(await call('emailIntel:prepare-action', 'send-reply', { conversationKey: g.conversationKey, mode: 'reply', bodyText: 'Thanks.' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-api-id' });
    expect(d.showMessageBox).not.toHaveBeenCalled();
    expect(sendPosts()).toHaveLength(0);
  });
});
