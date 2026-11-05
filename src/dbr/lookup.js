'use strict';
// src/dbr/lookup.js — on-demand DBR answer for ONE site / domicile / SCAC (or
// a "my sites" roll-up), built right now from live fleet data plus QuickSight
// when it was pulled today. Never waits on or triggers a QuickSight pull.
//
// Pure core (lookupDbr, qsStatus, fleetStats, formatReply) with everything
// injected, plus a thin shell (run / detect) that reads the store and uses
// relay.askWithTimeout. Nothing that needs electron is required at load, and
// this module never requires the scheduler or the DBR pull scraper.
//
// Sources are always labelled; numbers only ever come from fleet rows, the
// stored QuickSight tables, or the AI review text (which itself only sees the
// unit data). Every unit- or AI-derived string goes through defangMentions.

const engine = require('./review-engine');
const resolver = require('./target-resolver');
const intent = require('./intent');
const { defangMentions } = require('../justme-context/reply-hygiene');

const REPLY_MAX = 3500;
const MAX_DOWN_LIST = 8;
const MAX_MINE_SITES = 8;
const AI_REVIEW_MAX_UNITS = 60; // the renderer prompt's slice(0, 60)
const AI_TIMEOUT_MS = 75000;
const AI_TIMEOUT_MESSAGE = 'DBR AI review timed out';
const STALE_SYNC_MS = 4 * 60 * 60 * 1000;
const SECTION_CAPS = { trends: 700, barriers: 400, flips: 200, actions: 400, help: 300 };
const PULL_HINT = '_Say "pull dbr" to refresh QuickSight._';
const TZ = 'America/Los_Angeles';
const KINDS = new Set(['domicile', 'scac', 'mine']);

const _d = (s) => defangMentions(s);
function _cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; }
function _date(v) { const d = v instanceof Date ? v : new Date(v == null ? Date.now() : v); return isNaN(d.getTime()) ? null : d; }

// ── Pacific-day helpers (same rule as quicksight_dbr._todayPacific) ─────────
function todayPT(now) {
  const d = _date(now) || new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}
function _ptDay(iso) {
  if (!iso) return null;
  const d = _date(iso);
  return d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d) : null;
}
function _md(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? m[2] + '/' + m[3] : null;
}
function _ptStamp(iso, withDate) {
  const d = _date(iso);
  if (!iso || !d) return null;
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d)) parts[p.type] = p.value;
  const time = parts.hour + ':' + parts.minute + ' ' + String(parts.dayPeriod || '').toUpperCase() + ' PT';
  return withDate ? parts.month + '/' + parts.day + ' ' + time : time;
}

// ── QuickSight state ────────────────────────────────────────────────────────
function _docState(doc, today) {
  if (!doc || typeof doc !== 'object' || doc.ok !== true) return { state: 'none', dataAsOf: null, scrapedAt: null };
  const dataAsOf = typeof doc.dataAsOf === 'string' && doc.dataAsOf ? doc.dataAsOf : null;
  const scrapedAt = doc.scrapedAt || null;
  if (dataAsOf) return { state: dataAsOf === today ? 'fresh' : 'stale', dataAsOf, scrapedAt };
  if (scrapedAt && _ptDay(scrapedAt) === today) return { state: 'fresh-unverified', dataAsOf: null, scrapedAt };
  return { state: 'stale', dataAsOf: null, scrapedAt };
}

/**
 * qsStatus({ afp, dsp, kind, code, now }) -> [{ table, state, dataAsOf, scrapedAt, rows }]
 * Domicile targets read the AFP domicile table; SCAC targets read AFP scac[]
 * (possibly several rows, one per domicile) and the DSP scac table.
 */
function qsStatus({ afp, dsp, kind, code, now } = {}) {
  const today = todayPT(now);
  const key = resolver.normKey(code);
  const src = kind === 'domicile'
    ? [['AFP domicile', afp, 'domicile', 'domicile']]
    : [['AFP scac', afp, 'scac', 'scac'], ['DSP scac', dsp, 'scac', 'scac']];
  return src.map(([table, doc, listKey, field]) => {
    const st = _docState(doc, today);
    const list = st.state !== 'none' && Array.isArray(doc[listKey]) ? doc[listKey] : [];
    const rows = key ? list.filter((r) => r && resolver.normKey(r[field]) === key) : [];
    return { table, state: st.state, dataAsOf: st.dataAsOf, scrapedAt: st.scrapedAt, rows };
  });
}

function _qsValue(r) {
  const parts = [];
  if (typeof r.uptimePct === 'number' && isFinite(r.uptimePct)) parts.push(r.uptimePct + '%');
  if (typeof r.unitsUnavailable === 'number' && isFinite(r.unitsUnavailable)) {
    parts.push((r.unitsUnavailableEstimated === true ? '~' + r.unitsUnavailable + ' (est.)' : String(r.unitsUnavailable)) + ' units unavailable');
  }
  if (!parts.length) parts.push('no uptime value recorded');
  return parts.join(' · ');
}

function _qsLines(sources, kind) {
  const lines = [];
  let hint = false;
  for (const s of sources) {
    const name = kind === 'domicile' ? 'QuickSight' : 'QuickSight ' + s.table.split(' ')[0];
    const day = _md(s.dataAsOf) || _md(_ptDay(s.scrapedAt));
    if (s.state === 'none') { lines.push('• ' + name + ': not pulled yet'); hint = true; continue; }
    if (s.state === 'stale') {
      hint = true;
      const asOf = day ? 'data as of ' + day : 'date not recorded';
      if (s.rows.length) for (const r of s.rows) lines.push('• ' + name + ' (older, ' + asOf + ", not today's)" + _qsRowSuffix(r, kind) + ': ' + _d(_qsValue(r)));
      else lines.push('• ' + name + ': not pulled today (last ' + asOf + ')');
      continue;
    }
    const label = s.state === 'fresh' ? 'data as of ' + day : 'scraped ' + _ptStamp(s.scrapedAt, false) + ', data-as-of not recorded';
    if (s.rows.length) for (const r of s.rows) lines.push('• ' + name + ' (' + label + ')' + _qsRowSuffix(r, kind) + ': ' + _d(_qsValue(r)));
    else lines.push('• ' + name + ": not in today's WTD bottom 10 (" + label + ')');
  }
  return { lines, hint };
}

function _qsRowSuffix(r, kind) {
  return kind === 'scac' && r && typeof r.domicile === 'string' && r.domicile.trim() ? ' [' + _d(r.domicile.trim().toUpperCase()) + ']' : '';
}

// ── Live fleet ──────────────────────────────────────────────────────────────
const _dom = (r) => String((r && (r.domicileSite || r.domicile)) || '').trim().toUpperCase();
const _op = (r) => String((r && r.operator) || '').trim().toUpperCase();

/** fleetStats({ rows, kind, code }) -> { total, down, uptime|null, rows, downRows } */
function fleetStats({ rows, kind, code } = {}) {
  const key = String(code || '').trim().toUpperCase();
  const all = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const matched = key ? all.filter((r) => (kind === 'scac' ? _op(r) : _dom(r)) === key) : [];
  const downRows = matched.filter(engine.isUnavail);
  const uptime = matched.length ? engine.computeGroup(downRows, matched).uptime : null;
  return { total: matched.length, down: downRows.length, uptime, rows: matched, downRows };
}

function _liveLabel(meta, now) {
  const m = meta || {};
  const stamp = _ptStamp(m.syncedAt, true);
  let s = 'Estimated from live fleet data (as of last sync ' + (stamp || 'time unknown') + ')';
  const t = _date(m.syncedAt);
  const n = _date(now);
  if (m.syncedAt && t && n && n - t > STALE_SYNC_MS) s += ' ⚠ ' + Math.floor((n - t) / 3600000) + 'h old';
  if (m.stale) s += ' ⚠ stale';
  if (m.partial) s += ' ⚠ partial';
  return s;
}

// ── Reply formatting ────────────────────────────────────────────────────────
function _section(title, text, cap) {
  const body = _cut(_d(String(text == null ? '' : text).trim()), cap) || '—';
  const lines = body.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length);
  return '*' + title + ':* ' + (lines[0] || '—') + lines.slice(1).map((l) => '\n  ' + l.replace(/^\s+/, '')).join('');
}

function _unitLine(r) {
  const days = engine.parseDaysOpen(r);
  const vendor = r.vendor && r.vendor !== '--' && String(r.vendor).toLowerCase() !== 'unassigned' ? r.vendor : 'no vendor';
  return '• ' + [r.equipmentId || r.id || '?', vendor, r.lifecycleReason, days !== null ? days + 'd' : null, r.savedRepairStatus]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => _d(String(v).trim()))
    .join(' · ');
}

function _sortDown(rows) {
  return rows.slice().sort((a, b) => {
    const da = engine.parseDaysOpen(a);
    const db = engine.parseDaysOpen(b);
    if (da === null && db !== null) return 1;
    if (db === null && da !== null) return -1;
    if (da !== db) return db - da;
    return String(a.equipmentId || '').localeCompare(String(b.equipmentId || ''));
  });
}

/**
 * formatReply(model) -> string (<= 3500 chars). model:
 *   { code, kind, stats, liveLabel, qs:{lines,hint}, review, ai:'ok'|'fallback'|'skipped' }
 */
function formatReply(model) {
  const { code, kind, stats, liveLabel, qs, review, ai } = model;
  const kindLabel = kind === 'scac' ? 'SCAC' : 'domicile';
  const c = _d(code);
  const head = '*DBR — ' + c + '* (' + kindLabel + ') · ' + stats.uptime + '% uptime · ' + stats.down + ' of ' + stats.total + ' units down';
  const live = '• ' + liveLabel + ': ' + stats.uptime + '% · ' + stats.down + ' down / ' + stats.total + ' units';
  const sorted = _sortDown(stats.downRows);

  const build = (downLimit, scale) => {
    const caps = {};
    for (const k of Object.keys(SECTION_CAPS)) caps[k] = Math.max(40, Math.floor(SECTION_CAPS[k] * scale));
    const out = [head, live, ...qs.lines];
    if (stats.down === 0) {
      out.push('Nothing down at ' + c + ' right now.');
    } else {
      out.push(_section('Trends', review.trendsText, caps.trends));
      out.push(_section('Barriers', review.barriersText, caps.barriers));
      out.push(_section('Expected Flips', review.flipsText, caps.flips));
      out.push(_section('Actions', review.actionsText, caps.actions));
      out.push(_section('Help Needed', review.helpText, caps.help));
      out.push('*Down units (' + stats.down + '):*');
      for (const r of sorted.slice(0, downLimit)) out.push(_unitLine(r));
      if (sorted.length > downLimit) out.push('• ... +' + (sorted.length - downLimit) + ' more');
      out.push(ai === 'ok' ? '_Trends/Barriers/Actions: AI review of live fleet data._' : '_Mechanical draft (AI review unavailable)._');
      if (ai === 'ok' && stats.down > AI_REVIEW_MAX_UNITS) out.push('_(AI review covered the first ' + AI_REVIEW_MAX_UNITS + ' of ' + stats.down + ' down units)_');
    }
    if (qs.hint) out.push(PULL_HINT);
    return out.join('\n');
  };
  return _fit(build);
}

function _fit(build) {
  let text = build(MAX_DOWN_LIST, 1);
  for (let n = MAX_DOWN_LIST - 1; text.length > REPLY_MAX && n >= 0; n--) text = build(n, 1);
  for (const scale of [0.6, 0.35, 0.15]) { if (text.length <= REPLY_MAX) break; text = build(0, scale); }
  return text.length > REPLY_MAX ? text.slice(0, REPLY_MAX - 1) + '…' : text;
}

function _shortReply(lines, hint) {
  const out = lines.slice();
  if (hint) out.push(PULL_HINT);
  const text = out.join('\n');
  return text.length > REPLY_MAX ? text.slice(0, REPLY_MAX - 1) + '…' : text;
}

// ── "DBR for my sites" roll-up (no AI call) ─────────────────────────────────
function _mineReply({ rows, fleetMeta, afp, now }) {
  const all = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  if (!all.length) return _shortReply(['*DBR — my sites*', 'No live fleet data loaded yet. Sync first (say "sync").'], false);
  const groups = new Map();
  for (const r of all) {
    const k = _dom(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const sites = [];
  for (const [code, list] of groups) {
    const down = list.filter(engine.isUnavail);
    if (!down.length) continue;
    sites.push({ code, total: list.length, down: down.length, uptime: engine.computeGroup(down, list).uptime });
  }
  sites.sort((a, b) => (a.uptime - b.uptime) || (b.down - a.down) || a.code.localeCompare(b.code));
  const out = ['*DBR — my sites* · ' + sites.length + ' of ' + groups.size + ' domiciles with units down', '• ' + _liveLabel(fleetMeta, now)];
  if (!sites.length) out.push('Nothing down across your ' + groups.size + ' domiciles right now.');
  for (const s of sites.slice(0, MAX_MINE_SITES)) out.push('• ' + _d(s.code) + ': ' + s.uptime + '% · ' + s.down + ' down / ' + s.total + ' units');
  if (sites.length > MAX_MINE_SITES) out.push('• ... +' + (sites.length - MAX_MINE_SITES) + ' more domiciles with units down');
  const st = _docState(afp, todayPT(now));
  let hint = false;
  if (st.state === 'fresh' || st.state === 'fresh-unverified') {
    const label = st.state === 'fresh' ? 'data as of ' + _md(st.dataAsOf) : 'scraped ' + _ptStamp(st.scrapedAt, false) + ', data-as-of not recorded';
    const shown = new Set(sites.slice(0, MAX_MINE_SITES).map((s) => resolver.normKey(s.code)));
    const hits = (Array.isArray(afp.domicile) ? afp.domicile : []).filter((r) => r && shown.has(resolver.normKey(r.domicile)));
    out.push(hits.length
      ? '• QuickSight bottom-10 includes (' + label + '): ' + hits.map((r) => _d(String(r.domicile).trim().toUpperCase()) + (typeof r.uptimePct === 'number' ? ' (' + r.uptimePct + '%)' : '')).join(', ')
      : '• QuickSight: none of these are in the WTD bottom 10 (' + label + ')');
  } else {
    hint = true;
    const day = _md(st.dataAsOf) || _md(_ptDay(st.scrapedAt));
    out.push(st.state === 'none' ? '• QuickSight: not pulled yet' : '• QuickSight: not pulled today (last ' + (day ? 'data as of ' + day : 'date not recorded') + ')');
  }
  if (sites.length) out.push('Ask "DBR for <site>" for Trends/Barriers/Actions.');
  return _shortReply(out, hint);
}

// ── Orchestrator ────────────────────────────────────────────────────────────
function _defaultAsk(relay) {
  return (prompt, opts) => (relay || require('../orcha/relay')).askWithTimeout(prompt, opts);
}

/**
 * lookupDbr({ target, kind, candidates, rows, fleetMeta, contacts, afp, dsp, now, ask, source, signal, requestId })
 *   -> { text, status:'ok'|'unknown'|'ambiguous'|'mine'|'nodata', code?, kind?, ai:'ok'|'fallback'|'skipped' }
 * ask(prompt, opts) resolves to the AI text (or { text }); opts follow
 * relay.askWithTimeout. Rejects only when the AI failed after signal.aborted.
 */
async function lookupDbr(args = {}) {
  const { rows, fleetMeta, contacts, afp, dsp, source, signal, requestId } = args;
  const now = _date(args.now) || new Date();
  const kind = KINDS.has(args.kind) ? args.kind : undefined;
  const allRows = Array.isArray(rows) ? rows : [];

  if (kind === 'mine') {
    return { text: _mineReply({ rows: allRows, fleetMeta, afp, now }), status: 'mine', ai: 'skipped' };
  }

  const catalog = resolver.buildCatalog({ rows: allRows, contacts, qsAfp: afp, qsDsp: dsp });

  // 2+ distinct known targets typed: ask, never guess.
  const cands = Array.isArray(args.candidates) ? args.candidates : [];
  if (cands.length > 1) {
    const codes = [];
    for (const c of cands) {
      const r = resolver.resolveTarget(c, kind, catalog);
      if (r.status === 'ok' && !codes.includes(r.code)) codes.push(r.code);
    }
    if (codes.length > 1) {
      return { text: 'You named more than one: ' + codes.map(_d).join(', ') + '. Which one? (one site or carrier per question)', status: 'ambiguous', ai: 'skipped' };
    }
  }

  const res = resolver.resolveTarget(args.target, kind, catalog);
  if (res.status === 'mine') return { text: _mineReply({ rows: allRows, fleetMeta, afp, now }), status: 'mine', ai: 'skipped' };
  if (res.status === 'unknown') {
    const clean = resolver.sanitizeTarget(args.target);
    if (!clean) return { text: 'Which site, domicile or carrier? Try "DBR for AUVTE".', status: 'unknown', ai: 'skipped' };
    const sugg = res.suggestions.length ? 'Closest: ' + res.suggestions.map(_d).join(', ') + '.' : 'No close matches.';
    return { text: 'I don\'t have "' + _d(clean) + '" in your domiciles or carriers. ' + sugg, status: 'unknown', ai: 'skipped' };
  }
  if (res.status === 'ambiguous') {
    const clean = resolver.sanitizeTarget(args.target) || '';
    const kinds = new Set(res.options.map((o) => o.kind));
    const opts = res.options.map((o) => _d(o.code) + (kinds.size > 1 ? ' (' + (o.kind === 'scac' ? 'SCAC' : 'domicile') + ')' : '')).join(', ');
    const q = kinds.size > 1 ? 'Domicile or SCAC?' : 'Which one?';
    return { text: '"' + _d(clean) + '" matches more than one: ' + opts + '. ' + q, status: 'ambiguous', ai: 'skipped' };
  }

  const code = res.code;
  const rkind = res.kind;
  const kindLabel = rkind === 'scac' ? 'SCAC' : 'domicile';
  const qs = _qsLines(qsStatus({ afp, dsp, kind: rkind, code, now }), rkind);
  const head = '*DBR — ' + _d(code) + '* (' + kindLabel + ')';

  if (!allRows.length) {
    return { text: _shortReply([head, 'No live fleet data loaded yet. Sync first (say "sync").', ...qs.lines], qs.hint), status: 'nodata', code, kind: rkind, ai: 'skipped' };
  }
  const stats = fleetStats({ rows: allRows, kind: rkind, code });
  if (!stats.total) {
    const stamp = _ptStamp(fleetMeta && fleetMeta.syncedAt, true);
    return { text: _shortReply([head, 'No units for ' + _d(code) + ' in the live fleet data (last sync ' + (stamp || 'time unknown') + ').', ...qs.lines], qs.hint), status: 'nodata', code, kind: rkind, ai: 'skipped' };
  }
  const liveLabel = _liveLabel(fleetMeta, now);
  if (!stats.down) {
    return { text: formatReply({ code, kind: rkind, stats, liveLabel, qs, review: null, ai: 'skipped' }), status: 'ok', code, kind: rkind, ai: 'skipped' };
  }

  const ask = typeof args.ask === 'function' ? args.ask : _defaultAsk();
  const askOpts = {
    source: 'dbr_lookup',
    priority: source === 'slack-justme' ? 'high' : 'normal',
    timeoutMs: AI_TIMEOUT_MS,
    timeoutMessage: AI_TIMEOUT_MESSAGE,
    signal,
    requestId,
  };
  let aiErr = null;
  const askAi = async (prompt) => {
    try { return engine.parseAiJson(await ask(prompt, askOpts)); } catch (e) { aiErr = e; throw e; }
  };
  const label = (rkind === 'domicile' ? 'domicile ' : 'SCAC ') + code;
  const review = await engine.reviewRow(stats.downRows, label, askAi);
  const failed = 'aiError' in review;
  if (failed && signal && signal.aborted) throw aiErr || new Error('aborted');
  const ai = failed ? 'fallback' : 'ok';
  return { text: formatReply({ code, kind: rkind, stats, liveLabel, qs, review, ai }), status: 'ok', code, kind: rkind, ai };
}

// ── Production shell ────────────────────────────────────────────────────────
function _store(deps) { return (deps && deps.store) || require('../store'); }

/** detect(userMsg, { rows, contacts, afp, dsp }) -> intent.detectDbrLookup result or null */
function detect(userMsg, deps = {}) {
  const rows = Array.isArray(deps.rows) ? deps.rows : ((deps.fd && Array.isArray(deps.fd.rows)) ? deps.fd.rows : []);
  const catalog = resolver.buildCatalog({ rows, contacts: deps.contacts, qsAfp: deps.afp, qsDsp: deps.dsp });
  return intent.detectDbrLookup(userMsg, catalog);
}

/**
 * run({ target, kind, candidates, source, signal, requestId }, deps) — loads
 * fleetData / contacts / quicksightDbr / quicksightDbrDsp from the store
 * (deps.fd / deps.contacts / deps.afp / deps.dsp override) and answers.
 * deps.ask or deps.relay replace the default relay.askWithTimeout.
 */
async function run(args = {}, deps = {}) {
  const need = (k) => deps[k] === undefined;
  const st = (need('fd') || need('contacts') || need('afp') || need('dsp')) ? _store(deps) : null;
  const fd = (need('fd') ? st.load('fleetData', {}) : deps.fd) || {};
  const contacts = need('contacts') ? st.load('contacts', []) : deps.contacts;
  const afp = need('afp') ? st.load('quicksightDbr', null) : deps.afp;
  const dsp = need('dsp') ? st.load('quicksightDbrDsp', null) : deps.dsp;
  return lookupDbr({
    target: args.target,
    kind: args.kind,
    candidates: args.candidates,
    rows: Array.isArray(fd.rows) ? fd.rows : [],
    fleetMeta: { syncedAt: fd.syncedAt || fd.aapScrapedAt || null, stale: !!fd.stale, partial: !!fd.partial },
    contacts, afp, dsp,
    now: deps.now,
    ask: typeof deps.ask === 'function' ? deps.ask : _defaultAsk(deps.relay),
    source: args.source,
    signal: args.signal,
    requestId: args.requestId,
  });
}

module.exports = {
  todayPT, qsStatus, fleetStats, formatReply, lookupDbr, detect, run,
  REPLY_MAX, MAX_DOWN_LIST, AI_TIMEOUT_MS, AI_TIMEOUT_MESSAGE, PULL_HINT,
};
