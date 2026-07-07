'use strict';
/**
 * guardian.js — Orcha Pre-Flight Guardian [V-C]
 * V-C changes vs V-B:
 *   - console.log replaced with namespaced logger
 *   - No path changes needed (guardian is stateless, no file I/O)
 *   - Identical logic to V-B
 */

const context = require('./context');
const logger  = require('../utils/logger')('guardian');

// ── SEVERITY LEVELS ───────────────────────────────────────────────────────────
const SEVERITY = {
  BLOCK: 'block',
  WARN:  'warn',
  INFO:  'info',
};

// ── GUARDIAN CLASS ────────────────────────────────────────────────────────────
class Guardian {
  constructor() {
    this._rules   = [];
    this._history = [];
    this._registerDefaultRules();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  check(action) {
    const issues = [];

    for (const rule of this._rules) {
      if (rule.appliesTo && !rule.appliesTo.includes(action.type)) continue;
      try {
        const result = rule.check(action, context);
        if (result) {
          issues.push({ severity: result.severity || SEVERITY.WARN, code: rule.code, message: result.message, suggestion: result.suggestion || null });
        }
      } catch (e) {
        issues.push({ severity: SEVERITY.INFO, code: 'RULE_ERROR', message: `Guardian rule '${rule.code}' threw: ${e.message}` });
      }
    }

    const blocked  = issues.some(i => i.severity === SEVERITY.BLOCK);
    const warnings = issues.filter(i => i.severity === SEVERITY.WARN);

    this._history.push({ ts: Date.now(), action: { type: action.type, unitId: action.unitId }, allowed: !blocked, issues: issues.length, blocked });
    if (this._history.length > 200) this._history.splice(0, this._history.length - 200);

    return { allowed: !blocked, issues, blockCount: issues.filter(i => i.severity === SEVERITY.BLOCK).length, warnCount: warnings.length };
  }

  checkUnit(unitId, actionType) {
    return this.check({ type: actionType, unitId, data: {} });
  }

  checkWRPayload(payload) {
    const issues = [];

    if (!payload.unit)  issues.push({ severity: SEVERITY.BLOCK, code: 'WR_NO_UNIT',   message: 'Work Request has no unit ID' });
    if (!payload.vendor) issues.push({ severity: SEVERITY.BLOCK, code: 'WR_NO_VENDOR', message: 'Work Request has no vendor' });
    if (!payload.issue && !payload.title) issues.push({ severity: SEVERITY.WARN, code: 'WR_NO_ISSUE', message: 'Work Request has no issue description' });

    if (payload.unit) {
      const unit = context.getUnit(payload.unit);
      if (unit) {
        if (payload.vendor && unit.vendor && unit.vendor !== '--' &&
            payload.vendor.toLowerCase() !== unit.vendor.toLowerCase()) {
          issues.push({ severity: SEVERITY.WARN, code: 'WR_VENDOR_MISMATCH',
            message: `WR vendor "${payload.vendor}" doesn't match unit's assigned vendor "${unit.vendor}"`,
            suggestion: `Use "${unit.vendor}" or reassign the unit first` });
        }
        if (unit.atsState === 'Available') {
          issues.push({ severity: SEVERITY.BLOCK, code: 'WR_UNIT_AVAILABLE',
            message: `Unit ${payload.unit} is Available — cannot create WR for available units`,
            suggestion: 'Flip unit to Unavailable first, or verify you have the correct unit' });
        }
        if (unit.workRequestId && unit.workRequestId !== '--') {
          issues.push({ severity: SEVERITY.WARN, code: 'WR_DUPLICATE',
            message: `Unit ${payload.unit} already has WR: ${unit.workRequestId}`,
            suggestion: 'Check if the existing WR should be updated instead' });
        }
        if (payload.areas && payload.areas.length > 0) {
          const issueText = (unit.issue || '').toLowerCase();
          if (issueText.includes('engine') && payload.areas[0]?.area === 'CHASSIS') {
            issues.push({ severity: SEVERITY.WARN, code: 'WR_AREA_MISMATCH', message: 'Issue mentions "engine" but area is CHASSIS — double-check classification' });
          }
        }
      } else {
        issues.push({ severity: SEVERITY.WARN, code: 'WR_UNIT_UNKNOWN',
          message: `Unit ${payload.unit} not found in context — data may be stale`,
          suggestion: 'Run a sync to refresh fleet data' });
      }
    }

    return { allowed: !issues.some(i => i.severity === SEVERITY.BLOCK), issues };
  }

  checkPlaywrightAction(action) {
    const issues = [];

    if (!action.target && !action.selector && !action.url) {
      issues.push({ severity: SEVERITY.BLOCK, code: 'PW_NO_TARGET', message: 'Playwright action has no target' });
    }

    if (action.url) {
      const allowed = ['aap-na.corp.amazon.com', 'relay.amazon.com', 'amazon.sharepoint.com', 'decisiv.net', 'outlook.office'];
      if (!allowed.some(d => action.url.includes(d))) {
        issues.push({ severity: SEVERITY.WARN, code: 'PW_UNEXPECTED_URL',
          message: `Playwright navigating to unexpected domain: ${action.url}`,
          suggestion: 'Verify this URL is intended' });
      }
    }

    if (action.type === 'fill' && action.value && action.value.length > 5000) {
      issues.push({ severity: SEVERITY.WARN, code: 'PW_LARGE_INPUT', message: `Filling very large text (${action.value.length} chars) — verify this is correct` });
    }

    return { allowed: !issues.some(i => i.severity === SEVERITY.BLOCK), issues };
  }

  getHistory(limit = 30) { return this._history.slice(-limit); }

  addRule(rule) { this._rules.push(rule); }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFAULT RULES
  // ═══════════════════════════════════════════════════════════════════════════

  _registerDefaultRules() {
    this._rules.push({
      code: 'STALE_DATA',
      appliesTo: ['create_wr', 'sp_push', 'flip_state'],
      check: (action, ctx) => {
        const lastSync = ctx.systemHealth.lastAAPSync;
        if (!lastSync) return { severity: SEVERITY.WARN, message: 'No sync has been performed — data may be outdated', suggestion: 'Run a scan first' };
        const ageMin = (Date.now() - lastSync) / 60000;
        if (ageMin > 30) return { severity: SEVERITY.WARN, message: `Data is ${Math.round(ageMin)} minutes old`, suggestion: 'Consider re-syncing before this action' };
        return null;
      },
    });

    this._rules.push({
      code: 'AVAILABLE_PROTECTION',
      appliesTo: ['create_wr', 'assign_vendor'],
      check: (action, ctx) => {
        if (!action.unitId) return null;
        const unit = ctx.getUnit(action.unitId);
        if (!unit) return null;
        if (unit.atsState === 'Available') {
          return { severity: SEVERITY.BLOCK, message: `Unit ${action.unitId} is Available — action not applicable`, suggestion: 'Verify correct unit or flip state first' };
        }
        return null;
      },
    });

    this._rules.push({
      code: 'DUPLICATE_WORKFLOW',
      appliesTo: null,
      check: (action, ctx) => {
        if (!action.unitId) return null;
        const active = ctx.getActiveWorkflows().filter(w => w.unitId === action.unitId && w.type === action.type);
        if (active.length > 0) {
          const age = Math.round((Date.now() - active[0].startedAt) / 1000);
          return { severity: SEVERITY.WARN, message: `Duplicate: ${action.type} already running for ${action.unitId} (${age}s ago)`, suggestion: 'Wait for existing workflow to complete' };
        }
        return null;
      },
    });

    this._rules.push({
      code: 'VENDOR_CONSISTENCY',
      appliesTo: ['create_wr'],
      check: (action, ctx) => {
        if (!action.unitId || !action.data?.vendor) return null;
        const unit = ctx.getUnit(action.unitId);
        if (!unit || !unit.vendor || unit.vendor === '--') return null;
        if (action.data.vendor.toLowerCase() !== unit.vendor.toLowerCase()) {
          return { severity: SEVERITY.WARN, message: `WR vendor "${action.data.vendor}" ≠ unit vendor "${unit.vendor}"` };
        }
        return null;
      },
    });

    this._rules.push({
      code: 'EMAIL_RATE_LIMIT',
      appliesTo: ['send_email'],
      check: (action, ctx) => {
        const recentEmails = ctx.recentEvents.filter(e => e.type === 'workflow_completed' && e.detail?.type === 'send_email');
        const last5min = recentEmails.filter(e => (Date.now() - e.ts) < 300000);
        if (last5min.length >= 3) {
          return { severity: SEVERITY.WARN, message: `${last5min.length} emails sent in last 5 minutes — possible rate issue` };
        }
        return null;
      },
    });

    this._rules.push({
      code: 'DANGEROUS_FLIP',
      appliesTo: ['flip_state'],
      check: (action, ctx) => {
        if (!action.unitId || !action.data?.targetState) return null;
        const unit = ctx.getUnit(action.unitId);
        if (!unit) return null;
        if (action.data.targetState === 'Available') {
          if (unit.savedRepairStatus && !unit.savedRepairStatus.toLowerCase().includes('complete')) {
            return { severity: SEVERITY.WARN, message: `Unit has repair status "${unit.savedRepairStatus}" — confirm repairs are complete before flipping to Available` };
          }
        }
        if (action.data.targetState === 'Unavailable') {
          if (!unit.issue && !unit.savedNotes) {
            return { severity: SEVERITY.WARN, message: 'Flipping to Unavailable with no documented issue — add notes first' };
          }
        }
        return null;
      },
    });
  }
}

// Singleton
const guardian = new Guardian();

module.exports = guardian;
module.exports.SEVERITY = SEVERITY;
