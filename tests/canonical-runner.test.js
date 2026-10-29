// tests/canonical-runner.test.js
//
// Canonical pass in API mode (src/orcha/canonical_runner.js) + the Decisiv
// case-stage override in canonical_state (2026-10-28).
//  - the API stage decides READY (Ready -> ready_for_pickup; other stages veto
//    a ready that only came from note wording)
//  - deep-scan's stage/notes get saved onto the stored fleet rows
//  - first run after a gap is a QUIET BASELINE (no carrier notices)
//  - a normal run with a fresh ready transition queues the notice
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const canonical = require('../src/orcha/canonical_state');
const runner = require('../src/orcha/canonical_runner');

const SINCE = '2026-10-29T09:00:00-04:00';

describe('canonical: Decisiv API stage decides Ready', () => {
  it('API stage Ready -> ready_for_pickup, even with no "ready" wording', () => {
    expect(canonical._stageOverride({ offsiteStage: 'ready', offsiteStageSince: SINCE }, 'in_repair')).toBe('ready_for_pickup');
    const rec = canonical.computeCanonical({ equipmentId: 'U1', lifecycleState: 'Unavailable', issueSummary: 'turbo replacement', offsiteStage: 'ready', offsiteStageSince: SINCE });
    expect(rec.status).toBe('ready_for_pickup');
  });
  it('a stale "ready" in the notes is vetoed while the dealer case is still in repair', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'U2', lifecycleState: 'Unavailable', issueSummary: 'unit will be ready for pickup Friday',
      offsiteStage: 'repair', offsiteStageDetail: 'Road Test', offsiteStageSince: SINCE });
    expect(rec.status).toBe('in_repair');
    expect(canonical._stageOverride({ offsiteStage: 'repair', offsiteStageDetail: 'Hold (parts)', offsiteStageSince: SINCE }, 'ready_for_pickup')).toBe('awaiting_parts');
    expect(canonical._stageOverride({ offsiteStage: 'approval', offsiteStageDetail: 'Hold (auth)', offsiteStageSince: SINCE }, 'ready_for_pickup')).toBe('awaiting_estimate_approval');
  });
  it('non-ready stages do NOT change other statuses', () => {
    expect(canonical._stageOverride({ offsiteStage: 'repair', offsiteStageSince: SINCE }, 'awaiting_parts')).toBe('awaiting_parts');
  });
  it('a screen-read stage (no offsiteStageSince) changes nothing', () => {
    expect(canonical._stageOverride({ offsiteStage: 'ready' }, 'in_repair')).toBe('in_repair');
    expect(canonical._stageOverride({ offsiteStage: 'repair' }, 'ready_for_pickup')).toBe('ready_for_pickup');
  });
});

describe('overlayDeepScanFields', () => {
  it('copies stage + notes onto stored rows for the same WR only (newer read)', () => {
    const live = [{ equipmentId: 'A', _offsiteWrId: 'w1' }, { equipmentId: 'B', _offsiteWrId: 'w2', offsiteStage: '' }];
    const scanned = [{ equipmentId: 'A', _offsiteWrId: 'w1', offsiteStage: 'ready', offsiteStageSince: SINCE, _stageReadAt: '2026-10-29T04:00:00Z',
      asistNotes: 'Asset ready', asistScrapedAt: '2026-10-29T04:00:00Z' },
    { equipmentId: 'B', _offsiteWrId: 'OLD', offsiteStage: 'ready', offsiteStageSince: SINCE, _stageReadAt: '2026-10-29T04:00:00Z' }];
    expect(runner.overlayDeepScanFields(live, scanned)).toBe(1);
    expect(live[0]).toMatchObject({ offsiteStage: 'ready', offsiteStageSince: SINCE, asistNotes: 'Asset ready' });
    expect(live[1].offsiteStage).toBe(''); // offsite moved to another WR -> not resurrected
  });

  it('REGRESSION 322504: a stale deep-scan copy never overwrites a newer stage read', () => {
    // stage refresh saved "no status" at 04:02; deep-scan (rows loaded earlier) finished at 04:05
    const live = [{ equipmentId: '322504', _offsiteWrId: 'w', offsiteStage: '', offsiteStageDetail: 'No status set by the dealer yet', offsiteStageSince: '', _stageReadAt: '2026-10-29T04:02:55Z' }];
    const stale = [{ equipmentId: '322504', _offsiteWrId: 'w', offsiteStage: 'ready', offsiteStageDetail: '', offsiteStageSince: '' }];
    expect(runner.overlayDeepScanFields(live, stale)).toBe(0);
    expect(live[0]).toMatchObject({ offsiteStage: '', offsiteStageDetail: 'No status set by the dealer yet' });
  });

  it('a newer deep-scan read (incl. "no status") does replace an older one', () => {
    const live = [{ equipmentId: 'X', _offsiteWrId: 'w', offsiteStage: 'ready', _stageReadAt: '2026-10-29T03:00:00Z' }];
    const fresh = [{ equipmentId: 'X', _offsiteWrId: 'w', offsiteStage: '', offsiteStageDetail: 'No status set by the dealer yet', offsiteStageSince: '', _stageReadAt: '2026-10-29T04:00:00Z' }];
    expect(runner.overlayDeepScanFields(live, fresh)).toBe(1);
    expect(live[0].offsiteStage).toBe('');
  });
});

function fakeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial));
  return { data, load: (k, d) => (k in data ? data[k] : d), save: (k, v) => { data[k] = v; } };
}
function fakeNotify() {
  const calls = [];
  return { calls, _isFreshReady: (rec) => !!(rec && rec.status === 'ready_for_pickup' && rec.previousStatus && rec.previousStatus !== 'ready_for_pickup'),
    enqueue: (fn) => Promise.resolve().then(fn), notifyReadyUnits: vi.fn(async (units) => { calls.push(Object.keys(units)); return {}; }) };
}
const NOW = Date.parse('2026-10-29T14:00:00Z');
const ROWS = [{ equipmentId: 'U1', lifecycleState: 'Unavailable', issueSummary: 'turbo replacement', offsiteStage: 'ready', offsiteStageSince: SINCE }];

describe('runCanonicalPass', () => {
  it('first run after the 10-16 gap = quiet baseline: saves state, sends nothing', () => {
    const store = fakeStore({ fleetData: { rows: ROWS }, canonicalState: { updatedAt: '2026-10-16T22:43:56.839Z', units: { U1: { equipmentId: 'U1', status: 'in_repair' } } } });
    const rn = fakeNotify();
    const res = runner.runCanonicalPass({ deps: { store, readyNotify: rn, notifyDeps: {}, now: () => NOW, log: { info() {}, warn() {} } } });
    expect(res.baseline).toBe(true);
    expect(res.notifyQueued).toBe(false);
    expect(rn.notifyReadyUnits).not.toHaveBeenCalled();
    expect(store.data.canonicalState.updatedAt).toBe(new Date(NOW).toISOString());
    expect(store.data.canonicalState.units.U1.status).toBe('ready_for_pickup');
    expect(store.data.fleetData.rows[0].canonicalStatus || store.data.fleetData.rows[0]).toBeTruthy();
  });

  it('REGRESSION (B12343): fresh file timestamp but a 10-16 unit record -> baselined, NO notice', () => {
    const store = fakeStore({ fleetData: { rows: ROWS }, canonicalState: {
      updatedAt: new Date(NOW - 10 * 60000).toISOString(),   // bumped by a single-unit refresh
      units: { U1: { equipmentId: 'U1', status: 'in_repair', updatedAt: '2026-10-16T22:43:56.769Z' } } } });
    const rn = fakeNotify();
    const res = runner.runCanonicalPass({ deps: { store, readyNotify: rn, notifyDeps: {}, now: () => NOW, log: { info() {}, warn() {} } } });
    expect(res.baseline).toBe(false);
    expect(res.baselinedUnits).toBe(1);
    expect(res.notifyQueued).toBe(false);
    expect(rn.notifyReadyUnits).not.toHaveBeenCalled();
  });

  it('a unit with no prior record at all is baselined too (never a "transition")', () => {
    const store = fakeStore({ fleetData: { rows: ROWS }, canonicalState: { updatedAt: new Date(NOW - 60000).toISOString(), units: {} } });
    const rn = fakeNotify();
    const res = runner.runCanonicalPass({ deps: { store, readyNotify: rn, notifyDeps: {}, now: () => NOW, log: { info() {}, warn() {} } } });
    expect(res.notifyQueued).toBe(false);
  });

  it('normal run: a fresh transition to Ready queues the carrier notice', async () => {
    const store = fakeStore({ fleetData: { rows: ROWS }, canonicalState: { updatedAt: new Date(NOW - 20 * 60000).toISOString(),
      units: { U1: { equipmentId: 'U1', status: 'in_repair', updatedAt: new Date(NOW - 20 * 60000).toISOString() } } } });
    const rn = fakeNotify();
    const res = runner.runCanonicalPass({ deps: { store, readyNotify: rn, notifyDeps: {}, now: () => NOW, log: { info() {}, warn() {} } } });
    expect(res.baseline).toBe(false);
    expect(res.notifyQueued).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(rn.calls).toEqual([['U1']]);
  });

  it('a unit already Ready last run does not notify again', () => {
    const store = fakeStore({ fleetData: { rows: ROWS }, canonicalState: { updatedAt: new Date(NOW - 20 * 60000).toISOString(), units: { U1: { equipmentId: 'U1', status: 'ready_for_pickup' } } } });
    const rn = fakeNotify();
    const res = runner.runCanonicalPass({ deps: { store, readyNotify: rn, notifyDeps: {}, now: () => NOW, log: { info() {}, warn() {} } } });
    expect(res.notifyQueued).toBe(false);
  });

  it('saves the deep-scan stage so the pass sees it, then mirrors + pushes', () => {
    const store = fakeStore({ fleetData: { rows: [{ equipmentId: 'U1', lifecycleState: 'Unavailable', _offsiteWrId: 'w1' }] }, canonicalState: { updatedAt: new Date(NOW - 60000).toISOString(), units: {} } });
    const pushed = [];
    const res = runner.runCanonicalPass({
      scannedRows: [{ equipmentId: 'U1', _offsiteWrId: 'w1', offsiteStage: 'repair', offsiteStageDetail: 'Road Test', offsiteStageSince: SINCE, _stageReadAt: '2026-10-29T13:59:00Z' }],
      pushData: (p) => pushed.push(p),
      deps: { store, readyNotify: fakeNotify(), notifyDeps: {}, now: () => NOW, log: { info() {}, warn() {} } },
    });
    expect(res.overlaid).toBe(1);
    expect(store.data.fleetData.rows[0]).toMatchObject({ offsiteStage: 'repair', offsiteStageDetail: 'Road Test' });
    expect(pushed.length).toBe(1);
  });
});
