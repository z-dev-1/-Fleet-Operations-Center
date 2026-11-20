// tests/unit-detail-id-links-dom.test.js — Repair tab WR fields (WR ID / AMZ ID /
// SF Case / Vendor WO) render as clickable in-app links only when a safe URL
// resolves, and a click calls the aap:open-url opener with { zoom: true }
// (never files.openExternal, never the split view). Synthetic data only.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');
const require = createRequire(import.meta.url);
const { buildSalesforceUrl } = require('../src/utils/salesforce-url');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SVC = 'https://aap-na.corp.amazon.com/v2/service/svc-1';
const OFFSITE = 'https://pssmfleet.decisiv.net/x';
const SF = buildSalesforceUrl('12345678');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const linkOf = (h, field) => {
  const mm = h.match(new RegExp('data-id-link="([^"]*)" data-id-link-field="' + field + '"'));
  return mm ? mm[1] : null;
};
const wo = (extra = {}) => ({ workRequestId: 'svc-1', alternativeId: 'amz-abc', salesforceCase: '12345678', serviceCategory: 'Brakes',
  totalCost: '$100', vendor: 'Amerit', ...extra });

describe('pure helpers', () => {
  it('buildSalesforceCaseUrl matches the main-process builder', () => {
    expect(m.buildSalesforceCaseUrl('12345678')).toBe(SF);
    expect(m.buildSalesforceCaseUrl('')).toBe('');
    expect(m.buildSalesforceCaseUrl('a"b')).toBe('');
  });
  it('isSafeIdLinkUrl: https + allow-listed hosts only', () => {
    expect(m.isSafeIdLinkUrl(SVC)).toBe(true);
    expect(m.isSafeIdLinkUrl(SF)).toBe(true);
    expect(m.isSafeIdLinkUrl(OFFSITE)).toBe(true);
    for (const bad of ['javascript:alert(1)', 'http://aap-na.corp.amazon.com/x', 'https://evil.example.com/x',
      'https://aap-na.corp.amazon.com/x"onclick=1', '', null]) expect(m.isSafeIdLinkUrl(bad), String(bad)).toBe(false);
  });
  it('idLinkUrl per field', () => {
    expect(m.idLinkUrl('WR ID', { serviceUrl: SVC })).toBe(SVC);
    expect(m.idLinkUrl('AMZ ID', { _relayUrl: SVC })).toBe(SVC);
    expect(m.idLinkUrl('WR ID', { _serviceUUID: 'svc-1' })).toBe(SVC);
    expect(m.idLinkUrl('WR ID', { _serviceUUID: 'bad/../x' })).toBe('');
    expect(m.idLinkUrl('SF Case', { salesforceCaseUrl: SF })).toBe(SF);
    expect(m.idLinkUrl('SF Case', { savedSalesforceCaseUrl: 'https://evil.example.com', salesforceCase: '12345678' })).toBe(SF);
    expect(m.idLinkUrl('Vendor WO', { savedOffsiteUrl: OFFSITE })).toBe(OFFSITE);
    expect(m.idLinkUrl('Vendor WO', { offsiteShopEventUrl: OFFSITE, _offsiteWrId: 'other', workRequestId: 'svc-1' })).toBe('');
    expect(m.idLinkUrl('Category', { serviceUrl: SVC })).toBe('');
  });
  it('woFieldHtml: unlinked output is the legacy chip byte-for-byte', () => {
    expect(m.woFieldHtml(['WR ID', 'svc-1'], {})).toBe('<span class="dp-wo-field"><span class="dp-wo-field__k">WR ID</span><span class="dp-wo-field__v">svc-1</span></span>');
    const l = m.woFieldHtml(['WR ID', 'svc-1'], { serviceUrl: SVC });
    expect(l).toContain('<span class="dp-wo-field__v">svc-1</span>');
    expect(l).toContain('role="link"');
    expect(linkOf(l, 'wr')).toBe(SVC);
  });
});

describe('cards', () => {
  it('main WR card (renderRepairPane): WR ID / AMZ ID / SF Case / Vendor WO link to their URLs', () => {
    vi.useFakeTimers();
    const hadWindow = 'window' in globalThis;
    if (!hadWindow) globalThis.window = {};
    try {
      const u = wo({ equipmentId: 'U1', relaySynced: true, serviceUrl: SVC, vendorWorkOrderId: 'VWO-9', offsiteShopEventUrl: OFFSITE,
        _secondaryWRs: [], _plannedWRData: null });
      const h = m.renderRepairPane(u);
      expect(linkOf(h, 'wr')).toBe(SVC);
      expect(linkOf(h, 'amz')).toBe(SVC);
      expect(linkOf(h, 'sf')).toBe(attr(SF));
      expect(linkOf(h, 'vendor-wo')).toBe(OFFSITE);
      expect(h).toContain('<span class="dp-wo-field__v">svc-1</span>');
      expect(h).toContain('<span class="dp-wo-field"><span class="dp-wo-field__k">Category</span>');
      expect(h).toContain('<span class="dp-wo-field"><span class="dp-wo-field__k">Total Cost</span>');

      const plain = m.renderRepairPane(wo({ equipmentId: 'U2', relaySynced: true, salesforceCase: '', vendorWorkOrderId: 'VWO-9',
        _secondaryWRs: [], _plannedWRData: null }));
      expect(plain).not.toContain('data-id-link');
      expect(plain).toContain('<span class="dp-wo-field"><span class="dp-wo-field__k">WR ID</span><span class="dp-wo-field__v">svc-1</span></span>');
      expect(plain).toContain('<span class="dp-wo-field"><span class="dp-wo-field__k">Vendor WO</span><span class="dp-wo-field__v">VWO-9</span></span>');

      const unsafe = m.renderRepairPane(wo({ equipmentId: 'U3', relaySynced: true, salesforceCase: '', serviceUrl: 'javascript:alert(1)',
        vendorWorkOrderId: 'VWO-9', offsiteShopEventUrl: 'http://pssmfleet.decisiv.net/x', savedOffsiteUrl: 'https://evil.example.com/x',
        _secondaryWRs: [], _plannedWRData: null }));
      expect(unsafe).not.toContain('data-id-link');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      if (!hadWindow) delete globalThis.window;
    }
  });
  it('planned card (PM Failed) links from _serviceUUID and the SF case number', () => {
    const p = wo({ _serviceUUID: 'svc-1' });
    const h = m.plannedWrCardHtml({ lifecycleReason: 'PM Failed', _plannedWRData: p });
    expect(linkOf(h, 'wr')).toBe(SVC);
    expect(linkOf(h, 'amz')).toBe(SVC);
    expect(linkOf(h, 'sf')).toBe(attr(SF));
    expect(h).toContain('data-split-left="' + SVC + '"'); // Split View unchanged
  });
  it('secondary cards link from _relayUrl; no URL -> plain text', () => {
    const h = m.secondaryWrCardsHtml({ lifecycleReason: 'Offsite Shop Repair', _secondaryWRs: [wo({ _relayUrl: SVC }), wo({ workRequestId: 'svc-2', salesforceCase: '' })] });
    expect(linkOf(h, 'wr')).toBe(SVC);
    expect(h).toContain('<span class="dp-wo-field"><span class="dp-wo-field__k">WR ID</span><span class="dp-wo-field__v">svc-2</span></span>');
    expect(h.split('data-id-link-field="wr"').length - 1).toBe(1);
  });
});

describe('universal Vendor WO', () => {
  const DEC = 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146';
  const valueOf = (h) => {
    const mm = h.match(/data-id-link-field="vendor-wo"[^>]*><span class="dp-wo-field__k">Vendor WO<\/span><span class="dp-wo-field__v">([^<]*)<\/span>/);
    return mm ? mm[1] : null;
  };
  it('main card: Decisiv estimate URL without vendorWorkOrderId -> linked chip 21383146', () => {
    vi.useFakeTimers();
    const hadWindow = 'window' in globalThis;
    if (!hadWindow) globalThis.window = {};
    try {
      const h = m.renderRepairPane(wo({ equipmentId: 'U9', relaySynced: true, offsiteShopEventUrl: DEC, _secondaryWRs: [], _plannedWRData: null }));
      expect(linkOf(h, 'vendor-wo')).toBe(DEC);
      expect(valueOf(h)).toBe('21383146');
      const both = m.renderRepairPane(wo({ equipmentId: 'U9', relaySynced: true, offsiteShopEventUrl: DEC, vendorWorkOrderId: 'VWO-9',
        _secondaryWRs: [], _plannedWRData: null }));
      expect(valueOf(both)).toBe('21383146');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      if (!hadWindow) delete globalThis.window;
    }
  });
  it('planned card owning the unit offsite (workRequestId === unit._offsiteWrId) -> linked chip', () => {
    const p = wo({ workRequestId: 'svc-p1', _serviceUUID: 'svc-p1' });
    const h = m.plannedWrCardHtml({ lifecycleReason: 'PM Failed', _plannedWRData: p, _offsiteWrId: 'svc-p1', offsiteShopEventUrl: DEC });
    expect(linkOf(h, 'vendor-wo')).toBe(DEC);
    expect(valueOf(h)).toBe('21383146');
    const notOwned = m.plannedWrCardHtml({ lifecycleReason: 'PM Failed', _plannedWRData: p, _offsiteWrId: 'svc-other', offsiteShopEventUrl: DEC });
    expect(notOwned).not.toContain('Vendor WO');
  });
  it('secondary card with vendorWorkOrderId RO-1 and no URL -> plain chip', () => {
    const h = m.secondaryWrCardsHtml({ lifecycleReason: 'Offsite Shop Repair', _secondaryWRs: [wo({ workRequestId: 'svc-3', vendorWorkOrderId: 'RO-1' })] });
    expect(h).toContain('<span class="dp-wo-field"><span class="dp-wo-field__k">Vendor WO</span><span class="dp-wo-field__v">RO-1</span></span>');
    expect(h).not.toContain('data-id-link-field="vendor-wo"');
  });
  it('woFieldHtml uses the tuple URL only when safe', () => {
    expect(m.woFieldHtml(['Vendor WO', '21383146', DEC], {})).toContain('data-id-link="' + DEC + '" data-id-link-field="vendor-wo"');
    expect(m.woFieldHtml(['Vendor WO', 'X', 'https://evil.example.com/x'], { offsiteShopEventUrl: OFFSITE }))
      .toBe('<span class="dp-wo-field"><span class="dp-wo-field__k">Vendor WO</span><span class="dp-wo-field__v">X</span></span>');
  });
});

describe('wireIdLinks', () => {
  function fakeRoot(urls) {
    const els = urls.map((u) => ({
      attrs: { 'data-id-link': u }, listeners: {},
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(t, fn) { this.listeners[t] = fn; },
    }));
    return { els, querySelectorAll: (s) => (s === '[data-id-link]' ? els : []) };
  }
  it('click / Enter open the URL in the in-app window with zoom; not openExternal', () => {
    const openExternal = vi.fn();
    globalThis.window = { files: { openExternal } };
    try {
      const root = fakeRoot([SVC, SF]);
      const open = vi.fn(() => Promise.resolve({ ok: true }));
      m.wireIdLinks(root, open);
      const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      root.els[0].listeners.click(ev);
      expect(open).toHaveBeenCalledWith(SVC, { zoom: true });
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(ev.stopPropagation).toHaveBeenCalled();
      root.els[1].listeners.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
      expect(open).toHaveBeenLastCalledWith(SF, { zoom: true });
      root.els[1].listeners.keydown({ key: 'a', preventDefault() {}, stopPropagation() {} });
      expect(open).toHaveBeenCalledTimes(2);
      expect(openExternal).not.toHaveBeenCalled();
    } finally { delete globalThis.window; }
  });
  it('a tampered unsafe data-id-link is not opened; opener errors are swallowed', () => {
    const root = fakeRoot(['javascript:alert(1)', SVC]);
    const open = vi.fn(() => { throw new Error('no bridge'); });
    m.wireIdLinks(root, open);
    root.els[0].listeners.click({});
    expect(open).not.toHaveBeenCalled();
    expect(() => root.els[1].listeners.click({})).not.toThrow();
  });
  it('static: _renderUnit wires the links through window.aap.openUrl(u, o), not split view / openExternal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'js', 'views', 'unit-detail.js'), 'utf8');
    const i = src.indexOf('wireIdLinks(_panel');
    expect(i).toBeGreaterThan(0);
    const line = src.slice(i, src.indexOf('\n', i));
    expect(line).toContain('window.aap.openUrl(u, o)');
    expect(line).not.toContain('openExternal');
    expect(line).not.toContain('_openInlineSplit');
  });
});
