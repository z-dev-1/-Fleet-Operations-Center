// tests/history-wo-3c-render.test.js — History Repair timeline card: flag-off
// markup is byte-identical to the pre-3C template; flag-on 3C slot states,
// escaping, badges, and the in-place apply3cResults patch.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');

// The pre-3C card template, copied verbatim from renderReport at afe2a45
// (esc / fmtDate are the same helpers that renderReport used).
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtDate(ms) {
  if (!ms) return 'Unknown';
  try { var d = new Date(ms); return (d.getMonth()+1)+'/'+d.getDate()+'/'+String(d.getFullYear()).slice(2); }
  catch (_) { return 'Unknown'; }
}
function legacyCard(e, rcaHtml) {
  var dur = e.durationHours != null ? (e.durationHours + 'h') : 'Unknown';
  var cost = e.estimateCost != null ? (' \u00b7 est $' + e.estimateCost) : '';
  return '<div class="dp-ri-tl">' +
    '<div class="dp-ri-tl-head"><span class="dp-ri-tl-date">' + esc(fmtDate(e.reportedAt)) + '</span>' +
      '<span class="dp-ri-tl-vend">' + esc(e.vendor || 'vendor n/a') + '</span>' +
      '<span class="dp-ri-tl-status dp-ri-status-' + esc(e.status||'') + '">' + esc(e.status||'') + '</span>' + rcaHtml + '</div>' +
    '<div class="dp-ri-tl-body">' +
      '<span class="dp-ri-tl-cat">' + esc(e.category || '') + (e.component ? ' / ' + esc(e.component) : '') + '</span>' +
      (e.complaint ? '<div class="dp-ri-tl-complaint">' + esc(e.complaint) + '</div>' : '') +
      '<div class="dp-ri-tl-meta">' + esc(dur) + cost + (e.rootCause ? ' \u00b7 ' + esc(e.rootCause) : '') + '</div>' +
    '</div>' +
  '</div>';
}

const BTN = '<button class="dp-ri-open-btn dp-launcher" data-hist-left="a" data-hist-right="b" title="t">\ud83d\udccb Open</button>';
const ENTRY = {
  reportedAt: Date.UTC(2026, 9, 3, 12), workOrderId: 'WO-1', vendor: 'Acme & Sons', status: 'completed',
  category: 'Unplanned Repair', component: 'Brakes', complaint: 'Grinding <noise>', rootCause: 'suspected: worn pads',
  durationHours: 26, estimateCost: 450,
};
const THREE = {
  v: 1,
  complaint: { text: 'Brakes grinding <script>alert(1)</script>', status: 'confirmed' },
  cause: { text: 'Worn pads', status: 'suspected' },
  correction: { text: 'Not recorded', status: 'not_recorded' },
  basis: 'aap+offsite', ai: true, at: 1, model: null,
};

describe('historyTimelineCardHtml', () => {
  it('flag off → exact legacy markup', () => {
    expect(m.historyTimelineCardHtml(ENTRY, { buttonsHtml: BTN, woSummaries: false })).toBe(legacyCard(ENTRY, BTN));
    const bare = { workOrderId: 'X' };
    expect(m.historyTimelineCardHtml(bare, { buttonsHtml: '', woSummaries: false })).toBe(legacyCard(bare, ''));
  });

  it('flag off with a threeC present → still the legacy markup', () => {
    const e = Object.assign({}, ENTRY, { threeC: THREE });
    expect(m.historyTimelineCardHtml(e, { buttonsHtml: BTN, woSummaries: false })).toBe(legacyCard(ENTRY, BTN));
  });

  it('flag on, no threeC → pending slot inside the body', () => {
    const html = m.historyTimelineCardHtml(ENTRY, { buttonsHtml: BTN, woSummaries: true });
    expect(html).toContain('data-wo3c="WO-1"');
    expect(html).toContain('summarizing');
    expect(html.indexOf('dp-ri-3c-slot')).toBeGreaterThan(html.indexOf('dp-ri-tl-meta'));
    expect(html.endsWith('</div></div></div></div>')).toBe(true);
  });

  it('flag on, ready → escaped text, Not recorded muted, badges, dealer basis note', () => {
    const html = m.historyTimelineCardHtml(Object.assign({}, ENTRY, { threeC: THREE, workOrderId: 'W"1' }), { woSummaries: true });
    expect(html).toContain('data-wo3c="W&quot;1"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<span class="dp-ri-3c-v dp-ri-3c-v--none">Not recorded</span>');
    expect(html).toContain('dp-ri-3c-badge--confirmed">confirmed<');
    expect(html).toContain('dp-ri-3c-badge--suspected">suspected<');
    expect(html).toContain('AI from AAP + dealer notes, verify before use');
  });
});

describe('render3cInner', () => {
  it('states', () => {
    expect(m.render3cInner(null, 'pending')).toBe('<div class="dp-ri-3c dp-ri-3c--pending">AI 3C summary: summarizing\u2026</div>');
    expect(m.render3cInner(null, 'unavailable')).toBe('<div class="dp-ri-3c dp-ri-3c--na">AI summary unavailable \u2014 use Refresh AI Analysis to retry</div>');
    const ready = m.render3cInner(Object.assign({}, THREE, { basis: 'aap' }), 'ready');
    expect(ready).toContain('(AI from AAP notes, verify before use)');
    expect(ready.match(/dp-ri-3c-row/g).length).toBe(3);
    expect(ready).toContain('<span class="dp-ri-3c-k">Complaint</span>');
    expect(ready).toContain('<span class="dp-ri-3c-k">Cause</span>');
    expect(ready).toContain('<span class="dp-ri-3c-k">Correction</span>');
  });
});

describe('apply3cResults', () => {
  it('patches matching slots only', () => {
    const slots = [
      { dataset: { wo3c: 'A' }, innerHTML: '' },
      { dataset: { wo3c: 'B' }, innerHTML: 'x' },
      { dataset: { wo3c: 'C' }, innerHTML: 'keep' },
      { dataset: { wo3c: 'D' }, innerHTML: 'keep-d' },
    ];
    const root = { querySelectorAll: (sel) => (sel === '[data-wo3c]' ? slots : []) };
    m.apply3cResults(root, { A: { status: 'fresh', threeC: THREE }, B: { status: 'timeout' }, D: { status: 'cached_unknown' } });
    expect(slots[0].innerHTML).toBe(m.render3cInner(THREE, 'ready'));
    expect(slots[1].innerHTML).toBe(m.render3cInner(null, 'unavailable'));
    expect(slots[2].innerHTML).toBe('keep');
    expect(slots[3].innerHTML).toBe('keep-d');
  });
});
