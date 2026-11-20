// tests/pending-estimates-upgrade-dom.test.js — Pending Estimates overlay upgrade
// (renderer/src/js/views/pending-estimates-panel.js) through the htmlparser2 mini DOM:
// Owner control (Mine · Everyone · All, default Mine), stackable filter bar (AND), mismatch
// toggle, Vendor WO chip opening in-app, Escalate on a team-only row. The team scan is a fake
// (no IPC, no AAP / Decisiv call); raw ungated writes THROW so any direct write fails the test.
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
const L = await import('../renderer/src/js/views/pending-estimates-logic.js');

const NOW = Date.parse('2026-11-19T18:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const wr = (n) => '0a1b2c3d-1111-2222-3333-' + String(n).padStart(12, '0');
const VOLVO_URL = (id) => 'https://volvopg.asist.decisiv.net/fleet/estimates/' + id;
const PACCAR_URL = (id) => 'https://paccarpg.decisiv.net/fleet/estimates/' + id;

// The user's own fleet slice: one v1 pending row (mine by definition).
const UNIT_A = { equipmentId: 'A100', workRequestId: wr(1), assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/AAID1', vendor: 'TA',
  estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - 3 * H), estimateSubmittedAmount: 4200, extractedAt: iso(NOW - H) };

const off = (o) => Object.assign({ ok: true, fleetStatus: 'Approved', repairStatus: 'Waiting', stage: 'repair', stageStatus: 'Waiting',
  total: 1000, updatedAt: iso(NOW - 2 * H), scrapedAt: iso(NOW - 10 * 60000) }, o);
const row = (o) => Object.assign({ aaid: '', assetUrl: '', serviceUrl: '', vendor: 'Volvo (ASIST)', vendorKind: 'volvo', domicileSite: 'DXX1',
  operator: 'ABCD', fas: '', mine: false, rgOpen: true, rgPending: false, rgStatus: 'Work in progress', rgPendingCost: null,
  created: iso(NOW - 4 * 24 * H), vendorWorkOrderId: '', offsiteShopEventUrl: '', offsite: null, source: 'rg',
  offsiteDone: false, statusMismatch: false, notInRg: false }, o);
const SCAN = { ok: true, asOf: '2026-11-19T17:45:00Z', excludedDtna: 2, counts: {}, errors: [], rows: [
  // mine
  row({ key: 'wr:' + wr(61), workRequestId: wr(61), equipmentId: 'T610', mine: true, fas: 'Jane Doe', source: 'decisiv',
    offsiteShopEventUrl: VOLVO_URL('610'), offsite: off({}) }),
  row({ key: 'est:888', workRequestId: '', equipmentId: 'T620', mine: true, vendorKind: 'paccar', vendor: 'Kenworth', source: 'decisiv',
    offsiteShopEventUrl: PACCAR_URL('888'), offsite: off({ repairStatus: 'Working', stageStatus: 'Working' }), rgOpen: false, notInRg: true }),
  // everyone else
  row({ key: 'wr:' + wr(63), workRequestId: wr(63), equipmentId: 'T630', fas: 'Bob Roe', source: 'decisiv',
    offsiteShopEventUrl: VOLVO_URL('630'), offsite: off({ repairStatus: 'Complete (here)', stage: 'ready', stageStatus: 'Complete (here)' }),
    offsiteDone: true, statusMismatch: true }),
  row({ key: 'wr:' + wr(64), workRequestId: wr(64), equipmentId: 'T640', fas: 'Bob Roe', vendorKind: 'paccar', vendor: 'Peterbilt', source: 'decisiv',
    offsiteShopEventUrl: PACCAR_URL('640'), offsite: off({}) }),
  row({ key: 'wr:' + wr(65), workRequestId: wr(65), equipmentId: 'T650', aaid: 'AAID-T65', vendorKind: 'other', vendor: 'Rush', source: 'rg',
    rgPending: true, rgPendingCost: 2500, vendorWorkOrderId: 'RO-65' }),
] };

let doc; let ctl; let getScan; let runScan; let openUrl; let openEscalation; let escDeps;
async function setup() {
  doc = createMiniDocument();
  getScan = vi.fn(async () => Object.assign({}, SCAN, { cached: true }));
  runScan = vi.fn(async () => Object.assign({}, SCAN, { cached: false }));
  openUrl = vi.fn(async () => ({ ok: true }));
  openEscalation = vi.fn(async () => {});
  escDeps = { modal: fakeModal, bridge: window.relayWrites, aapApi: window.aapApi, toast: { show: vi.fn() } };
  ctl = P.__test__.createController({ doc, modal: fakeModal, getFleet: () => ({ rows: [UNIT_A], syncedAt: '2026-11-19T17:55:00Z' }),
    getScan, runScan, openUrl, openEscalation, escalationDeps: escDeps, navigate: vi.fn(), now: () => NOW });
  ctl.open();
  await ctl.whenLoaded();
}
const q = (s) => doc.querySelector(s);
const units = () => doc.querySelectorAll('#pe-body [data-pe-unit]').map((b) => b.getAttribute('data-pe-unit')).sort();
const change = (name, set) => { const el = q('[data-pe-filter="' + name + '"]'); set(el); el.dispatchEvent({ type: 'change' }); };

beforeEach(() => {
  fakeModal.show.mockClear();
  globalThis.window = {
    files: { openExternal: vi.fn(() => { throw new Error('EXTERNAL'); }) },
    aap: { openUrl: vi.fn(() => { throw new Error('use the injected openUrl'); }) },
    aapApi: { updateEscalations: vi.fn(() => { throw new Error('RAW WRITE'); }) },
    relayWrites: {
      escalate: vi.fn(() => { throw new Error('NO WRITE'); }),
      addComment: vi.fn(() => { throw new Error('NO WRITE'); }),
      draftAction: vi.fn(() => { throw new Error('NO DRAFT'); }),
    },
  };
});

describe('Pending Estimates upgrade overlay (mini DOM)', () => {
  it('opens on Mine: the Mine button is pressed and only mine rows render; the team-wide scan ran once with force:false', async () => {
    await setup();
    expect(q('[data-pe-owner="mine"]').getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-pe-owner="everyone"]').getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-pe-owner="all"]').getAttribute('aria-pressed')).toBe('false');
    expect(units()).toEqual(['A100', 'T610', 'T620']);
    expect(getScan).toHaveBeenCalledTimes(1);
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan).toHaveBeenCalledWith({ force: false });
    expect(q('#pe-body').textContent).toContain('team as of 11/19 12:45');
    expect(q('.pe-sub').textContent).toBe('RG + Volvo/PACCAR offsite \u00B7 team-wide pull \u00B7 DTNA excluded');
    // bar sits between the head and the body
    const panel = q('.pe-panel');
    expect(panel.children.map((c) => c.className)).toEqual(['pe-head', 'pe-bar', 'pe-body']);
  });

  it('renders every requirement-2 filter and the three Owner buttons', async () => {
    await setup();
    for (const k of ['source', 'fleetStatus', 'repairStatus', 'vendor', 'fas', 'mismatch']) {
      expect(q('#pe-bar [data-pe-filter="' + k + '"]'), k).not.toBe(null);
    }
    expect(q('[data-pe-filter="mismatch"]').getAttribute('type')).toBe('checkbox');
    expect(doc.querySelectorAll('#pe-bar [data-pe-owner]').map((b) => b.textContent)).toEqual(['Mine', 'Everyone', 'All']);
    const vendorOpts = doc.querySelectorAll('[data-pe-filter="vendor"] option').map((o) => o.textContent);
    expect(vendorOpts).toEqual(['Any', 'Volvo', 'PACCAR', 'Other']);
    expect(doc.querySelectorAll('[data-pe-filter="source"] option').map((o) => o.getAttribute('value'))).toEqual(['', 'rg', 'decisiv', 'both']);
    expect(doc.querySelectorAll('[data-pe-filter="fas"] option').map((o) => o.textContent)).toEqual(['Any', 'Bob Roe', 'Jane Doe', 'Unknown']);
    expect(doc.querySelectorAll('[data-pe-filter="repairStatus"] option').map((o) => o.textContent))
      .toEqual(['Any', 'Complete (here)', 'Waiting', 'Working', 'Unknown']);
  });

  it('Everyone shows only the rest of the team, All shows everyone; the pull is unchanged by the toggle', async () => {
    await setup();
    q('[data-pe-owner="everyone"]').click();
    expect(units()).toEqual(['T630', 'T640', 'T650']);
    expect(q('[data-pe-owner="everyone"]').getAttribute('aria-pressed')).toBe('true');
    q('[data-pe-owner="all"]').click();
    expect(units()).toEqual(['A100', 'T610', 'T620', 'T630', 'T640', 'T650']);
    q('[data-pe-owner="mine"]').click();
    expect(units()).toEqual(['A100', 'T610', 'T620']);
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan.mock.calls[0]).toEqual([{ force: false }]);
    expect(getScan).toHaveBeenCalledTimes(1);
  });

  it('two filters stack with AND (vendor paccar + source decisiv) and compose with Owner', async () => {
    await setup();
    q('[data-pe-owner="all"]').click();
    change('vendor', (el) => { el.value = 'paccar'; });
    expect(units()).toEqual(['T620', 'T640']);
    change('source', (el) => { el.value = 'decisiv'; });
    expect(units()).toEqual(['T620', 'T640']);
    change('fas', (el) => { el.value = 'Bob Roe'; });
    expect(units()).toEqual(['T640']);
    expect(q('[data-pe-filter="vendor"] option[value="paccar"]').hasAttribute('selected')).toBe(true);
    q('[data-pe-owner="mine"]').click();
    expect(units()).toEqual([]);
    expect(q('#pe-body').textContent).toContain('No rows match the current filters.');
    q('[data-pe-clear]').click();
    expect(units()).toEqual(['A100', 'T610', 'T620']);
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('the mismatch checkbox alone shows only the "Done offsite · RG WO still open" rows', async () => {
    await setup();
    q('[data-pe-owner="all"]').click();
    change('mismatch', (el) => { el.checked = true; });
    expect(units()).toEqual(['T630']);
    const rows = doc.querySelectorAll('#pe-body tr.pe-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('td').querySelector('.pe-badge--mismatch').textContent).toBe('\u2714 Done offsite \u00B7 RG WO still open');
    expect(q('[data-pe-filter="mismatch"]').hasAttribute('checked')).toBe(true);
    change('mismatch', (el) => { el.checked = false; });
    expect(units()).toHaveLength(6);
  });

  it('the mismatch sort header puts flagged rows first', async () => {
    await setup();
    q('[data-pe-owner="all"]').click();
    q('th[data-pe-sort="mismatch"]').click();
    expect(doc.querySelectorAll('#pe-body [data-pe-unit]')[0].getAttribute('data-pe-unit')).toBe('T630');
    expect(q('th[data-pe-sort="mismatch"]').getAttribute('aria-sort')).toBe('ascending');
  });

  it('a Vendor WO chip opens in-app through openUrl(url, { zoom: true }), never openExternal', async () => {
    await setup();
    const chips = doc.querySelectorAll('#pe-body [data-id-link-field="vendor-wo"]');
    expect(chips.length).toBeGreaterThan(0);
    const chip = chips.find((c) => c.getAttribute('data-id-link') === VOLVO_URL('610'));
    expect(chip.textContent).toBe('Vendor WO610');
    chip.click();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(VOLVO_URL('610'), { zoom: true });
    expect(window.files.openExternal).not.toHaveBeenCalled();
    expect(doc.body.children).toHaveLength(1); // the chip click did not close / navigate
  });

  it('Escalate on a team-only row opens the Escalate modal pre-targeted to HVE; nothing writes', async () => {
    await setup();
    q('[data-pe-owner="everyone"]').click();
    const btn = q('[data-pe-escalate="wr:' + wr(65) + '"]');
    expect(btn.disabled).toBe(false);
    btn.click();
    await Promise.resolve();
    expect(openEscalation).toHaveBeenCalledTimes(1);
    const [unit, wrId, deps, opts] = openEscalation.mock.calls[0];
    expect(unit).toMatchObject({ equipmentId: 'T650', workRequestId: wr(65), aaid: 'AAID-T65', estimatePendingCost: 2500 });
    expect(wrId).toBe(wr(65));
    expect(deps).toBe(escDeps);
    expect(opts).toEqual({ initialTarget: L.HVE_TARGET });
    expect(L.HVE_TARGET).toBe('MCS_HIGH_VALUE_ESTIMATE');
    for (const fn of ['escalate', 'addComment', 'draftAction']) expect(window.relayWrites[fn]).not.toHaveBeenCalled();
    expect(window.aapApi.updateEscalations).not.toHaveBeenCalled();
  });

  it('Refresh re-runs the same team-wide scan with force:true', async () => {
    await setup();
    q('[data-pe-refresh]').click();
    await ctl.whenLoaded();
    await new Promise((r) => setTimeout(r, 0));
    expect(runScan).toHaveBeenCalledTimes(2);
    expect(runScan.mock.calls[1]).toEqual([{ force: true }]);
  });
});
