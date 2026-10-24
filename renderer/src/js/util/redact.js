// renderer/src/js/util/redact.js — ESM twin of src/orcha/redact_sharing.js.
//
// Redacts personal names + dollar amounts for CARRIER-FACING / shared display
// (the unit-panel repair timeline). KEEPS vendor/company names, dealer
// locations, case numbers, parts, dates. Applied as a display backstop only —
// the stored data and the raw "Dealer comments (offsite)" block are untouched.
//
// Keep byte-for-byte in sync with src/orcha/redact_sharing.js (main process).

const KEEP_ORG_RE = /(amazon|logistics|amzl|fleet|relay|volvo|freightliner|kenworth|peterbilt|mack|international|cummins|navistar|paccar|travelcenters|\bta\b|amerit|cox|velociti|fleetnet|rush|hunter|kooner|goodyear|penske|ryder|dealer|truck|group|northeast|insurance|vanliner|protective)/i;
const NAME_SEQ = String.raw`[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,3}`;

function _stripMoney(text) {
  return text
    .replace(/\s*\$\s?[\d,]+(?:\.\d{1,2})?\s*/g, ' ')
    .replace(/\b(?:USD|dollars?)\s*[\d,]+(?:\.\d{1,2})?\b/gi, '')
    .replace(/\s+at\s+\.\s*/g, '. ')
    .replace(/\s+at\s+under\s/g, ' under ');
}

function _stripContacts(text) {
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '')
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '');
}

function _stripNameHeaders(text) {
  let s = text;
  s = s.replace(
    new RegExp('\\bto\\s+' + NAME_SEQ + '\\s*-\\s*(?=[A-Za-z])', 'g'),
    (m) => (KEEP_ORG_RE.test(m) ? m : 'to ')
  );
  s = s.replace(
    new RegExp('(^|[\\n\\.;:,]\\s*)' + NAME_SEQ + '\\s*-\\s*(?=[A-Za-z])', 'g'),
    (full, pre) => pre
  );
  return s;
}

function _stripSignatureTails(text) {
  return text.replace(
    /\b([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,2})\s+(TA|KW|PACCAR|Volvo|Amerit|Kenworth)\b/g,
    (m, name, org) => org
  );
}

export function redactForSharing(text) {
  if (text == null) return '';
  let s = String(text);
  if (!s.trim()) return s;
  try {
    s = _stripNameHeaders(s);
    s = _stripSignatureTails(s);
    s = _stripContacts(s);
    s = _stripMoney(s);
    s = s
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+-\s*$/g, '')
      .trim();
  } catch (_) {
    return String(text);
  }
  return s;
}

export default { redactForSharing };
