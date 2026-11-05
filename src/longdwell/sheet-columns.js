'use strict';
/**
 * longdwell/sheet-columns.js - single source of the weekly Long Dwell sheet
 * columns used by the "Preview, then write" SharePoint feature.
 *
 * Everything here is derived from the existing tracker definitions
 * (TRACKER_COLUMNS / MANUAL_COLUMNS in src/ipc/long-dwell-csv.js and the enums
 * in src/ipc/long-dwell.js). String literals exist only for the non-canonical
 * tier-2 header aliases and the optional work-order column aliases.
 *
 * Pure module: no Electron, no store, no logging. Keep this file printable
 * ASCII (a test enforces it).
 */
const { TRACKER_COLUMNS, MANUAL_COLUMNS } = require('../ipc/long-dwell-csv');
const { DELAY_REASONS, ESCALATION_LEVELS } = require('../ipc/long-dwell');

// A..R in sheet order (13 tracker + 5 manual headers).
const EXPECTED_HEADERS = TRACKER_COLUMNS.concat(MANUAL_COLUMNS.map((c) => c.label));

// Zero-based index into TRACKER_COLUMNS of the tracker columns the feature reads.
const TRACKER_INDEX = { assetId: 2, site: 4, vendor: 8, level1: 11, level2: 12 };

// Internal keys for all 13 tracker columns (used for header scoring only).
const TRACKER_KEYS = [
  'fas', 'um', 'assetId', 'assetType', 'site', 'scac',
  'lifecycleReason', 'daysDown', 'vendor',
  'vendorDelayReason', 'expectedEtc', 'level1', 'level2',
];

const MANUAL_KEYS = MANUAL_COLUMNS.map((c) => c.key);
const TARGET_KEYS = ['delayReason', 'escalationAction', 'notes'];
const MAX_CELL_CHARS = 4000;

// Canonical header label for a manual or tracker key (never retyped).
function labelOf(key) {
  const m = MANUAL_COLUMNS.find((c) => c.key === key);
  if (m) return m.label;
  const i = TRACKER_KEYS.indexOf(key);
  return i >= 0 ? TRACKER_COLUMNS[i] : null;
}

const META = {
  delayReason:      { multiline: false, enum: DELAY_REASONS },
  escalationAction: { multiline: false, enum: ESCALATION_LEVELS },
  notes:            { multiline: true, max: MAX_CELL_CHARS },
};

// Computed value (from) -> sheet column (key). Only N, O and R are ever mapped;
// Support Team POC (P) and Asana Link (Q) are never written.
const FIELD_MAP = [
  { from: 'delayReason',     key: 'delayReason' },
  { from: 'escalationLevel', key: 'escalationAction' },
  { from: 'summary',         key: 'notes' },
].map((f) => Object.freeze({ ...f, header: labelOf(f.key), ...META[f.key] }));

// NFKC, lower-case, trim, whitespace collapsed, trailing ':' and '*' removed.
function normHeader(s) {
  let t = String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  t = t.replace(/[:*\s]+$/, '').trim();
  return t;
}

// Tier-2 aliases: consulted only when the canonical (tier-1) label finds no column.
const EXTRA_ALIASES = {
  escalationAction: ['escalation level / action', 'escalation action'],
  notes:            ['required notes', 'notes'],
  asanaLink:        ['asana link'],
  assetId:          ['assetid'],
};

// Optional work-order column (absent from the AAP CSV, may exist on the sheet).
const WO_HEADER_ALIASES = [
  'work order', 'wo', 'wo #', 'wo number', 'vendor work order',
  'work order id', 'lt id', 'amz wo',
];

const ALL_KEYS = TRACKER_KEYS.concat(MANUAL_KEYS);

function _buildTiers() {
  const tier1 = {};
  TRACKER_KEYS.forEach((k, i) => { tier1[k] = [normHeader(TRACKER_COLUMNS[i])]; });
  MANUAL_COLUMNS.forEach((c) => { tier1[c.key] = [normHeader(c.label)]; });
  const tier2 = {};
  for (const k of ALL_KEYS) tier2[k] = (EXTRA_ALIASES[k] || []).map(normHeader);
  return { tier1, tier2 };
}
const HEADER_TIERS = _buildTiers();

// Unit key: NBSP/whitespace removed, leading aaid_ stripped, upper-cased.
// Leading zeros are kept ('0123' !== '123'). A numeric '520024.0' becomes '520024'.
function normUnitId(s) {
  let t = String(s == null ? '' : s).replace(/[\s\u00a0\u2007\u202f]+/g, '');
  t = t.replace(/^aaid_/i, '').toUpperCase();
  if (/^\d+\.0+$/.test(t)) t = t.replace(/\.0+$/, '');
  return t;
}

// Cell text: CRLF/CR -> LF, tab -> space, XML-invalid control characters
// stripped, ends trimmed, inner newlines kept. Not clipped.
function sanitizeForCell(v) {
  if (v === undefined || v === null) return '';
  let s = String(v).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '');
  s = s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
  return s.trim();
}

// Exact comparison form (case-sensitive) used for emptiness/equality checks.
const normText = (s) => sanitizeForCell(s);

// Loose name key: NFKC, upper-case, non-alphanumerics to one space, trimmed.
// Used for WO and vendor comparison. Equality only, never substring.
function normName(s) {
  return String(s == null ? '' : s).normalize('NFKC').toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const normKey = (s) => normName(s);

function fieldByKey(key) { return FIELD_MAP.find((f) => f.key === key) || null; }

// Server-side check for text the user approved. Returns {ok:true, text} with the
// sanitized text, or {ok:false, code:'invalid-text'}.
function validateCellText(columnKey, text) {
  const f = fieldByKey(columnKey);
  if (!f || typeof text !== 'string') return { ok: false, code: 'invalid-text' };
  const t = sanitizeForCell(text);
  if (t === '' || t.length > MAX_CELL_CHARS) return { ok: false, code: 'invalid-text' };
  if (f.enum && !f.enum.includes(t)) return { ok: false, code: 'invalid-text' };
  if (!f.multiline && t.indexOf('\n') !== -1) return { ok: false, code: 'invalid-text' };
  return { ok: true, text: t };
}

module.exports = {
  TRACKER_COLUMNS, MANUAL_COLUMNS, EXPECTED_HEADERS, TRACKER_INDEX, TRACKER_KEYS,
  MANUAL_KEYS, TARGET_KEYS, ALL_KEYS, MAX_CELL_CHARS,
  labelOf, FIELD_MAP, fieldByKey, HEADER_TIERS, EXTRA_ALIASES, WO_HEADER_ALIASES,
  normHeader, normUnitId, normText, normName, normKey, sanitizeForCell, validateCellText,
};
