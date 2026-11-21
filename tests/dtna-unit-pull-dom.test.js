// tests/dtna-unit-pull-dom.test.js — unit detail "⬇ Pull DTNA" button
// (dtnaPullButtonHtml) in the Offsite Event card of renderRepairPane.
// Shown for a DTNA case URL, or for a Freightliner / Daimler / Western Star
// unit with no offsite URL; never for a Decisiv URL or other makes. Rendering
// makes no DTNA call (wiring runs in a timer that fake timers never fire).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
const toastSpy = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: toastSpy }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');

const DTNA = 'https://dtna.my.site.com/Servicetracker/s/case/500gx000002E4U5AAK/detail';
const DECISIV = 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146';
const BTN_RE = /<button type="button" class="dp-dtna-pull-btn" data-dtna-pull="([^"]*)"[^>]*>\u2b07 Pull DTNA<\/button>/;

describe('dtnaPullButtonHtml', () => {
  it('present for a DTNA case URL', () => {
    const h = m.dtnaPullButtonHtml({ equipmentId: '122269', vendor: 'Some Shop' }, DTNA);
    expect(h).toMatch(BTN_RE);
    expect(h.match(BTN_RE)[1]).toBe('122269');
    expect(h).toContain('title="Pull this unit\'s DTNA Service Tracker case (comments, status, repair order)"');
  });
  it('present for a Freightliner / Daimler / Western Star unit without offsite URL', () => {
    for (const u of [{ vendor: 'Freightliner of Hartford' }, { make: 'FREIGHTLINER' }, { make: 'Daimler Truck' },
      { vendor: 'Western Star Trucks' }, { make: 'WesternStar' }, { vendor: 'DTNA dealer' }]) {
      expect(m.dtnaPullButtonHtml({ equipmentId: 'U1', ...u }, ''), JSON.stringify(u)).toMatch(BTN_RE);
    }
  });
  it('absent for a Decisiv URL (even on a Freightliner) and for other makes without offsite', () => {
    expect(m.dtnaPullButtonHtml({ equipmentId: 'U1', make: 'Freightliner' }, DECISIV)).toBe('');
    expect(m.dtnaPullButtonHtml({ equipmentId: 'U1', vendor: 'Volvo', make: 'Volvo' }, '')).toBe('');
    expect(m.dtnaPullButtonHtml({ equipmentId: 'U1', make: 'Kenworth' }, '')).toBe('');
    expect(m.dtnaPullButtonHtml({ equipmentId: 'U1' }, 'https://evil.example.com/dtna.my.site.com/Servicetracker/s/case/500x')).toBe('');
  });
  it('absent without an equipmentId', () => {
    expect(m.dtnaPullButtonHtml({ make: 'Freightliner' }, '')).toBe('');
    expect(m.dtnaPullButtonHtml(null, DTNA)).toBe('');
  });
  it('escapes the equipmentId in the attribute', () => {
    const h = m.dtnaPullButtonHtml({ equipmentId: 'a"b<c>&\'d', make: 'Freightliner' }, '');
    expect(h).toContain('data-dtna-pull="a&quot;b&lt;c&gt;&amp;&#39;d"');
    expect(h).not.toContain('a"b');
  });
});

describe('renderRepairPane Offsite Event card', () => {
  let hadWindow;
  beforeEach(() => {
    vi.useFakeTimers();
    hadWindow = 'window' in globalThis;
    if (!hadWindow) globalThis.window = {};
    globalThis.window.dtna = { pullUnit: vi.fn(), login: vi.fn(), status: vi.fn() };
  });
  afterEach(() => {
    const dt = globalThis.window.dtna;
    vi.clearAllTimers();
    vi.useRealTimers();
    expect(dt.pullUnit).not.toHaveBeenCalled();
    expect(dt.login).not.toHaveBeenCalled();
    expect(dt.status).not.toHaveBeenCalled();
    if (!hadWindow) delete globalThis.window; else delete globalThis.window.dtna;
  });
  const base = (extra) => ({ equipmentId: '122269', relaySynced: true, workRequestId: 'svc-1', vendor: 'Amerit',
    _secondaryWRs: [], _plannedWRData: null, ...extra });
  const card = (h) => {
    const i = h.indexOf('<div class="dp-offsite-card">');
    return i < 0 ? '' : h.slice(i);
  };

  it('DTNA offsite URL: the button sits inside .dp-offsite-card after the header', () => {
    const h = m.renderRepairPane(base({ offsiteShopEventUrl: DTNA, asistSource: 'dtna', asistLabel: 'DTNA Case' }));
    const c = card(h);
    expect(c).toMatch(BTN_RE);
    expect(c.indexOf('dp-offsite-card__header')).toBeLessThan(c.indexOf('dp-dtna-pull-btn'));
    expect(h.split('data-dtna-pull=').length - 1).toBe(1);
  });
  it('Freightliner unit without offsite URL: minimal Offsite Event card with the button', () => {
    const h = m.renderRepairPane(base({ make: 'Freightliner' }));
    expect(h).toContain('<div class="dp-section-title">Offsite Event</div><div class="dp-offsite-card"><button type="button" class="dp-dtna-pull-btn"');
    expect(card(h)).toMatch(BTN_RE);
  });
  it('Decisiv offsite URL: card renders without the button; non-Freightliner without offsite: no card', () => {
    const dec = m.renderRepairPane(base({ offsiteShopEventUrl: DECISIV, make: 'Freightliner' }));
    expect(dec).toContain('<div class="dp-offsite-card">');
    expect(dec).not.toContain('data-dtna-pull');
    const none = m.renderRepairPane(base({ make: 'Volvo' }));
    expect(none).not.toContain('dp-offsite-card');
    expect(none).not.toContain('data-dtna-pull');
  });
});

describe('Post to DTNA button (Phase B)', () => {
  let hadWindow;
  beforeEach(() => {
    vi.useFakeTimers();
    hadWindow = 'window' in globalThis;
    if (!hadWindow) globalThis.window = {};
    globalThis.window.dtna = { pullUnit: vi.fn(), postComment: vi.fn(), draftComment: vi.fn() };
  });
  afterEach(() => {
    const dt = globalThis.window.dtna;
    vi.clearAllTimers();
    vi.useRealTimers();
    expect(dt.pullUnit).not.toHaveBeenCalled();
    expect(dt.postComment).not.toHaveBeenCalled();
    expect(dt.draftComment).not.toHaveBeenCalled();
    if (!hadWindow) delete globalThis.window; else delete globalThis.window.dtna;
  });
  const base = (extra) => ({ equipmentId: '122269', relaySynced: true, workRequestId: 'svc-1', vendor: 'Amerit',
    _secondaryWRs: [], _plannedWRData: null, ...extra });

  it('a DTNA-offsite unit shows both Pull DTNA and Post to DTNA; a Decisiv-offsite unit shows neither', () => {
    const h = m.renderRepairPane(base({ offsiteShopEventUrl: DTNA, asistSource: 'dtna' }));
    expect(h).toContain('data-dtna-pull="122269"');
    expect(h).toContain('data-dtna-post="122269" data-dtna-case="500gx000002E4U5AAK"');
    expect(h).toContain('\uD83D\uDCAC Post to DTNA</button>');
    const dec = m.renderRepairPane(base({ offsiteShopEventUrl: DECISIV, make: 'Freightliner' }));
    expect(dec).not.toContain('data-dtna-pull');
    expect(dec).not.toContain('data-dtna-post');
    // Freightliner without an offsite case: Pull only (there is no case to post to yet).
    const fl = m.renderRepairPane(base({ make: 'Freightliner' }));
    expect(fl).toContain('data-dtna-pull');
    expect(fl).not.toContain('data-dtna-post');
  });
});

describe('Pull DTNA toast when a comment read failed (Phase A review #1)', () => {
  let prevDoc;
  let prevWin;
  beforeEach(() => { vi.useFakeTimers(); prevDoc = globalThis.document; prevWin = globalThis.window; toastSpy.show.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); globalThis.document = prevDoc; globalThis.window = prevWin; });

  async function clickPull(result) {
    const { createMiniDocument } = await import('./fixtures/mini-dom.js');
    const doc = createMiniDocument();
    globalThis.document = doc;
    globalThis.window = Object.assign({}, prevWin || {}, { dtna: { pullUnit: vi.fn(async () => result), login: vi.fn() } });
    const unit = { equipmentId: '122269', relaySynced: true, workRequestId: 'svc-1', vendor: 'Amerit', _secondaryWRs: [], _plannedWRData: null,
      offsiteShopEventUrl: DTNA, asistSource: 'dtna' };
    const html = m.renderRepairPane(unit);
    const host = doc.createElement('div');
    host.innerHTML = html;
    doc.body.appendChild(host);
    try { vi.advanceTimersByTime(150); } catch (_) { /* other wiring in the timer may need more DOM */ }
    const btn = doc.querySelector('[data-dtna-pull]');
    btn.click();
    vi.useRealTimers();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return window.dtna.pullUnit;
  }

  it('commentsStale -> warn toast that the last-good comments were kept', async () => {
    const pull = await clickPull({ ok: true, caseId: 'x', commentCount: 3, commentsStale: true, commentsCode: 'DTNA_APEX_ERROR' });
    expect(pull).toHaveBeenCalledTimes(1);
    expect(toastSpy.show).toHaveBeenCalledWith('warn', 'DTNA: comment read failed; kept the 3 comments from your last pull', 5000);
  });

  it('commentsCode without a kept thread -> info toast', async () => {
    await clickPull({ ok: true, caseId: 'x', commentCount: 0, commentsCode: 'DTNA_APEX_ERROR' });
    expect(toastSpy.show).toHaveBeenCalledWith('info', 'DTNA case pulled; no comments readable', 4000);
  });

  it('a clean pull keeps the existing success toast', async () => {
    await clickPull({ ok: true, caseId: 'x', commentCount: 4 });
    expect(toastSpy.show).toHaveBeenCalledWith('success', 'DTNA: 4 comments pulled', 3000);
  });
});
