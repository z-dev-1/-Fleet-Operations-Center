// tests/health-snapshot.test.js — src/health/snapshot.js buildSnapshot()
// (Phase 6 Worker Health). Every source is an injected fake; `now` is
// injected; _resetForTests() clears the memos + failure map.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const health = require('../src/health/snapshot');

const T = 1730000000000;
const SECTIONS = ['workers', 'ai', 'auth', 'slack', 'scheduler', 'resources'];
const WORKER_KEYS = [
  'name', 'group', 'label', 'state', 'waitingOn', 'disabledReason', 'breakerState',
  'lastHeartbeatAt', 'lastStartAt', 'lastEndAt', 'lastDurationMs', 'currentJob',
  'counts', 'skipReasons', 'consecutiveFailures', 'lastError',
  'restarts', 'maxRestarts', 'isolations', 'isolationReason', 'isolatedUntil', 'notified',
  'nextRunAt', 'intervalMs', 'timeoutMs', 'maxFailures', 'cooldownMs', 'dependsOn', 'idempotent', 'owner',
].sort();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function worker(name, extra) {
  return Object.assign({
    name, group: 'test', label: 'Worker ' + name, state: 'waiting', waitingOn: ['auth'], disabledReason: null,
    breakerState: 'ok', lastHeartbeatAt: T - 5000, lastStartAt: T - 6000, lastEndAt: T - 5000, lastDurationMs: 1000,
    currentJob: null, counts: { runs: 3, ok: 2, fail: 1, skip: 4, timeout: 0 },
    skipReasons: { busy: 0, self: 0, dependency: { auth: 4 } }, consecutiveFailures: 0,
    lastError: { message: 'boom', at: T - 60000, kind: 'throw' }, restarts: 0, maxRestarts: 3, isolations: 0,
    isolationReason: null, isolatedUntil: null, notified: false, nextRunAt: T + 60000, intervalMs: 60000,
    timeoutMs: 10000, maxFailures: 3, cooldownMs: 1800000, dependsOn: ['auth'], idempotent: true, owner: 'supervisor',
  }, extra || {});
}

function job(i, state) {
  return {
    jobId: 'job_' + i, channel: 'email', slotLabel: '07:30', dateKey: '2026-03-02', state, updatedAt: '2026-03-02T07:31:00Z',
    intendedRecipients: ['someone@example.com'], actualRecipients: ['someone@example.com'],
    history: [{ at: 'x', from: 'a', to: 'b', note: 'n' }], lastError: { at: 'x', class: 'auth', message: 'auth failed' },
  };
}

function channel(over) {
  return Object.assign({
    lastVerified: job(1, 'completed'), lastFailure: job(2, 'failed'), active: [], blockedAuth: [], blockedStale: [],
    uncertain: [], retrying: [],
  }, over || {});
}

function mkDeps(over) {
  const calls = { sched: 0, ai: 0, sup: 0, relay: 0, poller: 0, mw: 0, tel: 0 };
  let now = T;
  const deps = {
    now: () => now,
    logger: quiet,
    supervisor: {
      getStatus: () => { calls.sup++; return { enabled: true, initializedAt: T - 1e6, shuttingDown: false, at: T, process: null, workers: [worker('alpha'), worker('beta', { state: 'healthy', waitingOn: null })] }; },
      getSummary: () => ({ enabled: true, count: 2, byState: { healthy: 1, busy: 0, waiting: 1, degraded: 0, isolated: 0, disabled: 0 }, isolated: [], waiting: [{ name: 'alpha', on: ['auth'] }], fails: 1, lastErrorAt: T - 60000 }),
    },
    relay: {
      queueStats: () => { calls.relay++; return {
        active: 1, waiting: 2, max: 4, reserve: 1,
        byPriority: { critical: { active: 1, waiting: 0 }, high: { active: 0, waiting: 1 }, normal: { active: 0, waiting: 1 }, low: { active: 0, waiting: 0 } },
        oldestWaitMs: 1500, inflightDedupe: 0,
        flags: { priorities: true, abortOnTimeout: false, dedupe: true, routerDecides: false },
        claudePool: { size: 2, busy: 1, queued: 0, queuedByPriority: { critical: 0, high: 0, normal: 0, low: 0, none: 0 } },
      }; },
    },
    aiStatus: {
      snapshot: () => { calls.ai++; return {
        at: '2026-03-02T12:00:00Z',
        lanes: { fleetBrain: { status: 'up', ready: true }, orcha: { status: 'up' }, claude: { status: 'down' }, bedrock: { status: 'fallback' } },
        overall: { status: 'up', reasons: ['one AI lane unavailable'] },
        gateway: {
          sampleSize: 10,
          byPriority: { normal: { count: 10, ok: 9, timeout: 1, aborted: 0, error: 0, deduped: 0, p50LatencyMs: 800, p95LatencyMs: 2400, p95QueueWaitMs: 50 } },
          bySource: { 'slack-dm': { count: 10, timeout: 1, error: 0, p95LatencyMs: 2400 } },
        },
      }; },
    },
    midway: {
      getState: () => { calls.mw++; return 'HEALTHY'; },
      getSnapshot: () => ({
        state: 'HEALTHY', at: '2026-03-02T11:59:00Z', internet: { online: true }, vpn: { connected: true, required: false },
        diskSession: { present: true, expiresInMin: 300 }, diskAea: { present: true, expiresInMin: 120 },
        aapApiSmokeTest: { ok: true }, aapProbe: { ok: true }, lastRecovery: { at: 'x' }, nextRetryAt: 12345,
      }),
    },
    aeaKeepalive: {
      getState: () => ({ running: true, state: 'HEALTHY', last: { ok: true, reason: 'refreshed', aeaMin: 100, tokenMin: 50, at: T - 1000 }, consecutiveFailures: 0 }),
    },
    poller: {
      getStatus: () => { calls.poller++; return {
        mode: 'on', configuredMode: 'on', startedAt: T - 1e6, startError: null, flags: { mainProcessPolling: 'on' },
        polls: {
          dm: { intervalMs: 30000, inFlight: false, stalled: false, lastStartAt: T - 2000, lastEndAt: T - 1000, lastDurationMs: 1000, nextRunAt: T + 29000, runs: 10, fails: 1, lastError: 'x', lastResult: { messages: ['secret body'] }, skipped: { coalesced: 2, busy: 0, standby: 0, notAuthed: 0 }, shadow: {}, renderer: {} },
        },
        owaTriage: { recipients: ['someone@example.com'] },
        speedup: { lane: { active: 1, label: 'drop-me' }, dm: { hits: 3 }, channel: { hits: 4 } },
      }; },
    },
    scheduler: {
      getState: () => { calls.sched++; return {
        now: 'x', enabled: { sp: true, email: true, dbr: false },
        nextSlot: { sp: { label: '08:00', when: 'today' }, email: { label: '07:30', when: 'next-weekday' }, dbr: null },
        sharepoint: channel(), email: channel(), dbrAfp: channel(), dbrDsp: channel(),
        jobsToday: [job(9, 'completed')],
      }; },
    },
    telemetry: {
      latestSample: () => { calls.tel++; return {
        seq: 1, at: T - 2000, eventLoop: { p50Ms: 10, p99Ms: 40, maxMs: 90, meanMs: 12 },
        memory: { rssMb: 300, heapUsedMb: 120, heapTotalMb: 150 },
        processes: [
          { type: 'Browser', pid: 11, name: 'main', cpuPct: 5, workingSetMb: 200 },
          { type: 'Tab', pid: 12, name: 'renderer', cpuPct: 3, workingSetMb: 150 },
          { type: 'Tab', pid: 13, name: 'aap', cpuPct: 1, workingSetMb: 100 },
          { type: 'GPU', pid: 14, name: 'gpu', cpuPct: 2, workingSetMb: 50 },
        ],
        totals: { count: 4, workingSetMb: 500, privateMb: 400, cpuPct: 11 },
        windows: { total: 3, visible: 1, hidden: 2 },
      }; },
      snapshot: () => ({
        tracks: Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['track' + i, { count: 5, ok: 5, fail: 0, p95Ms: i * 10, maxMs: i * 20, lastError: 'x' }])),
        recent: [{ name: 'track1', ms: 5 }],
      }),
    },
  };
  Object.assign(deps, over || {});
  return { deps, calls, setNow: (n) => { now = n; } };
}

function walkKeys(o, out = new Set()) {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) { out.add(k); walkKeys(o[k], out); }
  }
  return out;
}

beforeEach(() => { health._resetForTests(); });

describe('health snapshot — shape', () => {
  it('all sections ok, exact top-level keys', () => {
    const { deps } = mkDeps();
    const s = health.buildSnapshot(deps);
    expect(Object.keys(s).sort()).toEqual(['ai', 'at', 'auth', 'jobs', 'ok', 'resources', 'scheduler', 'slack', 'workers'].sort());
    expect(s.ok).toBe(true);
    expect(s.at).toBe(T);
    for (const k of SECTIONS) expect(s[k].status).toBe('ok');
  });

  it('workers: same key set as supervisor _workerStatus; summary bounded', () => {
    const { deps } = mkDeps();
    const w = health.buildSnapshot(deps).workers;
    expect(w.enabled).toBe(true);
    expect(w.list.map((x) => x.name)).toEqual(['alpha', 'beta']);
    for (const x of w.list) expect(Object.keys(x).sort()).toEqual(WORKER_KEYS);
    expect(w.list[0].waitingOn).toEqual(['auth']);
    expect(w.summary).toEqual({ count: 2, byState: { healthy: 1, busy: 0, waiting: 1, degraded: 0, isolated: 0, disabled: 0 }, fails: 1, lastErrorAt: T - 60000 });
  });

  it('workers: supervisor not initialized → enabled:false, empty list', () => {
    const { deps } = mkDeps({ supervisor: { getStatus: () => ({ enabled: false, workers: [] }), getSummary: () => null } });
    expect(health.buildSnapshot(deps).workers).toEqual({ status: 'ok', enabled: false, shuttingDown: false, summary: null, list: [] });
  });

  it('workers: getStatus() {error} → unavailable with the clipped reason', () => {
    const { deps } = mkDeps({ supervisor: { getStatus: () => ({ enabled: true, error: 'boom', workers: [] }), getSummary: () => null } });
    expect(health.buildSnapshot(deps).workers).toEqual({ status: 'unavailable', reason: 'boom' });
  });

  it('ai: lanes, queue, latency from gateway (no bySource), claudePool, flags', () => {
    const { deps } = mkDeps();
    const a = health.buildSnapshot(deps).ai;
    expect(a.lanes).toEqual({ fleetBrain: 'up', orcha: 'up', claude: 'down', bedrock: 'fallback' });
    expect(a.overall).toEqual({ status: 'up', reasons: ['one AI lane unavailable'] });
    expect(a.queue.byPriority.high).toEqual({ active: 0, waiting: 1 });
    expect(a.queue).toMatchObject({ active: 1, waiting: 2, max: 4, reserve: 1, oldestWaitMs: 1500 });
    expect(a.latency).toEqual({ sampleSize: 10, byPriority: { normal: { count: 10, p50LatencyMs: 800, p95LatencyMs: 2400, p95QueueWaitMs: 50, timeout: 1, error: 0 } } });
    expect(JSON.stringify(a)).not.toContain('bySource');
    expect(a.claudePool).toMatchObject({ size: 2, busy: 1, queued: 0 });
    expect(a.flags).toEqual({ priorities: true, abortOnTimeout: false, dedupe: true, routerDecides: false });
    expect(a.at).toBe(T);
    expect('akiLane' in a).toBe(false);
  });

  it('ai: akiLane mapped (state + numbers/booleans only) when the relay provides it', () => {
    const { deps } = mkDeps();
    const base = deps.relay.queueStats;
    deps.relay = { queueStats: () => Object.assign(base(), {
      akiLane: { state: 'up', active: true, busy: 1, queued: 2, max: 2, calls: 5, ok: 4, failed: 1, toolsUsed: 3,
        enabled: true, allowUntrusted: false, lastErrorCode: 'AKI_EXIT', lastTools: { Bash: 2 }, secret: 'x' },
    }) };
    const a = health.buildSnapshot(deps).ai;
    expect(a.akiLane).toMatchObject({ state: 'up', active: true, busy: 1, queued: 2, max: 2, calls: 5, ok: 4, failed: 1,
      toolsUsed: 3, enabled: true, allowUntrusted: false });
    expect(a.akiLane.secret).toBeUndefined();
    expect(a.akiLane.lastErrorCode).toBeUndefined();
  });

  it('auth: whitelisted fields only, no nextRetryAt / aapProbe / lastRecovery', () => {
    const { deps } = mkDeps();
    const a = health.buildSnapshot(deps).auth;
    expect(a).toEqual({
      status: 'ok', state: 'HEALTHY', at: '2026-03-02T11:59:00Z', online: true, sessionExpiresInMin: 300, aeaExpiresInMin: 120,
      keepAlive: { running: true, state: 'HEALTHY', consecutiveFailures: 0, lastOk: true, lastAt: T - 1000, lastReason: 'refreshed' },
    });
    expect('nextRetryAt' in a).toBe(false);
    expect('aapProbe' in a).toBe(false);
    expect('lastRecovery' in a).toBe(false);
  });

  it('auth: getSnapshot() null → ok with nulls; AEA not loaded → keepAlive null', () => {
    const { deps } = mkDeps({ midway: { getState: () => 'COOLDOWN', getSnapshot: () => null }, aeaKeepalive: null });
    expect(health.buildSnapshot(deps).auth).toEqual({
      status: 'ok', state: 'COOLDOWN', at: null, online: null, sessionExpiresInMin: null, aeaExpiresInMin: null, keepAlive: null,
    });
  });

  // auth.propagation (F11): live status fields only when the flag is on.
  const LIVE = {
    level: 'warn', action: 'mwinit', stepUp: true, message: 'Midway is asking for a full sign-in.',
    verifiedAt: '2026-03-02T11:00:00.000Z', verifiedBy: 'api:aap-api', nextRetryAt: '2026-03-02T12:05:00.000Z',
    evidence: { liveAeaMin: 14, diskAeaMin: 120 }, secretish: 'never-copied',
  };
  const LEGACY_AUTH = {
    status: 'ok', state: 'HEALTHY', at: '2026-03-02T11:59:00Z', online: true, sessionExpiresInMin: 300, aeaExpiresInMin: 120,
    keepAlive: { running: true, state: 'HEALTHY', consecutiveFailures: 0, lastOk: true, lastAt: T - 1000, lastReason: 'refreshed' },
  };
  function withStatus(enabled) {
    const { deps } = mkDeps();
    const getStatus = vi.fn(() => LIVE);
    deps.midway = Object.assign({}, deps.midway, { getStatus });
    deps.authReport = { isEnabled: () => enabled };
    return { deps, getStatus };
  }

  it('F11: _authSection flag-off output unchanged (getStatus never read)', () => {
    const { deps, getStatus } = withStatus(false);
    const a = health.buildSnapshot(deps).auth;
    expect(JSON.stringify(a)).toBe(JSON.stringify(LEGACY_AUTH));
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('F11: _authSection flag-on adds status fields', () => {
    const { deps } = withStatus(true);
    const a = health.buildSnapshot(deps).auth;
    expect(a).toEqual(Object.assign({}, LEGACY_AUTH, {
      level: 'warn', action: 'mwinit', stepUp: true, message: 'Midway is asking for a full sign-in.',
      verifiedAt: '2026-03-02T11:00:00.000Z', verifiedBy: 'api:aap-api', nextRetryAt: '2026-03-02T12:05:00.000Z', liveAea: 14,
    }));
    expect('secretish' in a).toBe(false);
  });

  it('slack: polls without lastResult; speedup numbers only; no owaTriage', () => {
    const { deps } = mkDeps();
    const s = health.buildSnapshot(deps).slack;
    expect(s.mode).toBe('on');
    expect(s.polls.dm).toEqual({ inFlight: false, stalled: false, lastEndAt: T - 1000, lastDurationMs: 1000, nextRunAt: T + 29000, runs: 10, fails: 1, lastError: 'x', skipped: { coalesced: 2, busy: 0, standby: 0, notAuthed: 0 } });
    expect(s.speedup).toEqual({ lane: { active: 1 }, dm: { hits: 3 }, channel: { hits: 4 } });
    expect('owaTriage' in s).toBe(false);
  });

  it('scheduler: per-channel summary; blocked combines auth+stale; lastError rendered as message', () => {
    const { deps } = mkDeps({ scheduler: { getState: () => ({
      enabled: { sp: true, email: false, dbr: false }, nextSlot: { sp: { label: '08:00', when: 'today' }, email: null, dbr: null },
      sharepoint: channel({ blockedAuth: [job(3, 'blocked_auth')], blockedStale: [job(4, 'blocked_stale_data')], uncertain: [job(5, 'delivery_uncertain')], active: [job(6, 'running')] }),
      email: channel(), dbrAfp: channel(), dbrDsp: channel(),
    }) } });
    const s = health.buildSnapshot(deps).scheduler;
    expect(s.enabled).toEqual({ sp: true, email: false, dbr: false });
    const sp = s.channels.sharepoint;
    expect(sp.blockedCount).toBe(2);
    expect(sp.blocked.map((j) => j.state)).toEqual(['blocked_auth', 'blocked_stale_data']);
    expect(sp.uncertainCount).toBe(1);
    expect(sp.active).toBe(1);
    expect(sp.lastFailure).toEqual({ slotLabel: '07:30', dateKey: '2026-03-02', state: 'failed', updatedAt: '2026-03-02T07:31:00Z', error: 'auth failed' });
    expect(sp.lastVerified).toEqual({ slotLabel: '07:30', dateKey: '2026-03-02', updatedAt: '2026-03-02T07:31:00Z' });
  });

  it('resources: main/renderer/total/windows + top 8 tracks by p95', () => {
    const { deps } = mkDeps();
    const r = health.buildSnapshot(deps).resources;
    expect(r.eventLoop).toEqual({ p50Ms: 10, p99Ms: 40, maxMs: 90 });
    expect(r.main).toEqual({ rssMb: 300, heapUsedMb: 120, cpuPct: 5, workingSetMb: 200 });
    expect(r.renderer).toEqual({ count: 2, workingSetMb: 250, cpuPct: 4 });
    expect(r.total).toEqual({ count: 4, workingSetMb: 500, cpuPct: 11 });
    expect(r.windows).toEqual({ total: 3, visible: 1 });
    expect(r.topTracks).toHaveLength(8);
    expect(r.topTracks[0]).toEqual({ name: 'track11', count: 5, fail: 0, p95Ms: 110, maxMs: 220 });
  });

  it('resources: no telemetry sample → unavailable "telemetry not sampling"', () => {
    const { deps } = mkDeps({ telemetry: { latestSample: () => null, snapshot: () => ({ tracks: {} }) } });
    const s = health.buildSnapshot(deps);
    expect(s.resources).toEqual({ status: 'unavailable', reason: 'telemetry not sampling' });
    expect(s.workers.status).toBe('ok');
  });
});

describe('health snapshot — isolation', () => {
  const throwers = [
    ['workers', (d) => { d.supervisor = { getStatus: () => { throw new Error('sup down'); }, getSummary: () => null }; }],
    ['ai', (d) => { d.relay = { queueStats: () => { throw new Error('relay down'); } }; }],
    ['ai', (d) => { d.aiStatus = { snapshot: () => { throw new Error('status down'); } }; }],
    ['auth', (d) => { d.midway = { getState: () => { throw new Error('auth down'); }, getSnapshot: () => null }; }],
    ['slack', (d) => { d.poller = { getStatus: () => { throw new Error('poller down'); } }; }],
    ['scheduler', (d) => { d.scheduler = { getState: () => { throw new Error('ledger down'); } }; }],
    ['resources', (d) => { d.telemetry = { latestSample: () => { throw new Error('tel down'); } }; }],
  ];
  for (const [section, mutate] of throwers) {
    it('throwing ' + section + ' source → only that section unavailable', () => {
      const { deps } = mkDeps();
      mutate(deps);
      let s;
      expect(() => { s = health.buildSnapshot(deps); }).not.toThrow();
      expect(s.ok).toBe(true);
      expect(s[section].status).toBe('unavailable');
      expect(typeof s[section].reason).toBe('string');
      expect(s[section].reason).toMatch(/down/);
      for (const k of SECTIONS) if (k !== section) expect(s[k].status).toBe('ok');
    });
  }

  it('modules not in require.cache → not-loaded; require.cache unchanged', () => {
    const before = Object.keys(require.cache).sort();
    const s = health.buildSnapshot({
      now: () => T, logger: quiet,
      supervisor: { getStatus: () => ({ enabled: false, workers: [] }) },
      telemetry: { latestSample: () => null },
    });
    for (const k of ['ai', 'auth', 'slack', 'scheduler']) expect(s[k]).toEqual({ status: 'unavailable', reason: 'not-loaded' });
    expect(Object.keys(require.cache).sort()).toEqual(before);
  });
});

describe('health snapshot — bounds', () => {
  it('caps: lastError ≤200, 20 blocked → 5 items + blockedCount 20, 60 workers → 50', () => {
    const workers = Array.from({ length: 60 }, (_, i) => worker('w' + i, { lastError: { message: 'x '.repeat(500), at: T, kind: 'throw' } }));
    const blocked = Array.from({ length: 20 }, (_, i) => job(i, 'blocked_auth'));
    const { deps } = mkDeps({
      supervisor: { getStatus: () => ({ enabled: true, shuttingDown: false, workers }), getSummary: () => null },
    });
    const base = deps.scheduler.getState();
    deps.scheduler = { getState: () => Object.assign({}, base, { email: channel({ blockedAuth: blocked }) }) };
    const s = health.buildSnapshot(deps);
    expect(s.workers.list).toHaveLength(50);
    expect(s.workers.total).toBe(60);
    for (const w of s.workers.list) expect(w.lastError.message.length).toBeLessThanOrEqual(200);
    expect(s.scheduler.channels.email.blocked).toHaveLength(5);
    expect(s.scheduler.channels.email.blockedCount).toBe(20);
    expect(JSON.stringify(s).length).toBeLessThan(64 * 1024);
  });

  it('redaction: token=… and long base64 runs become [redacted]', () => {
    const secret = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw';
    const { deps } = mkDeps({
      supervisor: { getStatus: () => ({ enabled: true, workers: [worker('alpha', { lastError: { message: 'failed token=abcd1234 then ' + secret, at: T, kind: 'throw' } })] }), getSummary: () => null },
    });
    const msg = health.buildSnapshot(deps).workers.list[0].lastError.message;
    expect(msg).toContain('token=[redacted]');
    expect(msg).not.toContain('abcd1234');
    expect(msg).not.toContain(secret);
    expect(msg).toContain('[redacted]');
    expect(health._clip('Cookie: abc', 60)).toBe('Cookie=[redacted]');
  });

  it('forbidden keys never appear anywhere in the payload', () => {
    const { deps } = mkDeps();
    const keys = walkKeys(health.buildSnapshot(deps));
    for (const k of ['intendedRecipients', 'actualRecipients', 'history', 'lastResult', 'owaTriage', 'pid', 'recent', 'bySource', 'aapProbe', 'lastRecovery', 'nextRetryAt', 'jobsToday', 'processes', 'samples']) {
      expect(keys.has(k)).toBe(false);
    }
    expect(JSON.stringify(health.buildSnapshot(deps))).not.toContain('someone@example.com');
  });
});

describe('health snapshot — TTL memo (no timers)', () => {
  it('scheduler + ai/status memoized 30 s; fast getters called every time', () => {
    const { deps, calls, setNow } = mkDeps();
    health.buildSnapshot(deps);
    setNow(T + 10000);
    const s2 = health.buildSnapshot(deps);
    expect(calls.sched).toBe(1);
    expect(calls.ai).toBe(1);
    expect(s2.scheduler.at).toBe(T);
    expect(s2.ai.at).toBe(T);
    expect(calls.sup).toBe(2);
    expect(calls.relay).toBe(2);
    expect(calls.poller).toBe(2);
    expect(calls.mw).toBe(2);
    expect(calls.tel).toBe(2);
    setNow(T + 30000);
    const s3 = health.buildSnapshot(deps);
    expect(calls.sched).toBe(2);
    expect(calls.ai).toBe(2);
    expect(s3.scheduler.at).toBe(T + 30000);
  });
});
