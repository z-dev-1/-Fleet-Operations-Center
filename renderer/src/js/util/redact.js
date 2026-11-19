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
const EMAIL_ORG_RE = /(cent(?:er|re)s?|service|repair|shop|garage|motors|parts|diesel|tire|towing|uptime|dtna|daimler|decisiv|berman|bergey|\binc\b|\bllc\b|\bcorp\b)/i;
function _isOrg(s) { return KEEP_ORG_RE.test(s) || EMAIL_ORG_RE.test(s); }
const DATED_NAME_RE = new RegExp('((?:^|\\n)[ \\t]*\\d{1,2}\\/\\d{1,2}(?:\\s*-\\s*\\d{1,2}\\/\\d{1,2})?\\s+[-\\u2013]\\s+(?:\\[[^\\]\\n]{0,40}\\]\\s+)?)(' + NAME_SEQ + ')\\s+-\\s*(?=[A-Za-z])', 'g');
const PER_ATTRIB_RE = /\bper\s+([A-Z][a-zA-Z'’.-]*(?:,?\s+[A-Z][a-zA-Z'’.-]*){0,3})\s+(e-?mail|call|text|message|msg|voicemail)\b/g;
function _stripPerAttrib(s) {
  PER_ATTRIB_RE.lastIndex = 0;
  return s.replace(PER_ATTRIB_RE, (m, name, via) => (_isOrg(name) ? m : 'per ' + via));
}

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
  s = s.replace(DATED_NAME_RE, (full, pre, name) => (_isOrg(name) ? full : pre));
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
  const s = String(text);
  if (!s.trim()) return s;
  try {
    return _redact(_stripPerAttrib(s));
  } catch (_) {
    return _redact(s);
  }
}

function _redact(text) {
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
