// tests/longdwell-sp-render.test.js - renderer side of the Long Dwell weekly
// sheet panel: the synchronous mount contract (A1), the preview table HTML,
// the reducer, the write payload, the report, the control strip, and the side
// panel driven through a small fake DOM (node environment, no jsdom).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const B = vi.hoisted(() => ({
  longDwellSp: { status: null, setLink: null, clearLink: null, preview: null, write: null, discard: null },
  aap: { openUrl: null },
}));
vi.mock('../renderer/src/js/bridge.js', () => B);

const L = await import('../renderer/src/js/longdwell-sp-logic.js');
const view = await import('../renderer/src/js/views/longdwell-sp.js');

// ── fake DOM ────────────────────────────────────────────────────────────────
class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attrs = {}; this.listeners = {}; this.hidden = false; this.id = ''; this.className = ''; this._html = ''; this._stubs = {};
    this.reloads = 0;
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return self.className.split(/\s+/).includes(c); },
    };
  }
  reload() { this.reloads++; }
  focus() {}
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  insertBefore(n, ref) {
    if (n.parentNode) n.remove();
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    n.parentNode = this; return n;
  }
  appendChild(n) { return this.insertBefore(n, null); }
  remove() { if (!this.parentNode) return; const s = this.parentNode.children; s.splice(s.indexOf(this), 1); this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  async emit(t, ev) { for (const fn of this.listeners[t] || []) await fn(ev); }
  stub(sel, v) { this._stubs[sel] = v; }
  _walk(fn) { for (const c of this.children) { const r = fn(c) || c._walk(fn); if (r) return r; } return null; }
  querySelector(sel) {
    if (Object.prototype.hasOwnProperty.call(this._stubs, sel)) return this._stubs[sel];
    if (sel[0] === '#') return this._walk((c) => (c.id === sel.slice(1) ? c : null));
    if (sel[0] === '.') return this._walk((c) => (c.className.split(/\s+/).includes(sel.slice(1)) ? c : null));
    return null;
  }
}
function makeWrap() {
  const doc = { created: [], defaultView: null };
  doc.createElement = (t) => { const e = new FakeEl(t, doc); doc.created.push(e); return e; };
  const wrap = new FakeEl('div', doc); wrap.id = 'an-ld-computed-wrap';
  const toolbar = new FakeEl('div', doc); toolbar.id = 'an-ld-toolbar-wrap';
  const table = new FakeEl('div', doc); table.id = 'an-ld-table-wrap';
  wrap.appendChild(toolbar); wrap.appendChild(table);
  return { doc, wrap, toolbar, table };
}
const act = (action, ds = {}) => { const el = { dataset: { ldspAction: action, ...ds } }; return { target: { closest: (s) => (s === '[data-ldsp-action]' ? el : null), dataset: {} } }; };
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function recordingHost() {
  const calls = [];
  const rec = (n) => (...a) => { calls.push(n); return a[0]; };
  const h = {
    calls, appendChild: rec('appendChild'), insertBefore: rec('insertBefore'), addEventListener: rec('addEventListener'),
    removeChild: rec('removeChild'), setAttribute: rec('setAttribute'),
    querySelector: (s) => { calls.push('querySelector:' + s); return null; },
    classList: { add: rec('classList.add'), remove: rec('classList.remove') }, style: {},
  };
  Object.defineProperty(h, 'firstChild', { get() { calls.push('firstChild'); return null; } });
  Object.defineProperty(h, 'ownerDocument', { get() { calls.push('ownerDocument'); return { createElement: (t) => { calls.push('createElement:' + t); return {}; } }; } });
  Object.defineProperty(h, 'innerHTML', { get() { return ''; }, set() { calls.push('innerHTML'); } });
  return h;
}

// ── fixtures ────────────────────────────────────────────────────────────────
const LINK = { url: 'https://contoso.sharepoint.com/sites/F/Shared%20Documents/LD.xlsx', source: 'manual', confidence: 'user', setAt: 1, fileName: 'LD.xlsx' };
const STATUS = { ok: true, enabled: true, commit: true, weekKey: '2026-W45', weekLabel: 'Week 45, 2026', link: LINK };
const DR = ['Parts', 'Labor'];
const ES = ['SEV1', 'SEV2'];
function cell(id, o) {
  const [row, col] = id.split(':');
  return { id, equipmentId: o.unit || 'U' + row, woKey: o.unit || 'U' + row, sheetRow: Number(row), column: col,
    header: { N: 'Delay Reason', O: 'Escalation Level Action', R: 'Required Notes for ALL Units' }[col],
    current: o.current || '', next: o.next || '', state: o.state, reason: o.reason || null,
    selectable: o.state === 'will-write' || o.state === 'conflict', defaultChecked: !!o.dc,
    editor: col === 'R' ? 'textarea' : 'select', options: col === 'N' ? DR : col === 'O' ? ES : undefined, warnings: o.warnings || [] };
}
function preview(over = {}) {
  return {
    ok: true, previewId: 'a'.repeat(32), weekKey: '2026-W45', generatedAt: '2026-11-05T10:00:00Z', expiresAt: '2026-11-05T10:20:00Z',
    file: { name: 'LD.xlsx', tab: 'Long Dwell', headerRow: 2, tabCount: 1 },
    mapping: [
      { field: 'delayReason', fieldLabel: 'Delay Reason', column: 'N', header: 'Delay Reason' },
      { field: 'escalationLevel', fieldLabel: 'Escalation', column: 'O', header: 'Escalation Level Action' },
      { field: 'summary', fieldLabel: 'Summary', column: 'R', header: 'Required Notes for ALL Units' },
    ],
    untouched: [{ column: 'A-M', header: 'Tracker columns', reason: 'read-only' }, { column: 'P', header: 'Support Team POC', reason: 'no-computed-value' }, { column: 'Q', header: 'Asana Link (If at SEV2)', reason: 'no-computed-value' }],
    commit: true,
    units: [
      { equipmentId: 'U2', woKey: 'U2', match: 'matched', sheetRow: 2, via: 'unit' },
      { equipmentId: 'U9', woKey: 'U9', match: 'not-in-sheet', sheetRow: null },
      { equipmentId: 'U8', woKey: 'U8', match: 'ambiguous', sheetRow: null, candidates: [10, 11] },
    ],
    cells: [
      cell('2:N', { state: 'will-write', next: 'Parts', dc: true }),
      cell('2:O', { state: 'conflict', current: 'SEV1', next: 'SEV2' }),
      cell('2:R', { state: 'will-write', next: '<script>alert(1)</script>', dc: true }),
      cell('3:N', { state: 'no-change', current: 'Labor', next: 'Labor' }),
      cell('4:R', { state: 'blocked', reason: 'formula', next: 'x' }),
      cell('5:N', { state: 'will-write', next: 'Parts', warnings: ['vendor-match'] }),
      cell('6:R', { state: 'will-write', next: 'n', warnings: ['needs-confirm'] }),
      cell('7:R', { state: 'no-change', current: 'line1\nline2', next: 'line1\nline2' }),
    ],
    counts: { unitsInView: 12, units: 3, matched: 1, ambiguous: 1, notInSheet: 1, extraWo: 0, cells: 8, willWrite: 4, noChange: 2, conflict: 1, blocked: 1 },
    diagnostics: {}, truncated: false, ...over,
  };
}
const loaded = (over) => L.reduce(L.initialState(STATUS), { type: 'preview-loaded', preview: preview(over) });
const rows = (html) => [...html.matchAll(/<tr data-cell-id="([^"]+)" class="ldsp-row--([a-z-]+)">([\s\S]*?)<\/tr>/g)].map((m) => ({ id: m[1], cls: m[2], html: m[3] }));

beforeEach(() => {
  B.longDwellSp.status = vi.fn(async () => STATUS);
  B.longDwellSp.setLink = vi.fn(async () => ({ ok: true }));
  B.longDwellSp.clearLink = vi.fn(async () => ({ ok: true }));
  B.longDwellSp.preview = vi.fn(async () => preview());
  B.longDwellSp.write = vi.fn(async () => ({ ok: true, status: 'ok', counts: { written: 1 }, cells: [{ id: '2:N', equipmentId: 'U2', column: 'N', header: 'Delay Reason', status: 'written' }] }));
  B.longDwellSp.discard = vi.fn(async () => ({ ok: true }));
  B.aap.openUrl = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

describe('mount contract', () => {
  it('returns a non-thenable object synchronously', () => {
    const { wrap } = makeWrap();
    const api = view.mount(wrap, { getUnits: () => [] });
    expect(api).toBeTruthy();
    expect(typeof api.then).toBe('undefined');
    expect(api instanceof Promise).toBe(false);
    expect(typeof api.refresh).toBe('function');
    expect(wrap.children.length).toBe(2); // nothing inserted before status resolves
  });
  for (const [name, impl] of [
    ['status rejects', () => Promise.reject(new Error('x'))],
    ["{ok:false,code:'off'}", async () => ({ ok: false, code: 'off' })],
    ['{enabled:false}', async () => ({ ok: true, enabled: false })],
    ['status throws synchronously', () => { throw new Error('x'); }],
  ]) {
    it(`status rejects / {ok:false,code:'off'} / {enabled:false}: host untouched and refresh() is a no-op (${name})`, async () => {
      B.longDwellSp.status = vi.fn(impl);
      const host = recordingHost();
      const getUnits = vi.fn(() => []);
      const api = view.mount(host, { getUnits });
      await flush();
      expect(() => api.refresh()).not.toThrow();
      expect(api.refresh()).toBeUndefined();
      await flush();
      expect(host.calls).toEqual([]);
      expect(getUnits).not.toHaveBeenCalled();
      expect(B.longDwellSp.status).toHaveBeenCalledTimes(1);
    });
  }
  it('enabled: host is the first child of the wrap and the hidden pane follows #an-ld-table-wrap', async () => {
    const { wrap, toolbar, table } = makeWrap();
    const getUnits = vi.fn(() => []);
    const api = view.mount(wrap, { getUnits });
    await flush();
    expect(wrap.children.map((c) => c.id)).toEqual(['an-ld-sp-host', toolbar.id, table.id, 'an-ld-sp-pane']);
    expect(wrap.children[3].hidden).toBe(true);
    expect(wrap.children[0].className).toBe('ldsp');
    expect(wrap.children[0].innerHTML).toContain('Week 45, 2026');
    expect(getUnits).not.toHaveBeenCalled();
    api.refresh(); await flush();
    expect(B.longDwellSp.status).toHaveBeenCalledTimes(2);
  });
});

describe('preview DOM', () => {
  const html = L.renderPreviewHtml(loaded());
  const rs = rows(html);
  it('one <tr data-cell-id> per cell with state classes and text labels', () => {
    expect(rs.map((r) => r.id)).toEqual(['2:N', '2:O', '2:R', '3:N', '4:R', '5:N', '6:R', '7:R']);
    expect(rs.map((r) => r.cls)).toEqual(['will-write', 'conflict', 'will-write', 'no-change', 'blocked', 'will-write', 'will-write', 'no-change']);
    expect(rs[0].html).toContain('Will write');
    expect(rs[1].html).toContain('Conflict');
    expect(rs[3].html).toContain('No change');
    expect(rs[4].html).toContain('Blocked: Cell holds a formula');
  });
  it('real table with column headers', () => {
    expect(html).toContain('<table class="an-table ldsp-table">');
    expect((html.match(/<th scope="col">/g) || []).length).toBe(8 + 2);
  });
  it('checkboxes only for selectable cells, with labels and default ticks', () => {
    const boxes = rs.filter((r) => r.html.includes('type="checkbox"')).map((r) => r.id);
    expect(boxes).toEqual(['2:N', '2:O', '2:R', '5:N', '6:R']);
    expect(rs[0].html).toMatch(/type="checkbox"[^>]*checked/);
    expect(rs[1].html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(rs[5].html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(rs[6].html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(rs[0].html).toContain('aria-label="Write Delay Reason for unit U2"');
    expect(rs[5].html).toContain('matched by vendor, confirm row');
    expect(rs[6].html).toContain('needs confirm');
  });
  it('editors: select with enum options for N/O, textarea for R, none for non-selectable', () => {
    expect(rs[0].html).toContain('<select');
    expect(rs[0].html).toContain('<option value="Parts" selected>Parts</option><option value="Labor">Labor</option>');
    expect(rs[1].html).toContain('<option value="SEV2" selected>');
    expect(rs[2].html).toContain('<textarea');
    expect(rs[2].html).toContain('aria-label="New Required Notes for ALL Units for unit U2"');
    expect(rs[3].html).not.toMatch(/<select|<textarea/);
    expect(rs[4].html).not.toMatch(/<select|<textarea/);
  });
  it('values are HTML-escaped, including edited text', () => {
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const ed = L.reduce(loaded(), { type: 'edit', cellId: '2:R', text: '<img src=x onerror=1>' });
    const h2 = L.renderPreviewHtml(ed);
    expect(h2).not.toContain('<img');
    expect(h2).toContain('&lt;img src=x onerror=1&gt;');
  });
  it('multi-line values use <details>', () => {
    expect(rs[7].html).toContain('<details class="ldsp-diff">');
  });
  it('mapping shows real letters and the Not written line; header strip shows units from the current view', () => {
    expect(html).toContain('N Delay Reason');
    expect(html).toContain('O Escalation Level Action');
    expect(html).toContain('R Required Notes for ALL Units');
    expect(html).toContain('Not written: A to M (read-only), P Support Team POC, Q Asana Link (If at SEV2)');
    expect(html).toContain('12 units from the current view');
    expect(html).toContain('Nothing written yet');
  });
  it('count chips and unit lists', () => {
    for (const t of ['will write 4', 'no change 2', 'conflicts 1', 'needs confirm 1', 'matched by vendor 1', 'ambiguous 1', 'not in sheet 1', 'blocked 1']) expect(html).toContain(t);
    expect(html).toContain('Not in sheet (1)');
    expect(html).toContain('U8 (rows 10, 11)');
  });
  it('dry-run notice names longDwell.sharepointWriteCommit and Write is disabled with the reason', () => {
    const h = L.renderPreviewHtml(loaded({ commit: false }));
    expect(h).toContain('longDwell.sharepointWriteCommit');
    expect(h).toMatch(/data-ldsp-action="write" disabled/);
    expect(h).toContain('Write is turned off (dry run)');
  });
});

describe('reducer', () => {
  it('tick / untick only selectable cells', () => {
    let s = loaded();
    s = L.reduce(s, { type: 'tick', cellId: '2:O', checked: true });
    expect(s.ticks['2:O']).toBe(true);
    s = L.reduce(s, { type: 'tick', cellId: '2:N', checked: false });
    expect(s.ticks['2:N']).toBe(false);
    const s2 = L.reduce(s, { type: 'tick', cellId: '3:N', checked: true });
    expect(s2).toBe(s);
  });
  it('edit does not tick, shows edited badge, re-derives state; reset restores', () => {
    let s = loaded();
    s = L.reduce(s, { type: 'edit', cellId: '5:N', text: 'Labor' });
    expect(s.ticks['5:N']).toBe(false);
    expect(L.renderPreviewHtml(s)).toMatch(/data-cell-id="5:N"[\s\S]*?edited/);
    s = L.reduce(s, { type: 'edit', cellId: '2:O', text: 'SEV1' });
    const c = s.preview.cells.find((x) => x.id === '2:O');
    expect(L.effectiveState(s, c)).toBe('no-change');
    s = L.reduce(s, { type: 'reset', cellId: '2:O' });
    expect(L.effectiveState(s, c)).toBe('conflict');
  });
  it('select all will-write never touches conflicts; clear unticks all', () => {
    let s = L.reduce(loaded(), { type: 'clear' });
    expect(Object.values(s.ticks).every((v) => v === false)).toBe(true);
    s = L.reduce(s, { type: 'select-all' });
    expect(s.ticks).toEqual({ '2:N': true, '2:O': false, '2:R': true, '5:N': true, '6:R': true });
  });
  it('empty ticked text disables Write; label counts overwrites', () => {
    let s = loaded();
    expect(L.writeInfo(s)).toMatchObject({ count: 2, overwrites: 0, disabled: false, label: 'Write 2 cells to sheet' });
    s = L.reduce(s, { type: 'tick', cellId: '2:O', checked: true });
    expect(L.writeInfo(s).label).toBe('Write 3 cells to sheet (1 overwrite existing text)');
    s = L.reduce(s, { type: 'arm-confirm' });
    expect(L.writeInfo(s).label).toBe('Confirm: overwrite 1 cell');
    s = L.reduce(s, { type: 'edit', cellId: '2:R', text: '   ' });
    expect(L.writeInfo(s)).toMatchObject({ disabled: true, reason: 'A ticked cell is empty.' });
    s = L.reduce(L.reduce(loaded(), { type: 'clear' }), { type: 'busy', busy: false });
    expect(L.writeInfo(s)).toMatchObject({ disabled: true, reason: 'Tick at least one cell to write.' });
  });
  it('a new week in status clears the preview', () => {
    const s = L.reduce(loaded(), { type: 'status', status: { ...STATUS, weekKey: '2026-W46', link: null } });
    expect(s.preview).toBe(null);
  });
});

describe('write payload', () => {
  it('is exactly {previewId, cells:[{cellId,text}], confirm:true} with edited text', () => {
    let s = loaded();
    s = L.reduce(s, { type: 'tick', cellId: '2:O', checked: true });
    s = L.reduce(s, { type: 'edit', cellId: '2:R', text: 'my note' });
    const p = L.buildWritePayload(s);
    expect(Object.keys(p).sort()).toEqual(['cells', 'confirm', 'previewId']);
    expect(p).toEqual({ previewId: 'a'.repeat(32), confirm: true, cells: [{ cellId: '2:N', text: 'Parts' }, { cellId: '2:O', text: 'SEV2' }, { cellId: '2:R', text: 'my note' }] });
    for (const c of p.cells) expect(Object.keys(c).sort()).toEqual(['cellId', 'text']);
  });
});

describe('report HTML', () => {
  it('mixed statuses with edited / overwrote markers and friendly reasons', () => {
    const h = L.renderReportHtml({ ok: false, status: 'partial-failure', counts: { written: 1, skipped: 1, conflict: 1, failed: 1 }, errors: [],
      cells: [
        { id: '2:N', equipmentId: 'U2', column: 'N', header: 'Delay Reason', status: 'written', edited: true },
        { id: '2:O', equipmentId: 'U2', column: 'O', header: 'Escalation Level Action', status: 'written', overwrote: true },
        { id: '5:N', equipmentId: 'U5', column: 'N', header: 'Delay Reason', status: 'skipped', reason: 'changed-since-preview', detail: 'row-moved' },
        { id: '6:R', equipmentId: 'U6', column: 'R', header: 'Required Notes for ALL Units', status: 'failed', reason: 'locked' },
        { id: '7:R', equipmentId: 'U7', column: 'R', header: 'Required Notes for ALL Units', status: 'conflict', reason: 'not-approved' },
      ] });
    expect(rows(h).map((r) => r.cls)).toEqual(['written', 'written', 'skipped', 'failed', 'conflict']);
    expect(h).toContain('edited');
    expect(h).toContain('overwrote');
    expect(h).toContain('changed since preview');
    expect(h).toContain('written 1');
    expect(h).toContain('Preview again');
  });
  it('friendly texts: auth-required and write-disabled naming the key', () => {
    expect(L.friendlyText('auth-required')).toMatch(/Sign in/);
    expect(L.friendlyText('write-disabled')).toContain('longDwell.sharepointWriteCommit');
    expect(L.friendlyText('changed-since-preview')).toBe('changed since preview');
  });
});

describe('control HTML', () => {
  it('no link: paste prompt, url input and Save', () => {
    const h = L.renderControlHtml(L.initialState({ ...STATUS, link: null }));
    expect(h).toContain("paste this week's sheet link");
    expect(h).toContain('type="url"');
    expect(h).toContain('data-ldsp-action="save-link"');
  });
  it('link stored: file name and Open sheet / Pop out / Preview / Change link', () => {
    const h = L.renderControlHtml(L.initialState(STATUS));
    expect(h).toContain('LD.xlsx');
    for (const a of ['open-pane', 'pop-out', 'preview', 'change-link']) expect(h).toContain('data-ldsp-action="' + a + '"');
    expect(h).not.toContain('type="url"');
  });
  it('week rollover (status without link) shows the paste prompt again', () => {
    const s = L.reduce(L.initialState(STATUS), { type: 'status', status: { ...STATUS, weekKey: '2026-W46', weekLabel: 'Week 46, 2026', link: null } });
    const h = L.renderControlHtml(s);
    expect(h).toContain('Week 46, 2026');
    expect(h).toContain("paste this week's sheet link");
  });
});

describe('side panel and view flow', () => {
  async function active(status = STATUS) {
    B.longDwellSp.status = vi.fn(async () => status);
    const w = makeWrap();
    const getUnits = vi.fn(() => [{ equipmentId: 'U2', woKey: 'U2', isPrimary: true }]);
    const api = view.mount(w.wrap, { getUnits });
    await flush();
    const host = w.wrap.children[0];
    const pane = w.wrap.children[3];
    return { ...w, api, host, pane, getUnits };
  }
  const webview = (pane) => pane._walk((c) => (c.tagName === 'WEBVIEW' ? c : null));

  it('Open sheet creates a <webview> whose src is the stored link, with no partition/preload/allowpopups', async () => {
    const t = await active();
    await t.host.emit('click', act('open-pane'));
    const wv = webview(t.pane);
    expect(wv).toBeTruthy();
    expect(wv.attrs.src).toBe(LINK.url);
    for (const a of ['partition', 'preload', 'allowpopups']) expect(wv.hasAttribute(a)).toBe(false);
    expect(t.pane.hidden).toBe(false);
    expect(t.wrap.classList.contains('ldsp-split')).toBe(true);
    await t.host.emit('click', act('open-pane'));
    expect(t.doc.created.filter((e) => e.tagName === 'WEBVIEW').length).toBe(1);
  });
  it('a non-SharePoint src is refused', async () => {
    const t = await active({ ...STATUS, link: { ...LINK, url: 'https://evil.example.com/a.xlsx' } });
    await t.host.emit('click', act('open-pane'));
    expect(t.doc.created.some((e) => e.tagName === 'WEBVIEW')).toBe(false);
    expect(t.host.innerHTML).toContain('Only SharePoint links');
  });
  it('Pop out calls aap.openUrl with the stored link; Close removes the element', async () => {
    const t = await active();
    await t.host.emit('click', act('pop-out'));
    expect(B.aap.openUrl).toHaveBeenCalledWith(LINK.url);
    await t.host.emit('click', act('open-pane'));
    await t.pane.emit('click', act('pane-close'));
    expect(webview(t.pane)).toBe(null);
    expect(t.pane.hidden).toBe(true);
    expect(t.pane.innerHTML).toBe('');
  });
  it('did-fail-load (main frame) replaces the pane with the notice and calls aap.openUrl once', async () => {
    const t = await active();
    await t.host.emit('click', act('open-pane'));
    const wv = webview(t.pane);
    await wv.emit('did-fail-load', { isMainFrame: false, errorCode: -105 });
    await wv.emit('did-fail-load', { isMainFrame: true, errorCode: -3 });
    expect(B.aap.openUrl).not.toHaveBeenCalled();
    await wv.emit('did-fail-load', { isMainFrame: true, errorCode: -105 });
    await wv.emit('did-fail-load', { isMainFrame: true, errorCode: -105 });
    expect(B.aap.openUrl).toHaveBeenCalledTimes(1);
    expect(t.pane.innerHTML).toContain("Couldn't load the sheet here");
  });
  it('no dom-ready within 15 s falls back once; dom-ready in time does not', async () => {
    vi.useFakeTimers();
    const t = await active();
    await t.host.emit('click', act('open-pane'));
    vi.advanceTimersByTime(14999);
    expect(B.aap.openUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(B.aap.openUrl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60000);
    expect(B.aap.openUrl).toHaveBeenCalledTimes(1);
    const t2 = await active();
    await t2.host.emit('click', act('open-pane'));
    await webview(t2.pane).emit('dom-ready');
    vi.advanceTimersByTime(20000);
    expect(B.aap.openUrl).toHaveBeenCalledTimes(1);
  });
  it('Preview calls getUnits and preview(); Write with the pane open prompts once per preview, then reloads the webview after the report', async () => {
    const t = await active();
    await t.host.emit('click', act('preview'));
    await flush();
    expect(t.getUnits).toHaveBeenCalledTimes(1);
    expect(B.longDwellSp.preview).toHaveBeenCalledWith({ units: [{ equipmentId: 'U2', woKey: 'U2', isPrimary: true }] });
    expect(t.host.innerHTML).toContain('data-cell-id="2:N"');
    await t.host.emit('click', act('open-pane'));
    const wv = webview(t.pane);
    await t.host.emit('click', act('write'));
    expect(B.longDwellSp.write).not.toHaveBeenCalled();
    expect(t.host.innerHTML).toContain('Close and write');
    await t.host.emit('click', act('prompt-cancel'));
    expect(B.longDwellSp.write).not.toHaveBeenCalled();
    await t.host.emit('click', act('write')); // prompt shown once per preview
    await flush();
    expect(B.longDwellSp.write).toHaveBeenCalledTimes(1);
    expect(B.longDwellSp.write.mock.calls[0][0]).toEqual({ previewId: 'a'.repeat(32), confirm: true, cells: [{ cellId: '2:N', text: 'Parts' }, { cellId: '2:R', text: '<script>alert(1)</script>' }] });
    expect(wv.reloads).toBe(1);
    expect(t.host.innerHTML).toContain('ldsp-report');
  });
  it('Close and write removes the pane, then sends write', async () => {
    const t = await active();
    await t.host.emit('click', act('preview')); await flush();
    await t.host.emit('click', act('open-pane'));
    await t.host.emit('click', act('write'));
    await t.host.emit('click', act('prompt-close-write'));
    await flush();
    expect(webview(t.pane)).toBe(null);
    expect(B.longDwellSp.write).toHaveBeenCalledTimes(1);
  });
  it('overwrites need a two-step confirm that reverts after 6 s', async () => {
    vi.useFakeTimers();
    const t = await active();
    await t.host.emit('click', act('preview')); await flush();
    await t.host.emit('change', { target: { dataset: { ldspField: 'tick', cellId: '2:O' }, checked: true } });
    expect(t.host.innerHTML).toContain('(1 overwrite existing text)');
    await t.host.emit('click', act('write'));
    expect(B.longDwellSp.write).not.toHaveBeenCalled();
    expect(t.host.innerHTML).toContain('Confirm: overwrite 1 cell');
    vi.advanceTimersByTime(6000);
    expect(t.host.innerHTML).not.toContain('Confirm: overwrite');
    await t.host.emit('click', act('write'));
    await t.host.emit('click', act('write'));
    await flush();
    expect(B.longDwellSp.write).toHaveBeenCalledTimes(1);
  });
  it('commit off: Write click sends nothing', async () => {
    B.longDwellSp.preview = vi.fn(async () => preview({ commit: false }));
    const t = await active({ ...STATUS, commit: false });
    await t.host.emit('click', act('preview')); await flush();
    await t.host.emit('click', act('write')); await flush();
    expect(B.longDwellSp.write).not.toHaveBeenCalled();
    expect(t.host.innerHTML).toContain('longDwell.sharepointWriteCommit');
  });
  it('Save link calls setLink with the trimmed url and re-fetches status', async () => {
    const t = await active({ ...STATUS, link: null });
    t.host.stub('[data-ldsp-input="link"]', { value: '  ' + LINK.url + '  ' });
    await t.host.emit('click', act('save-link'));
    await flush();
    expect(B.longDwellSp.setLink).toHaveBeenCalledWith({ url: LINK.url });
    expect(B.longDwellSp.status).toHaveBeenCalledTimes(2);
  });
  it('a failed preview shows friendly text, not the code alone', async () => {
    B.longDwellSp.preview = vi.fn(async () => ({ ok: false, code: 'auth-required' }));
    const t = await active();
    await t.host.emit('click', act('preview')); await flush();
    expect(t.host.innerHTML).toContain('Sign in: click Open sheet');
  });
});
