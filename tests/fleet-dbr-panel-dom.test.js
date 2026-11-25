// tests/fleet-dbr-panel-dom.test.js — the Daily Call Fleet DBR panel
// controller (renderer/src/js/views/fleet-dbr-panel.js) driven through a small
// fake DOM (node environment, no jsdom; pattern from
// tests/longdwell-sp-render.test.js) and a fake fleetDbr bridge. Also the
// static QuickSight-retirement checks on daily-call.js. Synthetic data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const B = vi.hoisted(() => ({ fleetDbr: {} }));
vi.mock('../renderer/src/js/bridge.js', () => B);

const L = await import('../renderer/src/js/views/fleet-dbr-logic.js');
const P = await import('../renderer/src/js/views/fleet-dbr-panel.js');
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeFleetRows } = require('./fixtures/fleet-dbr/make-rows');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'renderer', 'src', 'js', 'views');

// ── fake DOM ────────────────────────────────────────────────────────────────
class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attrs = {}; this.listeners = {}; this.id = ''; this.className = ''; this._html = ''; this.textContent = '';
    this.style = {}; this.focused = 0;
  }
  focus() { this.focused++; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); this.children.push(n); n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  async emit(t, ev) { for (const fn of this.listeners[t] || []) await fn(ev); }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  _walk(fn) { for (const c of this.children) { const r = fn(c) || c._walk(fn); if (r) return r; } return null; }
  querySelector(sel) { return sel[0] === '#' ? this._walk((c) => (c.id === sel.slice(1) ? c : null)) : null; }
}
function makeDoc() {
  const doc = { activeElement: null };
  doc.createElement = (t) => new FakeEl(t, doc);
  doc.body = new FakeEl('body', doc);
  return doc;
}
const act = (action, ds = {}) => {
  const el = { dataset: { fdbrAction: action, ...ds }, textContent: 'btn' };
  return { target: { closest: (s) => (s === '[data-fdbr-action]' ? el : null), dataset: {} }, el };
};
const typing = (key, col, value) => ({ target: { dataset: { key, col }, value, style: {}, scrollHeight: 40 } });
const flush = async (n = 200) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── fixture model + fake bridge ─────────────────────────────────────────────
const TODAY = '2026-11-10';
const BUILT = F.buildFleetDbr(makeFleetRows(), { today: TODAY });
BUILT.builtAt = '2026-11-10T15:31:00Z';
BUILT.fleetSyncedAt = '2026-11-10T15:30:00Z';
const modelWith = (drafts = {}, extra = {}) => F.applyOverlays(BUILT, { today: TODAY, drafts, flags: { aiDraft: true }, ...extra });
const DOWN_KEYS = BUILT.rows.filter((r) => r.pair.down > 0).map((r) => r.key);
const ZERO_KEYS = BUILT.rows.filter((r) => r.pair.down === 0).map((r) => r.key);
const hashOf = (k) => BUILT.rows.find((r) => r.key === k).unitsHash;
const SYNC_MS = Date.parse(BUILT.fleetSyncedAt);
const FRESH_NOW = SYNC_MS + 30 * 60000;
// A stored v3 draft (overlay v3: only its sheet prose cells overlay).
const v3d = (k, sheet, over = {}) => {
  const r = BUILT.rows.find((x) => x.key === k);
  return Object.assign({ version: 3, unitsHash: r.unitsHash, evidenceHash: r.evidenceHash, draftedAt: 'X', sheet, identity: { alias: true, names: 0, fasTagged: 0 } }, over);
};
// Visible-scope copy (no roster in the fixture -> the 'mine' scope is unavailable) in sheet order.
const visibleCopy = (m, hideZero = false, scacs = []) => L.copyRows(m, 'visible', hideZero, scacs);

let api; let calls; let drafts; let pendingDrafts; let maxInFlight; let inFlight; let manualDraft;
function makeApi({ enabled = true, aiDraft = true, getModel = null } = {}) {
  calls = []; drafts = {}; pendingDrafts = []; maxInFlight = 0; inFlight = 0;
  const rec = (name, fn) => vi.fn(async (p) => { calls.push(name); return fn(p); });
  return {
    status: rec('status', () => ({ ok: true, enabled, aiDraft: enabled && aiDraft })),
    get: rec('get', () => ({ ok: true, model: getModel })),
    build: rec('build', () => ({ ok: true, model: modelWith(drafts), saved: true })),
    saveEdit: rec('saveEdit', () => ({ ok: true })),
    resetRow: rec('resetRow', () => ({ ok: true })),
    setFasName: rec('setFasName', (p) => ({ ok: true, fasName: p.name.trim() })),
    draft: vi.fn((p) => {
      calls.push('draft');
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const done = (res) => { inFlight--; return res; };
      if (!manualDraft) {
        drafts[p.key] = v3d(p.key, { fasActions: '\u2022 ' + p.key + ': call vendor', support: 'None' });
        return Promise.resolve(done({ ok: true, key: p.key, sheet: drafts[p.key].sheet, model: modelWith(drafts) }));
      }
      return new Promise((resolve) => pendingDrafts.push({ key: p.key, resolve: (res) => resolve(done(res)) }));
    }),
  };
}
function setup(opts = {}) {
  manualDraft = !!opts.manualDraft;
  api = makeApi(opts);
  const doc = makeDoc();
  const clipboard = { writeText: vi.fn(async () => true) };
  const store = { ...(opts.store || {}) };
  const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const unsub = vi.fn();
  const busHandlers = {};
  const bus = { on: vi.fn((ev, fn) => { busHandlers[ev] = fn; return unsub; }) };
  const returnFocusEl = { focus: vi.fn() };
  // Clock 30 min after the fixture's fleet sync, so the stale-data alert is off unless a test moves it.
  const clock = { t: opts.nowMs || FRESH_NOW };
  const extra = { now: () => clock.t };
  if (opts.setTimeout) Object.assign(extra, { setTimeout: opts.setTimeout, clearTimeout: opts.clearTimeout });
  const ctl = P.__test__.createController({ api, doc, clipboard, storage, bus, returnFocusEl, ...extra });
  return { ctl, doc, clipboard, store, bus, busHandlers, unsub, returnFocusEl, clock };
}
const overlayOf = (t) => t.doc.body.children[0];
const box = (t) => overlayOf(t).children[0];
const part = (t, id) => overlayOf(t).querySelector('#' + id);

beforeEach(() => { B.fleetDbr = {}; });
afterEach(() => { vi.useRealTimers(); });

describe('open flow', () => {
  it('status -> get (null) -> build; dialog semantics, notes and the 24-column table render', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    expect(calls).toEqual(['status', 'get', 'build']);
    const ov = overlayOf(t);
    expect(ov.id).toBe('dbr-overlay');
    expect(box(t).attrs).toMatchObject({ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fdbr-title' });
    const frame = part(t, 'fdbr-frame').innerHTML;
    expect(frame).toContain('ETC is best-effort');
    expect(frame).toContain('\u21ba Build from fleet data');
    expect(frame).toContain('id="fdbr-title"');
    expect(part(t, 'fdbr-status').attrs['aria-live']).toBe('polite');
    expect(part(t, 'fdbr-status').textContent).toContain('21 rows');
    const table = part(t, 'fdbr-table').innerHTML;
    expect((table.match(/<th scope="col">/g) || []).length).toBe(25);
    expect(t.bus.on).toHaveBeenCalledWith('fleet:data', expect.any(Function));
  });
  it('an existing model from get() is shown without building', async () => {
    const t = setup({ aiDraft: false, getModel: modelWith() });
    await t.ctl.open(); await flush();
    expect(calls).toEqual(['status', 'get']);
  });
  it('off: shows the off notice and never calls get/build', async () => {
    const t = setup({ enabled: false });
    await t.ctl.open(); await flush();
    expect(calls).toEqual(['status']);
    expect(part(t, 'fdbr-frame').innerHTML).toContain('Fleet DBR is turned off');
    expect(part(t, 'fdbr-table').innerHTML).toBe('');
  });
  it("bridge answering {code:'unavailable'} (preload API missing): the panel says so", async () => {
    const doc = makeDoc();
    const unavailable = async () => ({ ok: false, code: 'unavailable' });
    const ctl = P.__test__.createController({ api: { status: unavailable, get: unavailable, build: unavailable }, doc, clipboard: {}, storage: null, bus: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ctl.open(); await flush();
    warn.mockRestore();
    expect(doc.body.children[0].querySelector('#fdbr-frame').innerHTML).toContain('Fleet DBR unavailable in this build');
  });
  it('Build button calls build again', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('click', act('build')); await flush();
    expect(api.build).toHaveBeenCalledTimes(2);
  });
  it('no-fleet-data build shows the sync hint', async () => {
    const t = setup({ aiDraft: false });
    api.build = vi.fn(async () => ({ ok: false, code: 'no-fleet-data' }));
    await t.ctl.open(); await flush();
    expect(part(t, 'fdbr-status').textContent).toContain('No fleet data yet');
  });
});

describe('edits and copy', () => {
  it('typing in a cell saves key/col/value after the 600 ms debounce', async () => {
    vi.useFakeTimers();
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    const key = DOWN_KEYS[0];
    await overlayOf(t).emit('input', typing(key, 'fasActions', 'first'));
    await overlayOf(t).emit('input', typing(key, 'fasActions', 'first edit'));
    vi.advanceTimersByTime(599);
    expect(api.saveEdit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(api.saveEdit).toHaveBeenCalledWith({ key, col: 'fasActions', value: 'first edit' });
  });
  it('a failed save keeps the text and warns', async () => {
    vi.useFakeTimers();
    const t = setup({ aiDraft: false });
    api.saveEdit = vi.fn(async () => ({ ok: false, code: 'save-failed' }));
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('input', typing(DOWN_KEYS[0], 'support', 'keep me'));
    vi.advanceTimersByTime(600); await flush();
    expect(part(t, 'fdbr-status').textContent).toContain("Couldn't save edit (save-failed)");
    expect(t.ctl.state.live[DOWN_KEYS[0]].support).toBe('keep me');
  });
  it('Copy rows / Copy with header write exactly sheetTsv output (golden format), including the unsaved edit as typed', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    const key = DOWN_KEYS[1];
    await overlayOf(t).emit('input', typing(key, 'noEtc', 'unsaved\ttext'));
    const m = modelWith();
    const live = (r, c) => (r.key === key && c === 'noEtc' ? 'unsaved\ttext' : r.cells[c]);
    const getSource = (r, c) => (r.key === key && c === 'noEtc' ? 'edit' : r.source[c]);
    const a = act('copy');
    await overlayOf(t).emit('click', a); await flush();
    expect(t.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(t.clipboard.writeText.mock.calls[0][0]).toBe(L.sheetTsv(m.columns, visibleCopy(m), live, { getSource }));
    expect(t.clipboard.writeText.mock.calls[0][0]).toContain('\tunsaved text\t');
    expect(t.clipboard.writeText.mock.calls[0][0]).not.toMatch(/\t(Y|N)\t/);
    expect(a.el.textContent).toBe('\u2713 Copied');
    await overlayOf(t).emit('click', act('copy-header')); await flush();
    const withHeader = t.clipboard.writeText.mock.calls[1][0];
    expect(withHeader).toBe(L.sheetTsv(m.columns, visibleCopy(m), live, { header: true, getSource }));
    expect(withHeader.split('\n')[0].split('\t').length).toBe(24);
    expect(part(t, 'fdbr-status').textContent).toContain('Copied 21 rows (all visible rows)');
  });
  it('hide-zero toggle persists and Copy honours it; Copy row copies one row', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('change', { target: { dataset: { fdbrField: 'hideZero' }, checked: true } });
    expect(t.store.fleetDbr__hideZero).toBe('1');
    await overlayOf(t).emit('click', act('copy')); await flush();
    expect(t.clipboard.writeText.mock.calls[0][0].split('\n').length).toBe(DOWN_KEYS.length);
    await overlayOf(t).emit('click', act('copy-row', { key: DOWN_KEYS[0] })); await flush();
    const one = t.clipboard.writeText.mock.calls[1][0];
    expect(one.split('\n').length).toBe(1);
    expect(one.split('\t').length).toBe(24);
  });
  it('clipboard failure shows the manual-copy hint', async () => {
    const t = setup({ aiDraft: false });
    t.clipboard.writeText = vi.fn(async () => false);
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('click', act('copy')); await flush();
    expect(part(t, 'fdbr-status').textContent).toContain('Copy failed');
  });
  it('FAS Name change calls setFasName and fills rows without a roster name', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('change', { target: { dataset: { fdbrField: 'fasName' }, value: '  Pat  ' } });
    await flush();
    expect(api.setFasName).toHaveBeenCalledWith({ name: '  Pat  ' });
    expect(t.ctl.state.model.rows.every((r) => r.cells.fasName === 'Pat')).toBe(true);
    expect(part(t, 'fdbr-status').textContent).toContain('21 rows use your name (no roster match)');
  });
  it('Reset row cancels the pending save, calls resetRow and reloads the model', async () => {
    vi.useFakeTimers();
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    const key = DOWN_KEYS[0];
    await overlayOf(t).emit('input', typing(key, 'support', 'x'));
    await overlayOf(t).emit('click', act('reset-row', { key })); await flush();
    vi.advanceTimersByTime(5000); await flush();
    expect(api.resetRow).toHaveBeenCalledWith({ key });
    expect(api.saveEdit).not.toHaveBeenCalled();
    expect(t.ctl.state.live[key]).toBeUndefined();
    expect(calls.filter((c) => c === 'get').length).toBe(2);
  });
});

describe('AI drafting', () => {
  it('auto-drafts only eligible keys, never more than 2 in flight, and drafts land in editable cells', async () => {
    const t = setup({ manualDraft: true });
    await t.ctl.open(); await flush();
    expect(pendingDrafts.length).toBe(2);
    while (pendingDrafts.length) {
      expect(inFlight).toBeLessThanOrEqual(2);
      const d = pendingDrafts.shift();
      drafts[d.key] = v3d(d.key, { fasActions: '\u2022 ' + d.key + ': call vendor', support: 'None' });
      d.resolve({ ok: true, key: d.key, sheet: drafts[d.key].sheet, model: modelWith(drafts) });
      await flush();
    }
    expect(maxInFlight).toBe(2);
    const drafted = api.draft.mock.calls.map((c) => c[0].key);
    expect(new Set(drafted)).toEqual(new Set(DOWN_KEYS));
    expect(drafted.length).toBe(DOWN_KEYS.length);
    for (const z of ZERO_KEYS) expect(drafted).not.toContain(z);
    const table = part(t, 'fdbr-table').innerHTML;
    const k = DOWN_KEYS[0];
    expect(table).toContain('data-key="' + L.esc(k) + '" data-col="fasActions" aria-label="FAS Actions \u2014 ' + k.replace('|', '/') + '">' + L.esc('\u2022 ' + k + ': call vendor') + '</textarea>');
    expect(part(t, 'fdbr-status').textContent).toContain('AI ' + DOWN_KEYS.length + '/' + DOWN_KEYS.length);
    // Only the fleetDbr bridge was used: nothing is sent anywhere but the clipboard on Copy.
    expect(new Set(calls)).toEqual(new Set(['status', 'get', 'build', 'draft']));
    expect(t.clipboard.writeText).not.toHaveBeenCalled();
    expect(t.ctl.state.drafting).toBe(false);
  });
  it('rows already drafted (ok) or with both AI cells edited are skipped; Redraft forces one row', async () => {
    const [okKey, bothKey] = DOWN_KEYS;
    const allEdited = Object.fromEntries(F.AI_CELL_IDS.filter((id) => F.EDITABLE_IDS.includes(id)).map((id) => [id, 'x']));
    const m = modelWith({ [okKey]: v3d(okKey, { fasActions: 'a', support: 'b' }) }, { edits: { [bothKey]: allEdited } });
    const t = setup({ getModel: m });
    await t.ctl.open(); await flush();
    const drafted = api.draft.mock.calls.map((c) => c[0].key);
    expect(drafted).not.toContain(okKey);
    expect(drafted).not.toContain(bothKey);
    expect(drafted.length).toBe(DOWN_KEYS.length - 2);
    await overlayOf(t).emit('click', act('redraft', { key: okKey })); await flush();
    expect(api.draft).toHaveBeenLastCalledWith({ key: okKey });
  });
  it('AI off: no draft calls and no AI buttons', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('click', act('draft-all')); await flush();
    expect(api.draft).not.toHaveBeenCalled();
    expect(part(t, 'fdbr-frame').innerHTML).not.toContain('draft-all');
    expect(part(t, 'fdbr-table').innerHTML).not.toContain('data-fdbr-action="redraft"');
  });
  it('Stop issues no new requests; in-flight results still land', async () => {
    const t = setup({ manualDraft: true });
    await t.ctl.open(); await flush();
    expect(part(t, 'fdbr-frame').innerHTML).toContain('data-fdbr-action="stop"');
    await overlayOf(t).emit('click', act('stop'));
    const first = pendingDrafts.shift();
    drafts[first.key] = v3d(first.key, { fasActions: 'landed', support: 'None' });
    first.resolve({ ok: true, key: first.key, sheet: drafts[first.key].sheet, model: modelWith(drafts) });
    pendingDrafts.shift().resolve({ ok: false, code: 'ai-timeout' });
    await flush();
    expect(api.draft).toHaveBeenCalledTimes(2);
    expect(part(t, 'fdbr-table').innerHTML).toContain('>landed</textarea>');
    expect(part(t, 'fdbr-table').innerHTML).toContain('\u26a0 ai-timeout');
    expect(part(t, 'fdbr-frame').innerHTML).toContain('data-fdbr-action="draft-all"');
  });
  it('busy is re-queued after 2 s (max 3 retries)', async () => {
    vi.useFakeTimers();
    const t = setup({ manualDraft: true });
    await t.ctl.open(); await flush();
    const key = pendingDrafts[0].key;
    pendingDrafts.shift().resolve({ ok: false, code: 'busy' });
    await flush();
    const before = api.draft.mock.calls.filter((c) => c[0].key === key).length;
    vi.advanceTimersByTime(2000); await flush();
    // the retry waits for a free slot: free one
    pendingDrafts.shift().resolve({ ok: false, code: 'ai-failed' });
    await flush();
    const keysCalled = api.draft.mock.calls.map((c) => c[0].key);
    expect(keysCalled.filter((k) => k === key).length).toBe(before + 1);
  });
  it('stale-build shows the "Fleet data updated" banner', async () => {
    const t = setup({ manualDraft: true });
    await t.ctl.open(); await flush();
    pendingDrafts.shift().resolve({ ok: false, code: 'stale-build' });
    await flush();
    expect(part(t, 'fdbr-banner').innerHTML).toContain('Fleet data updated');
    expect(part(t, 'fdbr-banner').innerHTML).toContain('data-fdbr-action="build"');
  });
  it('a fleet:data sync with a new syncedAt shows the banner (no auto-rebuild)', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    t.busHandlers['fleet:data']({ rows: [], syncedAt: BUILT.fleetSyncedAt });
    expect(part(t, 'fdbr-banner').innerHTML).toBe('');
    t.busHandlers['fleet:data']({ rows: [], syncedAt: '2026-11-10T16:00:00Z' });
    expect(part(t, 'fdbr-banner').innerHTML).toContain('Fleet data updated');
    expect(api.build).toHaveBeenCalledTimes(1);
  });
});

// v3 stored draft for one row (overlay v3).
const v2 = (k, over = {}) => v3d(k, { oemYN: 'Y', oemDetails: 'AI oem sentence.', fasActions: 'AI fas sentence.', support: 'None.' },
  Object.assign({ unitNotes: { fasActions: '\u2022 AI fas' }, flags: { oemYN: 'review', fasActions: 'review' } }, over));

describe('AI v3 cells (FEAT-004)', () => {
  it('24 columns with AI on; only the sheet prose cells carry the AI marker; Y/N stay computed', async () => {
    const k = DOWN_KEYS[0];
    const okAll = Object.fromEntries(DOWN_KEYS.map((x) => [x, v2(x)]));
    const t = setup({ getModel: modelWith(okAll) });
    await t.ctl.open(); await flush();
    expect(api.draft).not.toHaveBeenCalled(); // every row has an ok draft
    const table = part(t, 'fdbr-table').innerHTML;
    expect((table.match(/<th scope="col">/g) || []).length).toBe(25);
    expect(table).toContain('<td data-key="' + L.esc(k) + '" data-col="oemYN">No</td>');
    expect(table).toContain('aria-label="FAS Actions \u2014 ' + k.replace('|', '/') + '">AI fas sentence.</textarea>'
      + '<span class="fdbr-marks" data-mark-key="' + L.esc(k) + '" data-mark-col="fasActions"><span class="fdbr-mark">AI</span></span>');
    expect(table).not.toContain('\u26a0 check</span></td>');
  });

  it('AC30: _patchDraft v3 — res.sheet patches only the draft sheet ids (Details only when Y); the next queued row starts', async () => {
    const t = setup({ manualDraft: true, getModel: modelWith() });
    await t.ctl.open(); await flush();
    expect(pendingDrafts.length).toBe(2);
    const first = pendingDrafts.shift();
    const before = t.ctl.state.model.rows.find((r) => r.key === first.key);
    const sheet = { oemYN: 'Y', oemDetails: 'AI oem', fasActions: 'AI fas', support: 'None.', etcToday: '9', domicileDown: '999' };
    first.resolve({ ok: true, key: first.key, sheet, unitNotes: { fasActions: '\u2022 X: y' }, flags: { fasActions: 'review', oemYN: 'review' }, draftedAt: 'T' });
    await flush();
    expect(api.draft).toHaveBeenCalledTimes(3); // the next queued row started (no stall)
    const row = t.ctl.state.model.rows.find((r) => r.key === first.key);
    expect([row.cells.fasActions, row.source.fasActions]).toEqual(['AI fas', 'ai']);
    expect([row.cells.support, row.source.support]).toEqual(['None.', 'ai']);
    for (const id of ['oemYN', 'oemDetails', 'etcToday', 'domicileDown']) {
      expect(row.cells[id], id).toBe(before.cells[id]);
      expect(row.source[id], id).toBe('computed');
    }
    expect(row.unitNotes).toEqual({ fasActions: '\u2022 X: y' });
    expect(row.unitNoteFlags).toEqual({ fasActions: 'review' });
    expect(row.flags).toEqual({});
    expect(row.draft.state).toBe('ok');
    expect(row.etcUnits).toEqual([]);
    const table = part(t, 'fdbr-table').innerHTML;
    expect(table).toContain('data-col="fasActions" aria-label="FAS Actions \u2014 ' + first.key.replace('|', '/') + '">AI fas</textarea>');
    // A response without `sheet` (v1/v2 shape) patches no cell.
    const second = pendingDrafts.shift();
    const before2 = t.ctl.state.model.rows.find((r) => r.key === second.key).cells;
    second.resolve({ ok: true, key: second.key, fasActions: '\u2022 v1', support: 'None', cells: { oemYN: 'Y' } });
    await flush();
    const r2 = t.ctl.state.model.rows.find((r) => r.key === second.key);
    expect(r2.cells).toEqual(before2);
    expect(r2.source.oemYN).toBe('computed');
    expect(api.draft).toHaveBeenCalledTimes(4);
  });

  it('R-N3: an identity-stale result with res.model present is re-queued once per panel', async () => {
    const t = setup({ manualDraft: true, getModel: modelWith() });
    await t.ctl.open(); await flush();
    const k = pendingDrafts[0].key;
    const staleModel = () => modelWith({ [k]: v2(k, { identity: { alias: false, names: 0, fasTagged: 0 } }) }, { fasAliasKnown: true });
    expect(staleModel().rows.find((r) => r.key === k).draft.staleReason).toBe('identity');
    pendingDrafts.shift().resolve({ ok: true, key: k, cells: {}, model: staleModel() });
    await flush();
    const count = () => api.draft.mock.calls.filter((c) => c[0].key === k).length;
    // drain: answer every pending draft with the identity-stale model again
    for (let i = 0; i < 40 && pendingDrafts.length; i++) {
      const d = pendingDrafts.shift();
      d.resolve({ ok: true, key: d.key, cells: {}, model: staleModel() });
      await flush();
    }
    expect(count()).toBe(2);
    expect(t.ctl.state.identityRequeued.has(k)).toBe(true);
    expect(t.ctl.state.drafting).toBe(false);
  });

  it('Draft all also queues evidence-stale rows; panel open does not', async () => {
    const k = DOWN_KEYS[0];
    const okAll = Object.fromEntries(DOWN_KEYS.map((x) => [x, v2(x)]));
    okAll[k] = v2(k, { evidenceHash: 'old' });
    const t = setup({ getModel: modelWith(okAll) });
    await t.ctl.open(); await flush();
    expect(api.draft).not.toHaveBeenCalled();
    await overlayOf(t).emit('click', act('draft-all')); await flush();
    expect(api.draft.mock.calls.map((c) => c[0].key)).toEqual([k]);
  });
});

describe('SCAC filter', () => {
  const scacEv = (scac, checked) => ({ target: { dataset: { fdbrField: 'scac', scac }, checked } });
  const rowCount = (t) => (part(t, 'fdbr-table').innerHTML.match(/<tr data-key=/g) || []).length;
  const scacOf = (k) => BUILT.rows.find((r) => r.key === k).scac;
  const downOf = (scac) => DOWN_KEYS.filter((k) => scacOf(k) === scac);
  const draftedKeys = () => api.draft.mock.calls.map((c) => c[0].key);

  it('renders the distinct SCACs (none checked) and all 21 rows by default', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    const frame = part(t, 'fdbr-frame').innerHTML;
    expect((frame.match(/data-fdbr-field="scac"/g) || []).length).toBe(11);
    expect(frame).not.toMatch(/data-fdbr-field="scac"[^>]* checked/);
    expect(frame).not.toContain('scac-all');
    expect(rowCount(t)).toBe(21);
  });

  it('selecting a SCAC narrows rows, persists, updates the status line and Copy; All SCACs resets', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('change', scacEv('TUZR', true));
    expect(rowCount(t)).toBe(3);
    expect(t.store[P.__test__.SCAC_KEY]).toBe('["TUZR"]');
    expect(part(t, 'fdbr-status').textContent).toContain('3 of 21 rows');
    expect(part(t, 'fdbr-frame').innerHTML).toContain('data-scac="TUZR" value="TUZR" checked>');
    await overlayOf(t).emit('click', act('copy')); await flush();
    expect(t.clipboard.writeText.mock.calls[0][0].split('\n').length).toBe(3);
    await overlayOf(t).emit('change', scacEv('SAPB', true));
    expect(rowCount(t)).toBe(5);
    expect(t.store.fleetDbr__scacs).toBe('["SAPB","TUZR"]');
    await overlayOf(t).emit('change', scacEv('TUZR', false));
    expect(rowCount(t)).toBe(2);
    await overlayOf(t).emit('click', act('scac-all')); await flush();
    expect(rowCount(t)).toBe(21);
    expect(t.store.fleetDbr__scacs).toBe('[]');
    expect(part(t, 'fdbr-status').textContent).toContain('21 rows');
  });

  it('restores the persisted selection, ignoring SCACs no longer in the model; malformed -> all rows', async () => {
    const t = setup({ aiDraft: false, store: { fleetDbr__scacs: '["TUZR","ZZZZ"]' } });
    await t.ctl.open(); await flush();
    const frame = part(t, 'fdbr-frame').innerHTML;
    expect((frame.match(/ checked>/g) || []).length).toBe(1);
    expect(frame).toContain('data-scac="TUZR" value="TUZR" checked>');
    expect(rowCount(t)).toBe(3);
    const bad = setup({ aiDraft: false, store: { fleetDbr__scacs: '{not json' } });
    await bad.ctl.open(); await flush();
    expect(rowCount(bad)).toBe(21);
  });

  it('auto-draft only queues visible rows; widening the filter drafts the new rows once, never re-drafts', async () => {
    const t = setup({ store: { fleetDbr__scacs: '["TUZR"]' } });
    await t.ctl.open(); await flush();
    expect(new Set(draftedKeys())).toEqual(new Set(downOf('TUZR')));
    expect(draftedKeys().length).toBe(2);
    expect(part(t, 'fdbr-status').textContent).toContain('AI 2/2');
    await overlayOf(t).emit('change', scacEv('SAPB', true)); await flush();
    expect(new Set(draftedKeys())).toEqual(new Set([...downOf('TUZR'), ...downOf('SAPB')]));
    expect(draftedKeys().length).toBe(4);
    expect(t.ctl.state.drafting).toBe(false);
  });

  it('narrowing while drafting: in-flight drafts land, hidden queued rows are dropped, progress counts visible rows', async () => {
    const t = setup({ manualDraft: true, store: { fleetDbr__scacs: '["SAPB","TUZR"]' } });
    await t.ctl.open(); await flush();
    expect(pendingDrafts.length).toBe(2);
    const inFlightKeys = pendingDrafts.map((d) => d.key);
    const hidden = scacOf(t.ctl.state.queue[0].key);
    const kept = hidden === 'TUZR' ? 'SAPB' : 'TUZR';
    const dropped = t.ctl.state.queue.map((q) => q.key).filter((k) => scacOf(k) === hidden);
    expect(dropped.length).toBeGreaterThan(0);
    await overlayOf(t).emit('change', scacEv(hidden, false)); await flush();
    expect(t.ctl.state.queue.some((q) => dropped.includes(q.key))).toBe(false);
    for (const k of dropped) expect(t.ctl.state.rowStatus[k]).toBeUndefined();
    expect(pendingDrafts.length).toBe(2); // nothing aborted
    for (let i = 0; i < 10 && pendingDrafts.length; i++) {
      const d = pendingDrafts.shift();
      drafts[d.key] = v3d(d.key, { fasActions: 'landed ' + d.key, support: 'None' });
      d.resolve({ ok: true, key: d.key, sheet: drafts[d.key].sheet, model: modelWith(drafts) });
      await flush();
    }
    for (const k of dropped) expect(draftedKeys()).not.toContain(k);
    for (const k of inFlightKeys) expect(t.ctl.state.model.rows.find((r) => r.key === k).draft.state).toBe('ok');
    expect(new Set(draftedKeys())).toEqual(new Set([...inFlightKeys, ...downOf(kept)]));
    expect(t.ctl.state.drafting).toBe(false);
    const status = part(t, 'fdbr-status').textContent;
    expect(status).toContain('AI 2/2');
    expect(status).toContain('SCAC: ' + kept);
  });

  it('after ■ Stop, changing the filter starts no new drafts', async () => {
    const t = setup({ manualDraft: true });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('click', act('stop'));
    await overlayOf(t).emit('change', scacEv('TUZR', true)); await flush();
    await overlayOf(t).emit('change', scacEv('SAPB', true)); await flush();
    expect(api.draft).toHaveBeenCalledTimes(2);
  });

  it('Copy fill columns copies only the 17 fill columns of the visible (filtered) rows', async () => {
    const t = setup({ aiDraft: false, store: { fleetDbr__scacs: '["TUZR"]' } });
    await t.ctl.open(); await flush();
    expect(part(t, 'fdbr-frame').innerHTML).toContain('data-fdbr-action="copy-fill"');
    const key = downOf('TUZR')[0];
    await overlayOf(t).emit('input', typing(key, 'support', 'two\nlines'));
    const a = act('copy-fill');
    await overlayOf(t).emit('click', a); await flush();
    expect(t.clipboard.writeText).toHaveBeenCalledTimes(1);
    const tsv = t.clipboard.writeText.mock.calls[0][0];
    const m = modelWith();
    const live = (r, c) => (r.key === key && c === 'support' ? 'two\nlines' : r.cells[c]);
    const getSource = (r, c) => (r.key === key && c === 'support' ? 'edit' : r.source[c]);
    // Fill columns also go through sheetValue (Yes/No, bare counts).
    expect(tsv).toBe(L.sheetTsv(L.fillColumns(m), visibleCopy(m, false, ['TUZR']), live, { getSource }));
    expect(tsv.split('\n')[0].split('\t')[0]).toMatch(/^(Yes|No)$/);
    const lines = tsv.split('\n');
    expect(lines.length).toBe(3);
    for (const line of lines) expect(line.split('\t').length).toBe(17);
    expect(tsv).toContain('two lines');
    expect(tsv).not.toContain('TUZR'); // SCAC / domicile identity columns are omitted
    expect(a.el.textContent).toBe('\u2713 Copied');
  });
});

describe('copy scope, copy note, freshness (FEAT-004)', () => {
  const ME = 'Z Santiago';
  const MINE = ['ROC5|AUVTE', 'ABE40|SAPB', 'AVP40|YTSC'];
  const roster = (over = {}) => Object.assign({
    rosterExact: Object.fromEntries(MINE.map((k) => [k, ME])), rosterLoaded: true, fasNameOverride: ME,
  }, over);
  const frameOf = (t) => part(t, 'fdbr-frame').innerHTML;

  it('scope select: "mine" by default, persisted on change, invalid stored value -> mine', async () => {
    const t = setup({ aiDraft: false, getModel: modelWith({}, roster()), store: { [P.__test__.COPY_SCOPE_KEY]: 'bogus' } });
    await t.ctl.open(); await flush();
    expect(P.__test__.COPY_SCOPE_KEY).toBe('fleetDbr__copyScope');
    expect(t.ctl.state.copyScope).toBe('mine');
    expect(frameOf(t)).toContain('<option value="mine" selected>My pairs with units down (3)</option>');
    expect(frameOf(t)).toContain('<option value="visible">All visible rows (21)</option>');
    await overlayOf(t).emit('change', { target: { dataset: { fdbrField: 'copyScope' }, value: 'visible' } });
    expect(t.store.fleetDbr__copyScope).toBe('visible');
    expect(frameOf(t)).toContain('<option value="visible" selected>');
    await overlayOf(t).emit('change', { target: { dataset: { fdbrField: 'copyScope' }, value: '<x>' } });
    expect(t.store.fleetDbr__copyScope).toBe('mine');
    const s = setup({ aiDraft: false, getModel: modelWith({}, roster()), store: { fleetDbr__copyScope: 'visible' } });
    await s.ctl.open(); await flush();
    expect(s.ctl.state.copyScope).toBe('visible');
  });

  it('DR2-13: "mine" disabled with a note when no roster, no FAS name, or no pair matches the name', async () => {
    for (const [extra, text] of [
      [{ fasNameOverride: ME }, 'FAS roster not loaded \u2014 copying all visible rows'],
      [roster({ fasNameOverride: '' }), 'Set your FAS name to copy only your pairs'],
      [roster({ fasNameOverride: 'Z Santiagoo' }), "No roster pairs match &#39;Z Santiagoo&#39; \u2014 check your FAS name"],
    ]) {
      const t = setup({ aiDraft: false, getModel: modelWith({}, extra) });
      await t.ctl.open(); await flush();
      expect(frameOf(t)).toMatch(/<option value="mine" disabled>/);
      expect(frameOf(t)).toContain(text);
      await overlayOf(t).emit('click', act('copy')); await flush();
      expect(t.clipboard.writeText.mock.calls[0][0].split('\n')).toHaveLength(21); // falls back to the visible rows
    }
  });

  it('copy uses the scope and the golden format; note "Copied N rows (your pairs with units down)"; AI clause only with aiDraft (DR2-10)', async () => {
    const m = modelWith({}, roster());
    const t = setup({ aiDraft: false, getModel: m });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('click', act('copy-header')); await flush();
    const tsv = t.clipboard.writeText.mock.calls[0][0];
    expect(tsv).toBe(L.sheetTsv(m.columns, L.copyRows(m, 'mine', false, []), null, { header: true }));
    const lines = tsv.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.slice(1).map((l) => l.split('\t')[0])).toEqual([ME, ME, ME]);
    expect(lines.slice(1).map((l) => l.split('\t')[1] + '|' + l.split('\t')[4]).sort()).toEqual(MINE.slice().sort());
    // model.flags.aiDraft on and no current drafts -> the auto-text clause.
    expect(part(t, 'fdbr-status').textContent).toContain('Copied 3 rows (your pairs with units down) \u00b7 3 rows use auto text (AI draft pending)');
    const k = MINE[0];
    const t2 = setup({ aiDraft: false, getModel: modelWith({ [k]: v3d(k, { fasActions: 'x' }) }, roster()) });
    await t2.ctl.open(); await flush();
    await overlayOf(t2).emit('click', act('copy')); await flush();
    expect(part(t2, 'fdbr-status').textContent).toContain('\u00b7 2 rows use auto text (AI draft pending)');
    // AI drafting off -> no clause.
    const off = F.applyOverlays(BUILT, { today: TODAY, flags: { aiDraft: false }, ...roster() });
    const t3 = setup({ aiDraft: false, getModel: off });
    await t3.ctl.open(); await flush();
    await overlayOf(t3).emit('click', act('copy')); await flush();
    expect(part(t3, 'fdbr-status').textContent).toContain('Copied 3 rows (your pairs with units down)');
    expect(part(t3, 'fdbr-status').textContent).not.toContain('auto text');
    // Copy row keeps the single clicked row, whatever the scope.
    const zero = ZERO_KEYS[0];
    await overlayOf(t3).emit('click', act('copy-row', { key: zero })); await flush();
    expect(t3.clipboard.writeText.mock.calls[1][0]).toBe(L.sheetTsv(off.columns, [off.rows.find((r) => r.key === zero)], null, {}));
    expect(part(t3, 'fdbr-status').textContent).toContain('Copied 1 row');
  });

  it('AC12: stale banner + status age at 121 min, none at 119 min; the 60 s tick updates the age; copy note warns', async () => {
    vi.useFakeTimers();
    const t = setup({ aiDraft: false, getModel: modelWith(), nowMs: SYNC_MS + 119 * 60000 });
    await t.ctl.open(); await flush();
    expect(part(t, 'fdbr-banner').innerHTML).toBe('');
    expect(part(t, 'fdbr-status').textContent).toContain('(1h 59m old)');
    t.clock.t = SYNC_MS + 121 * 60000;
    vi.advanceTimersByTime(P.__test__.FRESH_TICK_MS);
    expect(P.__test__.FRESH_TICK_MS).toBe(60000);
    const banner = part(t, 'fdbr-banner').innerHTML;
    expect(banner).toContain('class="fdbr-banner fdbr-banner--stale" role="alert"');
    expect(banner).toContain('\u26a0 Fleet data is 2h 1m old');
    expect(part(t, 'fdbr-status').textContent).toContain('(2h 1m old)');
    t.clock.t += 60000;
    vi.advanceTimersByTime(60000);
    expect(part(t, 'fdbr-banner').innerHTML).toContain('2h 2m old');
    await overlayOf(t).emit('click', act('copy')); await flush();
    expect(part(t, 'fdbr-status').textContent).toContain('\u00b7 \u26a0 fleet data is 2h 2m old');
    // The stale alert comes first, then the existing "Fleet data updated" banner.
    t.busHandlers['fleet:data']({ rows: [], syncedAt: '2026-11-10T18:00:00Z' });
    const both = part(t, 'fdbr-banner').innerHTML;
    expect(both.indexOf('fdbr-banner--stale')).toBeLessThan(both.indexOf('Fleet data updated'));
  });

  it('the freshness tick is cleared on close', async () => {
    const live = new Map();
    let seq = 0;
    const setT = (fn, ms) => { const id = ++seq; live.set(id, { fn, ms }); return id; };
    const clrT = (id) => { live.delete(id); };
    const t = setup({ aiDraft: false, getModel: modelWith(), setTimeout: setT, clearTimeout: clrT });
    await t.ctl.open(); await flush();
    expect([...live.values()].some((x) => x.ms === P.__test__.FRESH_TICK_MS)).toBe(true);
    t.ctl.close();
    expect(live.size).toBe(0);
  });
});

describe('close', () => {
  it('Escape closes, removes the overlay, unsubscribes and returns focus', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('keydown', { key: 'Escape', preventDefault() {} });
    expect(t.doc.body.children.length).toBe(0);
    expect(t.unsub).toHaveBeenCalled();
    expect(t.returnFocusEl.focus).toHaveBeenCalled();
  });
  it('× and backdrop close; pending edits are flushed on close', async () => {
    vi.useFakeTimers();
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('input', typing(DOWN_KEYS[0], 'support', 'flush me'));
    await overlayOf(t).emit('click', act('close'));
    expect(api.saveEdit).toHaveBeenCalledWith({ key: DOWN_KEYS[0], col: 'support', value: 'flush me' });
    expect(t.doc.body.children.length).toBe(0);
    const t2 = setup({ aiDraft: false });
    await t2.ctl.open(); await flush();
    const ov = overlayOf(t2);
    await ov.emit('click', { target: ov });
    expect(t2.doc.body.children.length).toBe(0);
  });
});

describe('static: QuickSight UI retired', () => {
  const dc = fs.readFileSync(path.join(VIEWS, 'daily-call.js'), 'utf8');
  it('daily-call.js has no quicksight reference and no old panel functions', () => {
    expect(dc).not.toMatch(/quicksight/i);
    for (const n of ['_dbrAfpPrompt', '_dbrDspPrompt', '_openDbrPanel', '_dbrPanelHtml', '_dbrRenderTables', '_dbrHeaderGet']) expect(dc).not.toContain(n);
    // DBR DATA now routes to the first-class DBR tab (views/dbr-view.js), not the modal.
    expect(dc).toContain("bus.emit('ui:select-tab', { key: 'dbr' })");
    expect(dc).not.toContain('openFleetDbrPanel(');
    expect(dc).toContain('\ud83d\udcca DBR DATA</button>');
  });
  it('the new panel files have no quicksight reference and no send path besides the clipboard', () => {
    for (const f of ['fleet-dbr-panel.js', 'fleet-dbr-logic.js']) {
      const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
      expect(src, f).not.toMatch(/quicksight/i);
      expect(src, f).not.toMatch(/window\.ai\b|\bslack\b|sendMail|\bowa\b|\bfetch\(/i);
    }
  });
});
