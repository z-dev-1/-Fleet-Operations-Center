// tests/email-api-reply-recipients-overlay.test.js — renderer side of the "To (0): none" fix: the reply panel shows
// "Resolving recipients…" with Send off, then the resolved To (N) / CC (N); an unresolvable email shows a clear
// alert and keeps Send off; flag-off HTML is unchanged. Node + the tiny fake DOM; no jsdom, no network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __test__ as O } from '../renderer/src/js/components/email-triage-overlay.js';
import * as P from '../renderer/src/js/components/email-intel-panels.js';
import bus from '../renderer/src/js/bus.js';
import { createFakeDom } from './fixtures/email-intel/fake-dom.js';

const CK = 'cv_0123456789abcdef';
const EM = () => ({ id: 'em_1', from: 'Shop Desk', fromName: 'Shop Desk', subject: 'Unit 40123', replyState: 'drafted', replyDraft: 'Thanks, on it.', intel: { conversationKey: CK, recipientsKnown: false } });
const FLAGS_API = { capture: true, threadReplies: true, apiTransport: true };
const SHOP = { name: 'Shop Desk', address: 'shop@example.test', role: 'sender' };
const BOSS = { name: 'Boss Lead', address: 'boss@example.test', role: 'cc' };
const OTHER = { name: 'Other Tech', address: 'other@example.test', role: 'to' };

function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }
let dom; let body; let toasts; let off;
beforeEach(() => {
  toasts = [];
  off = bus.on('ui:toast', (d) => toasts.push(d.message));
  dom = createFakeDom();
  body = dom.add('et-body');
  dom.add('et-meta');
  dom.document.querySelector = (sel) => (String(sel).startsWith('textarea') ? { value: 'Thanks, on it.', scrollIntoView() {}, focus() {} } : null);
  globalThis.document = dom.document;
  globalThis.CSS = { escape: (s) => s };
  O._setIntelForTests({ ok: true, enabled: true, flags: FLAGS_API });
  O._setResultsForTests({ emails: [EM()] });
});
afterEach(() => {
  off(); vi.useRealTimers();
  O._setReplyUiForTests('em_1', null); O._setIntelForTests(null); O._setResultsForTests(null);
  delete globalThis.window; delete globalThis.document; delete globalThis.CSS; delete globalThis.confirm;
});
const sendBtn = (html, mode) => new RegExp('data-ei-send="' + mode + '" data-ei-id="em_1"( disabled aria-disabled="true"[^>]*)?>').exec(html)[1] ? 'disabled' : 'enabled';

describe('reply recipient display after the API resolve', () => {
  it('shows "Resolving recipients…" with both Send buttons off, then the resolved To (1) and CC (0)', async () => {
    const d = deferred();
    globalThis.window = { emailIntel: { resolveReplyRecipients: vi.fn(() => d.p), prepareAction: vi.fn() } };
    const done = O._intelResolve('em_1', 'reply');
    expect(body.innerHTML).toContain('Resolving recipients…');
    expect(body.innerHTML).toContain('role="status" aria-live="polite"');
    expect(body.innerHTML).not.toContain('To (0)');
    expect(sendBtn(body.innerHTML, 'reply')).toBe('disabled');
    expect(sendBtn(body.innerHTML, 'reply-all')).toBe('disabled');
    d.resolve({ ok: true, mode: 'reply', source: 'api', basedOnMessageKey: 'mi_x', recipients: { to: [SHOP], cc: [], external: 0, blocked: null }, replyAllAvailable: true, sendable: true });
    await done;
    expect(window.emailIntel.resolveReplyRecipients).toHaveBeenCalledWith({ conversationKey: CK, mode: 'reply' });
    expect(body.innerHTML).not.toContain('Resolving recipients…');
    expect(body.innerHTML).toContain('<b>To (1):</b> Shop Desk &lt;shop@example.test&gt;');
    expect(body.innerHTML).toContain('<b>CC (0):</b> none');
    expect(sendBtn(body.innerHTML, 'reply')).toBe('enabled');
    expect(sendBtn(body.innerHTML, 'reply-all')).toBe('enabled');
  });

  it('Reply All resolved: To (2) and the highlighted CC (1)', async () => {
    globalThis.window = { emailIntel: { resolveReplyRecipients: vi.fn(async () => ({ ok: true, mode: 'reply-all', source: 'api', basedOnMessageKey: 'mi_x', recipients: { to: [SHOP, OTHER], cc: [BOSS], external: 0, blocked: null }, replyAllAvailable: true, sendable: true })) } };
    await O._intelResolve('em_1', 'reply-all');
    expect(body.innerHTML).toContain('<b>To (2):</b> Shop Desk &lt;shop@example.test&gt;; Other Tech &lt;other@example.test&gt;');
    expect(body.innerHTML).toContain('<div class="ei-cc" role="note"><b>CC (1) - check these people:</b> Boss Lead &lt;boss@example.test&gt;</div>');
    expect(body.innerHTML).not.toContain('CC (0)');
  });

  it('unresolvable: a clear alert, both Send buttons off, and prepare is never called', async () => {
    const prepareAction = vi.fn();
    globalThis.window = { emailIntel: { resolveReplyRecipients: vi.fn(async () => ({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'not-found', sendable: false, replyAllAvailable: false, recipients: { to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' } })), prepareAction } };
    await O._intelResolve('em_1', 'reply');
    expect(body.innerHTML).toContain('<div class="ei-warn ei-rcpt-unresolved" role="alert">' + P.esc(P.UNRESOLVED_TEXT['not-found']) + '</div>');
    expect(body.innerHTML).not.toContain('To (0)');
    expect(sendBtn(body.innerHTML, 'reply')).toBe('disabled');
    expect(sendBtn(body.innerHTML, 'reply-all')).toBe('disabled');
    await O._intelPrepareSend('em_1', 'reply');
    await O._intelPrepareSend('em_1', 'reply-all');
    expect(prepareAction).not.toHaveBeenCalled();
    expect(toasts[toasts.length - 1]).toBe(P.UNRESOLVED_TEXT['not-found']);
  });

  it('a drafted card from an earlier session resolves once on render, then shows the resolved To', async () => {
    vi.useFakeTimers();
    const resolveReplyRecipients = vi.fn(async () => ({ ok: true, mode: 'reply', source: 'api', basedOnMessageKey: 'mi_x', recipients: { to: [SHOP], cc: [], external: 0, blocked: null }, replyAllAvailable: false, sendable: true }));
    globalThis.window = { emailIntel: { resolveReplyRecipients } };
    O._render();
    expect(body.innerHTML).toContain('Resolving recipients…');
    O._render();                                                         // a second render does not schedule again
    await vi.runAllTimersAsync();
    expect(resolveReplyRecipients).toHaveBeenCalledTimes(1);
    expect(body.innerHTML).toContain('<b>To (1):</b> Shop Desk &lt;shop@example.test&gt;');
    expect(sendBtn(body.innerHTML, 'reply')).toBe('enabled');
    expect(sendBtn(body.innerHTML, 'reply-all')).toBe('disabled');       // replyAllAvailable:false
  });

  it('_intelDraft maps recipientsSource / sendable / unresolved into the panel; Re-draft shows resolving first', async () => {
    const d = deferred();
    const draftThreadReply = vi.fn(() => d.p);
    globalThis.window = { emailIntel: { draftThreadReply } };
    O._setReplyUiForTests('em_1', { mode: 'reply', recipients: { to: [SHOP], cc: [] }, source: 'api' });
    const done = O._intelDraft('em_1', 'reply', false);
    expect(body.innerHTML).toContain('Resolving recipients…');
    expect(sendBtn(body.innerHTML, 'reply')).toBe('disabled');
    d.resolve({ ok: true, draft: 'Hi', mode: 'reply', aiUnavailable: false, warnings: [], basedOnMessageKey: 'md_x', recipients: { to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' },
      replyAllAvailable: false, recipientsSource: null, sendable: false, unresolved: { reason: 'blocked-auth' } });
    await done;
    expect(body.innerHTML).toContain(P.esc(P.UNRESOLVED_TEXT['blocked-auth']));
    expect(sendBtn(body.innerHTML, 'reply')).toBe('disabled');
    expect(O._replyUi('em_1')).toMatchObject({ source: 'none', sendBlocked: true, unresolved: { reason: 'blocked-auth' }, resolving: false });
    draftThreadReply.mockImplementation(async () => ({ ok: true, draft: 'Hi', mode: 'reply', aiUnavailable: false, warnings: [], basedOnMessageKey: 'mi_x', recipients: { to: [SHOP], cc: [], external: 0, blocked: null },
      replyAllAvailable: true, recipientsSource: 'api', sendable: true }));
    await O._intelDraft('em_1', 'reply', false);
    expect(body.innerHTML).toContain('<b>To (1):</b> Shop Desk &lt;shop@example.test&gt;');
    expect(body.innerHTML).toContain('<b>CC (0):</b> none');
    expect(sendBtn(body.innerHTML, 'reply')).toBe('enabled');
  });

  it('a resolve still in flight never overwrites a newer draft result', async () => {
    const d = deferred();
    globalThis.window = { emailIntel: { resolveReplyRecipients: vi.fn(() => d.p), draftThreadReply: vi.fn(async () => ({ ok: true, draft: 'Hi', mode: 'reply-all', aiUnavailable: false, warnings: [], basedOnMessageKey: 'mi_x',
      recipients: { to: [SHOP, OTHER], cc: [BOSS], external: 0, blocked: null }, replyAllAvailable: true, recipientsSource: 'api', sendable: true })) } };
    const pending = O._intelResolve('em_1', 'reply');
    await O._intelDraft('em_1', 'reply-all', false);
    d.resolve({ ok: false, code: 'RECIPIENTS_UNRESOLVED', reason: 'unavailable', recipients: { to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' } });
    await pending;
    expect(body.innerHTML).toContain('<b>To (2):</b>');
    expect(body.innerHTML).not.toContain('role="alert"');
  });
});

describe('flag-off parity', () => {
  it('without apiTransport: the panel HTML is today\'s, nothing is resolved, and renderRecipientsHtml has no CC (0) line', async () => {
    vi.useFakeTimers();
    const resolveReplyRecipients = vi.fn();
    globalThis.window = { emailIntel: { resolveReplyRecipients } };
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, threadReplies: true } });
    const em = EM();
    expect(O._replyPanelHtml(em)).toBe(P.renderReplyPanelHtml(em, undefined));
    O._render();
    await vi.runAllTimersAsync();
    expect(resolveReplyRecipients).not.toHaveBeenCalled();
    expect(O._replyUi('em_1')).toBeUndefined();
    await O._intelResolve('em_1', 'reply');
    expect(resolveReplyRecipients).not.toHaveBeenCalled();
    const r = { to: [SHOP], cc: [] };
    expect(P.renderRecipientsHtml(r)).toBe('<div class="ei-rcpt"><div class="ei-rcpt-to"><b>To (1):</b> Shop Desk &lt;shop@example.test&gt;</div></div>');
    // the draft-time ui of today (no API fields) renders exactly as before
    const ui = { mode: 'reply', recipients: { to: [SHOP], cc: [], external: 0, blocked: null }, warnings: [], stale: false, replyAllAvailable: true, basedOnMessageKey: 'mi_x' };
    const html = P.renderReplyPanelHtml(em, ui);
    expect(html).not.toContain('CC (0)');
    expect(html).not.toContain('Resolving');
    expect(sendBtn(html, 'reply')).toBe('enabled');
  });
});
