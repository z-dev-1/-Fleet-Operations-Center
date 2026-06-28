'use strict';
const logger = require('../utils/logger').createLogger('orcha_priority');
/**
 * orcha_priority.js — Smart Priority Queue
 * 
 * Ranks UNAVAILABLE units into:
 *   🔴 ACTION  — needs your input NOW (vendor waiting, estimate to approve, stale)
 *   🟡 WATCH   — check today (approaching SLA, ETA today, new conversation)
 *   🟢 ON TRACK — vendor working, no action needed
 * 
 * Runs after every scan. No AI call needed — pure rule engine + data signals.
 */

const STALE_DAYS = 3;        // No update in 3 days = stale
const CRITICAL_DAYS = 7;     // 7+ days offsite = critical
const SLA_WARNING_DAYS = 5;  // Approaching SLA at 5 days

/**
 * calculatePriority(unit) — returns { tier, score, reasons[] }
 * tier: 'action' | 'watch' | 'track'
 * score: 0-100 (higher = more urgent)
 */
function calculatePriority(unit) {
  let score = 0;
  const reasons = [];
  const now = Date.now();

  // ── TIER: ACTION (needs you NOW) ─────────────────────────────────────

  // No vendor assigned
  if (!unit.vendor || unit.vendor === 'UNASSIGNED' || unit.vendor === '') {
    score += 40;
    reasons.push('No vendor assigned');
  }

  // Stale: no conversation update in 3+ days
  const lastUpdate = unit.lastConversationDate || unit.created || '';
  if (lastUpdate) {
    const daysSince = (now - new Date(lastUpdate).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= CRITICAL_DAYS) {
      score += 35;
      reasons.push(`No update in ${Math.floor(daysSince)} days`);
    } else if (daysSince >= STALE_DAYS) {
      score += 20;
      reasons.push(`${Math.floor(daysSince)} days since last update`);
    }
  }

  // Offsite 7+ days
  const created = unit.created || '';
  if (created) {
    const daysOffsite = (now - new Date(created).getTime()) / (1000 * 60 * 60 * 24);
    if (daysOffsite >= CRITICAL_DAYS) {
      score += 25;
      reasons.push(`Offsite ${Math.floor(daysOffsite)} days`);
    } else if (daysOffsite >= SLA_WARNING_DAYS) {
      score += 10;
      reasons.push(`Offsite ${Math.floor(daysOffsite)} days — SLA approaching`);
    }
  }

  // Pending estimate/approval (keywords in notes or status)
  const notes = (unit.savedNotes || unit.notes || '').toLowerCase();
  const status = (unit.savedRepairStatus || unit.repairStatus || '').toLowerCase();
  const issue = (unit.issue || unit.issueDetails || '').toLowerCase();

  if (status.includes('pending') && (status.includes('estimate') || status.includes('approval'))) {
    score += 30;
    reasons.push('Estimate pending your approval');
  }

  if (notes.includes('waiting on') && notes.includes('you')) {
    score += 25;
    reasons.push('Vendor waiting on you');
  }

  if (notes.includes('call') && (notes.includes('schedule') || notes.includes('pickup'))) {
    score += 20;
    reasons.push('Needs call/scheduling');
  }

  // High risk score from Uptake
  if (unit.riskScore && unit.riskScore >= 75) {
    score += 15;
    reasons.push(`High risk (${unit.riskScore})`);
  }

  // No notes at all (Orcha hasn't processed yet or brand new)
  if (!unit.savedNotes && !notes) {
    score += 10;
    reasons.push('No notes — needs review');
  }

  // ── TIER: WATCH (monitor today) ──────────────────────────────────────

  // Parts on order / ETA today
  if (notes.includes('parts') && (notes.includes('order') || notes.includes('eta'))) {
    score += 8;
    reasons.push('Parts on order');
  }

  // New conversation activity
  if (unit._hasNewActivity) {
    score += 12;
    reasons.push('New vendor update');
  }

  // Pending diag
  if (status.includes('pending') && status.includes('diag')) {
    score += 8;
    reasons.push('Pending diagnostics');
  }

  // ── TIER ASSIGNMENT ──────────────────────────────────────────────────
  let tier;
  if (score >= 30) {
    tier = 'action';
  } else if (score >= 12) {
    tier = 'watch';
  } else {
    tier = 'track';
  }

  return {
    tier,
    score: Math.min(100, score),
    reasons,
    label: tier === 'action' ? '🔴 ACTION' : tier === 'watch' ? '🟡 WATCH' : '🟢 ON TRACK',
    color: tier === 'action' ? '#f85149' : tier === 'watch' ? '#f0a800' : '#3fb950',
  };
}

/**
 * prioritizeUnits(units) — ranks all UNAVAILABLE units
 * Returns sorted array with priority attached, action units first
 */
function prioritizeUnits(units) {
  const unavail = (units || []).filter(u =>
    u.lifecycleState === 'UNAVAILABLE' || (u.atsState || '').toLowerCase() === 'unavailable'
  );

  const prioritized = unavail.map(u => {
    const p = calculatePriority(u);
    return { ...u, _priority: p };
  });

  // Sort: action first (highest score), then watch, then track
  prioritized.sort((a, b) => b._priority.score - a._priority.score);

  const counts = { action: 0, watch: 0, track: 0 };
  prioritized.forEach(u => counts[u._priority.tier]++);

  return { units: prioritized, counts };
}

module.exports = { calculatePriority, prioritizeUnits };
