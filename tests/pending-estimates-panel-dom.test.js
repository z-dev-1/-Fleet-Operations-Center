// tests/pending-estimates-panel-dom.test.js — Fleet tab Pending Estimates overlay controller
// (renderer/src/js/views/pending-estimates-panel.js) through a small fake DOM (no jsdom; same
// approach as fleet-dbr-panel-dom.test.js). The raw ungated writes THROW, so any direct write
// fails the test: Escalate must go through the existing Escalate modal and the gated bridge.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeModal = vi.hoisted(() => {
  const st = { opts: null, panel: null, open: false };
  return { st, show: vi.fn((o) => { st.opts = o; if (o.onMount) o.onMount(st.panel); }), close: vi.fn(), isOpen: vi.fn(() => st.open) };
});
vi.mock('../renderer/src/js/bridge.js', () => ({}));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() { return () => {}; }, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { slice() { return {}; }, update() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show: vi.fn() } }));
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: fakeModal }));

const P = await import('../renderer/src/js/views/pending-estimates-panel.js');
const ra = await import('../renderer/src/js/views/relay-actions.js');

// ── fake DOM ────────────────────────────────────────────────────────────────
class FakeEl {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
    this.listeners = {}; this.id = ''; this.className = ''; this._html = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  appendChild(n) { this.children.push(n); n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  async emit(t, ev) { for (const fn of this.listeners[t] || []) await fn(ev); }
  _walk(fn) { for (const c of this.children) { const r = fn(c) || c._walk(fn); if (r) return r; } return null; }
  querySelector(sel) { return sel[0] === '#' ? this._walk((c) => (c.id === sel.slice(1) ? c : null)) : null; }
}
function makeDoc() {
  const doc = { keyListeners: [] };
  doc.createElement = (t) => new FakeEl(t);
  doc.body = new FakeEl('body');
  doc.addEventListener = (t, fn, cap) => { if (t === 'keydown') doc.keyListeners.push({ fn, cap }); };
  doc.removeEventListener = (t, fn) => { doc.keyListeners = doc.keyListeners.filter((l) => l.fn !== fn); };
  doc.key = (key) => doc.keyListeners.slice().forEach((l) => l.fn({ key, preventDefault() {} }));
  return doc;
}
const clickAttr = (attr, value, extra = {}) => ({ target: { closest: (s) => (s === '[' + attr + ']'
  ? Object.assign({ getAttribute: (k) => (k === attr ? value : null), disabled: false }, extra) : null) } });

// ── fixture fleet ───────────────────────────────────────────────────────────
const NOW = Date.parse('2026-11-19T18:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const WR_A = '0a1b2c3d-1111-2222-3333-000000000001';
const WR_DTNA = '0a1b2c3d-1111-2222-3333-000000000002';
const UNIT_A = { equipmentId: 'A100', workRequestId: WR_A, assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/AAID1', vendor: 'TA',
  estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - 3 * H), estimateSubmittedAmount: 4200, extractedAt: iso(NOW - H) };
const DTNA = { equipmentId: 'D999', workRequestId: WR_DTNA, assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/AAID2',
  vendor: 'Freightliner (DAIMLER)', asistSource: 'dtna', estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - 9 * H) };
const APPROVED = { equipmentId: 'C300', workRequestId: '0a1b2c3d-1111-2222-3333-000000000003', estimateStatus: 'approved' };

let fleet; let doc; let busHandlers; let unsub; let returnFocusEl; let openEscalation; let navigate; let ctl; let escDeps;
function setup(over = {}) {
  fleet = { rows: [UNIT_A, DTNA, APPROVED], syncedAt: '2026-11-19T17:55:00Z', usedCache: false, stale: false };
  doc = makeDoc();
  busHandlers = {};
  unsub = vi.fn();
  const bus = { on: vi.fn((ev, fn) => { busHandlers[ev] = fn; return unsub; }) };
  returnFocusEl = { focus: vi.fn() };
  openEscalation = over.openEscalation || vi.fn(async () => {});
  navigate = vi.fn();
  escDeps = over.escalationDeps || { modal: fakeModal, toast: { show: vi.fn() } };
  ctl = P.__test__.createController({ doc, bus, modal: fakeModal, getFleet: () => fleet, openEscalation, escalationDeps: escDeps,
    navigate, returnFocusEl, now: () => NOW });
  ctl.open();
}
const overlay = () => doc.body.children[0];
const body = () => overlay().querySelector('#pe-body').innerHTML;

beforeEach(() => {
  fakeModal.st.open = false; fakeModal.st.opts = null;
  fakeModal.show.mockClear(); fakeModal.close.mockClear();
  globalThis.window = {
    aapApi: {
      escalationOptions: vi.fn(async () => ({ ok: true, enabled: true, current: [],
        options: [{ value: 'FAS', displayText: 'FAS' }, { value: 'MCS_HIGH_VALUE_ESTIMATE', displayText: 'MCS High Value Estimate' }] })),
      updateEscalations: vi.fn(() => { throw new Error('RAW WRITE'); }),
    },
    relayWrites: {
      escalate: vi.fn(async () => ({ ok: true, outcome: 'pending-approval' })),
      draftAction: vi.fn(async () => { throw new Error('NO AUTO DRAFT'); }),
    },
  };
});

describe('Pending Estimates overlay', () => {
  it('mounts a dialog overlay with the pending rows only (DTNA listed, approved absent) and the as-of stamp', () => {
    setup();
    expect(overlay().id).toBe('pe-overlay');
    expect(overlay().className).toBe('pe-overlay');
    expect(overlay().attrs).toMatchObject({ role: 'dialog', 'aria-modal': 'true' });
    const h = body();
    expect(h).toContain('data-pe-unit="A100"');
    expect(h).toContain('$4,200.00');
    expect(h).toContain('submitted 3h 0m ago');
    expect(h).toContain('data-pe-unit="D999"');
    expect(h).not.toContain('C300');
    expect(h).toContain('as of 11/19 12:55');
    expect(h).toContain('DTNA not pulled');
    expect(h).not.toContain('DTNA excluded');
  });

  it('Escalate calls the existing Escalate modal opener once, pre-targeted to HVE; nothing writes directly', async () => {
    setup();
    await overlay().emit('click', clickAttr('data-pe-escalate', WR_A));
    expect(openEscalation).toHaveBeenCalledTimes(1);
    expect(openEscalation).toHaveBeenCalledWith(UNIT_A, WR_A, escDeps, { initialTarget: 'MCS_HIGH_VALUE_ESTIMATE' });
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
    expect(window.relayWrites.draftAction).not.toHaveBeenCalled();
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
    await overlay().emit('click', clickAttr('data-pe-escalate', WR_A, { disabled: true }));
    expect(openEscalation).toHaveBeenCalledTimes(1);
  });

  it('end to end with the real Escalate modal: HVE pre-selected, submit goes only through the gated bridge.escalate', async () => {
    const sel = {};
    const mk = () => ({ value: '', hidden: true, textContent: '', listeners: {}, addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); },
      fire(e) { return Promise.all((this.listeners[e] || []).map((f) => f({ target: this }))); }, focus() {} });
    ['#ra-esc-target', '#ra-esc-hve', '#ra-esc-reactivation-hint', '#ra-esc-amount', '#ra-esc-reason', '#ra-esc-draft',
      '#ra-esc-count', '#ra-stale', '#ra-fills'].forEach((s) => { sel[s] = mk(); });
    fakeModal.st.panel = { querySelector: (s) => sel[s] || null, querySelectorAll: () => [] };
    const toast = { show: vi.fn() };
    setup({ openEscalation: ra.openEscalationModal,
      escalationDeps: { modal: fakeModal, bridge: window.relayWrites, aapApi: window.aapApi, toast, confirm: () => true } });
    await overlay().emit('click', clickAttr('data-pe-escalate', WR_A));
    expect(window.aapApi.escalationOptions).toHaveBeenCalledWith({ aaid: 'AAID1', workRequestId: WR_A });
    expect(fakeModal.show).toHaveBeenCalledTimes(1);
    expect(sel['#ra-esc-target'].value).toBe('MCS_HIGH_VALUE_ESTIMATE');
    expect(sel['#ra-esc-hve'].hidden).toBe(false);
    expect(window.relayWrites.draftAction).not.toHaveBeenCalled();
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
    expect(doc.body.children.length).toBe(1); // overlay stays under the modal
    sel['#ra-esc-reason'].value = 'OFFSITE EST SUBMITTED - REVIEW';
    await fakeModal.st.opts.actions.find((a) => a.label === 'Submit escalation').onClick();
    expect(window.relayWrites.escalate).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.escalate.mock.calls[0][0]).toMatchObject({ workRequestId: WR_A, aaid: 'AAID1',
      add: ['MCS_HIGH_VALUE_ESTIMATE'], unit: 'A100' });
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
    expect(toast.show.mock.calls.at(-1)[1]).toContain('Queued in Relay writes');
  });

  it('Escape closes the overlay, but not while a modal.js modal is open', () => {
    setup();
    fakeModal.st.open = true;
    doc.key('Escape');
    expect(doc.body.children.length).toBe(1);
    fakeModal.st.open = false;
    doc.key('Escape');
    expect(doc.body.children.length).toBe(0);
    expect(returnFocusEl.focus).toHaveBeenCalledTimes(1);
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(doc.keyListeners.length).toBe(0);
  });

  it('× and backdrop close; a unit link navigates and closes', async () => {
    setup();
    await overlay().emit('click', clickAttr('data-pe-close', '1'));
    expect(doc.body.children.length).toBe(0);
    setup();
    await overlay().emit('click', { target: overlay().children[0] });
    expect(doc.body.children.length).toBe(0);
    setup();
    await overlay().emit('click', clickAttr('data-pe-unit', 'A100'));
    expect(navigate).toHaveBeenCalledWith('A100');
    expect(doc.body.children.length).toBe(0);
  });

  it('a fleet:data push re-renders with the new rows and as-of time; cached data is flagged', () => {
    setup();
    expect(busHandlers['fleet:data']).toBeTypeOf('function');
    fleet = { rows: [], syncedAt: '2026-11-19T19:30:00Z', usedCache: true };
    busHandlers['fleet:data']({});
    expect(body()).toContain('as of 11/19 14:30 (cached)');
    expect(body()).toContain('No pending estimates in your domiciles.');
  });
});
