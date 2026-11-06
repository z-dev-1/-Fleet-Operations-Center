// tests/email-intel-reply-owa.test.js — the real-Outlook-thread reply through the message's own Reply control
// (design 6.4; R5.4, R5.6/AC-8, R5.9/F-11, F-21, case L delivery-uncertain). A fake `electron` answers the page
// scripts; the prepend script is executed against a tiny fake editor DOM. No real Outlook, no network.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const owaReply = require('../src/email-intel/reply/owa_reply');
const ps = require('../src/email-intel/reply/page-scripts');
const owaMailer = require('../src/scrapers/owa-mailer');

const INBOX = 'https://outlook.office365.com/mail/inbox';
const QUOTE_HTML = '<div id="divRplyFwdMsg"><b>From:</b> Dealer Parts Desk<br>Sent: Tuesday<br>Can you confirm pickup Friday for 40123?</div>';
const MARKER = 'FOC-00112233aabbccdd';
const BODY = 'Hi,\n\nFriday works for 40123.\n\nBest';
const HTML = owaMailer.embedMarker('<div style="white-space:pre-wrap">' + BODY + '</div>', MARKER);
const EXPECTED = { to: [{ name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' }], cc: [] };

/** Fake editor DOM for the prepend script: innerText strips tags and display:none spans (like a browser). */
function fakeEditor(initial, mode = 'good') {
  const ed = {
    html: initial, events: [],
    get innerHTML() { return this.html; },
    get innerText() { return this.html.replace(/<span style="display:none[^"]*">[\s\S]*?<\/span>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').trim(); },
    focus() {}, dispatchEvent(e) { this.events.push(e.type); return true; },
    insertAdjacentHTML(pos, h) { if (pos === 'afterbegin') this.html = h + this.html; },
  };
  const doc = {
    querySelector: () => ed,
    createRange: () => ({ setStart(node, off) { this.node = node; this.off = off; }, collapse() {} }),
    execCommand(cmd, _ui, h) {
      if (cmd !== 'insertHTML') return false;
      if (mode === 'good') { ed.html = h + ed.html; return true; }
      if (mode === 'clobber') { ed.html = h; return true; }                     // what a select-all insert would do
      return false;                                                              // 'refuse': execCommand unsupported
    },
  };
  const win = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  function Ev(type) { this.type = type; }
  const run = (script) => JSON.parse(new Function('document', 'window', 'Event', 'return ' + script)(doc, win, Ev));
  return { ed, run };
}

/** Fake electron for openSession + the reply steps. */
function world(o = {}) {
  const w = {
    url: INBOX, log: [], sendClicks: 0, hooks: [], buttons: o.buttons || ['Reply', 'Reply all', 'Forward'],
    recipients: o.recipients || { to: [{ title: 'Dealer Parts Desk <parts@dealer.example.test>', aria: '', text: '' }, { title: '', aria: '', text: 'Dealer Parts Desk' }], cc: [], found: { to: true, cc: true } },
    editor: fakeEditor(QUOTE_HTML, o.editorMode || 'good'), probe: o.probe || 'enabled', click: o.click || { status: 'clicked', where: 'block' },
  };
  class WC {
    constructor() { this.l = {}; }
    on(ev, fn) { (this.l[ev] = this.l[ev] || []).push(fn); }
    emit(ev, ...a) { (this.l[ev] || []).forEach((fn) => fn(...a)); }
    setWindowOpenHandler() {}
    getURL() { return w.url; }
    async executeJavaScript(s) {
      if (this.win.destroyed) throw new Error('Object has been destroyed');
      if (s.includes('/*ei-reply:click*/')) { w.log.push('reply-click'); return JSON.stringify(w.click); }
      if (s.includes('/*ei-reply:recipients*/')) { w.log.push('recipients'); return JSON.stringify(w.recipients); }
      if (s.includes('/*ei-reply:prepend*/')) { w.log.push('prepend'); return JSON.stringify(w.editor.run(s)); }
      if (s.includes('clicked-keyboard')) { w.log.push('send-click'); w.sendClicks++; return 'clicked'; }
      if (s.includes("disabled ? 'disabled' : 'enabled'")) { w.log.push('send-probe'); return w.probe; }
      if (s.includes('status: "opened"')) { w.log.push('open-row'); return JSON.stringify({ status: 'opened' }); }
      if (s.includes('paneFallback')) { w.log.push('pane'); return JSON.stringify({ subject: 'Pickup 40123', blocks: [], buttons: w.buttons }); }
      w.log.push('other');
      return '';
    }
  }
  class BW {
    constructor() { this.destroyed = false; this.webContents = new WC(); this.webContents.win = this; w.win = this; }
    on() {} hide() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; w.log.push('close'); }
    loadURL(u) { w.log.push('load'); w.url = u; setTimeout(() => this.webContents.emit('did-finish-load'), 0); }
  }
  w.electron = { BrowserWindow: BW, session: { defaultSession: {} } };
  return w;
}

const run = (w, o = {}) => {
  const hook = o.hook || vi.fn(() => { w.log.push('persist-sending'); return true; });
  const verify = o.verify || vi.fn(async () => ({ found: true, matchedBy: 'marker', at: '2026-11-04T16:00:00.000Z' }));
  const p = owaReply.sendThreadReply({
    convId: 'conv/abc=', folder: 'Inbox', mode: o.mode || 'reply', expected: o.expected || EXPECTED, html: HTML, bodyText: BODY, marker: MARKER, subjectNorm: 're: pickup 40123',
    attemptHooks: { beforeSendClick: hook }, _electron: w.electron, _warm: o.warm || (async () => ({ ok: true })), _sleep: async () => {},
    _waitFor: o.waitFor || (async () => true), _verify: verify,
  });
  return { p, hook, verify };
};

describe('thread reply through the Outlook Reply control (R5.4)', () => {
  it('happy path: real Reply control, recipients verified, body prepended, attempt persisted before the click, Sent Items confirmed', async () => {
    const w = world();
    const { p, hook, verify } = run(w);
    const r = await p;
    expect(r).toMatchObject({ status: 'sent', mechanism: 'owa-thread', detail: { where: 'block', sentItemsMatch: { found: true, matchedBy: 'marker' } } });
    expect(w.log.filter((x) => x !== 'load' && x !== 'other')).toEqual(['open-row', 'pane', 'reply-click', 'recipients', 'prepend', 'send-probe', 'persist-sending', 'send-click', 'close']);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(w.sendClicks).toBe(1);
    expect(verify.mock.calls[0][1]).toEqual({ marker: MARKER, normSubject: 're: pickup 40123', recipients: ['parts@dealer.example.test'], timeoutMs: 75_000 });
  });

  it('R5.4 uses Reply control, preserves quoted body', async () => {
    const w = world();
    await run(w).p;
    expect(w.editor.ed.html.endsWith(QUOTE_HTML)).toBe(true);                              // OWA's quoted conversation is untouched
    expect(w.editor.ed.html.startsWith(HTML)).toBe(true);                                   // the reply sits above it
    expect(w.log).not.toContain('other');                                                   // no other script (no select-all insert, no compose deeplink)
  });

  it('R5.4 fallback labeled not threaded: no Reply control -> mechanism-unavailable before any compose opens', async () => {
    const w = world({ buttons: ['Forward', 'Reply all (Ctrl+Shift+R)'] });
    const { p, hook } = run(w);
    expect(await p).toMatchObject({ status: 'mechanism-unavailable', mechanism: 'owa-thread', detail: { code: 'NO_REPLY_CONTROL' } });
    expect(w.log).not.toContain('reply-click');
    expect(w.sendClicks).toBe(0);
    expect(hook).not.toHaveBeenCalled();
    // Reply all needs its own exact control
    const w2 = world({ buttons: ['Reply'] });
    expect((await run(w2, { mode: 'reply-all' }).p).status).toBe('mechanism-unavailable');
  });

  it('non-inline compose: no editor appears -> failed-before-send COMPOSE_NOT_INLINE, nothing typed', async () => {
    const w = world();
    const r = await run(w, { waitFor: async () => false }).p;
    expect(r).toMatchObject({ status: 'failed-before-send', detail: { code: 'COMPOSE_NOT_INLINE' } });
    expect(w.log).not.toContain('recipients');
    expect(w.log).not.toContain('prepend');
    expect(w.sendClicks).toBe(0);
  });

  it('auth wall: blocked-auth before any window or click', async () => {
    const w = world();
    const r = await run(w, { warm: async () => ({ authWall: true }) }).p;
    expect(r).toMatchObject({ status: 'blocked-auth', detail: { code: 'AUTH_WALL' } });
    expect(w.log).toEqual([]);
  });

  it('a disabled Send button or an attempt that could not be persisted never clicks', async () => {
    const w = world({ probe: 'disabled' });
    expect((await run(w).p)).toMatchObject({ status: 'failed-before-send', detail: { code: 'SEND_DISABLED' } });
    const w2 = world({ probe: 'no-btn' });
    expect((await run(w2).p).detail.code).toBe('SEND_NOT_FOUND');                           // no keyboard fallback on the reply path
    const w3 = world();
    expect((await run(w3, { hook: () => false }).p)).toMatchObject({ status: 'failed-before-send', detail: { code: 'ATTEMPT_NOT_PERSISTED' } });
    expect(w.sendClicks + w2.sendClicks + w3.sendClicks).toBe(0);
  });
});

describe('recipient verification (R5.6 / AC-8)', () => {
  it('R5.6/AC-8 recipient mismatch aborts before send', async () => {
    const w = world({ recipients: { to: [{ title: 'Dealer Parts Desk <parts@dealer.example.test>' }], cc: [{ title: 'Reply To Desk <replyto@dealer.example.test>' }], found: { to: true, cc: true } } });
    const { p, hook } = run(w);
    const r = await p;
    expect(r).toMatchObject({ status: 'recipient-mismatch', detail: { code: 'RECIPIENT_MISMATCH', diff: { missing: [], extra: [{ name: 'Reply To Desk', address: 'replyto@dealer.example.test', role: 'cc' }] } } });
    expect(w.log).not.toContain('prepend');                                                 // aborted BEFORE inserting text
    expect(w.log).not.toContain('send-probe');
    expect(w.sendClicks).toBe(0);
    expect(hook).not.toHaveBeenCalled();
    // a confirmed CC participant missing from the compose form is a mismatch too
    const w2 = world();
    const r2 = await run(w2, { mode: 'reply-all', expected: { to: EXPECTED.to, cc: [{ name: 'Mike Rivera', address: 'mike.rivera@example.test' }] } }).p;
    expect(r2.detail.diff.missing).toEqual([{ name: 'Mike Rivera', address: 'mike.rivera@example.test', role: 'cc' }]);
    expect(w2.sendClicks).toBe(0);
  });

  it('an unreadable To well fails closed', async () => {
    const w = world({ recipients: { to: [], cc: [], found: { to: false, cc: false } } });
    expect((await run(w).p)).toMatchObject({ status: 'failed-before-send', detail: { code: 'RECIPIENTS_UNREADABLE' } });
    expect(w.sendClicks).toBe(0);
  });
});

describe('quote-preserving prepend (R5.9 / F-11)', () => {
  it('F-11 prepend keeps quoted block', () => {
    const f = fakeEditor(QUOTE_HTML, 'good');
    const before = f.ed.innerText;
    const r = f.run(ps.buildPrependScript(HTML, { marker: MARKER }));
    expect(r).toMatchObject({ status: 'ok', via: 'insertHTML', markerFound: true });
    expect(r.quoteHash).toBe(r.afterQuoteHash);
    expect(r.quoteHash).toBe(ps.textHash(before));
    expect(ps.verifyPrepend(r, 10)).toEqual({ ok: true });
    expect(f.ed.html).toBe(HTML + QUOTE_HTML);
    expect(f.ed.events).toEqual(['input', 'change']);
    // execCommand unsupported: the afterbegin fallback also keeps the quote
    const g = fakeEditor(QUOTE_HTML, 'refuse');
    const r2 = g.run(ps.buildPrependScript(HTML, { marker: MARKER }));
    expect(r2).toMatchObject({ status: 'ok', via: 'afterbegin' });
    expect(ps.verifyPrepend(r2, 10)).toEqual({ ok: true });
    expect(g.ed.html.endsWith(QUOTE_HTML)).toBe(true);
  });

  it('F-11 changed quote hash aborts before send', async () => {
    const f = fakeEditor(QUOTE_HTML, 'clobber');
    const r = f.run(ps.buildPrependScript(HTML, { marker: MARKER }));
    expect(r.quoteHash).not.toBe(r.afterQuoteHash);
    expect(ps.verifyPrepend(r, 10)).toEqual({ ok: false, code: 'INSERT_UNVERIFIED', why: 'quote-changed' });
    const w = world({ editorMode: 'clobber' });
    const { p, hook } = run(w);
    expect(await p).toMatchObject({ status: 'failed-before-send', detail: { code: 'INSERT_UNVERIFIED', why: 'quote-changed' } });
    expect(w.sendClicks).toBe(0);
    expect(hook).not.toHaveBeenCalled();
    expect(w.log).toContain('close');                                                       // the compose window is discarded
    // other verification failures: too short, marker missing
    expect(ps.verifyPrepend({ status: 'ok', quoteHash: 'a', afterQuoteHash: 'a', added: 3, markerFound: true }, 10).why).toBe('too-short');
    expect(ps.verifyPrepend({ status: 'ok', quoteHash: 'a', afterQuoteHash: 'a', added: 30, markerFound: false }, 10).why).toBe('no-marker');
    expect(ps.verifyPrepend({ status: 'no-editor' }, 10).why).toBe('no-editor');
  });

  it('the prepend script never selects all, clears the editor or touches the clipboard', () => {
    const s = ps.buildPrependScript(HTML, { marker: MARKER });
    expect(s).not.toMatch(/selectNodeContents|selectAll|innerHTML\s*=|clipboard|execCommand\(\s*["']delete/);
    expect(s).toMatch(/range\.setStart\(ed, 0\); range\.collapse\(true\)/);
    for (const b of [ps.buildPrependScript(HTML, {}), ps.buildReplyControlClickScript('reply'), ps.buildReplyControlClickScript('reply-all'), ps.buildComposeRecipientsCollector()]) expect(() => new Function(b)).not.toThrow();
  });
});

describe('F-21 newest block control and the exact-label rule', () => {
  it("F-21 clicks the newest block's control", () => {
    const B = (labels, collapsed = false) => ({ labels, collapsed });
    expect(ps.pickReplyControl([B(['Reply', 'Reply all']), B(['Reply', 'Reply all'])], ['Reply'], 'reply')).toEqual({ where: 'block', block: 1, index: 0 });
    expect(ps.pickReplyControl([B(['Reply']), B(['Reply all', 'Reply'])], [], 'reply-all')).toEqual({ where: 'block', block: 1, index: 0 });
    // the newest EXPANDED block counts; collapsed later blocks are skipped
    expect(ps.pickReplyControl([B(['Reply']), B(['Reply']), B(['Reply'], true)], [], 'reply')).toEqual({ where: 'block', block: 1, index: 0 });
    // the newest block has no control: the reading-pane toolbar, never an older block
    expect(ps.pickReplyControl([B(['Reply']), B(['Forward'])], ['Reply all', 'Reply'], 'reply')).toEqual({ where: 'toolbar', index: 1 });
    expect(ps.pickReplyControl([B(['Reply']), B(['Forward'])], [], 'reply')).toBeNull();
    // the script embeds this exact choice function
    expect(ps.buildReplyControlClickScript('reply')).toContain('var pickReplyControl = function pickReplyControl(blocks, toolbar, mode)');
  });

  it("exact labels: 'Reply' never matches 'Reply all'", () => {
    expect(ps.exactLabel('Reply', 'reply')).toBe(true);
    expect(ps.exactLabel(' reply ', 'reply')).toBe(true);
    expect(ps.exactLabel('Reply all', 'reply')).toBe(false);
    expect(ps.exactLabel('Reply all', 'reply-all')).toBe(true);
    expect(ps.exactLabel('Reply', 'reply-all')).toBe(false);
    expect(ps.hasReplyControl(['Reply all', 'Forward'], 'reply')).toBe(false);
  });
});

describe('uncertain delivery (case L)', () => {
  it('a Send click without a Sent Items match is delivery-uncertain, never retried', async () => {
    const w = world();
    const { p, verify } = run(w, { verify: vi.fn(async () => ({ found: false })) });
    expect(await p).toMatchObject({ status: 'delivery-uncertain', detail: { code: 'NOT_IN_SENT_ITEMS' } });
    expect(w.sendClicks).toBe(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('the window failing after the click is delivery-uncertain, not failed or blocked-auth', async () => {
    const w = world();
    const r = await run(w, { verify: async () => { throw new Error('window gone'); } }).p;
    expect(r.status).toBe('delivery-uncertain');
    expect(w.sendClicks).toBe(1);
  });
});
