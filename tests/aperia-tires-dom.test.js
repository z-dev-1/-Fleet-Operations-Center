// tests/aperia-tires-dom.test.js — unit detail Intel pane "Aperia tires"
// section (renderer/src/js/views/aperia-tires.js). Opening the unit detail
// reads aperia.status(); when connected it auto-loads aperia.unit({ assetId })
// once (5-min cache), else the "Load Aperia tires" click does. Never a sign-in.
// The rendered result shows the tire flags,
// GPS (outside-US warning, placeholder -> "No GPS") and the embedded issue's
// recommended actions, all escaped. Unit results come from the real parser
// over tests/fixtures/aperia/responses.js.
process.env.TZ = 'UTC';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createMiniDocument } from './fixtures/mini-dom.js';
import { NOW, VEHICLE_DETAIL, GEO_PLACEHOLDER, GEO_OUTSIDE } from './fixtures/aperia/responses.js';

const h = vi.hoisted(() => ({ handlers: {} }));
vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on(ev, fn) { h.handlers[ev] = fn; }, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {}, slice() { return null; } } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const ud = await import('../renderer/src/js/views/unit-detail.js');
const at = await import('../renderer/src/js/views/aperia-tires.js');
const require = createRequire(import.meta.url);
const { parseVehicleDetail } = require('../src/aperia/parsers');

const KEYS = ['login', 'logout', 'status', 'unit', 'bulk', 'fleetTires', 'issues', 'startAlerts', 'stopAlerts', 'pollNow', 'exportBulk', 'onProgress', 'onAlert'];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const detail = (over) => parseVehicleDetail(Object.assign({}, VEHICLE_DETAIL, over || {}), { now: NOW });
const fakeAperia = (result) => Object.fromEntries(KEYS.map((k) => [k, k === 'unit' ? vi.fn(async () => result) : vi.fn()]));

describe('aperiaTireSectionHtml', () => {
  it('renders the title, the Load button with the escaped id and an empty result host', () => {
    const s = at.aperiaTireSectionHtml({ equipmentId: ' NP6923 ' });
    expect(s).toContain('<div class="dp-section-title">Aperia tires</div>');
    expect(s).toContain('<button type="button" class="dp-aperia-load-btn" data-aperia-load="NP6923">Load Aperia tires</button>');
    expect(s).toContain('<div class="dp-aperia-result"></div>');
    const x = at.aperiaTireSectionHtml({ equipmentId: 'a"b<c>&\'d' });
    expect(x).toContain('data-aperia-load="a&quot;b&lt;c&gt;&amp;&#39;d"');
    expect(x).not.toContain('a"b');
  });
  it('is empty without an equipmentId', () => {
    expect(at.aperiaTireSectionHtml({})).toBe('');
    expect(at.aperiaTireSectionHtml({ equipmentId: '  ' })).toBe('');
    expect(at.aperiaTireSectionHtml(null)).toBe('');
  });
});

describe('renderTireResult (pure)', () => {
  it('tire table with every flag badge, ET read times and the issue with its actions', () => {
    const r = detail();
    expect(r.ok).toBe(true);
    const html = at.renderTireResult(r);
    for (const th of ['Position', 'PSI', 'Target', '\u0394', 'Temp \u00b0F', 'Read (ET)', 'Flag']) expect(html).toContain('<th>' + th + '</th>');
    expect(html).toContain('dp-aperia-flag--critical">CRITICAL LOW<');
    expect(html).toContain('dp-aperia-flag--low">LOW<');
    expect(html).toContain('dp-aperia-flag--high">HIGH<');
    expect(html).toContain('dp-aperia-flag--stale">STALE<');
    expect(html).toContain('dp-aperia-flag--noread">NO READING<');
    expect(html).toContain('dp-aperia-flag--fault">SENSOR FAULT<');
    expect(html).toContain('dp-aperia-flag--ok">OK<');
    expect(html).toContain('dp-aperia-flag--none">no target<');
    expect(html).toContain('<td>-30</td>'); // 70 vs 100 PSI
    expect(html).toContain('<td>+15</td>');
    expect(html).toContain('11/22/2026, 9:00 AM EST'); // read 1 h before NOW, in New York time
    expect(html).toContain('Right Steer');
    expect(html).toContain('CRITICAL</span> Right Steer \u2013 UNDERINFLATION \u00b7 resolve immediately');
    expect(html).toContain('<li>Inflate the tire to the set point.</li>');
    expect(html).toContain('<li>Inspect for a puncture.</li>');
    expect(html).not.toContain('a6 dropped');
    expect(html).toContain('NP6923 \u00b7 ATL2 \u00b7 Ops B');
  });
  it('GPS inside the US: lat/lng 5 dp, ET time, map links, no warning', () => {
    const html = at.renderTireResult(detail());
    expect(html).toContain('GPS: 32.89654, -97.03804 \u00b7 11/22/2026, 8:00 AM EST');
    expect(html).not.toContain('outside the US');
    expect(html).toContain('data-aperia-ext="https://maps.googleapis.com/maps/api/staticmap?center=32.9,-97.0">Map image \u2197</a>');
    expect(html).toContain('data-aperia-ext="https://www.google.com/maps?q=32.89654,-97.03804">Google Maps \u2197</a>');
  });
  it('GPS outside the US shows the warning; a non-google image URL is dropped', () => {
    const html = at.renderTireResult(detail({ latestGeoTag: GEO_OUTSIDE }));
    expect(html).toContain('GPS: 51.00000, -100.00000');
    expect(html).toContain('dp-aperia-gps-warn');
    expect(html).toContain('GPS is outside the US');
    expect(html).not.toContain('Map image');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('Google Maps \u2197');
  });
  it('placeholder or missing GPS renders "No GPS" and no links', () => {
    const p = at.renderTireResult(detail({ latestGeoTag: GEO_PLACEHOLDER }));
    expect(p).toContain('No GPS');
    expect(p).toContain('placeholder');
    expect(p).not.toContain('data-aperia-ext');
    expect(p).not.toContain('-11.11111');
    const n = at.renderTireResult(detail({ latestGeoTag: undefined }));
    expect(n).toContain('No GPS');
    expect(n).not.toContain('data-aperia-ext');
  });
  it('escapes every value (XSS strings)', () => {
    const X = '<img src=x onerror=alert(1)>';
    const unit = {
      fleetVehicleId: X, domicile: '"><script>x</script>', group: 'g',
      tires: [{ position: X, shortPosition: X, positionName: X, pressure: 70, setPoint: 100, deltaPsi: -30, pct: 70, temperatureF: 70, readAtEt: X, flag: 'CRITICAL LOW', issue: null }],
      gps: { lat: 30, lng: -90, atEt: X, outsideUs: false, mapImageUrl: 'javascript:alert(1)', mapsUrl: 'https://www.google.com/maps?q=1"><b>,2' },
      gpsReason: 'OK',
      issues: [{ position: X, positionName: X, severity: X, type: X, resolveBy: X, actions: [X], createdEt: X }],
    };
    const html = at.renderTireResult({ ok: true, unit });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('"><b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('error codes render the right message', () => {
    expect(at.renderTireResult({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' })).toContain('Sign in from the Aperia pill');
    expect(at.renderTireResult({ ok: false, code: 'APERIA_SESSION_EXPIRED' })).toContain('Sign in from the Aperia pill');
    expect(at.renderTireResult({ ok: false, code: 'APERIA_UNIT_NOT_FOUND' })).toContain('This unit is not in Aperia.');
    expect(at.errorText('APERIA_NETWORK')).toBe('Aperia lookup failed (APERIA_NETWORK).');
    expect(at.renderTireResult({ ok: false, code: '<b>x</b>' })).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('wireAperiaTires', () => {
  let prevDoc, prevWin;
  beforeEach(() => { prevDoc = globalThis.document; prevWin = globalThis.window; });
  afterEach(() => { globalThis.document = prevDoc; globalThis.window = prevWin; });

  function mount(unit) {
    const doc = createMiniDocument();
    globalThis.document = doc;
    const host = doc.createElement('div');
    host.innerHTML = at.aperiaTireSectionHtml(unit);
    doc.body.appendChild(host);
    return host;
  }

  beforeEach(() => { at._resetAutoCacheForTests(); });
  const connected = (ap) => { ap.status = vi.fn(async () => ({ ok: true, state: 'connected' })); return ap; };

  it('connected -> wiring auto-loads once (unit called once, table rendered, button says Refresh); never signs in', async () => {
    const ap = connected(fakeAperia(detail()));
    globalThis.window = { aperia: ap };
    const host = mount({ equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' }); // binds once
    await flush();
    expect(ap.status).toHaveBeenCalledTimes(1);
    expect(ap.unit).toHaveBeenCalledTimes(1);
    expect(ap.unit).toHaveBeenCalledWith({ assetId: 'NP6923' });
    expect(host.querySelector('.dp-aperia-result').innerHTML).toContain('CRITICAL LOW');
    expect(host.querySelector('.dp-aperia-load-btn').textContent).toBe('Refresh Aperia tires');
    expect(ap.login).not.toHaveBeenCalled();
  });

  it('a re-mount within 5 min renders from the cache (one unit call); a click after auto-load calls unit again', async () => {
    const ap = connected(fakeAperia(detail()));
    globalThis.window = { aperia: ap };
    let host = mount({ equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' });
    await flush();
    host = mount({ equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' });
    await flush();
    expect(ap.unit).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.dp-aperia-result').innerHTML).toContain('CRITICAL LOW');
    host.querySelector('.dp-aperia-load-btn').click();
    await flush();
    expect(ap.unit).toHaveBeenCalledTimes(2);
    expect(ap.login).not.toHaveBeenCalled();
  });

  it('a failed auto-load is not cached (the next mount calls again)', async () => {
    const ap = connected(fakeAperia({ ok: false, code: 'APERIA_NETWORK' }));
    globalThis.window = { aperia: ap };
    at.wireAperiaTires(mount({ equipmentId: 'NP1' }), { equipmentId: 'NP1' });
    await flush();
    at.wireAperiaTires(mount({ equipmentId: 'NP1' }), { equipmentId: 'NP1' });
    await flush();
    expect(ap.unit).toHaveBeenCalledTimes(2);
  });

  it('signed out -> no unit call, the Load button stays; a status read that throws is ignored', async () => {
    const ap = fakeAperia(detail());
    ap.status = vi.fn(async () => ({ ok: true, state: 'signed-out' }));
    globalThis.window = { aperia: ap };
    const host = mount({ equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' });
    await flush();
    expect(ap.unit).not.toHaveBeenCalled();
    expect(host.querySelector('.dp-aperia-load-btn').textContent).toBe('Load Aperia tires');
    ap.status = vi.fn(async () => { throw new Error('x'); });
    const h2 = mount({ equipmentId: 'NP2' });
    at.wireAperiaTires(h2, { equipmentId: 'NP2' });
    await flush();
    expect(ap.unit).not.toHaveBeenCalled();
    expect(ap.login).not.toHaveBeenCalled();
  });

  it('not connected: wiring reads status only; a click calls unit({assetId}) once, disables while loading and renders the result', async () => {
    const ap = fakeAperia(detail());
    const files = { openExternal: vi.fn(async () => {}) };
    globalThis.window = { aperia: ap, files };
    const host = mount({ equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' });
    at.wireAperiaTires(host, { equipmentId: 'NP6923' }); // binds once
    await flush();
    expect(ap.status).toHaveBeenCalledTimes(1);
    for (const k of KEYS.filter((x) => x !== 'status')) expect(ap[k], k).not.toHaveBeenCalled();
    const btn = host.querySelector('.dp-aperia-load-btn');
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    await flush();
    expect(ap.unit).toHaveBeenCalledTimes(1);
    expect(ap.unit).toHaveBeenCalledWith({ assetId: 'NP6923' });
    expect(btn.disabled).toBe(false);
    const out = host.querySelector('.dp-aperia-result');
    expect(out.innerHTML).toContain('CRITICAL LOW');
    expect(out.innerHTML).toContain('Inflate the tire to the set point.');
    for (const k of KEYS.filter((x) => x !== 'unit' && x !== 'status')) expect(ap[k], k).not.toHaveBeenCalled();
    // Links open through window.files.openExternal.
    out.querySelector('[data-aperia-ext]').click();
    await flush();
    expect(files.openExternal).toHaveBeenCalledWith('https://maps.googleapis.com/maps/api/staticmap?center=32.9,-97.0');
  });

  it('an error result renders the message', async () => {
    const ap = fakeAperia({ ok: false, code: 'APERIA_UNIT_NOT_FOUND' });
    globalThis.window = { aperia: ap };
    const host = mount({ equipmentId: 'ZZ1' });
    at.wireAperiaTires(host, { equipmentId: 'ZZ1' });
    host.querySelector('.dp-aperia-load-btn').click();
    await flush();
    expect(host.querySelector('.dp-aperia-result').textContent).toBe('This unit is not in Aperia.');
  });
});

describe('unit detail panel open (unit-detail.js)', () => {
  let prevDoc, prevWin, prevRaf;
  beforeEach(() => {
    vi.useFakeTimers(); // renderRepairPane schedules DOM wiring; never run it
    prevDoc = globalThis.document; prevWin = globalThis.window; prevRaf = globalThis.requestAnimationFrame;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.document = prevDoc; globalThis.window = prevWin; globalThis.requestAnimationFrame = prevRaf;
  });

  it('opening the unit while signed out reads status only; the Intel pane has the section and its Load button works', async () => {
    at._resetAutoCacheForTests();
    const doc = createMiniDocument();
    globalThis.document = doc;
    globalThis.requestAnimationFrame = () => 0;
    const ap = fakeAperia(detail());
    globalThis.window = { aperia: ap };
    ud.init();
    expect(typeof h.handlers['ui:unit-select']).toBe('function');
    const unit = { equipmentId: 'NP6923', lifecycleState: 'Active', relaySynced: false, _secondaryWRs: [], repairTimeline: '' };
    try { h.handlers['ui:unit-select']({ unit }); } catch (_) { /* later, unrelated wiring may need more DOM */ }
    const panel = doc.getElementById('detail-panel');
    const intel = panel.querySelector('#dp-pane-intel');
    expect(intel).toBeTruthy();
    const btn = intel.querySelector('.dp-aperia-load-btn');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('data-aperia-load')).toBe('NP6923');
    expect(btn.hasAttribute('data-aperia-bound')).toBe(true);
    await flush();
    for (const k of KEYS.filter((x) => x !== 'status')) expect(ap[k], k).not.toHaveBeenCalled();
    btn.click();
    await flush();
    expect(ap.unit).toHaveBeenCalledTimes(1);
    expect(ap.unit).toHaveBeenCalledWith({ assetId: 'NP6923' });
    expect(intel.querySelector('.dp-aperia-result').innerHTML).toContain('SENSOR FAULT');
  });

  it('static: unit-detail.js has exactly the three additive Aperia edits', () => {
    const src = fs.readFileSync(new URL('../renderer/src/js/views/unit-detail.js', import.meta.url), 'utf8');
    expect(src.match(/aperia/gi).length).toBe(5);
    expect(src).toContain("import { open as openRcaModal } from './rca-modal.js';\nimport { aperiaTireSectionHtml, wireAperiaTires } from './aperia-tires.js';".replace(/\n/g, src.includes('\r\n') ? '\r\n' : '\n'));
    expect(src).toContain("+dialHtml+subsHtml+aperiaTireSectionHtml(unit)+insHtml+");
    expect(src).toMatch(/_emitTabContext\(\);\r?\n {2}try \{ wireAperiaTires\(_panel, unit\); \} catch \(_\) \{\}/);
  });
});
