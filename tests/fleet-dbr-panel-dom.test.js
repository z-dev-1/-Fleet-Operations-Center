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
        drafts[p.key] = { fasActions: '\u2022 ' + p.key + ': call vendor', support: 'None', unitsHash: hashOf(p.key) };
        return Promise.resolve(done({ ok: true, key: p.key, fasActions: drafts[p.key].fasActions, support: 'None', model: modelWith(drafts) }));
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
  const store = {};
  const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const unsub = vi.fn();
  const busHandlers = {};
  const bus = { on: vi.fn((ev, fn) => { busHandlers[ev] = fn; return unsub; }) };
  const returnFocusEl = { focus: vi.fn() };
  const ctl = P.__test__.createController({ api, doc, clipboard, storage, bus, returnFocusEl });
  return { ctl, doc, clipboard, store, bus, busHandlers, unsub, returnFocusEl };
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
  it('Copy rows / Copy with header write exactly rowsToTsv output, including the unsaved edit', async () => {
    const t = setup({ aiDraft: false });
    await t.ctl.open(); await flush();
    const key = DOWN_KEYS[1];
    await overlayOf(t).emit('input', typing(key, 'noEtc', 'unsaved\ttext'));
    const m = modelWith();
    const live = (r, c) => (r.key === key && c === 'noEtc' ? 'unsaved\ttext' : r.cells[c]);
    const a = act('copy');
    await overlayOf(t).emit('click', a); await flush();
    expect(t.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(t.clipboard.writeText.mock.calls[0][0]).toBe(L.rowsToTsv(m.columns, m.rows, live));
    expect(t.clipboard.writeText.mock.calls[0][0]).toContain('"unsaved\ttext"');
    expect(a.el.textContent).toBe('\u2713 Copied');
    await overlayOf(t).emit('click', act('copy-header')); await flush();
    const withHeader = t.clipboard.writeText.mock.calls[1][0];
    expect(withHeader).toBe(L.rowsToTsv(m.columns, m.rows, live, { header: true }));
    expect(withHeader.split('\n')[0].split('\t').length).toBe(24);
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
      drafts[d.key] = { fasActions: '\u2022 ' + d.key + ': call vendor', support: 'None', unitsHash: hashOf(d.key) };
      d.resolve({ ok: true, key: d.key, fasActions: drafts[d.key].fasActions, support: 'None', model: modelWith(drafts) });
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
    const m = modelWith({ [okKey]: { fasActions: 'a', support: 'b', unitsHash: hashOf(okKey) } }, { edits: { [bothKey]: allEdited } });
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
    drafts[first.key] = { fasActions: 'landed', support: 'None', unitsHash: hashOf(first.key) };
    first.resolve({ ok: true, key: first.key, fasActions: 'landed', support: 'None', model: modelWith(drafts) });
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

// v2 stored draft for one row (FEAT-004).
const rowOfBuilt = (k) => BUILT.rows.find((r) => r.key === k);
function v2(k, over = {}) {
  const r = rowOfBuilt(k);
  return Object.assign({
    version: 2, unitsHash: r.unitsHash, evidenceHash: r.evidenceHash, draftedAt: 'X',
    cells: { oemYN: 'Y', oemDetails: '\u2022 AI oem', fasActions: '\u2022 AI fas', support: 'None' },
    sources: { oemYN: 'ai', oemDetails: 'ai', fasActions: 'ai', support: 'ai' },
    flags: { oemYN: 'review', fasActions: 'review' }, identity: { alias: true, names: 0, fasTagged: 0 },
  }, over);
}

describe('AI v2 cells (FEAT-004)', () => {
  it('24 columns with AI on; AI / ⚠ check markers render on the drafted row', async () => {
    const k = DOWN_KEYS[0];
    const okAll = Object.fromEntries(DOWN_KEYS.map((x) => [x, v2(x)]));
    const t = setup({ getModel: modelWith(okAll) });
    await t.ctl.open(); await flush();
    expect(api.draft).not.toHaveBeenCalled(); // every row has an ok draft
    const table = part(t, 'fdbr-table').innerHTML;
    expect((table.match(/<th scope="col">/g) || []).length).toBe(25);
    expect(table).toContain('<td data-key="' + L.esc(k) + '" data-col="oemYN">Y<span class="fdbr-mark">AI</span><span class="fdbr-mark fdbr-mark--warn">\u26a0 check</span></td>');
  });

  it('AC26 / AC37: Copy notes the flagged cells; the pasted text is unchanged', async () => {
    const k = DOWN_KEYS[0];
    const m = modelWith({ [k]: v2(k, { cells: { partsYN: 'N', fasActions: '\u2022 AI fas' }, sources: { partsYN: 'ai', fasActions: 'ai' }, flags: { partsYN: 'review', fasActions: 'review' } }) });
    const t = setup({ aiDraft: false, getModel: m });
    await t.ctl.open(); await flush();
    await overlayOf(t).emit('click', act('copy-row', { key: k })); await flush();
    expect(t.clipboard.writeText.mock.calls[0][0]).toBe(L.rowsToTsv(m.columns, [m.rows.find((r) => r.key === k)], null));
    expect(part(t, 'fdbr-status').textContent).toContain('2 cells flagged \u26a0 \u2014 review before pasting');
    // An unsaved edit of a flagged cell is not counted.
    await overlayOf(t).emit('input', typing(k, 'fasActions', 'mine'));
    await overlayOf(t).emit('click', act('copy-row', { key: k })); await flush();
    expect(part(t, 'fdbr-status').textContent).toContain('1 cell flagged \u26a0');
    // No flagged cell -> no note.
    await overlayOf(t).emit('click', act('copy-row', { key: DOWN_KEYS[1] })); await flush();
    expect(part(t, 'fdbr-status').textContent).not.toContain('flagged');
  });

  it('AC30: ok with cells and no model (no sources) patches every AI cell and the next queued row starts', async () => {
    const t = setup({ manualDraft: true, getModel: modelWith() });
    await t.ctl.open(); await flush();
    expect(pendingDrafts.length).toBe(2);
    const first = pendingDrafts.shift();
    const cells = Object.fromEntries(F.AI_CELL_IDS.map((id) => [id, id.endsWith('YN') ? 'Y' : 'AI ' + id]));
    first.resolve({ ok: true, key: first.key, cells, flags: { oemYN: 'review' }, draftedAt: 'T' });
    await flush();
    expect(api.draft).toHaveBeenCalledTimes(3); // the next queued row started (no stall)
    const row = t.ctl.state.model.rows.find((r) => r.key === first.key);
    for (const id of F.AI_CELL_IDS) { expect(row.cells[id]).toBe(cells[id]); expect(row.source[id]).toBe('ai'); }
    expect(row.flags).toEqual({ oemYN: 'review' });
    expect(row.draft.state).toBe('ok');
    expect(row.etcUnits).toEqual([]);
    const table = part(t, 'fdbr-table').innerHTML;
    expect(table).toContain('data-col="oemDetails" aria-label="OEM Barrier \u2014 Details \u2014 ' + first.key.replace('|', '/') + '">AI oemDetails</textarea>');
    expect(table).toContain('data-col="partsYN">Y<span class="fdbr-mark">AI</span></td>');
    // v1-shaped response (no cells) still patches fasActions/support only.
    const second = pendingDrafts.shift();
    second.resolve({ ok: true, key: second.key, fasActions: '\u2022 v1', support: 'None' });
    await flush();
    const r2 = t.ctl.state.model.rows.find((r) => r.key === second.key);
    expect(r2.cells.fasActions).toBe('\u2022 v1');
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
    expect(dc).toContain("import { openFleetDbrPanel } from './fleet-dbr-panel.js';");
    expect(dc).toContain('openFleetDbrPanel({ returnFocusEl: e.currentTarget })');
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
