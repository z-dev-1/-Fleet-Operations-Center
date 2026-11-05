'use strict';
// tests/helpers/orcha-action-harness.cjs — loads the REAL src/ipc/ai.js
// (processOrchaAction) with every heavy dependency replaced through
// require.cache, so a test can record the exact prompt, relay options and store
// saves. Used by T-PARITY-PROMPT (goldens captured from the unmodified ai.js at
// f839cd2) and by the Just Me context injection/memory tests.
//
// Fakes installed at the real resolved paths (all required, documented here):
//   electron                         { BrowserWindow.getAllWindows() -> [], screen, session } — ai.js
//                                    destructures it at load and the action loop calls getAllWindows().
//   src/store                        in-memory load/save; load returns a JSON copy, save records a JSON
//                                    copy in `saves` (never vi.mock of src/store).
//   src/orcha/relay                  records ask(prompt, opts); isolatedLaneAvailable() is configurable.
//                                    Skipped when opts.realRelay is true (the test drives the real relay).
//   src/orcha/ai-context             resolveEntities: whole-token match of the seeded equipment ids /
//                                    sites / operators; buildFleetContext: a fixed marker string.
//   src/orcha/awareness/context-block buildAwarenessBlock -> { text, focusUnitId } from opts;
//                                    isDeictic uses copies of DEICTIC_RE / DRAFTING_RE; markInjected no-op.
//   src/utils/logger                 records every line in `logs` (level + text).
// Anything else (action-log, ask-internal, carrier_briefing, repair-history, …) is
// passed per test in opts.fakes { '<path relative to repo root>': exports }.
//
// Time: the caller freezes the clock (vi.setSystemTime) before calling run().

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_PATH = path.join(ROOT, 'src', 'ipc', 'ai.js');
const r = (rel) => require.resolve(path.join(ROOT, rel));

// Copies of src/orcha/awareness/context-block.js DEICTIC_RE / DRAFTING_RE.
const DEICTIC_RE = /\b(this|that)\s+(unit|truck|one|wr|work\s*order)\b|\b(this|here)\s*\??$|^\s*(this|here)\b|\bwhat'?s\s+(going on|up|new|happening)\b|\b(escalate|flip|status of|update on)\s+(this|it)\b/i;
const DRAFTING_RE = /^\s*(please\s+)?(rewrite|reword|rephrase|draft|translate|proofread|shorten|polish)\b/i;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Fixed seed: two units, contacts, one due reminder, two prior chat turns. */
function defaultSeed(now) {
  return {
    fleetData: { rows: [
      { equipmentId: '208336', domicileSite: 'ABE40', operator: 'ABEOW', lifecycleState: 'Unavailable', lifecycleReason: 'In Repair', vendor: 'Amerit', workDuration: '3d', issueDetails: 'brake job', assetUrl: 'https://aap.example/asset/208336' },
      { equipmentId: 'B62281', domicileSite: 'AVP40', operator: 'AVPOP', lifecycleState: 'Active', vendor: '--' },
    ] },
    notesStore: { '208336': { timeline: '11/01 - towed to Amerit' } },
    contacts: [
      { name: 'James Mendez', type: 'slack', slackId: 'U0JAMES', email: 'james@example.com' },
      { name: 'Alice Wong', type: 'email', email: 'alice@example.com' },
    ],
    reminders: [{ unit: '208336', when: '2026-11-01', note: 'check tow invoice' }],
    orchaPatterns: [],
    chatHistory: [
      { role: 'user', text: 'morning', ts: now - 3600000 },
      { role: 'ai', text: 'Good morning Z.', ts: now - 3599000 },
    ],
  };
}

function install(opts = {}) {
  const data = Object.assign(defaultSeed(Date.now()), clone(opts.seed || {}));
  const saves = [];
  const relayCalls = [];
  const logs = [];
  const state = {
    laneAvailable: opts.laneAvailable !== false,
    relayImpl: opts.relayImpl || (async () => '{"reply":"ok","actions":[]}'),
  };
  const installed = [];
  const put = (resolved, exportsObj) => {
    installed.push([resolved, require.cache[resolved]]);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  };

  put(require.resolve('electron'), {
    BrowserWindow: { getAllWindows: () => [] }, screen: {}, session: {},
  });
  put(r('src/store'), {
    load: (k, fb) => (k in data ? clone(data[k]) : fb),
    save: (k, v) => { data[k] = clone(v); saves.push({ key: k, value: clone(v) }); },
  });
  const mkLogger = () => {
    const rec = (level) => (...a) => { logs.push({ level, text: a.map(String).join(' ') }); };
    return { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  };
  const loggerFn = () => mkLogger();
  loggerFn.createLogger = () => mkLogger();
  loggerFn.setLogDir = () => {}; loggerFn.setLevel = () => {}; loggerFn.setSilent = () => {};
  put(r('src/utils/logger'), loggerFn);
  if (!opts.realRelay) {
    put(r('src/orcha/relay'), {
      ask: (...a) => { relayCalls.push({ prompt: a[0], opts: a[1], argc: a.length }); return state.relayImpl(a[0], a[1]); },
      isolatedLaneAvailable: () => state.laneAvailable,
    });
  }
  put(r('src/orcha/ai-context'), {
    resolveEntities: (msg, rows) => {
      const s = String(msg || '').toUpperCase();
      const hit = (v) => v && new RegExp('(^|[^A-Z0-9])' + v + '($|[^A-Z0-9])').test(s);
      const units = (rows || []).filter((x) => hit(String(x.equipmentId).toUpperCase())).map((x) => x.equipmentId);
      const groups = [...new Set((rows || []).flatMap((x) => [x.domicileSite, x.operator]).filter(Boolean))].filter((g) => hit(String(g).toUpperCase()));
      return { units, groups };
    },
    buildFleetContext: (msg) => '\nFLEET-CONTEXT-MARKER[' + String(msg) + ']\n',
  });
  put(r('src/orcha/awareness/context-block'), {
    buildAwarenessBlock: () => ({ text: opts.awarenessText || '', focusUnitId: opts.focusUnitId || null }),
    isDeictic: (m) => DEICTIC_RE.test(String(m || '')) && !DRAFTING_RE.test(String(m || '')),
    markInjected: () => {},
  });
  for (const [rel, exp] of Object.entries(opts.fakes || {})) put(r(rel), exp);

  // Modules that capture `store` at load time are reloaded so they see this fake.
  const RELOAD = [AI_PATH, r('src/ipc/wr-classify')];
  for (const p of RELOAD) delete require.cache[p];
  const ai = require(AI_PATH);

  function restore() {
    for (const p of RELOAD) delete require.cache[p];
    for (const [resolved, prev] of installed.reverse()) {
      if (prev) require.cache[resolved] = prev; else delete require.cache[resolved];
    }
  }
  return {
    ai, data, saves, relayCalls, logs, restore,
    setRelay(fn) { state.relayImpl = fn; },
    setLaneAvailable(v) { state.laneAvailable = !!v; },
    savesOf(key) { return saves.filter((s) => s.key === key).map((s) => s.value); },
  };
}

/** Relay opts as a JSON-safe description (AbortSignal → marker). */
function describeOpts(o) {
  if (!o || typeof o !== 'object') return { type: typeof o };
  const out = { keys: Object.keys(o) };
  for (const k of Object.keys(o)) out[k] = (o[k] && typeof o[k] === 'object' && typeof o[k].aborted === 'boolean') ? '[AbortSignal]' : o[k];
  return out;
}

module.exports = { install, describeOpts, defaultSeed, ROOT };
