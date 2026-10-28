'use strict';
/**
 * src/dev/timeline-audit.js — READ-ONLY timeline freshness audit (dev aid).
 *
 * Enabled only by FLEET_TIMELINE_AUDIT=1 (see src/app.js). Two parts:
 *
 * 1) WRITE TRACER — wraps store.save (pass-through, behavior unchanged) and,
 *    for every fleetData / notesStore write, records each down unit's newest
 *    dated timeline entry. If a write makes a unit's timeline go BACKWARDS
 *    (older than a previous write), it logs a REGRESSION with the caller stack
 *    so we can see exactly which code path wrote the stale copy.
 *
 * 2) GROUND-TRUTH PASS — after the first API load, for every down unit it
 *    calls aap_api.refreshUnit (GET only) to get the LIVE WR comment threads
 *    (primary + secondary WRs), finds the newest comment date, and compares it
 *    with the built timeline (notesStore) and what the fleet row shows.
 *    Each unit gets a verdict + reason.
 *
 * Output: %TEMP%\timeline_audit.json (ground truth) and
 *         %TEMP%\timeline_audit_writes.json (tracer). Nothing else is written.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'timeline_audit.json');
const OUT_W = path.join(os.tmpdir(), 'timeline_audit_writes.json');

// Newest "MM/DD - ..." (or "MM/DD-MM/DD - ...") LINE-START entry → sortable
// number YYYYMMDD. Dated text inside sentences (e.g. "ETC 11/2") is ignored.
function lastEntry(txt) {
  const s = String(txt || '');
  const now = new Date();
  let best = -1, label = '';
  for (const m of s.matchAll(/(?:^|\n)\s*(\d{1,2})\/(\d{1,2})(?:-(\d{1,2})\/(\d{1,2}))?\s*-/g)) {
    const mo = +(m[3] || m[1]), d = +(m[4] || m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    let y = now.getFullYear(); if (mo > now.getMonth() + 1) y -= 1;
    const v = y * 10000 + mo * 100 + d;
    if (v > best) { best = v; label = mo + '/' + d; }
  }
  return { v: best, label };
}
// Is the newest entry a placeholder like "10/27 - [no update logged]"?
function lastIsPlaceholder(txt) {
  const lines = String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? /\[no update logged\]/i.test(lines[lines.length - 1]) : false;
}
const isDown = (r) => /unavail/i.test(String((r && r.lifecycleState) || ''));
const shortStack = () => String(new Error().stack || '').split('\n').slice(3, 9)
  .map((l) => l.trim().replace(/^at /, '').replace(/\(.*fleet-version-c[\\/]/, '(')).join(' <- ');

function start({ log }) {
  const L = log || console;
  const store = require('../store');
  const watch = String(process.env.FLEET_TIMELINE_AUDIT_WATCH || '321186').split(',').map((s) => s.trim()).filter(Boolean);

  // ── 1) write tracer ─────────────────────────────────────────────────────────
  const best = new Map();            // `${key}:${id}` -> newest v seen
  const writes = [];                 // compact per-write records (capped)
  const regressions = [];
  const origSave = store.save;
  store.save = function patchedSave(key, data) {
    try {
      if (key === 'fleetData' || key === 'notesStore') {
        const stack = shortStack();
        const units = {};
        const entries = key === 'fleetData'
          ? ((data && Array.isArray(data.rows)) ? data.rows.filter(isDown).map((r) => [String(r.equipmentId), r.repairTimeline]) : [])
          : Object.entries(data || {}).map(([id, n]) => [id, n && n.timeline]);
        for (const [id, tl] of entries) {
          const le = lastEntry(tl);
          const k = key + ':' + id;
          const prev = best.get(k);
          if (prev != null && le.v >= 0 && le.v < prev) {
            regressions.push({ ts: new Date().toISOString(), key, id, from: prev, to: le.v, toLabel: le.label, stack });
          }
          if (le.v > (prev == null ? -1 : prev)) best.set(k, le.v);
          if (watch.includes(id)) units[id] = le.label || '-';
        }
        if (writes.length < 400) writes.push({ ts: new Date().toISOString(), key, rows: entries.length, watch: units, stack });
        fs.writeFileSync(OUT_W, JSON.stringify({ watch, regressions, writes }, null, 1));
      }
    } catch (_) { /* tracer must never affect the real save */ }
    return origSave.apply(this, arguments);
  };
  L.info('[timeline-audit] write tracer armed (watch: ' + watch.join(',') + ')');

  // ── 2) ground-truth pass ────────────────────────────────────────────────────
  const delay = Number(process.env.FLEET_TIMELINE_AUDIT_DELAY_MS || 150000);
  setTimeout(async () => {
    const api = require('../scrapers/aap_api');
    const fd = store.load('fleetData', { rows: [] });
    const down = (fd.rows || []).filter(isDown);
    L.info('[timeline-audit] ground-truth pass: ' + down.length + ' down units');
    const results = [];
    for (const r of down) {
      const id = String(r.equipmentId);
      const out = { id, site: r.domicileSite || '', op: r.operator || '', vendor: r.vendor || '', reason: r.lifecycleReason || '' };
      try {
        const fr = await api.refreshUnit(id);
        const sec = (fr && Array.isArray(fr._secondaryWRs)) ? fr._secondaryWRs : [];
        const primConv = (fr && fr.fullConversation) || '';
        const primLe = lastEntry(primConv);
        let srcLe = primLe, srcWhere = 'primary';
        for (const s of sec) {
          const le = lastEntry(s && s.fullConversation);
          if (le.v > srcLe.v) { srcLe = le; srcWhere = 'secondary'; }
        }
        const notes = (store.load('notesStore', {}) || {})[id] || {};
        const fdNow = store.load('fleetData', { rows: [] });
        const rowNow = (fdNow.rows || []).find((x) => String(x.equipmentId) === id) || {};
        const nt = lastEntry(notes.timeline);
        const rt = lastEntry(rowNow.repairTimeline);
        Object.assign(out, {
          wrId: (fr && fr.workRequestId) || r.workRequestId || '',
          wrCount: 1 + sec.length,
          commentLines: (primConv.match(/(?:^|\n)\s*\d{1,2}\/\d{1,2}\s*-/g) || []).length,
          latestComment: srcLe.label || '-', latestIn: srcLe.v >= 0 ? srcWhere : '-',
          timelineLatest: nt.label || '-', rowLatest: rt.label || '-',
          timelineBuiltAt: notes._lastAiCorrection || '',
          timelineEndsWithPlaceholder: lastIsPlaceholder(notes.timeline),
          manual: !notes._autoGenerated && !!notes.timeline,
        });
        let verdict, why = '';
        if (!out.wrId && srcLe.v < 0) { verdict = 'NO_WR'; why = 'unit down with no work request in AAP'; }
        else if (srcLe.v < 0) { verdict = 'NO_COMMENTS'; why = 'WR exists but has no dated comments yet'; }
        else if (nt.v < srcLe.v) {
          verdict = 'TIMELINE_BEHIND';
          const builtMs = notes._lastAiCorrection ? Date.parse(notes._lastAiCorrection) : 0;
          why = !notes.timeline ? 'no timeline has been built'
            : (!notes._autoGenerated ? 'manual timeline — auto-rebuild skipped'
            : (srcWhere === 'secondary' ? 'newest update is on a SECONDARY WR'
            : (builtMs && (Date.now() - builtMs) < 3 * 3600e3 ? 'timeline rebuilt recently but AI dropped the newest comment'
            : 'timeline not rebuilt since the newest comment (last build ' + (notes._lastAiCorrection || 'never') + ')')));
        } else if (rt.v < nt.v) { verdict = 'ROW_STALE'; why = 'built timeline is current but the fleet row shows an older copy'; }
        else verdict = 'OK';
        out.verdict = verdict; out.why = why;

        // OFFSITE check: does the offsite the row shows belong to a CURRENT WR?
        const rowUrl = rowNow.offsiteShopEventUrl || rowNow.savedOffsiteUrl || rowNow.asistSrUrl || '';
        const liveUrl = (fr && (fr.offsiteShopEventUrl || fr.savedOffsiteUrl || fr.asistSrUrl)) || '';
        const allConv = [primConv].concat(sec.map((s) => (s && s.fullConversation) || '')).join('\n');
        out.offsiteRow = rowUrl.replace(/^https?:\/\//, '');
        out.offsiteLive = liveUrl.replace(/^https?:\/\//, '');
        out.offsiteWrId = rowNow._offsiteWrId || '';
        if (!rowUrl && !liveUrl) out.offsite = 'NONE';
        else if (!rowUrl && liveUrl) out.offsite = 'MISSING (current WR names one, row shows none)';
        else if (liveUrl && liveUrl === rowUrl) out.offsite = 'OK';
        else if (allConv.includes(rowUrl.split('?')[0])) out.offsite = 'OK (in a current WR thread)';
        else if (liveUrl) out.offsite = 'WRONG (row shows a different offsite than the current WR)';
        else out.offsite = 'STALE (not in any current WR comment)';
      } catch (e) {
        out.verdict = 'AUDIT_ERROR'; out.why = (e && e.message) || String(e);
      }
      results.push(out);
      await new Promise((res) => setTimeout(res, 250));
    }
    const counts = {};
    for (const x of results) counts[x.verdict] = (counts[x.verdict] || 0) + 1;
    for (const x of results) { const k = 'offsite:' + String(x.offsite || 'n/a').split(' ')[0]; counts[k] = (counts[k] || 0) + 1; }
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), down: down.length, counts, results }, null, 1));
    L.info('[timeline-audit] DONE ' + JSON.stringify(counts) + ' → ' + OUT);
  }, delay);
}

module.exports = { start, lastEntry };
