// tests/dtna-stage-actions-dom.test.js — unit detail "⇢ Change Stage" (DTNA Phase C,
// renderer/src/js/views/dtna-stage-actions.js) against a recording fake modal.js and fake elements.
// The picker is forward-only; Submit closes the modal before the gated changeStage resolves; nothing auto-sends.
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

const S = await import('../renderer/src/js/views/dtna-stage-actions.js');

const CASE = '500gx000002E4U5AAK';
const DTNA = 'https://dtna.my.site.com/Servicetracker/s/case/' + CASE + '/detail';
const UNIT = { equipmentId: '122269', vendor: 'HORWITH FREIGHTLINER', offsiteShopEventUrl: DTNA };
const STAGES = ['Pre-Repair', 'Arrived', 'In-Repair', 'Post-Repair', 'Ready for Pickup', 'Closed'];
const OPTS = { ok: true, configured: true, current: 'In-Repair', currentIndex: 2, targets: ['Post-Repair', 'Ready for Pickup', 'Closed'], stages: STAGES };

function el(extra = {}) {
  return Object.assign({
    value: '', disabled: false, textContent: '', listeners: {}, attrs: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    fire(ev) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: this }))); },
  }, extra);
}
let sel; let toast; let bridge; let confirm;
async function open(over = {}) {
  sel = { '#dtna-st-target': el({ value: ((over.opts || OPTS).targets || [])[0] || '' }), '#dtna-st-change': el(), '[data-modal-action="1"]': el() };
  fakeModal.st.panel = { querySelector: (s) => sel[s] || null };
  fakeModal.st.opts = null;
  toast = { show: vi.fn() };
  confirm = over.confirm || vi.fn(() => true);
  bridge = Object.assign({
    stageOptions: vi.fn(async () => over.opts || OPTS),
    changeStage: vi.fn(async (p) => { fakeModal.st.order.push('change'); return { ok: true, outcome: 'sent', id: 'rw_1', fromStage: 'In-Repair', toStage: p.target, currentStage: p.target, confirmed: true }; }),
    login: vi.fn(async () => ({ ok: true, state: 'connected' })),
  }, over.bridge || {});
  await S.openDtnaStageModal(UNIT, { caseId: CASE }, { modal: fakeModal, toast, bridge, confirm });
}
const action = (label) => fakeModal.st.opts.actions.find((a) => a.label === label);
const options = (body) => [...body.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

beforeEach(() => {
  fakeModal.show.mockClear();
  fakeModal.close.mockClear();
  fakeModal.st.order = [];
});

describe('dtnaStageButtonHtml', () => {
  it('shows for a DTNA case URL only; escapes the equipment id', () => {
    const h = S.dtnaStageButtonHtml(UNIT, DTNA);
    expect(h).toContain('data-dtna-stage="122269"');
    expect(h).toContain('data-dtna-case="' + CASE + '"');
    expect(h).toContain('\u21e2 Change Stage</button>');
    expect(h).toContain('visible to the dealer');
    expect(S.dtnaStageButtonHtml(UNIT, 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146')).toBe('');
    expect(S.dtnaStageButtonHtml(UNIT, '')).toBe('');
    expect(S.dtnaStageButtonHtml({}, DTNA)).toBe('');
    const e = S.dtnaStageButtonHtml({ equipmentId: 'a"b<c>' }, DTNA);
    expect(e).toContain('data-dtna-stage="a&quot;b&lt;c&gt;"');
    expect(e).not.toContain('a"b');
  });
});

describe('openDtnaStageModal', () => {
  it('forward-only picker: only later stages, current shown, change line, dealer-visible hint; nothing sent on open', async () => {
    await open();
    expect(bridge.stageOptions).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE });
    expect(fakeModal.show).toHaveBeenCalledTimes(1);
    const o = fakeModal.st.opts;
    expect(o.title).toBe('Change DTNA stage \u2014 case \u2026' + CASE.slice(-6));
    expect(options(o.body)).toEqual([['Post-Repair', 'Post-Repair'], ['Ready for Pickup', 'Ready for Pickup'], ['Closed', 'Closed (truck picked up)']]);
    for (const earlier of ['Pre-Repair', 'Arrived', 'In-Repair']) expect(o.body).not.toContain('<option value="' + earlier + '"');
    expect(o.body).toContain('Current stage: <b id="dtna-st-current">In-Repair</b>');
    expect(o.body).toContain('<div class="dp-escalate__row" id="dtna-st-change">In-Repair \u2192 Post-Repair</div>');
    expect(o.body).toContain('Visible to the dealer');
    expect(o.body).toContain('Nothing is sent until you approve');
    expect(o.actions.map((a) => a.label)).toEqual(['Cancel', 'Submit for approval']);
    expect(sel['[data-modal-action="1"]'].disabled).toBe(false);
    sel['#dtna-st-target'].value = 'Closed';
    await sel['#dtna-st-target'].fire('change');
    expect(sel['#dtna-st-change'].textContent).toBe('In-Repair \u2192 Closed');
    expect(bridge.changeStage).not.toHaveBeenCalled();
  });

  it('not configured or no later stage -> Submit disabled with a note; clicking sends nothing', async () => {
    await open({ opts: Object.assign({}, OPTS, { configured: false }) });
    expect(fakeModal.st.opts.body).toContain('Stage changes are not set up yet. Nothing can be sent.');
    expect(sel['[data-modal-action="1"]'].disabled).toBe(true);
    await action('Submit for approval').onClick();
    expect(bridge.changeStage).not.toHaveBeenCalled();
    expect(fakeModal.close).not.toHaveBeenCalled();
    await open({ opts: Object.assign({}, OPTS, { current: 'Closed', currentIndex: 5, targets: [] }) });
    expect(fakeModal.st.opts.body).toContain('This case is already at its last stage.');
    expect(options(fakeModal.st.opts.body)).toEqual([]);
    expect(sel['[data-modal-action="1"]'].disabled).toBe(true);
    await action('Submit for approval').onClick();
    expect(bridge.changeStage).not.toHaveBeenCalled();
  });

  it('Submit closes the modal BEFORE changeStage resolves, sends once with { equipmentId, caseId, target }; double click sends once', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await open({ bridge: { changeStage: vi.fn(async (p) => { fakeModal.st.order.push('change'); await gate; return { ok: true, outcome: 'sent', id: 'rw_1', fromStage: 'In-Repair', toStage: p.target, currentStage: p.target, confirmed: true }; }) } });
    sel['#dtna-st-target'].value = 'Closed';
    const p1 = action('Submit for approval').onClick();
    const p2 = action('Submit for approval').onClick();
    await Promise.resolve();
    expect(fakeModal.st.order).toEqual(['close', 'change']);
    expect(toast.show).toHaveBeenCalledWith('info', 'Waiting for your approval\u2026', 3000);
    release();
    await Promise.all([p1, p2]);
    expect(bridge.changeStage).toHaveBeenCalledTimes(1);
    expect(bridge.changeStage).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE, target: 'Closed' });
    expect(toast.show).toHaveBeenLastCalledWith('success', 'DTNA case \u2026' + CASE.slice(-6) + ' moved to Closed.');
  });

  it('a target outside the offered list is never sent (falls back to the first later stage)', async () => {
    await open();
    sel['#dtna-st-target'].value = 'Pre-Repair';
    await action('Submit for approval').onClick();
    expect(bridge.changeStage).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE, target: 'Post-Repair' });
  });

  it('SESSION_LOW: confirm -> login once and no result toast; declined -> warn toast', async () => {
    await open({ bridge: { changeStage: vi.fn(async () => ({ ok: false, code: 'DTNA_SESSION_LOW', remainingSec: 30 })) } });
    await action('Submit for approval').onClick();
    expect(confirm).toHaveBeenCalledWith('Your DTNA session expires in under 2 minutes (or has expired). Sign in again now?');
    expect(bridge.login).toHaveBeenCalledTimes(1);
    await open({ confirm: vi.fn(() => false), bridge: { changeStage: vi.fn(async () => ({ ok: false, code: 'DTNA_SESSION_LOW', remainingSec: 30 })) } });
    await action('Submit for approval').onClick();
    expect(bridge.login).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenLastCalledWith('warn', 'Your DTNA session is about to expire. Sign in again, then change the stage. Nothing was sent.');
  });

  it('a failed stageOptions (not pulled) -> toast and no modal', async () => {
    await open({ opts: { ok: false, code: 'DTNA_NOT_PULLED' } });
    expect(fakeModal.show).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith('warn', 'Pull DTNA for this unit first.');
    expect(bridge.changeStage).not.toHaveBeenCalled();
  });

  it('Cancel closes with no call', async () => {
    await open();
    action('Cancel').onClick();
    expect(fakeModal.close).toHaveBeenCalledTimes(1);
    expect(bridge.changeStage).not.toHaveBeenCalled();
  });
});

describe('stageMessage', () => {
  it('maps results to toasts', () => {
    const tag = CASE.slice(-6);
    expect(S.stageMessage({ ok: true, outcome: 'sent', toStage: 'Closed', currentStage: 'Closed', confirmed: true }, CASE))
      .toEqual({ level: 'success', text: 'DTNA case \u2026' + tag + ' moved to Closed.' });
    expect(S.stageMessage({ ok: true, outcome: 'sent', toStage: 'Closed', currentStage: 'In-Repair', confirmed: false }, CASE))
      .toEqual({ level: 'warn', text: 'Stage change sent, but DTNA shows In-Repair. Open the case in DTNA to check.' });
    expect(S.stageMessage({ ok: false, code: 'DTNA_STAGE_NOT_CONFIGURED' }, CASE)).toEqual({ level: 'warn', text: 'Changing the DTNA stage is not set up yet. Nothing was sent.' });
    expect(S.stageMessage({ ok: false, code: 'DTNA_STAGE_NOT_FORWARD', currentStage: 'Closed' }, CASE))
      .toEqual({ level: 'warn', text: 'DTNA now shows Closed; only a later stage can be chosen. Nothing was sent.' });
    expect(S.stageMessage({ ok: false, code: 'DTNA_SESSION_LOW' }, CASE).level).toBe('warn');
    expect(S.stageMessage({ ok: false, code: 'DTNA_STAGE_REJECTED' }, CASE).level).toBe('error');
    expect(S.stageMessage({ ok: false, outcome: 'pending-approval', id: 'rw_2' }, CASE)).toEqual({ level: 'info', text: 'Queued in Relay writes. Approve it there to send.' });
    expect(S.stageMessage({ ok: false, outcome: 'skipped-not-approved' }, CASE)).toEqual({ level: 'info', text: 'Not sent.' });
  });
});
