// tests/fixtures/email-intel-fixture.js — shared fixture for the Email Triage
// Intelligence flag-OFF golden (plan.md FEAT-001 / design 12.3).
//   generator: tests/email-intel-baseline.gen.test.js  (FLEET_GEN_BASELINE=1, run once)
//   consumer : tests/email-intel-parity.test.js        (deep-equals tests/fixtures/email-intel-baseline.json)
//
// captureAll() drives the LEGACY email triage code (email_triage.js, email_intel.js,
// email_actions.js, owa_reader.js, ipc/email-triage.js, the overlay render helpers,
// preload bridge text, jobs status) against require-cache stubs for store, relay,
// reason, electron, logger, slack poller and supervisor. Only `Date` is frozen
// (plus setTimeout/clearTimeout inside the readInbox scenarios). No Outlook, no AI,
// no network, no disk writes: the stub store keeps documents in memory and records
// every save, which is what the "no new files" checks (N10) compare.
//
// IMPORTANT: this file must only call code that exists at the base commit. Later
// phases must keep every output of captureAll() byte-identical with flags OFF.
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { __test__ as overlay } from '../../renderer/src/js/components/email-triage-overlay.js';
const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXED = Date.parse('2026-11-04T15:04:05.000Z');
export function setupClock() { vi.useFakeTimers({ toFake: ['Date'], now: FIXED }); }
export function restoreClock() { vi.useRealTimers(); }

const norm = (x) => (x === undefined ? '<undefined>' : JSON.parse(JSON.stringify(x)));

// ── Recorders ──────────────────────────────────────────────────────────────────
export const rec = {
  logs: [], saves: [], handlers: {}, claims: [], sends: [], deletes: [], reads: [], reasonCalls: 0,
  reasonImpl: null,
};
const docs = new Map();

function resetRecorders() {
  rec.logs = []; rec.saves = []; rec.claims = []; rec.sends = []; rec.deletes = []; rec.reads = [];
  rec.reasonCalls = 0; rec.reasonImpl = null;
}

function memStore() {
  const api = {
    load(k, d) { return docs.has(k) ? JSON.parse(docs.get(k)) : (d !== undefined ? d : null); },
    save(k, v) { const s = JSON.stringify(v); docs.set(k, s); rec.saves.push(k); },
    exists(k) { return docs.has(k); },
    delete(k) { docs.delete(k); },
    update(k, fn, d) { const cur = api.load(k, d); const nx = fn(cur); const out = nx === undefined ? cur : nx; api.save(k, out); return out; },
  };
  return api;
}

function fakeLogger(ns) {
  const r = (level) => (...a) => rec.logs.push({ ns, level, msg: a.map(String).join(' ') });
  return { debug: r('debug'), info: r('info'), warn: r('warn'), error: r('error'), log: r('info') };
}
fakeLogger.createLogger = fakeLogger;
fakeLogger.setLogDir = () => {};
fakeLogger.setLevel = () => {};
fakeLogger.setSilent = () => {};
fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function inject(relFromRoot, exportsObj) {
  const resolved = require.resolve(relFromRoot === 'electron' ? relFromRoot : path.join(ROOT, relFromRoot));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
function forget(relFromRoot) {
  try { delete require.cache[require.resolve(path.join(ROOT, relFromRoot))]; } catch (_) { /* not loaded */ }
}

let _installed = false;
export function installStubs() {
  if (_installed) return;
  _installed = true;
  inject('src/utils/logger', fakeLogger);
  inject('src/store', memStore());
  inject('src/orcha/relay', {
    askWithTimeout: async () => '', ask: async () => '', getStatus: () => ({ backends: { orcha: true } }),
  });
  inject('src/orcha/reason', { reason: async (o) => { rec.reasonCalls++; return rec.reasonImpl ? rec.reasonImpl(o) : { ok: false }; } });
  inject('src/slack/poller', { getMode: () => 'off' });
  inject('src/workers/supervisor', {
    claim: (spec) => { rec.claims.push(Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'function' ? '<fn>' : v]))); return false; },
    stop: () => {}, getStatus: () => ({ workers: [] }),
  });
  inject('electron', {
    ipcMain: { handle: (ch, fn) => { rec.handlers[ch] = fn; } },
    BrowserWindow: { getAllWindows: () => [] },
  });
}

// Fresh copies of the legacy modules so module state (in-flight guards, status
// counters, armed timers) never leaks between scenarios or between captures.
const LEGACY = ['src/scrapers/email_triage', 'src/scrapers/email_intel', 'src/scrapers/email_actions', 'src/ipc/email-triage'];
let ow;
let realReadInbox;
let realDeleteMessage;
let owaMailer;
let realSendViaOwa;
let realWarm;
export function freshLegacy() {
  for (const m of LEGACY) forget(m);
  const triage = require(path.join(ROOT, 'src/scrapers/email_triage'));
  const actions = require(path.join(ROOT, 'src/scrapers/email_actions'));
  const intel = require(path.join(ROOT, 'src/scrapers/email_intel'));
  if (!ow) {
    ow = require(path.join(ROOT, 'src/scrapers/owa_reader'));
    owaMailer = require(path.join(ROOT, 'src/scrapers/owa-mailer'));
    realReadInbox = ow.readInbox; realDeleteMessage = ow.deleteMessage;
    realSendViaOwa = owaMailer.sendViaOwa; realWarm = owaMailer.warmOwaSession;
  }
  return { triage, actions, intel };
}
export function freshIpc() {
  rec.handlers = {};
  const m = require(path.join(ROOT, 'src/ipc/email-triage'));
  m.registerEmailTriageIPC({});
  return m;
}
export const call = (ch, ...args) => rec.handlers[ch]({}, ...args);

export function resetWorld(seed) {
  docs.clear();
  resetRecorders();
  for (const [k, v] of Object.entries(seed || {})) docs.set(k, JSON.stringify(v));
  rec.saves = [];
}
export const doc = (k) => (docs.has(k) ? JSON.parse(docs.get(k)) : '<absent>');

// ── Synthetic data ─────────────────────────────────────────────────────────────
const ROWS = [
  { equipmentId: '40123', operator: 'ACME', domicileSite: 'ABE1', repairTimeline: '' },
  { equipmentId: '40456', operator: 'BETA', domicileSite: 'AVP4' },
  { equipmentId: '40789', operator: 'ACME', domicileSite: 'ABE1' },
  { equipmentId: '40999', operator: 'GAMMA', domicileSite: 'TUZR' },
];
const CANON = {
  units: {
    '40123': { repairPhase: 'awaiting_parts', waitingOnFine: 'dealer', status: 'down', lastMeaningfulUpdate: { source: 'relay', text: 'Parts on order', at: 'Nov 4, 2026 02:00 PM' } },
    '40456': { repairPhase: 'ready_for_pickup', waitingOnFine: 'unknown', status: 'ready', lastMeaningfulUpdate: { source: 'relay', text: 'Ready', at: 'Nov 4, 2026 02:00 PM' } },
  },
};
const filler = (n) => ('Please see the thread below for the routine weekly status. '.repeat(Math.ceil(n / 58))).slice(0, n);
const mkEmail = (o) => ({
  id: o.id, convId: o.convId || '', from: o.from || 'dealer@example.test', fromName: o.fromName || 'Dealer Co',
  subject: o.subject, receivedText: o.receivedText || '18:09', bodyText: o.bodyText, folder: o.folder || 'Inbox',
  attachments: o.attachments || [],
});
const EMAILS = [
  mkEmail({ id: 'em_a1', convId: 'conv/a1=', subject: 'Unit 40123 parts update', bodyText: 'Parts arrived for 40123, repair starts Monday.' }),
  mkEmail({ id: 'em_a2', convId: 'conv/a2=', from: 'vendor@example.test', fromName: 'Vendor Rep', subject: 'Estimate for 40123', bodyText: 'Estimate $1,840 attached for 40123, please approve.', attachments: [{ name: 'Estimate_40123.pdf', ext: 'pdf', type: 'document' }] }),
  mkEmail({ id: 'em_a3', convId: 'conv/a3=', from: 'news@example.test', fromName: 'Weekly News', subject: 'Weekly newsletter', bodyText: 'Top stories this week. Unsubscribe anytime.' }),
  mkEmail({ id: 'em_a4', convId: 'conv/a4=', subject: 'Weekly status', bodyText: filler(1600) + ' Unit 40789 will be ready 11/15.' }),
  mkEmail({ id: 'em_a5', convId: 'conv/a5=', subject: 'Other region unit', bodyText: 'Unit 51888 is waiting on a turbo.' }),
  mkEmail({ id: 'em_a6', convId: 'conv/a6=', fromName: 'Shop Lead', subject: 'Unit 40456 is ready', bodyText: 'Unit 40456 repaired and available for pickup now.', attachments: [{ name: 'photo.jpg', ext: 'jpg', type: 'image' }] }),
  mkEmail({ id: 'em_a7', convId: 'conv/a7=', fromName: 'Coworker', subject: 'Question on 40123', bodyText: 'Can someone check the DPF on 40123? Dealer says ETA 11/14.' }),
];
const VERDICTS = {
  em_a1: { summary: 'Dealer says parts arrived for 40123.', scope: 'mine', category: 'fleet_status_update', informationType: 'new', importance: 'high', importanceWhy: 'dealer update', confidence: 0.9, unitRefs: [{ unit: '40123', update: '11/04 - parts arrived, repair starts Monday', ready: false }] },
  em_a2: { summary: 'Vendor estimate awaiting approval.', scope: 'mine', category: 'estimate_or_approval', intent: 'request_approval', informationType: 'new', importance: 'high', confidence: 0.9, decisionRequired: true, unitRefs: [{ unit: '40123', update: '11/04 - estimate received', ready: false }] },
  em_a3: { summary: 'Newsletter.', importance: 'low', deleteSuggested: true, confidence: 0.95, unitRefs: [] },
  em_a4: { summary: 'Status mentions 40789.', scope: 'mine', informationType: 'new', importance: 'normal', unitRefs: [{ unit: '40789', update: '11/04 - ready 11/15', ready: false }] },
  em_a5: { summary: 'Out of region unit.', scope: 'other_region', importance: 'low', confidence: 0.8, unitRefs: [{ unit: '51888', update: '11/04 - turbo', ready: false }] },
  em_a6: { summary: 'Unit ready.', scope: 'mine', category: 'ready_for_pickup', informationType: 'status_change', importance: 'high', confidence: '0.9', unitRefs: [{ unit: '40456', update: '11/04 - ready for pickup', ready: true }] },
  em_a7: { summary: 'Question about 40123.', scope: 'mine', category: 'question', informationType: 'new', importance: 'normal', confidence: 1.7, replySuggested: true, unitRefs: [{ unit: '40123', update: '11/04 - DPF ETA 11/14', ready: false }] },
};
const idsInPrompt = (prompt) => Array.from(String(prompt).matchAll(/^id: (\S+)$/gm)).map((m) => m[1]);
const reasonFromVerdicts = (map) => async (o) => ({
  ok: true, data: { emails: idsInPrompt(o.prompt).filter((id) => map[id]).map((id) => ({ id, ...map[id] })) },
});

const LEARNING = {
  deleted: { 'news.example.test': { count: 3, lastAt: '2026-11-01T00:00:00.000Z', samples: ['Weekly newsletter'] } },
  kept: { 'dealer.example.test': { count: 2, lastAt: '2026-11-02T00:00:00.000Z' } },
  keywords: { deleted: { weekly: 3, newsletter: 3 }, kept: { parts: 2 } },
};

// ── N1 prompt ──────────────────────────────────────────────────────────────────
function captureN1() {
  const out = {};
  const unitIds = ROWS.map((r) => r.equipmentId);
  resetWorld({});
  const { triage } = freshLegacy();
  out.learningEmpty = triage.buildTriagePrompt(EMAILS, unitIds);
  out.noUnits = triage.buildTriagePrompt(EMAILS.slice(0, 1), []);
  resetWorld({ emailTriageLearning: LEARNING });
  out.learningPresent = triage.buildTriagePrompt(EMAILS, unitIds);
  out.learningSummary = triage._learningSummary();
  return out;
}

// ── N2 verdict / fallback / decision ───────────────────────────────────────────
function captureN2() {
  resetWorld({ canonicalState: CANON });
  const { triage } = freshLegacy();
  const email = EMAILS[0];
  const base = VERDICTS.em_a1;
  const confidences = { missing: undefined, valid09: 0.9, valid05: 0.5, string09: '0.9', over: 1.7, negative: -1, zero: 0, nullv: null, text: 'high' };
  const out = { merge: {}, decision: {}, fallback: {}, mergeNoSummary: {} };
  for (const [name, c] of Object.entries(confidences)) {
    const v = { ...base }; if (c !== undefined) v.confidence = c; else delete v.confidence;
    out.merge[name] = norm(triage._mergeVerdict(email, v, ROWS));
    const refs = [{ unit: '40123', operator: 'ACME', domicile: 'ABE1', update: base.unitRefs[0].update, ready: false }];
    out.decision[name] = norm(triage._buildDecision(email, v, ROWS, refs));
    const vNoSum = { ...v }; delete vNoSum.summary;
    out.mergeNoSummary[name] = norm(triage._buildDecision(email, vNoSum, ROWS, refs).confidence);
  }
  for (const e of EMAILS) {
    out.fallback[e.id] = norm(triage._fallbackVerdict(e, ROWS));
    out.merge[e.id] = norm(triage._mergeVerdict(e, VERDICTS[e.id], ROWS));
  }
  out.decisionNoVerdict = norm(triage._buildDecision(EMAILS[1], {}, ROWS, [{ unit: '40123', operator: 'ACME', domicile: 'ABE1', update: 'x', ready: false }]));
  out.decisionNoRefs = norm(triage._buildDecision(EMAILS[2], {}, ROWS, []));
  out.canon = norm(triage._canonFor('40123'));
  out.canonMissing = norm(triage._canonFor('99999'));
  return out;
}

// ── N3 runTriage persisted results ─────────────────────────────────────────────
async function captureN3() {
  const out = {};
  const seed = { fleetData: { rows: ROWS }, canonicalState: CANON };
  resetWorld(seed);
  const { triage } = freshLegacy();
  rec.reasonImpl = reasonFromVerdicts(VERDICTS);
  const snap = () => ({ stored: doc('emailTriageResults'), saves: rec.saves.slice() });
  const read = (emails) => ({ _readInbox: async () => ({ ok: true, emails }) });

  out.first = norm(await triage.runTriage(read(EMAILS)));
  out.firstStored = snap();
  // The user engages with one email, then the same ids are rescanned.
  const stored = doc('emailTriageResults');
  stored.emails = stored.emails.map((e) => (e.id === 'em_a1' ? { ...e, replyDraft: 'Thanks', replyState: 'drafted', unitUpdateApplied: true, readyDmSent: true, firstSeenAt: '2026-11-01T00:00:00.000Z' } : e));
  docs.set('emailTriageResults', JSON.stringify(stored));
  vi.setSystemTime(FIXED + 3600 * 1000);
  rec.saves = [];
  out.rescanSameIds = norm(await triage.runTriage(read(EMAILS)));
  out.rescanSameIdsStored = snap();
  // Changed content under the same id (today's inheritance quirk).
  vi.setSystemTime(FIXED + 2 * 3600 * 1000);
  const changed = EMAILS.map((e) => (e.id === 'em_a1' ? { ...e, bodyText: 'Update: part is delayed again, new ETA 11/20 for 40123.' } : e));
  const verdicts2 = { ...VERDICTS, em_a1: { ...VERDICTS.em_a1, summary: 'Part delayed again.', unitRefs: [{ unit: '40123', update: '11/04 - part delayed to 11/20', ready: false }] } };
  rec.reasonImpl = reasonFromVerdicts(verdicts2);
  rec.saves = [];
  out.rescanChangedContent = norm(await triage.runTriage(read(changed)));
  out.rescanChangedContentStored = snap();
  // A new email arrives; an older one falls out of the window but is kept.
  vi.setSystemTime(FIXED + 3 * 3600 * 1000);
  rec.saves = [];
  out.rescanWindowSlide = norm(await triage.runTriage(read([EMAILS[4], EMAILS[5]])));
  // AI unavailable -> deterministic fallback.
  resetWorld(seed);
  vi.setSystemTime(FIXED);
  const f = freshLegacy().triage;
  rec.reasonImpl = async () => ({ ok: false });
  out.aiDown = norm(await f.runTriage(read(EMAILS)));
  out.aiDownReasonCalls = rec.reasonCalls;
  // Read failure, auth wall, empty read, chrome rows.
  resetWorld(seed);
  const g = freshLegacy().triage;
  out.readThrows = norm(await g.runTriage({ _readInbox: async () => { throw new Error('boom'); } }));
  out.authBlocked = norm(await g.runTriage({ _readInbox: async () => ({ authBlocked: true, error: 'auth wall' }) }));
  out.emptyRead = norm(await g.runTriage({ _readInbox: async () => ({ ok: false, emails: [], error: 'no messages read' }) }));
  rec.reasonImpl = reasonFromVerdicts(VERDICTS);
  out.chromeRows = norm(await g.runTriage(read([
    { id: 'em_chrome', subject: 'Navigation pane', from: '', fromName: '', bodyText: '' },
    { id: 'em_empty', subject: 'x', from: '', fromName: '', bodyText: 'short' },
    EMAILS[2],
  ])));
  out.readArgs = null;
  const seen = [];
  await g.runTriage({ max: 7, folders: ['Inbox', 'Relay Garage'], _electron: 'E', _readInbox: async (o) => { seen.push(o); return { emails: [] }; } });
  out.readArgs = norm(seen);
  vi.setSystemTime(FIXED);
  return out;
}

// ── N4 applyPendingUnitUpdates + gate outcomes ─────────────────────────────────
function snapshotWrites() {
  return {
    notesStore: doc('notesStore'), fleetTimelines: ((doc('fleetData') || {}).rows || []).map((r) => [r.equipmentId, r.repairTimeline || '']),
    emailEvidence: doc('emailEvidence'), repairHistory: doc('repairHistory'),
    results: doc('emailTriageResults'), saves: rec.saves.slice(),
  };
}
async function seedScanned(cfg) {
  const seed = { fleetData: { rows: ROWS.map((r) => ({ ...r })) }, canonicalState: CANON };
  if (cfg) seed.emailTriageConfig = cfg;
  resetWorld(seed);
  const mods = freshLegacy();
  rec.reasonImpl = reasonFromVerdicts(VERDICTS);
  await mods.triage.runTriage({ _readInbox: async () => ({ emails: EMAILS }) });
  mods.scanSaves = rec.saves.slice();
  rec.saves = [];
  return mods;
}
async function captureN4() {
  const out = {};
  {
    const { triage } = await seedScanned();
    const results = triage.loadResults();
    out.directApplied = triage.applyPendingUnitUpdates(results);
    out.direct = norm(snapshotWrites());
    rec.saves = [];
    out.directAgain = triage.applyPendingUnitUpdates(triage.loadResults());
    out.directAgainSaves = rec.saves.slice();
    out.nullInput = [triage.applyPendingUnitUpdates(null), triage.applyPendingUnitUpdates({}), triage.applyPendingUnitUpdates({ emails: 'x' })];
  }
  // Gate outcomes through the two legacy call sites for autoApplyUnitUpdates true AND false (F2-01).
  out.gate = {};
  for (const flag of [true, false]) {
    const cfg = { enabled: true, autoScan: true, autoApplyUnitUpdates: flag, folders: ['Inbox'], maxEmails: 25 };
    const label = 'autoApply' + (flag ? 'True' : 'False');
    {
      const { triage } = await seedScanned(cfg);
      freshIpc();
      ow.readInbox = async () => ({ ok: true, emails: EMAILS });
      try {
        const r = await call('emailTriage:run', {});
        out.gate[label + '_ipcRun'] = norm({ returnedEmails: r.emails.map((e) => [e.id, !!e.unitUpdateApplied, e.autoApplyBlocked || null]), writes: snapshotWrites() });
      } finally { ow.readInbox = realReadInbox; triage.stopAutoScan(); }
    }
    {
      const { triage } = await seedScanned(cfg);
      ow.readInbox = async () => ({ ok: true, emails: EMAILS });
      try {
        await triage._autoTick();
        out.gate[label + '_autoTick'] = norm({ writes: snapshotWrites() });
      } finally { ow.readInbox = realReadInbox; triage.stopAutoScan(); }
    }
  }
  // Disabled / autoScan off tick is a no-op.
  {
    const { triage } = await seedScanned({ enabled: true, autoScan: false });
    let reads = 0;
    ow.readInbox = async () => { reads++; return { emails: EMAILS }; };
    try { await triage._autoTick(); } finally { ow.readInbox = realReadInbox; triage.stopAutoScan(); }
    out.autoTickScanOff = { reads, saves: rec.saves.slice() };
  }
  return out;
}

// ── N5 owa_reader pins and behavior ────────────────────────────────────────────
function sliceFunction(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = text.indexOf('{', text.indexOf(')', start));
  const open = i; let depth = 0; let state = null;
  for (; i < text.length; i++) {
    const c = text[i]; const n = text[i + 1];
    if (state === 'line') { if (c === '\n') state = null; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = null; i++; } continue; }
    if (state) { if (c === '\\') { i++; continue; } if (c === state) state = null; continue; }
    if (c === '/' && n === '/') { state = 'line'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block'; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { state = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  throw new Error('unbalanced function: ' + name + ' from ' + open);
}
export function owaReaderPins() {
  const file = path.join(ROOT, 'src/scrapers/owa_reader.js');
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    functions: {
      _buildRowScanScript: sliceFunction(text, '_buildRowScanScript'),
      _buildOpenAndReadScript: sliceFunction(text, '_buildOpenAndReadScript'),
      _buildReadPaneScript: sliceFunction(text, '_buildReadPaneScript'),
    },
  };
}

const ARIA = [
  'Unread Has attachments Dealer Co Unit# 40123 parts update 18:09 Parts arrived, repair starts Monday.',
  'Hunter Buffalo Peterbilt RE: Estimate for 40123 Mon 10/6 Please approve the attached estimate',
  'Smith, John FW: Weekly status Oct 9 See below',
  'Has attachments Unread Gabrielli Truck Sales Ridgefield Park Invoice 12345 10/6/2026 Invoice attached',
  'Notifications Your report is ready 6:09 PM Click to view',
  '',
  'OnlyOneToken',
];
const FOLDER_ROWS = {
  Inbox: [0, 1, 2, 3, 4, 5].map((i) => ({ index: i, convId: 'inbox/' + i + '=', aria: 'Unread Dealer Co Unit# 4012' + i + ' parts update 18:0' + i + ' preview text ' + i, preview: 'preview ' + i, hasAttach: i % 2 === 0 })),
  'Relay Garage': [0, 1].map((i) => ({ index: i, convId: 'relay/' + i + '=', aria: 'Relay Bot Garage note ' + i + ' 09:1' + i + ' garage preview ' + i, preview: 'g ' + i, hasAttach: false })),
  AVP40: [0, 1].map((i) => ({ index: i, convId: 'avp/' + i + '=', aria: 'Site Lead AVP40 item ' + i + ' 10:2' + i + ' avp preview ' + i, preview: 'a ' + i, hasAttach: false })),
};

class FakeWindow {
  constructor(world) {
    this.world = world; this.url = ''; this.destroyed = false; this.handlers = {}; this.folder = 'Inbox'; this.row = 0;
    const self = this;
    this.webContents = {
      setWindowOpenHandler() {}, on(evt, fn) { (self.handlers[evt] = self.handlers[evt] || []).push(fn); },
      getURL: () => self.url,
      executeJavaScript: async (script) => self.exec(String(script)),
    };
  }
  on() {} hide() {} isDestroyed() { return this.destroyed; } close() { this.destroyed = true; }
  loadURL(url) {
    this.url = url;
    Promise.resolve().then(() => { for (const fn of (this.handlers['did-finish-load'] || [])) fn(); });
  }
  exec(script) {
    const w = this.world;
    w.scripts++;
    if (script.includes('? "yes" : "no"')) return 'yes';
    if (script.includes('var want = ')) {
      const want = JSON.parse(script.match(/var want = (".*?");/)[1]);
      const hit = Object.keys(w.folders).find((f) => f.toLowerCase() === want);
      w.clicks.push(want);
      if (!hit) return 'not-found';
      this.folder = hit; return 'clicked';
    }
    if (script.includes('out.push({ index:i')) {
      const max = parseInt(script.match(/out\.length<(\d+)/)[1], 10);
      return JSON.stringify((w.folders[this.folder] || []).slice(0, max));
    }
    if (script.includes('clickTarget.click()')) { this.row = parseInt(script.match(/rows\[(\d+)\]/)[1], 10); return JSON.stringify({ clicked: true }); }
    if (script.includes('UniqueMessageBody')) {
      const r = (w.folders[this.folder] || [])[this.row] || {};
      return JSON.stringify({ subject: 'Subject ' + this.folder + ' ' + this.row, from: 'sender' + this.row + '@example.test', fromName: 'Sender ' + this.row, receivedText: '2026-11-04T1' + this.row + ':00:00Z', bodyText: 'Full body for ' + (r.convId || '?') + ' ' + 'x'.repeat(60), attachments: this.row === 0 ? [{ name: 'Estimate_40123.pdf', ext: 'pdf' }] : [] });
    }
    return '';
  }
}

async function runReadInbox(opts, folders, warm) {
  const world = { folders, scripts: 0, clicks: [] };
  const wins = [];
  const electron = {
    session: { defaultSession: {} },
    BrowserWindow: function BW() { const w = new FakeWindow(world); wins.push(w); return w; },
  };
  owaMailer.warmOwaSession = async () => warm;
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: FIXED });
  try {
    let done = false; let value;
    const p = realReadInbox({ ...opts, _electron: electron }).then((v) => { done = true; value = v; });
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(500);
    await p;
    return norm({ result: value, folderClicks: world.clicks, windowClosed: wins.length ? wins[0].destroyed : null, windows: wins.length });
  } finally {
    owaMailer.warmOwaSession = realWarm;
    vi.useRealTimers();
    setupClock();
  }
}

async function captureN5() {
  resetWorld({});
  freshLegacy();
  const out = { pins: owaReaderPins() };
  out.aria = ARIA.map((a) => norm(ow._parseAriaLabel(a)));
  out.guessSender = ['Last, First Re: x', 'Hunter Buffalo Peterbilt Unit# 5', '', 'A B C D E F'].map((h) => ow._guessSender(h));
  out.normalize = [
    norm(ow._normalizeEmail({ subject: 'S', from: 'A@Example.test', fromName: 'A', receivedText: '18:09', bodyText: 'b', attachments: [{ name: 'a.pdf', ext: 'pdf' }, { name: 'p.png', ext: 'png' }, { name: 'z.bin', ext: 'bin' }] }, { convId: 'c1=' })),
    norm(ow._normalizeEmail({ bodyText: 'only body' }, { aria: ARIA[0] })),
    norm(ow._normalizeEmail({ subject: '', from: '' }, null)),
  ];
  out.hash = ['', 'abc', 'conv/a1='].map((s) => ow._hash(s));
  out.attachmentType = ['png', 'pdf', 'zip', ''].map((e) => ow._attachmentType(e));
  out.scripts = {
    folderClick: ow._buildFolderClickScript('Relay Garage'),
    folderClickEmpty: ow._buildFolderClickScript(''),
    selectRow: ow._buildSelectRowScript('AAQkAD/abc='),
    deleteClick: ow._buildDeleteClickScript(),
    rowSelector: ow.ROW_SELECTOR,
    inboxUrl: ow.INBOX_URL,
  };
  const warmOk = { ok: true, authWall: false };
  out.readInbox = {
    starvation: await runReadInbox({ max: 4, folders: ['Inbox', 'Relay Garage', 'AVP40'] }, FOLDER_ROWS, warmOk),
    fairWhenSmall: await runReadInbox({ max: 10, folders: ['Inbox', 'Relay Garage', 'AVP40'] }, { ...FOLDER_ROWS, Inbox: FOLDER_ROWS.Inbox.slice(0, 2) }, warmOk),
    folderMissing: await runReadInbox({ max: 10, folders: ['Relay Garage', 'Nope', 'AVP40'] }, FOLDER_ROWS, warmOk),
    dedupeFolders: await runReadInbox({ max: 3, folders: ['Inbox', 'inbox', 'Inbox'] }, FOLDER_ROWS, warmOk),
    warmupAuthWall: await runReadInbox({ max: 5, folders: ['Inbox'] }, FOLDER_ROWS, { ok: false, authWall: true, url: 'https://login.microsoftonline.com/x' }),
    empty: await runReadInbox({ max: 5, folders: ['Inbox'] }, { Inbox: [] }, warmOk),
  };
  return out;
}

// ── N6 sendReply and the send-reply handler patch ─────────────────────────────
export async function captureN6() {
  const out = { actions: {}, handler: {} };
  const base = { id: 'em_a1', convId: 'conv/a1=', from: 'dealer@example.test', fromName: 'Dealer Co', subject: 'Unit 40123 parts update', replyDraft: 'Thanks <b>&</b>' };
  const statuses = { sent: { status: 'sent' }, blockedAuth: { status: 'blocked-auth' }, uncertain: { status: 'delivery-uncertain' }, failed: { status: 'failed-before-send' }, unknown: {}, nullResult: null };
  for (const [name, res] of Object.entries(statuses)) {
    resetWorld({ fleetData: { rows: ROWS }, emailTriageResults: { emails: [base], ranAt: 'x', authBlocked: false } });
    const { actions } = freshLegacy();
    owaMailer.sendViaOwa = async (a) => { rec.sends.push(a); return res; };
    try {
      const r = await actions.sendReply(base, 'Body <i>1</i> & more', { _electron: 'E' });
      out.actions[name] = norm({ result: r, sends: rec.sends });
    } finally { owaMailer.sendViaOwa = realSendViaOwa; }
  }
  {
    const { actions } = freshLegacy();
    owaMailer.sendViaOwa = async (a) => { rec.sends.length = 0; rec.sends.push(a); return { status: 'sent' }; };
    try {
      out.actions.guards = norm({
        noEmail: await actions.sendReply(null, 'x'),
        emptyBody: await actions.sendReply(base, '   '),
        noFrom: await actions.sendReply({ ...base, from: '' }, 'x'),
        badFrom: await actions.sendReply({ ...base, from: 'Dealer Co' }, 'x'),
        rePrefix: [await actions.sendReply({ ...base, subject: 'RE: already' }, 'x'), rec.sends.slice()],
        noSubject: [await actions.sendReply({ ...base, subject: '' }, 'x'), rec.sends.slice()],
      });
    } finally { owaMailer.sendViaOwa = realSendViaOwa; }
  }
  for (const [name, res] of Object.entries(statuses)) {
    resetWorld({ fleetData: { rows: ROWS }, emailTriageResults: { emails: [base, { ...base, id: 'em_other' }], ranAt: 'x', authBlocked: false } });
    freshLegacy(); freshIpc();
    owaMailer.sendViaOwa = async (a) => { rec.sends.push(a); return res; };
    try {
      const r = await call('emailTriage:send-reply', 'em_a1', 'Edited reply body');
      out.handler[name] = norm({ result: r, sends: rec.sends, results: doc('emailTriageResults'), saves: rec.saves });
    } finally { owaMailer.sendViaOwa = realSendViaOwa; }
  }
  resetWorld({ emailTriageResults: { emails: [base], ranAt: 'x', authBlocked: false } });
  freshLegacy(); freshIpc();
  owaMailer.sendViaOwa = async (a) => { rec.sends.push(a); return { status: 'sent' }; };
  try {
    out.handler.useDraftWhenBodyOmitted = norm({ result: await call('emailTriage:send-reply', 'em_a1', ''), sends: rec.sends, results: doc('emailTriageResults') });
    out.handler.notFound = norm(await call('emailTriage:send-reply', 'nope', 'x'));
    out.handler.badId = norm(await call('emailTriage:send-reply', 5, 'x'));
    resetWorld({ emailTriageResults: { emails: [{ ...base, replyDraft: '' }], ranAt: 'x', authBlocked: false } });
    out.handler.emptyBody = norm(await call('emailTriage:send-reply', 'em_a1', ''));
  } finally { owaMailer.sendViaOwa = realSendViaOwa; }
  return out;
}

// ── N7 IPC channels, N8 preload keys, N11 supervisor claim ────────────────────
function preloadKeys(name) {
  const text = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const start = text.indexOf("expose('" + name + "', {");
  if (start < 0) return null;
  const end = text.indexOf('\n});', start);
  const block = text.slice(start, end);
  return Array.from(block.matchAll(/^\s{2}(\w+):/gm)).map((m) => m[1]);
}
export { preloadKeys, overlay as overlayFns, ROWS as FLEET_ROWS, EMAILS as FIXTURE_EMAILS };

function captureN7N11() {
  resetWorld({});
  const { triage } = freshLegacy();
  const m = freshIpc();
  const channels = Object.keys(rec.handlers);
  const claims = rec.claims.map((c) => norm(c));
  triage.stopAutoScan();
  const statusKeys = Object.keys(triage.getAutoScanStatus());
  const status = norm(triage.getAutoScanStatus());
  return {
    n7: { exports: Object.keys(m), channels },
    n11: { claims, statusKeys, status },
  };
}

// ── N9 overlay render ──────────────────────────────────────────────────────────
function captureN9() {
  const { _cardHtml, _replyButtonHtml, _replyPanelHtml } = overlay;
  const baseRec = {
    id: 'em_a6', from: 'shop@example.test', fromName: 'Shop <Lead>', subject: 'Unit "40456" & ready', summary: 'Unit ready.', importance: 'high', importanceWhy: 'ready',
    folder: 'Relay Garage', receivedText: '18:09', triagedAt: '2026-11-04T15:04:05.000Z', replyDraft: 'Draft <text> & "quote"',
    attachments: [{ name: 'photo.jpg', type: 'image' }, { name: 'Estimate.pdf', type: 'document' }, { name: 'x.bin', type: 'file' }],
    unitRefs: [{ unit: '40456', operator: 'BETA', update: '11/04 - ready', ready: true }, { unit: '40123', operator: '', update: '', ready: false, readyDmSent: true }],
  };
  const states = [undefined, 'none', 'drafted', 'sent', 'dismissed'];
  const flags = { plain: {}, suggestedDelete: { deleteSuggested: true }, kept: { deleteSuggested: true, kept: true }, deleted: { deleted: true }, applied: { unitUpdateApplied: true } };
  const out = {};
  for (const st of states) {
    for (const rs of [true, false]) {
      for (const [fname, f] of Object.entries(flags)) {
        const r = { ...baseRec, replySuggested: rs, ...f };
        if (st !== undefined) r.replyState = st;
        out[String(st) + '|' + (rs ? 'suggested' : 'plain') + '|' + fname] = { card: _cardHtml(r), button: _replyButtonHtml(r), panel: _replyPanelHtml(r) };
      }
    }
  }
  out.minimal = { card: _cardHtml({ id: 'm', subject: 's' }), button: _replyButtonHtml({ id: 'm' }), panel: _replyPanelHtml({ id: 'm' }) };
  return out;
}

// ── N10 data-dir writes per flow ───────────────────────────────────────────────
async function captureN10() {
  const out = {};
  {
    const seeded = await seedScanned({ enabled: true, autoScan: true, autoApplyUnitUpdates: true });
    out.scanSaves = seeded.scanSaves;
  }
  {
    const { triage } = await seedScanned();
    freshIpc();
    // _mergeVerdict does not carry convId through (base behavior), so seed it the way a live record would have it.
    const results = doc('emailTriageResults');
    results.emails = results.emails.map((e) => ({ ...e, convId: (EMAILS.find((x) => x.id === e.id) || {}).convId || '', deleteSuggested: e.deleteSuggested || e.id === 'em_a5' }));
    docs.set('emailTriageResults', JSON.stringify(results));
    ow.deleteMessage = async (a) => { rec.deletes.push(a); return a.convId === 'conv/a3=' ? { ok: true } : { ok: false, error: 'nope' }; };
    try {
      rec.saves = [];
      const one = await call('emailTriage:delete', 'em_a3');
      const fail = await call('emailTriage:delete', 'em_a1');
      const keep = await call('emailTriage:keep', 'em_a3');
      const batch = await call('emailTriage:delete-suggested');
      out.deleteFlow = norm({ one, fail, keep, batch, deletes: rec.deletes, saves: rec.saves, suggestedBefore: results.emails.filter((e) => e.deleteSuggested).map((e) => e.id), learning: doc('emailTriageLearning') });
    } finally { ow.deleteMessage = realDeleteMessage; triage.stopAutoScan(); }
  }
  {
    const { triage } = await seedScanned({ enabled: true, autoScan: true, autoApplyUnitUpdates: true });
    ow.readInbox = async () => ({ ok: true, emails: EMAILS });
    try { rec.saves = []; await triage._autoTick(); out.autoTickSaves = rec.saves.slice(); } finally { ow.readInbox = realReadInbox; triage.stopAutoScan(); }
  }
  {
    resetWorld({ fleetData: { rows: ROWS }, emailTriageResults: { emails: [], ranAt: null, authBlocked: false } });
    const { triage } = freshLegacy(); freshIpc();
    ow.readInbox = async () => ({ ok: true, emails: EMAILS });
    rec.reasonImpl = reasonFromVerdicts(VERDICTS);
    try { await call('emailTriage:set-config', { enabled: true, folders: ['Inbox', ' ', 'Inbox', 'AVP40'], maxEmails: 99, autoScanMinutes: 5 }); out.configSaves = rec.saves.slice(); out.config = doc('emailTriageConfig'); }
    finally { ow.readInbox = realReadInbox; triage.stopAutoScan(); }
  }
  // Distinct store keys (= files in the data dir) written by all flag-OFF flows. SQLite-backed keys never appear.
  out.dataFilesWritten = Array.from(new Set([].concat(out.scanSaves, out.deleteFlow.saves, out.autoTickSaves, out.configSaves))).sort();
  return out;
}

// ── N14 jobs status ────────────────────────────────────────────────────────────
function captureN14() {
  const jobs = require(path.join(ROOT, 'src/jobs'));
  const pf = require(path.join(ROOT, 'src/config/perf-flags'));
  jobs._resetForTests({ flags: { enabled: false, types: {} }, now: () => FIXED });
  const init = jobs.init();
  const out = norm({ init, status: jobs.getStatus(), summary: jobs.getSummary(FIXED), jobTypes: pf.JOB_TYPES, jobEnv: pf.JOB_ENV, resolveJobsDefault: pf.resolveJobsFlags({}, {}) });
  jobs._resetForTests();
  return out;
}

/** Everything the parity suite compares. Deterministic; safe to call more than once per process. */
export async function captureAll() {
  installStubs();
  setupClock();
  try {
    const out = {};
    out.N1 = captureN1();
    out.N2 = captureN2();
    out.N3 = await captureN3();
    out.N4 = await captureN4();
    out.N5 = await captureN5();
    out.N6 = await captureN6();
    Object.assign(out, (() => { const r = captureN7N11(); return { N7: r.n7, N11: r.n11 }; })());
    out.N8 = { emailTriageKeys: preloadKeys('emailTriage') };
    out.N9 = captureN9();
    out.N10 = await captureN10();
    out.N14 = captureN14();
    return out;
  } finally {
    restoreClock();
  }
}
