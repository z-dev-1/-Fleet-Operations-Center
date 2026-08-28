'use strict';
/**
 * email-summary.js — Smart change summary for auto-emails
 *
 * Compares current fleet state to the last email snapshot and generates
 * an HTML summary section showing:
 *   - New breakdowns (units that went unavailable since last send)
 *   - Returned to service (units that came back since last send)
 *   - Stalled units (down 5+ days with no recent timeline activity)
 *   - Fleet metrics delta (total unavail, avg days down, risk counts)
 */

const store  = require('../store');
const logger = require('../utils/logger').createLogger('email-summary');

const STALE_DAYS_THRESHOLD = 5;
const STALE_NO_UPDATE_HOURS = 48;

/**
 * buildChangeSummary(currentUnits, opts)
 * @param {Array} currentUnits - Current fleet unit rows (already merged/enriched)
 * @param {object} opts - { slot }
 * @returns {{ html: string, meta: { newCount, returnedCount, stalledCount, unavailCount, delta } }}
 */
function buildChangeSummary(currentUnits, opts = {}) {
  const slot = opts.slot || '';

  // BUG FIX (2026-08-28): the snapshot used to be a single global key
  // ('emailLastSnapshot'). Emails are built per operator (each with its own
  // operator-filtered `currentUnits`), so a shared snapshot cross-contaminated
  // the diff: operator A's send overwrote the snapshot with only A's units,
  // then operator B diffed B's units against A's snapshot — making all of B's
  // units look "new" and all of A's look "returned to service" regardless of
  // operator. Namespacing the snapshot per scope (operator[+domicile]+slot)
  // makes each recipient's returned/new diff compare against its OWN history.
  const scopeKey = opts.scopeKey ? String(opts.scopeKey) : '';
  const snapKey  = scopeKey ? ('emailLastSnapshot_' + scopeKey) : 'emailLastSnapshot';

  // Load previous snapshot (saved after last successful email send)
  const prevSnap = store.load(snapKey, null);
  const prevUnits = (prevSnap && Array.isArray(prevSnap.units)) ? prevSnap.units : [];
  const prevTime  = prevSnap ? prevSnap.sentAt : null;

  // Build lookup maps
  const prevMap = {};
  prevUnits.forEach(u => { if (u.id) prevMap[u.id] = u; });
  const currMap = {};
  currentUnits.forEach(u => { if (u.id) currMap[u.id] = u; });

  // Detect changes
  const newBreakdowns = []; // units now unavail that weren't before
  const returned = [];      // units now available that were unavail before
  const stalled = [];       // units unavail 5+ days with no recent activity

  currentUnits.forEach(u => {
    const isUnavail = (u.atsState || '').toLowerCase().includes('unavail');
    const prev = prevMap[u.id];

    if (isUnavail) {
      // New breakdown?
      if (!prev || !(prev.atsState || '').toLowerCase().includes('unavail')) {
        newBreakdowns.push(u);
      }

      // Stalled? (5+ days down, no recent timeline entry)
      const days = _parseDays(u.duration);
      if (days >= STALE_DAYS_THRESHOLD) {
        const lastTimelineAge = _timelineAgeHours(u.repairTimeline || u.savedTimeline || '');
        if (lastTimelineAge === null || lastTimelineAge > STALE_NO_UPDATE_HOURS) {
          stalled.push({ ...u, daysDown: days, hoursSinceUpdate: lastTimelineAge });
        }
      }
    }
  });

  // Returned: was unavail in prev, now NOT unavail (or gone from list)
  prevUnits.forEach(pu => {
    if (!(pu.atsState || '').toLowerCase().includes('unavail')) return;
    const curr = currMap[pu.id];
    if (!curr || !(curr.atsState || '').toLowerCase().includes('unavail')) {
      returned.push(pu);
    }
  });

  // Fleet metrics
  const currUnavail = currentUnits.filter(u => (u.atsState || '').toLowerCase().includes('unavail'));
  const prevUnavail = prevUnits.filter(u => (u.atsState || '').toLowerCase().includes('unavail'));
  const currHighRisk = currentUnits.filter(u => (u.riskScore || 0) >= 70);
  const currAvgDays = currUnavail.length
    ? (currUnavail.reduce((sum, u) => sum + (_parseDays(u.duration) || 0), 0) / currUnavail.length).toFixed(1)
    : '0';

  // Save current state as snapshot for next comparison (per-scope key)
  _saveSnapshot(currentUnits, slot, snapKey);

  // If no previous snapshot, skip the summary (first email ever)
  if (!prevSnap) {
    logger.info('[email-summary] No previous snapshot — skipping change summary (first send)');
    return { html: '', meta: { newCount: 0, returnedCount: 0, stalledCount: stalled.length, unavailCount: currUnavail.length, delta: 0 } };
  }

  // Build HTML
  const sinceLabel = prevTime
    ? new Date(prevTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'last report';

  let html = '';
  html += '<div style="margin-bottom:20px;padding:16px 20px;background:#f8f9fa;border:1px solid #e1e4e8;border-radius:8px;font-family:Arial,sans-serif;">';
  html += '<div style="font-size:14px;font-weight:700;color:#1f2328;margin-bottom:12px;">\u{1F4CA} Changes Since ' + _esc(sinceLabel) + '</div>';

  // New breakdowns
  if (newBreakdowns.length) {
    html += '<div style="margin-bottom:10px;">';
    html += '<div style="font-size:11px;font-weight:700;color:#cf222e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">\u{1F534} New Breakdowns (' + newBreakdowns.length + ')</div>';
    newBreakdowns.slice(0, 8).forEach(u => {
      const issue = (u.issueSummary || u.issue || u.relayStatus || '').slice(0, 80);
      const risk = u.riskScore ? ' \u2022 Risk: ' + u.riskScore : '';
      html += '<div style="font-size:12px;color:#1f2328;margin-bottom:4px;padding-left:12px;">\u2022 <b>' + _esc(u.id) + '</b> \u2014 ' + _esc(u.vendor || 'No vendor') + '. ' + _esc(issue) + risk + '</div>';
    });
    html += '</div>';
  }

  // Returned
  if (returned.length) {
    html += '<div style="margin-bottom:10px;">';
    html += '<div style="font-size:11px;font-weight:700;color:#1a7f37;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">\u2705 Returned to Service (' + returned.length + ')</div>';
    returned.slice(0, 8).forEach(u => {
      const dur = u.duration ? ' after ' + u.duration : '';
      html += '<div style="font-size:12px;color:#1f2328;margin-bottom:4px;padding-left:12px;">\u2022 <b>' + _esc(u.id) + '</b> \u2014 Back from ' + _esc(u.vendor || 'vendor') + dur + '.</div>';
    });
    html += '</div>';
  }

  // Stalled
  if (stalled.length) {
    html += '<div style="margin-bottom:10px;">';
    html += '<div style="font-size:11px;font-weight:700;color:#bc4c00;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">\u26A0\uFE0F Stalled / No Update (' + stalled.length + ')</div>';
    stalled.slice(0, 8).forEach(u => {
      const noUpdate = u.hoursSinceUpdate !== null ? ' No update in ' + Math.round(u.hoursSinceUpdate) + 'h.' : ' No timeline entries.';
      html += '<div style="font-size:12px;color:#1f2328;margin-bottom:4px;padding-left:12px;">\u2022 <b>' + _esc(u.id) + '</b> \u2014 ' + _esc(u.vendor || '?') + ', ' + u.daysDown + ' days.' + noUpdate + '</div>';
    });
    html += '</div>';
  }

  // No changes
  if (!newBreakdowns.length && !returned.length && !stalled.length) {
    html += '<div style="font-size:12px;color:#57606a;">\u2705 No significant changes since last report. Fleet status stable.</div>';
  }

  // Metrics bar
  const unavailDelta = currUnavail.length - prevUnavail.length;
  const deltaStr = unavailDelta > 0 ? ' (+' + unavailDelta + ')' : unavailDelta < 0 ? ' (' + unavailDelta + ')' : '';
  html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #e1e4e8;font-size:11px;color:#57606a;">';
  html += '<b>Unavailable:</b> ' + currUnavail.length + deltaStr + ' &nbsp;\u2022&nbsp; ';
  html += '<b>Avg Days Down:</b> ' + currAvgDays + ' &nbsp;\u2022&nbsp; ';
  html += '<b>High Risk (70+):</b> ' + currHighRisk.length;
  html += '</div>';

  html += '</div>';

  const meta = {
    newCount: newBreakdowns.length,
    returnedCount: returned.length,
    stalledCount: stalled.length,
    unavailCount: currUnavail.length,
    delta: unavailDelta,
  };

  return { html, meta };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _parseDays(duration) {
  if (!duration) return 0;
  const s = String(duration).toLowerCase();
  let days = 0;
  const dm = s.match(/(\d+)\s*d/);
  if (dm) days += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/);
  if (hm) days += parseInt(hm[1], 10) / 24;
  if (!dm && !hm) { const n = parseFloat(s); if (n > 0) days = n; }
  return Math.round(days * 10) / 10;
}

function _timelineAgeHours(timeline) {
  if (!timeline) return null;
  // Find most recent date-prefixed entry (MM/DD format)
  const lines = timeline.split('\n').filter(Boolean);
  const now = Date.now();
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) {
      const month = parseInt(m[1], 10) - 1;
      const day   = parseInt(m[2], 10);
      const year  = new Date().getFullYear();
      const entryDate = new Date(year, month, day);
      // If entry is in the future (wrapped year), use last year
      if (entryDate > now) entryDate.setFullYear(year - 1);
      return (now - entryDate.getTime()) / (1000 * 60 * 60);
    }
  }
  return null; // no parseable date found
}

function _saveSnapshot(units, slot, snapKey) {
  const snap = {
    sentAt: new Date().toISOString(),
    slot,
    units: units.map(u => ({
      id: u.id,
      atsState: u.atsState || '',
      vendor: u.vendor || '',
      duration: u.duration || '',
      riskScore: u.riskScore || 0,
    })),
  };
  store.save(snapKey || 'emailLastSnapshot', snap);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { buildChangeSummary };


/**
 * buildSubjectSuffix(meta) — Generates the change count suffix for the email subject
 * @param {{ newCount, returnedCount, unavailCount }} meta — from buildChangeSummary().meta
 * @returns {string} e.g. " | 3 New ↓ | 2 Returned ↑" or "" if no changes
 */
function buildSubjectSuffix(meta) {
  if (!meta) return '';
  const parts = [];
  if (meta.unavailCount) parts.push(meta.unavailCount + ' Unavail');
  if (meta.newCount > 0) parts.push(meta.newCount + ' New \u2193');
  if (meta.returnedCount > 0) parts.push(meta.returnedCount + ' Returned \u2191');
  return parts.length ? ' | ' + parts.join(' | ') : '';
}

module.exports = { buildChangeSummary, buildSubjectSuffix };
