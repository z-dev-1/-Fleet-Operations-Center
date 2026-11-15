'use strict';
/**
 * scrapers/aap_search_filters.js — optional server-side filters for the bulk
 * WORK-ORDER search (POST /api/v1/serviceaggregates/search).
 *
 * cleanSearchFilters(filters) returns ONLY the cleaned keys of SEARCH_FILTER_KEYS
 * that carry a value; aap_api._searchBody merges that object last over
 * DEFAULT_SEARCH_REQUEST + the caller's request. No filters (or only empty ones)
 * -> {} -> the request body is byte-identical to the unfiltered body.
 *
 * Never settable here: category (non-nullable on the server; stays UNPLANNED or
 * the caller's value), statuses, fleetIds, and every date-window key
 * (DEFERRED_DATE_FILTER_KEYS: needs live verification before it is enabled).
 *
 * Pure: no I/O besides the logger (one-time warnings, key names only).
 */

const logger = require('../utils/logger')('aap-search-filters');

const ARRAY_KEYS = Object.freeze([
  'vendors', 'assetDomicileSites', 'workOrderDelayReasons', 'escalations', 'suggestedItemsL1', 'suggestedItemsL2',
]);
const COST_START = 'totalEstimatePendingApprovalStartCost';
const COST_END = 'totalEstimatePendingApprovalEndCost';
const SEARCH_FILTER_KEYS = Object.freeze([...ARRAY_KEYS, COST_START, COST_END]);

// Every *EpochMs / *EpochMsRelative key of aap_longdwell.DEFAULT_SEARCH_REQUEST.
const DEFERRED_DATE_FILTER_KEYS = Object.freeze([
  'etcStartEpochMs', 'etcStartEpochMsRelative', 'etcEndEpochMs', 'etcEndEpochMsRelative',
  'scheduledStartEpochMs', 'scheduledStartEpochMsRelative', 'scheduledEndEpochMs', 'scheduledEndEpochMsRelative',
  'completedFromEpochMs', 'completedFromEpochMsRelative', 'completedToEpochMs', 'completedToEpochMsRelative',
  'modifiedFromEpochMs', 'modifiedFromEpochMsRelative', 'modifiedToEpochMs', 'modifiedToEpochMsRelative',
  'vendorModifiedFromEpochMs', 'vendorModifiedFromEpochMsRelative', 'vendorModifiedToEpochMs', 'vendorModifiedToEpochMsRelative',
  'rocModifiedFromEpochMs', 'rocModifiedFromEpochMsRelative', 'rocModifiedToEpochMs', 'rocModifiedToEpochMsRelative',
]);

const MAX_VALUE_CHARS = 100;
const MAX_VALUES = 200;
const CTRL_RE = /[\u0000-\u001F\u007F]/;

let _warnedDates = false;
let _warnedCost = false;

function _cleanList(v, upper) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    let s = x.trim();
    if (!s || s.length > MAX_VALUE_CHARS || CTRL_RE.test(s)) continue;
    if (upper) s = s.toUpperCase();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_VALUES) break;
  }
  return out;
}

function _cost(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }

function cleanSearchFilters(filters) {
  const out = {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return out;
  if (!_warnedDates && DEFERRED_DATE_FILTER_KEYS.some((k) => Object.prototype.hasOwnProperty.call(filters, k))) {
    _warnedDates = true;
    logger.warn('date-window filters not enabled (needs live verification)');
  }
  for (const k of ARRAY_KEYS) {
    const list = _cleanList(filters[k], k === 'assetDomicileSites');
    if (list.length) out[k] = list;
  }
  const start = _cost(filters[COST_START]);
  const end = _cost(filters[COST_END]);
  if (start !== null && end !== null && start > end) {
    if (!_warnedCost) { _warnedCost = true; logger.warn('estimate cost filter dropped: start > end'); }
    return out;
  }
  if (start !== null) out[COST_START] = start;
  if (end !== null) out[COST_END] = end;
  return out;
}

function _resetWarningsForTest() { _warnedDates = false; _warnedCost = false; }

module.exports = { SEARCH_FILTER_KEYS, DEFERRED_DATE_FILTER_KEYS, cleanSearchFilters, _resetWarningsForTest };
