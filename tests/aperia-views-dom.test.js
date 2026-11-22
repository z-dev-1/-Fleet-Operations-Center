// tests/aperia-views-dom.test.js — Aperia issues modal (aperia-issues-modal.js)
// and bulk / full-fleet modal (aperia-bulk-modal.js). Opening either reads
// aperia.status() only; Load / Look up / Pull full fleet are the only callers
// of issues / bulk / fleetTires; progress is filtered by jobId; exports carry
// { jobId, format, domicile }. A fake modal mounts the body on the mini DOM.
process.env.TZ = 'UTC';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMiniDocument } from './fixtures/mini-dom.js';

vi.mock('../renderer/src/js/bridge.js', () => ({}));
const busSpy = vi.hoisted(() => ({ emit: vi.fn(), on() {}, off() {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: busSpy }));

const im = await import('../renderer/src/js/views/aperia-issues-modal.js');
const bm = await import('../renderer/src/js/views/aperia-bulk-modal.js');

const KEYS = ['login', 'logout', 'status', 'unit', 'bulk', 'fleetTires', 'issues', 'startAlerts', 'stopAlerts', 'pollNow', 'exportBulk', 'onProgress', 'onAlert'];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const ISSUE_ROWS = [
  { issueId: '9004', fleetVehicleId: '122269', domicile: 'DFW5', group: 'Ops A', severity: 'MINOR', state: 'UNDERINFLATION', position: 'R2OC', positionName: 'Right Drive Outer', dateDetected: '2026-11-20T15:00:00Z', detectedEt: '11/20/2026, 10:00 AM EST', muted: false },
  { issueId: '9001', fleetVehicleId: 'NP6923', domicile: 'ATL2', group: 'Ops B', severity: 'CRITICAL', state: 'UNDERINFLATION', position: 'R1IC', positionName: 'Right Steer', dateDetected: '2026-11-22T13:00:00Z', detectedEt: '11/22/2026, 8:00 AM EST', muted: false },
  { issueId: '9002', fleetVehicleId: 'NP6923', domicile: 'ATL2', group: 'Ops B', severity: 'MAJOR', state: 'LEAK', position: 'L2IC', positionName: 'Left Drive Inner', dateDetected: '2026-11-22T12:00:00Z', detectedEt: '11/22/2026, 7:00 AM EST', muted: false },
  { issueId: '9003', fleetVehicleId: '<b>X1</b>', domicile: 'DFW5', group: 'Ops A', severity: 'CRITICAL', state: 'UNDERINFLATION_AND_LEAK', position: 'L1IC', positionName: 'Left Steer', dateDetected: '2026-11-21T15:00:00Z', detectedEt: '11/21/2026, 10:00 AM EST', muted: true },
];
const CROSS_ROWS = [
  { fleetVehicleId: 'NP6923', domicile: 'ATL2', criticalCount: 1, states: ['UNDERINFLATION'], positions: ['Right Steer'], latestDetected: '2026-11-22T13:00:00Z', latestDetectedEt: '11/22/2026, 8:00 AM EST', inFleet: true, closedDtnaCases: 1 },
];

let doc, prevDoc, prevWin;
function fakeModal() {
  const mm = { opts: null, el: null };
  mm.show = (opts) => {
    mm.opts = opts;
    mm.el = doc.createElement('div');
    mm.el.innerHTML = opts.body;
    doc.body.appendChild(mm.el);
    opts.onMount(mm.el);
  };
  mm.close = () => { mm.el.remove(); if (mm.opts.onClose) mm.opts.onClose(); };
  return mm;
}
function fakeAperia() {
  const a = Object.fromEntries(KEYS.map((k) => [k, vi.fn()]));
  a.status.mockResolvedValue({ ok: true, state: 'connected', alerts: 'off' });
  a.issues.mockImplementation(async ({ type }) => (type === 'critical-no-case'
    ? { ok: true, jobId: 'ax2', rows: CROSS_ROWS, domiciles: ['ATL2'], pulledAt: '2026-11-22T15:00:00Z', count: 1 }
    : { ok: true, jobId: 'ax1', rows: ISSUE_ROWS, domiciles: ['ATL2', 'DFW5'], pulledAt: '2026-11-22T15:00:00Z', count: 4 }));
  a.exportBulk.mockResolvedValue({ ok: true, filename: 'aperia-issues-2026-11-22.tsv' });
  a.bulk.mockResolvedValue({ ok: true, jobId: 'ab1' });
  a.fleetTires.mockResolvedValue({ ok: true, jobId: 'af1' });
  a._progress = [];
  a._unsubs = 0;
  a.onProgress.mockImplementation((cb) => { a._progress.push(cb); return () => { a._unsubs++; a._progress = a._progress.filter((f) => f !== cb); }; });
  return a;
}
const emit = (a, p) => { for (const cb of a._progress.slice()) cb(p); };

beforeEach(() => {
  prevDoc = globalThis.document; prevWin = globalThis.window;
  doc = createMiniDocument();
  globalThis.document = doc;
  busSpy.emit.mockClear();
});
afterEach(() => { globalThis.document = prevDoc; globalThis.window = prevWin; });

describe('issues helpers (pure)', () => {
  it('severityRank', () => {
    expect(im.severityRank('CRITICAL')).toBe(3);
    expect(im.severityRank('major')).toBe(2);
    expect(im.severityRank('MINOR')).toBe(1);
    expect(im.severityRank('')).toBe(0);
    expect(im.severityRank(null)).toBe(0);
  });
  it('sortIssueRows by severity desc puts CRITICAL first; asc reverses; does not mutate', () => {
    const before = ISSUE_ROWS.map((r) => r.issueId).join();
    const desc = im.sortIssueRows(ISSUE_ROWS, 'severity', 'desc').map((r) => r.severity);
    expect(desc).toEqual(['CRITICAL', 'CRITICAL', 'MAJOR', 'MINOR']);
    const asc = im.sortIssueRows(ISSUE_ROWS, 'severity', 'asc').map((r) => r.severity);
    expect(asc).toEqual(['MINOR', 'MAJOR', 'CRITICAL', 'CRITICAL']);
    expect(ISSUE_ROWS.map((r) => r.issueId).join()).toBe(before);
    expect(im.sortIssueRows(ISSUE_ROWS, 'detected', 'desc').map((r) => r.issueId)).toEqual(['9001', '9002', '9003', '9004']);
    expect(im.sortIssueRows(ISSUE_ROWS, 'unit', 'asc').map((r) => r.fleetVehicleId)[0]).toBe('<b>X1</b>');
    expect(im.sortIssueRows(null, 'unit', 'asc')).toEqual([]);
  });
  it('filterByDomicile', () => {
    expect(im.filterByDomicile(ISSUE_ROWS, 'ATL2').map((r) => r.issueId)).toEqual(['9001', '9002']);
    expect(im.filterByDomicile(ISSUE_ROWS, '').length).toBe(4);
    expect(im.filterByDomicile(ISSUE_ROWS, 'NOPE')).toEqual([]);
  });
});

describe('issues modal', () => {
  it('open calls status() only', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    im.openAperiaIssuesModal({ aperia: a, modal: mm });
    await flush();
    expect(a.status).toHaveBeenCalledTimes(1);
    for (const k of KEYS.filter((x) => x !== 'status')) expect(a[k], k).not.toHaveBeenCalled();
    expect(mm.el.querySelector('#aperia-issues-state').textContent).toBe('Aperia: Connected');
    expect(mm.el.querySelector('#aperia-issues-save-tsv').disabled).toBe(true);
    expect(mm.el.querySelector('#aperia-issues-table').innerHTML).toBe('');
    const opts = mm.el.querySelector('#aperia-issues-view').querySelectorAll('option').map((o) => o.textContent);
    expect(opts).toEqual(['Active issues', 'Tire critical, no repair case']);
  });

  it('Load calls issues({type}) once; rows sort by severity desc (CRITICAL first), header click toggles; values escaped', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    im.openAperiaIssuesModal({ aperia: a, modal: mm });
    const q = (s) => mm.el.querySelector(s);
    q('#aperia-issues-view').value = 'active';
    q('#aperia-issues-load').click();
    await flush();
    expect(a.issues).toHaveBeenCalledTimes(1);
    expect(a.issues).toHaveBeenCalledWith({ type: 'active' });
    const sevs = () => q('#aperia-issues-table').querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
    expect(sevs()).toEqual(['CRITICAL', 'CRITICAL', 'MAJOR', 'MINOR']);
    const headers = q('#aperia-issues-table').querySelectorAll('th').map((t) => t.textContent.replace(/ [\u25b2\u25bc]$/, ''));
    expect(headers).toEqual(['Severity', 'Unit', 'Domicile', 'State', 'Position', 'Detected ET']);
    q('th[data-aperia-sort="severity"]').click();
    expect(sevs()).toEqual(['MINOR', 'MAJOR', 'CRITICAL', 'CRITICAL']);
    q('th[data-aperia-sort="severity"]').click();
    expect(sevs()[0]).toBe('CRITICAL');
    q('th[data-aperia-sort="unit"]').click();
    expect(q('#aperia-issues-table').querySelectorAll('tbody tr')[0].children[1].textContent).toBe('<b>X1</b>');
    expect(q('#aperia-issues-table').innerHTML).toContain('&lt;b&gt;X1&lt;/b&gt;');
    expect(q('#aperia-issues-table').innerHTML).toContain('(muted)');
    expect(q('#aperia-issues-msg').textContent).toBe('4 rows \u00b7 pulled 11/22/2026, 10:00 AM EST');
  });

  it('domicile filter narrows the rows and the export carries jobId/format/domicile', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    im.openAperiaIssuesModal({ aperia: a, modal: mm });
    const q = (s) => mm.el.querySelector(s);
    q('#aperia-issues-load').click();
    await flush();
    const sel = q('#aperia-issues-domicile');
    expect(sel.disabled).toBe(false);
    expect(sel.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['', 'ATL2', 'DFW5']);
    sel.value = 'ATL2';
    sel.dispatchEvent({ type: 'change' });
    const units = q('#aperia-issues-table').querySelectorAll('tbody tr').map((tr) => tr.children[1].textContent);
    expect(units).toEqual(['NP6923', 'NP6923']);
    q('#aperia-issues-save-tsv').click();
    await flush();
    expect(a.exportBulk).toHaveBeenCalledWith({ jobId: 'ax1', format: 'tsv', domicile: 'ATL2' });
    sel.value = '';
    sel.dispatchEvent({ type: 'change' });
    expect(q('#aperia-issues-table').querySelectorAll('tbody tr').length).toBe(4);
    q('#aperia-issues-save-xls').click();
    await flush();
    expect(a.exportBulk).toHaveBeenLastCalledWith({ jobId: 'ax1', format: 'xls', domicile: '' });
    expect(busSpy.emit).toHaveBeenCalledWith('ui:toast', { type: 'success', message: 'Saved aperia-issues-2026-11-22.tsv to Downloads', duration: 4000 });
  });

  it('the "Tire critical, no repair case" view loads type critical-no-case and renders its columns', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    im.openAperiaIssuesModal({ aperia: a, modal: mm });
    const q = (s) => mm.el.querySelector(s);
    q('#aperia-issues-view').value = 'critical-no-case';
    q('#aperia-issues-load').click();
    await flush();
    expect(a.issues).toHaveBeenCalledTimes(1);
    expect(a.issues).toHaveBeenCalledWith({ type: 'critical-no-case' });
    const headers = q('#aperia-issues-table').querySelectorAll('th').map((t) => t.textContent.replace(/ [\u25b2\u25bc]$/, ''));
    expect(headers).toEqual(['Unit', 'Domicile', 'Critical', 'States', 'Positions', 'Latest detected ET', 'In fleet', 'Closed DTNA cases']);
    const cells = q('#aperia-issues-table').querySelectorAll('tbody tr')[0].children.map((c) => c.textContent);
    expect(cells).toEqual(['NP6923', 'ATL2', '1', 'UNDERINFLATION', 'Right Steer', '11/22/2026, 8:00 AM EST', 'YES', '1']);
    q('#aperia-issues-save-tsv').click();
    await flush();
    expect(a.exportBulk).toHaveBeenCalledWith({ jobId: 'ax2', format: 'tsv', domicile: '' });
  });

  it('a failed Load shows the code message and keeps Save disabled', async () => {
    const a = fakeAperia();
    a.issues.mockResolvedValueOnce({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    const mm = fakeModal();
    im.openAperiaIssuesModal({ aperia: a, modal: mm });
    mm.el.querySelector('#aperia-issues-load').click();
    await flush();
    expect(mm.el.querySelector('#aperia-issues-msg').textContent).toContain('sign-in needed');
    expect(mm.el.querySelector('#aperia-issues-save-tsv').disabled).toBe(true);
  });
});

describe('bulk helpers (pure)', () => {
  it('parseUnitList splits on whitespace, commas and semicolons, trims, de-dupes case-insensitively', () => {
    expect(bm.parseUnitList(' np6923, NP6923;122269\n\t 122270 ,, ;')).toEqual({ list: ['np6923', '122269', '122270'], overflow: 0, invalid: 0 });
    expect(bm.parseUnitList('')).toEqual({ list: [], overflow: 0, invalid: 0 });
    expect(bm.parseUnitList(null)).toEqual({ list: [], overflow: 0, invalid: 0 });
    expect(bm.parseUnitList('A1 <b> ok#2 ' + 'x'.repeat(41))).toEqual({ list: ['A1', 'ok#2'], overflow: 0, invalid: 2 });
  });
  it('parseUnitList caps at 500 and reports the overflow (duplicates do not count)', () => {
    const ids = Array.from({ length: 503 }, (_, i) => 'U' + i);
    const r = bm.parseUnitList(ids.concat(['u0', 'U1']).join('\n'));
    expect(r.list.length).toBe(500);
    expect(r.list[499]).toBe('U499');
    expect(r.overflow).toBe(3);
  });
  it('progressText', () => {
    expect(bm.progressText({ done: 3, total: 10, failed: 1 })).toBe('3 / 10 \u00b7 1 failed');
    expect(bm.progressText(null)).toBe('0 / 0 \u00b7 0 failed');
  });
});

describe('bulk modal', () => {
  it('open calls status() and subscribes onProgress only; close unsubscribes', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    bm.openAperiaBulkModal({ aperia: a, modal: mm, confirm: () => true });
    await flush();
    expect(a.status).toHaveBeenCalledTimes(1);
    expect(a.onProgress).toHaveBeenCalledTimes(1);
    for (const k of KEYS.filter((x) => x !== 'status' && x !== 'onProgress')) expect(a[k], k).not.toHaveBeenCalled();
    expect(mm.el.textContent).toContain('Sign out in the Aperia panel stops a running pull.');
    mm.close();
    expect(a._unsubs).toBe(1);
    expect(a._progress.length).toBe(0);
  });

  it('Look up calls bulk({list}) once; progress for another jobId is ignored; the final event renders rows; export carries domicile', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    bm.openAperiaBulkModal({ aperia: a, modal: mm, confirm: () => true });
    const q = (s) => mm.el.querySelector(s);
    q('#aperia-bulk-lookup').click();
    expect(a.bulk).not.toHaveBeenCalled();
    expect(q('#aperia-bulk-msg').textContent).toBe('Paste at least one unit number.');
    q('#aperia-bulk-list').value = 'NP6923, 122269 np6923';
    q('#aperia-bulk-lookup').click();
    expect(q('#aperia-bulk-lookup').disabled).toBe(true);
    await flush();
    expect(a.bulk).toHaveBeenCalledTimes(1);
    expect(a.bulk).toHaveBeenCalledWith({ list: ['NP6923', '122269'] });
    emit(a, { jobId: 'other', kind: 'bulk', done: 9, total: 9, failed: 0, finished: true, rows: [{ unit: 'NOPE' }] });
    expect(q('#aperia-bulk-progress-text').textContent).toBe('0 / 0 \u00b7 0 failed');
    expect(q('#aperia-bulk-save-tsv').disabled).toBe(true);
    emit(a, { jobId: 'ab1', kind: 'bulk', done: 1, total: 2, failed: 0, finished: false });
    expect(q('#aperia-bulk-progress-text').textContent).toBe('1 / 2 \u00b7 0 failed');
    expect(q('#aperia-bulk-progress').getAttribute('max')).toBe('2');
    const rows = [
      { unit: 'NP6923', domicile: 'ATL2', position: 'R1IC', positionName: 'Right Steer', pressurePsi: 70, setPointPsi: 100, deltaPsi: -30, readAtEt: 'x', flag: 'CRITICAL LOW', issueSeverity: 'CRITICAL', issueType: 'UNDERINFLATION', lookup: 'OK' },
      { unit: '<i>122269</i>', domicile: 'DFW5', lookup: 'NOT FOUND' },
    ];
    emit(a, { jobId: 'ab1', kind: 'bulk', done: 2, total: 2, failed: 1, finished: true, cancelled: false, rows, domiciles: ['ATL2', 'DFW5'] });
    expect(q('#aperia-bulk-msg').textContent).toBe('Done.');
    expect(q('#aperia-bulk-lookup').disabled).toBe(false);
    const res = q('#aperia-bulk-results');
    expect(res.querySelectorAll('tbody tr').length).toBe(2);
    expect(res.innerHTML).toContain('dp-aperia-flag--critical">CRITICAL LOW<');
    expect(res.innerHTML).toContain('&lt;i&gt;122269&lt;/i&gt;');
    expect(res.innerHTML).toContain('NOT FOUND');
    const sel = q('#aperia-bulk-domicile');
    sel.value = 'DFW5';
    sel.dispatchEvent({ type: 'change' });
    expect(res.querySelectorAll('tbody tr').length).toBe(1);
    q('#aperia-bulk-save-xls').click();
    await flush();
    expect(a.exportBulk).toHaveBeenCalledWith({ jobId: 'ab1', format: 'xls', domicile: 'DFW5' });
    expect(a.fleetTires).not.toHaveBeenCalled();
  });

  it('a list over 500 reports the overflow', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    bm.openAperiaBulkModal({ aperia: a, modal: mm });
    mm.el.querySelector('#aperia-bulk-list').value = Array.from({ length: 502 }, (_, i) => 'U' + i).join(' ');
    mm.el.querySelector('#aperia-bulk-lookup').click();
    await flush();
    expect(a.bulk.mock.calls[0][0].list.length).toBe(500);
    expect(mm.el.querySelector('#aperia-bulk-msg').textContent).toContain('2 over the 500 limit skipped');
  });

  it('Pull full fleet requires confirm: cancel -> no call; OK -> fleetTires({}) once', async () => {
    const a = fakeAperia();
    const mm = fakeModal();
    const confirm = vi.fn(() => false);
    bm.openAperiaBulkModal({ aperia: a, modal: mm, confirm });
    const q = (s) => mm.el.querySelector(s);
    q('#aperia-bulk-fleet').click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('about 8,800 units, one read each');
    expect(a.fleetTires).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    q('#aperia-bulk-fleet').click();
    await flush();
    expect(a.fleetTires).toHaveBeenCalledTimes(1);
    expect(a.fleetTires).toHaveBeenCalledWith({});
    emit(a, { jobId: 'af1', kind: 'fleet', done: 5, total: 5, failed: 0, finished: true, cancelled: true, domiciles: ['ATL2'] });
    expect(q('#aperia-bulk-msg').textContent).toContain('Stopped');
    expect(q('#aperia-bulk-save-tsv').disabled).toBe(false);
    q('#aperia-bulk-save-tsv').click();
    await flush();
    expect(a.exportBulk).toHaveBeenCalledWith({ jobId: 'af1', format: 'tsv', domicile: '' });
    expect(a.bulk).not.toHaveBeenCalled();
  });

  it('a busy start shows the message and re-enables the buttons', async () => {
    const a = fakeAperia();
    a.bulk.mockResolvedValueOnce({ ok: false, code: 'APERIA_BUSY', jobId: 'aold' });
    const mm = fakeModal();
    bm.openAperiaBulkModal({ aperia: a, modal: mm });
    mm.el.querySelector('#aperia-bulk-list').value = 'NP6923';
    mm.el.querySelector('#aperia-bulk-lookup').click();
    await flush();
    expect(mm.el.querySelector('#aperia-bulk-msg').textContent).toBe('An Aperia pull is already running.');
    expect(mm.el.querySelector('#aperia-bulk-lookup').disabled).toBe(false);
    expect(mm.el.querySelector('#aperia-bulk-save-tsv').disabled).toBe(true);
  });
});
