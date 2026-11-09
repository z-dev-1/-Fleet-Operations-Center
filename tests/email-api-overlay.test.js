// tests/email-api-overlay.test.js — renderer overlay under the Outlook API transport (design 11; AC-20):
// the reconcile control, the legacy Send result toast and the RECONCILE_* manual flows. Node + tiny globals only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __test__ as O } from '../renderer/src/js/components/email-triage-overlay.js';
import bus from '../renderer/src/js/bus.js';

const EM = { id: 'em_a1', from: 'shop@example.test', fromName: 'Shop', subject: 'Unit 40123', replyState: 'uncertain', replyDraft: 'Thanks', intel: { conversationKey: 'cv_0123456789abcdef', latestMessageKey: 'mi_x' } };
let toasts; let off; let prompts;
beforeEach(() => {
  toasts = []; prompts = [];
  off = bus.on('ui:toast', (d) => toasts.push(d.message));
  globalThis.CSS = { escape: (s) => s };
  globalThis.document = { querySelector: (sel) => (String(sel).startsWith('textarea') ? { value: 'Thanks, on it.' } : null), getElementById: () => null, querySelectorAll: () => [] };
});
afterEach(() => { off(); O._setIntelForTests(null); O._setResultsForTests(null); delete globalThis.window; delete globalThis.confirm; delete globalThis.document; delete globalThis.CSS; });
const answers = (...a) => { globalThis.confirm = vi.fn((msg) => { prompts.push(msg); return a.length ? a.shift() : false; }); };

describe('reconcile control', () => {
  it('AC-20 the reconcile control shows under apiTransport with threadReplies OFF; HTML unchanged when both are false', () => {
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true } });
    const base = O._replyButtonHtml(EM);
    expect(base).not.toContain('data-ei-reconcile');
    O._setIntelForTests(null);
    expect(O._replyButtonHtml(EM)).toBe(base);                                   // flags OFF: byte-identical
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, apiTransport: true } });
    expect(O._replyButtonHtml(EM)).toContain('data-ei-reconcile="em_a1"');
    expect(O._replyButtonHtml(Object.assign({}, EM, { intel: null }))).not.toContain('data-ei-reconcile');
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, apiTransport: false } });
    expect(O._replyButtonHtml(EM)).toBe(base);
  });
});

describe('legacy Send result', () => {
  it('an API delivery-uncertain result marks the row uncertain and toasts the text with no "Send failed:" prefix', async () => {
    O._setResultsForTests({ emails: [Object.assign({}, EM, { replyState: 'drafted' })] });
    answers(true);
    const text = 'Reply status uncertain - check Outlook and reconcile before retrying. It will not be sent again automatically.';
    globalThis.window = { emailTriage: { sendReply: vi.fn(async () => ({ ok: false, transport: 'api', status: 'delivery-uncertain', error: text })) } };
    await O._sendReply('em_a1');
    expect(toasts[toasts.length - 1]).toBe(text);
    expect(O._results().emails[0].replyState).toBe('uncertain');
    globalThis.window.emailTriage.sendReply = vi.fn(async () => ({ ok: false, transport: 'api', status: 'failed-before-send', error: 'Nothing was sent.' }));
    answers(true);
    await O._sendReply('em_a1');
    expect(toasts[toasts.length - 1]).toBe('Nothing was sent.');
  });

  it('without transport the toast is unchanged', async () => {
    O._setResultsForTests({ emails: [Object.assign({}, EM, { replyState: 'drafted' })] });
    answers(true);
    globalThis.window = { emailTriage: { sendReply: vi.fn(async () => ({ ok: false, error: 'OWA compose failed' })) } };
    await O._sendReply('em_a1');
    expect(toasts[toasts.length - 1]).toBe('Send failed: OWA compose failed');
    expect(O._results().emails[0].replyState).toBe('drafted');
  });
});

describe('reconcile flows', () => {
  function intel(reconcile, prepares) {
    const prep = prepares.slice();
    return {
      getSendAttempts: vi.fn(async () => ({ ok: true, attempts: [{ attemptId: 'sa_0123456789abcdef', state: 'delivery-uncertain' }] })),
      reconcileSend: vi.fn(async () => reconcile),
      prepareAction: vi.fn(async () => prep.shift()),
      confirmAction: vi.fn(async () => ({ ok: true, state: 'abandoned' })),
    };
  }

  it('AC-20 unavailable, inconclusive and in-progress reconcile flows', async () => {
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, apiTransport: true } });
    // RECONCILE_UNAVAILABLE: the manual flow with its own first prompt; "not sent" needs the override
    O._setResultsForTests({ emails: [Object.assign({}, EM)] });
    let api = intel({ ok: false, code: 'RECONCILE_UNAVAILABLE', state: 'delivery-uncertain' }, [{ ok: false, code: 'BAD_ARG', reason: 'reconcile-first' }, { ok: true, token: 't'.repeat(32) }]);
    globalThis.window = { emailIntel: api };
    answers(false, true, true);
    await O._intelReconcile('em_a1');
    expect(prompts[0]).toBe('This reply cannot be looked up in Sent Items automatically.\n\nCheck Outlook yourself. Did you find this reply in your Sent Items?\nOK = yes, mark it sent. Cancel = no.');
    expect(api.prepareAction.mock.calls.map((c) => c[1].override)).toEqual([undefined, true]);
    expect(api.confirmAction).toHaveBeenCalledTimes(1);
    expect(O._results().emails[0].replyState).toBe('drafted');
    // RECONCILE_INCONCLUSIVE: the "too many matching messages" prompt, mark sent
    prompts = [];
    O._setResultsForTests({ emails: [Object.assign({}, EM)] });
    api = intel({ ok: false, code: 'RECONCILE_INCONCLUSIVE', state: 'delivery-uncertain' }, [{ ok: true, token: 't'.repeat(32) }]);
    api.confirmAction = vi.fn(async () => ({ ok: true, state: 'sent' }));
    globalThis.window = { emailIntel: api };
    answers(true);
    await O._intelReconcile('em_a1');
    expect(prompts[0]).toBe('Sent Items has too many matching messages to check automatically.\n\nCheck Outlook yourself. Did you find this reply in your Sent Items?\nOK = yes, mark it sent. Cancel = no.');
    expect(api.prepareAction.mock.calls[0][1]).toMatchObject({ resolution: 'sent', acknowledgeCheckedOutlook: true });
    expect(O._results().emails[0].replyState).toBe('sent');
    // RECONCILE_IN_PROGRESS: a toast, nothing changes
    prompts = [];
    O._setResultsForTests({ emails: [Object.assign({}, EM)] });
    api = intel({ ok: false, code: 'RECONCILE_IN_PROGRESS', state: 'delivery-uncertain' }, []);
    globalThis.window = { emailIntel: api };
    answers();
    await O._intelReconcile('em_a1');
    expect(toasts[toasts.length - 1]).toBe('A Sent Items check for this reply is already running. Try again in a moment.');
    expect(prompts).toEqual([]);
    expect(api.prepareAction).not.toHaveBeenCalled();
    expect(O._results().emails[0].replyState).toBe('uncertain');
  });
});
