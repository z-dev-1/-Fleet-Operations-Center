// tests/dtna-bulk-modal-dom.test.js — Fleet "DTNA Pull" bulk modal
// (renderer/src/js/views/dtna-bulk-modal.js). Opening reads status only;
// Start/Cancel/Save drive window.dtna; progress is filtered by jobId; close
// drops the subscriptions. Mini DOM + a fake modal + a fake dtna bridge.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { createMiniDocument } from './fixtures/mini-dom.js';

vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: { show() {}, close() {}, isOpen() { return false; } } }));

let doc, mod;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fakeModal() {
  const fm = { opts: null, root: null, shown: 0 };
  fm.show = vi.fn((opts) => {
    fm.opts = opts;
    fm.shown++;
    fm.root = doc.createElement('div');
    fm.root.innerHTML = opts.body;
    doc.body.appendChild(fm.root);
    if (opts.onMount) opts.onMount(fm.root);
  });
  fm.close = vi.fn(() => {
    if (fm.root) fm.root.remove();
    if (fm.opts && fm.opts.onClose) fm.opts.onClose();
  });
  return fm;
}

function fakeDtna() {
  const d = { progressCbs: [], statusCbs: [], unsubProgress: vi.fn(), unsubStatus: vi.fn() };
  d.status = vi.fn(async () => ({ ok: true, state: 'connected', lastPullAt: null }));
  d.login = vi.fn(async () => ({ ok: true, state: 'connected' }));
  d.listCases = vi.fn(async () => ({ ok: true, count: 3 }));
  d.pullUnit = vi.fn(async () => ({ ok: true }));
  d.bulkPull = vi.fn(async () => ({ ok: true, jobId: 'jabc' }));
  d.bulkCancel = vi.fn(async () => ({ ok: true }));
  d.exportBulk = vi.fn(async (p) => ({ ok: true, filename: 'dtna-' + (p.mode || 'cases') + '-2026-11-20.' + p.format }));
  d.onProgress = vi.fn((cb) => { d.progressCbs.push(cb); return d.unsubProgress; });
  d.onStatus = vi.fn((cb) => { d.statusCbs.push(cb); return d.unsubStatus; });
  d.progress = (p) => d.progressCbs.forEach((cb) => cb(p));
  return d;
}

let fm, dt, bus;
const q = (s) => fm.root.querySelector(s);
const open = () => mod.openDtnaBulkModal({ dtna: dt, modal: fm, bus });

beforeAll(async () => {
  doc = createMiniDocument();
  globalThis.document = doc;
  mod = await import('../renderer/src/js/views/dtna-bulk-modal.js');
});
afterAll(() => { delete globalThis.document; });
beforeEach(() => {
  fm = fakeModal();
  dt = fakeDtna();
  bus = { emit: vi.fn() };
});

describe('progressText', () => {
  it('formats done / total · failed', () => {
    expect(mod.progressText({ done: 3, total: 10, failed: 1 })).toBe('3 / 10 \u00b7 1 failed');
    expect(mod.progressText(null)).toBe('0 / 0 \u00b7 0 failed');
    expect(mod.progressText({ done: 'x', total: -1 })).toBe('0 / 0 \u00b7 0 failed');
  });
});

describe('openDtnaBulkModal', () => {
  it('opening shows the controls and makes zero bulkPull / listCases / login calls', async () => {
    open();
    await flush();
    expect(fm.show).toHaveBeenCalledTimes(1);
    expect(fm.opts.title).toBe('DTNA Pull');
    expect(fm.opts.width).toBe(520);
    for (const id of ['#dtna-bulk-state', '#dtna-bulk-signin', '#dtna-bulk-comments', '#dtna-bulk-start', '#dtna-bulk-cancel',
      '#dtna-bulk-progress', '#dtna-bulk-progress-text', '#dtna-bulk-save-tsv', '#dtna-bulk-save-xls', '#dtna-bulk-save-comments']) {
      expect(q(id), id).toBeTruthy();
    }
    expect(q('#dtna-bulk-state').textContent).toBe('DTNA: Connected');
    expect(q('#dtna-bulk-cancel').disabled).toBe(true);
    expect(q('#dtna-bulk-save-tsv').disabled).toBe(true);
    expect(q('#dtna-bulk-save-xls').disabled).toBe(true);
    expect(q('#dtna-bulk-save-comments').disabled).toBe(true);
    expect(dt.status).toHaveBeenCalledTimes(1);
    expect(dt.bulkPull).not.toHaveBeenCalled();
    expect(dt.listCases).not.toHaveBeenCalled();
    expect(dt.login).not.toHaveBeenCalled();
    expect(dt.pullUnit).not.toHaveBeenCalled();
  });

  it('Start calls bulkPull({ includeComments:true }) once; foreign jobIds ignored; finished enables saves', async () => {
    open();
    q('#dtna-bulk-start').click();
    q('#dtna-bulk-start').click();
    await flush();
    expect(dt.bulkPull).toHaveBeenCalledTimes(1);
    expect(dt.bulkPull).toHaveBeenCalledWith({ includeComments: true });
    expect(q('#dtna-bulk-start').disabled).toBe(true);
    expect(q('#dtna-bulk-cancel').disabled).toBe(false);

    dt.progress({ jobId: 'jother', done: 9, total: 9, failed: 0, finished: true, cancelled: false });
    expect(q('#dtna-bulk-progress-text').textContent).toBe('0 / 0 \u00b7 0 failed');
    expect(q('#dtna-bulk-save-tsv').disabled).toBe(true);

    dt.progress({ jobId: 'jabc', done: 2, total: 5, failed: 1, finished: false });
    expect(q('#dtna-bulk-progress-text').textContent).toBe('2 / 5 \u00b7 1 failed');
    expect(q('#dtna-bulk-progress').getAttribute('value')).toBe('2');
    expect(q('#dtna-bulk-progress').getAttribute('max')).toBe('5');
    expect(q('#dtna-bulk-save-tsv').disabled).toBe(true);

    dt.progress({ jobId: 'jabc', done: 5, total: 5, failed: 1, finished: true, cancelled: false });
    expect(q('#dtna-bulk-save-tsv').disabled).toBe(false);
    expect(q('#dtna-bulk-save-xls').disabled).toBe(false);
    expect(q('#dtna-bulk-save-comments').disabled).toBe(false);
    expect(q('#dtna-bulk-save-comments').hidden).toBe(false);
    expect(q('#dtna-bulk-cancel').disabled).toBe(true);
    expect(q('#dtna-bulk-start').disabled).toBe(false);

    q('#dtna-bulk-save-tsv').click();
    await flush();
    expect(dt.exportBulk).toHaveBeenCalledWith({ jobId: 'jabc', format: 'tsv', mode: 'cases' });
    expect(bus.emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'Saved dtna-cases-2026-11-20.tsv to Downloads', duration: 4000 });
    q('#dtna-bulk-save-xls').click();
    q('#dtna-bulk-save-comments').click();
    await flush();
    expect(dt.exportBulk).toHaveBeenCalledWith({ jobId: 'jabc', format: 'xls', mode: 'cases' });
    expect(dt.exportBulk).toHaveBeenCalledWith({ jobId: 'jabc', format: 'tsv', mode: 'comments' });
  });

  it('unchecking Include comments sends includeComments:false and hides Save comments', async () => {
    open();
    q('#dtna-bulk-comments').checked = false;
    q('#dtna-bulk-start').click();
    await flush();
    expect(dt.bulkPull).toHaveBeenCalledWith({ includeComments: false });
    dt.progress({ jobId: 'jabc', done: 1, total: 1, failed: 0, finished: true, cancelled: false });
    expect(q('#dtna-bulk-save-tsv').disabled).toBe(false);
    expect(q('#dtna-bulk-save-comments').hidden).toBe(true);
  });

  it('Cancel calls bulkCancel({ jobId })', async () => {
    open();
    q('#dtna-bulk-start').click();
    await flush();
    q('#dtna-bulk-cancel').click();
    await flush();
    expect(dt.bulkCancel).toHaveBeenCalledTimes(1);
    expect(dt.bulkCancel).toHaveBeenCalledWith({ jobId: 'jabc' });
  });

  it('DTNA_SIGNIN_REQUIRED / DTNA_BUSY show a message and re-enable Start', async () => {
    dt.bulkPull.mockResolvedValueOnce({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    open();
    q('#dtna-bulk-start').click();
    await flush();
    expect(q('#dtna-bulk-msg').textContent).toMatch(/sign-in needed/i);
    expect(q('#dtna-bulk-start').disabled).toBe(false);
    expect(dt.login).not.toHaveBeenCalled();
    dt.bulkPull.mockResolvedValueOnce({ ok: false, code: 'DTNA_BUSY', jobId: 'jrun' });
    q('#dtna-bulk-start').click();
    await flush();
    expect(q('#dtna-bulk-msg').textContent).toMatch(/already running/i);
  });

  it('Sign in calls login once then re-reads status', async () => {
    open();
    await flush();
    dt.status.mockClear();
    q('#dtna-bulk-signin').click();
    await flush();
    expect(dt.login).toHaveBeenCalledTimes(1);
    expect(dt.status).toHaveBeenCalledTimes(1);
    expect(dt.bulkPull).not.toHaveBeenCalled();
  });

  it('close unsubscribes onProgress and onStatus', async () => {
    open();
    expect(dt.onProgress).toHaveBeenCalledTimes(1);
    expect(dt.onStatus).toHaveBeenCalledTimes(1);
    fm.close();
    expect(dt.unsubProgress).toHaveBeenCalledTimes(1);
    expect(dt.unsubStatus).toHaveBeenCalledTimes(1);
  });

  it('fleet.js meta bar wires #fleet-dtna-pull after #fleet-pending-est with a dynamic import', () => {
    const src = fs.readFileSync(new URL('../renderer/src/js/views/fleet.js', import.meta.url), 'utf8');
    const pe = src.indexOf('id="fleet-pending-est"');
    const dp = src.indexOf('id="fleet-dtna-pull"');
    expect(pe).toBeGreaterThan(0);
    expect(dp).toBeGreaterThan(pe);
    expect(src).toContain("import('./dtna-bulk-modal.js')");
    expect(src).toContain('m.openDtnaBulkModal()');
  });
});
