// tests/dtna-actions-modal-dom.test.js — unit detail "💬 Post to DTNA" compose modal
// (renderer/src/js/views/dtna-actions.js) against a recording fake modal.js and fake elements.
// AI draft only fills the textarea; Send closes the modal before the gated postComment resolves.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fakeModal = vi.hoisted(() => {
  const st = { opts: null, panel: null, order: [] };
  return {
    st,
    show: vi.fn((o) => { st.opts = o; if (o.onMount) o.onMount(st.panel); }),
    close: vi.fn(() => { st.order.push('close'); }),
    isOpen: vi.fn(() => false),
  };
});
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: fakeModal }));

const A = await import('../renderer/src/js/views/dtna-actions.js');

const CASE = '500gx000002E4U5AAK';
const DTNA = 'https://dtna.my.site.com/Servicetracker/s/case/' + CASE + '/detail';
const UNIT = { equipmentId: '122269', vendor: 'HORWITH FREIGHTLINER', offsiteShopEventUrl: DTNA };

function el() {
  return {
    value: '', disabled: false, textContent: '', listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: this }))); },
  };
}
let sel; let toast; let bridge; let confirm;
function open(over = {}) {
  sel = { '#dtna-cm-text': el(), '#dtna-cm-draft': el(), '#dtna-cm-count': el() };
  fakeModal.st.panel = { querySelector: (s) => sel[s] || null };
  toast = { show: vi.fn() };
  confirm = over.confirm || vi.fn(() => true);
  bridge = Object.assign({
    draftComment: vi.fn(async () => ({ ok: true, aiDrafted: true, draft: 'Could you share the ETA?', noUpdate: false, droppedCount: 0 })),
    postComment: vi.fn(async () => { fakeModal.st.order.push('post'); return { ok: true, outcome: 'sent', id: 'rw_1' }; }),
  }, over.bridge || {});
  A.openDtnaCommentModal(UNIT, { caseId: CASE }, { modal: fakeModal, toast, bridge, confirm });
}
const action = (label) => fakeModal.st.opts.actions.find((a) => a.label === label);

beforeEach(() => {
  fakeModal.show.mockClear();
  fakeModal.close.mockClear();
  fakeModal.st.order = [];
});

describe('dtnaPostButtonHtml', () => {
  it('shows for a DTNA case URL only', () => {
    const h = A.dtnaPostButtonHtml(UNIT, DTNA);
    expect(h).toContain('data-dtna-post="122269"');
    expect(h).toContain('data-dtna-case="' + CASE + '"');
    expect(h).toContain('\uD83D\uDCAC Post to DTNA');
    expect(A.dtnaPostButtonHtml(UNIT, DTNA + '?tabset-032e7=5194e')).toContain('data-dtna-case="' + CASE + '"');
    expect(A.dtnaPostButtonHtml(UNIT, 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146')).toBe('');
    expect(A.dtnaPostButtonHtml(UNIT, 'https://dtna.my.site.com/Servicetracker/s/case/001xx/detail')).toBe('');
    expect(A.dtnaPostButtonHtml(UNIT, 'https://evil.example/https://dtna.my.site.com/Servicetracker/s/case/' + CASE)).toBe('');
    expect(A.dtnaPostButtonHtml(UNIT, '')).toBe('');
    expect(A.dtnaPostButtonHtml({}, DTNA)).toBe('');
  });
});

describe('openDtnaCommentModal', () => {
  it('opens with the dealer-visible warning and a 2000-char textarea; nothing is sent on open', () => {
    open();
    expect(fakeModal.show).toHaveBeenCalledTimes(1);
    expect(fakeModal.st.opts.title).toBe('Post to DTNA \u2014 case \u2026' + CASE.slice(-6));
    expect(fakeModal.st.opts.body).toContain('Visible to the dealer (DTNA Service Tracker).');
    expect(fakeModal.st.opts.body).toContain('Nothing is sent until you approve the exact text.');
    expect(fakeModal.st.opts.body).toContain('id="dtna-cm-text"');
    expect(fakeModal.st.opts.body).toContain('maxlength="2000"');
    expect(fakeModal.st.opts.actions.map((a) => a.label)).toEqual(['Cancel', 'Send to DTNA']);
    expect(bridge.draftComment).not.toHaveBeenCalled();
    expect(bridge.postComment).not.toHaveBeenCalled();
  });

  it('AI draft fills the textarea and the next send carries aiDrafted:true', async () => {
    open();
    await sel['#dtna-cm-draft'].fire('click');
    expect(bridge.draftComment).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE });
    expect(sel['#dtna-cm-text'].value).toBe('Could you share the ETA?');
    expect(bridge.postComment).not.toHaveBeenCalled();
    await action('Send to DTNA').onClick();
    expect(bridge.postComment).toHaveBeenCalledTimes(1);
    expect(bridge.postComment).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE, text: 'Could you share the ETA?', aiDrafted: true });
  });

  it('AI draft asks before replacing typed text; clearing the text resets aiDrafted', async () => {
    open({ confirm: vi.fn(() => false) });
    sel['#dtna-cm-text'].value = 'my text';
    await sel['#dtna-cm-draft'].fire('click');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bridge.draftComment).not.toHaveBeenCalled();
    expect(sel['#dtna-cm-text'].value).toBe('my text');
    open();
    await sel['#dtna-cm-draft'].fire('click');
    sel['#dtna-cm-text'].value = '';
    await sel['#dtna-cm-text'].fire('input');
    sel['#dtna-cm-text'].value = 'typed by me';
    await sel['#dtna-cm-text'].fire('input');
    expect(sel['#dtna-cm-count'].textContent).toBe('11/2000');
    await action('Send to DTNA').onClick();
    expect(bridge.postComment.mock.calls[0][0].aiDrafted).toBe(false);
  });

  it('noUpdate -> info toast, textarea untouched', async () => {
    open({ bridge: { draftComment: vi.fn(async () => ({ ok: true, aiDrafted: true, draft: '', noUpdate: true, droppedCount: 0 })) } });
    await sel['#dtna-cm-draft'].fire('click');
    expect(sel['#dtna-cm-text'].value).toBe('');
    expect(toast.show).toHaveBeenCalledWith('info', 'AI found nothing new to ask the dealer.');
  });

  it('Send closes the modal BEFORE postComment resolves and calls it once with the exact fields', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    open({ bridge: { postComment: vi.fn(async () => { fakeModal.st.order.push('post'); await gate; return { ok: true, outcome: 'sent', id: 'rw_1' }; }) } });
    sel['#dtna-cm-text'].value = '  Please send the ETA.  ';
    const p = action('Send to DTNA').onClick();
    await Promise.resolve();
    expect(fakeModal.close).toHaveBeenCalledTimes(1);
    expect(fakeModal.st.order).toEqual(['close', 'post']);
    expect(toast.show).toHaveBeenCalledWith('info', 'Waiting for your approval\u2026', 3000);
    release();
    await p;
    expect(bridge.postComment).toHaveBeenCalledTimes(1);
    expect(bridge.postComment).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE, text: 'Please send the ETA.', aiDrafted: false });
    expect(toast.show).toHaveBeenLastCalledWith('success', 'Comment posted to DTNA case \u2026' + CASE.slice(-6) + '. Pull DTNA to see it in the thread.');
  });

  it('toasts for not configured and pending approval', async () => {
    open({ bridge: { postComment: vi.fn(async () => ({ ok: false, code: 'DTNA_POST_NOT_CONFIGURED' })) } });
    sel['#dtna-cm-text'].value = 'x';
    await action('Send to DTNA').onClick();
    expect(toast.show).toHaveBeenLastCalledWith('warn', 'Posting to DTNA is not set up yet. Nothing was sent.');
    open({ bridge: { postComment: vi.fn(async () => ({ ok: false, outcome: 'pending-approval', id: 'rw_2' })) } });
    sel['#dtna-cm-text'].value = 'x';
    await action('Send to DTNA').onClick();
    expect(toast.show).toHaveBeenLastCalledWith('info', 'Queued in Relay writes. Approve it there to send.');
    open({ bridge: { postComment: vi.fn(async () => ({ ok: false, code: 'DTNA_NO_REPAIR_ORDER' })) } });
    sel['#dtna-cm-text'].value = 'x';
    await action('Send to DTNA').onClick();
    expect(toast.show).toHaveBeenLastCalledWith('warn', 'This DTNA case has no repair order; the portal does not accept comments on it.');
  });

  it('empty text -> warn toast, no call, modal stays open', async () => {
    open();
    sel['#dtna-cm-text'].value = '   ';
    await action('Send to DTNA').onClick();
    expect(toast.show).toHaveBeenCalledWith('warn', 'Write a comment first.');
    expect(bridge.postComment).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
  });

  it('Cancel closes with no call', async () => {
    open();
    sel['#dtna-cm-text'].value = 'something';
    action('Cancel').onClick();
    expect(fakeModal.close).toHaveBeenCalledTimes(1);
    expect(bridge.postComment).not.toHaveBeenCalled();
    expect(bridge.draftComment).not.toHaveBeenCalled();
  });
});
