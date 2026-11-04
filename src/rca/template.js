'use strict';
/**
 * rca/template.js — validate + normalize an RCA response against the Relay
 * template (track.relay.amazon.dev/api/template/root-cause-analysis).
 *
 * Mirrors the rules of Relay's own TemplateFormRenderer (module 69244) and its
 * date widget (module 24217), read from the live bundles 2026-10-27:
 *   - `response` is a FLAT object keyed by field.propertyName.
 *   - selectInput: single -> the exact option string; allowsMultiple -> array.
 *   - booleanInput -> true / false.
 *   - textInput / textAreaInput -> string (textInputType "number" is still a
 *     string in the form; we format it as "0.00").
 *   - dateInput -> ISO-8601 UTC: the picked calendar date at 00:00:00 UTC
 *     (the RCA form passes no siteTimeZone, so the widget uses "UTC").
 *   - required unless field.required === false (a "true"/"false" string is
 *     coerced, as Relay's t9 helper does).
 *   - a field whose dependsOn isn't satisfied is hidden: skipped for
 *     validation and (unlike Relay's renderer, which forgets to) OMITTED from
 *     the submitted response.
 * Pure functions — no Electron, no network.
 */

const DISPLAY_ONLY = new Set(['textHeaderLabel', 'textBodyLabel']);

function isRequired(field) {
  if (!field) return false;
  if (typeof field.required === 'string') return field.required === 'true';
  return field.required !== false;
}

// Relay's dependsOn check (module 70700): every key must match; an array value
// matches if ANY of its elements is in the allowed list.
function isVisible(field, values) {
  const dep = field && field.dependsOn;
  if (dep == null) return true;
  if (values == null) return false;
  for (const [key, allowed] of Object.entries(dep)) {
    const v = values[key];
    const list = Array.isArray(allowed) ? allowed : [allowed];
    if (Array.isArray(v)) { if (!v.some((x) => list.includes(x))) return false; }
    else if (!list.includes(v)) return false;
  }
  return true;
}

function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

// Match a free value to one of the field's options: exact, then
// case/space-insensitive, then by leading code ("13" -> "013 Brakes" is NOT
// matched; "013" or "013 Brakes" is), then unique containment.
function matchOption(options, value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (options.includes(s)) return s;
  const norm = (x) => String(x).toLowerCase().replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
  const ns = norm(s);
  const exact = options.find((o) => norm(o) === ns);
  if (exact) return exact;
  const code = (ns.match(/^(\d{2,3})\b/) || [])[1];
  if (code) {
    const byCode = options.filter((o) => (norm(o).match(/^(\d{2,3})\b/) || [])[1] === code);
    if (byCode.length === 1) return byCode[0];
  }
  // Whole-word containment only (so short options like "TA"/"EV" don't match
  // inside other words), and the value must be >= 4 chars to match a longer option.
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contains = options.filter((o) => {
    const no = norm(o);
    return new RegExp('(^|[^a-z0-9])' + reEsc(no) + '($|[^a-z0-9])').test(ns) ||
      (ns.length >= 4 && new RegExp('(^|[^a-z0-9])' + reEsc(ns) + '($|[^a-z0-9])').test(no));
  });
  return contains.length === 1 ? contains[0] : null;
}

function _pad(n) { return String(n).padStart(2, '0'); }

// -> 'YYYY-MM-DDT00:00:00.000Z' or null. A bare 'YYYY-MM-DD' is taken as that
// calendar date. A timestamp (epoch ms or ISO with time) is converted to the
// LOCAL calendar date first (what the user would have picked), then encoded the
// way Relay's widget encodes a picked date.
function toRelayDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00.000Z';
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})T00:00:00(\.000)?Z$/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00.000Z';
  const t = typeof v === 'number' ? v : (/^\d{10,}$/.test(s) ? Number(s) : Date.parse(s));
  if (isNaN(t)) {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return y + '-' + _pad(m[1]) + '-' + _pad(m[2]) + 'T00:00:00.000Z';
  }
  const d = new Date(t);
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()) + 'T00:00:00.000Z';
}

function toBool(v) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

function toNumberString(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  if (isNaN(n) || n < 0) return null;
  return n.toFixed(2);
}

/**
 * normalizeResponse(template, values, opts) -> { response, errors, warnings }
 *   response : clean flat object, ready to submit (hidden + empty fields omitted)
 *   errors   : [{ field, label, message }] — blocking (required/invalid)
 *   warnings : [{ field, label, message }] — values dropped/adjusted
 * opts.requireAll (default true): report missing required fields as errors.
 */
function normalizeResponse(template, values, opts = {}) {
  const requireAll = opts.requireAll !== false;
  const fields = (template && Array.isArray(template.fields)) ? template.fields : [];
  const src = values || {};
  const work = {};      // normalized values, used for dependsOn evaluation
  const errors = [];
  const warnings = [];
  const label = (f) => f.displayName || f.propertyName;

  // Pass 1: normalize every field's value by type.
  for (const f of fields) {
    if (!f || !f.propertyName || DISPLAY_ONLY.has(f.fieldType)) continue;
    const raw = src[f.propertyName];
    if (isEmpty(raw)) continue;
    switch (f.fieldType) {
      case 'selectInput': {
        const options = Array.isArray(f.selectOptions) ? f.selectOptions : [];
        const list = Array.isArray(raw) ? raw : (f.allowsMultiple ? String(raw).split(/\s*;\s*/) : [raw]);
        const ok = [];
        for (const x of list) {
          const hit = matchOption(options, x);
          if (hit) { if (!ok.includes(hit)) ok.push(hit); }
          else if (!isEmpty(x)) warnings.push({ field: f.propertyName, label: label(f), message: 'Dropped "' + x + '" (not one of the form options)' });
        }
        if (!ok.length) break;
        if (f.allowsMultiple) work[f.propertyName] = ok;
        else {
          if (ok.length > 1) warnings.push({ field: f.propertyName, label: label(f), message: 'Single-choice field — kept "' + ok[0] + '"' });
          work[f.propertyName] = ok[0];
        }
        break;
      }
      case 'booleanInput': {
        const b = toBool(raw);
        if (b === null) warnings.push({ field: f.propertyName, label: label(f), message: 'Not a yes/no value: "' + raw + '"' });
        else work[f.propertyName] = b;
        break;
      }
      case 'dateInput': {
        const d = toRelayDate(raw);
        if (!d) warnings.push({ field: f.propertyName, label: label(f), message: 'Unreadable date: "' + raw + '"' });
        else work[f.propertyName] = d;
        break;
      }
      case 'textInput':
      case 'textAreaInput': {
        if (f.textInputType === 'number') {
          const n = toNumberString(raw);
          if (n === null) warnings.push({ field: f.propertyName, label: label(f), message: 'Not a number: "' + raw + '"' });
          else work[f.propertyName] = n;
        } else {
          const s = String(raw).trim();
          if (s) work[f.propertyName] = f.maxLength ? s.slice(0, f.maxLength) : s;
        }
        break;
      }
      default:
        // upload / unknown types are not supported by the API path.
        warnings.push({ field: f.propertyName, label: label(f), message: 'Field type "' + f.fieldType + '" is not supported here' });
    }
  }

  // Pass 2: drop hidden fields, then check required on the visible ones.
  // dependsOn can chain, so re-evaluate until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fields) {
      if (!f || !f.propertyName || !(f.propertyName in work)) continue;
      if (!isVisible(f, work)) { delete work[f.propertyName]; changed = true; }
    }
  }
  if (requireAll) {
    for (const f of fields) {
      if (!f || !f.propertyName || DISPLAY_ONLY.has(f.fieldType)) continue;
      if (!isVisible(f, work) || !isRequired(f)) continue;
      if (isEmpty(work[f.propertyName])) errors.push({ field: f.propertyName, label: label(f), message: 'Required' });
    }
  }

  return { response: work, errors, warnings };
}

module.exports = { normalizeResponse, isVisible, isRequired, matchOption, toRelayDate, toBool, toNumberString, DISPLAY_ONLY };
