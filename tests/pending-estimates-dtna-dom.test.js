// tests/pending-estimates-dtna-dom.test.js — DTNA rows in the Pending Estimates overlay (Phase B) through
// the htmlparser2 mini DOM: Total '—' with the hint, status from the case, Source DTNA / both, the DTNA
// Vendor-WO chip opening in-app, the header "Pull DTNA" button (bulkPull + one forced scan), and proof
// that open / auto-scan / Refresh never touch window.dtna. The scan and the dtna bridge are fakes.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMiniDocument } from './fixtures/mini-dom.js';

const fakeModal = vi.hoisted(() => ({ show: vi.fn(), close: vi.fn(), isOpen: vi.fn(() => false) }));
vi.mock('../renderer/src/js/bridge.js', () => ({}));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() { return () => {}; }, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { slice() { return {}; }, update() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show: vi.fn() } }));
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: fakeModal }));

const P = await import('../renderer/src/js/views/pending-estimates-panel.js');

const NOW = Date.parse('2026-11-19T18:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const wr = (n) => '0a1b2c3d-1111-2222-3333-' + String(n).padStart(12, '0');
const CASE = '500gx000002E4U5AAK';
const CASE2 = '500gx000003ZOQoAAO';
const DURL = (c) => 'https://dtna.my.site.com/Servicetracker/s/case/' + c + '/detail';
const VOLVO_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/610';

const dOff = (o) => Object.assign({ source: 'dtna', caseId: CASE, url: DURL(CASE), dealerName: 'HORWITH FREIGHTLINER', fleetStatus: '',
  repairStatus: 'Arrived', stage: 'arrival', stageStatus: '', stageSince: '', total: null, totalSource: 'none',
  updatedAt: iso(NOW - 2 * H), scrapedAt: iso(NOW - H), roNumber: 'R101048154', ok: true }, o);
const row = (o) => Object.assign({ aaid: '', assetUrl: '', serviceUrl: '', vendor: 'Freightliner', vendorKind: 'dtna', domicileSite: 'DXX1',
  operator: 'ABCD', fas: 'Jane Doe', mine: true, rgOpen: true, rgPending: false, rgStatus: 'Work in progress', rgPendingCost: null,
  created: iso(NOW - 4 * 24 * H), vendorWorkOrderId: '', offsiteShopEventUrl: '', offsite: null, source: 'rg',
  offsiteDone: false, statusMismatch: false, notInRg: false }, o);
const ROWS = [
  row({ key: 'wr:' + wr(70), workRequestId: wr(70), equipmentId: 'D700', source: 'dtna', offsiteShopEventUrl: DURL(CASE), offsite: dOff({}),
    dtnaCaseId: CASE, dtnaRepairOrderNo: 'R101048154' }),
  row({ key: 'wr:' + wr(71), workRequestId: wr(71), equipmentId: 'D710', source: 'both', rgPending: true, rgPendingCost: 300,
    offsiteShopEventUrl: DURL(CASE2), offsite: dOff({ caseId: CASE2, url: DURL(CASE2), repairStatus: 'In Repair' }), dtnaCaseId: CASE2, dtnaRepairOrderNo: 'R2' }),
  row({ key: 'wr:' + wr(61), workRequestId: wr(61), equipmentId: 'T610', vendor: 'Volvo (ASIST)', vendorKind: 'volvo', source: 'decisiv',
    offsiteShopEventUrl: VOLVO_URL, offsite: { ok: true, fleetStatus: 'Approved', repairStatus: 'Waiting', total: 1000, scrapedAt: iso(NOW - H) } }),
];
const FRESH_AS_OF = '2026-11-19T17:55:00Z';
const STALE_AS_OF = '2026-11-19T17:30:00Z';
const SCAN = (o) => Object.assign({ ok: true, asOf: FRESH_AS_OF, excludedDtna: 0, dtnaAsOf: '2026-11-19T17:00:00Z', counts: {}, errors: [], rows: ROWS }, o);

let doc; let ctl; let getScan; let runScan; let openUrl; let dtna; let progressCb; let toast;
function fakeDtna(o = {}) {
  progressCb = null;
  return {
    bulkPull: vi.fn(o.bulkPull || (async () => ({ ok: true, jobId: 'jabc' }))),
    onProgress: vi.fn((cb) => { progressCb = cb; return () => { progressCb = null; }; }),
    pullUnit: vi.fn(async () => { throw new Error('NO DTNA CALL'); }),
    listCases: vi.fn(async () => { throw new Error('NO DTNA CALL'); }),
    login: vi.fn(async () => ({ ok: true })),
  };
}
function make({ asOf = FRESH_AS_OF, withDtna = true, dtnaOver } = {}) {
  doc = createMiniDocument();
  getScan = vi.fn(() => SCAN({ asOf, cached: true }));
  runScan = vi.fn(async () => SCAN({ asOf: iso(NOW), cached: false, dtnaAsOf: iso(NOW - 60000) }));
  openUrl = vi.fn(async () => ({ ok: true }));
  toast = { show: vi.fn() };
  dtna = withDtna ? fakeDtna(dtnaOver) : null;
  ctl = P.__test__.createController({ doc, modal: fakeModal, getFleet: () => ({ rows: [], syncedAt: '2026-11-19T17:55:00Z' }),
    getScan, runScan, openUrl, openEscalation: vi.fn(), navigate: vi.fn(), now: () => NOW, toast, dtna });
}
const q = (s) => doc.querySelector(s);
const tr = (unit) => doc.querySelectorAll('#pe-body tr.pe-row').find((r) => r.querySelector('[data-pe-unit]').getAttribute('data-pe-unit') === unit);
const cells = (unit) => tr(unit).querySelectorAll('td');
const units = () => doc.querySelectorAll('#pe-body [data-pe-unit]').map((b) => b.getAttribute('data-pe-unit')).sort();
const change = (name, set) => { const el = q('[data-pe-filter="' + name + '"]'); set(el); el.dispatchEvent({ type: 'change' }); };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const dtnaNetCalls = () => dtna.bulkPull.mock.calls.length + dtna.pullUnit.mock.calls.length + dtna.listCases.mock.calls.length;

beforeEach(() => {
  globalThis.window = {
    files: { openExternal: vi.fn(() => { throw new Error('EXTERNAL'); }) },
    aap: { openUrl: vi.fn(() => { throw new Error('use the injected openUrl'); }) },
    dtna: { bulkPull: vi.fn(() => { throw new Error('use the injected dtna'); }) },
  };
});

describe('DTNA rows in Pending Estimates', () => {
  it('Total is a dash with the hint, Repair Status is the case status, Source DTNA / both', async () => {
    make();
    ctl.open();
    await ctl.whenLoaded();
    expect(units()).toEqual(['D700', 'D710', 'T610']);
    const c = cells('D700');
    // Unit, Vendor, Vendor WO, Source, FAS, Fleet Status, Repair Status, Total, Est amount, ...
    expect(c[3].textContent).toBe('DTNA');
    expect(c[5].textContent).toBe('\u2014');
    expect(c[6].textContent).toContain('Arrived');
    expect(c[7].textContent).toBe('\u2014');
    expect(c[7].getAttribute('title')).toBe('DTNA does not expose an estimate amount');
    expect(cells('D710')[3].textContent).toBe('both');
    expect(cells('D710')[6].textContent).toContain('In Repair');
    expect(cells('D710')[7].textContent).toBe('\u2014');
    expect(cells('T610')[7].textContent).toBe('$1,000.00');   // Decisiv totals unchanged
    expect(q('#pe-meta').textContent).toContain('DTNA as of 11/19 12:00');
  });

  it('the DTNA Vendor-WO chip shows the RO and opens the case in-app', async () => {
    make();
    ctl.open();
    await ctl.whenLoaded();
    const chip = tr('D700').querySelector('[data-id-link-field="vendor-wo"]');
    expect(chip.textContent).toBe('Vendor WOR101048154');
    expect(chip.getAttribute('data-id-link')).toBe(DURL(CASE));
    chip.click();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(DURL(CASE), { zoom: true });
    expect(window.files.openExternal).not.toHaveBeenCalled();
  });

  it('Vendor filter dtna and Source filter dtna', async () => {
    make();
    ctl.open();
    await ctl.whenLoaded();
    change('vendor', (el) => { el.value = 'dtna'; });
    expect(units()).toEqual(['D700', 'D710']);
    change('source', (el) => { el.value = 'dtna'; });
    expect(units()).toEqual(['D700']);
  });

  it('"Pull DTNA" calls bulkPull once with comments, shows progress, then runs exactly one forced scan', async () => {
    make();
    ctl.open();
    await ctl.whenLoaded();
    expect(runScan).not.toHaveBeenCalled();     // fresh cache: no scan on open
    const btn = () => q('[data-pe-dtna-pull]');
    expect(btn().textContent).toBe('\u2B07 Pull DTNA');
    btn().click();
    await flush();
    expect(dtna.bulkPull).toHaveBeenCalledTimes(1);
    expect(dtna.bulkPull).toHaveBeenCalledWith({ includeComments: true });
    expect(btn().disabled).toBe(true);
    btn().click();                               // ignored while pulling
    await flush();
    expect(dtna.bulkPull).toHaveBeenCalledTimes(1);
    progressCb({ jobId: 'jother', done: 9, total: 9, failed: 0, finished: true });   // another job: ignored
    progressCb({ jobId: 'jabc', done: 1, total: 2, failed: 0, finished: false });
    expect(btn().textContent).toBe('Pulling DTNA\u2026 1/2');
    expect(runScan).not.toHaveBeenCalled();
    progressCb({ jobId: 'jabc', done: 2, total: 2, failed: 0, finished: true, cancelled: false });
    await flush();
    await ctl.whenLoaded();
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan).toHaveBeenCalledWith({ force: true });
    expect(btn().disabled).toBe(false);
    expect(btn().textContent).toBe('\u2B07 Pull DTNA');
    expect(toast.show).toHaveBeenCalledWith('success', 'DTNA: 2 cases pulled (0 failed)', 4000);
    expect(progressCb).toBeNull();               // unsubscribed
    expect(window.dtna.bulkPull).not.toHaveBeenCalled();
  });

  it('progress that arrives before bulkPull resolves is buffered by jobId', async () => {
    make({ dtnaOver: { bulkPull: async () => { progressCb({ jobId: 'jabc', done: 1, total: 1, failed: 0, finished: true }); return { ok: true, jobId: 'jabc' }; } } });
    ctl.open();
    await ctl.whenLoaded();
    q('[data-pe-dtna-pull]').click();
    await flush();
    await ctl.whenLoaded();
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan).toHaveBeenCalledWith({ force: true });
  });

  it('busy / sign-in failures toast and run no scan; sign-in opens the login window', async () => {
    make({ dtnaOver: { bulkPull: async () => ({ ok: false, code: 'DTNA_BUSY', jobId: 'jx' }) } });
    ctl.open();
    await ctl.whenLoaded();
    q('[data-pe-dtna-pull]').click();
    await flush();
    expect(toast.show).toHaveBeenCalledWith('warn', 'A DTNA pull is already running', 4000);
    expect(runScan).not.toHaveBeenCalled();
    expect(q('[data-pe-dtna-pull]').disabled).toBe(false);
    make({ dtnaOver: { bulkPull: async () => ({ ok: true, jobId: 'jabc' }) } });
    ctl.open();
    await ctl.whenLoaded();
    q('[data-pe-dtna-pull]').click();
    await flush();
    progressCb({ jobId: 'jabc', done: 0, total: 0, failed: 0, finished: true, code: 'DTNA_SIGNIN_REQUIRED' });
    await flush();
    expect(dtna.login).toHaveBeenCalledTimes(1);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('open (stale auto-scan) and Refresh run scans but never call window.dtna', async () => {
    make({ asOf: STALE_AS_OF });
    ctl.open();
    await ctl.whenLoaded();
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan).toHaveBeenCalledWith({ force: false });
    q('[data-pe-refresh]').click();
    await ctl.whenLoaded();
    await flush();
    expect(runScan).toHaveBeenCalledTimes(2);
    expect(runScan.mock.calls[1]).toEqual([{ force: true }]);
    expect(dtnaNetCalls()).toBe(0);
    expect(dtna.onProgress).not.toHaveBeenCalled();
    expect(window.dtna.bulkPull).not.toHaveBeenCalled();
  });

  it('without a dtna bridge the Pull DTNA button is absent', async () => {
    make({ withDtna: false });
    ctl.open();
    await ctl.whenLoaded();
    expect(q('[data-pe-dtna-pull]')).toBe(null);
    expect(q('[data-pe-refresh]')).not.toBe(null);
  });
});
