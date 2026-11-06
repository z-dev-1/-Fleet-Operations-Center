'use strict';
/**
 * email-intel/facts/pipeline.js — scan stage 7 (design 4, 8.2): evaluate every new validated fact and
 * apply, stage, corroborate or record it; plus the scan-start steps 4 (pending-write reconcile, staged
 * caps) and 5 (per-phase legacy bootstrap).
 *
 *   beforeAnalysis({ effective, prevResults, lookbackDays }) -> { bootstrap, reconcile }
 *   runFactStage(ctx) -> stats   ctx: { effective, index, intelCfg, optCfg:{autoApplyUnitUpdates, readyDmSuggested},
 *                                       prevResults, canonicalFor(unit), scanId }
 *
 * optCfg is the legacy emailTriageConfig opt-outs, read ONCE per scan by the orchestrator (F2-01).
 * Messages are evaluated once per analysis (rec.factsEval.analyzedAt); a rescan of known mail evaluates
 * nothing. Facts are processed oldest message first so a later value supersedes an earlier one (case G).
 * With timelineWrites not effective every fact stages `timeline-disabled` (shadow mode, design 4.7).
 * Logs carry counts only.
 */
const stores = require('../stores');
const ledgerMod = require('../ingest/ledger');
const rc = require('./reconcile');
const staged = require('./staged');
const writer = require('./timeline-writer');
const evidence = require('./evidence');
const bootstrap = require('./bootstrap');
const { errName } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const MENTION_STATUSES = new Set(['ai-unavailable', 'failed-permanent']);

async function beforeAnalysis(o) {
  const out = { bootstrap: null, reconcile: null, caps: null };
  try { out.bootstrap = bootstrap.run({ effective: o.effective, results: o.prevResults, now: Date.now(), lookbackDays: o.lookbackDays }); } catch (e) { logger.warn('[email-intel] bootstrap failed ' + errName(e)); }
  if (o.effective && o.effective.timelineWrites) {
    try { out.reconcile = await writer.reconcilePending({ now: Date.now() }); } catch (e) { logger.warn('[email-intel] pending reconcile failed ' + errName(e)); }
  }
  try { stores.update('staged', (doc) => { out.caps = staged.applyCaps(staged.ensureDoc(doc), Date.now()); return doc; }); } catch (_) { /* caps only */ }
  return out;
}

function _rowFor(unit) {
  try {
    const store = require('../../store');
    const ns = store.load('notesStore', {}) || {};
    const fd = store.load('fleetData', {}) || {};
    const row = (Array.isArray(fd.rows) ? fd.rows : []).find((r) => String(r.equipmentId || '') === String(unit)) || {};
    return { asistScrapedAt: (ns[unit] && ns[unit].asistScrapedAt) || row.asistScrapedAt || '' };
  } catch (_) { return null; }
}

function _mention(unit, msg, reason, detail) {
  staged.stageFact({ fact: null, unit, msg, reason, detail, now: Date.now() });
}

async function runFactStage(c) {
  const stats = { evaluated: 0, applied: 0, staged: 0, duplicate: 0, duplicateOfCanonical: 0, stale: 0, outOfScope: 0, legacyCovered: 0, filtered: 0, mentions: 0, errors: 0, byReason: {}, ledgerError: false };
  const eff = c.effective || {};
  const writes = eff.timelineWrites === true;
  const doc = ledgerMod.ensureDoc(stores.load('messages'));
  const candidates = [];
  const evaluatedKeys = [];
  const openIds = new Set(Object.values(staged.load().items).filter((x) => x.state === 'open').map((x) => x.stagedId));
  for (const rec of Object.values(doc.messages || {})) {
    const a = rec.analysis || {};
    const stamp = a.analyzedAt || null;
    if (!stamp || (rec.factsEval && rec.factsEval.analyzedAt === stamp)) continue;
    if (a.status === 'ok' && a.result) {
      evaluatedKeys.push({ key: rec.messageKey, stamp });
      // an earlier "AI unavailable" mention for this message is resolved by the analysis
      const ids = ((a.deterministic && a.deterministic.units) || []).map((u) => staged.stagedIdOf(staged.mentionFactKey(u.unit, 'ai-unavailable'), rec.messageKey));
      if (ids.length && ids.some((id) => openIds.has(id))) {
        stores.update('staged', (d) => { for (const id of ids) if (d.items && d.items[id] && d.items[id].state === 'open') staged.close(d, id, 'superseded', 'resolved-by-analysis', Date.now()); return d; });
      }
      if (rec.legacyCovered) { stats.legacyCovered++; continue; }
      for (const u of a.unprocessedUnits || []) { _mention(u.unit, rec, 'unprocessed-window', 'part of the email was not analyzed'); stats.mentions++; }
      for (const u of a.result.units || []) {
        for (const f of u.facts || []) candidates.push({ id: candidates.length, unit: u.unit, fact: f, msg: rec, unprocessed: new Set((a.unprocessedUnits || []).map((x) => String(x.unit))) });
      }
    } else if (MENTION_STATUSES.has(a.status)) {
      evaluatedKeys.push({ key: rec.messageKey, stamp });
      if (rec.legacyCovered) continue;
      for (const u of (a.deterministic && a.deterministic.units) || []) {
        if (u.scope !== 'in' && u.scope !== 'unknown') continue;
        _mention(u.unit, rec, 'ai-unavailable', 'the email could not be analyzed'); stats.mentions++;
      }
    }
  }
  const tOf = (x) => Date.parse(x.msg.receivedAt || '') || Date.parse(x.msg.ingestedAt || '') || 0;
  candidates.sort((x, y) => (tOf(x) - tOf(y)) || (x.id - y.id));
  const ambiguous = rc.ambiguousOrder(candidates);

  for (const cand of candidates) {
    const { unit, fact, msg } = cand;
    stats.evaluated++;
    let canonical = null; let canonicalError = false;
    try { canonical = c.canonicalFor ? c.canonicalFor(unit) : null; } catch (_) { canonicalError = true; }
    const detail = c.index && c.index.detail ? c.index.detail(unit) : { scope: 'unknown' };
    const ledgerEntries = Object.values(stores.load('ledger').entries || {});
    const ev = rc.evaluateFact(fact, {
      unit, scope: c.index ? c.index.scopeOf(unit) : 'unknown', rosterMismatch: !!detail.rosterMismatch, canonical, canonicalError, row: _rowFor(unit),
      ledgerEntries, msg, flags: eff, cfg: c.optCfg || {}, intelCfg: c.intelCfg || {}, unprocessed: cand.unprocessed, ambiguousOrder: ambiguous.has(cand.id),
    });
    const keys = ev.keys;
    if (ev.verdict === 'out-of-scope') { stats.outOfScope++; continue; }
    if (ev.verdict === 'duplicate') {
      stores.update('ledger', (d) => {
        const e = d.entries && d.entries[ev.duplicateOf];
        if (e && msg.messageKey !== e.messageKey && !(e.corroboratedBy || []).includes(msg.messageKey)) {
          e.seenCount = (e.seenCount || 1) + 1;
          e.corroboratedBy = (e.corroboratedBy || []).concat(msg.messageKey).slice(0, 10);
        }
        return d;
      });
      stores.update('staged', (d) => { staged.corroborate(d, keys.factKey, msg.messageKey); return d; });
      stats.duplicate++;
      continue;
    }
    if (ev.verdict === 'duplicate-of-canonical') {
      stores.update('staged', (d) => {
        for (const it of Object.values(staged.ensureDoc(d).items)) if (it.state === 'open' && it.factKey === keys.factKey) staged.close(d, it.stagedId, 'superseded', 'resolved-by-canonical', Date.now());
        return d;
      });
      stats.duplicateOfCanonical++;
      continue;
    }
    if (ev.verdict === 'stale') {
      if (writes) evidence.recordEvidence({ unit, fact, keys, msg, usedInConclusion: false, informationType: 'stale' });
      stats.stale++;
      continue;
    }
    if (ev.verdict === 'stage') {
      _stageEval(cand, ev, writes);
      stats.staged++; stats.byReason[ev.reason] = (stats.byReason[ev.reason] || 0) + 1;
      continue;
    }
    // apply: the legacy pre-write check first (design 4.6)
    if (bootstrap.legacyCovers(msg, unit, c.prevResults) === 'legacy-record') {
      _stageEval(cand, Object.assign({}, ev, { reason: 'possible-duplicate', detail: 'the legacy email triage already updated this unit' }), writes);
      stats.staged++; stats.byReason['possible-duplicate'] = (stats.byReason['possible-duplicate'] || 0) + 1;
      continue;
    }
    let r;
    try { r = await writer.commitFact({ fact, unit, msg, evalResult: ev, scopeOf: c.index ? c.index.scopeOf : null, now: Date.now() }); } catch (e) { logger.warn('[email-intel] commit failed ' + errName(e)); r = { state: 'error', code: 'threw' }; }
    if (r.state === 'applied') stats.applied++;
    else if (r.state === 'duplicate') stats.duplicate++;
    else if (r.state === 'filtered') stats.filtered++;
    else if (r.state === 'staged' || r.state === 'standby') { stats.staged++; const k = r.reason || 'standby-host'; stats.byReason[k] = (stats.byReason[k] || 0) + 1; }
    else if (r.state === 'out-of-scope') stats.outOfScope++;
    else if (r.state === 'error') {
      stats.errors++;
      if (r.code === 'ledger') { stats.ledgerError = true; break; }        // intent-first: nothing written without the intent record
    }
  }

  if (!stats.ledgerError && evaluatedKeys.length) {
    const iso = new Date().toISOString();
    stores.update('messages', (d) => {
      for (const { key, stamp } of evaluatedKeys) { const m = d.messages && d.messages[key]; if (m) m.factsEval = { analyzedAt: stamp, at: iso, scanId: c.scanId || null }; }
      return d;
    });
  }
  try { stores.update('staged', (d) => { staged.applyCaps(staged.ensureDoc(d), Date.now()); return d; }); } catch (_) { /* caps only */ }
  logger.info('[email-intel] facts id=' + (c.scanId || '-') + ' evaluated=' + stats.evaluated + ' applied=' + stats.applied + ' staged=' + stats.staged + ' duplicate=' + stats.duplicate + ' stale=' + stats.stale + ' outOfScope=' + stats.outOfScope + ' filtered=' + stats.filtered + ' errors=' + stats.errors);
  return stats;
}

function _stageEval(cand, ev, writes) {
  const { unit, fact, msg } = cand;
  let proposedLine = '';
  if (fact) proposedLine = writer.buildLine({ fact, unit, msg, verifiedBy: ev.reason === 'conflict-ready' ? 'none' : ev.verifiedBy, userApproved: true });
  staged.stageFact({ fact, unit, msg, reason: ev.reason, detail: ev.detail, canonicalSnapshot: ev.canonicalSnapshot || null, proposedLine, now: Date.now() });
  if (ev.contradicts) {
    stores.update('ledger', (d) => { const e = d.entries && d.entries[ev.contradicts]; if (e && e.state === 'applied') { e.state = 'contradicted'; e.contradictedBy = msg.messageKey; } return d; });
  }
  if (writes && (ev.reason === 'conflict-canonical' || ev.reason === 'conflict-ready')) {
    evidence.recordEvidence({ unit, fact, keys: ev.keys, msg, usedInConclusion: false, isConflict: true, informationType: 'contradiction', stagedReason: ev.reason });
  }
}

module.exports = { beforeAnalysis, runFactStage };
