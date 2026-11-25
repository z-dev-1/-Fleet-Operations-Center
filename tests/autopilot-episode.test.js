// tests/autopilot-episode.test.js — Autopilot V2 AC-7 at the case-store level: WO-set and dealer-case
// merge, recurrence across verified resolutions and the in-case episode roll (design §5.4, §7.6).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TZ = 'America/New_York';

const F = require('./helpers/autopilot-fakes.cjs');
const { woSetOf } = require('../src/autopilot/constants');
const resolution = require('../src/autopilot/resolution');
const memory = require('../src/autopilot/memory');
const { cs, schema, T0, H, DAY } = F;

beforeEach(() => { F.freshDb('ep'); expect(schema.ensureSchema()).toBe(true); });

const row = (extra) => F.baseRow(extra);
const cand = (r, extra) => Object.assign({
  unitId: r.equipmentId, domicile: r.domicileSite, reasons: [{ code: 'OOS' }, { code: 'DWELL_EXCEEDED' }], openedBy: 'oos_rule',
  daysDown: 5, downSince: T0 - 5 * DAY, buildAtMs: T0 - H, woIds: woSetOf(r), equipmentClass: 'tractor',
  operator: r.operator, owner: r.owner, vendor: r.vendor, dealerCases: [],
}, extra || {});
const get = (id) => cs.getCase(id).case;
const events = (id, reason) => cs.getCase(id).events.filter((e) => e.reason_code === reason);
function toMonitoring(id, now) { cs.transition(id, 'INVESTIGATING', { now }); cs.transition(id, 'MONITORING', { now }); }
function resolve(id, now) {
  const r = resolution.verifyResolution(get(id), { equipmentId: '322283', lifecycleState: 'Active' }, { source: 'aap-api', buildAtMs: now }, now);
  cs.transition(id, 'RESOLVED', { resolution: r.token, now });
}

describe('WO set and dealer cases (AC-7)', () => {
  it('insert stores the V2 columns, episode key and the WO set with first-seen times', () => {
    const r = cs.upsertDetected(cand(row(), { dealerCases: ['DC-1', { id: 'EST-9', kind: 'decisiv' }], safety: true }), { now: T0 });
    const c = get(r.caseId);
    expect(c).toMatchObject({ equipment_class: 'tractor', operator: 'TUZR', owner: 'AZNG', vendor: 'Penske Truck Leasing', safety: 1, recurrence_count: 0, recurrence_of: null });
    expect(c.episode_opened_at).toBe(T0 - 5 * DAY);
    expect(c.episode_key).toBe('322283:2026-11-15');
    expect(c.wo_set).toEqual([
      { id: 'svc-1', role: 'primary', firstSeenAt: T0, lastSeenAt: T0 },
      { id: 'wr-1', role: 'alias', firstSeenAt: T0, lastSeenAt: T0 },
    ]);
    expect(c.dealer_cases.map((d) => d.id)).toEqual(['DC-1', 'EST-9']);
    expect(c.queued_since).toBe(T0);
  });

  it('a new WO joins the open case (first-seen kept, wo_joined event, no second case); dealer cases merge', () => {
    const r1 = cs.upsertDetected(cand(row(), { dealerCases: ['DC-1'] }), { now: T0 });
    const r2 = cs.upsertDetected(cand(row({ _secondaryWRs: [{ _serviceId: 'svc-2', workRequestId: 'wr-2' }] }), { dealerCases: ['DC-1', 'DC-2'] }), { now: T0 + H });
    expect(r2).toEqual({ caseId: r1.caseId, created: false, state: 'QUEUED' });
    expect(cs.listCases({}).total).toBe(1);
    const c = get(r1.caseId);
    expect(c.wo_set.find((w) => w.id === 'svc-1')).toEqual({ id: 'svc-1', role: 'primary', firstSeenAt: T0, lastSeenAt: T0 + H });
    expect(c.wo_set.find((w) => w.id === 'svc-2')).toMatchObject({ role: 'secondary', firstSeenAt: T0 + H });
    expect(c.wo_set.map((w) => w.id).sort()).toEqual(['svc-1', 'svc-2', 'wr-1', 'wr-2']);
    expect(c.dealer_cases.map((d) => [d.id, d.firstSeenAt, d.lastSeenAt])).toEqual([['DC-1', T0, T0 + H], ['DC-2', T0 + H, T0 + H]]);
    const ev = events(r1.caseId, 'wo_joined');
    expect(ev.length).toBe(1);
    expect(ev[0].detail).toEqual({ added: 2, total: 4 });
    cs.upsertDetected(cand(row()), { now: T0 + 2 * H });
    expect(events(r1.caseId, 'wo_joined').length).toBe(1);
  });

  it('keeps at most 50 WO ids and 30 dealer cases, dropping the oldest first', () => {
    const r1 = cs.upsertDetected(cand(row()), { now: T0 });
    for (let i = 0; i < 60; i++) cs.upsertDetected(cand(row(), { woIds: { primary: 'svc-1', secondary: ['x' + i] }, dealerCases: ['D' + i] }), { now: T0 + (i + 1) * 1000 });
    const c = get(r1.caseId);
    expect(c.wo_set.length).toBe(50);
    expect(c.wo_set.some((w) => w.id === 'x59')).toBe(true);
    expect(c.wo_set.some((w) => w.id === 'wr-1')).toBe(false);
    expect(c.dealer_cases.length).toBe(30);
    expect(c.dealer_cases[0].id).toBe('D30');
  });

  it('hold keeps a new case DETECTED', () => {
    expect(cs.upsertDetected(cand(row()), { now: T0, hold: true }).state).toBe('DETECTED');
  });
});

describe('recurrence across verified resolutions (AC-7)', () => {
  it('a new case after a verified RESOLVED gets prior_case_id; recurrence_of within 90 days only', () => {
    const a = cs.upsertDetected(cand(row()), { now: T0 }).caseId;
    toMonitoring(a, T0);
    resolve(a, T0 + H);
    const b = cs.upsertDetected(cand(row()), { now: T0 + 10 * DAY }).caseId;
    expect(b).not.toBe(a);
    expect(get(b)).toMatchObject({ prior_case_id: a, recurrence_of: a, recurrence_count: 1 });
    toMonitoring(b, T0 + 10 * DAY);
    resolve(b, T0 + 11 * DAY);
    const c = cs.upsertDetected(cand(row()), { now: T0 + 11 * DAY + 90 * DAY + 1 }).caseId;
    expect(get(c)).toMatchObject({ prior_case_id: b, recurrence_of: null, recurrence_count: 0 });
    toMonitoring(c, T0 + 102 * DAY);
    resolve(c, T0 + 103 * DAY);
    const d = cs.upsertDetected(cand(row()), { now: T0 + 103 * DAY + 90 * DAY }).caseId;
    expect(get(d)).toMatchObject({ prior_case_id: c, recurrence_of: c, recurrence_count: 1 });
  });
});

describe('episode roll inside the open case (AC-7, FR-6.5)', () => {
  function setup() {
    const id = cs.upsertDetected(cand(row()), { now: T0 }).caseId;
    toMonitoring(id, T0);
    const mem = memory.conclude(memory.init(get(id), null), { output: { summary: 'Waiting on parts.', confirmedFacts: [], inferences: [] }, runId: 'run_1', at: T0 });
    cs.lease(id, 'p#1', T0 + H, { now: T0 });
    cs.writeMemory(id, mem, { leaseOwner: 'p#1', now: T0 });
    cs.persistRun(id, null, { lease_owner: null, lease_until: null }, null, { now: T0 });
    // An unverified up sighting: the unit is seen not down in a later build (no RESOLVED: scrape source).
    cs.sweepResolution({ rowsByUnit: new Map([['322283', row({ lifecycleState: 'Active', _apiSourced: false })]]), fleetMeta: { source: 'scrape', buildAtMs: T0 + 2 * H }, now: T0 + 2 * H });
    expect(get(id).state).not.toBe('RESOLVED');
    const c = get(id);
    expect(c.last_up_seen_build_at).toBe(T0 + 2 * H);
    if (c.state === 'NEEDS_REVIEW') cs.review(id, 'accept', { now: T0 + 2 * H + 1 });
    return id;
  }

  it('down again with a new primary WO -> same case, new episode, WO set restarted, recurrence_count + 1, requeued new_episode', () => {
    const id = setup();
    const before = get(id);
    const r = cs.upsertDetected(cand(row({ _serviceId: 'svc-9', workRequestId: 'wr-9' }), { downSince: T0 + 3 * DAY, dealerCases: ['DC-NEW'] }), { now: T0 + 3 * DAY });
    expect(r).toEqual({ caseId: id, created: false, state: 'QUEUED', rolled: true });
    const c = get(id);
    expect(c.case_id).toBe(id);
    expect(c.episode_key).toBe('322283:2026-11-23');
    expect(c.episode_key).not.toBe(before.episode_key);
    expect(c.episode_opened_at).toBe(T0 + 3 * DAY);
    expect(c.wo_set.map((w) => w.id)).toEqual(['svc-9', 'wr-9']);
    expect(c.dealer_cases.map((d) => d.id)).toEqual(['DC-NEW']);
    expect(c.recurrence_count).toBe(before.recurrence_count + 1);
    expect(c.last_up_seen_build_at).toBe(null);
    expect(c.slice_fps).toBe(null);
    expect(c.ai_fp).toBe(null);
    expect(c.memory.priorEpisodes.length).toBe(1);
    expect(c.memory.priorEpisodes[0]).toMatchObject({ key: before.episode_key, woIds: ['svc-1', 'wr-1'] });
    expect(c.memory.priorEpisodes[0].conclusion.summary).toBe('Waiting on parts.');
    expect(c.memory.priorConclusions).toEqual([]);
    expect(c.memory.episode.key).toBe('322283:2026-11-23');
    expect(events(id, 'episode_rolled').length).toBe(1);
    const tr = cs.getCase(id).events.filter((e) => e.kind === 'transition').pop();
    expect(tr).toMatchObject({ to_state: 'QUEUED', reason_code: 'new_episode' });
    expect(cs.listCases({}).total).toBe(1);
  });

  it('down again with the same primary WO -> no roll', () => {
    const id = setup();
    const before = get(id);
    const r = cs.upsertDetected(cand(row()), { now: T0 + 3 * DAY });
    expect(r).toEqual({ caseId: id, created: false, state: before.state });
    expect(get(id).episode_key).toBe(before.episode_key);
    expect(events(id, 'episode_rolled').length).toBe(0);
  });

  it('a workRequestId-only row of the same WO does not roll', () => {
    const id = setup();
    const r = cs.upsertDetected(cand(row({ _serviceId: undefined, workRequestId: 'wr-1' })), { now: T0 + 3 * DAY });
    expect(r.rolled).toBeUndefined();
    expect(events(id, 'episode_rolled').length).toBe(0);
  });

  it('no roll without an up sighting after the episode opened', () => {
    const id = cs.upsertDetected(cand(row()), { now: T0 }).caseId;
    toMonitoring(id, T0);
    const r = cs.upsertDetected(cand(row({ _serviceId: 'svc-9', workRequestId: 'wr-9' })), { now: T0 + DAY });
    expect(r.rolled).toBeUndefined();
    expect(get(id).wo_set.map((w) => w.id)).toEqual(['svc-1', 'wr-1', 'svc-9', 'wr-9']);
    expect(events(id, 'wo_joined').length).toBe(1);
  });

  it('no roll while a run is active (INVESTIGATING)', () => {
    const id = setup();
    cs.review(id, 'rerun', { now: T0 + 3 * H });
    cs.transition(id, 'INVESTIGATING', { now: T0 + 3 * H });
    expect(cs.upsertDetected(cand(row({ _serviceId: 'svc-9', workRequestId: 'wr-9' })), { now: T0 + DAY }).rolled).toBeUndefined();
    expect(events(id, 'episode_rolled').length).toBe(0);
  });
});

describe('controller level (AC-7, §4.4 step 7)', () => {
  const { MIN } = F;
  const mk = (w) => F.mkEnv({ world: w || F.mkWorld({ rows: [row({ _secondaryWRs: [{ _serviceId: 'svc-2', workRequestId: 'wr-2' }] })] }), autopilot: { scope: { mode: 'fleet' } } });

  it('multiple WOs of one down unit correlate to one case and one episode', async () => {
    const env = mk();
    await env.ctl.runOnce({ forceDetect: true });
    const open = cs.listOpen();
    expect(open.length).toBe(1);
    const id = open[0].case_id;
    const key = open[0].episode_key;
    expect(open[0].wo_set.map((w) => w.id).sort()).toEqual(['svc-1', 'svc-2', 'wr-1', 'wr-2']);
    env.world.rows[0]._secondaryWRs.push({ _serviceId: 'svc-3' });
    env.clock.advance(MIN);
    await env.ctl.runOnce({ forceDetect: true });
    const after = cs.listOpen();
    expect(after.length).toBe(1);
    expect(after[0]).toMatchObject({ case_id: id, episode_key: key });
    expect(after[0].wo_set.map((w) => w.id)).toContain('svc-3');
  });

  it('down again with a new primary WO after an unverified up sighting -> rolled, requeued and run with trigger new_episode', async () => {
    const env = mk(F.mkWorld());
    await env.ctl.runOnce({ forceDetect: true });
    const id = cs.listOpen()[0].case_id;
    const key = get(id).episode_key;
    // Seen up in a newer scrape build: no verified resolution, the case stays open.
    Object.assign(env.world.rows[0], { lifecycleState: 'Active', _apiSourced: false });
    env.world.source = 'scrape';
    env.clock.advance(5 * MIN);
    env.world.lastOkAt = env.clock.now();
    await env.ctl.runOnce({ forceDetect: true });
    expect(get(id).state).not.toBe('RESOLVED');
    expect(get(id).last_up_seen_build_at).toBe(env.clock.now());
    // Down again with a new WO in a newer aap-api build.
    Object.assign(env.world.rows[0], { lifecycleState: 'Unavailable', _apiSourced: true, _serviceId: 'svc-9', workRequestId: 'wr-9', workDuration: '3d 6h 0m' });
    env.world.source = 'aap-api';
    env.clock.advance(5 * MIN);
    env.world.lastOkAt = env.clock.now();
    const r = await env.ctl.runOnce({ forceDetect: true });
    expect(cs.listOpen().length).toBe(1);
    const c = get(id);
    expect(c.episode_key).not.toBe(key);
    expect(c.wo_set.map((w) => w.id)).toEqual(['svc-9', 'wr-9']);
    expect(events(id, 'episode_rolled').length).toBe(1);
    expect(r.investigated.map((x) => x.caseId)).toEqual([id]);
    expect(cs.getCase(id).runs[0].trigger).toBe('new_episode');
  });
});