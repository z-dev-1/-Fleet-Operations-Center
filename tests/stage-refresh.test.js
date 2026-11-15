// tests/stage-refresh.test.js
//
// Quick Volvo/PACCAR case-stage refresh (src/orcha/stage_refresh.js), 2026-10-28.
// Reads only the Decisiv status API, saves stage/detail/since on the stored
// rows, runs the canonical pass, and hands Ready cases to the gated notifier.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sr = require('../src/orcha/stage_refresh');

const ROWS = () => [
  { equipmentId: '39582', _offsiteWrId: 'w1', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/20945735' },
  { equipmentId: 'B62274', _offsiteWrId: 'w2', offsiteShopEventUrl: 'https://paccarpg.decisiv.net/fleet/estimates/21467830' },
  { equipmentId: '59080', _offsiteWrId: 'w3', offsiteShopEventUrl: 'https://paccarpg.decisiv.net/service_requests/999', asistSrUrl: 'https://paccarpg.decisiv.net/fleet/estimates/21507037' },
  { equipmentId: '922516', offsiteShopEventUrl: 'https://dtna.my.site.com/Servicetracker/s/case/500X' },
  { equipmentId: 'AVAIL1' },
];

function fakes(statusById) {
  const data = { fleetData: { rows: ROWS() } };
  const store = { load: (k, d) => (k in data ? data[k] : d), save: (k, v) => { data[k] = v; } };
  const calls = [];
  const decisiv = { getCaseStatusSummary: vi.fn(async (id, o) => { calls.push([id, o.srUrl]); return statusById[id] || { ok: false, error: 'x' }; }) };
  const notified = [];
  const readyNotify = { onStageUpdate: (r) => { notified.push(r.equipmentId); return Promise.resolve({}); } };
  const runCanonicalPass = vi.fn(() => ({ ok: true }));
  return { data, deps: { store, decisiv, readyNotify, runCanonicalPass, log: { info() {}, warn() {} } }, calls, notified, runCanonicalPass };
}

beforeEach(() => sr._resetForTests());

describe('stage refresh', () => {
  it('targets only Volvo/PACCAR cases (estimate link in any offsite field)', () => {
    expect(sr.stageTargets(ROWS()).map((t) => t.equipmentId + ':' + t.estId)).toEqual(['39582:20945735', 'B62274:21467830', '59080:21507037']);
  });

  it('reads each case once, saves stage/detail/since, runs canonical, notifies only Ready', async () => {
    const f = fakes({
      '20945735': { ok: true, stage: 'repair', status: 'Road Test', since: '2026-10-28T18:26:37-04:00' },
      '21467830': { ok: true, stage: 'ready', status: 'Asset Ready', since: '2026-10-29T08:00:00-04:00' },
      '21507037': { ok: true, stage: 'approval', status: 'Hold (auth)', since: '2026-10-28T10:37:50-04:00' },
    });
    const res = await sr.refreshStages({ deps: f.deps });
    expect(res).toMatchObject({ ran: true, read: 3, failed: 0, changed: 3 });
    expect(f.calls.map((c) => c[0])).toEqual(['20945735', '21467830', '21507037']);
    expect(f.calls[1][1]).toBe('https://paccarpg.decisiv.net/fleet/estimates/21467830'); // lands on the case page
    const rows = f.data.fleetData.rows;
    expect(rows[0]).toMatchObject({ offsiteStage: 'repair', offsiteStageDetail: 'Road Test', offsiteStageSince: '2026-10-28T18:26:37-04:00' });
    expect(rows[2]).toMatchObject({ offsiteStage: 'approval', offsiteStageDetail: 'Hold (auth)' });
    expect(rows[3].offsiteStage).toBeUndefined();   // DTNA untouched
    expect(f.runCanonicalPass).toHaveBeenCalledTimes(1);
    expect(f.notified).toEqual(['B62274']);          // only the Ready case goes to the (gated) notifier
  });

  it('a failed read leaves the row as it was', async () => {
    const f = fakes({ '20945735': { ok: true, stage: 'repair', status: 'Working', since: 's' } });
    const res = await sr.refreshStages({ deps: f.deps });
    expect(res).toMatchObject({ read: 1, failed: 2, changed: 1 });
    expect(f.data.fleetData.rows[1].offsiteStage).toBeUndefined();
  });

  it('throttled to once per 15 min unless forced', async () => {
    const f = fakes({});
    let t = Date.parse('2026-10-29T04:00:00Z');
    f.deps.now = () => t;
    expect((await sr.refreshStages({ deps: f.deps })).ran).toBe(true);
    t += 5 * 60000;
    expect((await sr.refreshStages({ deps: f.deps })).reason).toBe('throttled');
    t += 11 * 60000;
    expect((await sr.refreshStages({ deps: f.deps })).ran).toBe(true);
    expect((await sr.refreshStages({ deps: f.deps, force: true })).ran).toBe(true);
  });

  it('applyStages skips a row whose offsite moved to another WR', () => {
    const rows = [{ equipmentId: 'A', _offsiteWrId: 'new' }];
    expect(sr.applyStages(rows, [{ equipmentId: 'A', wrId: 'old', stage: 'ready', status: 'x', since: 's' }])).toBe(0);
    expect(rows[0].offsiteStage).toBeUndefined();
  });
});

// Opening a unit (Relay merge) keeps the API stage trio together.
describe('relay merge keeps the stage trio', () => {
  const { mergeRelayIntoRows } = require('../src/scrapers/relay');
  it('a fresh API read (with time) is carried onto the row', () => {
    const rows = [{ equipmentId: '59080' }];
    const out = mergeRelayIntoRows(rows, { '59080': { offsiteStage: 'approval', offsiteStageDetail: 'Hold (auth)', offsiteStageSince: 's1' } }, {});
    expect(out[0]).toMatchObject({ offsiteStage: 'approval', offsiteStageDetail: 'Hold (auth)', offsiteStageSince: 's1' });
  });
  it('an old cache entry without a time never overwrites a row that has an API stage', () => {
    const rows = [{ equipmentId: '59080', offsiteStage: 'repair', offsiteStageDetail: 'Working', offsiteStageSince: 's2' }];
    const out = mergeRelayIntoRows(rows, { '59080': { offsiteStage: 'ready' } }, {});
    expect(out[0]).toMatchObject({ offsiteStage: 'repair', offsiteStageDetail: 'Working', offsiteStageSince: 's2' });
  });
});

describe('dealer never set a status (322504)', () => {
  it('clears an old guessed "ready" and records "no status yet"; never notifies', async () => {
    const f = fakes({ '20945735': { ok: true, empty: true, stage: '', status: '', since: '' } });
    f.data.fleetData.rows[0].offsiteStage = 'ready';      // the old wording guess
    const res = await sr.refreshStages({ deps: f.deps });
    expect(res.changed).toBe(1);
    expect(f.data.fleetData.rows[0]).toMatchObject({ offsiteStage: '', offsiteStageDetail: sr.NO_STATUS, offsiteStageSince: '' });
    expect(f.notified).toEqual([]);
  });
  it('relay merge: an API "no status" answer clears the old guessed stage', () => {
    const { mergeRelayIntoRows } = require('../src/scrapers/relay');
    const out = mergeRelayIntoRows([{ equipmentId: '322504', offsiteStage: 'ready' }],
      { '322504': { offsiteStage: '', offsiteStageConfidence: 'api', offsiteStageDetail: sr.NO_STATUS } }, {});
    expect(out[0]).toMatchObject({ offsiteStage: '', offsiteStageDetail: sr.NO_STATUS, offsiteStageSince: '' });
  });
});

// relay-extract AC41 (§11.1, §12.3 #10): the stage refresh keeps the case status history
// and recomputes the fact mirrors before its save.
describe('stage refresh keeps history (AC41)', () => {
  const woFacts = require('../src/repair-intel/wo-facts');
  // 27-entry 39582 shape (June prior episode, then Sept..Nov), served unsorted.
  const HISTORY = (() => {
    const out = [];
    for (let i = 0; i < 27; i++) {
      const d = i < 6 ? new Date(Date.UTC(2026, 5, 15 + i, 14)) : new Date(Date.UTC(2026, 8, 20 + (i - 6) * 2, 14));
      out.push({ stage: ['arrival', 'diagnosis', 'approval', 'repair'][i % 4], status: i % 3 ? 'Hold (parts)' : 'Working', at: d.toISOString() });
    }
    return out.reverse();
  })();
  const ST = { ok: true, stage: 'repair', status: 'Road Test', since: '2026-10-28T18:26:37-04:00', history: HISTORY };
  function withExtract(f, enabled, woFactsDep) {
    f.deps.loadExtract = () => ({ enabled, aiOutput: enabled });
    if (woFactsDep) f.deps.woFacts = woFactsDep;
    const saves = [];
    const save = f.deps.store.save;
    f.deps.store.save = (k, v) => { saves.push([k, JSON.parse(JSON.stringify(v))]); save(k, v); };
    return saves;
  }
  it('enabled: offsiteStageHistory written sorted (<= 80) on the same-WR row; a history-only change counts', async () => {
    const f = fakes({ '20945735': ST });
    withExtract(f, true);
    const res = await sr.refreshStages({ deps: f.deps });
    expect(res.changed).toBe(1);
    const h = f.data.fleetData.rows[0].offsiteStageHistory;
    expect(h).toHaveLength(27);
    expect(h.map((x) => Date.parse(x.at))).toEqual(h.map((x) => Date.parse(x.at)).sort((a, b) => a - b));
    sr._resetForTests();
    const res2 = await sr.refreshStages({ deps: f.deps, force: true });
    expect(res2.changed).toBe(0);                                   // same trio + same history
    f.deps.decisiv.getCaseStatusSummary = async (id) => (id === '20945735'
      ? Object.assign({}, ST, { history: HISTORY.concat([{ stage: 'repair', status: 'QC', at: '2026-11-11T14:00:00Z' }]) })
      : { ok: false });
    sr._resetForTests();
    const res3 = await sr.refreshStages({ deps: f.deps, force: true });
    expect(res3.changed).toBe(1);                                   // history-only change
  });
  it('enabled: the saved row deep-equals refreshRowFacts(row); refreshFleetFacts once, after applyStages, before the save', async () => {
    const f = fakes({ '20945735': ST });
    const order = [];
    const spy = { refreshFleetFacts: vi.fn((rows, flags, today) => { order.push('refresh:' + !!rows[0].offsiteStageHistory); return woFacts.refreshFleetFacts(rows, flags, today); }) };
    const saves = withExtract(f, true, spy);
    const save = f.deps.store.save;
    f.deps.store.save = (k, v) => { order.push('save:' + k); save(k, v); };
    await sr.refreshStages({ deps: f.deps });
    expect(spy.refreshFleetFacts).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh:true', 'save:fleetData']);
    const savedRow = saves.find((s) => s[0] === 'fleetData')[1].rows[0];
    const again = woFacts.refreshRowFacts(JSON.parse(JSON.stringify(savedRow)), { enabled: true, aiOutput: true });
    expect(savedRow).toEqual(JSON.parse(JSON.stringify(again)));
    expect(savedRow.offsiteStageHistory).toHaveLength(27);
  });
  it('disabled: saved rows byte-identical to today (no history key, no refresh)', async () => {
    const f = fakes({ '20945735': ST });
    const spy = { refreshFleetFacts: vi.fn() };
    const saves = withExtract(f, false, spy);
    await sr.refreshStages({ deps: f.deps });
    expect(spy.refreshFleetFacts).not.toHaveBeenCalled();
    const want = ROWS();
    Object.assign(want[0], { _stageReadAt: f.data.fleetData.rows[0]._stageReadAt, offsiteStage: 'repair', offsiteStageDetail: 'Road Test', offsiteStageSince: '2026-10-28T18:26:37-04:00' });
    expect(JSON.stringify(saves.find((s) => s[0] === 'fleetData')[1].rows)).toBe(JSON.stringify(want));
  });
  it('applyStages without a history array leaves offsiteStageHistory alone', () => {
    const rows = [{ equipmentId: 'A', _offsiteWrId: 'w', offsiteStageHistory: [{ stage: 'repair', status: 'x', at: '2026-11-01T00:00:00Z' }] }];
    sr.applyStages(rows, [{ equipmentId: 'A', wrId: 'w', stage: 'repair', status: 's', since: 't' }]);
    expect(rows[0].offsiteStageHistory).toHaveLength(1);
  });
});
