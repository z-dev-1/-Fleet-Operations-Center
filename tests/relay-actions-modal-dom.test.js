// tests/relay-actions-modal-dom.test.js
// Unit detail → WR-card "⚠ Escalate" / "💬 Add Relay Comment" and header
// "⟳ Change Lifecycle" modals (renderer/src/js/views/relay-actions.js). Runs the
// real module against a recording fake modal.js and fake DOM elements (no jsdom).
// The raw ungated writes (window.aapApi.updateEscalations, window.aap.setLifecycle)
// THROW, so any call to them fails the test: only the gated bridge may write.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const toast = vi.hoisted(() => ({ show: vi.fn() }));
const fakeModal = vi.hoisted(() => {
  const st = { opts: null, panel: null };
  return {
    st,
    show: vi.fn((o) => { st.opts = o; if (o.onMount) o.onMount(st.panel); }),
    close: vi.fn(),
    isOpen: vi.fn(() => false),
  };
});
vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: toast }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: fakeModal }));

const ra = await import('../renderer/src/js/views/relay-actions.js');
const m = await import('../renderer/src/js/views/unit-detail.js');

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const WR2 = '9f8e7d6c-1111-2222-3333-444455556666';
const ASSET = 'https://aap-na.corp.amazon.com/v2/asset/AAID1';
const UNIT = { equipmentId: '322168', workRequestId: WR, assetUrl: ASSET, lifecycleState: 'Unavailable', vendor: 'Rush' };
const LIVE = [
  { value: 'FAS', displayText: 'FAS' },
  { value: 'MCS_LEAD', displayText: 'MCS Lead' },
  { value: 'MCS_HIGH_VALUE_ESTIMATE', displayText: 'MCS High Value Estimate' },
  { value: 'TOWING', displayText: 'Towing' },
  { value: 'MCS_CARRIER_UPDATE_REQUEST', displayText: 'Carrier Update Request' },
];
const LABELS = ['FAS', 'MCS Lead', 'MCS High Value Estimate', 'MCS Reactivation', 'TOM Pending Action',
  'Document Request', 'MCS Recovery SIM Post Repair', 'MCS Carrier Update Request'];
const SELECTORS = ['#ra-esc-target', '#ra-esc-hve', '#ra-esc-reactivation-hint', '#ra-esc-amount', '#ra-esc-reason',
  '#ra-esc-draft', '#ra-esc-count', '#ra-stale', '#ra-fills', '#ra-cm-template', '#ra-cm-text', '#ra-cm-draft',
  '#ra-cm-count', '#ra-lc-state', '#ra-lc-reason'];

function el() {
  return {
    value: '', hidden: true, disabled: false, textContent: '', attrs: {}, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: this }))); },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    focus: vi.fn(),
  };
}
function mkPanel(removeVals) {
  const map = {};
  SELECTORS.forEach((s) => { map[s] = el(); });
  map['#ra-esc-amount'].value = '0';
  const chips = (removeVals || []).map((v) => { const b = el(); b.attrs['data-ra-remove'] = v; return b; });
  return { map, chips, querySelector: (s) => map[s] || null, querySelectorAll: (s) => (s === '[data-ra-remove]' ? chips : []) };
}
const q = (s) => fakeModal.st.panel.map[s];
const action = (label) => fakeModal.st.opts.actions.find((a) => a.label === label);
const optionTexts = (html) => [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((x) => x[1]);
const type = (s, v) => { q(s).value = v; return q(s).fire('input'); };
const choose = (s, v) => { q(s).value = v; return q(s).fire('change'); };

let deps;
beforeEach(() => {
  toast.show.mockClear();
  fakeModal.show.mockClear();
  fakeModal.close.mockClear();
  fakeModal.st.opts = null;
  globalThis.window = {
    aapApi: {
      escalationOptions: vi.fn(async () => ({ ok: true, enabled: true, options: LIVE, current: [] })),
      updateEscalations: vi.fn(() => { throw new Error('RAW WRITE'); }),
    },
    aap: { setLifecycle: vi.fn(() => { throw new Error('RAW WRITE'); }) },
    relayWrites: {
      escalate: vi.fn(async () => ({ ok: true, outcome: 'sent' })),
      addComment: vi.fn(async () => ({ ok: true, outcome: 'sent' })),
      changeLifecycle: vi.fn(async () => ({ ok: true, outcome: 'sent', result: { success: true } })),
      draftAction: vi.fn(async () => ({ ok: true, draft: 'OFFSITE EST SUBMITTED - <FILL: vendor>', placeholders: ['vendor'],
        freshness: { warnings: ['Offsite notes are 72 h old (scraped 11/16 08:00) \u2014 may be stale'], stale: true } })),
      draftComment: vi.fn(async () => ({ ok: true, draft: 'vendor says parts eta friday, see https://x.example/Path' })),
      lifecycleOptions: vi.fn(async () => ({ ok: true, states: ['ACTIVE', 'UNAVAILABLE', 'ORDERED', 'END_OF_LIFE'],
        reasons: ['HEALTHY', 'OFFSITE_SHOP_REPAIR', 'PARTS_DELAY'] })),
    },
  };
  deps = { modal: fakeModal, bridge: window.relayWrites, aapApi: window.aapApi, toast,
    confirm: vi.fn(() => true), verifyLifecycle: vi.fn(async () => true) };
});

async function openEsc(current) {
  window.aapApi.escalationOptions.mockImplementation(async () => ({ ok: true, enabled: true, options: LIVE, current: current || [] }));
  fakeModal.st.panel = mkPanel(current);
  await ra.openEscalationModal(UNIT, WR, deps);
}

describe('escalation modal', () => {
  it('lists the 8 RG targets in order, never towing, with the towing note, HVE amount 0 + hint and no threshold', async () => {
    await openEsc();
    expect(window.aapApi.escalationOptions).toHaveBeenCalledWith({ aaid: 'AAID1', workRequestId: WR });
    const o = fakeModal.st.opts;
    expect(o.title).toBe('Escalate WR 0a1b2c3d');
    const texts = optionTexts(o.body);
    expect(texts[0]).toBe('');
    expect(texts.slice(1).map((t) => t.replace(' (not offered for this fleet)', ''))).toEqual(LABELS);
    expect(texts.some((t) => /tow/i.test(t))).toBe(false);
    expect(o.body).not.toContain('TOWING');
    expect(o.body).toContain('Document Request (not offered for this fleet)');
    expect(o.body).toMatch(/<option value="DOCUMENT_REQUEST" disabled>/);
    expect(o.body).toContain(ra.TOWING_NOTE);
    expect(o.body).toContain('id="ra-esc-amount" type="number" min="0" step="0.01" value="0"');
    expect(o.body).toContain('confirm threshold with MCS lead');
    expect(o.body).toContain('maxlength="2000"');
    expect(o.body).toContain('You approve the exact text before anything is sent.');
    for (const n of ['2500', '2,500', '1000', '1,000']) expect(o.body).not.toContain(n);
    expect(o.actions.map((a) => a.label)).toEqual(['Cancel', 'Submit escalation']);
  });

  it('resolveTargetOptions maps live values (towing filtered) and isTowingOption catches value or text', () => {
    const r = ra.resolveTargetOptions(LIVE);
    expect(r.map((x) => x.key)).toEqual(ra.RG_TARGETS.map((t) => t.key));
    expect(r.find((x) => x.key === 'MCS_CARRIER_UPDATE_REQUEST').value).toBe('MCS_CARRIER_UPDATE_REQUEST');
    expect(r.find((x) => x.key === 'MCS_REACTIVATION')).toMatchObject({ value: null, disabled: true });
    expect(r.some((x) => x.value === 'TOWING')).toBe(false);
    expect(ra.isTowingOption({ value: 'X', displayText: 'Tow request' })).toBe(true);
    expect(ra.isTowingOption({ value: 'FAS', displayText: 'FAS' })).toBe(false);
  });

  it('HVE target shows the amount field; Draft calls draftAction and shows freshness warnings + fills', async () => {
    await openEsc();
    await choose('#ra-esc-target', 'MCS_HIGH_VALUE_ESTIMATE');
    expect(q('#ra-esc-hve').hidden).toBe(false);
    await choose('#ra-esc-target', 'MCS_REACTIVATION');
    expect(q('#ra-esc-hve').hidden).toBe(true);
    expect(q('#ra-esc-reactivation-hint').hidden).toBe(false);
    await choose('#ra-esc-target', 'MCS_HIGH_VALUE_ESTIMATE');
    await q('#ra-esc-draft').fire('click');
    expect(window.relayWrites.draftAction).toHaveBeenCalledTimes(1);
    const arg = window.relayWrites.draftAction.mock.calls[0][0];
    expect(arg).toMatchObject({ kind: 'escalation', target: 'MCS_HIGH_VALUE_ESTIMATE', workRequestId: WR, userInputs: { estAmount: 0 } });
    expect(arg.unit.equipmentId).toBe('322168');
    expect(q('#ra-esc-reason').value).toBe('OFFSITE EST SUBMITTED - <FILL: vendor>');
    expect(q('#ra-stale').textContent).toContain('\u26A0 Offsite notes are 72 h old');
    expect(q('#ra-fills').textContent).toContain('Fill before sending: <FILL: vendor>');
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
  });

  it('HVE amount field: pre-filled from the unit estimate; only a typed amount is sent to the drafter', async () => {
    fakeModal.st.panel = mkPanel();
    await ra.openEscalationModal(Object.assign({}, UNIT, { estimatePendingCost: '$4,850.50' }), WR, deps);
    expect(fakeModal.st.opts.body).toContain('id="ra-esc-amount" type="number" min="0" step="0.01" value="4850.5"');
    q('#ra-esc-amount').value = '4850.5';
    await choose('#ra-esc-target', 'MCS_HIGH_VALUE_ESTIMATE');
    await q('#ra-esc-draft').fire('click');
    expect(window.relayWrites.draftAction.mock.calls[0][0].userInputs).toEqual({ estAmount: 0 });
    await type('#ra-esc-amount', '3000');
    deps.confirm.mockReturnValue(true);
    await q('#ra-esc-draft').fire('click');
    expect(window.relayWrites.draftAction.mock.calls[1][0].userInputs).toEqual({ estAmount: 3000 });
    // Planned/secondary WR: its totalCost is the pending estimate; no estimate -> field stays 0.
    fakeModal.st.panel = mkPanel();
    await ra.openEscalationModal(Object.assign({}, UNIT, { _secondaryWRs: [{ workRequestId: WR2, totalCost: 1200 }] }), WR2, deps);
    expect(fakeModal.st.opts.body).toContain('value="1200"');
    expect(ra.unitEstAmount({})).toBe(0);
    expect(ra.unitEstAmount({ estimatePendingCost: 'n/a' })).toBe(0);
  });

  it('Submit closes the modal BEFORE bridge.escalate with add:[liveValue]; raw updateEscalations never called', async () => {
    await openEsc();
    await choose('#ra-esc-target', 'MCS_HIGH_VALUE_ESTIMATE');
    await q('#ra-esc-draft').fire('click');
    await action('Submit escalation').onClick();
    expect(fakeModal.close).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.escalate).toHaveBeenCalledTimes(1);
    expect(fakeModal.close.mock.invocationCallOrder[0]).toBeLessThan(window.relayWrites.escalate.mock.invocationCallOrder[0]);
    expect(window.relayWrites.escalate).toHaveBeenCalledWith({ workRequestId: WR, aaid: 'AAID1', add: ['MCS_HIGH_VALUE_ESTIMATE'],
      remove: [], comment: 'OFFSITE EST SUBMITTED - <FILL: vendor>', unit: '322168', aiDrafted: true });
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
    expect(toast.show.mock.calls.at(-1)[0]).toBe('success');
  });

  it('refuses a disabled target, an empty reason and an already-applied team', async () => {
    await openEsc(['FAS']);
    await choose('#ra-esc-target', 'DOCUMENT_REQUEST');
    await type('#ra-esc-reason', 'NEED DOCS');
    await action('Submit escalation').onClick();
    await choose('#ra-esc-target', 'MCS_LEAD');
    await type('#ra-esc-reason', '   ');
    await action('Submit escalation').onClick();
    await choose('#ra-esc-target', 'FAS');
    await type('#ra-esc-reason', 'PUSH VENDOR');
    await action('Submit escalation').onClick();
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
  });

  it('Remove chip de-escalates via bridge.escalate with remove:[value], add:[]', async () => {
    await openEsc(['FAS']);
    expect(fakeModal.st.opts.body).toContain('data-ra-remove="FAS"');
    await fakeModal.st.panel.chips[0].fire('click');
    expect(fakeModal.close.mock.invocationCallOrder[0]).toBeLessThan(window.relayWrites.escalate.mock.invocationCallOrder[0]);
    expect(window.relayWrites.escalate).toHaveBeenCalledWith({ workRequestId: WR, aaid: 'AAID1', add: [], remove: ['FAS'],
      comment: '', unit: '322168', aiDrafted: false });
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
  });

  it('Carrier Update Request removal needs a typed comment', async () => {
    await openEsc(['MCS_CARRIER_UPDATE_REQUEST']);
    await fakeModal.st.panel.chips[0].fire('click');
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
    expect(q('#ra-esc-reason').focus).toHaveBeenCalled();
    await type('#ra-esc-reason', 'CARRIER UPDATED');
    await fakeModal.st.panel.chips[0].fire('click');
    expect(window.relayWrites.escalate).toHaveBeenCalledWith(expect.objectContaining({
      add: [], remove: ['MCS_CARRIER_UPDATE_REQUEST'], comment: 'CARRIER UPDATED' }));
  });

  it('opts.initialTarget pre-selects HVE when offered, shows the amount row, and drafts/sends nothing on its own', async () => {
    fakeModal.st.panel = mkPanel();
    await ra.openEscalationModal(UNIT, WR, deps, { initialTarget: 'MCS_HIGH_VALUE_ESTIMATE' });
    expect(q('#ra-esc-target').value).toBe('MCS_HIGH_VALUE_ESTIMATE');
    expect(q('#ra-esc-hve').hidden).toBe(false);
    expect(window.relayWrites.draftAction).not.toHaveBeenCalled();
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
    await type('#ra-esc-reason', 'OFFSITE EST SUBMITTED - PLEASE REVIEW');
    await action('Submit escalation').onClick();
    expect(window.relayWrites.escalate).toHaveBeenCalledTimes(1);
    expect(window.relayWrites.escalate.mock.calls[0][0]).toMatchObject({ workRequestId: WR, add: ['MCS_HIGH_VALUE_ESTIMATE'], remove: [] });
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
  });

  it('opts.initialTarget is ignored when AAP does not offer that target', async () => {
    window.aapApi.escalationOptions.mockImplementation(async () => ({ ok: true, enabled: true,
      options: LIVE.filter((o) => o.value !== 'MCS_HIGH_VALUE_ESTIMATE'), current: [] }));
    fakeModal.st.panel = mkPanel();
    await ra.openEscalationModal(UNIT, WR, deps, { initialTarget: 'MCS_HIGH_VALUE_ESTIMATE' });
    expect(q('#ra-esc-target').value).toBe('');
    expect(q('#ra-esc-hve').hidden).toBe(true);
  });

  it('not enabled for the user → an explanation modal with only Close', async () => {
    window.aapApi.escalationOptions.mockImplementation(async () => ({ ok: true, enabled: false, options: [], current: [] }));
    fakeModal.st.panel = mkPanel();
    await ra.openEscalationModal(UNIT, WR, deps);
    expect(fakeModal.st.opts.body).toContain('not enabled for your AAP user');
    expect(fakeModal.st.opts.actions.map((a) => a.label)).toEqual(['Close']);
  });
});

describe('comment modal', () => {
  async function openCm() {
    fakeModal.st.panel = mkPanel();
    await ra.openCommentModal(UNIT, WR, deps);
  }
  it('offers the 3 templates; Offsite Update draft uses draftAction; submit posts via bridge.addComment only', async () => {
    await openCm();
    expect(fakeModal.st.opts.title).toBe('Add Relay comment \u2014 WR 0a1b2c3d');
    expect(optionTexts(fakeModal.st.opts.body)).toEqual(['Offsite Update', 'Update Request', 'Free-form']);
    window.relayWrites.draftAction.mockImplementation(async () => ({ ok: true, draft: 'OFFSITE - RUSH - 322168 - <FILL: component>',
      placeholders: ['component'], freshness: { warnings: [] } }));
    await choose('#ra-cm-template', 'offsite-update');
    await q('#ra-cm-draft').fire('click');
    expect(window.relayWrites.draftAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'comment', template: 'offsite-update',
      workRequestId: WR, userInputs: {} }));
    expect(q('#ra-cm-text').value).toBe('OFFSITE - RUSH - 322168 - <FILL: component>');
    await action('Submit comment').onClick();
    expect(fakeModal.close.mock.invocationCallOrder[0]).toBeLessThan(window.relayWrites.addComment.mock.invocationCallOrder[0]);
    expect(window.relayWrites.addComment).toHaveBeenCalledWith(WR, 'OFFSITE - RUSH - 322168 - <FILL: component>', '322168', { aiDrafted: true });
    expect(window.relayWrites.escalate).not.toHaveBeenCalled();
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
  });
  it('Update Request draft passes its template; a typed comment posts without the AI flag', async () => {
    await openCm();
    await choose('#ra-cm-template', 'update-request');
    await q('#ra-cm-draft').fire('click');
    expect(window.relayWrites.draftAction.mock.calls[0][0].template).toBe('update-request');
    await openCm();
    await type('#ra-cm-text', 'parts eta 11/20');
    await action('Submit comment').onClick();
    expect(window.relayWrites.addComment).toHaveBeenCalledWith(WR, 'parts eta 11/20', '322168');
  });
  it('Free-form draft reuses draftComment, caps it (keeping URLs) and shows a local freshness warning', async () => {
    await openCm();
    await choose('#ra-cm-template', 'free-form');
    await q('#ra-cm-draft').fire('click');
    expect(window.relayWrites.draftAction).not.toHaveBeenCalled();
    expect(window.relayWrites.draftComment).toHaveBeenCalledWith(WR, expect.objectContaining({ equipmentId: '322168' }));
    expect(q('#ra-cm-text').value).toBe('VENDOR SAYS PARTS ETA FRIDAY, SEE https://x.example/Path');
    expect(q('#ra-stale').textContent).toContain('freshness unknown');
  });
  it('localFreshnessWarnings warns when no Relay conversation is loaded (B5)', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const fresh = new Date(now - 3600000).toISOString();
    expect(ra.localFreshnessWarnings({ asistScrapedAt: fresh, scrapedAt: fresh, fullConversation: '' }, now)).toEqual(['No Relay conversation loaded']);
    expect(ra.localFreshnessWarnings({ asistScrapedAt: fresh, scrapedAt: fresh, fullConversation: 'Conversation\n11/19 - x' }, now)).toEqual([]);
  });
  it('a secondary-card draft sends the clicked WR; free-form freshness uses that WR entry', async () => {
    const SEC = '0a1b2c3d-1111-2222-3333-777777777777';
    const u = Object.assign({}, UNIT, { fullConversation: 'Conversation\n11/19 - primary', scrapedAt: new Date().toISOString(),
      _secondaryWRs: [{ workRequestId: SEC, vendor: 'Volvo', fullConversation: '' }] });
    fakeModal.st.panel = mkPanel();
    await ra.openCommentModal(u, SEC, deps);
    await choose('#ra-cm-template', 'offsite-update');
    await q('#ra-cm-draft').fire('click');
    expect(window.relayWrites.draftAction).toHaveBeenCalledWith(expect.objectContaining({ workRequestId: SEC, unit: expect.objectContaining({ equipmentId: '322168' }) }));
    await choose('#ra-cm-template', 'free-form');
    await type('#ra-cm-text', '');
    await q('#ra-cm-draft').fire('click');
    expect(window.relayWrites.draftComment).toHaveBeenCalledWith(SEC, expect.objectContaining({ equipmentId: '322168' }));
    expect(q('#ra-stale').textContent).toContain('No Relay conversation loaded');
    expect(ra.wrUnitOf(u, SEC)).toMatchObject({ workRequestId: SEC, vendor: 'Volvo' });
    expect(ra.wrUnitOf(u, UNIT.workRequestId)).toBe(u);
  });
  it('empty text is refused', async () => {
    await openCm();
    await action('Submit comment').onClick();
    expect(window.relayWrites.addComment).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
  });
});

describe('lifecycle modal', () => {
  async function openLc() {
    fakeModal.st.panel = mkPanel();
    await ra.openLifecycleModal(UNIT, deps);
  }
  it('lists states from lifecycleOptions (no END_OF_LIFE) and shows the current state', async () => {
    await openLc();
    const b = fakeModal.st.opts.body;
    expect(fakeModal.st.opts.title).toBe('Change lifecycle \u2014 322168');
    expect(b).toContain('Current: <b>Unavailable</b>');
    expect(b).not.toMatch(/end.of.life/i);
    expect(b).toContain('<option value="Unavailable" selected>');
    expect(b).toContain('You will confirm, then approve, before AAP changes.');
  });
  it('confirm → false sends nothing; the modal stays open', async () => {
    deps.confirm = vi.fn(() => false);
    await openLc();
    await choose('#ra-lc-state', 'Active');
    await action('Change lifecycle').onClick();
    expect(deps.confirm).toHaveBeenCalledWith('Change 322168 Unavailable \u2192 Active in AAP?');
    expect(window.relayWrites.changeLifecycle).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
  });
  it('confirm → true calls changeLifecycle(confirmed:true) after close, never raw setLifecycle, then verifies', async () => {
    await openLc();
    await choose('#ra-lc-state', 'Active');
    expect(q('#ra-lc-reason').value).toBe('HEALTHY');
    await action('Change lifecycle').onClick();
    expect(ra.lifecycleConfirmText('322168', 'Unavailable', 'Active')).toBe('Change 322168 Unavailable \u2192 Active in AAP?');
    expect(deps.confirm).toHaveBeenCalledWith('Change 322168 Unavailable \u2192 Active in AAP?');
    expect(window.relayWrites.changeLifecycle).toHaveBeenCalledWith({ equipmentId: '322168', assetUrl: ASSET, state: 'Active',
      reason: 'HEALTHY', fromState: 'Unavailable', confirmed: true });
    expect(fakeModal.close.mock.invocationCallOrder[0]).toBeLessThan(window.relayWrites.changeLifecycle.mock.invocationCallOrder[0]);
    expect(window.aap.setLifecycle).not.toHaveBeenCalled();
    expect(deps.verifyLifecycle).toHaveBeenCalledWith(UNIT, 'Active', 'HEALTHY');
    expect(toast.show.mock.calls.at(-1)[1]).toContain('confirmed live in AAP');
  });
  it('the unchanged current state is refused', async () => {
    await openLc();
    await choose('#ra-lc-state', 'Unavailable');
    await action('Change lifecycle').onClick();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(window.relayWrites.changeLifecycle).not.toHaveBeenCalled();
  });
});

describe('card and header buttons', () => {
  it('wrCardActionRowHtml: a row for an open UUID WR, empty for closed or non-UUID', () => {
    const h = ra.wrCardActionRowHtml({ workRequestId: WR, serviceState: 'Work In Progress' });
    expect(h).toContain('class="dp-ra-row"');
    expect(h).toContain('data-ra-escalate="' + WR + '"');
    expect(h).toContain('data-ra-comment="' + WR + '"');
    expect(h).toContain('dp-escalate__btn dp-ra-btn');
    expect(ra.wrCardActionRowHtml({ workRequestId: WR, completed: '2026-11-01' })).toBe('');
    expect(ra.wrCardActionRowHtml({ workRequestId: WR, serviceState: 'Closed' })).toBe('');
    expect(ra.wrCardActionRowHtml({ workRequestId: WR, serviceState: 'Cancelled' })).toBe('');
    expect(ra.wrCardActionRowHtml({ workRequestId: 'svc-m1-u' })).toBe('');
    expect(ra.wrCardActionRowHtml(null)).toBe('');
  });

  it('renderRepairPane / plannedWrCardHtml / secondaryWrCardsHtml carry the row for open UUID WRs', () => {
    vi.useFakeTimers(); // renderRepairPane schedules DOM wiring; never run it here
    try {
      const planned = { workRequestId: '', _serviceUUID: WR2, vendor: 'Amerit', serviceState: 'Open' };
      const u = { equipmentId: '322168', workRequestId: WR, vendor: 'Rush', relaySynced: true, serviceState: 'Work In Progress',
        lifecycleReason: 'PM Failed', _plannedWRData: planned, _secondaryWRs: [] };
      expect(m.renderRepairPane(u)).toContain('data-ra-escalate="' + WR + '"');
      expect(m.plannedWrCardHtml(u)).toContain('data-ra-escalate="' + WR2 + '"');
      const s = { equipmentId: '322168', lifecycleReason: 'Offsite Shop Repair',
        _secondaryWRs: [{ workRequestId: WR2, serviceState: 'Open' }, { workRequestId: 'svc-x', serviceState: 'Open' },
          { workRequestId: '11111111-2222-3333-4444-555555555555', serviceState: 'Closed' }] };
      const sh = m.secondaryWrCardsHtml(s);
      expect(sh).toContain('data-ra-comment="' + WR2 + '"');
      expect(sh.split('data-ra-escalate=').length - 1).toBe(1);
      const closed = Object.assign({}, u, { completed: '2026-11-01', _plannedWRData: null });
      expect(m.renderRepairPane(closed)).not.toContain('data-ra-escalate=');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('headerLifecycleButtonHtml is a ⟳ icon launcher, present only with an assetUrl', () => {
    const h = ra.headerLifecycleButtonHtml(UNIT);
    expect(h).toContain('id="dp-lc-change"');
    expect(h).toContain('class="dp-launcher"');
    expect(h).toContain('title="Change Lifecycle"');
    expect(h).toMatch(/>\u27F3<\/button>$/);
    expect(h).not.toContain('dp-launcher--lc');
    expect(ra.headerLifecycleButtonHtml({ equipmentId: 'X' })).toBe('');
  });

  it('renderHeader puts the ⟳ Change Lifecycle icon inside the launcher cluster; clicking it opens the lifecycle modal', async () => {
    const u = Object.assign({}, UNIT, { serviceUrl: 'https://relay.amazon.com/x/' + WR });
    const h = m.renderHeader(u);
    const cluster = /<div class="dp-header__launchers">([\s\S]*?)<\/div>/.exec(h);
    expect(cluster).not.toBeNull();
    expect(cluster[1]).toContain('id="dp-lc-change"');
    expect(cluster[1]).toContain('data-aap-url=');
    expect(h.split('id="dp-lc-change"').length - 1).toBe(1);
    expect(h.indexOf('id="dp-lc-change"')).toBeGreaterThan(h.indexOf('class="dp-header__launchers"'));
    expect(h).not.toContain('\u27F3 Change Lifecycle');
    expect(m.renderHeader({ equipmentId: 'X' })).not.toContain('dp-lc-change');
    const lc = el();
    const root = { querySelectorAll: () => [], querySelector: (s) => (s === '#dp-lc-change' ? lc : null) };
    fakeModal.st.panel = mkPanel();
    ra.wireRelayActions(root, u, deps);
    await lc.fire('click');
    expect(window.relayWrites.lifecycleOptions).toHaveBeenCalledTimes(1);
    expect(fakeModal.st.opts.title).toBe('Change lifecycle \u2014 322168');
    expect(fakeModal.st.opts.actions.map((a) => a.label)).toEqual(['Cancel', 'Change lifecycle']);
  });

  it('Repair tab no longer renders the old Escalation card or Add-comment box; WR-card buttons still render', () => {
    vi.useFakeTimers();
    try {
      const u = { equipmentId: '322168', workRequestId: WR, assetUrl: ASSET, vendor: 'Rush', relaySynced: true,
        serviceState: 'Work In Progress', repairTimeline: '11/18 vendor update', _secondaryWRs: [] };
      const h = m.renderRepairPane(u);
      for (const gone of ['dp-escalate-wrap', 'dp-relay-comment-', 'Add comment to Relay', 'Send to Relay',
        '>Escalation</div>', 'dp-escalate-team', 'dp-escalate-send']) expect(h).not.toContain(gone);
      expect(h).toContain('data-ra-escalate="' + WR + '"');
      expect(h).toContain('data-ra-comment="' + WR + '"');
      expect(h).toContain('\u26A0 Escalate');
      expect(h).toContain('\uD83D\uDCAC Add Relay Comment');
      for (const sym of ['escalationAaid', 'relayCommentTarget', 'relayCommentComposeHtml', 'wireRelayComment',
        'buildEscalationPayload', 'validateEscalationDraft']) expect(m[sym]).toBeUndefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('wireRelayActions opens the matching modal from each button', async () => {
    const esc = el(); esc.attrs['data-ra-escalate'] = WR;
    const cm = el(); cm.attrs['data-ra-comment'] = WR;
    const lc = el();
    const root = {
      querySelectorAll: (s) => (s === '[data-ra-escalate]' ? [esc] : s === '[data-ra-comment]' ? [cm] : []),
      querySelector: (s) => (s === '#dp-lc-change' ? lc : null),
    };
    fakeModal.st.panel = mkPanel();
    ra.wireRelayActions(root, UNIT, deps);
    await esc.fire('click');
    expect(fakeModal.st.opts.title).toBe('Escalate WR 0a1b2c3d');
    await cm.fire('click');
    expect(fakeModal.st.opts.title).toBe('Add Relay comment \u2014 WR 0a1b2c3d');
    await lc.fire('click');
    expect(fakeModal.st.opts.title).toBe('Change lifecycle \u2014 322168');
  });

  it('pure helpers: stateLabel, draft-unit whitelist, toCapsKeepFills, outcomeMessage', () => {
    expect(ra.stateLabel('UNAVAILABLE')).toBe('Unavailable');
    expect(ra.stateLabel('ORDERED')).toBe('Ordered');
    const du = ra.relayActionDraftUnit({ equipmentId: '1', estimatePendingCost: 4850, assetUrl: 'x', _plannedWRData: {} });
    expect(du).toEqual({ equipmentId: '1', estimatePendingCost: '4850' });
    expect(ra.toCapsKeepFills('est <FILL: est amount> at https://a.b/Xy')).toBe('EST <FILL: est amount> AT https://a.b/Xy');
    expect(ra.outcomeMessage({ outcome: 'sent' }, 'Escalation').level).toBe('success');
    expect(ra.outcomeMessage({ outcome: 'pending-approval' }).level).toBe('info');
    expect(ra.outcomeMessage({ outcome: 'skipped-not-approved' }).text).toBe('Not sent.');
    expect(ra.outcomeMessage({ outcome: 'send-failed', error: 'x' }, 'Escalation').text).toBe('Escalation failed: x');
  });
});
