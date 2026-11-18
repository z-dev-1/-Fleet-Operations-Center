'use strict';
/**
 * carrier-intel/index.js — the shell (design B4, B5, B12, B14, B17).
 *
 * detect(userMsg, { rows, history, nowMs })  -> intent hit | { ambiguous, candidates } | null
 * answerCarrierIntel(args)                    -> { text, scac, units, mode, removed, ms, diag }
 *   Core orchestrator with every source injected (rows, stats, enrich, fasNames, fasAlias,
 *   repairHistory, ask, surface, today, now, signal, fd). One ask() call at most.
 * run(args, deps)                             -> { text, scac, units, mode, removed, ms, surface }
 *   Loads the store / fleet-dbr wrappers / fleetStats, injects the isolated-lane ask and logs
 *   every diag entry as '[carrier-intel] <code>' with scac / units / ms only.
 *
 * Read-only: nothing here proposes or executes an action. This is the only carrier-intel
 * module that logs or touches the store and the AI transport.
 */

const intent = require('./intent');
const C = require('./context');
const A = require('./answer');
const resolver = require('../dbr/target-resolver');
const F = require('../dbr/fleet-dbr');

const AI_TIMEOUT_MS = 200000;
const BOX_RE = /box\s*truck/i;

function _s(v) { return v == null ? '' : String(v); }
function _plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function _rows(v) { return (Array.isArray(v) ? v : []).filter((r) => r && typeof r === 'object'); }
// Error codes / names only, never message text (B17).
function _code(v) { const s = _s(v); return /^[A-Za-z0-9_.-]{1,40}$/.test(s) ? s : ''; }
function _isBox(r) { return r.assetType === 'boxTruck' || BOX_RE.test(_s(r.bodyType)); }
function _localDay(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _scacRows(rows, scac) {
  const key = resolver.normKey(scac);
  return _rows(rows).filter((r) => resolver.normKey(r.operator) === key);
}

/** detect(userMsg, { rows, history, nowMs }): follow-up first, then the plain detector (B4). */
function detect(userMsg, deps = {}) {
  const rows = _rows(deps.rows);
  const catalog = resolver.buildCatalog({ rows });
  const unitIds = new Set(rows.map((r) => _s(r.equipmentId).trim().toUpperCase()).filter(Boolean));
  const history = Array.isArray(deps.history) ? deps.history : [];
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const fu = intent.detectFollowUp(userMsg, history, catalog, unitIds, nowMs);
  if (fu) return fu;
  const hit = intent.detectCarrierIntel(userMsg, catalog, unitIds);
  if (hit && !hit.ambiguous) delete hit.userMsg;
  return hit;
}

function _errorText(scac) {
  return "I couldn't build the carrier analysis for " + scac + ' right now. Try again, or ask "dbr for ' + scac + '".';
}

/**
 * answerCarrierIntel({ hit, userMsg, rows, stats, enrich, fasNames, fasAlias, repairHistory, ask,
 *   surface, today, now, signal, fd }). Rejects only when the AI call was aborted.
 */
async function answerCarrierIntel(args = {}) {
  const t0 = Date.now();
  const hit = _plain(args.hit);
  const diag = [];
  const scac = _s(hit.scac).toUpperCase();
  const done = (o) => Object.assign({ scac, units: 0, removed: 0, diag }, o, { ms: Date.now() - t0 });

  if (hit.ambiguous) {
    const c = (Array.isArray(hit.candidates) ? hit.candidates : []).map((x) => _s(x).toUpperCase());
    diag.push({ code: 'ambiguous', level: 'info' });
    return done({ text: 'One carrier per question: ' + c.slice(0, -1).join(', ') + ' or ' + c[c.length - 1] + '?', scac: c.join(','), mode: 'ambiguous' });
  }

  const signal = args.signal;
  try {
    const now = Number.isFinite(args.now) ? args.now : Date.now();
    const today = _s(args.today) || _localDay(now);
    const rows = _rows(args.rows);
    const built = C.buildContext({
      scac, rows, fleetRows: rows, stats: args.stats, enrich: args.enrich, fasNames: args.fasNames,
      fasAlias: args.fasAlias, repairHistory: args.repairHistory, today, now, cues: hit.cues,
      assetFilter: hit.assetFilter, userMsg: args.userMsg, fd: args.fd,
    });
    diag.push(...(built.diag || []));
    const units = (built.model.records || []).length;
    const surface = args.surface === 'fab' ? 'fab' : 'slack';

    // Zero down units: no AI call (B10).
    if (!units) {
      const g = A.gateAnswer({ ok: false }, built);
      diag.push(...g.diag);
      return done({ text: A.render(built.model, { surface, sections: { support: g.sections.support } }), units, mode: 'mechanical:zero-down' });
    }

    let parsed = { ok: false };
    let reason = null;
    if (built.mode === 'too-large') {
      reason = 'context too large';
    } else {
      let out;
      try {
        out = await args.ask(built.prompt, { timeoutMs: AI_TIMEOUT_MS, signal });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (e && e.code === 'AI_TIMEOUT') { reason = 'AI timed out'; diag.push({ code: 'ai-timeout', level: 'warn' }); }
        else { reason = 'AI unavailable'; diag.push({ code: 'ai-failed', level: 'warn', err: _code(e && e.code) }); }
      }
      if (!reason) {
        parsed = A.parseAnswer(typeof out === 'string' ? out : _s(out && out.text));
        if (!parsed.ok) { reason = 'AI reply unreadable'; diag.push({ code: 'ai-bad-json', level: 'warn' }); }
      }
    }

    const g = A.gateAnswer(parsed, built);
    diag.push(...g.diag);
    if (g.removals.length) {
      const counts = {};
      for (const r of g.removals) counts[r.code] = (counts[r.code] || 0) + 1;
      diag.push({ code: 'gate-drops', level: 'debug', counts });
    }
    const text = A.render(built.model, { surface, sections: g.sections, removed: g.removed, reason });
    return done({ text, units, mode: reason ? 'mechanical:' + reason : 'ai', removed: g.removed });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    diag.push({ code: 'internal', level: 'warn', err: _code(e && e.name) });
    return done({ text: _errorText(scac), mode: 'error' });
  }
}

// ── Production shell ────────────────────────────────────────────────────────
function _logger(deps) {
  if (deps.logger) return deps.logger;
  try { return require('../utils/logger')('carrier-intel'); } catch (_) { return { debug() {}, info() {}, warn() {} }; }
}

/**
 * run({ hit, userMsg, source, signal, requestId }, deps) — deps.fd (fleetData), deps.store,
 * deps.fleetDbr, deps.stats (fn), deps.ask, deps.logger and deps.now override the sources.
 */
async function run(args = {}, deps = {}) {
  const log = _logger(deps);
  const hit = _plain(args.hit);
  const source = args.source;
  const scac = _s(hit.scac).toUpperCase();
  const line = (code, r) => '[carrier-intel] ' + code + ' (scac=' + scac + ' units=' + (r ? r.units : 0) + ' ms=' + (r ? r.ms : 0) + ')';
  const warn = (code) => { try { log.warn(line(code)); } catch (_) { /* logging never fails the turn */ } };

  let fd = deps.fd;
  let st = null;
  const store = () => st || (st = deps.store || require('../store'));
  if (!fd || typeof fd !== 'object') {
    try { fd = store().load('fleetData', {}) || {}; } catch (_) { fd = {}; warn('fleetData-unavailable'); }
  }
  const rows = _rows(fd.rows);
  let repairHistory = {};
  try { repairHistory = _plain(store().load('repairHistory', {})); } catch (_) { repairHistory = {}; warn('repairHistory-unavailable'); }

  const scacRows = hit.ambiguous ? [] : _scacRows(rows, scac);
  const box = hit.assetFilter === 'boxTruck' ? scacRows.filter(_isBox) : [];
  const scoped = box.length ? box : scacRows;
  const downIds = scoped.filter((r) => { try { return F.isDown(r); } catch (_) { return false; } })
    .map((r) => _s(r.equipmentId).trim()).filter(Boolean);
  const domiciles = [...new Set(scoped.map((r) => _s(r.domicileSite || r.domicile).trim()).filter(Boolean))];

  let fdbr = null;
  const fleetDbr = () => fdbr || (fdbr = deps.fleetDbr || require('../ipc/fleet-dbr'));
  let enrich = {};
  let fasNames = [];
  let fasAlias = '';
  if (!hit.ambiguous) {
    try { enrich = _plain(fleetDbr().enrichFor(downIds)); } catch (_) { enrich = {}; warn('enrich-unavailable'); }
    try {
      for (const d of domiciles) for (const n of (fleetDbr().fasNamesFor(scac, d) || [])) if (typeof n === 'string' && !fasNames.includes(n)) fasNames.push(n);
    } catch (_) { fasNames = []; warn('fasNames-unavailable'); }
    try { const a = fleetDbr().cachedAapAlias(); fasAlias = typeof a === 'string' ? a : ''; } catch (_) { fasAlias = ''; warn('fasAlias-unavailable'); }
  }

  let stats;
  try {
    const fleetStats = deps.stats || require('../dbr/lookup').fleetStats;
    const s = fleetStats({ rows: scoped, kind: 'scac', code: scac });
    stats = { total: s.total, down: s.down, uptime: s.uptime };
  } catch (_) { stats = undefined; warn('stats-unavailable'); }

  const priority = source === 'slack-justme' ? 'high' : 'normal';
  const ask = typeof deps.ask === 'function' ? deps.ask
    : (p, o) => require('../orcha/relay').askWithTimeout(p, { ...o, source: 'carrier_intel', priority, isolated: true, preferAki: true, requestId: args.requestId });
  const surface = source === 'fab' ? 'fab' : 'slack';
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();

  const r = await answerCarrierIntel({
    hit, userMsg: args.userMsg, rows, stats, enrich, fasNames, fasAlias, repairHistory, ask, surface,
    today: _localDay(now), now, signal: args.signal, fd,
  });
  for (const d of r.diag || []) {
    const lvl = d.level === 'warn' ? 'warn' : d.level === 'info' ? 'info' : 'debug';
    let extra = d.counts ? ' ' + Object.keys(d.counts).map((k) => k + '=' + d.counts[k]).join(',') : '';
    if (d.err) extra += ' err=' + d.err;
    try { (log[lvl] || log.debug).call(log, line(d.code, r) + extra); } catch (_) { /* never fails the turn */ }
  }
  return { text: r.text, scac: r.scac, units: r.units, mode: r.mode, removed: r.removed, ms: r.ms, surface };
}

module.exports = { detect, answerCarrierIntel, run, AI_TIMEOUT_MS };
