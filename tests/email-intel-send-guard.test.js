// tests/email-intel-send-guard.test.js — persisted send attempts, the uncertain-delivery block and boot recovery
// (design 6.5; R5.8, case L), plus the read-only reconcile (reply/reconcile-send.js) with an injected session.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const flags = require('../src/email-intel/flags');
const stores = require('../src/email-intel/stores');
const store = require('../src/store');
const guard = require('../src/email-intel/reply/send-guard');
const { reconcileSend } = require('../src/email-intel/reply/reconcile-send');

const CK = 'cv_00000000000000c1';
const CK2 = 'cv_00000000000000c2';
const FIELDS = { conversationKey: CK, targetMessageKey: 'mi_t1', mode: 'reply', mechanism: 'owa-thread', to: [{ name: 'Dealer', address: 'parts@dealer.example.test' }], cc: [{ name: 'Mike', address: 'mike@example.test' }], subjectNorm: 're: pickup', bodyHash: 'h', bodyChars: 10, marker: 'FOC-0123456789abcdef' };
let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-sg-'));
  require('../src/config/paths').setDataDir(tmp);
  flags._setForTests({ enabled: true, capture: true, multiRecipient: true, threadReplies: true });
  guard._resetForTests();
});
afterEach(() => { flags._setForTests(null); guard._resetForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ } });

describe('send attempts (R5.8)', () => {
  it('R5.8 uncertain blocks resend', () => {
    expect(guard.canSend(CK)).toEqual({ ok: true });
    const c = guard.createAttempt(FIELDS);
    expect(c.ok).toBe(true);
    expect(c.attempt).toMatchObject({ state: 'preparing', mode: 'reply', mechanism: 'owa-thread', toCount: 1, ccCount: 1, reconcile: { checks: [], resolution: null } });
    expect(c.attempt.attemptId).toMatch(guard.ID_RE);
    // preparing (younger than 10 minutes) already blocks a second attempt for the same conversation
    expect(guard.createAttempt(FIELDS)).toMatchObject({ ok: false, code: 'UNRECONCILED_ATTEMPT', attemptId: c.attempt.attemptId });
    expect(guard.canSend(CK2)).toEqual({ ok: true });                                 // other conversations are not blocked
    expect(guard.markSending(c.attempt.attemptId).attempt).toMatchObject({ state: 'sending', sendClickedAt: expect.any(String) });
    expect(stores.load('sends').attempts[c.attempt.attemptId].state).toBe('sending');   // persisted before the click
    guard.finish(c.attempt.attemptId, 'delivery-uncertain');
    expect(guard.canSend(CK)).toEqual({ ok: false, reason: 'unreconciled-attempt', attemptId: c.attempt.attemptId, state: 'delivery-uncertain' });
    expect(guard.createAttempt(FIELDS)).toMatchObject({ ok: false, code: 'UNRECONCILED_ATTEMPT' });
    guard.finish(c.attempt.attemptId, 'unconfirmed-not-found');
    expect(guard.canSend(CK).ok).toBe(false);                                           // not found by reconcile: still blocked
    expect(guard.unreconciledCount()).toBe(1);
    guard.resolve(c.attempt.attemptId, 'not-sent');
    expect(guard.get(c.attempt.attemptId)).toMatchObject({ state: 'abandoned', reconcile: { resolution: 'user-marked-not-sent' } });
    expect(guard.canSend(CK)).toEqual({ ok: true });
  });

  it('terminal states never block; a preparing attempt older than 10 minutes does not block', () => {
    for (const st of ['sent', 'failed-before-send', 'blocked-auth', 'abandoned']) {
      const c = guard.createAttempt(FIELDS);
      guard.finish(c.attempt.attemptId, st);
      expect(guard.canSend(CK), st).toEqual({ ok: true });
    }
    const old = guard.createAttempt(FIELDS, { now: Date.now() - 11 * 60_000 });
    expect(old.ok).toBe(true);
    expect(guard.canSend(CK)).toEqual({ ok: true });
  });

  it('boot recovery: sending becomes delivery-uncertain, an old preparing attempt becomes failed-before-send', () => {
    const a = guard.createAttempt(FIELDS); guard.markSending(a.attempt.attemptId);
    const b = guard.createAttempt(Object.assign({}, FIELDS, { conversationKey: CK2 }), { now: Date.now() - 20 * 60_000 });
    expect(guard.bootRecover()).toEqual({ uncertain: 1, failed: 1 });
    expect(guard.get(a.attempt.attemptId)).toMatchObject({ state: 'delivery-uncertain', errorCode: 'BOOT_RECOVERY' });
    expect(guard.get(b.attempt.attemptId)).toMatchObject({ state: 'failed-before-send', errorCode: 'BOOT_RECOVERY' });
    expect(guard.canSend(CK).ok).toBe(false);
    expect(guard.bootRecover()).toEqual({ uncertain: 0, failed: 0 });
  });

  it('process-wide mutex: one send at a time', async () => {
    let release;
    const first = guard.withSendLock(() => new Promise((r) => { release = r; }));
    expect(await guard.withSendLock(async () => 'second')).toEqual({ ok: false, code: 'SEND_IN_PROGRESS' });
    expect(guard.isSending()).toBe(true);
    expect(guard.bootRecover()).toEqual({ uncertain: 0, failed: 0 });                    // never while this process is sending
    release({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await guard.withSendLock(async () => 'third')).toBe('third');
  });

  it('applyOutcome mirrors sent / uncertain / abandoned onto the legacy record and closes reply items on a confirmed send', () => {
    store.save('emailTriageResults', { emails: [{ id: 'em_x', replyState: 'drafted', replyDraft: 'd', intel: { conversationKey: CK } }], ranAt: 'x', authBlocked: false });
    stores.save('actions', { version: 1, questions: {}, items: { ac_00000000000000a1: { actionId: 'ac_00000000000000a1', category: 'reply', state: 'open', conversationKey: CK }, ac_00000000000000a2: { actionId: 'ac_00000000000000a2', category: 'recorded', state: 'open', conversationKey: CK } } });
    const c = guard.createAttempt(FIELDS);
    guard.applyOutcome(guard.finish(c.attempt.attemptId, 'delivery-uncertain').attempt);
    expect(store.load('emailTriageResults').emails[0].replyState).toBe('uncertain');
    guard.applyOutcome(guard.finish(c.attempt.attemptId, 'abandoned').attempt);
    expect(store.load('emailTriageResults').emails[0].replyState).toBe('drafted');
    guard.applyOutcome(guard.finish(c.attempt.attemptId, 'sent').attempt, { bodyText: 'final body' });
    expect(store.load('emailTriageResults').emails[0]).toMatchObject({ replyState: 'sent', replyDraft: 'final body' });
    const items = stores.load('actions').items;
    expect(items.ac_00000000000000a1.state).toBe('done-user');
    expect(items.ac_00000000000000a2.state).toBe('open');
  });

  it('flags OFF: nothing is written and attempts cannot be created', () => {
    flags._setForTests(null);
    expect(guard.createAttempt(FIELDS)).toEqual({ ok: false, code: 'FLAGS_OFF' });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe('reconcile-send (read-only Sent Items re-check)', () => {
  const session = (verifyResult, settled = {}) => async (_opts, driver) => {
    const ctx = { state: {}, win: { fake: true } };
    if (!settled.authBlocked) await driver(ctx);
    return { state: ctx.state, settled: Object.assign({}, ctx.state, settled) };
  };
  const uncertain = () => { const c = guard.createAttempt(FIELDS); guard.markSending(c.attempt.attemptId); guard.finish(c.attempt.attemptId, 'delivery-uncertain'); return c.attempt.attemptId; };

  it('found: the attempt becomes sent (confirmed-sent) and the conversation unblocks', async () => {
    const id = uncertain();
    const calls = [];
    const r = await reconcileSend(id, { _session: session(), _verify: async (win, o) => { calls.push(o); return { found: true, matchedBy: 'marker' }; } });
    expect(r).toEqual({ ok: true, state: 'sent', found: true });
    expect(calls[0]).toMatchObject({ marker: 'FOC-0123456789abcdef', normSubject: 're: pickup', recipients: ['parts@dealer.example.test', 'mike@example.test'], timeoutMs: 75_000 });
    expect(guard.get(id)).toMatchObject({ state: 'sent', reconcile: { resolution: 'confirmed-sent', checks: [{ found: true }] } });
    expect(guard.canSend(CK)).toEqual({ ok: true });
  });

  it('not found: unconfirmed-not-found, the check is recorded and the conversation stays blocked', async () => {
    const id = uncertain();
    expect(await reconcileSend(id, { _session: session(), _verify: async () => ({ found: false }) })).toEqual({ ok: true, state: 'unconfirmed-not-found', found: false });
    expect(guard.get(id).reconcile.checks).toHaveLength(1);
    expect(guard.canSend(CK).ok).toBe(false);
    expect((await reconcileSend(id, { _session: session(), _verify: async () => ({ found: false }) })).state).toBe('unconfirmed-not-found');
    expect(guard.get(id).reconcile.checks).toHaveLength(2);
  });

  it('auth wall: unchanged and blocked-auth reported; only uncertain attempts are reconcilable', async () => {
    const id = uncertain();
    expect(await reconcileSend(id, { _session: session(null, { authBlocked: true }), _verify: async () => ({ found: true }) })).toEqual({ ok: false, code: 'blocked-auth', state: 'delivery-uncertain' });
    expect(guard.get(id).state).toBe('delivery-uncertain');
    const c = guard.createAttempt(Object.assign({}, FIELDS, { conversationKey: CK2 }));
    expect(await reconcileSend(c.attempt.attemptId, { _session: session(), _verify: async () => ({ found: true }) })).toEqual({ ok: false, code: 'NOT_RECONCILABLE', state: 'preparing' });
    expect(await reconcileSend('sa_ffffffffffffffff', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
