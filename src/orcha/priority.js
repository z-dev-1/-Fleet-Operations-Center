'use strict';
/**
 * priority.js — Smart Priority Engine [V-C]
 * V-C changes vs V-B:
 *   - Added 'use strict' + logger header (no file I/O in this module)
 *   - Pure rule engine — identical logic to V-B
 *
 * Ranks UNAVAILABLE units:
 *   🔴 ACTION  — needs input NOW
 *   🟡 WATCH   — check today
 *   🟢 ON TRACK — vendor working, no action needed
 */
const STALE_DAYS       = 3;
const CRITICAL_DAYS    = 7;
const SLA_WARNING_DAYS = 5;
const SLOW_VENDOR_AVG  = 6;  // if vendor's avg repair > 6 days, boost urgency

// ── Pattern-aware scoring (S28-Sprint3 integration) ────────────────────────
// Loads learned vendor performance data to boost priority for historically slow vendors.
const fs   = require('fs');
const path = require('path');
let _patternsCache = null;
let _patternsCacheTs = 0;

function _getPatterns() {
  // Cache for 60s to avoid re-reading disk every call
  const now = Date.now();
  if (_patternsCache && (now - _patternsCacheTs < 60000)) return _patternsCache;
  try {
    const { P } = require('../config/paths');
    const stateFile = path.join(P.dataDir, 'patterns_state.json');
    if (fs.existsSync(stateFile)) {
      _patternsCache = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      _patternsCacheTs = now;
    }
  } catch (_) { _patternsCache = null; }
  return _patternsCache;
}

/**
 * calculatePriority(unit) — returns { tier, score, reasons[] }
 * tier: 'action' | 'watch' | 'track'
 * score: 0-100 (higher = more urgent)
 */
function calculatePriority(unit) {
  let score = 0;
  const reasons = [];
  const now = Date.now();

  // ── TIER: ACTION ─────────────────────────────────────────────────────────

  if (!unit.vendor || unit.vendor === 'UNASSIGNED' || unit.vendor === '') {
    score += 40; reasons.push('No vendor assigned');
  }

  const lastUpdate = unit.lastConversationDate || unit.created || '';
  if (lastUpdate) {
    const daysSince = (now - new Date(lastUpdate).getTime()) / 86400000;
    if (daysSince >= CRITICAL_DAYS) {
      score += 35; reasons.push(`No update in ${Math.floor(daysSince)} days`);
    } else if (daysSince >= STALE_DAYS) {
      score += 20; reasons.push(`${Math.floor(daysSince)} days since last update`);
    }
  }

  const created = unit.created || '';
  if (created) {
    const daysOffsite = (now - new Date(created).getTime()) / 86400000;
    if (daysOffsite >= CRITICAL_DAYS) {
      score += 25; reasons.push(`Offsite ${Math.floor(daysOffsite)} days`);
    } else if (daysOffsite >= SLA_WARNING_DAYS) {
      score += 10; reasons.push(`Offsite ${Math.floor(daysOffsite)} days — SLA approaching`);
    }
  }

  const notes  = (unit.savedNotes || unit.notes || '').toLowerCase();
  const status = (unit.savedRepairStatus || unit.repairStatus || '').toLowerCase();

  if (status.includes('pending') && (status.includes('estimate') || status.includes('approval'))) {
    score += 30; reasons.push('Estimate pending your approval');
  }
  if (notes.includes('waiting on') && notes.includes('you')) {
    score += 25; reasons.push('Vendor waiting on you');
  }
  if (notes.includes('call') && (notes.includes('schedule') || notes.includes('pickup'))) {
    score += 20; reasons.push('Needs call/scheduling');
  }
  if (unit.riskScore && unit.riskScore >= 75) {
    score += 15; reasons.push(`High risk (${unit.riskScore})`);
  }
  // Pattern boost: if vendor is historically slow, increase urgency
  const vendorName = (unit.vendor || '').trim();
  if (vendorName && vendorName !== '--') {
    const patterns = _getPatterns();
    if (patterns && patterns.vendorPerf && patterns.vendorPerf[vendorName]) {
      const avgDays = patterns.vendorPerf[vendorName].avgDays;
      if (avgDays && avgDays > SLOW_VENDOR_AVG) {
        score += 10;
        reasons.push(`Slow vendor history (avg ${Math.round(avgDays)}d)`);
      }
    }
  }
  if (!unit.savedNotes && !notes) {
    score += 10; reasons.push('No notes — needs review');
  }

  // ── TIER: WATCH ──────────────────────────────────────────────────────────

  if (notes.includes('parts') && (notes.includes('order') || notes.includes('eta'))) {
    score += 8; reasons.push('Parts on order');
  }
  if (unit._hasNewActivity) {
    score += 12; reasons.push('New vendor update');
  }
  if (status.includes('pending') && status.includes('diag')) {
    score += 8; reasons.push('Pending diagnostics');
  }

  // ── TIER ASSIGNMENT ──────────────────────────────────────────────────────
  const tier = score >= 30 ? 'action' : score >= 12 ? 'watch' : 'track';

  return {
    tier,
    score:  Math.min(100, score),
    reasons,
    label:  tier === 'action' ? '🔴 ACTION' : tier === 'watch' ? '🟡 WATCH' : '🟢 ON TRACK',
    color:  tier === 'action' ? '#f85149' : tier === 'watch' ? '#f0a800' : '#3fb950',
  };
}

/**
 * prioritizeUnits(units) — rank all UNAVAILABLE units, action first
 */
function prioritizeUnits(units) {
  const unavail = (units || []).filter(u =>
    (u.lifecycleState || '').toLowerCase() === 'unavailable' || (u.atsState || '').toLowerCase() === 'unavailable'
  );

  const prioritized = unavail.map(u => {
    const p = calculatePriority(u);
    return { ...u, _priority: p };
  });

  prioritized.sort((a, b) => b._priority.score - a._priority.score);

  const counts = { action: 0, watch: 0, track: 0 };
  prioritized.forEach(u => counts[u._priority.tier]++);

  return { units: prioritized, counts };
}

module.exports = { calculatePriority, prioritizeUnits };
