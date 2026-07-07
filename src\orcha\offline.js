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

function isOffline() { return _isOffline; }

function startMonitoring(onChange) {
  _onStatusChange = onChange;
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
    if (_onStatusChange) _onStatusChange('online');
  } else if (!wasOffline && !online) {
    logger.info('Gone offline — queuing mode active');
    if (_onStatusChange) _onStatusChange('offline');
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

module.exports = { isOffline, startMonitoring, stopMonitoring, queueTimelineEntry, processQueue, getQueueCount };
