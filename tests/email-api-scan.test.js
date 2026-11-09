// tests/email-api-scan.test.js — runIntelScan / scheduledTick on the Outlook REST transport (design 5.1, 5.6, 8.6;
// FR-2.8, FR-2.9, AC-4, AC-6, AC-7, NFR-4, R4-M2, R4-M3, R4-M5, R4-L11). Temp data dir, fake net, fake tokens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { apiEnv, fakeTokens, createFakeNet } from './fixtures/email-api/fake-net.js';
import { restMessage, restFolder, mailboxRoutes, WK } from './fixtures/email-api/rest-messages.js';
import { stubTriage } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const map = require('../src/email-intel/transport/map');
const identity = require('../src/email-intel/ingest/identity');
const { createHttp } = require('../src/email-intel/transport/http');
const owaRe = require('../src/scrapers/owa-mailer');

const HOUR = 3600_000;
const at = (h) => new Date(Date.now() - h * HOUR).toISOString().replace(/\.\d+Z$/, 'Z');
let env; let idx; let lock; let world;
function setup(w, o) {
  world = w;
  env = apiEnv(Object.assign({ routes: mailboxRoutes(w) }, o || {}));
  lock = require('../src/email-intel/reliability/lock');
  lock._reset();
  idx = require('../src/email-intel/index');
}
const scan = (o, trigger) => idx.runIntelScan(Object.assign({ folders: ['Inbox'], _transport: env.transport.deps(), _triageEmails: stubTriage() }, o || {}), trigger || 'manual');
const msg = (n, h, extra) => restMessage(Object.assign({ Id: 'M' + n, ConversationId: 'CONV-' + n, InternetMessageId: '<m' + n + '@example.test>', ReceivedDateTime: at(h), ParentFolderId: WK.inbox }, extra || {}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); if (env) env.cleanup(); env = null; });

describe('API scan', () => {
  it('FR-2.9 emailTriageResults and the overlay are fed from the API-built ledger', async () => {
    setup({ msgs: [msg(1, 2, { CcRecipients: [{ EmailAddress: { Name: 'Lead', Address: 'lead@example.test' } }] })] });
    const notify = vi.fn();
    const res = await idx.scheduledTick({ signal: new AbortController().signal }, {}, { notify, loadResults: () => require('../src/scrapers/email_triage').loadResults(), _scanOpts: { folders: ['Inbox'], _transport: env.transport.deps(), _triageEmails: stubTriage() } });
    expect(res.intel.outcome).toBe('complete');
    const e = res.emails[0];
    expect(e).toMatchObject({ from: 'shop@example.test', fromName: 'Shop Desk', convId: map.legacyConvId('CONV-1'), folder: 'Inbox' });
    expect(e.intel).toMatchObject({ recipientsKnown: true, messageCount: 1 });
    expect(e.intel.latestMessageKey).toBe(identity.itemKey('imid:<m1@example.test>'));
    expect(notify).toHaveBeenCalledTimes(1);
    const rec = env.stores.load('messages').messages[e.intel.latestMessageKey];
    expect(rec).toMatchObject({ source: 'api', receivedAtQuality: 'exact', recipientsKnown: true, cc: [{ name: 'Lead', address: 'lead@example.test' }] });
    expect(env.stores.load('checkpoints').folders.Inbox.api).toMatchObject({ v: 1, folderId: WK.inbox });
    const st = idx.getStatus();
    expect(st.flags.apiTransport).toBe(true);
    expect(st.api).toMatchObject({ token: expect.objectContaining({ present: true }), pausedUntil: 0 });
  });

  it('case K on the API: res.authBlocked is true, owaAuth blocked, scheduledTick throws AuthBlockedError', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' });
    let blocked = true;
    setup({ msgs: [msg(1, 3), msg(2, 2, { ParentFolderId: 'F-A' })], folders: [fA], failFolder: {} });
    world.failFolder['F-A'] = (req) => (blocked ? { status: 401 } : { status: 200, json: { value: world.msgs.filter((m) => m.ParentFolderId === 'F-A').map((m) => ({ Id: m.Id, ConversationId: m.ConversationId, InternetMessageId: m.InternetMessageId, ReceivedDateTime: m.ReceivedDateTime })) } });
    const res = await scan({ folders: ['Inbox', 'A', 'B'] });
    expect(res.authBlocked).toBe(true);
    expect(res.intel.outcome).toBe('auth-blocked');
    const ck = env.stores.load('checkpoints');
    expect(ck.owaAuth).toMatchObject({ state: 'blocked', blockedCount: 1 });
    expect(Object.keys(env.stores.load('messages').messages)).toHaveLength(1);           // the committed batch is kept
    const st = idx.getStatus();
    expect(st.warnings).toContain('auth-blocked');
    const P = await import('../renderer/src/js/components/email-intel-panels.js');
    expect(P.renderBannersHtml(st)).toContain('Outlook needs sign-in');
    let thrown = null;
    try { await idx.scheduledTick({ signal: new AbortController().signal }, {}, { _scanOpts: { folders: ['Inbox', 'A', 'B'], _transport: env.transport.deps(), _triageEmails: stubTriage() } }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(idx.AuthBlockedError);
    expect(thrown.code).toBe('OWA_AUTH_BLOCKED');
    blocked = false;
    const ok = await scan({ folders: ['Inbox', 'A', 'B'] });
    expect(ok.authBlocked).toBe(false);
    expect(env.stores.load('checkpoints').owaAuth.state).toBe('ok');
    expect(Object.keys(env.stores.load('messages').messages)).toHaveLength(2);
  });

  it('AC-7 a crash before commit re-reads without duplicates', async () => {
    setup({ msgs: [msg(1, 3), msg(2, 2)] });
    const r1 = await scan();
    expect(r1.emails).toHaveLength(2);
    env.stores.update('checkpoints', (ck) => { delete ck.folders.Inbox.api; return ck; });     // the cursor write was lost
    world.msgs.push(msg(3, 1));
    const r2 = await scan();
    expect(Object.keys(env.stores.load('messages').messages)).toHaveLength(3);
    expect(r2.emails).toHaveLength(3);
    expect(env.fn.calls.filter((c) => /\/me\/messages\/M1\?/.test(c.decoded))).toHaveLength(1);   // M1 was not opened again
  });

  it('R4-L11 two consecutive API scans start at different first folders', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' });
    setup({ msgs: [msg(1, 2), msg(2, 2, { ParentFolderId: 'F-A' })], folders: [fA] });
    const firstFolder = () => { const c = env.fn.calls.find((x) => /mailfolders\/(FOLDER-INBOX|F-A)\/messages/.test(x.decoded)); return /mailfolders\/([^/]+)\/messages/.exec(c.decoded)[1]; };
    await scan({ folders: ['Inbox', 'A'] });
    const f1 = firstFolder();
    env.fn.calls.length = 0;
    await scan({ folders: ['Inbox', 'A'] });
    expect(firstFolder()).not.toBe(f1);
  });

  it('R4-M2 onBatch passes cfg.caps.lookbackDays in the buildRecord ctx under api only', async () => {
    setup({ msgs: [msg(1, 2)] });
    const ledger = require('../src/email-intel/ingest/ledger');
    const spy = vi.spyOn(ledger, 'buildRecord');
    await scan();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.every((c) => c[2].lookbackDays === 14)).toBe(true);
    spy.mockClear();
    env.flags._setForTests({ effective: { capture: true } });
    const cap = Object.assign(map.toCapture(msg(9, 1), { folderLabel: 'Inbox' }), { source: undefined, keySeed: undefined });
    const reader = async (o) => { await o.onBatch('Inbox', [{ rowKey: 'r', rowSig: 's', captures: [cap] }]); return { ok: true, authBlocked: false, folders: [{ folder: 'Inbox', status: 'ok' }], opened: 1, rowsExamined: 1 }; };
    await idx.runIntelScan({ folders: ['Inbox'], _readMailbox: reader, _triageEmails: stubTriage() }, 'manual');
    expect(spy.mock.calls.length).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(spy.mock.calls[0][2], 'lookbackDays')).toBe(false);
  });

  it('R4-M3 a 3-member API group with a cross-conversation DOM twin ends under one key and one overlay row', async () => {
    const members = [
      restMessage({ Id: 'G1', ConversationId: 'CONV-G', InternetMessageId: '<g1@example.test>', ReceivedDateTime: at(30), Body: { ContentType: 'Text', Content: 'First question about unit 40123 timing.' } }),
      restMessage({ Id: 'G2', ConversationId: 'CONV-G', InternetMessageId: '<g2@example.test>', ReceivedDateTime: at(20), Body: { ContentType: 'Text', Content: 'Second message: parts on order for 40123.' } }),
      restMessage({ Id: 'G3', ConversationId: 'CONV-G', InternetMessageId: '<g3@example.test>', ReceivedDateTime: at(10), Body: { ContentType: 'Text', Content: 'Final answer: unit 40123 picked up today, thanks all.' } }),
    ];
    setup({ msgs: members });
    const dom = env.addDom({ itemId: null, conversationKey: identity.conversationKey('DOM/ENC+G='), convIdRaw: 'DOM/ENC+G=', convIdSource: 'owa', legacySeed: 'DOM/ENC+G=', folder: 'Inbox', subject: 'Unit 40123 status',
      from: { name: 'Shop Desk', address: null }, to: [], cc: [], recipientsKnown: false, receivedAt: null, receivedAtQuality: 'unknown', bodyText: 'Final answer: unit 40123 picked up today, thanks all.', bodyStatus: 'complete' }, Date.now() - 86_400_000);
    require('../src/store').save('emailTriageResults', { emails: [{ id: dom.legacyId, replyState: 'drafted', replyDraft: 'Ok', triagedAt: new Date().toISOString(), intel: { conversationKey: dom.conversationKey, latestMessageKey: dom.messageKey } }], ranAt: null });
    const res = await scan();
    const doc = env.stores.load('messages');
    const apiKey = identity.conversationKey(map.legacyConvId('CONV-G'));
    expect(doc.byConv[apiKey]).toBeUndefined();
    expect(doc.byConv[dom.conversationKey]).toHaveLength(3);
    expect(Object.values(doc.messages).filter((r) => r.source === 'api').map((r) => r.legacyId)).toEqual([dom.legacyId, dom.legacyId, dom.legacyId]);
    expect(doc.convAliasIndex[apiKey]).toEqual({ conversationKey: dom.conversationKey, legacyId: dom.legacyId });
    const rows = res.emails.filter((e) => e.intel && e.intel.conversationKey === dom.conversationKey);
    expect(rows).toHaveLength(1);
    expect(res.emails).toHaveLength(1);
    expect(rows[0].id).toBe(dom.legacyId);
  });
});

describe('scan-start auto-reconcile (R4-M5)', () => {
  const MARK = 'FOC-aaaaaaaaaaaaaaaa';
  function uncertain(i, guard) {
    const ck = 'cv_' + String(i).repeat(16).slice(0, 16);
    const c = guard.createAttempt({ conversationKey: ck, mode: 'reply', mechanism: 'api-thread', transport: 'api', apiRef: { subject: 'RE: S' + i }, marker: MARK, to: [], cc: [] }, { now: Date.now() - (30 - i) * 60_000 });
    guard.markSending(c.attempt.attemptId, { now: Date.now() - (30 - i) * 60_000 });
    guard.setApiRef(c.attempt.attemptId, { internetMessageId: '<x' + i + '@example.test>', conversationId: 'CONV-X' + i });
    guard.finish(c.attempt.attemptId, 'delivery-uncertain', { errorCode: 'UNCONFIRMED_TIMEOUT' });
    return c.attempt.attemptId;
  }

  it('R4-M5 auto-reconcile with 19 s fake GETs stays inside the 90 s budget, defers the rest, and the reader runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sentSlow = { method: 'GET', re: /mailfolders\/sentitems\/messages/, respond: () => ({ status: 200, json: { value: [] }, delayMs: 19_000 }) };
    world = { msgs: [msg(1, 2)] };
    env = apiEnv({ routes: [sentSlow].concat(mailboxRoutes(world)) });
    lock = require('../src/email-intel/reliability/lock'); lock._reset();
    idx = require('../src/email-intel/index');
    const ids = [uncertain(1, env.guard), uncertain(2, env.guard), uncertain(3, env.guard)];
    const t0 = Date.now();
    let readerAt = null;
    let done = null;
    const p = scan().then((r) => { done = r; });
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(done.intel.outcome).toBe('complete');
    const first = env.fn.calls.find((c) => /mailfolders\/FOLDER-INBOX\/messages/.test(c.decoded));
    expect(first).toBeTruthy();
    readerAt = first.at;
    expect(readerAt - t0).toBeLessThanOrEqual(90_000 + 2_000);
    const checks = ids.map((id) => env.guard.get(id).reconcile.checks.length);
    // newest first: the first attempt (3 strategies x 19 s = 57 s) completes; the second is cut off at 90 s; the third is deferred
    expect(checks).toEqual([0, 0, 1]);
    expect(ids.map((id) => env.guard.get(id).state)).toEqual(['delivery-uncertain', 'delivery-uncertain', 'delivery-uncertain']);
    expect(env.fn.calls.filter((c) => /sentitems/.test(c.decoded))).toHaveLength(5);
    expect(env.fn.calls.every((c) => c.method === 'GET')).toBe(true);
  }, 30_000);

  it('R4-M5 auto-reconcile stops on opts.signal abort', async () => {
    world = { msgs: [] };
    env = apiEnv({ routes: [{ method: 'GET', re: /sentitems/, respond: () => ({ status: 200, json: { value: [] } }) }].concat(mailboxRoutes(world)) });
    idx = require('../src/email-intel/index');
    uncertain(1, env.guard); uncertain(2, env.guard);
    const ac = new AbortController();
    ac.abort();
    const counts = await idx._reconcilePending({ max: 3, signal: ac.signal, deadlineAt: Date.now() + 90_000 });
    expect(counts).toMatchObject({ checked: 0, deferred: 2 });
    expect(env.fn.calls).toHaveLength(0);
    // abort mid-way: the attempt in flight ends inconclusive (no check), the rest are deferred
    const ac2 = new AbortController();
    const find = vi.fn(async () => { ac2.abort(); return { ok: false, code: 'RECONCILE_INCONCLUSIVE' }; });
    const c2 = await idx._reconcilePending({ max: 3, signal: ac2.signal, deadlineAt: Date.now() + 90_000, _apiFind: find });
    expect(c2).toMatchObject({ checked: 1, inconclusive: 1, deferred: 1 });
  });

  it('auto limits: transport api only, age >= 2 min, no check in the last 10 min, max 3, unsearchable filtered first', async () => {
    world = { msgs: [] };
    env = apiEnv({ routes: mailboxRoutes(world) });
    idx = require('../src/email-intel/index');
    const g = env.guard;
    const dom = g.createAttempt({ conversationKey: 'cv_dddddddddddddddd', mode: 'reply', mechanism: 'owa-thread', marker: MARK }, { now: Date.now() - 3600_000 });
    g.markSending(dom.attempt.attemptId); g.finish(dom.attempt.attemptId, 'delivery-uncertain');
    const fresh = g.createAttempt({ conversationKey: 'cv_eeeeeeeeeeeeeeee', mode: 'reply', mechanism: 'api-thread', transport: 'api', apiRef: { subject: 'S' }, marker: MARK });
    g.markSending(fresh.attempt.attemptId); g.finish(fresh.attempt.attemptId, 'delivery-uncertain');
    for (let i = 0; i < 3; i++) {
      const u = g.createAttempt({ conversationKey: 'cv_f' + i + 'fffffffffffffff'.slice(0, 14), mode: 'reply', mechanism: 'api-thread', transport: 'api', marker: MARK }, { now: Date.now() - 3600_000 });
      g.markSending(u.attempt.attemptId, { now: Date.now() - 3600_000 }); g.finish(u.attempt.attemptId, 'delivery-uncertain');      // no apiRef: unsearchable
    }
    const searchable = uncertain(4, g);
    const recent = uncertain(5, g);
    g.recordCheck(recent, false, Date.now() - 60_000);
    const seen = [];
    const find = vi.fn(async (a) => { seen.push(a.attemptId); return { ok: true, found: true }; });
    const counts = await idx._reconcilePending({ max: 3, deadlineAt: Date.now() + 90_000, _apiFind: find });
    expect(seen).toEqual([searchable]);
    expect(counts).toMatchObject({ checked: 1, sent: 1 });
    expect(g.get(searchable).state).toBe('sent');
  });
});
