'use strict';
/**
 * retention.js — 30-Day Data Retention Engine [V-C]
 * V-C changes vs V-B:
 *   - HISTORY_FILE: was require('electron').app.getPath('userData') inline call
 *     → now P.fleetHistory (safe lazy resolution, works before app ready)
 *   - console.log replaced with namespaced logger
 *   - saveHistory uses atomic tmp->rename write
 */

const fs     = require('fs');
const path   = require('path');
const { P }  = require('../config/paths');
const logger = require('../utils/logger')('retention');

const RETENTION_DAYS = 30;

function loadHistory() {
  try {
    if (fs.existsSync(P.fleetHistory)) return JSON.parse(fs.readFileSync(P.fleetHistory, 'utf8'));
  } catch (e) { logger.warn('Load error: ' + e.message); }
  return { units: {}, events: [] };
}

function saveHistory(data) {
  try {
    fs.mkdirSync(path.dirname(P.fleetHistory), { recursive: true });
    const tmp = P.fleetHistory + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, P.fleetHistory);
  } catch (e) { logger.warn('Save error: ' + e.message); }
}

function trackChanges(newRows) {
  if (!Array.isArray(newRows) || newRows.length === 0) return;
  const history = loadHistory();
  const now = new Date().toISOString();
  let changesLogged = 0;

  for (const unit of newRows) {
    const id = unit.equipmentId;
    if (!id) continue;
    const prev = history.units[id];

    if (!prev) {
      history.units[id] = {
        equipmentId: id, firstSeen: now, lastSeen: now,
        currentState:  unit.lifecycleState || 'Unknown',
        currentReason: unit.lifecycleReason || '',
        operator:      unit.operator     || '',
        domicileSite:  unit.domicileSite || '',
        vendor:        unit.vendor       || '',
        stateHistory: [{ state: unit.lifecycleState || 'Unknown', reason: unit.lifecycleReason || '', at: now }],
      };
      continue;
    }

    prev.lastSeen    = now;
    prev.operator    = unit.operator    || prev.operator;
    prev.domicileSite = unit.domicileSite || prev.domicileSite;
    if (unit.vendor && unit.vendor !== '--') prev.vendor = unit.vendor;

    const newState  = unit.lifecycleState  || 'Unknown';
    const newReason = unit.lifecycleReason || '';

    if (prev.currentState !== newState || prev.currentReason !== newReason) {
      const event = {
        equipmentId: id,
        from: prev.currentState + (prev.currentReason ? ' / ' + prev.currentReason : ''),
        to:   newState           + (newReason          ? ' / ' + newReason          : ''),
        at:   now,
        operator:    unit.operator    || '',
        domicileSite: unit.domicileSite || '',
      };
      history.events.push(event);
      changesLogged++;
      prev.currentState  = newState;
      prev.currentReason = newReason;
      prev.stateHistory.push({ state: newState, reason: newReason, at: now });
      logger.info(`${id}: ${event.from} -> ${event.to}`);
    }
  }

  // Prune events older than RETENTION_DAYS
  const cutoff = Date.now() - (RETENTION_DAYS * 86400000);
  history.events = history.events.filter(e => new Date(e.at).getTime() > cutoff);
  for (const id in history.units) {
    const u = history.units[id];
    u.stateHistory = u.stateHistory.filter(s => new Date(s.at).getTime() > cutoff);
    if (new Date(u.lastSeen).getTime() < cutoff) delete history.units[id];
  }

  saveHistory(history);
  if (changesLogged > 0) {
    logger.info(`${changesLogged} state change(s) logged. Total: ${history.events.length} events, ${Object.keys(history.units).length} units tracked`);
  }
}

function getEvents(days) {
  const history = loadHistory();
  if (!days) return history.events;
  const cutoff = Date.now() - (days * 86400000);
  return history.events.filter(e => new Date(e.at).getTime() > cutoff);
}

function getUnitHistory(equipmentId) {
  const history = loadHistory();
  return history.units[equipmentId] || null;
}

function getStats() {
  const history  = loadHistory();
  const events   = history.events;
  const now      = Date.now();
  const day      = 86400000;
  return {
    totalTrackedUnits:       Object.keys(history.units).length,
    totalEvents:             events.length,
    last24h:                 events.filter(e => now - new Date(e.at).getTime() < day).length,
    last7d:                  events.filter(e => now - new Date(e.at).getTime() < 7 * day).length,
    last30d:                 events.length,
    unavailableToAvailable:  events.filter(e => /Active|Available/i.test(e.to)   && /Unavailable/i.test(e.from)).length,
    availableToUnavailable:  events.filter(e => /Unavailable/i.test(e.to)        && /Active|Available/i.test(e.from)).length,
  };
}

module.exports = { trackChanges, getEvents, getUnitHistory, getStats };
