import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TZ = 'America/New_York';

const { fp, cheapFp } = require('../src/autopilot/fingerprint');
const { score, strongestReason, compareCases } = require('../src/autopilot/priority');
const { dueTriggers, autoRunStats, shouldEvalCheapFp } = require('../src/autopilot/triggers');
const { newestVendorUpdate, newestLiveComment } = require('../src/autopilot/updates');

const MIN = 60000;
const H = 60 * MIN;
const NOW = new Date(2026, 10, 10, 12, 0).getTime();

describe('fingerprint', () => {
  const items = [
    { source: 'aap_cache', sourceRef: 'WR1', field: 'lifecycleState', value: 'Unavailable', observedAt: 1, retrievedAt: 5, freshness: 'RECENT', confidence: 0.9 },
    { source: 'decisiv', sourceRef: 'E1', field: 'stage', value: 'repair', observedAt: 2, retrievedAt: 5, freshness: 'RECENT', confidence: 0.65 },
  ];
  it('is stable under retrievedAt, freshness, confidence and order changes', () => {
    const a = fp({ items });
    const b = fp({ items: items.slice().reverse().map((x) => Object.assign({}, x, { retrievedAt: 999, freshness: 'STALE', confidence: 0.1 })) });
    expect(b).toBe(a);
    expect(fp({ items: [items[0], Object.assign({}, items[1], { value: 'ready' })] })).not.toBe(a);
    expect(fp({ items: [items[0], Object.assign({}, items[1], { observedAt: 3 })] })).not.toBe(a);
    expect(fp({ items: [] })).toBe(fp(null));
  });

  it('cheapFp changes on a watched-key entry for the unit and on a new repair-intel event, not on other units', () => {
    const row = { equipmentId: 'B13014', lifecycleState: 'Unavailable', repairEtc: '2026-11-12' };
    const base = { row, slices: { dtna: [{ caseId: 'C1', offsiteStage: 'repair' }], email: null }, aperiaIssues: [], riSummary: { count: 2, maxReportedAt: 10 } };
    const a = cheapFp(base);
    expect(cheapFp(JSON.parse(JSON.stringify(base)))).toBe(a);
    expect(cheapFp(Object.assign({}, base, { slices: { dtna: [{ caseId: 'C1', offsiteStage: 'ready' }], email: null } }))).not.toBe(a);
    expect(cheapFp(Object.assign({}, base, { riSummary: { count: 3, maxReportedAt: 11 } }))).not.toBe(a);
    // Other units' entries never enter this unit's input; unrelated row fields are ignored.
    expect(cheapFp(Object.assign({}, base, { row: Object.assign({}, row, { _convFetchedAt: 'now', someUiField: 1 }) }))).toBe(a);
    expect(cheapFp(Object.assign({}, base, { row: Object.assign({}, row, { repairEtc: '2026-11-13' }) }))).not.toBe(a);
  });

  it('two AAP builds with the same underlying evidence -> same fp and cheapFp (fallback observedAt, workDuration)', () => {
    const build = (buildAt, wd) => [
      { source: 'aap_cache', sourceRef: 'row/lifecycleState', field: 'lifecycleState', value: 'Unavailable', observedAt: buildAt, observedFrom: 'buildAt' },
      { source: 'aap_cache', sourceRef: 'row/workDuration', field: 'workDuration', value: wd, observedAt: buildAt, observedFrom: 'buildAt' },
      { source: 'aap_cache', sourceRef: 'row/vendor', field: 'vendor', value: 'Penske', observedAt: buildAt + 5, observedFrom: 'syncedAt' },
      { source: 'aap_live', sourceRef: 'aap/wr-1', field: 'lifecycleState', value: 'Unavailable', observedAt: buildAt + 9, observedFrom: 'retrievedAt', live: true },
      { source: 'aap_cache', sourceRef: 'row/offsiteStage', field: 'offsiteStage', value: 'repair', observedAt: 100, observedFrom: 'offsiteStageSince' },
    ];
    const a = fp({ items: build(1000, '5d 2h 0m') });
    expect(fp({ items: build(1000 + 4 * H, '5d 6h 0m') })).toBe(a);
    // A source-stated time and a real value change still change the fingerprint.
    const b = build(1000, '5d 2h 0m');
    b[4] = Object.assign({}, b[4], { observedAt: 200 });
    expect(fp({ items: b })).not.toBe(a);
    const c = build(1000, '5d 2h 0m');
    c[0] = Object.assign({}, c[0], { value: 'Active' });
    expect(fp({ items: c })).not.toBe(a);

    const row = { equipmentId: '322283', lifecycleState: 'Unavailable', workDuration: '5d 2h 0m', created: '2026-11-15T10:00:00Z', canonicalConflictCount: 0 };
    const input = (r) => ({ row: r, slices: {}, aperiaIssues: null, riSummary: null });
    expect(cheapFp(input(Object.assign({}, row, { workDuration: '5d 6h 0m' })))).toBe(cheapFp(input(row)));
    expect(cheapFp(input(Object.assign({}, row, { canonicalConflictCount: 1 })))).not.toBe(cheapFp(input(row)));
  });

  it('cheap fp is evaluated on the first tick after restart even with zero generations', () => {
    expect(shouldEvalCheapFp({ evaluatedOnce: false, gens: { fleetData: 0 }, prevGens: { fleetData: 0 }, now: NOW })).toBe(true);
    expect(shouldEvalCheapFp({ evaluatedOnce: true, gens: { fleetData: 0 }, prevGens: { fleetData: 0 }, lastEvalAt: NOW - MIN, now: NOW })).toBe(false);
    expect(shouldEvalCheapFp({ evaluatedOnce: true, gens: { fleetData: 1 }, prevGens: { fleetData: 0 }, lastEvalAt: NOW - MIN, now: NOW })).toBe(true);
    expect(shouldEvalCheapFp({ evaluatedOnce: true, gens: {}, prevGens: {}, lastEvalAt: NOW - 31 * MIN, now: NOW })).toBe(true);
  });
});

describe('priority', () => {
  it('base by strongest reason plus days down, never-investigated and trigger boosts; clamped 0..100', () => {
    expect(strongestReason([{ code: 'OOS' }, { code: 'DWELL_EXCEEDED' }, { code: 'REPAIRED_UNVERIFIED' }])).toBe('REPAIRED_UNVERIFIED');
    expect(score({ reasons: ['OOS'] })).toBe(10);
    expect(score({ reasons: ['ETA_OVERDUE_VERIFIED'], daysDown: 9, neverInvestigated: true, trigger: 'eta_due' })).toBe(35 + 4 + 10 + 10);
    expect(score({ reasons: ['REPAIRED_UNVERIFIED'], daysDown: 200, neverInvestigated: true, trigger: 'evidence_changed', aiUrgency: 'high' })).toBe(100);
    expect(score({ reasons: ['DWELL_EXCEEDED'], aiUrgency: 'high', aiInvestigation: false })).toBe(20);
    expect(score({ reasons: ['DWELL_EXCEEDED'], aiUrgency: 'low' })).toBe(15);
    expect(score({ reasons: ['OOS'], state: 'MONITORING', unchanged: true })).toBe(0);
    expect(score({})).toBe(0);
  });

  it('orders by priority DESC then state_changed_at ASC', () => {
    const list = [{ id: 'a', priority: 10, state_changed_at: 5 }, { id: 'b', priority: 30, state_changed_at: 9 }, { id: 'c', priority: 10, state_changed_at: 1 }];
    expect(list.sort(compareCases).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('priority.scoreV2 bands (AC-16, V2 §8.3)', () => {
  const { scoreV2 } = require('../src/autopilot/priority');
  const MAX_MODS = { daysDown: 400, neverInvestigated: true, recurrenceCount: 2, aiUrgency: 'high' };
  const MIN_MODS = { aiUrgency: 'low', state: 'MONITORING', unchanged: true };

  it('band floors and exact modifier sums', () => {
    expect(scoreV2({ reasons: ['OOS'] })).toBe(10);
    expect(scoreV2({ reasons: ['SAFETY_CRITICAL'] })).toBe(80);
    expect(scoreV2({ reasons: ['OOS'], safety: 1 })).toBe(80);
    expect(scoreV2({ reasons: ['REPAIRED_UNVERIFIED'] })).toBe(60);
    expect(scoreV2({ reasons: ['ETA_OVERDUE_VERIFIED'] })).toBe(57);
    expect(scoreV2({ reasons: ['REPAIRED_UNVERIFIED', 'ETA_OVERDUE_VERIFIED'] })).toBe(60);
    // other band: 10 + 5 (days) + 10 (stale) + 8 (repeat) + 6 (conflict) + 4 (new) + 6 (AI high) = 49
    expect(scoreV2({ reasons: ['OOS', 'UPDATE_STALE', 'STATUS_CONFLICT'], daysDown: 5.9, recurrenceOf: 'c0', neverInvestigated: true, aiUrgency: 'high' })).toBe(49);
    expect(scoreV2({ reasons: ['OOS'], aiUrgency: 'high', aiInvestigation: false })).toBe(10);
  });

  it('bands never overlap: safety 80..100 > operational 55..79 > other 10..54', () => {
    const top = (codes) => scoreV2(Object.assign({ reasons: codes.concat(['UPDATE_STALE', 'STATUS_CONFLICT']) }, MAX_MODS));
    const low = (codes) => scoreV2(Object.assign({ reasons: codes }, MIN_MODS));
    expect(top(['OOS'])).toBe(54);
    expect(low(['OOS'])).toBe(10);
    expect(top(['ETA_OVERDUE_VERIFIED'])).toBe(79);
    expect(low(['ETA_OVERDUE_VERIFIED'])).toBe(55);
    expect(top(['REPAIRED_UNVERIFIED'])).toBe(79);
    expect(low(['REPAIRED_UNVERIFIED'])).toBe(55);
    expect(top(['SAFETY_CRITICAL'])).toBe(100);
    expect(low(['SAFETY_CRITICAL'])).toBe(80);
  });

  it('deep -> at least 95; no trigger boost', () => {
    expect(scoreV2({ reasons: ['OOS'], deep: true })).toBe(95);
    expect(scoreV2(Object.assign({ reasons: ['SAFETY_CRITICAL', 'UPDATE_STALE'], deep: true }, MAX_MODS))).toBe(100);
    expect(scoreV2({ reasons: ['OOS'], trigger: 'evidence_changed' })).toBe(scoreV2({ reasons: ['OOS'] }));
    expect(scoreV2({})).toBe(10);
  });
});

describe('triggers', () => {
  const base = (o) => Object.assign({ case_id: 'c1', state: 'MONITORING', cheap_fp: 'fp0', next_review_at: NOW + H, next_attempt_at: null, eta_json: null }, o);
  const run = (trigger, at) => ({ trigger, started_at: at });
  const due = (c, ctx, now) => dueTriggers([c], now || NOW, Object.assign({ authState: { midway: 'HEALTHY' } }, ctx || {}));

  it('evidence_changed when the cheap fp differs, for every watched state incl. AUTH_REQUIRED and FAILED', () => {
    for (const st of ['MONITORING', 'RECOMMENDATION_READY', 'WAITING_FOR_DATA', 'AUTH_REQUIRED', 'FAILED']) {
      expect(due(base({ state: st }), { cheapFps: { c1: 'fp1' }, authState: { midway: 'WAITING_FOR_USER' } }), st).toEqual([{ caseId: 'c1', trigger: 'evidence_changed' }]);
    }
    expect(due(base(), { cheapFps: new Map([['c1', 'fp0']]) })).toEqual([]);
    expect(due(base({ state: 'QUEUED' }), { cheapFps: { c1: 'fp1' } })).toEqual([]);
    expect(due(base({ state: 'NEEDS_REVIEW' }), { cheapFps: { c1: 'fp1' } })).toEqual([]);
  });

  it('eta_due once per date with a local-midnight boundary', () => {
    const c = base({ eta_json: JSON.stringify({ status: 'FUTURE', date: '2026-11-11' }) });
    const before = new Date(2026, 10, 10, 23, 59).getTime();
    const after = new Date(2026, 10, 11, 0, 1).getTime();
    expect(due(Object.assign({}, c, { next_review_at: after + H }), {}, before)).toEqual([]);
    expect(due(Object.assign({}, c, { next_review_at: after + H }), {}, after)).toEqual([{ caseId: 'c1', trigger: 'eta_due', date: '2026-11-11' }]);
    expect(due(Object.assign({}, c, { next_review_at: after + H }), { etaFired: new Set(['c1|2026-11-11']) }, after)).toEqual([]);
    expect(due(base({ eta: { status: 'TODAY', date: '2026-11-10' } }))).toEqual([{ caseId: 'c1', trigger: 'eta_due', date: '2026-11-10' }]);
  });

  it('scheduled when next_review_at has passed', () => {
    expect(due(base({ next_review_at: NOW - 1 }))).toEqual([{ caseId: 'c1', trigger: 'scheduled' }]);
    expect(due(base({ next_review_at: NOW + 1 }))).toEqual([]);
  });

  it('auth_restored when midway leaves AUTH_DOWN (UNKNOWN, DEGRADED, HEALTHY), not while it stays down', () => {
    const c = base({ state: 'AUTH_REQUIRED', next_review_at: null });
    for (const m of ['UNKNOWN', 'DEGRADED', 'HEALTHY']) expect(due(c, { authState: { midway: m } }), m).toEqual([{ caseId: 'c1', trigger: 'auth_restored' }]);
    for (const m of ['WAITING_FOR_USER', 'OFFLINE', 'COOLDOWN', 'RECOVERING', 'FAILED']) expect(due(c, { authState: { midway: m } }), m).toEqual([]);
  });

  it('retry_due for AUTH_REQUIRED and WAITING_FOR_DATA at next_attempt_at', () => {
    const down = { authState: { midway: 'WAITING_FOR_USER' } };
    expect(due(base({ state: 'AUTH_REQUIRED', next_review_at: null, next_attempt_at: NOW - 1 }), down)).toEqual([{ caseId: 'c1', trigger: 'retry_due' }]);
    expect(due(base({ state: 'WAITING_FOR_DATA', next_review_at: null, next_attempt_at: NOW }))).toEqual([{ caseId: 'c1', trigger: 'retry_due' }]);
    expect(due(base({ state: 'WAITING_FOR_DATA', next_review_at: null, next_attempt_at: NOW + 1 }))).toEqual([]);
    expect(due(base({ state: 'MONITORING', next_review_at: null, next_attempt_at: NOW - 1 }))).toEqual([]);
  });

  it('30-minute spacing and 6 automatic runs per local day; harness and manual runs are exempt', () => {
    const c = base({ next_review_at: NOW - 1 });
    expect(due(c, { runs: { c1: [run('scheduled', NOW - 29 * MIN)] } })).toEqual([]);
    expect(due(c, { runs: { c1: [run('scheduled', NOW - 31 * MIN)] } })).toEqual([{ caseId: 'c1', trigger: 'scheduled' }]);
    const six = [0, 1, 2, 3, 4, 5].map((i) => run('scheduled', NOW - (i + 1) * H));
    expect(due(c, { runs: { c1: six } })).toEqual([]);
    const fiveAuto = six.slice(0, 5).concat([run('harness', NOW - 5 * MIN), run('manual', NOW - 6 * MIN), run('harness', NOW - 7 * MIN)]);
    expect(due(c, { runs: new Map([['c1', fiveAuto]]) })).toEqual([{ caseId: 'c1', trigger: 'scheduled' }]);
    const yesterday = six.map((r) => run('scheduled', r.started_at - 24 * H));
    expect(due(c, { runs: { c1: yesterday } })).toEqual([{ caseId: 'c1', trigger: 'scheduled' }]);
    expect(autoRunStats(fiveAuto, NOW)).toEqual({ lastAutoAt: NOW - H, autoToday: 5 });
  });
});

describe('updates', () => {
  it('vendor update counts vendor platforms only; live comments use the max timestamp', () => {
    const items = [
      { source: 'dtna', field: 'lastCommentAt', observedAt: 100 },
      { source: 'decisiv', field: 'stage', observedAt: 300 },
      { source: 'aap_live', field: 'comment', observedAt: 900 },
      { source: 'aap_cache', field: 'offsiteStage', observedAt: 800, observedFrom: 'buildAt' },
    ];
    expect(newestVendorUpdate(items)).toEqual({ at: 300, source: 'decisiv' });
    expect(newestVendorUpdate(items.concat([{ source: 'aap_cache', field: 'offsiteStage', observedAt: 500, observedFrom: 'offsiteStageSince' }]))).toEqual({ at: 500, source: 'aap_cache' });
    expect(newestLiveComment([{ timestamp: '2026-11-01T00:00:00Z' }, { timestamp: '2026-11-03T00:00:00Z' }, {}])).toBe(Date.parse('2026-11-03T00:00:00Z'));
    expect(newestVendorUpdate([])).toBe(null);
  });
});

describe('require boundary of the FEAT-001 modules', () => {
  it('requires only ./*, crypto, ../store/sqlite_engine (schema, case-store), ../store (config), ../ai/authority, ../email-intel/untrusted', () => {
    const dir = path.dirname(require.resolve('../src/autopilot/constants.js'));
    const files = ['constants', 'config', 'lifecycle', 'schema', 'resolution', 'case-store', 'scope', 'detect', 'classify', 'provenance', 'freshness', 'conflicts', 'updates', 'fingerprint', 'priority', 'triggers'];
    const base = new Set(['crypto', '../ai/authority', '../email-intel/untrusted']);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f + '.js'), 'utf8');
      const reqs = (src.match(/require\(\s*['"]([^'"]+)['"]\s*\)/g) || []).map((r) => /['"]([^'"]+)['"]/.exec(r)[1]);
      for (const r of reqs) {
        const ok = r.startsWith('./') || base.has(r)
          || (r === '../store/sqlite_engine' && (f === 'schema' || f === 'case-store'))
          || (r === '../store' && f === 'config')
          // V2: authorizedTokens fallback (design-review finding 9) and the §5.3 backup timing log.
          || (r === '../config/defaults' && f === 'config')
          || (r === '../utils/logger' && f === 'schema');
        expect(ok, f + ' requires ' + r).toBe(true);
      }
      expect(/aperia:[a-z]/.test(src), f + ' contains aperia:<letter>').toBe(false);
    }
    const cfg = fs.readFileSync(path.join(dir, 'config.js'), 'utf8');
    const keys = (cfg.match(/\.(load|save|update|updateAsync)\(\s*['"]([^'"]+)['"]/g) || []).map((m) => /['"]([^'"]+)['"]/.exec(m)[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(['settings']));
  });
});
