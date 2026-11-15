// tests/relay-write-approval-dom.test.js — the renderer approval prompt for Relay writes
// (renderer/src/js/components/relay-write-approval.js). The repo has no jsdom, so like
// tests/fleet-dbr-panel-dom.test.js this runs in node with a fake modal + bus + bridge:
// the escaped preview is shown in a <pre>, Cancel / ✕ / backdrop / Escape -> respond(id,false),
// Approve & send -> respond(id,true), and each request is answered exactly once.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const M = vi.hoisted(() => {
  const state = { opts: null, shows: 0 };
  const modal = {
    show: (o) => { state.opts = o; state.shows++; },
    // modal.js runs onClose on every close (✕, backdrop click, Escape, programmatic).
    close: () => { const o = state.opts; state.opts = null; if (o && o.onClose) o.onClose(); },
    isOpen: () => !!state.opts,
  };
  const listeners = {};
  const bus = { on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }, emit: () => {} };
  return { state, modal, bus, listeners };
});
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: M.modal }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: M.bus }));

let onRequest, respond;
const badge = { textContent: '', style: { display: 'none' } };
globalThis.document = { getElementById: (id) => (id === 'tb-relay-writes-badge' ? badge : null) };
globalThis.window = {
  relayWrites: {
    onRequest: (cb) => { onRequest = cb; },
    onUpdated: () => {},
    list: async () => ({ items: [{ id: 'a', state: 'pending' }, { id: 'b', state: 'sent' }] }),
    respond: (...a) => respond(...a),
    approve: vi.fn(), reject: vi.fn(),
  },
};

const C = await import('../renderer/src/js/components/relay-write-approval.js');
C.init();

const PREVIEW = 'Relay write: add internal comment\nText (exact, 28 chars):\n<script>alert("x")</script> & ok';
const req = (id, o = {}) => Object.assign({ id, kind: 'addComment', preview: PREVIEW, aiDrafted: false }, o);
const clickAction = (label) => M.state.opts.actions.find((a) => a.label === label).onClick();

beforeEach(() => {
  respond = vi.fn();
  if (M.state.opts) { const o = M.state.opts; M.state.opts = null; o.onClose = null; }
});

describe('relay write approval prompt', () => {
  it('renders the escaped preview inside a <pre>', () => {
    onRequest(req('r1'));
    const body = M.state.opts.body;
    expect(body).toContain('<pre class="rwa-preview"');
    expect(body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; ok');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('AI-drafted');
    expect(M.state.opts.title).toBe('Approve Relay comment');
    clickAction('Cancel');
  });

  it('shows the AI-drafted badge when the text was AI-drafted', () => {
    onRequest(req('r2', { aiDrafted: true, kind: 'createWorkOrder' }));
    expect(M.state.opts.body).toContain('AI-drafted — review the exact text');
    expect(M.state.opts.title).toBe('Approve Relay work request');
    clickAction('Cancel');
  });

  it('Cancel -> respond(id, false) once', () => {
    onRequest(req('r3'));
    clickAction('Cancel');
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('r3', false);
  });

  it('Approve & send -> respond(id, true) once (the close that follows does not cancel)', () => {
    onRequest(req('r4'));
    clickAction('Approve & send');
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('r4', true);
  });

  it('backdrop / Escape / ✕ (any modal close) -> respond(id, false)', () => {
    onRequest(req('r5'));
    M.modal.close();
    expect(respond).toHaveBeenCalledWith('r5', false);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('a second request waits until the first is answered', () => {
    onRequest(req('r6'));
    onRequest(req('r7'));
    expect(M.state.opts.body).toBeTruthy();
    clickAction('Approve & send');
    expect(respond).toHaveBeenNthCalledWith(1, 'r6', true);
    // r7 is shown next
    expect(M.state.opts).toBeTruthy();
    clickAction('Cancel');
    expect(respond).toHaveBeenNthCalledWith(2, 'r7', false);
  });

  it('toolbar badge counts pending writes', async () => {
    await new Promise((r) => setTimeout(r, 0));
    expect(badge.textContent).toBe('1');
    expect(badge.style.display).toBe('');
  });
});
