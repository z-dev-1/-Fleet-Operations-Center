// tests/fixtures/jobs-deep-scan-fixture.js — shared fixture for the Phase 7
// deep-scan flags-off golden (generator: tests/jobs-deep-scan-baseline.gen.test.js,
// consumer: tests/jobs-adopt-deep-scan.test.js and the T5 resume test).
//
// Installs require-cache recorder stubs for every outside effect of
// runOrchaDeepScan (relay, ASIST/DTNA enrich, repair-history, notifier,
// ready-pickup notify, the JSON store and the logger). No real AAP / Slack /
// AI / browser call can happen. Only `Date` is frozen (setupClock), so the
// relay/enrich stubs resolve on real microtasks.
//
// Normalization (applied identically by the generator and the tests):
//   - pushData payloads: deep-cloned at call time, `syncedAt` stripped.
//   - pushStatus: trailing toLocaleTimeString replaced by ' · <time>'.
//   - logger lines: no timestamps or durations appear in deep-scan messages,
//     so they are recorded verbatim (namespace 'deep-scan' only).
import { vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export const FIXED = Date.parse('2026-11-02T15:04:05.000Z');
const STALE = new Date(FIXED - 3 * 60 * 60 * 1000).toISOString(); // 3h old > 2h fresh window

export function setupClock() {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED });
}

function inject(relFromTests, exportsObj) {
  const resolved = require.resolve('../../' + relFromTests);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ── Recorder state (reset per scenario) ─────────────────────────────────────
export const rec = {
  logs: [],          // { ns, level, msg }
  prompts: [],       // { id, source }
  enrich: [],        // urls passed to enrichVolvoAsist / enrichDtna
  addEvent: [],
  enqueue: [],
  onStageUpdate: [],
  store: new Map(),  // key -> JSON doc
  relayImpl: null,   // optional override (id, prompt, opts) => Promise<string|null>
  enrichImpl: null,  // optional override (url) => Promise<result>
  onRelay: null,     // optional hook (id) for T9 assertions
  onEnrich: null,
};

export function resetRecorders() {
  rec.logs = []; rec.prompts = []; rec.enrich = [];
  rec.addEvent = []; rec.enqueue = []; rec.onStageUpdate = [];
  rec.store = new Map(); rec.relayImpl = null; rec.enrichImpl = null;
  rec.onRelay = null; rec.onEnrich = null;
}

// ── Logger ──────────────────────────────────────────────────────────────────
function fakeLogger(ns) {
  const r = (level) => (...a) => rec.logs.push({ ns, level, msg: a.map((x) => (typeof x === 'string' ? x : String(x && x.message || x))).join(' ') });
  return { debug: r('debug'), info: r('info'), warn: r('warn'), error: r('error'), log: r('info') };
}
fakeLogger.createLogger = fakeLogger;
fakeLogger.setLogDir = () => {};
fakeLogger.setLevel = () => {};
fakeLogger.setSilent = () => {};
fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// ── Deterministic AI text per unit ──────────────────────────────────────────
const AI_TEXT = {
  U101: 'REPAIR_STATUS: Parts ordered\nPRIMARY_COMPONENT: CHASSIS\nISSUE: Air leak at rear axle\nTIMELINE:\n10/28 - Work order created with Volvo for air leak.\n10/30 - Parts ordered. ETA pending.',
  U102: 'REPAIR_STATUS: Repair completed\nPRIMARY_COMPONENT: ENGINE/MOTOR SYSTEMS\nISSUE: Check engine light\nTIMELINE:\n10/29 - Diagnosis: failed sensor.\n11/01 - Repairs completed by technician. Ready for pickup.',
  U103: 'REPAIR_STATUS: Under diagnosis\nPRIMARY_COMPONENT: ELECTRICAL\nISSUE: Battery drain\nTIMELINE:\n10/31 - Dealer diagnosing battery drain.',
  U104: 'REPAIR_STATUS: Awaiting approval\nPRIMARY_COMPONENT: CAB/CLIMATE CONTROL/INSTRUMENTATION\nISSUE: AC not cooling\nTIMELINE:\n10/30 - Vendor inspected AC.\n11/01 - Vendor says repair is out of scope; needs to go to dealer.',
  U105: '',
  U106: null,
};

function _idFromPrompt(p) {
  const m = /repair timeline for unit (\S+?)\.\n/.exec(String(p));
  return m ? m[1] : '?';
}

// ── Stubs ───────────────────────────────────────────────────────────────────
export function installStubs() {
  inject('src/utils/logger', fakeLogger);
  inject('src/store', {
    load: (k, d) => (rec.store.has(k) ? clone(rec.store.get(k)) : d),
    save: (k, v) => { rec.store.set(k, clone(v)); },
  });
  inject('src/orcha/relay', {
    ask: async (prompt, opts) => {
      const id = _idFromPrompt(prompt);
      rec.prompts.push({ id, source: opts && opts.source });
      if (rec.onRelay) rec.onRelay(id);
      if (rec.relayImpl) return rec.relayImpl(id, prompt, opts);
      if (id === 'U106') throw new Error('relay lane down');
      return AI_TEXT[id] == null ? null : AI_TEXT[id];
    },
    askWithTimeout: async () => { throw new Error('askWithTimeout not expected in deep-scan'); },
    getStatus: () => ({ backends: { orcha: true, claude: true } }),
    getClaudePoolSize: () => 1,
  });
  inject('src/scrapers/asist_enrich', {
    enrichVolvoAsist: async (url) => {
      rec.enrich.push(url);
      if (rec.onEnrich) rec.onEnrich(url);
      if (rec.enrichImpl) return rec.enrichImpl(url);
      const id = (/case\/(\w+)/.exec(url) || [])[1] || '?';
      const ready = id === 'U101';
      return {
        ok: true, offsiteText: 'Fresh dealer notes for ' + id + ': technician update logged today, parts status confirmed.',
        scrapedAt: new Date(FIXED).toISOString(), source: 'decisiv-api', bestLabel: 'Decisiv case', bestUrl: url,
        offsiteStage: ready ? 'ready' : 'repair', offsiteStageDetail: ready ? 'Ready for pickup' : 'In bay',
        offsiteStageSince: ready ? '2026-11-02T12:00:00.000Z' : '', offsiteStageConfidence: 'api',
      };
    },
  });
  inject('src/scrapers/dtna_enrich', {
    enrichDtna: async (url) => {
      rec.enrich.push(url);
      if (rec.onEnrich) rec.onEnrich(url);
      return { ok: true, offsiteText: 'DTNA case feed: battery tested, awaiting dealer diagnosis.', scrapedAt: new Date(FIXED).toISOString(), bestLabel: 'DTNA Case', offsiteStage: 'diagnosis' };
    },
  });
  inject('src/orcha/repair-history', {
    addEvent: (id, ev) => { rec.addEvent.push([id, clone(ev)]); },
  });
  inject('src/orcha/awareness/notifier', {
    getNotifier: () => ({ enqueue: (notes) => { rec.enqueue.push(clone(notes)); } }),
  });
  inject('src/scrapers/ready_pickup_notify', {
    onStageUpdate: (u) => { rec.onStageUpdate.push({ equipmentId: u.equipmentId, offsiteStage: u.offsiteStage, offsiteStageSince: u.offsiteStageSince }); },
    notifyReadyUnits: async () => { throw new Error('notifyReadyUnits not expected'); },
  });
}

// ── Rows ────────────────────────────────────────────────────────────────────
const DEC = (id) => 'https://volvo.decisiv.net/case/' + id;
const BASE_ROWS = [
  { equipmentId: 'U101', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite repair', vendor: 'Volvo', workRequestId: 'WR101', serviceState: 'Open', created: '10/28/2026', domicileSite: 'ABE40', fullConversation: 'Conversation\nVendor: air leak confirmed', offsiteShopEventUrl: DEC('U101'), asistNotes: 'Old cached dealer notes for U101 (stale).', asistScrapedAt: STALE },
  { equipmentId: 'U102', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite repair', vendor: 'Volvo', workRequestId: 'WR102', serviceState: 'Open', created: '10/29/2026', domicileSite: 'PHL40', fullConversation: 'Conversation\nVendor: CEL diag', offsiteShopEventUrl: DEC('U102'), asistNotes: 'Old cached dealer notes for U102 (stale).', asistScrapedAt: STALE },
  { equipmentId: 'U103', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite repair', vendor: 'Freightliner', workRequestId: 'WR103', serviceState: 'Open', created: '10/31/2026', domicileSite: 'ABE40', fullConversation: 'Conversation\nVendor: battery drain', offsiteShopEventUrl: 'https://dtna.my.site.com/Servicetracker/s/case/500U103', asistNotes: 'Old DTNA notes for U103 (stale cache).', asistScrapedAt: STALE },
  { equipmentId: 'U104', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite repair', vendor: 'TA', workRequestId: 'WR104', serviceState: 'Open', created: '10/30/2026', domicileSite: 'PHL40', fullConversation: 'Conversation\nVendor: AC inspected', offsiteShopEventUrl: DEC('U104'), asistNotes: 'Old cached dealer notes for U104 (stale).', asistScrapedAt: STALE },
  { equipmentId: 'U105', lifecycleState: 'Unavailable', lifecycleReason: 'Repair', vendor: 'Amerit', workRequestId: 'WR105', serviceState: 'Open', created: '10/25/2026', domicileSite: 'ABE40', fullConversation: '' },
  { equipmentId: 'U106', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite repair', vendor: 'Volvo', workRequestId: 'WR106', serviceState: 'Open', created: '10/26/2026', domicileSite: 'ABE40', fullConversation: 'Conversation\nVendor: waiting', offsiteShopEventUrl: DEC('U106'), asistNotes: 'Old cached dealer notes for U106 (stale).', asistScrapedAt: STALE },
  { equipmentId: 'U107', lifecycleState: 'Active', lifecycleReason: '', vendor: 'Amerit', workRequestId: 'WR107', serviceState: 'Closed', created: '10/01/2026', domicileSite: 'ABE40' },
  { equipmentId: 'U108', lifecycleState: 'Unavailable', lifecycleReason: 'Repair', vendor: 'Amerit', workRequestId: 'WR108', serviceState: 'Open', created: '10/20/2026', domicileSite: 'PHL40', fullConversation: 'Conversation\nVendor: unchanged' },
];

export function freshRows() { return clone(BASE_ROWS); }

// notesStore seed: U101 has a manual entry, U108 is unchanged since its last
// build (skip-unchanged path), U102 has a prior note. Must be called after
// setupClock() (the sig embeds today's date).
export function seedNotes(ds) {
  const rows = freshRows();
  const u108 = rows.find((r) => r.equipmentId === 'U108');
  const ns108 = { timeline: '10/20 - Work order created with Amerit.', issueSummary: 'Brake chamber' };
  ns108._dsInputSig = ds._aiInputSig(u108, ns108);
  return {
    U101: { manualEntries: ['10/29 - Called dealer; parts on order.'], notes: '' },
    U102: { notes: '10/29 - Check engine light', repairStatus: 'Under diagnosis' },
    U108: ns108,
  };
}

// ── Scenario runner ─────────────────────────────────────────────────────────
export const normStatus = (s) => String(s).replace(/ \u00B7 [^\u00B7]*$/, ' \u00B7 <time>');

export function stripSynced(p) {
  const c = clone(p);
  if (c && typeof c === 'object') delete c.syncedAt;
  return c;
}

// mode: 'fleet' | 'ondemand' | 'force'. opts.rows / opts.notes override the
// defaults (T5 run 2). Returns { promise, out } where out is filled as it runs.
export function startScenario(ds, mode, opts = {}) {
  const rows = opts.rows || freshRows();
  rec.store.set('notesStore', clone(opts.notes || seedNotes(ds)));
  const pushes = [];
  const statuses = [];
  const payload = { syncedAt: '2026-11-02T15:00:00.000Z', source: 'fixture' };
  const o = {
    pushData: (p) => pushes.push(stripSynced(p)),
    pushStatus: (s) => statuses.push(normStatus(s)),
    payload, uptakeCount: 2, relayCount: 0,
  };
  if (mode === 'fleet') o.durableScope = 'fleet';
  if (mode === 'ondemand') o.aiSource = 'deep_scan_unit';
  if (mode === 'force') o.force = true;
  const out = { pushes, statuses };
  const promise = ds.runOrchaDeepScan(rows, o);
  return { promise, out, rows };
}

export function collect(out, ret) {
  const dsLogs = rec.logs.filter((l) => l.ns === 'deep-scan');
  return {
    notesStore: clone(rec.store.get('notesStore')),
    pushData: out.pushes,
    pushDataCount: out.pushes.length,
    pushStatus: out.statuses,
    promptCount: rec.prompts.length,
    prompts: rec.prompts.map((p) => p.id + ':' + p.source),
    enrich: rec.enrich.slice(),
    addEvent: rec.addEvent,
    enqueue: rec.enqueue,
    onStageUpdate: rec.onStageUpdate,
    warn: dsLogs.filter((l) => l.level === 'warn' || l.level === 'error').map((l) => l.msg),
    info: dsLogs.filter((l) => l.level === 'info').map((l) => l.msg),
    ret,
  };
}

export async function runScenario(ds, mode, opts) {
  const { promise, out } = startScenario(ds, mode, opts);
  const ret = await promise;
  return collect(out, ret);
}
