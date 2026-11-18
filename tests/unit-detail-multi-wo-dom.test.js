// tests/unit-detail-multi-wo-dom.test.js
// Unit detail → Repair tab work-order cards for a unit with more than one open
// WO. The secondary entries are built with the real mapper (toSecondaryWR), the
// same shape buildFleetDataset / refreshUnit attach, and rendered through the
// exported card helpers renderRepairPane uses. Also: the long-dwell AI feed
// lists a WO that is both _plannedWRData and a _secondaryWRs entry once.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { MULTI } from './fixtures/fleet-build/aap-fleet-fixture.js';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');
const { sourceContextWithMeta } = await import('../renderer/src/js/longdwell-ai.js');
const require = createRequire(import.meta.url);
const mapper = require('../src/scrapers/aap_api_mapper');

const W = MULTI.wos;
const sec = (wo, wrType, detail) => mapper.toSecondaryWR(wo, detail || null, { wrType });
const count = (s, sub) => s.split(sub).length - 1;
function unitM1001(reason) {
  const planned = sec(W.m1p, 'planned');
  return { equipmentId: 'M1001', workRequestId: 'svc-m1-u', vendor: 'Amerit', relaySynced: true, lifecycleState: 'Unavailable',
    lifecycleReason: reason, _secondaryWRs: [planned], _plannedWRData: planned };
}

describe('repair pane WO cards', () => {
  it('1 unplanned + 1 planned, Offsite Shop Repair: the planned WO renders as a secondary card with Split View', () => {
    const u = unitM1001('Offsite Shop Repair');
    expect(m.plannedWrCardHtml(u)).toBe('');
    const h = m.secondaryWrCardsHtml(u);
    expect(count(h, 'dp-wo-card--planned')).toBe(1);
    expect(h).toContain('Planned Work Order');
    expect(h).toContain('svc-m1-p');
    expect(h).toContain('data-split-left="https://aap-na.corp.amazon.com/v2/service/svc-m1-p"');
  });
  it('PM Failed: the planned card renders once and the secondary list skips it', () => {
    const u = unitM1001('PM Failed');
    const p = m.plannedWrCardHtml(u);
    const s = m.secondaryWrCardsHtml(u);
    expect(p).toContain('Planned Work Order');
    expect(p).toContain('svc-m1-p');
    expect(s).not.toContain('svc-m1-p');
    expect(count(p + s, '<span class="dp-wo-field__v">svc-m1-p</span>')).toBe(1);
  });
  it('2 unplanned + 1 planned (FLD260703 shape): one card per other open WO, titled by type', () => {
    const planned = sec(W.m3p, 'planned');
    const u = { equipmentId: 'M1003', workRequestId: 'svc-m3-u1', lifecycleReason: 'Offsite Shop Repair',
      _secondaryWRs: [sec(W.m3u2, 'unplanned'), planned], _plannedWRData: planned };
    const h = m.secondaryWrCardsHtml(u);
    expect(count(h, 'dp-wo-card--planned')).toBe(2);
    expect(h.indexOf('Unplanned Work Order')).toBeGreaterThanOrEqual(0);
    expect(h.indexOf('Unplanned Work Order')).toBeLessThan(h.indexOf('svc-m3-u2'));
    expect(h.indexOf('svc-m3-u2')).toBeLessThan(h.lastIndexOf('Planned Work Order'));
    expect(h.lastIndexOf('Planned Work Order')).toBeLessThan(h.indexOf('svc-m3-p'));
  });
  it('single open WO: no extra cards', () => {
    const u = { equipmentId: 'M1002', workRequestId: 'svc-m2-u', lifecycleReason: 'PM Failed', _secondaryWRs: [], _plannedWRData: null };
    expect(m.plannedWrCardHtml(u)).toBe('');
    expect(m.secondaryWrCardsHtml(u)).toBe('');
  });
});

describe('long-dwell AI feed', () => {
  it('a planned WO in both _plannedWRData and _secondaryWRs is listed once', () => {
    const detail = { workRequest: { comments: [{ timestamp: '2026-11-10T14:00:00Z', createdBy: 'Vendor', text: 'pm scheduled for friday' }] } };
    const planned = sec(W.m1p, 'planned', detail);
    const row = { equipmentId: 'M1001', fullConversation: '', _plannedWRData: planned, _secondaryWRs: [planned] };
    const { text } = sourceContextWithMeta(row, { fullContext: true });
    expect(text).toContain('[WO #1');
    expect(text).not.toContain('[WO #2');
    expect(count(text, 'pm scheduled for friday')).toBe(1);
  });
});
