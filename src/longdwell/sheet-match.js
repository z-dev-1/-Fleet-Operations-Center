'use strict';
/**
 * longdwell/sheet-match.js - match computed Long Dwell units (one entry per
 * open WO) to rows of the weekly sheet. Unit key = column C "Asset ID".
 *
 * Per unit (after normUnitId):
 *   0 rows             -> every WO 'not-in-sheet' (nothing is ever added)
 *   1 row,  1 WO       -> 'matched' via 'unit'
 *   1 row,  N WOs      -> primary WO 'matched' with needsConfirm; others 'extra-wo'
 *   M>1 rows           -> per WO, one precedence rule (plan A7):
 *       WO column present and the WO has a number: rows whose WO cell equals it
 *       (via 'wo-column'); if none, only rows with a BLANK WO cell (never a row
 *       with a different non-empty WO). Then, only if more than one candidate is
 *       left, the vendor filter (normKey equality) when it leaves >= 1 row
 *       (via 'vendor'). Matched only on a single candidate that is the sole
 *       candidate of no other WO of the unit (bijection); otherwise 'ambiguous'.
 *
 * Every match carries a matchKey {via, sheetRow, vendorKey, woKey,
 * candidateCount} so the write step can re-run the match on fresh bytes and
 * require the same row and the same rule. Pure; no text is logged.
 */
const { normUnitId, normKey } = require('./sheet-columns');

function _blank(s) { return normKey(s) === ''; }

function _matchKey(via, row, candidateCount) {
  return { via, sheetRow: row.sheetRow, vendorKey: normKey(row.vendor), woKey: normKey(row.wo), candidateCount };
}

function _result(u, match, extra) {
  return {
    equipmentId: u.equipmentId, woKey: u.woKey, match,
    sheetRow: null, candidates: [], via: null, needsConfirm: false, matchKey: null,
    ...extra,
  };
}

// Candidate rows for one WO of a multi-row unit (plan A7).
function _candidates(rows, u, hasWoCol) {
  let cand = rows, via = null, blankWo = false;
  const keys = [normKey(u.woNumber), normKey(u.woAmz)].filter(Boolean);
  if (hasWoCol && keys.length) {
    const byWo = rows.filter((r) => { const k = normKey(r.wo); return k !== '' && keys.includes(k); });
    if (byWo.length) { cand = byWo; via = 'wo-column'; } else { cand = rows.filter((r) => _blank(r.wo)); blankWo = true; }
  }
  if (cand.length > 1) {
    const vk = normKey(u.vendor);
    const byVendor = vk ? cand.filter((r) => normKey(r.vendor) === vk) : [];
    if (byVendor.length >= 1) { cand = byVendor; via = 'vendor'; }
  }
  return { cand, via, blankWo };
}

function matchUnits(sheetRows, units, opts = {}) {
  const hasWoCol = opts.hasWoCol === true;
  const rowsByUnit = new Map();
  for (const r of sheetRows || []) {
    const k = normUnitId(r && r.unitKey);
    if (!k) continue;
    if (!rowsByUnit.has(k)) rowsByUnit.set(k, []);
    rowsByUnit.get(k).push(r);
  }
  const unitsByKey = new Map();
  const order = [];
  for (const u of units || []) {
    const k = normUnitId(u && u.equipmentId);
    if (!unitsByKey.has(k)) { unitsByKey.set(k, []); }
    unitsByKey.get(k).push(u);
    order.push({ u, k });
  }
  const out = new Map(); // unit object -> result
  for (const [k, wos] of unitsByKey) {
    const rows = k ? rowsByUnit.get(k) || [] : [];
    if (!rows.length) { for (const u of wos) out.set(u, _result(u, 'not-in-sheet')); continue; }
    if (rows.length === 1) {
      const row = rows[0];
      if (wos.length === 1) {
        out.set(wos[0], _result(wos[0], 'matched', { sheetRow: row.sheetRow, candidates: [row.sheetRow], via: 'unit', matchKey: _matchKey('unit', row, 1) }));
        continue;
      }
      const primary = wos.find((u) => u.isPrimary === true) || wos[0];
      for (const u of wos) {
        if (u === primary) out.set(u, _result(u, 'matched', { sheetRow: row.sheetRow, candidates: [row.sheetRow], via: 'unit', needsConfirm: true, matchKey: _matchKey('unit', row, 1) }));
        else out.set(u, _result(u, 'extra-wo', { candidates: [row.sheetRow] }));
      }
      continue;
    }
    // M > 1 rows
    const perWo = wos.map((u) => ({ u, ..._candidates(rows, u, hasWoCol) }));
    for (const w of perWo) {
      const nums = w.cand.map((r) => r.sheetRow);
      if (w.cand.length === 1) {
        const row = w.cand[0];
        const taken = perWo.some((o) => o !== w && o.cand.length === 1 && o.cand[0] === row);
        if (!taken) {
          const via = w.via || 'unit';
          out.set(w.u, _result(w.u, 'matched', {
            sheetRow: row.sheetRow, candidates: nums, via,
            needsConfirm: w.blankWo === true,
            matchKey: _matchKey(via, row, 1),
          }));
          continue;
        }
      }
      out.set(w.u, _result(w.u, 'ambiguous', { candidates: nums }));
    }
  }
  return order.map(({ u }) => out.get(u));
}

module.exports = { matchUnits };
