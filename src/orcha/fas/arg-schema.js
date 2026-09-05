'use strict';
/**
 * orcha/fas/arg-schema.js — Central argument validation for every FAS research
 * tool and action (Part 15).
 *
 * The AI cannot be trusted to always produce well-formed JSON. Before any tool
 * runs or any action executes, its arguments are validated here against a
 * declared schema: known tool name, required fields present, correct types,
 * max lengths, allowed enum values, unit/date/URL/channel formats, and
 * result-size limits. Unknown fields are dropped. Invalid args are rejected
 * with a clear reason so the caller can record a failure rather than acting on
 * garbage.
 */

const MAX_STR = 4000;         // generic string ceiling
const MAX_QUESTION = 2000;
const MAX_KEYWORDS = 200;
const MAX_ENTRY = 2000;

// ── Field validators ─────────────────────────────────────────────────────────
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;      // equipment id shape (1-32 chars)
const OP_DOM_RE = /^[A-Za-z0-9]{2,12}$/;                    // operator/domicile code
const SLACK_CH_RE = /^[A-Za-z0-9._-]{1,64}$/;               // channel id / name token
const AAP_URL_RE = /^https:\/\/aap-na\.corp\.amazon\.com\//i;

function _str(v, max) {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, error: 'must be a string' };
  const s = v.trim();
  if (s.length > (max || MAX_STR)) return { ok: false, error: 'too long (max ' + (max || MAX_STR) + ')' };
  return { ok: true, value: s };
}
function _unit(v, required) {
  if (v == null || v === '') return required ? { ok: false, error: 'unit required' } : { ok: true, value: undefined };
  const s = String(v).trim();
  if (!UNIT_RE.test(s)) return { ok: false, error: 'invalid unit format: ' + s.slice(0, 40) };
  return { ok: true, value: s };
}
function _code(v) {
  if (v == null || v === '') return { ok: true, value: undefined };
  const s = String(v).trim().toUpperCase();
  if (!OP_DOM_RE.test(s)) return { ok: false, error: 'invalid operator/domicile code: ' + s.slice(0, 20) };
  return { ok: true, value: s };
}
function _date(v) {
  if (v == null || v === '') return { ok: true, value: undefined };
  const ms = Date.parse(v);
  if (isNaN(ms)) return { ok: false, error: 'invalid date: ' + String(v).slice(0, 40) };
  const y = new Date(ms).getFullYear();
  if (y < 2020 || y > new Date().getFullYear() + 3) return { ok: false, error: 'date out of range' };
  return { ok: true, value: new Date(ms).toISOString() };
}
function _ms(v) {
  if (v == null) return { ok: true, value: undefined };
  const n = Number(v);
  if (!isFinite(n) || n < 0) return { ok: false, error: 'invalid epoch ms' };
  return { ok: true, value: n };
}
function _channel(v) {
  if (v == null || v === '') return { ok: true, value: undefined };
  const s = String(v).trim();
  if (!SLACK_CH_RE.test(s)) return { ok: false, error: 'invalid channel id/name' };
  return { ok: true, value: s };
}
function _aapUrl(v) {
  if (v == null || v === '') return { ok: true, value: undefined };
  const s = String(v).trim();
  if (!AAP_URL_RE.test(s)) return { ok: false, error: 'assetUrl must be an aap-na.corp.amazon.com URL' };
  if (s.length > 1024) return { ok: false, error: 'assetUrl too long' };
  return { ok: true, value: s };
}
function _enum(v, allowed, required) {
  if (v == null || v === '') return required ? { ok: false, error: 'required' } : { ok: true, value: undefined };
  const s = String(v).trim();
  if (!allowed.includes(s)) return { ok: false, error: 'must be one of ' + allowed.join(', ') };
  return { ok: true, value: s };
}
function _obj(v) {
  if (v == null) return { ok: true, value: undefined };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'must be an object' };
  return { ok: true, value: v };
}

// Schema shape: { field: { validator, required?, args? } }
// Only listed fields are kept (unknown fields dropped).
const F = {
  unit: (req) => ({ v: (x) => _unit(x, req), req }),
  unitReq: { v: (x) => _unit(x, true), req: true },
  operator: { v: _code },
  domicile: { v: _code },
  vendor: { v: (x) => _str(x, 120) },
  keywords: { v: (x) => _str(x, MAX_KEYWORDS) },
  sender: { v: (x) => _str(x, 120) },
  channel: { v: _channel },
  fromMs: { v: _ms },
  toMs: { v: _ms },
  question: { v: (x) => _str(x, MAX_QUESTION) },
  entry: { v: (x) => _str(x, MAX_ENTRY) },
  note: { v: (x) => _str(x, MAX_ENTRY) },
  when: { v: _date },
  dueAt: { v: _date },
  summary: { v: (x) => _str(x, MAX_ENTRY) },
  promise: { v: (x) => _str(x, MAX_ENTRY) },
  state: { v: (x) => _str(x, 40) },
  reason: { v: (x) => _str(x, 300) },
  assetUrl: { v: _aapUrl },
  message: { v: (x) => _str(x, 4000) },
  channelId: { v: _channel },
  threadTs: { v: (x) => _str(x, 40) },
  payload: { v: _obj },
  slackId: { v: (x) => _str(x, 64) },
};

// Per-name schemas. READ tools + actions. A tool/name not listed here is
// allowed but only shallow-validated (strings capped) — we never reject an
// otherwise-known registered tool solely for lacking a schema entry.
const SCHEMAS = {
  // READ tools (unit-targeted)
  GET_UNIT: { unit: F.unitReq },
  GET_REPAIR_TIMELINE: { unit: F.unitReq },
  GET_OPEN_WORK_ORDERS: { unit: F.unitReq },
  GET_PM_STATUS: { unit: F.unitReq },
  GET_UPTAKE_INSIGHTS: { unit: F.unitReq },
  GET_RELAY_GARAGE_UNIT: { unit: F.unitReq },
  GET_RELAY_WORK_ORDERS: { unit: F.unitReq },
  GET_RELAY_WORK_ORDER_DETAILS: { unit: F.unitReq },
  GET_RELAY_REPAIR_TIMELINE: { unit: F.unitReq },
  GET_OFFSITE_EVENT: { unit: F.unitReq },
  GET_OFFSITE_EVENT_TIMELINE: { unit: F.unitReq },
  GET_SITE_SUMMARY: { domicile: F.domicile },
  GET_OPERATOR_SUMMARY: { operator: F.operator },
  GET_VENDOR_CONTACT: { vendor: F.vendor },
  GET_SENDER_PROFILE: { slackId: F.slackId },
  GET_COVERAGE: {},
  GET_COMPLIANCE_REQUIREMENT: {
    topic: { v: (x) => _str(x, 60) },
    condition: { v: (x) => _str(x, 300) },
    observation: { v: (x) => _str(x, 300) },
    query: { v: (x) => _str(x, 300) },
    keywords: { v: (x) => _str(x, MAX_KEYWORDS) },
    equipment: { v: (x) => _enum(x, ['box-truck', 'day-cab', 'sleeper-cab', 'all', ''], false) },
    unitEvidence: { v: _obj },
  },
  ASK_INTERNAL: { question: { v: (x) => _str(x, MAX_QUESTION), req: true } },
  SEARCH_SLACK: { unit: F.unit(false), vendor: F.vendor, operator: F.operator, domicile: F.domicile,
    keywords: F.keywords, sender: F.sender, channel: F.channel, fromMs: F.fromMs, toMs: F.toMs },
  // Actions
  ADD_TIMELINE: { unit: F.unitReq, entry: { v: (x) => _str(x, MAX_ENTRY), req: true } },
  CREATE_REMINDER: { unit: F.unit(false), note: { v: (x) => _str(x, MAX_ENTRY), req: true }, when: F.when },
  CREATE_FOLLOWUP_CASE: { unit: F.unit(false), summary: F.summary, promise: F.promise, dueAt: F.dueAt },
  MOVE_UNIT: { unit: F.unitReq, state: { v: (x) => _str(x, 40), req: true }, reason: F.reason, assetUrl: F.assetUrl },
  SUBMIT_WORK_REQUEST: { unit: F.unitReq, payload: F.payload },
  SEND_SLACK_MESSAGE: { channelId: { v: _channel, req: true }, message: { v: (x) => _str(x, 4000), req: true }, threadTs: F.threadTs },
};

/**
 * validateArgs(name, args) -> { ok, cleaned?, error? }
 * Rejects unknown-field-only? No — unknown fields are DROPPED (not fatal), but
 * missing required fields, wrong types, bad formats, and over-length values ARE
 * rejected. `slackId` is always passed through (runner adds it for context).
 */
function validateArgs(name, args) {
  args = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const schema = SCHEMAS[name];
  if (!schema) {
    // Unknown/registered-but-unschemad: shallow cap strings, keep object.
    const cleaned = {};
    for (const k of Object.keys(args)) {
      const val = args[k];
      if (typeof val === 'string') { if (val.length > MAX_STR) return { ok: false, error: k + ' too long' }; cleaned[k] = val; }
      else cleaned[k] = val;
    }
    return { ok: true, cleaned };
  }
  const cleaned = {};
  for (const field of Object.keys(schema)) {
    const spec = schema[field];
    const res = spec.v(args[field]);
    if (!res.ok) return { ok: false, error: field + ': ' + res.error };
    if (res.value !== undefined) cleaned[field] = res.value;
    else if (spec.req) return { ok: false, error: field + ' required' };
  }
  // Always carry slackId through (runner injects it for authorization context).
  if (args.slackId && typeof args.slackId === 'string') cleaned.slackId = args.slackId.slice(0, 64);
  return { ok: true, cleaned };
}

// Cap a tool result's serialized size so a huge payload can't flood the prompt.
const MAX_RESULT_CHARS = 20000;
function capResult(result) {
  try {
    const s = JSON.stringify(result);
    if (s && s.length > MAX_RESULT_CHARS) {
      return { ok: !!(result && result.ok), truncated: true, summary: 'result too large — truncated', verifiedFacts: [] };
    }
  } catch (_) {}
  return result;
}

module.exports = { validateArgs, capResult, SCHEMAS, MAX_RESULT_CHARS };
