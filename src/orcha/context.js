'use strict';
/**
 * context.js — Orcha Context Engine [V-C]
 * V-C changes vs V-B:
 *   - CONFIG_DIR + hardcoded CONTEXT_FILE replaced with P.orchaContext
 *   - console.log replaced with namespaced logger
 *   - _saveState uses atomic tmp->rename write
 *   - No bare require('fs'/'path'/'os') for path building — all via P.*
 */

const fs   = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { P }  = require('../config/paths');
const logger = require('../utils/logger')('context');

class OrchaContext extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    // ── CORE STATE ──────────────────────────────────────────────────────────
    this.units     = new Map();   // equipmentId → full unit object
    this.vendors   = new Map();   // vendorName  → { units, avgDays, slaBreaches, ... }
    this.workflows = new Map();   // workflowId  → { type, status, unitId, startedAt, ... }
    this.corrections = [];

    this.systemHealth = {
      lastAAPSync:   null,
      lastRelaySync: null,
      lastUptakeSync: null,
      lastSPPush:    null,
      aiStatus:      'unknown',
      aiLastOK:      null,
      aiErrors:      0,
      aiRequests:    0,
      appStartedAt:  Date.now(),
    };

    // ── DERIVED STATE ───────────────────────────────────────────────────────
    this.stats = {
      totalUnits: 0, unavailable: 0, available: 0, offsite: 0,
      highRisk: 0, slaBreaches: 0, pendingWRs: 0, activeWorkflows: 0,
    };

    // ── HISTORY ─────────────────────────────────────────────────────────────
    this.recentEvents = [];         // last 100 events
    this.unitHistory  = new Map();  // equipmentId → [{ ts, field, oldVal, newVal }]

    this._loadState();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  updateUnits(units) {
    if (!Array.isArray(units)) return;
    const changes = [];
    const now = Date.now();

    for (const u of units) {
      const id = u.id || u.equipmentId;
      if (!id) continue;
      const prev = this.units.get(id);

      if (prev) {
        if (prev.atsState !== u.atsState) {
          changes.push({ type: 'state_change', unitId: id, field: 'atsState', from: prev.atsState, to: u.atsState });
          this._recordUnitHistory(id, 'atsState', prev.atsState, u.atsState);
        }
        if (prev.vendor !== u.vendor && u.vendor && u.vendor !== '--') {
          changes.push({ type: 'vendor_change', unitId: id, field: 'vendor', from: prev.vendor, to: u.vendor });
          this._recordUnitHistory(id, 'vendor', prev.vendor, u.vendor);
        }
        if (prev.relayStatus !== u.relayStatus) {
          changes.push({ type: 'status_change', unitId: id, field: 'relayStatus', from: prev.relayStatus, to: u.relayStatus });
        }
        if ((prev.riskScore || 0) < 75 && (u.riskScore || 0) >= 75) {
          changes.push({ type: 'risk_escalation', unitId: id, score: u.riskScore });
        }
      } else {
        changes.push({ type: 'unit_new', unitId: id });
      }
      this.units.set(id, { ...u, _lastUpdated: now });
    }

    // Remove units no longer in payload
    const incomingIds = new Set(units.map(u => u.id || u.equipmentId).filter(Boolean));
    for (const [id] of this.units) {
      if (!incomingIds.has(id)) { changes.push({ type: 'unit_removed', unitId: id }); this.units.delete(id); }
    }

    this._recomputeStats();
    this._recomputeVendors();

    for (const change of changes) { this._addEvent(change); this.emit('change', change); }
    if (changes.length > 0) this.emit('units_updated', { count: units.length, changes: changes.length });

    this.systemHealth.lastAAPSync = now;
    this._saveState();
  }

  getUnit(id)              { return this.units.get(id) || null; }
  findUnits(filterFn)      { const r = []; for (const [, u] of this.units) if (filterFn(u)) r.push(u); return r; }
  getUnavailable()         { return this.findUnits(u => u.atsState === 'Unavailable'); }
  getUnitsByVendor(vendor) { const v = (vendor || '').toLowerCase(); return this.findUnits(u => (u.vendor || '').toLowerCase().includes(v)); }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKFLOW TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  startWorkflow(workflow) {
    const id = workflow.id || ('wf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const wf = { ...workflow, id, status: 'active', startedAt: Date.now(), steps: [], errors: [] };
    this.workflows.set(id, wf);
    this._addEvent({ type: 'workflow_started', workflowId: id, workflowType: wf.type, unitId: wf.unitId });
    this.emit('workflow_started', wf);
    this._recomputeStats();
    return id;
  }

  updateWorkflow(id, update) {
    const wf = this.workflows.get(id);
    if (!wf) return;
    if (update.step)   wf.steps.push({ ts: Date.now(), ...update.step });
    if (update.status) wf.status = update.status;
    if (update.error)  wf.errors.push({ ts: Date.now(), error: update.error });
    if (update.data)   Object.assign(wf, update.data);
    this.emit('workflow_updated', wf);
  }

  completeWorkflow(id, result = {}) {
    const wf = this.workflows.get(id);
    if (!wf) return;
    wf.status      = result.success === false ? 'failed' : 'completed';
    wf.completedAt = Date.now();
    wf.result      = result;
    this._addEvent({ type: 'workflow_completed', workflowId: id, status: wf.status, duration: wf.completedAt - wf.startedAt });
    this.emit('workflow_completed', wf);
    this._recomputeStats();
    // Keep last 50 completed
    const completed = [...this.workflows.values()].filter(w => w.status !== 'active');
    if (completed.length > 50) {
      completed.sort((a, b) => a.completedAt - b.completedAt);
      for (let i = 0; i < completed.length - 50; i++) this.workflows.delete(completed[i].id);
    }
  }

  getActiveWorkflows()          { return [...this.workflows.values()].filter(w => w.status === 'active'); }
  getWorkflowsForUnit(unitId)   { return [...this.workflows.values()].filter(w => w.unitId === unitId); }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM HEALTH
  // ═══════════════════════════════════════════════════════════════════════════

  updateSystemHealth(updates) { Object.assign(this.systemHealth, updates); this.emit('health_updated', this.systemHealth); }
  getSystemHealth()           { return { ...this.systemHealth }; }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI CONTEXT BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  buildPromptContext(scope = 'summary') {
    const lines = [];

    if (scope === 'summary' || scope === 'full') {
      lines.push(`=== FLEET STATE (${new Date().toLocaleString()}) ===`);
      lines.push(`Total units: ${this.stats.totalUnits} | Unavailable: ${this.stats.unavailable} | Available: ${this.stats.available}`);
      lines.push(`Offsite: ${this.stats.offsite} | High Risk: ${this.stats.highRisk} | SLA Breaches: ${this.stats.slaBreaches}`);
      lines.push(`Active workflows: ${this.stats.activeWorkflows} | Pending WRs: ${this.stats.pendingWRs}`);
      lines.push('');
    }

    if (scope === 'full') {
      lines.push('=== UNAVAILABLE UNITS ===');
      for (const u of this.getUnavailable()) {
        lines.push(`${u.id} | ${u.vendor || '--'} | ${u.relayStatus || '--'} | ${u.duration || '--'} | ${(u.issue || '').slice(0, 60)} | risk:${u.riskScore || 0}`);
      }
      lines.push('');
    }

    if (scope.startsWith('unit:')) {
      const unitId = scope.replace('unit:', '');
      const u = this.getUnit(unitId);
      if (u) {
        lines.push(`=== UNIT: ${u.id} ===`);
        lines.push(`Model: ${u.model || '--'} | VIN: ${u.vin || '--'} | Operator: ${u.op || '--'}`);
        lines.push(`State: ${u.atsState} | Relay: ${u.relayStatus} | Vendor: ${u.vendor || '--'}`);
        lines.push(`Issue: ${u.issue || '--'}`);
        lines.push(`Duration: ${u.duration || '--'} | Risk: ${u.riskScore || 0} (${u.riskTier || '--'})`);
        lines.push(`Notes: ${u.savedNotes || '(none)'}`);
        lines.push(`PC: ${u.savedPrimaryComponent || '--'} | RS: ${u.savedRepairStatus || '--'}`);
        const history = this.unitHistory.get(unitId);
        if (history && history.length > 0) {
          lines.push(`History: ${history.slice(-5).map(h => `${h.field}: ${h.oldVal}→${h.newVal}`).join('; ')}`);
        }
      }
    }

    if (scope.startsWith('vendor:')) {
      const vendorName = scope.replace('vendor:', '').toLowerCase();
      const vendor = this.vendors.get(vendorName);
      if (vendor) {
        lines.push(`=== VENDOR: ${vendor.name} ===`);
        lines.push(`Units: ${vendor.unitCount} | Avg days: ${vendor.avgDays} | SLA breaches: ${vendor.slaBreaches}`);
        lines.push(`Units: ${vendor.unitIds.join(', ')}`);
      }
    }

    if (scope === 'full' || scope === 'summary') {
      const recent = this.recentEvents.slice(-10);
      if (recent.length > 0) {
        lines.push('');
        lines.push('=== RECENT EVENTS ===');
        for (const ev of recent) {
          lines.push(`[${new Date(ev.ts).toLocaleTimeString()}] ${ev.type}: ${JSON.stringify(ev.detail || ev).slice(0, 80)}`);
        }
      }
    }

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL
  // ═══════════════════════════════════════════════════════════════════════════

  _recomputeStats() {
    const units = [...this.units.values()];
    this.stats.totalUnits  = units.length;
    this.stats.unavailable = units.filter(u => u.atsState === 'Unavailable').length;
    this.stats.available   = units.filter(u => u.atsState === 'Available').length;
    this.stats.offsite     = units.filter(u => (u.relayStatus || '').includes('Offsite')).length;
    this.stats.highRisk    = units.filter(u => (u.riskScore || 0) >= 75).length;
    this.stats.slaBreaches = units.filter(u => {
      if (u.atsState !== 'Unavailable') return false;
      return (parseInt(u.duration) || 0) >= (u.slaTarget || 5);
    }).length;
    this.stats.pendingWRs       = [...this.workflows.values()].filter(w => w.type === 'create_wr' && w.status === 'active').length;
    this.stats.activeWorkflows  = [...this.workflows.values()].filter(w => w.status === 'active').length;
  }

  _recomputeVendors() {
    this.vendors.clear();
    for (const [, u] of this.units) {
      if (!u.vendor || u.vendor === '--' || u.atsState !== 'Unavailable') continue;
      const key = u.vendor.toLowerCase();
      if (!this.vendors.has(key)) this.vendors.set(key, { name: u.vendor, unitCount: 0, unitIds: [], totalDays: 0, slaBreaches: 0, avgDays: 0 });
      const v = this.vendors.get(key);
      v.unitCount++; v.unitIds.push(u.id);
      const days = parseInt(u.duration) || 0;
      v.totalDays += days;
      if (days >= (u.slaTarget || 5)) v.slaBreaches++;
      v.avgDays = Math.round(v.totalDays / v.unitCount);
    }
  }

  _recordUnitHistory(unitId, field, oldVal, newVal) {
    if (!this.unitHistory.has(unitId)) this.unitHistory.set(unitId, []);
    const history = this.unitHistory.get(unitId);
    history.push({ ts: Date.now(), field, oldVal, newVal });
    if (history.length > 20) history.splice(0, history.length - 20);
  }

  _addEvent(event) {
    this.recentEvents.push({ ts: Date.now(), ...event });
    if (this.recentEvents.length > 100) this.recentEvents.splice(0, this.recentEvents.length - 100);
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(P.orchaContext), { recursive: true });
      const tmp = P.orchaContext + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        systemHealth: this.systemHealth, stats: this.stats,
        recentEvents: this.recentEvents.slice(-50), savedAt: Date.now(),
      }, null, 2));
      fs.renameSync(tmp, P.orchaContext);
    } catch (e) { logger.warn('_saveState failed: ' + e.message); }
  }

  _loadState() {
    try {
      if (fs.existsSync(P.orchaContext)) {
        const data = JSON.parse(fs.readFileSync(P.orchaContext, 'utf8'));
        if (data.systemHealth) Object.assign(this.systemHealth, data.systemHealth);
        if (data.recentEvents) this.recentEvents = data.recentEvents;
      }
    } catch (_) {}
  }
}

// Singleton — shared across the entire app
const context = new OrchaContext();

module.exports = context;
