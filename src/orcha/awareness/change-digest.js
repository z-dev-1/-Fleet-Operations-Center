'use strict';
/**
 * change-digest.js — per-unit change awareness for the context-aware assistant
 * (design §D2, rules P1a/P1b/P2/P3 from §D5).
 *
 * After each ACCEPTED fleet push (shouldDiff), diff the rows against a
 * persisted per-unit snapshot (store key assistantUnitSnapshots), append a
 * bounded digest (assistantChangeDigest), and hand proactive-note candidates
 * to the unified notifier.
 *
 * Quiet baseline: a unit with no prior snapshot (or a missing / corrupt /
 * version-mismatched doc) only records. A field never recorded produces no
 * entry. A restart emits no notes: liveness is per unit, in memory, primed only
 * by pushes whose data was scraped in THIS process (scrapedAt >= startedAt).
 * Changes for a non-live unit are kept in the digest as catch-up (cu:true) and
 * their candidates are enqueued silent:true (ledger-marked, never delivered).
 *
 * Nothing here sends anything anywhere; delivery is the notifier's job.
 */

const crypto = require('node:crypto');
const store  = require('../../store');
const logger = require('../../utils/logger')('awareness');

const SNAPSHOT_VERSION  = 1;
const STALE_SNAPSHOT_MS = 2 * 3600 * 1000;
const SEEN_REFRESH_MS   = 24 * 3600 * 1000;
const PRUNE_MS          = 30 * 24 * 3600 * 1000;
const HIGH_ESTIMATE     = 30000;
const ESTIMATE_MIN_DELTA = 500;
const MAX_DIGESTS       = 10;
const MAX_DIGEST_ENTRIES = 200;

// In memory only, one per process.
//   live:  unitId -> nowMs of the last FRESH accepted push containing it (catch-up test)
//   asOf:  unitId -> latest accepted data-as-of ms (data-as-of guard between snapshot writes)
// startedAt is the PROCESS start (not module load), so a push scraped before
// this module was first required but after launch still counts as fresh.
const _session = { startedAt: Date.now() - Math.round(process.uptime() * 1000), live: new Map(), asOf: new Map() };

// ── helpers ─────────────────────────────────────────────────────────────────
const _t = (s) => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : 0; };

function _str(v) { return typeof v === 'string' ? v.trim() : ''; }
function _norm(v) { return _str(v).toLowerCase(); }
function _canon(v) { const s = _str(v); return s.toLowerCase() === 'unknown' ? '' : s; }

function _parseMoney(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function _money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function _label(s) {
  if (!s) return 'No status';
  return String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function _wrIds(row) {
  const ids = [];
  if (row.workRequestId) ids.push(String(row.workRequestId));
  if (Array.isArray(row._secondaryWRs)) {
    for (const w of row._secondaryWRs) {
      const id = w && typeof w === 'object' ? w.workRequestId : w;
      if (id) ids.push(String(id));
    }
  }
  return Array.from(new Set(ids)).sort();
}

// Returns null when unknown (property absent, or only [object …] tokens).
function _escList(row) {
  if (!Object.prototype.hasOwnProperty.call(row, 'escalations')) return null;
  const raw = Array.isArray(row.escalations) ? row.escalations.join('; ') : String(row.escalations == null ? '' : row.escalations);
  const list = Array.from(new Set(raw.split(/[;,]/).map((s) => s.trim()).filter((s) => s && !/^\[object /i.test(s)))).sort();
  if (!list.length && raw.trim()) return null;
  return list;
}

function _noteHash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12); }

const STAGE_KEYS = ['st', 'sd', 'ss', 'sr'];
const DATA_KEYS  = ['l', 'r', 'c', 'v', 'w', 'e', 'x', 'n', 'nl'];

function _same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

// ── accepted payloads ──────────────────────────────────────────────────────
function shouldDiff(d) {
  return !!(d && Array.isArray(d.rows) && d.rows.length && !d.partial && !d.usedCache && !d.stale);
}

// Stage group (st/sd/ss/sr). Mutates `next`; returns true when the stage was taken.
function _applyStage(prior, next, row) {
  // Only rows that carry stage data (stage_refresh stamps _stageReadAt on every read).
  if (row.offsiteStage === undefined && !row._stageReadAt) return false;
  const stageFresh = !prior.sr
    || (_t(row._stageReadAt) && _t(row._stageReadAt) >= _t(prior.sr))
    || (!_t(row._stageReadAt) && _t(row.offsiteStageSince) > _t(prior.ss));
  if (!stageFresh) return false; // older copy: keep prior st/sd/ss/sr
  next.st = String(row.offsiteStage || '').toLowerCase(); // '' is a real API state ("no status")
  next.sd = String(row.offsiteStageDetail || '');
  next.ss = String(row.offsiteStageSince || '');
  next.sr = row._stageReadAt || prior.sr || '';
  return true;
}

// Non-stage fields. Mutates `next`, pushes entries.
function _applyData(prior, next, row, u, add) {
  const scalars = [['l', 'lifecycle', row.lifecycleState, _str], ['r', 'reason', row.lifecycleReason, _str],
    ['c', 'canonical', row.canonicalStatus, _canon], ['v', 'vendor', row.vendor, _str]];
  for (const [key, kind, raw, fn] of scalars) {
    const val = fn(raw);
    if (!val) continue; // unknown: keep prior
    if (prior[key] && _norm(prior[key]) !== val.toLowerCase()) {
      const text = kind === 'lifecycle' ? `${u} ${prior[key]} → ${val}`
        : kind === 'vendor' ? `${u} vendor ${prior[key]} → ${val}`
        : kind === 'reason' ? `${u} reason ${prior[key]} → ${val}`
        : `${u} status ${prior[key]} → ${val}`;
      add({ k: kind, f: prior[key], t: val, text });
    }
    next[key] = val;
  }

  const w = _wrIds(row);
  if (w.length) {
    if (Array.isArray(prior.w)) {
      const added = w.filter((id) => !prior.w.includes(id));
      if (added.length) {
        add({ k: 'wr-new', f: null, t: added.join(', '),
          text: added.length === 1 ? `${u} new WR ${added[0]}` : `${u} ${added.length} new WRs (${added.join(', ')})` });
      }
    }
    next.w = w;
  }

  const e = _parseMoney(row.estimatePendingCost);
  if (e) {
    const pe = prior.e || 0;
    if (pe && e !== pe && (Math.abs(e - pe) >= ESTIMATE_MIN_DELTA || (pe < HIGH_ESTIMATE) !== (e < HIGH_ESTIMATE))) {
      add({ k: 'estimate', f: pe, t: e, text: `${u} estimate ${_money(pe)} → ${_money(e)}` });
    }
    next.e = e;
  }

  const x = _escList(row);
  if (x) {
    if (Array.isArray(prior.x)) {
      for (const team of x) if (!prior.x.includes(team)) add({ k: 'esc-add', f: null, t: team, text: `${u} escalated to ${team}` });
      for (const team of prior.x) if (!x.includes(team)) add({ k: 'esc-remove', f: team, t: null, text: `${u} de-escalated from ${team}` });
    }
    next.x = x;
  }

  const notes = typeof row.asistNotes === 'string' ? row.asistNotes : '';
  if (notes.trim()) {
    const n = _noteHash(notes);
    if (prior.n && n !== prior.n && notes.length > (prior.nl || 0)) {
      add({ k: 'dealer-note', f: null, t: null, text: `${u} new dealer note` });
    }
    next.n = n;
    next.nl = notes.length;
  }
}

/**
 * diffUnits(prevDoc, rows, nowMs, opts) → { entries, nextDoc, dirty, baselined }
 * opts = { asOf, session }. Pure apart from READING session.live / session.asOf.
 */
function diffUnits(prevDoc, rows, nowMs, opts = {}) {
  const asOf = opts.asOf || 0;
  const session = opts.session || null;
  const valid = !!(prevDoc && typeof prevDoc === 'object' && prevDoc.version === SNAPSHOT_VERSION
    && prevDoc.units && typeof prevDoc.units === 'object');
  const baselined = !valid;
  const units = Object.assign({}, valid ? prevDoc.units : {});
  const entries = [];
  let dirty = false;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.equipmentId) continue;
    const u = String(row.equipmentId);
    const prior = (!baselined && units[u] && typeof units[u] === 'object') ? units[u] : null;

    if (!prior) { // baseline this unit only
      const next = {};
      _applyStage({}, next, row);
      _applyData({}, next, row, u, () => {});
      next.a = asOf;
      next.seen = nowMs;
      units[u] = next;
      dirty = true;
      continue;
    }

    const last = session && session.live.get(u);
    const cu = !(last && nowMs - last <= STALE_SNAPSHOT_MS);
    const wr = row.workRequestId ? String(row.workRequestId) : null;
    const add = (e) => { const ent = Object.assign({ u }, e, { wr }); if (cu) ent.cu = true; entries.push(ent); };
    const next = Object.assign({}, prior);

    if (_applyStage(prior, next, row) && prior.st !== undefined && next.st !== prior.st && next.st !== '') {
      add({ k: 'stage', f: prior.st, t: next.st,
        text: next.st === 'ready' ? `${u} went Ready${next.sd ? ' (' + next.sd + ')' : ''}` : `${u} ${_label(prior.st)} → ${_label(next.st)}` });
    }

    const effA = Math.max(prior.a || 0, session ? (session.asOf.get(u) || 0) : 0);
    const skipData = !!(asOf && effA && asOf < effA);
    if (!skipData) {
      _applyData(prior, next, row, u, add);
      if (asOf) next.a = Math.max(effA, asOf);
    }

    let changed = false;
    for (const k of STAGE_KEYS.concat(DATA_KEYS)) if (!_same(prior[k], next[k])) { changed = true; break; }
    if (changed || !prior.seen || nowMs - prior.seen > SEEN_REFRESH_MS) {
      next.seen = nowMs;
      units[u] = next;
      dirty = true;
    } // else: `a` advancing alone does not dirty the unit; keep prior as-is
  }

  for (const id of Object.keys(units)) {
    const s = units[id];
    if (!s || typeof s !== 'object' || (s.seen && nowMs - s.seen > PRUNE_MS)) delete units[id];
  }

  return { entries, nextDoc: { version: SNAPSHOT_VERSION, units }, dirty, baselined };
}

// ── proactive candidates (P1a / P1b / P2 / P3) ──────────────────────────────
function proactiveCandidates(entries, rowsById) {
  const out = [];
  const byId = rowsById || {};
  const p1aUnits = new Set();
  const mk = (e, n) => { const c = Object.assign({ unit: e.u, wr: e.wr || '-', source: 'digest' }, n); if (e.cu) c.silent = true; out.push(c); };

  for (const e of entries || []) {
    if (e.k !== 'stage' || e.t !== 'ready') continue;
    const row = byId[e.u] || {};
    if (!row.offsiteStageSince) continue;
    p1aUnits.add(e.u);
    const sd = row.offsiteStageDetail ? ` (${row.offsiteStageDetail})` : '';
    const at = row.vendor ? ` at ${row.vendor}` : '';
    mk(e, { key: `${e.u}|ready-api|${e.wr || '-'}`, family: 'ready-api', icon: '✅', title: 'Ready', severity: 'high',
      text: `${e.u} is Ready${sd}${at}, confirmed by the Decisiv API. Verify and flip to Available.` });
  }
  for (const e of entries || []) {
    if (e.k === 'canonical' && String(e.t || '').toLowerCase() === 'ready_for_pickup' && !p1aUnits.has(e.u)) {
      mk(e, { key: `${e.u}|ready-maybe|${e.wr || '-'}`, family: 'ready-maybe', icon: '✅', title: 'May be Ready', severity: 'high',
        text: `${e.u} may be Ready (from notes/status, not confirmed by the Decisiv API). Verify before flipping.` });
    } else if (e.k === 'esc-add') {
      mk(e, { key: `${e.u}|esc|${e.t}|${e.wr || '-'}`, family: 'esc', icon: '🚨', title: 'New escalation', severity: 'high',
        text: `${e.u} escalated to ${e.t}.` });
    } else if (e.k === 'estimate' && e.f < HIGH_ESTIMATE && e.t >= HIGH_ESTIMATE) {
      mk(e, { key: `${e.u}|estimate-high|${e.wr || '-'}`, family: 'estimate', icon: '💲', title: 'High estimate', severity: 'medium',
        text: `${e.u} pending estimate now ${_money(e.t)} (≥ $30k, L4H Leadership approval tier for powered units).` });
    }
  }
  return out;
}

function _appendDigest(load, save, d, entries, nowMs) {
  const doc = load('assistantChangeDigest', null);
  const digests = (doc && Array.isArray(doc.digests)) ? doc.digests.slice() : [];
  digests.unshift({ id: 'd_' + nowMs + '_' + crypto.randomBytes(3).toString('hex'), at: nowMs,
    source: d._partial || d.source || 'sync', entries: entries.slice(0, MAX_DIGEST_ENTRIES) });
  digests.length = Math.min(digests.length, MAX_DIGESTS);
  let total = 0;
  let keep = 0;
  for (; keep < digests.length; keep++) {
    if (total + digests[keep].entries.length > MAX_DIGEST_ENTRIES) break;
    total += digests[keep].entries.length;
  }
  save('assistantChangeDigest', { digests: digests.slice(0, Math.max(1, keep)) });
}

/**
 * onFleetPush(d, deps) — called (via setImmediate) from app.js _pushData.
 * deps = { load, save, now, notifier, log, session }.
 */
function onFleetPush(d, deps = {}) {
  if (!shouldDiff(d)) return;
  const load = deps.load || store.load;
  const save = deps.save || store.save;
  const now = deps.now || Date.now;
  const log = deps.log || logger;
  const session = deps.session || _session;

  const prev = load('assistantUnitSnapshots', null);
  if (!prev) log.info('[awareness] snapshot baseline (no prior)');
  const asOf = Date.parse(d.scrapedAt || d.aapScrapedAt || '') || 0;
  const nowMs = now();
  const { entries, nextDoc, dirty } = diffUnits(prev, d.rows, nowMs, { asOf, session });

  if (dirty) {
    try { save('assistantUnitSnapshots', nextDoc); }
    catch (e) { log.warn('[awareness] snapshot save failed: ' + e.message); return; }
  }

  if (entries.length) {
    try { _appendDigest(load, save, d, entries, nowMs); }
    catch (e) { log.warn('[awareness] digest save failed: ' + e.message); }

    const rowsById = {};
    for (const r of d.rows) if (r && r.equipmentId) rowsById[String(r.equipmentId)] = r;
    const candidates = proactiveCandidates(entries, rowsById);
    if (candidates.length) {
      try {
        const notifier = deps.notifier || require('./notifier').getNotifier();
        notifier.enqueue(candidates);
      } catch (e) { log.warn('[awareness] notifier enqueue failed: ' + e.message); }
    }
  }

  const fresh = asOf > 0 && asOf >= session.startedAt; // asOf 0 (unknown) never primes
  for (const r of d.rows) {
    if (!r || !r.equipmentId) continue;
    const id = String(r.equipmentId);
    if (asOf > 0 && asOf > (session.asOf.get(id) || 0)) session.asOf.set(id, asOf);
    if (fresh) session.live.set(id, now());
  }
}

module.exports = {
  shouldDiff, diffUnits, proactiveCandidates, onFleetPush,
  STALE_SNAPSHOT_MS, HIGH_ESTIMATE, _session,
};
