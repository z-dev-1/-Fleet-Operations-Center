// tests/email-api-delete.test.js — Outlook REST deletes: transport/mail-actions.apiMoveToDeleted and the delete
// executor / legacy helper (design 9; FR-3.7, AC-15b, INV-14, R4-M1). Fake net only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { createFakeNet, fakeTokens, apiEnv } from './fixtures/email-api/fake-net.js';
import { restMessage, mailServerRoutes, WK } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);
const mailActions = require('../src/email-intel/transport/mail-actions');
const { createHttp } = require('../src/email-intel/transport/http');
const { createFolderResolver } = require('../src/email-intel/transport/folders');
const { TC } = require('../src/email-intel/transport/constants');
const owaRe = require('../src/scrapers/owa-mailer');

function mk(s) {
  const server = s || {};
  const fn = createFakeNet(mailServerRoutes(server));
  const timers = { setTimeout: (f, ms) => setTimeout(f, ms >= TC.POST_TIMEOUT_MS ? 400 : ms), clearTimeout: (t) => clearTimeout(t) };
  const http = createHttp({ electron: fn.electron, tokens: fakeTokens(), owaRe, sleep: () => Promise.resolve(), timers });
  return { fn, server, deps: { http, folders: createFolderResolver({ http, owaRe }) } };
}
const moves = (x) => x.fn.calls.filter((c) => c.method === 'POST' && /\/move$/.test(c.decoded));

describe('apiMoveToDeleted', () => {
  it('AC-15b an empty list returns NOT_FOUND and moves nothing', async () => {
    const x = mk({ conv: {} });
    expect(await mailActions.apiMoveToDeleted({ deps: x.deps, folderLabel: 'Inbox', apiConversationId: 'CONV-1' })).toEqual({ ok: false, code: 'NOT_FOUND', moved: 0 });
    expect(moves(x)).toHaveLength(0);
  });

  it('AC-15b no API id, unknown folder, partial, auth block, 50 cap, no retry of a timed-out move', async () => {
    const x = mk({ conv: { 'CONV-1': ['A', 'B', 'C'] } });
    expect(await mailActions.apiMoveToDeleted({ deps: x.deps, folderLabel: 'Inbox' })).toEqual({ ok: false, code: 'NO_API_ID', moved: 0 });
    expect(x.fn.calls).toHaveLength(0);
    expect(await mailActions.apiMoveToDeleted({ deps: x.deps, folderLabel: 'Nope/Folder', apiConversationId: 'CONV-1' })).toEqual({ ok: false, code: 'FOLDER_NOT_FOUND', moved: 0 });
    expect(await mailActions.apiMoveToDeleted({ deps: x.deps, folderLabel: 'Inbox', apiConversationId: 'CONV-1' })).toEqual({ ok: true, moved: 3, failed: 0 });
    expect(moves(x).every((c) => JSON.stringify(c.body) === JSON.stringify({ DestinationId: 'deleteditems' }))).toBe(true);
    const p = mk({ conv: { 'CONV-1': ['A', 'B', 'C'] }, moveFail: new Set(['B']) });
    expect(await mailActions.apiMoveToDeleted({ deps: p.deps, folderLabel: 'Inbox', apiConversationId: 'CONV-1' })).toEqual({ ok: false, code: 'PARTIAL', moved: 2, failed: 1 });
    const a = mk({ conv: { 'CONV-1': ['A', 'B', 'C'] }, moveAuth: new Set(['B']) });
    expect(await mailActions.apiMoveToDeleted({ deps: a.deps, folderLabel: 'Inbox', apiConversationId: 'CONV-1' })).toEqual({ ok: false, code: 'blocked-auth', moved: 1, failed: 0 });
    expect(moves(a).map((c) => c.decoded.split('/').slice(-2)[0])).toEqual(['A', 'B', 'B']);   // the 401 refreshed once; no third move
    const many = Array.from({ length: 60 }, (_, i) => 'M' + i);
    const c = mk({ conv: { 'CONV-1': many } });
    expect(await mailActions.apiMoveToDeleted({ deps: c.deps, folderLabel: 'Inbox', apiConversationId: 'CONV-1' })).toEqual({ ok: true, moved: TC.DELETE_CONV_MAX, failed: 0 });
    const t = mk({ conv: { 'CONV-1': ['A'] }, moveFail: { has: () => true, get: () => ({ hang: true }) } });
    expect(await mailActions.apiMoveToDeleted({ deps: t.deps, folderLabel: 'Inbox', apiConversationId: 'CONV-1' })).toEqual({ ok: false, code: 'PARTIAL', moved: 0, failed: 1 });
    expect(moves(t)).toHaveLength(1);                                           // a timed-out move is not retried
  });
});

describe('delete executors under apiTransport', () => {
  let env; let confirm; let executors; let owaReader; let delSpy;
  const accept = { showMessageBox: async () => ({ response: 1 }) };
  const ORIG = restMessage({ Id: 'ORIG-1', ConversationId: 'CONV-1', InternetMessageId: '<o1@example.test>', Subject: 'Weekly promo' });
  beforeEach(() => {
    env = apiEnv({ routes: mailServerRoutes({ conv: { 'CONV-1': ['ORIG-1'] } }) });
    confirm = require('../src/email-intel/confirm');
    executors = require('../src/email-intel/executors');
    owaReader = require('../src/scrapers/owa_reader');
    delSpy = vi.spyOn(owaReader, 'deleteMessage').mockImplementation(async () => ({ ok: true }));
    confirm._resetForTests();
    executors.registerAll();
    env.rec = env.addApi(ORIG);
    require('../src/store').save('emailTriageResults', { emails: [{ id: env.rec.legacyId, convId: env.rec.convIdRaw, subject: 'Weekly promo', deleted: false, intel: { conversationKey: env.rec.conversationKey, latestMessageKey: env.rec.messageKey } }], ranAt: null });
  });
  afterEach(() => { vi.restoreAllMocks(); confirm._resetForTests(); env.cleanup(); });

  it('_deleteOne moves through the API and keeps the legacy bookkeeping; owa_reader.deleteMessage is never called', async () => {
    const t = executors.deleteTarget(env.rec.conversationKey);
    expect(t.target.apiConversationId).toBe('CONV-1');
    const p = confirm.prepare('delete', { conversationKey: env.rec.conversationKey });
    const r = await confirm.confirm(p.token, { _dialog: accept });
    expect(r).toEqual({ ok: true, message: 'Deleted - moved to Deleted Items in Outlook.' });
    expect(delSpy).not.toHaveBeenCalled();
    expect(env.fn.calls.filter((c) => /\/move$/.test(c.decoded))).toHaveLength(1);
    const res = require('../src/scrapers/email_triage').loadResults();
    expect(res.emails[0].deleted).toBe(true);
  });

  it('after an API success _deleteOne leaves the same documents as the DOM success path', async () => {
    const snap = () => { const r = JSON.parse(JSON.stringify(require('../src/scrapers/email_triage').loadResults())); for (const e of r.emails) if (e.deletedAt) e.deletedAt = 'T'; return r; };
    const seed = require('../src/store').load('emailTriageResults', null);
    const p = confirm.prepare('delete', { conversationKey: env.rec.conversationKey });
    const apiOut = await confirm.confirm(p.token, { _dialog: accept });
    const apiDocs = snap();
    require('../src/store').save('emailTriageResults', seed);
    env.flags._setForTests({ effective: { capture: true, multiRecipient: true, actionsView: true } });     // DOM build, faked DOM success
    const p2 = confirm.prepare('delete', { conversationKey: env.rec.conversationKey });
    const domOut = await confirm.confirm(p2.token, { _dialog: accept });
    expect(delSpy).toHaveBeenCalledTimes(1);
    expect(domOut).toEqual(apiOut);
    expect(snap()).toEqual(apiDocs);
  });

  it('NOT_FOUND maps to the DOM row-not-found result with no bookkeeping', async () => {
    env.transport._setForTests({ http: createHttp({ electron: createFakeNet(mailServerRoutes({ conv: {} })).electron, tokens: fakeTokens(), owaRe, sleep: () => Promise.resolve() }), tokens: fakeTokens() });
    const p = confirm.prepare('delete', { conversationKey: env.rec.conversationKey });
    expect(await confirm.confirm(p.token, { _dialog: accept })).toEqual({ ok: false, status: 'row-not-found', error: 'message not found in Inbox (already moved?)' });
    expect(require('../src/scrapers/email_triage').loadResults().emails[0].deleted).toBe(false);
  });

  it('R4-M1 deleteTarget and apiLegacyDelete use _apiLatest, no NO_API_ID from a leftover md_', async () => {
    env.addDom({ itemId: null, conversationKey: env.rec.conversationKey, convIdRaw: env.rec.convIdRaw, convIdSource: 'owa', legacySeed: env.rec.convIdRaw, folder: 'Inbox', subject: 'Unrelated preview',
      from: { name: 'Someone', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'collapsed', bodyStatus: 'complete' }, Date.now() + 3600_000);
    const t = executors.deleteTarget(env.rec.conversationKey);
    expect(t.ok).toBe(true);
    expect(t.target.apiConversationId).toBe('CONV-1');
    const email = require('../src/scrapers/email_triage').loadResults().emails[0];
    const r = await executors.apiLegacyDelete(email);
    expect(r).toEqual({ ok: true, moved: 1 });
    expect(delSpy).not.toHaveBeenCalled();
    expect(await executors.apiLegacyDelete({ intel: { latestMessageKey: 'md_unknown' } })).toEqual({ ok: false, error: 'not read through the Outlook API yet' });
  });
});
