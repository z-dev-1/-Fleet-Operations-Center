'use strict';
/**
 * autopilot/evidence.js — evidence collection for one case (§B7.3-§B7.6, plan R2).
 *
 * collect(plan, ports, limiter, signal, ctx) ->
 *   Promise<{ items, conflicts, sourceStatus, sourceCalls, flags, events, woSet }>
 *
 *   plan     planSources() result
 *   ports    ports.create() object (or a fake with the same names)
 *   limiter  createLimiter() instance, or null (then no live call is made)
 *   signal   AbortSignal or null
 *   ctx      { row, now, syncedAt, buildAtMs, staleDays, isDown, docs? }
 *            docs: optional store documents { canonicalState, longDwellStore, longDwellCsv,
 *            decisivCaseCache, emailEvidence, fasCases }; missing ones are read via ports.readStore.
 *
 * Every item goes through classify (trust), provenance (observedAt / retrievedAt / tag),
 * freshness (class + confidence) and, for CONFLICT_FIELDS fields, value normalization
 * before trust is decided (a Decisiv '' stage from an API answer becomes 'none').
 * Unit <-> WO association: DTNA entries, Decisiv data and live getService results that do
 * not belong to the unit are excluded and recorded as wo_association_mismatch.
 * Untrusted text is scanned with untrusted.detect(); a hit adds injection_suspected.
 * Excerpts are capped at 2000 chars; the pack is kept under 64 KB.
 * Events carry ids, codes and counts only, never raw text.
 */

const crypto = require('crypto');
const untrusted = require('../email-intel/untrusted');
const { SOURCES: S, LIMITS, normUnit, unitIndex, UNIT_KEY_OF } = require('./constants');
const { trustOf } = require('./classify');
const { provenanceOf } = require('./provenance');
const freshness = require('./freshness');
const { buildConflicts, conflictFieldOf, normalizeConflictValue } = require('./conflicts');
const { toMs } = require('./updates');
const { decisivRef, primaryWrId } = require('./plan');

const PACK_MAX_BYTES = 64 * 1024;
const EXCERPT_MAX = LIMITS.findingValueMaxChars;   // 2000
const RI_WINDOW_MS = 365 * 86400000;
const DTNA_THREAD_MAX = 10;
const AAP_COMMENTS_MAX = 20;
const EMAIL_MAX = 10;

const ROW_FIELDS = Object.freeze([
  'lifecycleState', 'lifecycleReason', 'serviceState', 'subState', 'workRequestId', '_serviceId', '_offsiteWrId',
  'vendor', 'dealerName', 'created', 'workDuration', 'completed', 'repairEtc', 'etcReason', 'partsEta', 'partsStatus',
  'estimateStatus', 'etcMissCount', 'etcSlipCount', 'offsiteStage', 'offsiteStageSince', 'issueSummary',
  'asistNotes', 'fullConversation',
]);
const LONG_DWELL_FIELDS = Object.freeze(['delayReason', 'escalationLevel', 'summary', 'status', 'daysDown']);

function _s(v) { return v == null ? '' : String(v); }
function _empty(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
function _cap(v) {
  if (typeof v !== 'string') return v;
  return v.length > EXCERPT_MAX ? v.slice(0, EXCERPT_MAX) : v;
}
function _sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _codeOf(e, fb) { return (e && e.code) || fb; }

/** The unit's WO set (§B7.3), plus repair-intel open events. */
function woSetOf(row, riEvents) {
  const r = row || {};
  const set = new Set();
  const add = (v) => { const s = _s(v).trim(); if (s) set.add(s); };
  add(r._serviceId); add(r.workRequestId); add(r._offsiteWrId);
  for (const w of Array.isArray(r._secondaryWRs) ? r._secondaryWRs : []) { if (w) { add(w._serviceId); add(w.workRequestId); } }
  for (const e of Array.isArray(riEvents) ? riEvents : []) {
    if (!e || !/^(open|reopened)$/i.test(_s(e.status))) continue;
    add(e.work_order_id); add(e.service_id);
  }
  return set;
}

function _vinTail(v) { const s = _s(v).replace(/\s+/g, '').toUpperCase(); return s.length >= 6 ? s.slice(-6) : (s || null); }

/** DTNA entry belongs to the unit: same normalized unit id or the VIN tail matches row.vin. */
function dtnaBelongs(entry, unit, row) {
  if (!entry) return false;
  if (normUnit(entry.unitId) && normUnit(entry.unitId) === unit) return true;
  const rowTail = _vinTail(row && row.vin);
  const tail = _vinTail(entry.vinTail || entry.serial);
  return !!(rowTail && tail && rowTail.endsWith(tail));
}

/** Decisiv data belongs to the row: estimate id equals row.decisivCaseId or the id in the row's Decisiv URL. */
function decisivBelongs(estimateId, row) {
  const id = _s(estimateId).trim();
  if (!id) return false;
  const ref = decisivRef(row);
  return id === _s(row && row.decisivCaseId).trim() || (!!ref.urlId && id === ref.urlId);
}

/** getService result belongs to the unit: wr id in the WO set and asset display name == unit. */
function serviceBelongs(detail, unit, woSet) {
  const d = detail || {};
  const wr = d.workRequest || {};
  const id = _s(wr.id || wr.workRequestId || d.id || d.serviceId).trim();
  const name = wr.assetDisplayName || (d.asset && d.asset.displayName) || d.assetDisplayName;
  return !!id && woSet.has(id) && normUnit(name) === unit;
}

function createCollector(ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const staleDays = freshness.clampStaleDays(c.staleDays);
  const items = [];
  const events = [];
  const flags = new Set();
  const ids = new Set();

  function add(source, field, value, provCtx, extra) {
    const ex = extra || {};
    let v = value;
    const cf = conflictFieldOf({ source, field });
    const prov = provenanceOf(source, field, provCtx || {});
    if (cf && v != null) {
      // Before the empty check: a Decisiv '' stage from an API answer normalizes to 'none'.
      const n = normalizeConflictValue(cf, v, { source, refMs: prov.observedAt || undefined });
      if (n != null) v = n;
    }
    if (_empty(v)) return null;
    if (typeof v === 'object' && v !== null) { try { v = JSON.stringify(v); } catch (_) { v = String(v); } }
    v = _cap(v);
    const trust = trustOf(source, field, v);
    const live = ex.live === true;
    const retrievedAt = live ? (Number.isFinite(ex.retrievedAt) ? ex.retrievedAt : now) : (prov.retrievedAt != null ? prov.retrievedAt : now);
    const item = {
      evidenceId: null,
      source,
      sourceRef: ex.sourceRef || null,
      field,
      value: v,
      observedAt: prov.observedAt != null ? prov.observedAt : null,
      retrievedAt,
      live,
      freshness: null,
      confidence: null,
      trust,
      authorityTag: prov.authorityTag,
      conflictField: cf || null,
      flags: [],
    };
    if (prov.observedFrom) item.observedFrom = prov.observedFrom;
    if (source === S.EMAIL && Number.isFinite(Number(ex.confidence))) item.confidence = Number(ex.confidence);
    item.freshness = freshness.classify(item, now, staleDays);
    item.confidence = freshness.confidence(item);
    let base = 'ev_' + _sha([source, item.sourceRef || '', field].join('|')).slice(0, 16);
    let id = base;
    for (let n = 2; ids.has(id); n++) id = base + '_' + n;
    ids.add(id);
    item.evidenceId = id;
    if (trust === 'untrusted_text') {
      let hit = false;
      try { hit = untrusted.detect(String(v)).suspicious; } catch (_) { hit = false; }
      if (hit) {
        item.flags.push('injection_suspected');
        flags.add('injection_suspected');
        events.push({ kind: 'injection_suspected', detail: { source, field, evidenceId: id } });
      }
    }
    items.push(item);
    return item;
  }

  function mismatch(source, ref) {
    flags.add('wo_association_mismatch');
    const it = {
      evidenceId: 'ev_' + _sha(['wo_association', source, ref || ''].join('|')).slice(0, 16),
      source, sourceRef: ref || null, field: 'wo_association', value: _cap(_s(ref || 'unknown')),
      observedAt: null, retrievedAt: now, live: false, freshness: 'UNKNOWN', confidence: 0.4,
      trust: 'structured', authorityTag: null, conflictField: null, flags: ['wo_association_mismatch'],
    };
    if (ids.has(it.evidenceId)) return;
    ids.add(it.evidenceId);
    items.push(it);
    events.push({ kind: 'wo_association_mismatch', detail: { source, ref: ref || null } });
  }

  return { add, mismatch, items, events, flags, now };
}

// Keep the pack under PACK_MAX_BYTES: drop the largest untrusted text items first.
function _capPack(items, flags) {
  const size = () => Buffer.byteLength(JSON.stringify(items), 'utf8');
  if (size() <= PACK_MAX_BYTES) return items;
  const order = items.filter((i) => i.trust === 'untrusted_text').sort((a, b) => _s(b.value).length - _s(a.value).length);
  let out = items.slice();
  for (const victim of order) {
    out = out.filter((i) => i !== victim);
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= PACK_MAX_BYTES) break;
  }
  flags.add('pack_truncated');
  return out;
}

function _docs(ctx, ports) {
  const given = (ctx && ctx.docs) || {};
  return (k) => {
    if (Object.prototype.hasOwnProperty.call(given, k)) return given[k];
    try { return ports.readStore(k); } catch (_) { return null; }
  };
}

function _rowItems(col, row, ctx) {
  const prov = { row, syncedAt: ctx.syncedAt, buildAtMs: ctx.buildAtMs };
  for (const f of ROW_FIELDS) col.add(S.AAP_CACHE, f, row[f], prov, { sourceRef: 'row/' + f });
  const fe = row._factEtc;
  if (fe && typeof fe === 'object') {
    col.add(S.AAP_CACHE, '_factEtc.date', fe.date, prov, { sourceRef: 'row/_factEtc.date' });
    col.add(S.AAP_CACHE, '_factEtc.snippet', fe.snippet, prov, { sourceRef: 'row/_factEtc.snippet' });
  }
}

function _canonicalItems(col, row, ports, doc) {
  const rec = ports.canonical(row);
  if (!rec || typeof rec !== 'object') return 'cache_empty';
  const prov = { record: rec, canonicalUpdatedAt: doc && doc.updatedAt, syncedAt: null };
  col.add(S.CANONICAL, 'status', rec.status, prov, { sourceRef: 'canonical/status' });
  if (typeof rec.stale === 'boolean') col.add(S.CANONICAL, 'stale', rec.stale, prov, { sourceRef: 'canonical/stale' });
  return 'ok';
}

function _riItems(col, unit, ports, now) {
  const events = ports.riEvents(unit, now - RI_WINDOW_MS);
  const list = Array.isArray(events) ? events : [];
  const open = list.filter((e) => e && /^(open|reopened)$/i.test(_s(e.status)));
  const newest = list.reduce((m, e) => Math.max(m, toMs(e && e.reported_at) || 0), 0) || null;
  const prov = { event: { reported_at: newest }, retrievedAt: now };
  col.add(S.REPAIR_INTEL, 'eventCount', list.length, prov, { sourceRef: 'ri/' + unit + '/events' });
  col.add(S.REPAIR_INTEL, 'openEventCount', open.length, prov, { sourceRef: 'ri/' + unit + '/open' });
  let repeat = [];
  try { repeat = ports.riRepeat(unit) || []; } catch (_) { repeat = []; }
  for (const r of (Array.isArray(repeat) ? repeat : []).slice(0, 10)) {
    if (r && r.component) col.add(S.REPAIR_INTEL, 'repeatComponent', String(r.component), { event: {}, retrievedAt: now }, { sourceRef: 'ri/' + unit + '/repeat/' + r.component });
  }
  return list;
}

function _dtnaItems(col, unit, row, ports) {
  const entries = ports.dtnaCasesForUnit(unit);
  const list = Array.isArray(entries) ? entries : [];
  let used = 0;
  for (const e of list) {
    if (!e) continue;
    const ref = 'dtna/' + _s(e.caseId || e.caseNumber || 'case');
    if (!dtnaBelongs(e, unit, row)) { col.mismatch(S.DTNA, ref); continue; }
    used++;
    const prov = { entry: e };
    col.add(S.DTNA, 'offsiteStage', e.offsiteStage, prov, { sourceRef: ref });
    col.add(S.DTNA, 'caseStatus', e.caseStatus, prov, { sourceRef: ref });
    col.add(S.DTNA, 'stageSince', e.stageSince, prov, { sourceRef: ref });
    col.add(S.DTNA, 'lastCommentAt', e.lastCommentAt, prov, { sourceRef: ref });
    col.add(S.DTNA, 'dealerName', e.dealerName, prov, { sourceRef: ref });
    col.add(S.DTNA, 'repairEtc', e.repairEtc || e.etc, prov, { sourceRef: ref });
    const thread = Array.isArray(e.thread) ? e.thread : (Array.isArray(e.comments) ? e.comments : []);
    const text = thread.slice(-DTNA_THREAD_MAX).map((m) => (m && (m.at ? m.at + ' ' : '') + _s(m.text || m.body))).filter(Boolean).join('\n');
    col.add(S.DTNA, 'thread', text, prov, { sourceRef: ref });
  }
  return used;
}

function _decisivCacheItems(col, row, doc) {
  const ref = decisivRef(row);
  if (!ref.estimateId) return 'cache_empty';
  const rec = doc && typeof doc === 'object' ? doc[ref.estimateId] : null;
  if (!rec || typeof rec !== 'object' || rec.ok === false) return 'cache_empty';
  const sref = 'decisiv/' + ref.estimateId;
  if (rec.estimateId != null && !decisivBelongs(rec.estimateId, row)) { col.mismatch(S.DECISIV, sref); return 'excluded'; }
  const prov = { entry: { since: rec.stageSince || rec.updatedAt }, retrievedAt: rec.scrapedAt };
  if (!_empty(rec.stage)) col.add(S.DECISIV, 'stage', rec.stage, prov, { sourceRef: sref });
  col.add(S.DECISIV, 'status', rec.stageStatus, prov, { sourceRef: sref });
  col.add(S.DECISIV, 'repairEtc', rec.etr, prov, { sourceRef: sref });
  col.add(S.DECISIV, 'dealerName', rec.dealerName, prov, { sourceRef: sref });
  return 'ok';
}

async function _aapLive(col, unit, row, ports, run, woSet) {
  const id = primaryWrId(row);
  const r = await run.call(S.AAP_LIVE, () => ports.aapGetServiceIfWarm(id));
  const call = { source: S.AAP_LIVE, op: 'getServiceIfWarm', status: r.status, attempts: r.attempts, ms: r.ms, code: r.code || null };
  if (r.status !== 'ok') return { status: r.status, calls: [call] };
  const detail = r.value || {};
  const sref = 'aap/' + id;
  if (!serviceBelongs(detail, unit, woSet)) { col.mismatch(S.AAP_LIVE, sref); return { status: 'ok', calls: [call] }; }
  const at = col.now;
  const wr = detail.workRequest || {};
  col.add(S.AAP_LIVE, 'lifecycleState', wr.lifecycleState, { item: wr, retrievedAt: at }, { sourceRef: sref, live: true, retrievedAt: at });
  const comments = Array.isArray(wr.comments) ? wr.comments.slice(-AAP_COMMENTS_MAX) : [];
  if (comments.length) {
    const newest = comments.reduce((m, x) => Math.max(m, toMs(x && x.timestamp) || 0), 0) || null;
    const text = comments.map((x) => (x && x.timestamp ? x.timestamp + ' ' : '') + _s(x && x.text)).join('\n').slice(0, 4000);
    col.add(S.AAP_LIVE, 'comments', text, { item: { timestamp: newest }, retrievedAt: at, commentDerived: true }, { sourceRef: sref + '/comments', live: true, retrievedAt: at });
  }
  return { status: 'ok', calls: [call] };
}

async function _decisivLive(col, row, ports, run) {
  const ref = decisivRef(row);
  const sref = 'decisiv/' + ref.estimateId;
  const calls = [];
  const r = await run.call(S.DECISIV, () => ports.decisivCaseStatusIfWarm(ref.estimateId, { srUrl: ref.srUrl }));
  calls.push({ source: S.DECISIV, op: 'caseStatusIfWarm', status: r.status, attempts: r.attempts, ms: r.ms, code: r.code || null });
  if (r.status !== 'ok') return { status: r.status, calls };
  const at = col.now;
  const v = r.value || {};
  const prov = { entry: { since: v.since }, retrievedAt: at };
  // '' from the API means "no status set" and normalizes to the structured 'none' (R2).
  col.add(S.DECISIV, 'stage', v.stage == null ? '' : v.stage, prov, { sourceRef: sref, live: true, retrievedAt: at });
  col.add(S.DECISIV, 'status', v.status, prov, { sourceRef: sref, live: true, retrievedAt: at });
  const a = await run.call(S.DECISIV, () => ports.decisivActivityIfWarm(ref.estimateId, { srUrl: ref.srUrl }));
  calls.push({ source: S.DECISIV, op: 'activityIfWarm', status: a.status, attempts: a.attempts, ms: a.ms, code: a.code || null });
  if (a.status === 'ok' && a.value) {
    let fmt = null;
    try { fmt = ports.decisivFormatActivity(a.value); } catch (_) { fmt = null; }
    const notes = Array.isArray(a.value.notes) ? a.value.notes : [];
    const newest = notes.reduce((m, n) => Math.max(m, toMs(n && (n.created_at || n.createdAt)) || 0), 0) || null;
    if (fmt && fmt.text) col.add(S.DECISIV, 'activity', fmt.text, { entry: { date: newest }, retrievedAt: at }, { sourceRef: sref + '/activity', live: true, retrievedAt: at });
  }
  return { status: 'ok', calls };
}

function _longDwellItems(col, unit, store, csv) {
  let n = 0;
  const st = store && typeof store === 'object' ? store : {};
  for (const k of unitIndex(st, UNIT_KEY_OF.longDwellStore).get(unit) || []) {
    const e = st[k] || {};
    for (const f of LONG_DWELL_FIELDS) col.add(S.LONG_DWELL, f, e[f], { entry: e }, { sourceRef: 'ld/' + k });
    n++;
  }
  const rows = csv && typeof csv === 'object' ? (csv.rows || csv) : {};
  for (const k of unitIndex(rows, UNIT_KEY_OF.longDwellCsvRows).get(unit) || []) {
    const e = rows[k] || {};
    const prov = { entry: { updatedAt: e.updatedAt, importedAt: e.importedAt || (csv && csv.importedAt) } };
    for (const f of LONG_DWELL_FIELDS) col.add(S.LONG_DWELL, f, e[f], prov, { sourceRef: 'ldcsv/' + k });
    n++;
  }
  return n;
}

function _slackItems(col, unit, ports, now) {
  const r = ports.slackSearch({ unit });
  const list = r && Array.isArray(r.results) ? r.results : [];
  for (const m of list.slice(0, 8)) {
    col.add(S.SLACK, 'excerpt', m && m.excerpt, { message: { ts: m.when || m.ts }, retrievedAt: now }, { sourceRef: 'slack/' + _s(m && m.ts) });
  }
  return list.length;
}

function _emailItems(col, unit, doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const keys = unitIndex(d, UNIT_KEY_OF.emailEvidence).get(unit) || [];
  let n = 0;
  for (const k of keys) {
    const list = Array.isArray(d[k]) ? d[k] : [];
    for (const it of list.slice(0, EMAIL_MAX)) {
      if (!it) continue;
      col.add(S.EMAIL, _s(it.field) || 'repairUpdate', it.value, { item: it }, { sourceRef: 'email/' + _s(it.messageId || n), confidence: it.confidence });
      if (it.quote) col.add(S.EMAIL, 'quote', it.quote, { item: it }, { sourceRef: 'email/' + _s(it.messageId || n) + '/quote' });
      n++;
    }
  }
  return n;
}

function _fasItems(col, unit, doc, now) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const e = d['unit-' + unit.toLowerCase()];
  if (!e) return 0;
  const text = typeof e === 'string' ? e : (e.summary || e.title || e.status || '');
  col.add(S.FAS_CASE, 'summary', text, { entry: e, retrievedAt: now }, { sourceRef: 'fas/' + unit });
  return 1;
}

function _vendorItems(col, row, ports, now) {
  const name = _s(row.dealerName || row.vendor).trim().toLowerCase();
  const all = ports.vendorScorecards();
  const list = Array.isArray(all) ? all : (all && Array.isArray(all.vendors) ? all.vendors : []);
  const hit = list.find((v) => v && _s(v.vendor || v.name).trim().toLowerCase() === name);
  if (!hit) return 0;
  col.add(S.VENDOR_INTEL, 'vendorScorecard', hit, { scorecard: hit, retrievedAt: now }, { sourceRef: 'vendor/' + name.slice(0, 60) });
  return 1;
}

function _aperiaItems(col, unit, ports) {
  const c = ports.aperiaCachedIssues();
  if (!c || !Array.isArray(c.issues)) return 'cache_empty';
  for (const is of c.issues) {
    if (!is || normUnit(is.fleetVehicleId) !== unit) continue;
    const ref = 'aperia_cache/' + _s(is.id || is.issueId || is.positionName);
    const prov = { issue: is, pulledAt: c.pulledAt };
    col.add(S.APERIA, 'severity', is.severity, prov, { sourceRef: ref });
    col.add(S.APERIA, 'state', is.state, prov, { sourceRef: ref });
    col.add(S.APERIA, 'positionName', is.positionName, prov, { sourceRef: ref });
    col.add(S.APERIA, 'dateDetected', is.dateDetected, prov, { sourceRef: ref });
    if (typeof is.muted === 'boolean') col.add(S.APERIA, 'muted', is.muted, prov, { sourceRef: ref });
  }
  return 'cache_only:live_disabled_v1';
}

async function collect(plan, ports, limiter, signal, ctx) {
  const c = ctx || {};
  const row = c.row || {};
  const unit = normUnit(row.equipmentId);
  const col = createCollector(c);
  const now = col.now;
  const doc = _docs(c, ports);
  const by = (plan && plan.bySource) || {};
  const sourceStatus = {};
  const sourceCalls = [];
  for (const s of (plan && plan.sources) || []) sourceStatus[s.source] = s.status;
  const inc = (s) => !!(by[s] && by[s].include);
  const safe = (source, fn) => {
    try { return fn(); } catch (e) { sourceStatus[source] = 'error:' + _codeOf(e, 'READ_FAILED'); return undefined; }
  };

  safe(S.AAP_CACHE, () => { _rowItems(col, row, c); sourceStatus[S.AAP_CACHE] = 'ok'; });
  safe(S.CANONICAL, () => { sourceStatus[S.CANONICAL] = _canonicalItems(col, row, ports, doc('canonicalState')); });

  let riEvents = [];
  if (inc(S.REPAIR_INTEL)) safe(S.REPAIR_INTEL, () => { riEvents = _riItems(col, unit, ports, now); sourceStatus[S.REPAIR_INTEL] = 'ok'; });
  const woSet = woSetOf(row, riEvents);

  if (inc(S.DTNA)) safe(S.DTNA, () => { _dtnaItems(col, unit, row, ports); });
  if (inc(S.DECISIV)) {
    safe(S.DECISIV, () => { _decisivCacheItems(col, row, doc('decisivCaseCache')); });
  }
  if (inc(S.LONG_DWELL)) safe(S.LONG_DWELL, () => { _longDwellItems(col, unit, doc('longDwellStore'), doc('longDwellCsv')); sourceStatus[S.LONG_DWELL] = 'ok'; });
  if (inc(S.SLACK)) safe(S.SLACK, () => { _slackItems(col, unit, ports, now); sourceStatus[S.SLACK] = 'ok'; });
  if (inc(S.EMAIL)) safe(S.EMAIL, () => { _emailItems(col, unit, doc('emailEvidence')); sourceStatus[S.EMAIL] = 'ok'; });
  if (inc(S.FAS_CASE)) safe(S.FAS_CASE, () => { _fasItems(col, unit, doc('fasCases'), now); sourceStatus[S.FAS_CASE] = 'ok'; });
  if (inc(S.VENDOR_INTEL)) safe(S.VENDOR_INTEL, () => { _vendorItems(col, row, ports, now); sourceStatus[S.VENDOR_INTEL] = 'ok'; });
  if (inc(S.APERIA)) safe(S.APERIA, () => { sourceStatus[S.APERIA] = _aperiaItems(col, unit, ports); });

  // Warm-only live reads: at most AAP + Decisiv in parallel (limiter caps 2 per run).
  const live = [];
  const run = limiter && typeof limiter.run === 'function' ? limiter.run({ signal }) : null;
  const wantAap = inc(S.AAP_LIVE) && by[S.AAP_LIVE].live;
  const wantDec = inc(S.DECISIV) && by[S.DECISIV].live;
  if ((wantAap || wantDec) && !run) {
    if (wantAap) sourceStatus[S.AAP_LIVE] = 'cache_only:no_limiter';
    if (wantDec) sourceStatus[S.DECISIV] = 'cache_only:no_limiter';
  } else {
    if (wantAap) live.push(_aapLive(col, unit, row, ports, run, woSet).then((r) => ({ source: S.AAP_LIVE, r }), (e) => ({ source: S.AAP_LIVE, r: { status: 'error:' + _codeOf(e, 'LIVE_FAILED'), calls: [] } })));
    if (wantDec) live.push(_decisivLive(col, row, ports, run).then((r) => ({ source: S.DECISIV, r }), (e) => ({ source: S.DECISIV, r: { status: 'error:' + _codeOf(e, 'LIVE_FAILED'), calls: [] } })));
  }
  for (const { source, r } of await Promise.all(live)) {
    sourceStatus[source] = r.status;
    for (const x of r.calls) sourceCalls.push(x);
  }

  const items = _capPack(col.items, col.flags);
  const conflicts = buildConflicts(items, { isDown: !!c.isDown });
  for (const it of items) {
    const g = conflicts.memberOf[it.evidenceId];
    it.conflictGroup = g && g.length ? g[0] : null;
  }
  return { items, conflicts, sourceStatus, sourceCalls, flags: [...col.flags], events: col.events, woSet: [...woSet] };
}

module.exports = {
  collect, woSetOf, dtnaBelongs, decisivBelongs, serviceBelongs, createCollector,
  PACK_MAX_BYTES, EXCERPT_MAX,
};
