'use strict';
/**
 * src/orcha/offline.js — Offline mode detection + queue
 * 
 * Auto-detects when offline (no network).
 * Queues timeline entries as raw text.
 * When back online, sends them to AI for professional rewrite.
 */

const { net } = require('electron');
const store = require('../store');
const logger = require('../utils/logger')('offline');

let _isOffline = false;
let _checkInterval = null;
let _onStatusChange = null;
// Additional transition subscribers (besides the single startMonitoring
// callback). Each is called with 'online' | 'offline'. Used by the Midway auth
// layer so it can pause re-auth while offline and re-probe on reconnect without
// clobbering the existing queue-processing callback.
const _subscribers = [];

function isOffline() { return _isOffline; }
function isOnline() { return !_isOffline; }

// Subscribe to online/offline transitions. Returns an unsubscribe fn. Safe to
// call before startMonitoring; the subscriber simply fires on the next change.
function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _subscribers.push(fn);
  return () => { const i = _subscribers.indexOf(fn); if (i !== -1) _subscribers.splice(i, 1); };
}

function _emit(status) {
  if (_onStatusChange) { try { _onStatusChange(status); } catch (_) {} }
  for (const fn of _subscribers.slice()) { try { fn(status); } catch (_) {} }
}

function startMonitoring(onStatusChange) {
  _onStatusChange = onStatusChange;
  _checkInterval = setInterval(_check, 10000); // Check every 10s
  _check();
}

function stopMonitoring() {
  if (_checkInterval) clearInterval(_checkInterval);
}

function _check() {
  const online = net.isOnline();
  const wasOffline = _isOffline;
  _isOffline = !online;

  if (wasOffline && online) {
    logger.info('Back online — processing offline queue');
    _emit('online');
  } else if (!wasOffline && !online) {
    logger.info('Gone offline — queuing mode active');
    _emit('offline');
  }
}

// Queue raw timeline entries while offline
function queueTimelineEntry(equipmentId, rawText) {
  const queue = store.load('offlineQueue', []);
  const today = new Date();
  const dateStr = String(today.getMonth()+1).padStart(2,'0') + '/' + String(today.getDate()).padStart(2,'0');
  
  queue.push({
    equipmentId,
    rawText,
    date: dateStr,
    ts: Date.now()
  });
  store.save('offlineQueue', queue);
  logger.info('Queued offline entry for ' + equipmentId + ': ' + rawText.substring(0, 40));
}

// Process queue when back online (AI rewrites)
async function processQueue(aiRewrite) {
  const queue = store.load('offlineQueue', []);
  if (!queue.length) return [];
  
  const results = [];
  for (const entry of queue) {
    try {
      const professional = await aiRewrite(entry.equipmentId, entry.date + ' - ' + entry.rawText);
      results.push({ equipmentId: entry.equipmentId, original: entry.rawText, rewritten: professional });
    } catch (e) {
      // If AI fails, just use the raw text with date prefix
      results.push({ equipmentId: entry.equipmentId, original: entry.rawText, rewritten: entry.date + ' - ' + entry.rawText });
    }
  }
  
  // Clear queue
  store.save('offlineQueue', []);
  logger.info('Processed ' + results.length + ' offline entries');
  return results;
}

function getQueueCount() {
  return store.load('offlineQueue', []).length;
}

module.exports = { isOffline, isOnline, onChange, startMonitoring, stopMonitoring, queueTimelineEntry, processQueue, getQueueCount };
