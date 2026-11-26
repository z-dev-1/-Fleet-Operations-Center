'use strict';
/**
 * autopilot/tool-registry.js — the frozen read-only tool catalog of the V2 investigation loop
 * (design §6.2.1, §6.2.2, §6.2.4, §6.2.5; FR-4).
 *
 *   TOOL_NAMES        the 17 tool names in FR-4.1 order (frozen)
 *   TOOL_DEFS[name]   frozen { name, description, source, costClass, gateSource, args, timeoutMs(cfg), run(args, t) }
 *   createRegistry(t) -> frozen { list(), has(name), execute(name, args, ctx) }
 *
 * Every tool reads local caches or the warm-only live ports through ports.js and the limiter.
 * Nothing here writes, posts or signs in. The model controls only the tool name and the
 * schema-checked arguments; every query (Slack included) is built here from the case unit.
 * Every item a tool returns is created with evidence.createCollector(...).add (directly or
 * through evidence.collectOne / timeline.publishedItems), with the run's evidenceIndex as
 * knownItems, so ids never change meaning between turns and case-store accepts every item.
 *
 * execute(): args schema -> INVALID_ARGS (code = key); unit / WO association -> DENIED
 * UNIT_MISMATCH / WO_NOT_IN_CASE; a gate source blocked in this run -> SKIPPED SOURCE_UNAVAILABLE
 * (live tools still return the cache); a throw -> ERROR; UNAVAILABLE / AUTH_REQUIRED blocks the
 * gate source for the rest of the run (t.blockedSources).
 */

const evidence = require('./evidence');
const timeline = require('./timeline');
const fingerprint = require('./fingerprint');
const limiterMod = require('./limiter');
const memoryMod = require('./memory');
const { buildConflicts } = require('./conflicts');
const { etaStatus } = require('./detect');
const { decisivRef, primaryWrId } = require('./plan');
const { newestLoggedUpdate, toMs, isoDate } = require('./updates');
const {
  SOURCES: S, CONFLICT_FIELDS, OPERATIONAL_CADENCE, AUTH_DOWN, DAY, normUnit, localDate, isAuthoritativeEtcTag,
} = require('./constants');

const UNIT_RE = /^[A-Z0-9_-]{1,32}$/;
const WO_RE = /^[A-Za-z0-9_-]{1,40}$/;
const WO_DESC = 'Filter results to this WO; does not change which WO is read';
const OK_STATUSES = new Set(['OK', 'EMPTY', 'REUSED']);
const FRESH_RANK = Object.freeze({ LIVE: 3, RECENT: 2, STALE: 1, UNKNOWN: 0 });
const STRUCT_SUMMARY_MAX = 12;
const STRUCT_VALUE_MAX = 80;
const WO_HISTORY_MAX = 20;
const PRIOR_CASES_MAX = 3;

// ── argument schemas ───────────────────────────────────────────────────────

const A_UNIT = Object.freeze({ type: 'string', required: true, description: 'The case unit id' });
const A_WO = Object.freeze({ type: 'string', required: false, pattern: WO_RE, description: WO_DESC });
const A_REFRESH = Object.freeze({ type: 'boolean', required: false, default: true, description: 'Allow a warm-only live read when the cache is old' });
const args = (extra) => Object.freeze(Object.assign({ unit: A_UNIT }, extra || {}));

// ── small helpers ──────────────────────────────────────────────────────────

function _s(v) { return v == null ? '' : String(v); }
function _arr(v) { return Array.isArray(v) ? v : []; }
function _obj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _now(t) { return typeof t.now === 'function' ? t.now() : (Number.isFinite(t.now) ? t.now : Date.now()); }
function _known(t) { return t.evidenceIndex instanceof Map ? t.evidenceIndex : new Map(); }
function _doc(t, key) {
  if (t.docs && Object.prototype.hasOwnProperty.call(t.docs, key)) return t.docs[key];
  try { return t.ports.readStore(key); } catch (_) { return null; }
}
function _colCtx(t) {
  return { row: t.row, now: _now(t), syncedAt: t.syncedAt, buildAtMs: t.buildAtMs, staleDays: t.staleDays, isDown: !!t.isDown, docs: t.docs || {} };
}
function _collector(t) { return evidence.createCollector(_colCtx(t), { knownItems: _known(t) }); }
// A plain-text token for structured composite values (no free text reaches a 'structured' item).
function _tok(v, n) { return _s(v).replace(/[^\w .,&'()/:-]/g, '').trim().slice(0, n || 60); }

async function _one(source, t, extra) {
  return evidence.collectOne(source, Object.assign({
    row: t.row, unit: t.unit, ports: t.ports, ctx: _colCtx(t), docs: t.docs || {}, woSet: t.woSet, knownItems: _known(t),
  }, extra || {}));
}

// woId filter (FR-4.3a): keep items that mention the WO, plus items with no WO association at all.
function _filterWo(items, woId, woSet) {
  if (!woId) return items;
  const ids = [...(woSet || [])].filter((x) => x && x !== woId);
  return items.filter((it) => {
    const hay = _s(it.sourceRef) + ' ' + _s(it.value);
    if (hay.includes(woId)) return true;
    return !ids.some((id) => hay.includes(id));
  });
}

function _freshness(items) {
  let best = 'UNKNOWN';
  for (const it of items) if ((FRESH_RANK[it.freshness] || 0) > (FRESH_RANK[best] || 0)) best = it.freshness;
  return best;
}

/** The §6.2.1 envelope. */
function envelope(def, status, code, items, extra) {
  const list = _arr(items).filter(Boolean);
  const st = status || (list.length ? 'OK' : 'EMPTY');
  const structured = list.filter((it) => it.trust === 'structured');
  const newest = list.reduce((m, it) => (Number.isFinite(it.observedAt) && it.observedAt > m ? it.observedAt : m), -Infinity);
  const env = {
    ok: OK_STATUSES.has(st),
    tool: def.name,
    status: st,
    code: code || null,
    source: def.source,
    live: list.some((it) => it.live === true),
    freshness: _freshness(list),
    items: list,
    summary: {
      count: list.length,
      evidenceIds: list.map((it) => it.evidenceId),
      fields: [...new Set(list.map((it) => it.field))],
      newestObservedAt: Number.isFinite(newest) ? newest : null,
      structured: structured.slice(0, STRUCT_SUMMARY_MAX).map((it) => ({ field: it.field, value: _s(it.value).slice(0, STRUCT_VALUE_MAX) })),
    },
    data: { facts: structured.map((it) => ({ field: it.field, value: it.value, source: it.source })) },
    sourceFp: list.length ? fingerprint.itemsFp(list) : null,
  };
  if (code) env.error = code;
  if (extra && extra.cacheServed) env.summary.cacheServed = true;
  // Freshly pulled items in the result (source metrics count a live success only then).
  if (env.live) env.summary.live = true;
  return env;
}

// ── live rule (§6.2.2) and status mapping (§6.2.4) ─────────────────────────

function _aapOld(t) {
  const newest = newestLoggedUpdate(t.row && t.row.fullConversation, t.syncedAt);
  return newest == null || _now(t) - newest > OPERATIONAL_CADENCE.aapLiveMinAgeMs;
}
function _decisivEntry(t) {
  const ref = decisivRef(t.row);
  const doc = _doc(t, 'decisivCaseCache');
  return ref.estimateId && _obj(doc) && _obj(doc[ref.estimateId]) ? doc[ref.estimateId] : null;
}
function _decisivOld(t) {
  const e = _decisivEntry(t);
  const at = e ? toMs(e.scrapedAt) : null;
  return at == null || _now(t) - at > OPERATIONAL_CADENCE.decisivLiveMinAgeMs;
}

/** -> null when a live read may be attempted, else the cache code. */
function liveBlockCode(a, t, source, oldEnough) {
  if (a.refresh === false) return 'REFRESH_OFF';
  if (!(t.cfg && t.cfg.features && t.cfg.features.liveReads)) return 'LIVE_READS_OFF';
  if (t.liveDone && t.liveDone.has(source)) return 'LIVE_DONE_THIS_RUN';
  if (!oldEnough) return 'CACHE_FRESH';
  const lim = t.limiter;
  if (!lim || typeof lim.tokensLeft !== 'function' || !(lim.tokensLeft(source) > 0) || !(lim.tickLeft() > 0)) return 'LIVE_BUDGET';
  return null;
}

/** Limiter / port status -> { status, code } (§6.2.4). */
function mapLiveStatus(st, calls, t, source) {
  const s = _s(st);
  const code0 = (_arr(calls).find((c) => c && c.code) || {}).code || null;
  if (s === 'ok') return { status: 'OK', code: null };
  if (s === 'auth_unavailable') return { status: 'AUTH_REQUIRED', code: code0 || 'AUTH_REQUIRED' };
  if (s === 'not_warm') return { status: 'UNAVAILABLE', code: 'NOT_WARM' };
  if (s === 'cache_only:gate_closed') {
    if (source === S.AAP_LIVE) {
      let mw = null;
      try { const a = t.ports.authState(); mw = a && a.midway; } catch (_) { mw = null; }
      if (mw && AUTH_DOWN.has(mw)) return { status: 'AUTH_REQUIRED', code: 'MIDWAY_' + _tok(mw, 30) };
    }
    return { status: 'UNAVAILABLE', code: 'GATE_CLOSED' };
  }
  if (s === 'cache_only:live_reads_off') return { status: 'UNAVAILABLE', code: 'LIVE_READS_OFF' };
  if (s === 'cache_only:no_origin') return { status: 'UNAVAILABLE', code: 'NO_ORIGIN' };
  if (s === 'rate_limited' || s === 'cache_only:budget') return { status: 'UNAVAILABLE', code: 'RATE_LIMITED' };
  if (s === 'busy_orphan') return { status: 'UNAVAILABLE', code: 'SOURCE_BUSY' };
  if (s === 'cache_only:no_limiter') return { status: 'UNAVAILABLE', code: 'LIVE_BUDGET' };
  if (s === 'error:timeout') return { status: 'TIMEOUT', code: 'LIVE_TIMEOUT' };
  if (s === 'skipped:aborted') {
    return t.runSignal && t.runSignal.aborted ? { status: 'ERROR', code: 'ABORTED' } : { status: 'TIMEOUT', code: 'LIVE_SLOT_WAIT' };
  }
  if (s.startsWith('error:')) return { status: 'ERROR', code: s.slice(6) || 'LIVE_FAILED' };
  return { status: 'ERROR', code: 'LIVE_FAILED' };
}

// One live attempt for `source` through evidence.collectOne; cache items always come back too.
async function _withLive(def, a, t, cacheItems, source, oldEnough, runLive, extraCode) {
  const block = extraCode || liveBlockCode(a, t, source, oldEnough);
  if (block) return envelope(def, null, block === 'REFRESH_OFF' ? null : block, cacheItems);
  const r = await runLive();
  t.liveDone.add(source);
  const m = mapLiveStatus(r.sourceStatus[source], r.sourceCalls, t, source);
  const liveItems = _filterWo(r.items, a.woId, t.woSet);
  if (m.status === 'OK') return envelope(def, null, null, cacheItems.concat(liveItems));
  return envelope(def, m.status, m.code, cacheItems.concat(liveItems), { cacheServed: true });
}

// ── tool runs ──────────────────────────────────────────────────────────────

function _rowAdd(col, t, fields) {
  const row = t.row || {};
  const prov = { row, syncedAt: t.syncedAt, buildAtMs: t.buildAtMs };
  for (const f of fields) col.add(S.AAP_CACHE, f, row[f], prov, { sourceRef: 'row/' + f });
}

async function runCanonical(a, t) {
  const r = await _one(S.CANONICAL, t);
  const col = _collector(t);
  let down = null;
  try { down = t.ports.isDown(t.row); } catch (_) { down = null; }
  if (typeof down === 'boolean') col.add(S.CANONICAL, 'isDown', down, { retrievedAt: _now(t) }, { sourceRef: 'canonical/isDown' });
  return envelope(this, null, null, r.items.concat(col.items));
}

function _woRoles(t) {
  const roles = new Map();
  const row = t.row || {};
  const p = primaryWrId(row);
  const add = (id, role, firstSeenAt) => {
    const s = _s(id).trim();
    if (!s || !WO_RE.test(s)) return;
    const ex = roles.get(s);
    if (!ex) roles.set(s, { id: s, role, firstSeenAt: Number.isFinite(firstSeenAt) ? firstSeenAt : null });
    else if (ex.firstSeenAt == null && Number.isFinite(firstSeenAt)) ex.firstSeenAt = firstSeenAt;
  };
  let set = null;
  try { set = typeof t.rec.wo_set_json === 'string' ? JSON.parse(t.rec.wo_set_json) : (t.rec.wo_set_json || t.rec.wo_set || null); } catch (_) { set = null; }
  const firstSeen = new Map(_arr(set).filter(_obj).map((w) => [_s(w.id), w.firstSeenAt]));
  if (p) add(p, 'primary', firstSeen.get(p));
  if (row._serviceId && row.workRequestId) add(p === _s(row._serviceId) ? row.workRequestId : row._serviceId, 'alias', firstSeen.get(_s(row.workRequestId)));
  if (row._offsiteWrId) add(row._offsiteWrId, 'offsite', firstSeen.get(_s(row._offsiteWrId)));
  for (const w of _arr(row._secondaryWRs)) if (w) { add(w._serviceId, 'secondary', firstSeen.get(_s(w._serviceId))); add(w.workRequestId, 'secondary', firstSeen.get(_s(w.workRequestId))); }
  for (const w of _arr(set).filter(_obj)) add(w.id, w.role || 'secondary', w.firstSeenAt);
  return [...roles.values()];
}

async function runActiveWos(a, t) {
  const col = _collector(t);
  const now = _now(t);
  for (const w of _woRoles(t)) {
    col.add(S.AAP_CACHE, 'wo', { id: w.id, role: _tok(w.role, 20), firstSeenAt: w.firstSeenAt }, { row: t.row, syncedAt: t.syncedAt, buildAtMs: t.buildAtMs, retrievedAt: now },
      { sourceRef: 'row/wo/' + w.id, trust: 'structured', observedAt: Number.isFinite(w.firstSeenAt) ? w.firstSeenAt : undefined });
  }
  _rowAdd(col, t, ['workRequestId', '_serviceId', '_offsiteWrId', 'serviceState', 'subState', 'openUnplanned', 'openPlanned', 'created', 'vendor', 'dealerName', 'vendorWorkOrderId']);
  return envelope(this, null, null, col.items);
}

async function runWoHistory(a, t) {
  const now = _now(t);
  const days = Number.isInteger(a.days) ? a.days : 180;
  let list = [];
  try { list = _arr(t.ports.riEvents(t.row && t.row.equipmentId, now - days * DAY)); } catch (_) { list = []; }
  list = list.filter(Boolean).sort((x, y) => (toMs(y.reported_at) || 0) - (toMs(x.reported_at) || 0)).slice(0, WO_HISTORY_MAX);
  const col = _collector(t);
  list.forEach((e, i) => {
    const v = {
      workOrderId: _tok(e.work_order_id, 40) || null, serviceId: _tok(e.service_id, 40) || null, status: _tok(e.status, 30) || null,
      woType: _tok(e.wo_type, 30) || null, category: _tok(e.repair_category, 60) || null, component: _tok(e.repair_component, 60) || null,
      vendor: _tok(e.vendor, 60) || null, reportedAt: _tok(e.reported_at, 40) || null, completedAt: _tok(e.repair_completed_at, 40) || null,
      returnToServiceAt: _tok(e.return_to_service_at, 40) || null,
    };
    const ref = 'ri/' + t.unit + '/wo/' + (v.workOrderId || v.serviceId || String(i));
    col.add(S.REPAIR_INTEL, 'woEvent', v, { event: e, retrievedAt: now }, { sourceRef: ref, trust: 'structured' });
  });
  return envelope(this, null, null, col.items);
}

async function runAapComments(a, t) {
  const col = _collector(t);
  _rowAdd(col, t, ['fullConversation', 'asistNotes']);
  const cache = _filterWo(col.items, a.woId, t.woSet);
  const p = primaryWrId(t.row);
  const extra = a.woId && a.woId !== p ? 'LIVE_PRIMARY_ONLY' : null;
  return _withLive(this, a, t, cache, S.AAP_LIVE, _aapOld(t),
    () => _one(S.AAP_LIVE, t, { limiter: t.limiter, signal: t.signal }), extra);
}

async function runDtna(a, t) {
  const r = await _one(S.DTNA, t);
  const items = _filterWo(r.items, a.woId, t.woSet);
  let s = null;
  try { s = t.ports.dtnaStatus(); } catch (_) { s = null; }
  const state = _s(s && s.state).toLowerCase();
  if (state === 'expired' || state === 'signed-out' || (s && s.actionNeeded === true)) return envelope(this, 'AUTH_REQUIRED', 'DTNA_SESSION', items, { cacheServed: true });
  if (state === 'connecting') return envelope(this, 'OK', 'DTNA_CONNECTING', items);
  return envelope(this, null, null, items);
}

async function _decisivTool(def, a, t, rowExtra) {
  const ref = decisivRef(t.row);
  const r = await _one(S.DECISIV, t);
  const col = _collector(t);
  if (rowExtra) _rowAdd(col, t, rowExtra);
  const cache = _filterWo(r.items.concat(col.items), a.woId, t.woSet);
  if (!ref.srUrl) return envelope(def, cache.length ? 'OK' : 'EMPTY', 'NO_DECISIV_CASE', cache);
  return _withLive(def, a, t, cache, S.DECISIV, _decisivOld(t),
    async () => {
      const lr = await _one(S.DECISIV, t, { limiter: t.limiter, signal: t.signal, live: true, knownItems: new Map([..._known(t)].concat(cache.map((it) => [it.evidenceId, it]))) });
      // collectOne re-reads the cache entry; only the live items are new here.
      return Object.assign({}, lr, { items: lr.items.filter((it) => it.live === true) });
    });
}

async function runDecisiv(a, t) { return _decisivTool(this, a, t, null); }

const ASIST_FIELDS = Object.freeze(['asistNotes', 'offsiteStage', 'offsiteStageSince', 'asistScrapedAt']);
async function runPaccar(a, t) {
  const ref = decisivRef(t.row);
  if (!ref.srUrl || !/paccar/i.test(ref.srUrl)) {
    const col = _collector(t);
    _rowAdd(col, t, ASIST_FIELDS);
    return envelope(this, 'EMPTY', 'NOT_PACCAR', _filterWo(col.items, a.woId, t.woSet));
  }
  return _decisivTool(this, a, t, ASIST_FIELDS);
}

async function runEstimates(a, t) {
  const col = _collector(t);
  const row = t.row || {};
  _rowAdd(col, t, ['estimateStatus']);
  const cost = Number(row.totalEstimatePendingApprovalCost);
  if (row.totalEstimatePendingApprovalCost != null && Number.isFinite(cost)) {
    col.add(S.AAP_CACHE, 'totalEstimatePendingApprovalCost', cost, { row, syncedAt: t.syncedAt, buildAtMs: t.buildAtMs }, { sourceRef: 'row/totalEstimatePendingApprovalCost' });
  }
  if (typeof row.dtnaEstimateText === 'string' && row.dtnaEstimateText.trim()) {
    col.add(S.AAP_CACHE, 'dtnaEstimateText', row.dtnaEstimateText.slice(0, 2000), { row, syncedAt: t.syncedAt, buildAtMs: t.buildAtMs },
      { sourceRef: 'row/dtnaEstimateText', trust: 'untrusted_text' });
  }
  const e = _decisivEntry(t);
  if (e && e.estimateStatus != null) {
    const ref = decisivRef(t.row);
    col.add(S.DECISIV, 'estimateStatus', e.estimateStatus, { entry: { since: e.stageSince || e.updatedAt }, retrievedAt: e.scrapedAt }, { sourceRef: 'decisiv/' + ref.estimateId });
  }
  return envelope(this, null, null, _filterWo(col.items, a.woId, t.woSet));
}

async function runVendor(a, t) {
  const r = await _one(S.VENDOR_INTEL, t);
  const col = _collector(t);
  const name = _s((t.row || {}).dealerName || (t.row || {}).vendor).trim();
  const hist = _doc(t, 'vendorHistory');
  const rec = _obj(hist) ? (hist[name] || hist[name.toLowerCase()] || null) : null;
  if (_obj(rec)) {
    const key = name.toLowerCase().slice(0, 60);
    const nums = Object.keys(rec).filter((k) => typeof rec[k] === 'number' && Number.isFinite(rec[k]) && /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 12);
    for (const k of nums) col.add(S.VENDOR_INTEL, 'vendorHistory.' + k, rec[k], { scorecard: rec, retrievedAt: _now(t) }, { sourceRef: 'vendorHistory/' + key });
  }
  return envelope(this, null, null, r.items.concat(col.items));
}

async function runSlack(a, t) {
  const r = await _one(S.SLACK, t);   // the query is { unit } only (FR-4.8)
  const items = a.woId ? r.items.filter((it) => _s(it.value).includes(a.woId)) : r.items;
  return envelope(this, null, null, items);
}

async function runOutlook(a, t) {
  const r = await _one(S.EMAIL, t);
  return envelope(this, null, null, r.items);
}

async function runAperia(a, t) {
  const r = await _one(S.APERIA, t);
  let s = null;
  try { s = t.ports.aperiaStatus(); } catch (_) { s = null; }
  if (s && s.actionNeeded === true) return envelope(this, 'AUTH_REQUIRED', 'APERIA_ACTION_NEEDED', r.items, { cacheServed: true });
  return envelope(this, null, null, r.items);
}

function _priorCaseItems(col, t, now) {
  for (const pc of _arr(t.priorCases).slice(0, PRIOR_CASES_MAX)) {
    if (!pc || !pc.case_id) continue;
    const at = Number.isFinite(pc.state_changed_at) ? pc.state_changed_at : undefined;
    let mem = null;
    try { mem = typeof pc.memory === 'string' ? memoryMod.load(pc.memory) : (pc.memory || null); } catch (_) { mem = null; }
    const conc = mem && _arr(mem.priorConclusions)[0];
    const rec = _obj(pc.record) ? pc.record : null;
    col.add(S.AP_MEMORY, 'priorCase', {
      caseId: _tok(pc.case_id, 64), episodeKey: _tok(pc.episode_key, 64) || null, primaryReason: _tok(pc.primary_reason, 40) || null,
      summary: conc ? _s(conc.summary).slice(0, 400) : null, rootCause: rec && rec.root_cause ? _s(rec.root_cause).slice(0, 300) : null,
      blocker: rec && rec.blocker ? _tok(rec.blocker, 40) : null,
    }, { retrievedAt: now }, { sourceRef: 'prior/' + _tok(pc.case_id, 64), observedAt: at });
  }
}

async function runUnitHistory(a, t) {
  const col = _collector(t);
  const now = _now(t);
  let repeat = [];
  try { repeat = _arr(t.ports.riRepeat(t.unit)); } catch (_) { repeat = []; }
  for (const r of repeat.slice(0, 10)) {
    if (r && r.component) col.add(S.REPAIR_INTEL, 'repeatComponent', _tok(r.component, 60), { event: {}, retrievedAt: now }, { sourceRef: 'ri/' + t.unit + '/repeat/' + _tok(r.component, 60) });
  }
  let ai = null;
  try { ai = t.ports.riAnalysis(t.unit); } catch (_) { ai = null; }
  if (ai != null) col.add(S.REPAIR_INTEL, 'aiAnalysis', ai, { event: { reported_at: ai && ai.generatedAt }, retrievedAt: now }, { sourceRef: 'ri/' + t.unit + '/aiAnalysis' });
  _priorCaseItems(col, t, now);
  return envelope(this, null, null, col.items);
}

async function runTimeline(a, t) {
  const items = timeline.publishedItems(_doc(t, 'notesStore'), (t.row && t.row.equipmentId) || t.unit, { now: _now(t), knownItems: _known(t), staleDays: t.staleDays });
  return envelope(this, null, null, items);
}

async function runPrevious(a, t) {
  const scope = a.scope || 'both';
  const col = _collector(t);
  const now = _now(t);
  const m = t.memory || null;
  const prov = { retrievedAt: now };
  const add = (field, value, ref, at) => col.add(S.AP_MEMORY, field, value, prov, { sourceRef: 'memory/' + ref, observedAt: Number.isFinite(at) ? at : undefined });
  if (m && (scope === 'this_episode' || scope === 'both')) {
    _arr(m.priorConclusions).forEach((c, i) => { if (c && c.summary) add('conclusion', _s(c.summary).slice(0, 400), 'conclusion/' + i, c.at); });
    _arr(m.hypotheses).forEach((h, i) => { if (h && h.statement) add('hypothesis', _s(h.statement).slice(0, 200), 'hypothesis/' + i, h.at); });
    _arr(m.openQuestions).forEach((q, i) => { if (q && q.question) add('openQuestion', _s(q.question).slice(0, 200), 'question/' + i, q.at); });
    if (m.confirmedBlocker && m.confirmedBlocker.code) add('confirmedBlocker', _tok(m.confirmedBlocker.code, 40), 'blocker', m.confirmedBlocker.at);
  }
  if (scope === 'prior_episodes' || scope === 'both') {
    if (m) {
      _arr(m.priorEpisodes).forEach((p, i) => {
        if (!p) return;
        add('priorEpisode', { key: _tok(p.key, 64) || null, blocker: _tok(p.blocker, 40) || null, summary: p.conclusion && p.conclusion.summary ? _s(p.conclusion.summary).slice(0, 400) : null },
          'episode/' + i, p.endedAt);
      });
    }
    _priorCaseItems(col, t, now);
    for (const pc of _arr(t.priorCases).slice(0, PRIOR_CASES_MAX)) {
      const rec = pc && _obj(pc.record) ? pc.record : null;
      if (rec && rec.root_cause) add('rootCause', _s(rec.root_cause).slice(0, 300), 'rootCause/' + _tok(pc.case_id, 64), pc.state_changed_at);
    }
  }
  return envelope(this, null, null, col.items);
}

async function runCompare(a, t) {
  const all = [..._known(t).values()].filter((it) => it && it.trust !== 'derived_ai' && it.trust !== 'prior_conclusion');
  const groups = buildConflicts(all, { isDown: !!t.isDown }).groups.filter((g) => !a.field || _arr(g.fields).includes(a.field));
  const col = _collector(t);
  const now = _now(t);
  for (const g of groups) {
    col.add(S.AP_DERIVED, 'conflictGroup', {
      group: g.group, field: _arr(g.fields)[0] || null,
      positions: _arr(g.positions).slice(0, 8).map((p) => ({ evidenceId: p.evidenceId || null, source: p.source, value: _s(p.value).slice(0, 80) })),
      authorityWinner: g.authorityWinner ? g.authorityWinner.source : null, tie: !g.authorityWinner && !g.informational,
    }, { retrievedAt: now }, { sourceRef: 'derived/conflict/' + g.group, flags: ['derived_calc'], observedAt: now });
  }
  return envelope(this, null, null, col.items);
}

async function runVerifyEta(a, t) {
  const now = _now(t);
  const cands = _filterWo([..._known(t).values()].filter((it) => it && it.trust === 'structured' && it.field === 'repairEtc'
    && (it.source === S.DTNA || it.source === S.DECISIV)), a.woId, t.woSet);
  const cacheEtcs = cands.map((it) => ({ date: it.value, source: it.authorityTag || it.source }));
  const today = localDate(now);
  const r = etaStatus(t.row, cacheEtcs, today, now);
  const agrees = [];
  const disagrees = [];
  for (const it of cands) {
    const d = isoDate(it.value, now);
    if (!d || !r.date) continue;
    (d === r.date ? agrees : disagrees).push(it.evidenceId);
  }
  const col = _collector(t);
  col.add(S.AP_DERIVED, 'etaVerification', {
    status: r.status, date: r.date || null, source: r.source ? _tok(r.source, 40) : null, authoritative: isAuthoritativeEtcTag(r.source),
    agrees, disagrees,
  }, { retrievedAt: now }, { sourceRef: 'derived/eta' + (a.woId ? '/' + a.woId : ''), flags: ['derived_calc'], observedAt: now });
  return envelope(this, null, null, col.items);
}

// ── timeouts (§6.2.1) ──────────────────────────────────────────────────────

function _cacheMs(cfg) {
  const v = cfg && cfg.tools && cfg.tools.timeoutMs;
  return Number.isFinite(v) && v > 0 ? v : 20000;
}
// Worst case of one limiter call: 2 attempts plus the retry sleep (limiter.js).
function _liveWorstMs(source, calls) {
  const one = 2 * limiterMod.DEADLINE_MS[source] + limiterMod.RETRY_BASE_MS + limiterMod.RETRY_JITTER_MS;
  return calls * one;
}
const cacheTimeout = (cfg) => _cacheMs(cfg);
const aapTimeout = (cfg) => Math.max(_cacheMs(cfg), _liveWorstMs(S.AAP_LIVE, 1) + 5000);
const decisivTimeout = (cfg) => Math.max(_cacheMs(cfg), _liveWorstMs(S.DECISIV, 2) + 5000);

// ── the catalog ────────────────────────────────────────────────────────────

const CONFLICT_FIELD_KEYS = Object.freeze(Object.keys(CONFLICT_FIELDS));
const def = (d) => Object.freeze(Object.assign({ gateSource: null, timeoutMs: cacheTimeout }, d));

const TOOL_DEFS = Object.freeze({
  canonical_status: def({ name: 'canonical_status', description: 'Canonical unit status (derived from the other sources), stale flag and the down test.',
    source: S.CANONICAL, costClass: 'cache', args: args(), run: runCanonical }),
  active_work_orders: def({ name: 'active_work_orders', description: 'The case WO ids with roles and first-seen times, plus the AAP row WO fields.',
    source: S.AAP_CACHE, costClass: 'cache', args: args(), run: runActiveWos }),
  wo_history: def({ name: 'wo_history', description: 'Repair-intel work order history of the unit (newest 20) over the last N days.',
    source: S.REPAIR_INTEL, costClass: 'cache', args: args({ days: Object.freeze({ type: 'integer', required: false, min: 1, max: 365, default: 180, description: 'Days back' }) }), run: runWoHistory }),
  aap_comments: def({ name: 'aap_comments', description: 'AAP WO comment thread (cached); a warm-only live AAP read when the newest comment is older than 6 h.',
    source: S.AAP_CACHE, costClass: 'live', gateSource: S.AAP_LIVE, timeoutMs: aapTimeout, args: args({ woId: A_WO, refresh: A_REFRESH }), run: runAapComments }),
  dtna_case: def({ name: 'dtna_case', description: 'Cached DTNA Service Tracker case: stage, status, ETC, dealer and thread.',
    source: S.DTNA, costClass: 'cache', gateSource: S.DTNA, args: args({ woId: A_WO }), run: runDtna }),
  decisiv_activity: def({ name: 'decisiv_activity', description: 'Decisiv case stage and activity (cached); a warm-only live read when the cache is older than 12 h.',
    source: S.DECISIV, costClass: 'live', gateSource: S.DECISIV, timeoutMs: decisivTimeout, args: args({ woId: A_WO, refresh: A_REFRESH }), run: runDecisiv }),
  paccar_asist: def({ name: 'paccar_asist', description: 'PACCAR ASIST case through the Decisiv cache and warm-only reads, plus the row ASIST fields.',
    source: S.DECISIV, costClass: 'live', gateSource: S.DECISIV, timeoutMs: decisivTimeout, args: args({ woId: A_WO, refresh: A_REFRESH }), run: runPaccar }),
  estimates: def({ name: 'estimates', description: 'Estimate status, pending approval cost and the cached estimate text.',
    source: S.AAP_CACHE, costClass: 'cache', args: args({ woId: A_WO }), run: runEstimates }),
  vendor_history: def({ name: 'vendor_history', description: 'Vendor scorecard and history numbers (historical, not current status).',
    source: S.VENDOR_INTEL, costClass: 'cache', args: args(), run: runVendor }),
  slack_evidence: def({ name: 'slack_evidence', description: 'Local Slack index excerpts that mention the unit (query built from the unit only).',
    source: S.SLACK, costClass: 'cache', args: args({ woId: A_WO }), run: runSlack }),
  outlook_evidence: def({ name: 'outlook_evidence', description: 'Email evidence extracted for the unit.',
    source: S.EMAIL, costClass: 'cache', args: args(), run: runOutlook }),
  aperia_tire: def({ name: 'aperia_tire', description: 'Cached Aperia tire issues of the unit.',
    source: S.APERIA, costClass: 'cache', gateSource: S.APERIA, args: args(), run: runAperia }),
  unit_repair_history: def({ name: 'unit_repair_history', description: 'Repeat components, prior AI repair analysis (derived) and earlier cases of the unit.',
    source: S.REPAIR_INTEL, costClass: 'cache', args: args(), run: runUnitHistory }),
  existing_timeline: def({ name: 'existing_timeline', description: 'The published unit timeline lines (prior AI-written or manual; not evidence).',
    source: S.TIMELINE, costClass: 'cache', args: args(), run: runTimeline }),
  previous_findings: def({ name: 'previous_findings', description: 'Earlier Autopilot conclusions, hypotheses and open questions for this case and prior episodes.',
    source: S.AP_MEMORY, costClass: 'local', args: args({ scope: Object.freeze({ type: 'enum', required: false, values: Object.freeze(['this_episode', 'prior_episodes', 'both']), default: 'both', description: 'Which episodes' }) }), run: runPrevious }),
  compare_conflicting_status: def({ name: 'compare_conflicting_status', description: 'Conflict groups over all evidence gathered so far, with the authority winner or a tie.',
    source: S.AP_DERIVED, costClass: 'derived', args: args({ field: Object.freeze({ type: 'enum', required: false, values: CONFLICT_FIELD_KEYS, description: 'One conflict field' }) }), run: runCompare }),
  verify_eta_against_source: def({ name: 'verify_eta_against_source', description: 'Checks the repair ETC against the DTNA / Decisiv ETCs gathered so far.',
    source: S.AP_DERIVED, costClass: 'derived', args: args({ woId: A_WO }), run: runVerifyEta }),
});

const TOOL_NAMES = Object.freeze([
  'canonical_status', 'active_work_orders', 'wo_history', 'aap_comments', 'dtna_case', 'decisiv_activity', 'paccar_asist',
  'estimates', 'vendor_history', 'slack_evidence', 'outlook_evidence', 'aperia_tire', 'unit_repair_history', 'existing_timeline',
  'previous_findings', 'compare_conflicting_status', 'verify_eta_against_source',
]);

const CATALOG = Object.freeze(TOOL_NAMES.map((n) => Object.freeze({
  name: n,
  description: TOOL_DEFS[n].description,
  args: Object.freeze(Object.fromEntries(Object.keys(TOOL_DEFS[n].args).map((k) => {
    const s = TOOL_DEFS[n].args[k];
    return [k, Object.freeze({ type: s.type, required: !!s.required, values: s.values, min: s.min, max: s.max, default: s.default, description: s.description })];
  }))),
})));

// ── argument validation ────────────────────────────────────────────────────

/** normalizeArgs(name, args) -> { ok:true, args } | { ok:false, code: '<key>' } */
function normalizeArgs(name, raw) {
  const d = TOOL_DEFS[name];
  if (!d) return { ok: false, code: 'tool' };
  if (!_obj(raw)) return { ok: false, code: 'args' };
  const out = {};
  for (const k of Object.keys(raw)) if (!Object.prototype.hasOwnProperty.call(d.args, k)) return { ok: false, code: _tok(k, 40) || 'args' };
  for (const k of Object.keys(d.args)) {
    const s = d.args[k];
    let v = raw[k];
    if (v === undefined || v === null) {
      if (s.required) return { ok: false, code: k };
      if (s.default !== undefined) out[k] = s.default;
      continue;
    }
    if (s.type === 'string') {
      if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, code: k };
      v = String(v).trim();
      if (k === 'unit') { v = normUnit(v); if (!UNIT_RE.test(v)) return { ok: false, code: k }; }
      if (s.pattern && !s.pattern.test(v)) return { ok: false, code: k };
    } else if (s.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < s.min || v > s.max) return { ok: false, code: k };
    } else if (s.type === 'boolean') {
      if (typeof v !== 'boolean') return { ok: false, code: k };
    } else if (s.type === 'enum') {
      if (typeof v !== 'string' || !s.values.includes(v)) return { ok: false, code: k };
    }
    out[k] = v;
  }
  return { ok: true, args: out };
}

/** keyOf(name, args) — in-run dedupe key over the normalized args (FR-5.3b). */
function keyOf(name, raw) {
  const n = normalizeArgs(name, raw);
  return name + ':' + fingerprint.stableStringify(n.ok ? n.args : raw);
}

// ── the registry ───────────────────────────────────────────────────────────

/**
 * createRegistry(t) -> frozen { list, has, execute }
 * t: the per-run tool context of §6.2.1 (blockedSources, liveDone and evidenceIndex are shared and
 * mutable; caseStore holds read functions only).
 */
function createRegistry(t) {
  const ctx0 = t || {};
  if (!(ctx0.blockedSources instanceof Set)) throw new Error('blockedSources set required');
  if (!(ctx0.liveDone instanceof Set)) throw new Error('liveDone set required');
  const unit = normUnit(ctx0.unit);
  const woSet = ctx0.woSet instanceof Set ? ctx0.woSet : new Set(_arr(ctx0.woSet));

  function list() { return CATALOG; }
  function has(name) { return TOOL_NAMES.includes(name); }

  async function execute(name, rawArgs, callCtx) {
    const d = TOOL_DEFS[name];
    if (!d || !has(name)) return envelope({ name: String(name || '?'), source: null }, 'DENIED', 'UNKNOWN_TOOL', []);
    const n = normalizeArgs(name, rawArgs);
    if (!n.ok) return envelope(d, 'INVALID_ARGS', n.code, []);
    const a = n.args;
    if (a.unit !== unit) return envelope(d, 'DENIED', 'UNIT_MISMATCH', []);
    if (a.woId && !woSet.has(a.woId)) return envelope(d, 'DENIED', 'WO_NOT_IN_CASE', []);
    const toolSignal = callCtx && callCtx.toolSignal;
    const tt = Object.assign({}, ctx0, { unit, woSet, signal: toolSignal || ctx0.signal || null, runSignal: ctx0.signal || null });
    if (d.gateSource && ctx0.blockedSources.has(d.gateSource)) {
      if (d.costClass !== 'live') return envelope(d, 'SKIPPED', 'SOURCE_UNAVAILABLE', []);
      // No live attempt: the cached items only (FR-4.7, AC-11).
      const cached = await _cachedOnly(d, a, tt);
      return envelope(d, 'SKIPPED', 'SOURCE_UNAVAILABLE', cached, { cacheServed: true });
    }
    let env;
    try { env = await d.run.call(d, a, tt); } catch (e) { env = envelope(d, 'ERROR', (e && e.code) || 'TOOL_FAILED', []); }
    if (d.gateSource && (env.status === 'UNAVAILABLE' || env.status === 'AUTH_REQUIRED')) ctx0.blockedSources.add(d.gateSource);
    return env;
  }

  return Object.freeze({ list, has, execute });
}

// Live tools with their source blocked: the same cache read with no live attempt.
async function _cachedOnly(d, a, t) {
  const blocked = Object.assign({}, t, { liveDone: new Set([S.AAP_LIVE, S.DECISIV]) });
  let env = null;
  try { env = await d.run.call(d, Object.assign({}, a, { refresh: false }), blocked); } catch (_) { env = null; }
  return env ? env.items : [];
}

module.exports = {
  TOOL_DEFS, TOOL_NAMES, createRegistry, normalizeArgs, keyOf, envelope, mapLiveStatus, liveBlockCode,
};
