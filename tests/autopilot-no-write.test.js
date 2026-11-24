// tests/autopilot-no-write.test.js — fleet-autopilot §B14 items 1-7 (static part) and plan R12.
// No Autopilot file may require or reference a write module, a sign-in function or a
// window-creating read. ports.js is the only file with network / session requires and it
// reads members only through pick(mod, 'name') with the pinned names below. Files that do
// not exist yet (later FEATs) are skipped.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AP_DIR = path.join(ROOT, 'src', 'autopilot');
const IPC_FILE = path.join(ROOT, 'src', 'ipc', 'autopilot.js');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}
const apFiles = walk(AP_DIR);
const scanned = apFiles.concat(fs.existsSync(IPC_FILE) ? [IPC_FILE] : []);
const base = (f) => path.basename(f, '.js');
const requiresOf = (src) => [...src.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);

// §B14 item 1 (+ item 7 narrowing).
const COMMON = new Set(['crypto', '../jobs', '../telemetry', '../utils/logger', '../ai/authority', '../ai/trace', '../email-intel/untrusted']);
function allowedFor(file, r) {
  const f = base(file);
  if (r.startsWith('./')) return true;
  if (COMMON.has(r)) return true;
  if (r === '../store/sqlite_engine') return f === 'case-store' || f === 'schema';
  if (r === '../store') return f === 'config';
  if (r === '../workers/supervisor') return f === 'controller' || f === 'index';
  if (r === '../orcha/reason') return f === 'investigate';
  if (['fs', 'path', '../config/paths'].includes(r)) return f === 'harness';
  return false;
}
// §B14 item 2.
const PORTS_ALLOWED = new Set([
  '../store', '../health/fleet-freshness', '../orcha/canonical_state', '../repair-intel/store',
  '../repair-intel/trends', '../repair-intel/vendor-network', '../carrier-intel/taxonomy',
  '../orcha/fas/slack-search', '../dtna/store', '../dtna/session', '../scrapers/aap_api',
  '../scrapers/decisiv_api', '../aperia/sync-read', '../aperia/session',
  '../auth/midway-health-supervisor', '../cluster', '../orcha/offline', '../orcha/relay',
  '../utils/offsite-owner',
]);

// §B14 item 3.
const FORBIDDEN_RE = new RegExp([
  'apiPost', 'apiPut', 'createWorkOrder', 'updateWork', 'updateEscalations', '_commitApproved', 'slack_send',
  'owa-mailer', 'email_sender', 'write-gate', '/writes/', 'fas/executor', 'sharepoint_push', 'sp_sheet_transport',
  'dtna/writes', 'dtna/auto', 'aperia/client', 'comment-draft', 'setLifecycle', 'lifecycle_change\\(',
  'chat\\.postMessage', 'runMwinit', 'ensureHealthy', 'backgroundLogin', 'openLoginWindow', 'ensureContext',
  'reauth\\(', 'pullIfStale', 'lookupUnit', 'buildIndex', 'getVehicle', 'listIssues', 'bulkLookup', 'fleetTires',
  'evaluateInPage', 'withWindow', 'BrowserWindow', 'openPage', 'method:\\s*[\'"](POST|PUT|PATCH|DELETE)',
].join('|'));
const FORBIDDEN_PICK_RE = /['"](getService|getCaseStatusSummary|getActivityLogs|apiGet)['"]/;

// §B14 item 5: pinned port names and per-module picks.
const PINNED_PORTS = [
  'readStore', 'generation', 'fleetFreshness', 'canonical', 'isDown',
  'riEvents', 'riAnalysis', 'riRepeat', 'vendorScorecards', 'downCause',
  'slackSearch', 'offsiteUrlOf', 'dtnaCasesForUnit', 'dtnaStatus',
  'aperiaCachedIssues', 'aperiaStatus', 'aapIsWarm', 'aapGetServiceIfWarm',
  'decisivIsWarm', 'decisivCaseStatusIfWarm', 'decisivActivityIfWarm', 'decisivFormatActivity',
  'authState', 'aiQueue', 'aiStatus', 'isolatedLaneAvailable',
];
const PINNED_PICKS = {
  store: ['load', 'generation'],
  fleetFreshness: ['evaluate', 'getSnapshot', 'RED_AGE_FACTOR'],
  canonicalState: ['getCanonical', 'isDown'],
  riStore: ['eventsForUnit', 'getAiAnalysis'],
  riTrends: ['repeatOffenders'],
  vendorNetwork: ['vendorScorecards'],
  taxonomy: ['downCause'],
  slackSearch: ['searchSlack'],
  dtnaStore: ['findByUnit'],
  dtnaSession: ['status'],
  aapApi: ['isWarm', 'getServiceIfWarm'],
  decisivApi: ['isWarm', 'getCaseStatusSummaryIfWarm', 'getActivityLogsIfWarm', 'formatActivityLogs'],
  aperiaSyncRead: ['cached'],
  aperiaSession: ['status'],
  midway: ['getState'],
  cluster: ['mayLivePull'],
  offline: ['isOffline'],
  relay: ['queueStats', 'getStatus', 'isolatedLaneAvailable'],
  offsiteOwner: ['offsiteUrlOf'],
};
const NULLS = Object.fromEntries(Object.keys(PINNED_PICKS).map((k) => [k, null]));
const WRITE_NAME_RE = /post|put|create|update|send|write|commit|approve|delete|login|reauth|ensure/i;

// §B14 item 7: the walker of tests/carrier-intel-readonly-graph.test.js.
const REQ_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
function directRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(REQ_RE)) out.push(m[2]);
  return out;
}
function closure(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(c?js)$/.test(f)) continue;
    const req = createRequire(f);
    for (const spec of directRequires(f)) {
      let resolved;
      try { resolved = req.resolve(spec); } catch (_) { continue; }
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return new Set([...seen].map(rel));
}
const CLOSURE_FORBIDDEN = (p) => p.startsWith('src/writes/') || p === 'src/scrapers/aap_api.js' || p === 'src/scrapers/decisiv_api.js'
  || /^src\/dtna\/[^/]+$/.test(p) || /^src\/aperia\/[^/]+$/.test(p) || p === 'src/orcha/relay.js' || /^src\/auth\/[^/]+$/.test(p);
const CLOSURE_EXEMPT = new Set(['ports', 'investigate', 'controller', 'index']);

describe('§B14 static boundary', () => {
  it('scans the FEAT-001/002 modules (sanity)', () => {
    const names = apFiles.map(base);
    for (const n of ['constants', 'config', 'case-store', 'detect', 'ports', 'limiter', 'plan', 'evidence']) expect(names).toContain(n);
  });

  it('item 1: every Autopilot file except ports.js requires only allowed modules', () => {
    for (const f of scanned) {
      if (base(f) === 'ports' && path.dirname(f) === AP_DIR) continue;
      const bad = requiresOf(read(f)).filter((r) => !allowedFor(f, r));
      expect(bad, rel(f)).toEqual([]);
    }
  });

  it('item 2: ports.js requires only the allowed network / session modules', () => {
    const reqs = requiresOf(read(path.join(AP_DIR, 'ports.js')));
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.filter((r) => !PORTS_ALLOWED.has(r))).toEqual([]);
    expect(reqs).not.toContain('../dtna/auto');
    expect(reqs).not.toContain('../aperia/client');
  });

  it('item 3: no forbidden token and no forbidden quoted pick name', () => {
    for (const f of scanned) {
      const src = read(f);
      const m = src.match(FORBIDDEN_RE);
      expect(m && m[0], rel(f)).toBe(null);
      const q = src.match(FORBIDDEN_PICK_RE);
      expect(q && q[0], rel(f)).toBe(null);
    }
  });

  it('item 3 self-test: the forbidden regexes match what they must', () => {
    for (const s of ['aap.apiPost(', "require('../writes/write-gate')", 'new BrowserWindow(', "method: 'POST'", 'session.reauth()', "pick(m, 'getService')"]) {
      expect(FORBIDDEN_RE.test(s) || FORBIDDEN_PICK_RE.test(s), s).toBe(true);
    }
    expect(FORBIDDEN_PICK_RE.test("'getServiceIfWarm'")).toBe(false);
  });

  it('item 4: write SQL names only ap_* tables; store.save / update only in config.js with the key settings', () => {
    const SQL_RE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const f of scanned) {
      const src = read(f);
      for (const m of src.matchAll(SQL_RE)) {
        if (/^(OR|SET)$/.test(m[1])) continue;
        expect(m[1].startsWith('ap_'), rel(f) + ': ' + m[0]).toBe(true);
      }
      const writes = [...src.matchAll(/\.(save|update|updateAsync)\(\s*(['"])([^'"]+)\2/g)].map((x) => x[3]);
      if (base(f) === 'config' && path.dirname(f) === AP_DIR) expect(new Set(writes), rel(f)).toEqual(new Set(['settings']));
      else expect(writes, rel(f)).toEqual([]);
    }
  });

  it('item 6: only investigate.js, controller.js and case-store.js require ./resolution', () => {
    const users = scanned.filter((f) => requiresOf(read(f)).some((r) => r === './resolution' || r === '../autopilot/resolution')).map(base).sort();
    for (const u of users) expect(['case-store', 'controller', 'investigate']).toContain(u);
    expect(users).toContain('case-store');
  });

  it('R12: no aperia:<letter> anywhere in src/autopilot/** or src/ipc/autopilot.js', () => {
    for (const f of scanned) expect(/aperia:[a-z]/.test(read(f)), rel(f)).toBe(false);
  });
});

describe('§B14 item 7: transitive require closure', () => {
  it('walker self-test: ports.js reaches the transports and the relay (lazy requires followed)', () => {
    const c = closure(path.join(AP_DIR, 'ports.js'));
    expect(c.has('src/scrapers/aap_api.js')).toBe(true);
    expect(c.has('src/scrapers/decisiv_api.js')).toBe(true);
    expect(c.has('src/orcha/relay.js')).toBe(true);
    expect([...c].some(CLOSURE_FORBIDDEN)).toBe(true);
  });

  it('every other Autopilot module reaches no write, transport, DTNA, Aperia, relay or auth module', () => {
    for (const f of apFiles) {
      if (path.dirname(f) !== AP_DIR || CLOSURE_EXEMPT.has(base(f))) continue;
      const bad = [...closure(f)].filter(CLOSURE_FORBIDDEN);
      expect(bad, rel(f)).toEqual([]);
    }
  });
});

describe('§B14 item 5: the frozen port object', () => {
  // Proxy fakes record every member create() reads; every member is a harmless function.
  function mkFakes() {
    const accessed = {};
    const fakes = {};
    for (const key of Object.keys(PINNED_PICKS)) {
      accessed[key] = new Set();
      fakes[key] = new Proxy({}, {
        get(_t, prop) {
          if (typeof prop !== 'string') return undefined;
          accessed[key].add(prop);
          if (/^[A-Z_]+$/.test(prop)) return 3;
          return function fake() { return null; };
        },
      });
    }
    return { fakes, accessed };
  }
  const ports = require('../src/autopilot/ports');

  it('the pinned port names, picks and frozen object', () => {
    const { fakes } = mkFakes();
    const p = ports.create(fakes);
    expect(Object.keys(p)).toEqual(PINNED_PORTS);
    expect(ports.PORT_NAMES).toEqual(PINNED_PORTS);
    expect(JSON.parse(JSON.stringify(ports.PICKS))).toEqual(PINNED_PICKS);
    expect(Object.isFrozen(p)).toBe(true);
    for (const name of Object.keys(p)) {
      expect(typeof p[name], name).toBe('function');
      expect(WRITE_NAME_RE.test(p[name].name), name + ' -> ' + p[name].name).toBe(false);
    }
  });

  it('create() reads exactly the pinned members of each module, and no picked name is a write name', () => {
    const { fakes, accessed } = mkFakes();
    ports.create(fakes);
    for (const key of Object.keys(PINNED_PICKS)) {
      expect([...accessed[key]].sort(), key).toEqual(PINNED_PICKS[key].slice().sort());
      for (const n of PINNED_PICKS[key]) expect(WRITE_NAME_RE.test(n), key + '.' + n).toBe(false);
    }
  });

  it('calling every port reads no further member', () => {
    const { fakes, accessed } = mkFakes();
    const p = ports.create(Object.assign(fakes, { liveReads: true }));
    const snap = JSON.stringify(Object.fromEntries(Object.entries(accessed).map(([k, v]) => [k, [...v].sort()])));
    for (const name of Object.keys(p)) {
      try { const r = p[name]('x', { srUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/1' }); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    }
    expect(JSON.stringify(Object.fromEntries(Object.entries(accessed).map(([k, v]) => [k, [...v].sort()])))).toBe(snap);
  });

  it('a missing member yields a PORT_MISSING stub', async () => {
    const p = ports.create({ ...NULLS, aperiaSyncRead: {}, aapApi: {}, liveReads: true, cluster: { mayLivePull: () => true }, offline: { isOffline: () => false }, midway: { getState: () => 'HEALTHY' } });
    expect(p.aperiaCachedIssues()).toEqual({ ok: false, code: 'PORT_MISSING' });
    expect(await p.aapGetServiceIfWarm('svc-1')).toEqual({ ok: false, code: 'PORT_MISSING' });
  });
});

describe('ports gates (evaluated right before each live call)', () => {
  const ports = require('../src/autopilot/ports');
  function mk(over) {
    const calls = { aap: 0, dec: 0, act: 0 };
    const st = Object.assign({ live: true, pull: true, off: false, midway: 'HEALTHY' }, over || {});
    const p = ports.create({
      ...NULLS,
      liveReads: () => st.live,
      cluster: { mayLivePull: () => st.pull },
      offline: { isOffline: () => st.off },
      midway: { getState: () => st.midway },
      aapApi: { isWarm: () => true, getServiceIfWarm: async (id) => { calls.aap++; return { id }; } },
      decisivApi: {
        isWarm: () => true,
        getCaseStatusSummaryIfWarm: async () => { calls.dec++; return { ok: true, stage: 'repair' }; },
        getActivityLogsIfWarm: async () => { calls.act++; return { notes: [] }; },
        formatActivityLogs: () => ({ text: '' }),
      },
    });
    return { p, calls, st };
  }
  const SR = 'https://volvopg.asist.decisiv.net/fleet/estimates/1';

  it('all gates open -> the warm-only reads are called', async () => {
    const { p, calls } = mk();
    expect(await p.aapGetServiceIfWarm('svc-1')).toEqual({ ok: true, value: { id: 'svc-1' } });
    expect(await p.decisivCaseStatusIfWarm('1', { srUrl: SR })).toEqual({ ok: true, value: { stage: 'repair' } });
    expect(await p.decisivActivityIfWarm('1', { srUrl: SR })).toEqual({ ok: true, value: { notes: [] } });
    expect(calls).toEqual({ aap: 1, dec: 1, act: 1 });
  });

  it('liveReads OFF, cluster closed, offline, or midway not HEALTHY -> no call', async () => {
    for (const over of [{ live: false }, { pull: false }, { off: true }]) {
      const { p, calls } = mk(over);
      expect((await p.aapGetServiceIfWarm('svc-1')).ok).toBe(false);
      expect((await p.decisivCaseStatusIfWarm('1', { srUrl: SR })).ok).toBe(false);
      expect((await p.decisivActivityIfWarm('1', { srUrl: SR })).ok).toBe(false);
      expect(calls).toEqual({ aap: 0, dec: 0, act: 0 });
    }
    const off = mk({ live: false });
    expect(await off.p.aapGetServiceIfWarm('svc-1')).toEqual({ ok: false, code: 'LIVE_READS_OFF' });
    for (const m of ['WAITING_FOR_USER', 'UNKNOWN', 'DEGRADED']) {
      const { p, calls } = mk({ midway: m });
      expect(await p.aapGetServiceIfWarm('svc-1')).toEqual({ ok: false, code: 'GATE_CLOSED' });
      expect(calls.aap).toBe(0);
      // The Decisiv gate has no midway term.
      expect((await p.decisivCaseStatusIfWarm('1', { srUrl: SR })).ok).toBe(true);
    }
  });

  it('the gate is read at call time, not at create time', async () => {
    const { p, calls, st } = mk({ live: false });
    st.live = true;
    expect((await p.aapGetServiceIfWarm('svc-1')).ok).toBe(true);
    st.pull = false;
    expect((await p.aapGetServiceIfWarm('svc-1')).ok).toBe(false);
    expect(calls.aap).toBe(1);
  });

  it('Decisiv without srUrl -> DECISIV_NO_ORIGIN without calling', async () => {
    const { p, calls } = mk();
    expect(await p.decisivCaseStatusIfWarm('1', {})).toEqual({ ok: false, code: 'DECISIV_NO_ORIGIN' });
    expect(await p.decisivActivityIfWarm('1')).toEqual({ ok: false, code: 'DECISIV_NO_ORIGIN' });
    expect(calls).toEqual({ aap: 0, dec: 0, act: 0 });
  });

  it('liveReads defaults to OFF when not provided', async () => {
    const p = ports.create({ ...NULLS, cluster: { mayLivePull: () => true }, offline: { isOffline: () => false }, midway: { getState: () => 'HEALTHY' }, aapApi: { getServiceIfWarm: async () => { throw new Error('must not be called'); } } });
    expect(await p.aapGetServiceIfWarm('svc-1')).toEqual({ ok: false, code: 'LIVE_READS_OFF' });
  });

  it('fleetFreshness returns lastOkAt from getSnapshot (R1)', () => {
    const p = ports.create({ ...NULLS, fleetFreshness: {
      evaluate: () => ({ level: 'red', reasons: ['age>3x'], intervalMs: 600000, health: 'x' }),
      getSnapshot: () => ({ lastOkAt: 12345 }),
      RED_AGE_FACTOR: 3,
    } });
    expect(p.fleetFreshness(1)).toEqual({ level: 'red', reasons: ['age>3x'], intervalMs: 600000, redAgeFactor: 3, lastOkAt: 12345 });
  });

  it('readStore reads only the READ_KEYS', () => {
    const loads = [];
    const p = ports.create({ ...NULLS, store: { load: (k, fb) => { loads.push(k); return fb; }, generation: () => 0 } });
    expect(p.readStore('settings')).toBe(null);
    expect(p.readStore('relayWritesPending')).toBe(null);
    p.readStore('fleetData');
    expect(loads).toEqual(['fleetData']);
  });
});
