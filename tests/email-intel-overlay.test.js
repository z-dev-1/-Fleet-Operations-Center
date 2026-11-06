// tests/email-intel-overlay.test.js — overlay reply rendering (F-09, R5.5, R5.6, R5.8) through the test-only __test__
// export (F2-02) and the pure reply builders in email-intel-panels.js. No DOM: the functions return HTML strings.
import { describe, it, expect, afterEach } from 'vitest';
import { __test__ as O } from '../renderer/src/js/components/email-triage-overlay.js';
import * as P from '../renderer/src/js/components/email-intel-panels.js';

const UNCERTAIN_SPAN = '<span class="et-uncertain" role="status">Reply status uncertain - check Outlook</span>';
const STATUS_ON = { ok: true, enabled: true, flags: { capture: true, multiRecipient: true, actionsView: true, threadReplies: true } };
const rec = (o = {}) => Object.assign({
  id: 'em_o1', from: 'parts@dealer.example.test', fromName: 'Dealer Parts Desk', subject: 'Pickup 40123', summary: 's', importance: 'normal', unitRefs: [],
  replyState: 'none', replyDraft: '', intel: { conversationKey: 'cv_00000000000000f1', recipientsKnown: true, latestMessageKey: 'mi_1' },
}, o);

afterEach(() => { O._setIntelForTests(null); O._setReplyUiForTests('em_o1', null); });

describe('F-09 uncertain reply state', () => {
  it('F-09 uncertain replyState renders no Reply button (flags OFF and ON)', () => {
    for (const on of [false, true]) {
      O._setIntelForTests(on ? STATUS_ON : null);
      const em = rec({ replyState: 'uncertain', replyDraft: 'sent text' });
      const btn = O._replyButtonHtml(em);
      expect(btn.startsWith(UNCERTAIN_SPAN), String(on)).toBe(true);
      const card = O._cardHtml(em);
      for (const html of [btn, card]) {
        expect(html).not.toContain('data-reply=');
        expect(html).not.toContain('data-ei-reply=');
        expect(html).not.toContain('data-ei-send=');
        expect(html).not.toContain('Reply sent');
      }
      expect(O._replyPanelHtml(em)).toBe('');
      if (on) expect(btn).toContain('data-ei-reconcile="em_o1"');                        // the only action is Reconcile
      else expect(btn).toBe(UNCERTAIN_SPAN);
    }
  });

  it('flags OFF: an intel record still renders the legacy single Reply button and the legacy draft panel', () => {
    O._setIntelForTests(null);
    expect(O._replyButtonHtml(rec())).toMatch(/^<button class="et-mini et-reply-start" data-reply="em_o1">\S+ Reply<\/button>$/);
    const panel = O._replyPanelHtml(rec({ replyState: 'drafted', replyDraft: 'd' }));
    expect(panel).toContain('data-send="em_o1"');
    expect(panel).not.toContain('data-ei-send');
    // threadReplies not effective (status without the flag): legacy too
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, multiRecipient: true, actionsView: true } });
    expect(O._replyButtonHtml(rec())).toMatch(/^<button class="et-mini et-reply-start" data-reply="em_o1">\S+ Reply<\/button>$/);
  });
});

describe('threadReplies on: Reply and Reply All are separate intentional buttons (R5.5)', () => {
  it('two buttons; Reply All disabled with a text reason when recipients are unknown; legacy records keep the legacy button', () => {
    O._setIntelForTests(STATUS_ON);
    const b = O._replyButtonHtml(rec());
    expect(b).toContain('data-ei-reply="reply"');
    expect(b).toContain('data-ei-reply="reply-all"');
    expect(b).not.toContain('data-reply=');
    const unknown = O._replyButtonHtml(rec({ intel: { conversationKey: 'cv_00000000000000f1', recipientsKnown: false } }));
    expect(unknown).toMatch(/data-ei-reply="reply-all"[^>]* disabled aria-disabled="true" title="Reply All is unavailable: the recipients of this email are not known"/);
    expect(O._replyButtonHtml(rec({ intel: undefined }))).toMatch(/^<button class="et-mini et-reply-start" data-reply="em_o1">\S+ Reply<\/button>$/);
  });

  it('drafted: the intel panel shows the mode, the mechanism label, To and CC (CC highlighted and labeled), warnings and the stale-draft warning', () => {
    O._setIntelForTests(STATUS_ON);
    O._setReplyUiForTests('em_o1', {
      mode: 'reply-all', replyAllAvailable: true, stale: true, warnings: [{ code: 'amount', label: 'mentions a dollar amount' }],
      recipients: { to: [{ name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' }], cc: [{ name: 'Mike <Rivera>', address: 'mike.rivera@example.test' }], external: 1 },
    });
    const html = O._replyPanelHtml(rec({ replyState: 'drafted', replyDraft: 'Draft <b>text</b>' }));
    expect(html).toContain('Your Reply All draft');
    expect(html).toContain('<div class="ei-mech">Threaded reply in the Outlook conversation</div>');
    expect(html).toContain('<div class="ei-cc" role="note"><b>CC (1) - check these people:</b> Mike &lt;Rivera&gt; &lt;mike.rivera@example.test&gt;</div>');
    expect(html).toContain('External recipients: 1');
    expect(html).toContain(P.STALE_DRAFT_TEXT);
    expect(html).toContain('<li>The reply mentions a dollar amount</li>');
    expect(html).toContain('Draft &lt;b&gt;text&lt;/b&gt;');
    expect(html).toContain('data-ei-send="reply"');
    expect(html).toContain('data-ei-send="reply-all"');
    expect(html).not.toContain('data-ei-send="new-message"');
    expect(html).not.toContain('data-send=');                                             // the legacy send button is not offered
    O._setReplyUiForTests('em_o1', { mode: 'reply', fallback: true });
    const fb = O._replyPanelHtml(rec({ replyState: 'drafted' }));
    expect(fb).toContain('data-ei-send="new-message"');
    expect(fb).toContain('Send as ' + P.NOT_THREADED_LABEL);
  });

  it('R5.6 the in-app confirmation lists To and highlights CC; not-threaded sends carry the label', () => {
    const s = { headline: 'Send Reply All to 2 people (1 in CC)?', to: [{ name: 'Dealer', address: 'parts@dealer.example.test' }], cc: [{ name: 'Mike Rivera', address: 'mike.rivera@example.test' }], external: 0, warnings: [], notThreaded: false };
    const html = P.renderSendConfirmHtml(s);
    expect(html).toContain('Send Reply All to 2 people (1 in CC)?');
    expect(html).toContain('<b>To (1):</b> Dealer &lt;parts@dealer.example.test&gt;');
    expect(html).toContain('class="ei-cc"');
    expect(html).toContain('data-ei-confirm="1"');
    expect(html).toContain('A system dialog asks you once more');
    const nt = P.renderSendConfirmHtml(Object.assign({}, s, { notThreaded: true, cc: [] }));
    expect(nt).toContain(P.NOT_THREADED_LABEL + ': this is a new message');
    expect(nt).not.toContain('class="ei-cc"');
  });
});
