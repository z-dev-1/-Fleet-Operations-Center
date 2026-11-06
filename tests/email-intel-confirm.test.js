// tests/email-intel-confirm.test.js — confirmation tokens and native human proof (design 1.7, F-18).
// R5.6 summary lists CC; R5.7 single-use token, ttl, payload binding; R7.5 no executor runs
// without a token AND native dialog acceptance; F-18 cancelled dialog consumes the token.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const confirm = require('../src/email-intel/confirm');
const C = require('../src/email-intel/constants');

const T0 = 1_800_000_000_000;
const TOKEN_RE = /^[0-9a-f]{32}$/;
let ran;
const dialogs = [];
const accept = { showMessageBox: async (...a) => { dialogs.push(a[a.length - 1]); return { response: 1 }; } };
const cancel = { showMessageBox: async (...a) => { dialogs.push(a[a.length - 1]); return { response: 0 }; } };
const explode = { showMessageBox: async () => { throw new Error('no display'); } };

function register(kind) {
  confirm.registerExecutor(kind, {
    summarize: (p) => ({ headline: 'Do ' + kind + ' to ' + (p.to ? p.to.length : 0) + ' people (' + ((p.cc || []).length) + ' in CC)', detailText: 'To: ' + (p.to || []).join(', ') + '\nCC: ' + (p.cc || []).join(', ') }),
    run: async (p) => { ran.push({ kind, p }); return { ok: true, did: kind }; },
  });
}

beforeEach(() => {
  confirm._resetForTests();
  ran = []; dialogs.length = 0;
  for (const k of confirm.KINDS) register(k);
});

describe('R5.7 prepare / confirm token mechanics', () => {
  it('prepare returns a 16-byte hex token, a main-process summary, and a 5 minute expiry', () => {
    const r = confirm.prepare('send-reply', { to: ['a@example.test'], cc: ['c@example.test', 'd@example.test'], bodyText: 'hi' }, { now: T0 });
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(TOKEN_RE);
    expect(r.expiresAt).toBe(T0 + 5 * 60_000);
    expect(r.summary.headline).toBe('Do send-reply to 1 people (2 in CC)');
    expect(r.summary.payloadHash).toMatch(/^[0-9a-f]{12}$/);
    expect(r.summary.kind).toBe('send-reply');
    expect(ran).toEqual([]);   // preparing never executes
  });

  it('R5.6 summary lists CC recipients so the user can see them before sending', () => {
    const r = confirm.prepare('send-reply', { to: ['to@example.test'], cc: ['cc1@example.test', 'cc2@example.test'] });
    expect(r.summary.detailText).toContain('CC: cc1@example.test, cc2@example.test');
  });

  it('rejects unknown kinds, non-object payloads, and kinds without an executor', () => {
    expect(confirm.prepare('format-disk', {})).toEqual({ ok: false, code: 'BAD_KIND' });
    expect(confirm.prepare('send-reply', 'x')).toEqual({ ok: false, code: 'BAD_ARG', field: 'payload' });
    expect(confirm.prepare('send-reply', [1])).toEqual({ ok: false, code: 'BAD_ARG', field: 'payload' });
    confirm._resetForTests();
    expect(confirm.prepare('send-reply', {})).toEqual({ ok: false, code: 'KIND_UNAVAILABLE' });
  });

  it('single use: the second confirm of the same token is TOKEN_USED and the executor ran once', async () => {
    const { token } = confirm.prepare('reject-staged', { stagedId: 'st_1' }, { now: T0 });
    expect(await confirm.confirm(token, { now: T0 + 1000 })).toEqual({ ok: true, did: 'reject-staged' });
    expect(await confirm.confirm(token, { now: T0 + 2000 })).toEqual({ ok: false, code: 'TOKEN_USED' });
    expect(ran).toHaveLength(1);
  });

  it('TTL: a token older than 5 minutes is TOKEN_EXPIRED, runs nothing, and is consumed', async () => {
    const a = confirm.prepare('reject-staged', { stagedId: 'a' }, { now: T0 });
    expect(await confirm.confirm(a.token, { now: T0 + C.CONFIRM_TTL_MS + 1 })).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
    expect(await confirm.confirm(a.token, { now: T0 + 10 })).toEqual({ ok: false, code: 'TOKEN_USED' });
    const b = confirm.prepare('reject-staged', { stagedId: 'b' }, { now: T0 });
    expect((await confirm.confirm(b.token, { now: T0 + C.CONFIRM_TTL_MS - 1 })).ok).toBe(true);
    expect(ran.map((r) => r.p.stagedId)).toEqual(['b']);
  });

  it('a token that expired before the next prepare is still reported as expired', async () => {
    const a = confirm.prepare('reject-staged', { stagedId: 'a' }, { now: T0 });
    confirm.prepare('reject-staged', { stagedId: 'b' }, { now: T0 + C.CONFIRM_TTL_MS + 5 });   // purges a
    expect(await confirm.confirm(a.token, { now: T0 + C.CONFIRM_TTL_MS + 6 })).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('unknown, malformed and non-string tokens are TOKEN_UNKNOWN and never execute', async () => {
    for (const bad of ['0'.repeat(32), 'xyz', '', null, undefined, 42, {}, 'A'.repeat(32)]) {
      expect(await confirm.confirm(bad, { _dialog: accept })).toEqual({ ok: false, code: 'TOKEN_UNKNOWN' });
    }
    expect(ran).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  it('payload binding: the executor receives the prepared payload even if the caller mutates it afterwards', async () => {
    const payload = { stagedId: 'st_1', note: 'original' };
    const { token } = confirm.prepare('reject-staged', payload);
    payload.note = 'tampered'; payload.extra = true;
    await confirm.confirm(token);
    expect(ran[0].p).toEqual({ stagedId: 'st_1', note: 'original' });
  });

  it('payload binding: a caller-supplied payloadHash must match; a mismatch consumes the token and runs nothing', async () => {
    const r = confirm.prepare('reject-staged', { stagedId: 'st_1' });
    expect(await confirm.confirm(r.token, { payloadHash: 'f'.repeat(12) })).toEqual({ ok: false, code: 'PAYLOAD_MISMATCH' });
    expect(await confirm.confirm(r.token)).toEqual({ ok: false, code: 'TOKEN_USED' });
    const ok = confirm.prepare('reject-staged', { stagedId: 'st_2' });
    expect((await confirm.confirm(ok.token, { payloadHash: ok.summary.payloadHash })).ok).toBe(true);
    // key order does not matter for the binding
    expect(confirm.payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(confirm.payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(confirm.payloadHash({ a: 1 })).not.toBe(confirm.payloadHash({ a: 2 }));
  });

  it('at most 50 live tokens: the oldest is dropped', async () => {
    const first = confirm.prepare('reject-staged', { n: 0 }, { now: T0 });
    for (let i = 1; i <= 50; i++) confirm.prepare('reject-staged', { n: i }, { now: T0 });
    expect(confirm._liveCount()).toBe(C.CONFIRM_MAX_LIVE_TOKENS);
    expect(await confirm.confirm(first.token, { now: T0 })).toEqual({ ok: false, code: 'TOKEN_UNKNOWN' });
  });

  it('an executor that throws returns EXECUTOR_FAILED (no error text) and the token is consumed', async () => {
    confirm.registerExecutor('reject-staged', { run: async () => { throw new Error('boom jane@corp.test'); } });
    const { token } = confirm.prepare('reject-staged', { stagedId: 'x' });
    expect(await confirm.confirm(token)).toEqual({ ok: false, code: 'EXECUTOR_FAILED' });
    expect(await confirm.confirm(token)).toEqual({ ok: false, code: 'TOKEN_USED' });
  });
});

describe('F-18 native human proof for consequential kinds', () => {
  const CONSEQ = ['send-reply', 'delete', 'delete-batch', 'approve-staged', 'mark-send-resolution', 'send-ready-dm'];

  it('the consequential set is exactly the six kinds; reject-staged is local', () => {
    expect([...confirm.CONSEQUENTIAL]).toEqual(CONSEQ);
    expect(confirm.KINDS).toContain('reject-staged');
    expect(confirm.CONSEQUENTIAL).not.toContain('reject-staged');
  });

  for (const kind of CONSEQ) {
    it('R7.5 ' + kind + ': a token alone does not execute; an accepted native dialog does', async () => {
      const { token } = confirm.prepare(kind, { to: ['a@example.test'], cc: [] });
      // no dialog available in plain node -> fail closed
      expect(await confirm.confirm(token)).toEqual({ ok: false, code: 'DIALOG_UNAVAILABLE' });
      expect(ran).toEqual([]);
      const again = confirm.prepare(kind, { to: ['a@example.test'], cc: [] });
      expect((await confirm.confirm(again.token, { _dialog: accept })).ok).toBe(true);
      expect(ran.map((r) => r.kind)).toEqual([kind]);
    });
  }

  it('F-18 confirm without dialog acceptance does not execute', async () => {
    const { token } = confirm.prepare('send-reply', { to: ['a@example.test'] });
    expect(await confirm.confirm(token, { _dialog: { showMessageBox: async () => ({ response: 0 }) } })).toEqual({ ok: false, code: 'USER_CANCELLED' });
    const t2 = confirm.prepare('send-reply', { to: ['a@example.test'] });
    expect(await confirm.confirm(t2.token, { _dialog: { showMessageBox: async () => undefined } })).toEqual({ ok: false, code: 'USER_CANCELLED' });
    const t3 = confirm.prepare('send-reply', { to: ['a@example.test'] });
    expect(await confirm.confirm(t3.token, { _dialog: explode })).toEqual({ ok: false, code: 'DIALOG_FAILED' });
    expect(ran).toEqual([]);
  });

  it('F-18 cancelled dialog consumes the token (a later accepting dialog cannot reuse it)', async () => {
    const { token } = confirm.prepare('delete', { conversationKey: 'cv_0123456789abcdef' });
    expect(await confirm.confirm(token, { _dialog: cancel })).toEqual({ ok: false, code: 'USER_CANCELLED' });
    expect(await confirm.confirm(token, { _dialog: accept })).toEqual({ ok: false, code: 'TOKEN_USED' });
    expect(ran).toEqual([]);
  });

  it('the native dialog is built in the main process from the summary (modal warning, Cancel is default)', async () => {
    const { token } = confirm.prepare('send-reply', { to: ['a@example.test', 'b@example.test'], cc: ['c@example.test'] });
    await confirm.confirm(token, { _dialog: accept });
    const box = dialogs[0];
    expect(box).toMatchObject({ type: 'warning', title: 'Send reply', message: 'Do send-reply to 2 people (1 in CC)', buttons: ['Cancel', 'Send'], defaultId: 0, cancelId: 0, noLink: true });
    expect(box.detail).toContain('CC: c@example.test');
    expect(box.detail.length).toBeLessThanOrEqual(C.CONFIRM_DETAIL_MAX_CHARS);
  });

  it('detail text is control-stripped and capped at 2,000 chars; cleanLabel caps names at 60', async () => {
    confirm.registerExecutor('delete', { summarize: () => ({ headline: 'Delete\u0007 it', detailText: 'x'.repeat(5000) + '\u202e' }), run: async () => ({ ok: true }) });
    const { token, summary } = confirm.prepare('delete', { conversationKey: 'cv_0123456789abcdef' });
    expect(summary.detailText.length).toBe(C.CONFIRM_DETAIL_MAX_CHARS);
    expect(summary.headline).toBe('Delete it');
    await confirm.confirm(token, { _dialog: accept });
    expect(dialogs[0].detail).not.toMatch(/[\u202e\u0007]/);
    const label = confirm.cleanLabel('A'.repeat(100) + '\n\t\u0000B');
    expect(label.length).toBe(60);
    expect(confirm.cleanLabel('  Mike\u202e  Rivera ')).toBe('Mike Rivera');
  });

  it('reject-staged needs no dialog (local decision) but still needs a token', async () => {
    const { token } = confirm.prepare('reject-staged', { stagedId: 'st_9' });
    expect(await confirm.confirm(token)).toEqual({ ok: true, did: 'reject-staged' });
    expect(dialogs).toEqual([]);
  });

  it('the dialog is parented to the sender window when one can be resolved', async () => {
    const electron = require('electron');
    const orig = typeof electron === 'object' ? electron.BrowserWindow : undefined;
    const parent = { id: 'win' };
    const seen = [];
    const dlg = { showMessageBox: async (...a) => { seen.push(a); return { response: 1 }; } };
    if (typeof electron === 'object') electron.BrowserWindow = { fromWebContents: (wc) => (wc === 'WC' ? parent : null) };
    try {
      const { token } = confirm.prepare('send-reply', { to: ['a@example.test'] });
      await confirm.confirm(token, { _dialog: dlg, event: { sender: 'WC' } });
      if (typeof electron === 'object') { expect(seen[0][0]).toBe(parent); expect(seen[0]).toHaveLength(2); }
      else { expect(seen[0]).toHaveLength(1); }   // plain node: electron is a path string, no parent
    } finally { if (typeof electron === 'object') electron.BrowserWindow = orig; }
  });
});
