'use strict';
/**
 * email-intel/facts/bootstrap.js — legacy-write coverage so mail the legacy path already applied to a
 * timeline is never written again (design 4.6, F-22).
 *
 *   isLegacyRecord(email)               a results record produced by the legacy triage (no intel, or Phase A legacy-triage)
 *   run({ effective, results, now, lookbackDays }) -> { ran, phases[], covered }
 *       per phase transition: runs when effective.capture / multiRecipient / timelineWrites is true and its
 *       checkpoints.bootstrapped key is missing, or when legacy records with unitUpdateApplied:true were
 *       triaged after the stored ISO (legacy writes while the phase was off). Messages of such a conversation
 *       with receivedAt <= triagedAt (or unknown receivedAt and ingestedAt within the lookback) get
 *       `legacyCovered` and are never written by the intel path (their analysis is kept for display).
 *   legacyCovers(msg, unit, results) -> 'bootstrap' | 'legacy-record' | null   the pre-write check
 *
 * Deviation from design 4.6 (documented in the FEAT findings): covered messages keep their analysis status
 * (so the legacy-derived display and the Phase D question state are not lost); only timeline writes are blocked.
 */
const stores = require('../stores');

const PHASES = Object.freeze(['capture', 'multiRecipient', 'timelineWrites']);
const DAY = 86_400_000;

function isLegacyRecord(e) { return !!e && (!e.intel || e.intel.analysisStatus === 'legacy-triage'); }

function _legacyApplied(results) {
  return ((results && Array.isArray(results.emails)) ? results.emails : []).filter((e) => e && e.unitUpdateApplied === true && isLegacyRecord(e));
}

function _units(e) { return (Array.isArray(e.unitRefs) ? e.unitRefs : []).map((u) => String((u && u.unit) || '')).filter(Boolean); }

function run(o) {
  const opts = o || {};
  const eff = opts.effective || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const iso = new Date(now).toISOString();
  const lookbackMs = (Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 14) * DAY;
  const applied = _legacyApplied(opts.results);
  const maxT = applied.reduce((m, e) => (String(e.triagedAt || '') > m ? String(e.triagedAt || '') : m), '');
  const bs = (stores.load('checkpoints').bootstrapped) || {};
  const due = PHASES.filter((p) => eff[p] === true && (!bs[p] || (maxT && maxT > bs[p])));
  if (!due.length) return { ran: false, phases: [], covered: 0 };
  let covered = 0;
  if (applied.length) {
    const byId = new Map(applied.map((e) => [e.id, e]));
    stores.update('messages', (doc) => {
      for (const rec of Object.values((doc && doc.messages) || {})) {
        const e = byId.get(rec.legacyId);
        if (!e) continue;
        const tri = Date.parse(e.triagedAt || '');
        const recv = Date.parse(rec.receivedAt || '');
        const ing = Date.parse(rec.ingestedAt || '');
        const ok = Number.isFinite(recv) ? (Number.isFinite(tri) && recv <= tri) : (Number.isFinite(ing) && now - ing <= lookbackMs);
        if (!ok || rec.legacyCovered) continue;
        rec.legacyCovered = { triagedAt: e.triagedAt || null, units: _units(e), at: iso };
        covered++;
      }
      return doc;
    });
  }
  stores.update('checkpoints', (ck) => {
    ck.bootstrapped = Object.assign({}, ck.bootstrapped || {});
    for (const p of due) ck.bootstrapped[p] = iso;
    return ck;
  });
  return { ran: true, phases: due, covered };
}

/** Pre-write legacy check (design 4.6 last paragraph). */
function legacyCovers(msg, unit, results) {
  const u = String(unit || '');
  const lc = msg && msg.legacyCovered;
  if (lc && (!Array.isArray(lc.units) || !lc.units.length || lc.units.includes(u))) return 'bootstrap';
  const e = ((results && Array.isArray(results.emails)) ? results.emails : []).find((x) => x && x.id === (msg && msg.legacyId));
  if (!e || !isLegacyRecord(e) || e.unitUpdateApplied !== true || !_units(e).includes(u)) return null;
  const tri = Date.parse(e.triagedAt || '');
  const recv = Date.parse((msg && msg.receivedAt) || '');
  if (Number.isFinite(tri) && Number.isFinite(recv) && tri >= recv) return 'legacy-record';
  return null;
}

module.exports = { PHASES, isLegacyRecord, run, legacyCovers };
