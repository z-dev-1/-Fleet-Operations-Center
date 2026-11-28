// tests/decisiv-reply-modal-dom.test.js — the "Reply to dealer (Decisiv)"
// composer (renderer/src/js/views/relay-actions.js): the button only for a
// PACCAR Decisiv estimate URL, the grouped roster checklist with nothing
// checked by default, submit validation, and close-before-await. Fake modal and
// fake elements (no jsdom). Synthetic ids and names only.
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

const ra = await import('../renderer/src/js/views/relay-actions.js');

const EST = '1000001';
const CASE = '1000002';
const SR = 'https://paccarpg.decisiv.net/fleet/estimates/' + EST;
const cid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const UNIT = { equipmentId: 'U100', offsiteShopEventUrl: SR };
const CONTACTS = [
  { id: cid(1), name: 'Dealer Writer A', jobRole: 'Service Advisor', subGroup: 'Dealer Group A', filterName: 'dealer' },
  { id: cid(2), name: 'Amazon Staff B', jobRole: '', subGroup: 'Amazon Staff Group', filterName: 'fleet_dealer' },
  { id: cid(3), name: 'Dealer Writer <C>', jobRole: 'Parts', subGroup: 'Dealer Group A', filterName: 'dealer' },
];

function el(attrs = {}) {
  return {
    value: '', checked: false, textContent: '', attrs, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: this }))); },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    focus: vi.fn(),
  };
}
// Build the checkbox elements from the rendered body so the test reads what the user sees.
function mkPanel(body) {
  const boxes = [...body.matchAll(/<input type="checkbox"([^>]*)>/g)].map((m) => {
    const id = /data-dr-id="([^"]+)"/.exec(m[1])[1];
    const b = el({ 'data-dr-id': id });
    b.checked = /\schecked\b/.test(m[1]);
    return b;
  });
  const map = { '#ra-dr-text': el(), '#ra-dr-count': el(), '#ra-dr-selected': el() };
  return { map, boxes, querySelector: (s) => map[s] || null, querySelectorAll: (s) => (s === '[data-dr-id]' ? boxes : []) };
}

let toast, bridge;
function deps(over = {}) {
  toast = { show: vi.fn() };
  bridge = Object.assign({
    decisivReplyRoster: vi.fn(async () => ({ ok: true, caseId: CASE, estimateId: EST, contacts: CONTACTS })),
    decisivReply: vi.fn(async () => { fakeModal.st.order.push('post'); return { ok: true, outcome: 'sent', id: 'rw_1' }; }),
  }, over);
  return { modal: fakeModal, toast, bridge };
}
async function open(d) {
  // The panel is built from the body the modal is asked to show.
  fakeModal.show.mockImplementationOnce((o) => {
    fakeModal.st.opts = o;
    fakeModal.st.panel = mkPanel(o.body);
    if (o.onMount) o.onMount(fakeModal.st.panel);
  });
  await ra.openDecisivReplyModal(UNIT, ra.decisivReplyRefOf(UNIT), d);
}
const action = (label) => fakeModal.st.opts.actions.find((a) => a.label === label);

beforeEach(() => {
  fakeModal.show.mockClear();
  fakeModal.close.mockClear();
  fakeModal.st.opts = null;
  fakeModal.st.panel = null;
  fakeModal.st.order = [];
});

describe('Reply to dealer button', () => {
  it('is hidden without a URL, for a DTNA case and for a non-Decisiv host; shown for a PACCAR or Volvo estimate', () => {
    expect(ra.decisivReplyButtonHtml({ equipmentId: 'U1' })).toBe('');
    expect(ra.decisivReplyButtonHtml({ equipmentId: 'U1', dtnaCaseNumber: '123', offsiteShopEventUrl: 'https://dtna.my.site.com/Servicetracker/s/case/500gx000002E4U5AAK/detail' })).toBe('');
    expect(ra.decisivReplyButtonHtml({ equipmentId: 'U1', offsiteShopEventUrl: 'https://evil.example/fleet/estimates/' + EST })).toBe('');
    expect(ra.decisivReplyButtonHtml({ equipmentId: 'U1', offsiteShopEventUrl: 'http://volvopg.asist.decisiv.net/fleet/estimates/' + EST })).toBe('');
    const VOLVO_SR = 'https://volvopg.asist.decisiv.net/fleet/estimates/' + EST;
    const volvoUnit = { equipmentId: 'U2', offsiteShopEventUrl: VOLVO_SR };
    expect(ra.decisivReplyButtonHtml(volvoUnit)).toContain('data-ra-decisiv-reply="' + EST + '"');
    expect(ra.decisivReplyRefOf(volvoUnit)).toEqual({ estimateId: EST, srUrl: VOLVO_SR });
    const html = ra.decisivReplyButtonHtml(UNIT);
    expect(html).toContain('data-ra-decisiv-reply="' + EST + '"');
    expect(html).toContain('Reply to dealer (Decisiv)');
    expect(ra.decisivReplyRefOf(UNIT)).toEqual({ estimateId: EST, srUrl: SR });
  });

  it('wireRelayActions opens the composer from the button', async () => {
    const d = deps();
    const btn = el({ 'data-ra-decisiv-reply': EST });
    const root = { querySelectorAll: (s) => (s === '[data-ra-decisiv-reply]' ? [btn] : []), querySelector: () => null };
    ra.wireRelayActions(root, UNIT, d);
    await btn.fire('click');
    await new Promise((r) => setImmediate(r));
    expect(bridge.decisivReplyRoster).toHaveBeenCalledWith({ estimateId: EST, srUrl: SR, unit: 'U100' });
    expect(fakeModal.show).toHaveBeenCalledTimes(1);
  });
});

describe('roster checklist', () => {
  it('groups by sub_group with name — job_role — sub_group labels, escaped, and nothing checked', () => {
    const html = ra.decisivRecipientListHtml(CONTACTS);
    expect(html.indexOf('Amazon Staff Group')).toBeLessThan(html.indexOf('Dealer Group A'));
    expect(html).toContain('Amazon Staff Group <span class="ra-hint">(Amazon staff)</span>');
    expect(html).toContain('Dealer Group A <span class="ra-hint">(Dealer / OEM)</span>');
    expect(html).toContain('Dealer Writer A \u2014 Service Advisor \u2014 Dealer Group A');
    expect(html).toContain('Amazon Staff B \u2014 \u2014 \u2014 Amazon Staff Group');
    expect(html).toContain('Dealer Writer &lt;C&gt;');
    expect(html).not.toMatch(/\schecked\b/);
    expect((html.match(/type="checkbox"/g) || []).length).toBe(3);
  });

  it('the opened modal shows the case and no box is checked by default', async () => {
    await open(deps());
    expect(fakeModal.st.opts.body).toContain('Decisiv case <b>' + CASE + '</b>');
    expect(fakeModal.st.panel.boxes).toHaveLength(3);
    expect(fakeModal.st.panel.boxes.every((b) => !b.checked)).toBe(true);
  });
});

describe('submit', () => {
  it('0 checked or empty text does not call the bridge', async () => {
    await open(deps());
    fakeModal.st.panel.map['#ra-dr-text'].value = 'Any ETA?';
    await action('Stage reply').onClick();
    expect(bridge.decisivReply).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith('warn', 'Pick at least one recipient.');
    fakeModal.st.panel.boxes[0].checked = true;
    fakeModal.st.panel.map['#ra-dr-text'].value = '   ';
    await action('Stage reply').onClick();
    expect(bridge.decisivReply).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
  });

  it('2 checked -> one bridge call with exactly those ids; the modal closes before the call', async () => {
    await open(deps());
    const p = fakeModal.st.panel;
    const box = (id) => p.boxes.find((b) => b.getAttribute('data-dr-id') === id);
    box(cid(1)).checked = true;
    box(cid(3)).checked = true;
    await box(cid(1)).fire('change');
    expect(p.map['#ra-dr-selected'].textContent).toBe('2');
    p.map['#ra-dr-text'].value = '  Any ETA?  ';
    await action('Stage reply').onClick();
    expect(bridge.decisivReply).toHaveBeenCalledTimes(1);
    expect(bridge.decisivReply).toHaveBeenCalledWith({ unit: 'U100', estimateId: EST, srUrl: SR, caseId: CASE, text: 'Any ETA?', recipients: [cid(1), cid(3)] });
    expect(fakeModal.st.order).toEqual(['close', 'post']);
    expect(toast.show).toHaveBeenLastCalledWith('success', 'Reply posted to Decisiv case ' + CASE + ' for 2 recipient(s).');
  });

  it('a roster failure shows the toast and opens no modal', async () => {
    const d = deps({ decisivReplyRoster: vi.fn(async () => ({ ok: false, code: 'DECISIV_NO_ROSTER' })) });
    await ra.openDecisivReplyModal(UNIT, ra.decisivReplyRefOf(UNIT), d);
    expect(fakeModal.show).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenLastCalledWith('error', 'No dealer case roster found for this estimate; nothing can be sent.');
  });
});
