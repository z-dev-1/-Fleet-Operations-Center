// tests/unit-detail-relay-comment-draft-dom.test.js
// Unit detail → Repair tab "Draft with AI" next to the Relay compose box. Runs the real
// unit-detail.js helpers against fake DOM elements (no jsdom in this repo) with the bridge
// mocked: the button renders only with an open Relay WR, a draft only FILLS the textarea
// (never sends), the text stays editable, and Send is still the only path out (with
// aiDrafted:true when the text came from a draft), so a denied approval sends nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: toast }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const UNIT = {
  workRequestId: WR, equipmentId: 'B62020', vendor: 'Cox', repairTimeline: '11/13 - FAS called Cox',
  fullConversation: 'Conversation\n11/12 - Cox Service: waiting on turbo', relayFacts: { parts: [] }, daysDown: 5,
};
const DRAFT = 'FAS called Cox on 11/13.';
const flush = () => new Promise((r) => setImmediate(r));

function el() {
  return {
    value: '', disabled: false, readOnly: false, textContent: '', innerHTML: '', attrs: {}, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: this }))); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    focus() {},
  };
}
function mkRoot() {
  const map = {
    '#dp-relay-comment-text': el(),
    '#dp-relay-comment-send': el(),
    '#dp-relay-comment-draft': el(),
    '#dp-relay-comment-count': el(),
    '#dp-relay-comment-status': el(),
  };
  return { map, txt: map['#dp-relay-comment-text'], btn: map['#dp-relay-comment-send'], dbtn: map['#dp-relay-comment-draft'],
    cnt: map['#dp-relay-comment-count'], st: map['#dp-relay-comment-status'], root: { querySelector: (s) => map[s] || null } };
}
function type(d, v) { d.txt.value = v; return d.txt.fire('input'); }
const okDraft = (draft = DRAFT, extra = {}) => ({ ok: true, aiDrafted: true, draft, noUpdate: false, droppedCount: 0, dropped: [], ...extra });

beforeEach(() => {
  toast.show.mockClear();
  globalThis.window = {
    relayWrites: { addComment: vi.fn(async () => ({ ok: true, outcome: 'sent' })), draftComment: vi.fn(async () => okDraft()) },
    confirm: vi.fn(() => true),
  };
});

describe('render guard', () => {
  it('renders Draft with AI before Send for an open Relay WR', () => {
    const h = m.relayCommentComposeHtml(UNIT);
    expect(h).toContain('id="dp-relay-comment-draft"');
    expect(h).toContain('Draft with AI');
    expect(h.indexOf('id="dp-relay-comment-draft"')).toBeLessThan(h.indexOf('id="dp-relay-comment-send"'));
    expect(h).not.toMatch(/Decisiv|Volvo|PACCAR|DTNA/i);
  });
  it('has no Draft button without an open Relay WR (none, offsite-only, non-UUID, closed)', () => {
    const none = [
      {}, null,
      { savedOffsiteUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/V1', offsiteShopEventUrl: 'https://dtna.example/se/1', _offsiteWrId: '' },
      { workRequestId: '12345' },
      { workRequestId: WR, completed: '2026-11-01' },
      { workRequestId: WR, serviceState: 'Closed' },
    ];
    for (const u of none) expect(m.relayCommentComposeHtml(u)).toBe('');
  });
});

describe('Draft with AI fills the textarea and never sends', () => {
  it('calls draftComment once with string fields, shows a spinner, then inserts the draft', async () => {
    let resolve;
    window.relayWrites.draftComment = vi.fn(() => new Promise((r) => { resolve = r; }));
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    const p = d.dbtn.fire('click');
    await flush();
    expect(window.relayWrites.draftComment).toHaveBeenCalledTimes(1);
    const [wr, u] = window.relayWrites.draftComment.mock.calls[0];
    expect(wr).toBe(WR);
    expect(u).toMatchObject({ equipmentId: 'B62020', workRequestId: WR, vendor: 'Cox' });
    for (const v of Object.values(u)) expect(typeof v).toBe('string');
    expect(u.relayFacts).toBeUndefined();
    // Pending
    expect(d.dbtn.disabled).toBe(true);
    expect(d.dbtn.innerHTML).toContain('dp-ai-spinner');
    expect(d.dbtn.attrs['aria-busy']).toBe('true');
    expect(d.txt.readOnly).toBe(true);
    expect(d.btn.disabled).toBe(true);
    // (h) a second click while pending makes no second call
    await d.dbtn.fire('click');
    expect(window.relayWrites.draftComment).toHaveBeenCalledTimes(1);
    resolve(okDraft());
    await p;
    expect(d.txt.value).toBe(DRAFT);
    expect(d.txt.readOnly).toBe(false);
    expect(d.dbtn.disabled).toBe(false);
    expect(d.dbtn.innerHTML).toBe('Draft with AI');
    expect(d.dbtn.attrs['aria-busy']).toBeUndefined();
    expect(d.btn.disabled).toBe(false);
    expect(d.cnt.textContent).toBe(DRAFT.length + '/2000');
    expect(window.relayWrites.addComment).not.toHaveBeenCalled();
  });

  it('the draft is editable and Send carries the edited text with aiDrafted:true', async () => {
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await d.dbtn.fire('click');
    expect(window.relayWrites.addComment).not.toHaveBeenCalled();
    await type(d, DRAFT + ' Edited.');
    expect(d.txt.value).toBe(DRAFT + ' Edited.');
    expect(d.btn.disabled).toBe(false);
    await d.btn.fire('click');
    expect(window.relayWrites.addComment).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.addComment).toHaveBeenCalledWith(WR, DRAFT + ' Edited.', 'B62020', { aiDrafted: true });
  });

  it('manual text sends the 3-argument form; clearing a draft resets the AI origin', async () => {
    let d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await type(d, 'Manual note');
    await d.btn.fire('click');
    expect(window.relayWrites.addComment.mock.calls[0]).toEqual([WR, 'Manual note', 'B62020']);
    d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await d.dbtn.fire('click');
    await type(d, '');
    await type(d, 'Typed by me');
    await d.btn.fire('click');
    expect(window.relayWrites.addComment.mock.calls[1]).toEqual([WR, 'Typed by me', 'B62020']);
  });

  it('denied approval: Not sent, draft kept, no other send', async () => {
    window.relayWrites.addComment = vi.fn(async () => ({ ok: false, outcome: 'skipped-not-approved' }));
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await d.dbtn.fire('click');
    await d.btn.fire('click');
    expect(d.st.textContent).toBe('Not sent.');
    expect(d.txt.value).toBe(DRAFT);
    expect(window.relayWrites.draftComment).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.addComment).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.addComment.mock.calls[0][3]).toEqual({ aiDrafted: true });
  });

  it('noUpdate, all lines dropped, failure and a missing bridge leave the textarea unchanged', async () => {
    const cases = [
      [{ ok: true, aiDrafted: true, draft: '', noUpdate: true, droppedCount: 0, dropped: [] }, /nothing new/],
      [{ ok: true, aiDrafted: true, draft: '', noUpdate: false, droppedCount: 2, dropped: [] }, /2 line/],
      [{ ok: false, code: 'ai-failed' }, /AI draft failed/],
    ];
    for (const [res, re] of cases) {
      toast.show.mockClear();
      window.relayWrites.draftComment = vi.fn(async () => res);
      const d = mkRoot();
      m.wireRelayComment(d.root, UNIT);
      await d.dbtn.fire('click');
      expect(d.txt.value).toBe('');
      expect(d.st.textContent).toMatch(re);
      expect(toast.show).toHaveBeenCalledTimes(1);
      if (!res.ok) expect(toast.show.mock.calls[0][0]).toBe('error');
    }
    window.relayWrites.draftComment = vi.fn(async () => okDraft(DRAFT, { droppedCount: 1 }));
    let d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await d.dbtn.fire('click');
    expect(d.st.textContent).toContain('Removed 1 line(s)');
    globalThis.window = { confirm: () => true };
    d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await expect(d.dbtn.fire('click')).resolves.toBeDefined();
    expect(d.st.textContent).toContain('bridge unavailable');
    expect(d.txt.readOnly).toBe(false);
  });

  it('asks before replacing user text; cancel makes no AI call', async () => {
    window.confirm = vi.fn(() => false);
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await type(d, 'My own note');
    await d.dbtn.fire('click');
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.draftComment).not.toHaveBeenCalled();
    expect(d.txt.value).toBe('My own note');
    window.confirm = vi.fn(() => true);
    await d.dbtn.fire('click');
    expect(d.txt.value).toBe(DRAFT);
    // Re-drafting an unedited draft does not ask again.
    window.confirm = vi.fn(() => false);
    await d.dbtn.fire('click');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(window.relayWrites.draftComment).toHaveBeenCalledTimes(2);
  });

  it('the draft path never calls addComment', async () => {
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    for (let i = 0; i < 3; i++) await d.dbtn.fire('click');
    expect(window.relayWrites.draftComment).toHaveBeenCalledTimes(3);
    expect(window.relayWrites.addComment).not.toHaveBeenCalled();
  });
});
