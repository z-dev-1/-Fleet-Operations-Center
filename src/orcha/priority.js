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
    u.lifecycleState === 'UNAVAILABLE' || (u.atsState || '').toLowerCase() === 'unavailable'
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
