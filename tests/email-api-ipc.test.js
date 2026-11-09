// tests/email-api-ipc.test.js — IPC under the Outlook REST transport: legacy emailTriage:* channels and the
// emailIntel:* gates (design 8.7, 9, 10; FR-2.10, FR-3.4a, FR-3.5, FR-3.7, AC-14, AC-15a, AC-15b, INV-12, INV-14, R4-M1).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { apiEnv, fakeTokens, createFakeNet } from './fixtures/email-api/fake-net.js';
import { restMessage, mailServerRoutes } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);

const handlers = {};
const electronStub = { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow: { getAllWindows: () => [] } };
beforeAll(() => {
  const p = require.resolve('electron');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: electronStub };
});
const call = (ch, ...a) => handlers[ch]({ sender: {} }, ...a);

let env; let server; let owaReader; let delSpy; let triage; let confirm;
const ORIG = restMessage({ Id: 'ORIG-1', ConversationId: 'CONV-1', InternetMessageId: '<o1@example.test>', Subject: 'Unit 40123' });
function boot(flagsObj, srv) {
  server = Object.assign({ originals: { 'ORIG-1': ORIG }, conv: { 'CONV-1': ['ORIG-1'] } }, srv || {});
  env = apiEnv({ flags: flagsObj, routes: [{ method: 'GET', re: /mailfolders\/inbox\/messages\?\$top=1&/, respond: () => ({ status: 200, json: { value: [{ Id: 'X' }] } }) }].concat(mailServerRoutes(server)) });
  owaReader = require('../src/scrapers/owa_reader');
  delSpy = vi.spyOn(owaReader, 'deleteMessage').mockImplementation(async () => ({ ok: true }));
  vi.spyOn(owaReader, 'probeInbox').mockImplementation(async () => ({ ok: true, dom: true }));
  triage = require('../src/scrapers/email_triage');
  vi.spyOn(triage, 'startAutoScan').mockImplementation(() => {});
  confirm = require('../src/email-intel/confirm');
  confirm._resetForTests();
  require('../src/ipc/email-triage').registerEmailTriageIPC({});
  require('../src/ipc/email-intel').registerEmailIntelIPC({});
  env.rec = env.addApi(ORIG);
  saveLegacy({});
}
function saveLegacy(extra) {
  require('../src/store').save('emailTriageResults', { emails: [Object.assign({ id: env.rec.legacyId, convId: env.rec.convIdRaw, from: 'shop@example.test', subject: 'Unit 40123', folder: 'Inbox', replyDraft: 'Thanks', deleteSuggested: true,
    intel: { conversationKey: env.rec.conversationKey, latestMessageKey: env.rec.messageKey } }, extra)], ranAt: null });
}
const API = { effective: { capture: true, apiTransport: true } };
const accept = () => { electronStub.dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }; return electronStub.dialog; };
beforeEach(() => { delete electronStub.dialog; });
afterEach(() => { vi.restoreAllMocks(); if (confirm) confirm._resetForTests(); if (env) env.cleanup(); env = null; delete electronStub.dialog; });
const posts = () => env.fn.calls.filter((c) => c.method === 'POST' && /\/send$|\/sendmail$/.test(c.decoded));

describe('legacy emailTriage:* under apiTransport', () => {
  it('AC-14 the legacy send-reply channel opens the native dialog', async () => {
    boot(API);
    const d = accept();
    const r = await call('emailTriage:send-reply', env.rec.legacyId, 'Thanks, on it.');
    expect(d.showMessageBox).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, status: 'sent', transport: 'api' });
    expect(r).not.toHaveProperty('fallback');
    expect(posts()).toHaveLength(1);
    electronStub.dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
    saveLegacy({});
    env.guard._resetForTests();
    const c = await call('emailTriage:send-reply', env.rec.legacyId, 'Again');
    expect(c).toMatchObject({ ok: false, code: 'USER_CANCELLED', transport: 'api', error: 'Cancelled. Nothing was sent.' });
    expect(posts()).toHaveLength(1);
  });

  it('threadReplies ON keeps CONFIRMATION_REQUIRED on the legacy channel', async () => {
    boot({ effective: { capture: true, multiRecipient: true, threadReplies: true, apiTransport: true } });
    const d = accept();
    expect(await call('emailTriage:send-reply', env.rec.legacyId, 'x')).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(d.showMessageBox).not.toHaveBeenCalled();
  });

  it('AC-15a legacy refusals return their own code and text without opening the dialog', async () => {
    boot(API);
    const d = accept();
    const g = env.guard.createAttempt({ conversationKey: env.rec.conversationKey, mode: 'reply', mechanism: 'api-thread', transport: 'api' });
    env.guard.markSending(g.attempt.attemptId);
    expect(await call('emailTriage:send-reply', env.rec.legacyId, 'x')).toMatchObject({ ok: false, transport: 'api', code: 'UNRECONCILED_ATTEMPT', error: 'Reply status uncertain - reconcile before retrying. Nothing was sent.' });
    env.guard.finish(g.attempt.attemptId, 'sent');
    expect(await call('emailTriage:send-reply', env.rec.legacyId, 'password: hunter2 secret=AKIAABCDEFGHIJKLMNOP')).toMatchObject({ ok: false, reason: 'secret-like', error: 'The reply looks like it contains a secret or credential. Nothing was sent.' });
    saveLegacy({ intel: null });
    expect(await call('emailTriage:send-reply', env.rec.legacyId, 'x')).toMatchObject({ ok: false, code: 'NO_CONVERSATION', error: 'Run a scan so this email is read through the Outlook API, then reply.' });
    expect(d.showMessageBox).not.toHaveBeenCalled();
    expect(env.fn.calls).toHaveLength(0);
  });

  it('AC-15a a derived DOM record returns no-api-id with the Run a scan text', async () => {
    boot(API);
    const d = accept();
    const dom = env.addDom({ itemId: null, conversationKey: 'cv_' + 'b'.repeat(16), convIdRaw: '', convIdSource: 'derived', legacySeed: 'aria', folder: 'Inbox', subject: 'Hi',
      from: { name: 'Someone', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'hello', bodyStatus: 'complete' });
    require('../src/store').save('emailTriageResults', { emails: [{ id: dom.legacyId, intel: { conversationKey: dom.conversationKey, latestMessageKey: dom.messageKey } }] });
    expect(await call('emailTriage:send-reply', dom.legacyId, 'x')).toEqual({ ok: false, transport: 'api', code: 'BAD_ARG', reason: 'no-api-id', error: 'Run a scan so this email is read through the Outlook API, then reply.' });
    expect(d.showMessageBox).not.toHaveBeenCalled();
    // flag OFF: the same derived record keeps today's refusal reason
    env.flags._setForTests({ effective: { capture: true } });
    const v = require('../src/email-intel/executors').validateSendReply({ conversationKey: dom.conversationKey, mode: 'reply', bodyText: 'x' });
    expect(['no-recipients', 'no-conversation-id']).toContain(v.reason);
  });

  it('AC-15a mechanism-unavailable shows the nothing-was-sent text with no fallback', async () => {
    boot(API, { originals: {} });
    accept();
    const r = await call('emailTriage:send-reply', env.rec.legacyId, 'x');
    expect(r).toMatchObject({ ok: false, status: 'mechanism-unavailable', transport: 'api', error: 'Could not reply inside the Outlook conversation. Nothing was sent.' });
    expect(r).not.toHaveProperty('fallback');
    expect(posts()).toHaveLength(0);
  });

  it('a delivery-uncertain executor result returns the uncertain text and transport:api', async () => {
    boot(API, { send: { status: 503 } });
    accept();
    const r = await call('emailTriage:send-reply', env.rec.legacyId, 'x');
    const executors = require('../src/email-intel/executors');
    expect(r).toMatchObject({ ok: false, status: 'delivery-uncertain', transport: 'api', error: executors.SEND_MESSAGES['delivery-uncertain'] });
    expect(posts()).toHaveLength(1);
  });

  it('AC-15b legacy delete NOT_FOUND shows the DOM text with no recordDeletion', async () => {
    boot(API, { conv: {} });
    const rec = vi.spyOn(triage, 'recordDeletion');
    expect(await call('emailTriage:delete', env.rec.legacyId)).toEqual({ ok: false, error: 'message not found in Inbox (already moved?)', status: 'row-not-found' });
    expect(rec).not.toHaveBeenCalled();
    expect(triage.loadResults().emails[0].deleted).toBeUndefined();
    const s = await call('emailTriage:delete-suggested');
    expect(s).toEqual({ ok: true, deleted: 0, total: 1, outcomes: [{ id: env.rec.legacyId, ok: false, error: 'message not found in Inbox (already moved?)' }] });
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('legacy delete moves through the API and keeps the bookkeeping', async () => {
    boot(API);
    const rec = vi.spyOn(triage, 'recordDeletion').mockImplementation(() => {});
    expect(await call('emailTriage:delete', env.rec.legacyId)).toEqual({ ok: true, message: 'Deleted — moved to Deleted Items in Outlook.' });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(triage.loadResults().emails[0].deleted).toBe(true);
    expect(delSpy).not.toHaveBeenCalled();
    expect(env.fn.calls.filter((c) => /\/move$/.test(c.decoded))).toHaveLength(1);
  });

  it('R4-M1 legacy send-reply and delete with a leftover md_ twin use the api record', async () => {
    boot(API);
    accept();
    env.addDom({ itemId: null, conversationKey: env.rec.conversationKey, convIdRaw: env.rec.convIdRaw, convIdSource: 'owa', legacySeed: env.rec.convIdRaw, folder: 'Inbox', subject: 'Different words',
      from: { name: 'Other', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'collapsed', bodyStatus: 'complete' }, Date.now() + 3600_000);
    const r = await call('emailTriage:send-reply', env.rec.legacyId, 'Thanks');
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(env.fn.calls.find((c) => /createreply$/.test(c.decoded)).decoded).toContain('/messages/ORIG-1/createreply');
    vi.spyOn(triage, 'recordDeletion').mockImplementation(() => {});
    expect((await call('emailTriage:delete', env.rec.legacyId)).ok).toBe(true);
  });
});

describe('emailIntel:* under apiTransport', () => {
  it('FR-2.10 probe runs transport.probe; dom-probe and set-tz-verified return DOM_DISABLED', async () => {
    boot(API);
    const dp = require('../src/email-intel/capture/dom-probe');
    const spy = vi.spyOn(dp, 'domProbe');
    const p = await call('emailTriage:probe');
    expect(p).toMatchObject({ ok: true, transport: 'api', status: 200, token: expect.objectContaining({ present: true }) });
    expect(Object.keys(p).sort()).toEqual(['latencyMs', 'ok', 'status', 'token', 'transport']);
    expect(owaReader.probeInbox).not.toHaveBeenCalled();
    expect(await call('emailIntel:dom-probe', {})).toMatchObject({ ok: false, code: 'DOM_DISABLED' });
    expect(await call('emailIntel:set-tz-verified', { probeId: 'pr_0123456789abcdef' })).toMatchObject({ ok: false, code: 'DOM_DISABLED' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('gates opened by apiTransport alone: get-send-attempts, reconcile-send, mark-send-resolution', async () => {
    boot(API);
    const ipc = require('../src/ipc/email-intel');
    expect(ipc.GATES['emailIntel:get-send-attempts']).toBe('threadReplies|apiTransport');
    expect(ipc.KIND_GATES['mark-send-resolution']).toBe('threadReplies|apiTransport');
    expect(Object.keys(ipc.GATES)).toHaveLength(16);
    expect(await call('emailIntel:get-send-attempts', env.rec.conversationKey)).toMatchObject({ ok: true, attempts: [] });
    expect(await call('emailIntel:reconcile-send', 'sa_0123456789abcdef')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await call('emailIntel:prepare-action', 'mark-send-resolution', { attemptId: 'sa_0123456789abcdef', resolution: 'sent', acknowledgeCheckedOutlook: true })).toMatchObject({ ok: false, code: 'BAD_ARG', reason: 'not-unresolved' });
    expect(await call('emailIntel:draft-thread-reply', { conversationKey: env.rec.conversationKey, mode: 'reply' })).toEqual({ ok: true, enabled: false });
    expect(await call('emailIntel:prepare-action', 'send-reply', { conversationKey: env.rec.conversationKey, mode: 'reply', bodyText: 'x' })).toEqual({ ok: true, enabled: false });
    env.flags._setForTests({ effective: { capture: true } });
    expect(await call('emailIntel:get-send-attempts', env.rec.conversationKey)).toEqual({ ok: true, enabled: false });
    expect(await call('emailIntel:reconcile-send', 'sa_0123456789abcdef')).toEqual({ ok: true, enabled: false });
  });
});
