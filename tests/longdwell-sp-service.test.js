// tests/longdwell-sp-service.test.js - preview/write orchestration for the
// weekly Long Dwell sheet (src/longdwell/sheet-service.js) against synthetic
// workbooks and a programmable fake transport. Nothing here talks to SharePoint.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { createRequire } from 'module';
import { buildWorkbook, unitRow, createFakeTransport, SECRET_CELL_TEXT } from './helpers/sheet-fixture.js';
const require = createRequire(import.meta.url);
const { createSheetService, LIMITS } = require('../src/longdwell/sheet-service');
const links = require('../src/longdwell/sheet-links');
const grid = require('../src/longdwell/xlsx-grid');
const { DELAY_REASONS, ESCALATION_LEVELS } = require('../src/ipc/long-dwell');

const DR = DELAY_REASONS[1];     // 'Parts Delay'
const DR2 = DELAY_REASONS[0];    // 'Primary Vendor'
const ESC = ESCALATION_LEVELS[2];
const LINK = 'https://contoso.sharepoint.com/sites/Fleet/Shared%20Documents/Tracker.xlsx';
const T0 = Date.parse('2026-11-05T10:00:00Z');
const MIN = 60 * 1000;

// ── fakes ───────────────────────────────────────────────────────────────────
function memStore(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  const calls = [];
  return {
    data, calls,
    load(k, d) { calls.push(['load', k]); return k in data ? JSON.parse(JSON.stringify(data[k])) : d; },
    update(k, fn, d) { calls.push(['update', k]); const cur = k in data ? JSON.parse(JSON.stringify(data[k])) : d; data[k] = fn(cur); return data[k]; },
  };
}

function recLogger() {
  const calls = [];
  const rec = (lvl) => (...a) => calls.push({ lvl, a });
  return { calls, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), text: () => JSON.stringify(calls.map((c) => c.a)) };
}

// Adapter: the fixture's server-state fake shaped like the real transport.
function makeTransport(ft, hooks = {}) {
  const calls = [];
  const ops = {
    meta: async () => { calls.push('meta'); if (hooks.beforeMeta) await hooks.beforeMeta(); return ft.meta(); },
    get: async () => { calls.push('get'); return ft.download(); },
    download: async () => {
      calls.push('download');
      for (let i = 0; i < 2; i++) {
        const m0 = await ft.meta(); if (!m0.ok) return { ok: false, code: 'guard-unavailable' };
        const g = await ft.download();
        const m0b = await ft.meta(); if (!m0b.ok) return { ok: false, code: 'guard-unavailable' };
        if (m0.etag === m0b.etag && m0.modified === m0b.modified) {
          if (hooks.afterDownload) { const h = hooks.afterDownload; hooks.afterDownload = null; await h(); }
          return { ok: true, bytes: g.bytes, meta: m0 };
        }
      }
      return { ok: false, code: 'changed-since-preview' };
    },
    put: async (bytes, o = {}) => {
      calls.push('put');
      const r = await ft.upload(bytes, { ifMatch: o.ifMatch });
      if (hooks.afterPut) await hooks.afterPut(bytes);
      return r;
    },
  };
  return {
    calls, ops,
    resolveFile: vi.fn(async () => { calls.push('resolve'); return hooks.resolveResult || ft.resolve(); }),
    downloadFile: vi.fn(async () => { calls.push('downloadFile'); return ops.download(); }),
    withSession: vi.fn(async (_t, fn) => {
      calls.push('session');
      if (hooks.sessionFail) { const c = hooks.sessionFail; hooks.sessionFail = null; return { ok: false, code: c }; }
      return fn(ops);
    }),
  };
}

let now, flags, store, log, ft, tp, svc, sleeps;
function setup({ rows, tabs, hooks, lock, storeInit } = {}) {
  return (async () => {
    const bytes = await buildWorkbook({ tabs: tabs || [{ name: 'Tracker', rows: rows || [] }] });
    ft = createFakeTransport({ bytes });
    tp = makeTransport(ft, hooks || {});
    store = memStore(storeInit || { longDwellStore: ANN });
    log = recLogger();
    flags = { sharepointWrite: true, sharepointWriteCommit: true, sharepointGuard: 'modified-recheck' };
    sleeps = [];
    svc = createSheetService({
      transport: tp, store, logger: log, flags: () => flags, lock,
      clock: { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } },
    });
    links.setLink(undefined, { url: LINK, kind: 'direct-path' }, { store, now: () => new Date(now) });
    return bytes;
  })();
}

const ANN = {
  'U1::primary': { delayReason: DR, escalationLevel: ESC, summary: 'Waiting on parts' },
  'U2::primary': { delayReason: DR2, escalationLevel: ESC, summary: 'New note' },
  'U3::111': { delayReason: DR, escalationLevel: ESC, summary: 'WO one' },
  'U3::222': { delayReason: DR2, escalationLevel: ESC, summary: 'WO two' },
};
const U = (id, extra = {}) => ({ equipmentId: id, woKey: 'primary', isPrimary: true, ...extra });

async function cellsOf(bytes) {
  const wb = await grid.openWorkbook(bytes);
  const g = await grid.readGrid(wb, 'Tracker');
  const m = new Map();
  for (const r of g.scan.rows) for (const c of r.cells) m.set(r.r + ':' + c.col, grid.cellText(c, g.sst));
  return { m, rows: g.scan.rows.map((r) => r.r) };
}
async function entries(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const out = {};
  for (const n of Object.keys(z.files)) if (!z.files[n].dir) out[n] = await z.file(n).async('string');
  return out;
}
const cellById = (p, id) => p.cells.find((c) => c.id === id);
const repCell = (r, id) => r.cells.find((c) => c.id === id);
const writeIds = (p, ids, texts = {}) => svc.write({ previewId: p.previewId, confirm: true, cells: ids.map((id) => ({ cellId: id, text: texts[id] !== undefined ? texts[id] : cellById(p, id).next })) });

beforeEach(() => { now = T0; });
afterEach(() => { vi.useRealTimers(); });

// ── preview ─────────────────────────────────────────────────────────────────
describe('preview', () => {
  it('preview never calls upload; payload maps N/O/R and lists P/Q as untouched', async () => {
    await setup({ rows: [unitRow('U1'), unitRow('U2', { N: DR2 })] });
    const p = await svc.preview({ units: [U('U1'), U('U2')] });
    expect(p.ok).toBe(true);
    expect(tp.calls).not.toContain('put');
    expect(ft.state.uploads).toHaveLength(0);
    expect(p.mapping.map((m) => m.column)).toEqual(['N', 'O', 'R']);
    expect(p.untouched.map((u) => u.column)).toEqual(['A-M', 'P', 'Q']);
    expect(p.file).toMatchObject({ name: 'Tracker.xlsx', tab: 'Tracker', headerRow: 1 });
    expect(p.counts).toMatchObject({ unitsInView: 2, units: 2, matched: 2, cells: 6, willWrite: 5, noChange: 1 });
    expect(cellById(p, '2:N')).toMatchObject({ state: 'will-write', next: DR, selectable: true, defaultChecked: true, editor: 'select' });
    expect(cellById(p, '3:N')).toMatchObject({ state: 'no-change', selectable: false });
    expect(p.commit).toBe(true);
    expect(p.previewId).toMatch(/^[0-9a-f]{32}$/);
  });
  it('values come from the app store, never from the renderer payload', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1', { summary: 'RENDERER', delayReason: 'Weather' })] });
    expect(cellById(p, '2:R').next).toBe('Waiting on parts');
    expect(cellById(p, '2:N').next).toBe(DR);
  });
  it('flag off -> off; no link -> no-link', async () => {
    await setup({ rows: [unitRow('U1')] });
    flags.sharepointWrite = false;
    expect(await svc.preview({ units: [U('U1')] })).toEqual({ ok: false, code: 'off' });
    expect(tp.calls).toEqual([]);
    flags.sharepointWrite = true;
    links.clearLink(undefined, { store, now: () => new Date(now) });
    expect(await svc.preview({ units: [U('U1')] })).toEqual({ ok: false, code: 'no-link' });
  });
  it('preview diagnostics: shape matches, contains no sentinel string or name, logged at INFO with counts only', async () => {
    await setup({ rows: [unitRow('U1', { R: SECRET_CELL_TEXT, P: SECRET_CELL_TEXT })] });
    const p = await svc.preview({ units: [U('U1', { vendor: 'Amerit' })] });
    expect(Object.keys(p.diagnostics).sort()).toEqual(['dupAssetIds', 'hasWoCol', 'idCells', 'meta', 'targets', 'validations', 'vendorEq', 'vendorNeq'].sort());
    expect(p.diagnostics.meta).toEqual({ etagShape: 'sp-guid-n', lockedBy: null, checkOutType: null, versioning: null });
    expect(JSON.stringify(p.diagnostics)).not.toContain(SECRET_CELL_TEXT);
    expect(JSON.stringify(p.diagnostics)).not.toMatch(/Amerit|U1/);
    const info = log.calls.find((c) => c.lvl === 'info' && c.a[0] === '[ldsp] preview');
    expect(info).toBeTruthy();
    expect(log.text()).not.toMatch(/SECRET_CELL_TEXT|Tracker\.xlsx|Amerit|\?/);
  });
  it('preview rate limit: 3 s between previews', async () => {
    await setup({ rows: [unitRow('U1')] });
    expect((await svc.preview({ units: [U('U1')] })).ok).toBe(true);
    now += 1000;
    expect(await svc.preview({ units: [U('U1')] })).toEqual({ ok: false, code: 'rate-limited', retryAfterMs: 2000 });
    now += 2000;
    expect((await svc.preview({ units: [U('U1')] })).ok).toBe(true);
  });
  it('limits: more than 1000 units -> too-many-units before any I/O', async () => {
    await setup({ rows: [unitRow('U1')] });
    const units = Array.from({ length: 1001 }, (_, i) => U('X' + i));
    expect(await svc.preview({ units })).toEqual({ ok: false, code: 'too-many-units' });
    expect(tp.calls).toEqual([]);
  });
  it('needs-tab-choice and unknown-tab', async () => {
    await setup({ tabs: [{ name: 'A', rows: [unitRow('U1')] }, { name: 'B', rows: [unitRow('U1')] }] });
    const r = await svc.preview({ units: [U('U1')] });
    expect(r.code).toBe('needs-tab-choice');
    expect(r.tabs.map((t) => t.name)).toEqual(['A', 'B']);
    now += 5000;
    expect((await svc.preview({ units: [U('U1')], tab: 'Nope' })).code).toBe('unknown-tab');
  });
  it('the chosen tab is remembered and reused', async () => {
    await setup({ tabs: [{ name: 'A', rows: [unitRow('U1')] }, { name: 'B', rows: [unitRow('U1')] }] });
    expect((await svc.preview({ units: [U('U1')], tab: 'B' })).file.tab).toBe('B');
    now += 5000;
    expect((await svc.preview({ units: [U('U1')] })).file.tab).toBe('B');
    expect(tp.resolveFile).toHaveBeenCalledTimes(1);
  });
});

describe('link replacement', () => {
  it('cached resolution ignored when forUrlSha256 differs: resolve runs again, stored tab gone', async () => {
    await setup({ tabs: [{ name: 'A', rows: [unitRow('U1')] }, { name: 'B', rows: [unitRow('U1')] }] });
    const wk = links.isoWeekKey(new Date(now));
    store.data.longDwellSheetLinks.links[wk].resolved = { host: 'contoso.sharepoint.com', site: '/sites/Fleet', serverRelativeUrl: '/sites/Fleet/Shared Documents/Tracker.xlsx', name: 'Tracker.xlsx', tab: 'B', forUrlSha256: links.sha256('https://contoso.sharepoint.com/sites/Fleet/Old.xlsx') };
    const r = await svc.preview({ units: [U('U1')] });
    expect(tp.resolveFile).toHaveBeenCalledTimes(1);
    expect(r.code).toBe('needs-tab-choice'); // stored tab 'B' was not used
  });
  it('a matching cached resolution skips resolve', async () => {
    await setup({ rows: [unitRow('U1')] });
    await svc.preview({ units: [U('U1')] });
    now += 5000;
    await svc.preview({ units: [U('U1')] });
    expect(tp.resolveFile).toHaveBeenCalledTimes(1);
  });
});

// ── write ───────────────────────────────────────────────────────────────────
describe('write sends only approved cells', () => {
  it('before/after bytes: only the ticked cells change; A-M, P, Q untouched, no clears, no new rows', async () => {
    const b0 = await setup({ rows: [unitRow('U1', { P: 'Pat', Q: 'https://asana/x' }), unitRow('U2', { R: 'keep me' })] });
    const p = await svc.preview({ units: [U('U1'), U('U2')] });
    const r = await writeIds(p, ['2:N', '2:R']);
    expect(r).toMatchObject({ ok: true, status: 'ok' });
    expect(ft.state.uploads).toHaveLength(1);
    const before = await cellsOf(b0);
    const after = await cellsOf(ft.state.bytes);
    expect(after.rows).toEqual(before.rows);
    const changed = [];
    for (const k of new Set([...before.m.keys(), ...after.m.keys()])) if (before.m.get(k) !== after.m.get(k)) changed.push(k);
    expect(changed.sort()).toEqual(['2:13', '2:17']);
    expect(after.m.get('2:13')).toBe(DR);
    expect(after.m.get('2:17')).toBe('Waiting on parts');
    expect(after.m.get('2:15')).toBe('Pat');
    expect(after.m.get('2:16')).toBe('https://asana/x');
    expect(after.m.get('3:17')).toBe('keep me');
    const e0 = await entries(b0), e1 = await entries(ft.state.bytes);
    expect(Object.keys(e1)).toEqual(Object.keys(e0));
    for (const n of Object.keys(e0)) if (n !== 'xl/worksheets/sheet1.xml') expect(e1[n]).toBe(e0[n]);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'written', verified: true });
    expect(repCell(r, '2:O')).toMatchObject({ status: 'skipped', reason: 'not-approved' });
    expect(r.counts.written).toBe(2);
  });
  it('edited text is re-validated and re-classified from the cached current', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    expect((await writeIds(p, ['2:N'], { '2:N': 'Not an enum' }))).toEqual({ ok: false, code: 'invalid-text' });
    expect((await writeIds(p, ['2:R'], { '2:R': '   ' }))).toEqual({ ok: false, code: 'invalid-text' });
    const r = await writeIds(p, ['2:R'], { '2:R': 'Edited note' });
    expect(repCell(r, '2:R')).toMatchObject({ status: 'written', edited: true });
  });
  it('gate codes: confirm, unknown / duplicate / non-selectable ids, too many cells', async () => {
    await setup({ rows: [unitRow('U1', { O: ESC })] });
    const p = await svc.preview({ units: [U('U1')] });
    const w = (cells, extra = {}) => svc.write({ previewId: p.previewId, confirm: true, cells, ...extra });
    expect(await w([{ cellId: '2:N', text: DR }], { confirm: false })).toEqual({ ok: false, code: 'confirm-required' });
    expect(await w([{ cellId: '9:N', text: DR }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await w([{ cellId: '2:N', text: DR }, { cellId: '2:N', text: DR }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await w([{ cellId: '2:O', text: ESC }])).toEqual({ ok: false, code: 'invalid-cell' }); // no-change: not selectable
    expect(await w([{ cellId: '2:C', text: 'x' }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await w([])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await w(Array.from({ length: 3001 }, (_, i) => ({ cellId: (i + 2) + ':N', text: DR })))).toEqual({ ok: false, code: 'too-many-cells' });
    expect(tp.withSession).not.toHaveBeenCalled();
  });
});

describe('conflicts', () => {
  it('ticked conflict is written with overwrote:true; unticked conflict is listed and left alone', async () => {
    await setup({ rows: [unitRow('U1', { R: 'old one' }), unitRow('U2', { R: 'old two' })] });
    const p = await svc.preview({ units: [U('U1'), U('U2')] });
    expect(cellById(p, '2:R')).toMatchObject({ state: 'conflict', defaultChecked: false });
    const r = await writeIds(p, ['2:R']);
    expect(repCell(r, '2:R')).toMatchObject({ status: 'written', overwrote: true });
    expect(repCell(r, '3:R')).toMatchObject({ status: 'conflict', reason: 'not-approved' });
    const after = await cellsOf(ft.state.bytes);
    expect(after.m.get('3:17')).toBe('old two');
    expect(r.counts.conflict).toBe(1);
  });
});

describe('write-time re-match', () => {
  const WO_ROWS = [unitRow('U3', { wo: '111' }), unitRow('U3', { wo: '222' })];
  const WO_UNITS = [{ equipmentId: 'U3', woKey: '111', isPrimary: true, woNumber: '111' }, { equipmentId: 'U3', woKey: '222', woNumber: '222' }];
  it('two sibling rows with empty targets swapped between preview and write: both cells skipped changed-since-preview (row-moved), bytes unchanged', async () => {
    await setup({ tabs: [{ name: 'Tracker', woHeader: 'Work Order', rows: WO_ROWS }] });
    const p = await svc.preview({ units: WO_UNITS });
    expect(p.units.map((u) => [u.sheetRow, u.via])).toEqual([[2, 'wo-column'], [3, 'wo-column']]);
    const swapped = await buildWorkbook({ tabs: [{ name: 'Tracker', woHeader: 'Work Order', rows: [WO_ROWS[1], WO_ROWS[0]] }] });
    ft.externalEdit(swapped);
    const r = await writeIds(p, ['2:R', '3:R']);
    expect(r.cells.filter((c) => c.id === '2:R' || c.id === '3:R').map((c) => [c.status, c.reason, c.detail])).toEqual([
      ['skipped', 'changed-since-preview', 'row-moved'], ['skipped', 'changed-since-preview', 'row-moved']]);
    expect(ft.state.uploads).toHaveLength(0);
    expect(ft.state.bytes).toBe(swapped);
  });
  it('a new sibling row added makes the unique match ambiguous: skipped row-moved', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.externalEdit(await buildWorkbook({ tabs: [{ name: 'Tracker', rows: [unitRow('U1'), unitRow('U1')] }] }));
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'skipped', reason: 'changed-since-preview', detail: 'row-moved' });
    expect(ft.state.uploads).toHaveLength(0);
  });
  it('value changed since preview: skipped value-changed', async () => {
    await setup({ rows: [unitRow('U1'), unitRow('U2')] });
    const p = await svc.preview({ units: [U('U1'), U('U2')] });
    ft.externalEdit(await buildWorkbook({ tabs: [{ name: 'Tracker', rows: [unitRow('U1', { N: 'Weather' }), unitRow('U2')] }] }));
    const r = await writeIds(p, ['2:N', '3:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'skipped', reason: 'changed-since-preview', detail: 'value-changed' });
    expect(repCell(r, '3:N')).toMatchObject({ status: 'written' });
    expect(r.status).toBe('partial-failure');
  });
  it('layout-changed: header row moved', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.externalEdit(await buildWorkbook({ tabs: [{ name: 'Tracker', titleRows: 1, rows: [unitRow('U1')] }] }));
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'skipped', reason: 'layout-changed' });
    expect(ft.state.uploads).toHaveLength(0);
  });
});

describe('partial failure and upload outcomes', () => {
  it('report mixes written / skipped / conflict / failed with correct counts and derived status', async () => {
    let clobber = null;
    await setup({ rows: [unitRow('U1'), unitRow('U2', { R: 'old two' })], hooks: { afterPut: async (bytes) => { if (clobber) await clobber(bytes); } } });
    const p = await svc.preview({ units: [U('U1'), U('U2')] });
    clobber = async (bytes) => { const b = (await grid.patchWorkbookBytes(bytes, 'xl/worksheets/sheet1.xml', [{ row: 2, col: 17, text: 'someone else' }], { allowedCols: [17] })).bytes; ft.state.bytes = b; };
    ft.externalEdit(await buildWorkbook({ tabs: [{ name: 'Tracker', rows: [unitRow('U1', { O: 'SEV3' }), unitRow('U2', { R: 'old two' })] }] }));
    const r = await writeIds(p, ['2:N', '2:O', '2:R', '3:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'written', verified: true });
    expect(repCell(r, '2:O')).toMatchObject({ status: 'skipped', reason: 'changed-since-preview', detail: 'value-changed' });
    expect(repCell(r, '2:R')).toMatchObject({ status: 'failed', reason: 'verify-mismatch' });
    expect(repCell(r, '3:R')).toMatchObject({ status: 'conflict', reason: 'not-approved' });
    expect(r.counts).toMatchObject({ written: 2, failed: 1, conflict: 1 });
    expect(r.status).toBe('partial-failure');
    expect(r.ok).toBe(false);
  });
  it('412 -> skipped changed-since-preview', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.state.uploadResult = 'precondition';
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'skipped', reason: 'changed-since-preview' });
  });
  it('423 locked -> failed locked, no retry', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.state.uploadResult = 'locked';
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'failed', reason: 'locked' });
    expect(ft.state.uploads).toHaveLength(1);
    expect(r.status).toBe('failed');
  });
  it('unknown-outcome PUT resolved by read-back: applied -> written, lost -> upload-unknown', async () => {
    await setup({ rows: [unitRow('U1')] });
    let p = await svc.preview({ units: [U('U1')] });
    ft.state.uploadResult = 'unknown-applied';
    let r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'written', verified: true });
    now += 5000;
    await setup({ rows: [unitRow('U1')] });
    p = await svc.preview({ units: [U('U1')] });
    ft.state.uploadResult = 'unknown-lost';
    r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'failed', reason: 'upload-unknown' });
    expect(r.cells.some((c) => c.status === 'written')).toBe(false);
  });
  it('verify lag: verified:false, verification-pending; read-back at +2.5/+4/+6 s', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.state.lag = 3;
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'written', verified: false });
    expect(r.status).toBe('verification-pending');
    expect(sleeps).toEqual([2500, 1500, 2000]);
  });
  it('verify-mismatch when the read-back holds neither value', async () => {
    await setup({ rows: [unitRow('U1')], hooks: { afterPut: async (bytes) => { ft.state.bytes = (await grid.patchWorkbookBytes(bytes, 'xl/worksheets/sheet1.xml', [{ row: 2, col: 13, text: 'Weather' }], { allowedCols: [13] })).bytes; } } });
    const p = await svc.preview({ units: [U('U1')] });
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'failed', reason: 'verify-mismatch' });
  });
});

describe('flags and guard', () => {
  it('commit flag off -> write-disabled with zero transport calls', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    tp.calls.length = 0;
    flags.sharepointWriteCommit = false;
    const r = await writeIds(p, ['2:N']);
    expect(r).toEqual({ ok: false, code: 'write-disabled', error: 'Write is turned off. Set longDwell.sharepointWriteCommit to enable.' });
    expect(tp.calls).toEqual([]);
  });
  it('commit flag re-checked inside the lock', async () => {
    let release;
    let chain = Promise.resolve();
    const lock = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };
    await setup({ rows: [unitRow('U1')], lock });
    const p = await svc.preview({ units: [U('U1')] });
    lock(() => new Promise((r) => { release = r; }));
    const wp = writeIds(p, ['2:N']);
    await new Promise((r) => setTimeout(r, 5));
    flags.sharepointWriteCommit = false;
    release();
    expect((await wp).code).toBe('write-disabled');
    expect(tp.withSession).not.toHaveBeenCalled();
  });
  it('modified-recheck sends no If-Match; if-match sends M1 ETag', async () => {
    await setup({ rows: [unitRow('U1'), unitRow('U2')] });
    let p = await svc.preview({ units: [U('U1'), U('U2')] });
    await writeIds(p, ['2:N']);
    expect(ft.state.uploads[0].headers.ifMatch).toBeUndefined();
    flags.sharepointGuard = 'if-match';
    now += 5000;
    p = await svc.preview({ units: [U('U1'), U('U2')] });
    const etag = ft.state.etag;
    await writeIds(p, ['3:N']);
    expect(ft.state.uploads[1].headers.ifMatch).toBe(etag);
  });
  it('M1 differs from M0 -> skipped changed-since-preview, nothing uploaded', async () => {
    const hooks = {};
    await setup({ rows: [unitRow('U1')], hooks });
    const p = await svc.preview({ units: [U('U1')] });
    hooks.afterDownload = async () => { ft.externalEdit(ft.state.bytes); };
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'skipped', reason: 'changed-since-preview' });
    expect(ft.state.uploads).toHaveLength(0);
  });
  it('metadata failure -> guard-unavailable, nothing uploaded, preview kept', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.state.metaFail = true;
    const r = await writeIds(p, ['2:N']);
    expect(repCell(r, '2:N')).toMatchObject({ status: 'failed', reason: 'guard-unavailable' });
    expect(r.previewKept).toBe(true);
    expect(ft.state.uploads).toHaveLength(0);
    ft.state.metaFail = false;
    expect((await writeIds(p, ['2:N'])).status).toBe('ok');
  });
});

describe('preview lifecycle', () => {
  it('second concurrent write returns busy', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    const a = writeIds(p, ['2:N']);
    const b = await writeIds(p, ['2:N']);
    expect(b).toEqual({ ok: false, code: 'busy' });
    expect((await a).status).toBe('ok');
  });
  it('auth-required before PUT restores state ready (second write works)', async () => {
    const hooks = {};
    await setup({ rows: [unitRow('U1')], hooks });
    const p = await svc.preview({ units: [U('U1')] });
    hooks.sessionFail = 'auth-required';
    const r = await writeIds(p, ['2:N']);
    expect(r.status).toBe('auth-failed');
    expect(r.previewKept).toBe(true);
    expect((await writeIds(p, ['2:N'])).status).toBe('ok');
  });
  it('PUT attempted consumes the preview (second write -> preview-expired)', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    ft.state.uploadResult = 'http-500';
    expect(repCell(await writeIds(p, ['2:N']), '2:N')).toMatchObject({ status: 'failed', reason: 'http-500' });
    expect(await writeIds(p, ['2:N'])).toEqual({ ok: false, code: 'preview-expired' });
  });
  it('all no-change consumes the preview without any transport call', async () => {
    await setup({ rows: [unitRow('U1', { R: 'old' })] });
    const p = await svc.preview({ units: [U('U1')] });
    tp.calls.length = 0;
    const r = await writeIds(p, ['2:R'], { '2:R': 'old' });
    expect(r).toMatchObject({ ok: true, status: 'no-op' });
    expect(r.counts.noChange).toBe(1);
    expect(tp.calls).toEqual([]);
    expect(await writeIds(p, ['2:R'])).toEqual({ ok: false, code: 'preview-expired' });
  });
  it('TTL expiry: preview-expired after 20 min', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    now += LIMITS.ttlMs + 1;
    expect(await writeIds(p, ['2:N'])).toEqual({ ok: false, code: 'preview-expired' });
  });
  it('cache keeps at most 3 previews', async () => {
    await setup({ rows: [unitRow('U1')] });
    const ids = [];
    for (let i = 0; i < 4; i++) { now += 5000; ids.push((await svc.preview({ units: [U('U1')] })).previewId); }
    expect([...svc._cacheForTests().keys()]).toEqual(ids.slice(1));
  });
  it('week-rolled and link-changed', async () => {
    await setup({ rows: [unitRow('U1')] });
    let p = await svc.preview({ units: [U('U1')] });
    links.setLink(undefined, { url: LINK + '?x=1', kind: 'direct-path' }, { store, now: () => new Date(now) });
    expect(await writeIds(p, ['2:N'])).toEqual({ ok: false, code: 'link-changed' });
    // Sunday 23:55 local (W45) -> Monday 00:05 local (W46), inside the TTL
    now = new Date(2026, 10, 8, 23, 55).getTime();
    links.setLink(undefined, { url: LINK, kind: 'direct-path' }, { store, now: () => new Date(now) });
    p = await svc.preview({ units: [U('U1')] });
    expect(p.weekKey).toBe('2026-W45');
    now += 10 * MIN;
    expect(await writeIds(p, ['2:N'])).toEqual({ ok: false, code: 'week-rolled' });
  });
  it('discard drops the preview', async () => {
    await setup({ rows: [unitRow('U1')] });
    const p = await svc.preview({ units: [U('U1')] });
    expect(svc.discard(p.previewId)).toEqual({ ok: true });
    expect(await writeIds(p, ['2:N'])).toEqual({ ok: false, code: 'preview-expired' });
  });
});

describe('write lock shared with the push', () => {
  it('lock held > 90 s -> busy; preview stays usable', async () => {
    let chain = Promise.resolve();
    const lock = vi.fn((fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; });
    await setup({ rows: [unitRow('U1')], lock });
    const p = await svc.preview({ units: [U('U1')] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release;
    lock(() => new Promise((r) => { release = r; }));
    const wp = writeIds(p, ['2:N']);
    await vi.advanceTimersByTimeAsync(90001);
    expect(await wp).toEqual({ ok: false, code: 'busy' });
    release();
    await vi.advanceTimersByTimeAsync(5);
    expect(tp.withSession).not.toHaveBeenCalled();
    vi.useRealTimers();
    expect((await writeIds(p, ['2:N'])).status).toBe('ok');
  });
});

describe('no cell contents in logs or errors', () => {
  it('exception sentinel -> internal, nothing leaks', async () => {
    await setup({ rows: [unitRow('U1')] });
    const SENT = 'SECRET_CELL_TEXT https://x.sharepoint.com/f?e=TOKEN';
    tp.downloadFile.mockImplementationOnce(async () => { throw new Error(SENT); });
    const r = await svc.preview({ units: [U('U1')] });
    expect(r).toEqual({ ok: false, code: 'internal' });
    now += 5000;
    const p = await svc.preview({ units: [U('U1')] });
    tp.withSession.mockImplementationOnce(async () => { throw new Error(SENT); });
    const w = await writeIds(p, ['2:N']);
    expect(w).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify([r, w])).not.toMatch(/SECRET|TOKEN/);
    expect(log.text()).not.toMatch(/SECRET|TOKEN/);
    expect(log.calls.filter((c) => c.lvl === 'error').length).toBe(2);
  });
  it('no cell contents, file names or URL queries in log args across preview and write', async () => {
    await setup({ rows: [unitRow('U1', { R: SECRET_CELL_TEXT }), unitRow('U2')], hooks: { resolveResult: { ok: true, host: 'contoso.sharepoint.com', site: '/sites/Fleet', serverRelativeUrl: '/sites/Fleet/Shared Documents/SECRET_FILE.xlsx', name: 'SECRET_FILE.xlsx' } } });
    store.data.longDwellStore['U2::primary'].summary = SECRET_CELL_TEXT + ' note';
    links.setLink(undefined, { url: LINK + '?e=TOKEN', kind: 'direct-path' }, { store, now: () => new Date(now) });
    const p = await svc.preview({ units: [U('U1'), U('U2')] });
    await writeIds(p, ['2:R', '3:R', '3:N']);
    expect(log.calls.length).toBeGreaterThan(1);
    expect(log.text()).not.toMatch(/SECRET|TOKEN|\.xlsx|Waiting on parts|\?/);
  });
});
