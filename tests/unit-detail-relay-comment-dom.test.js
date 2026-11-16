// tests/unit-detail-relay-comment-dom.test.js
// Unit detail → Repair tab "Add comment to Relay" compose control. Runs the real
// unit-detail.js helpers against fake DOM elements (no jsdom in this repo) with
// the bridge mocked: render guard, empty/over-limit disables Send, Send calls
// window.relayWrites.addComment(workRequestId, text, unit), and outcome mapping.
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
const UNIT = { workRequestId: WR, equipmentId: 'B62020' };
const flush = () => new Promise((r) => setImmediate(r));

function el() {
  return {
    value: '', disabled: false, textContent: '', listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: this }))); },
    classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    focus() {},
  };
}
function mkRoot() {
  const map = {
    '#dp-relay-comment-text': el(),
    '#dp-relay-comment-send': el(),
    '#dp-relay-comment-count': el(),
    '#dp-relay-comment-status': el(),
  };
  return { map, txt: map['#dp-relay-comment-text'], btn: map['#dp-relay-comment-send'], cnt: map['#dp-relay-comment-count'],
    st: map['#dp-relay-comment-status'], root: { querySelector: (s) => map[s] || null } };
}
function type(d, v) { d.txt.value = v; return d.txt.fire('input'); }

beforeEach(() => {
  toast.show.mockClear();
  globalThis.window = { relayWrites: { addComment: vi.fn(async () => ({ ok: true, outcome: 'sent' })) } };
});

describe('render guard', () => {
  it('renders for a unit with an open Relay WR id or serviceUrl', () => {
    for (const u of [UNIT, { serviceUrl: 'https://aap-na.corp.amazon.com/v2/service/' + WR, equipmentId: 'B1' }]) {
      const h = m.relayCommentComposeHtml(u);
      expect(h).toContain('id="dp-relay-comment-wrap"');
      expect(h).toContain('maxlength="2000"');
      expect(h).toContain('Send to Relay');
      expect(h).toContain('INTERNAL');
      expect(h).toContain('approve');
      expect(h).toMatch(/<button[^>]*id="dp-relay-comment-send"[^>]*disabled/);
    }
  });
  it('is hidden without an open Relay WR (none, offsite-only, non-UUID, closed)', () => {
    const none = [
      {}, null,
      { savedOffsiteUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/V1', offsiteShopEventUrl: 'https://dtna.example/se/1', _offsiteWrId: '' },
      { workRequestId: '12345' },
      { workRequestId: WR, completed: '2026-11-01' },
      { workRequestId: WR, serviceState: 'Closed' },
    ];
    for (const u of none) {
      expect(m.relayCommentComposeHtml(u)).toBe('');
      expect(m.relayCommentTarget(u)).toBeNull();
    }
  });
  it('has no offsite comment control', () => {
    expect(m.relayCommentComposeHtml(UNIT)).not.toMatch(/Decisiv|Volvo|PACCAR|DTNA/i);
  });
});

describe('wiring', () => {
  it('empty text keeps Send disabled and a forced click does nothing', async () => {
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    expect(d.btn.disabled).toBe(true);
    await type(d, '   ');
    expect(d.btn.disabled).toBe(true);
    await d.btn.fire('click');
    expect(window.relayWrites.addComment).not.toHaveBeenCalled();
  });

  it('valid text enables Send; click calls the bridge once with (workRequestId, text, unit), disabled while in flight', async () => {
    let resolve;
    window.relayWrites.addComment = vi.fn(() => new Promise((r) => { resolve = r; }));
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await type(d, 'Parts ETA 11/12');
    expect(d.btn.disabled).toBe(false);
    expect(d.cnt.textContent).toBe('15/2000');
    const p = d.btn.fire('click');
    await flush();
    expect(window.relayWrites.addComment).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.addComment).toHaveBeenCalledWith(WR, 'Parts ETA 11/12', 'B62020');
    expect(d.btn.disabled).toBe(true);
    await d.btn.fire('click');
    expect(window.relayWrites.addComment).toHaveBeenCalledTimes(1);
    resolve({ ok: true, outcome: 'sent' });
    await p;
    expect(d.txt.value).toBe('');
  });

  it('enforces the 2000-character limit', async () => {
    expect(m.RELAY_COMMENT_MAX).toBe(2000);
    expect(m.validateRelayComment('a'.repeat(2000)).ok).toBe(true);
    expect(m.validateRelayComment('a'.repeat(2001)).ok).toBe(false);
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await type(d, 'a'.repeat(2001));
    expect(d.cnt.textContent).toBe('2001/2000');
    expect(d.cnt.classList.contains('dp-escalate__count--over')).toBe(true);
    expect(d.btn.disabled).toBe(true);
    await d.btn.fire('click');
    expect(window.relayWrites.addComment).not.toHaveBeenCalled();
  });

  it('maps each outcome to the toast level, status text and textarea clearing', async () => {
    const cases = [
      [{ ok: true, outcome: 'sent' }, 'success', true],
      [{ ok: false, outcome: 'pending-approval' }, 'info', true],
      [{ ok: false, outcome: 'skipped-not-approved' }, 'info', false],
      [{ ok: false, outcome: 'send-failed', error: 'x' }, 'error', false],
    ];
    for (const [res, level, cleared] of cases) {
      toast.show.mockClear();
      window.relayWrites.addComment = vi.fn(async () => res);
      const d = mkRoot();
      m.wireRelayComment(d.root, UNIT);
      await type(d, 'note');
      await d.btn.fire('click');
      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(toast.show.mock.calls[0][0]).toBe(level);
      expect(d.st.textContent).toBe(m.relayCommentOutcome(res, WR).text);
      expect(d.txt.value).toBe(cleared ? '' : 'note');
      expect(d.btn.disabled).toBe(cleared);
    }
    expect(m.relayCommentOutcome({ outcome: 'send-failed', error: 'x' }, WR).text).toBe('Relay comment failed: x');
    expect(m.relayCommentOutcome({ outcome: 'sent' }, WR).text).toContain('0a1b2c3d');
  });

  it('a missing bridge gives an error toast and does not throw', async () => {
    globalThis.window = {};
    const d = mkRoot();
    m.wireRelayComment(d.root, UNIT);
    await type(d, 'note');
    await expect(d.btn.fire('click')).resolves.toBeDefined();
    expect(toast.show.mock.calls[0][0]).toBe('error');
    expect(d.st.textContent).toContain('bridge unavailable');
  });
});
