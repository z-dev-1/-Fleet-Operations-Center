/**
 * orcha/redact_sharing.js — redact PII for CARRIER-FACING / SHARED surfaces.
 *
 * Scope (deliberately narrow): this is applied ONLY to text that leaves the
 * app toward a carrier/partner or is shown as the "official" shared timeline —
 * the Daily Carrier Briefing (src/scrapers/carrier_briefing.js) and the
 * unit-panel repair timeline (renderer). It is NOT applied to the stored
 * asistNotes / fullConversation / canonical evidence, so the AI/reasoning layer
 * keeps full, unredacted context.
 *
 * What it removes:
 *   - Personal names in the structured dealer-comment shapes the Decisiv/ASIST
 *     and Relay threads use:
 *       "Christy Adriaansen - Kenworth Northeast Group (Service Advisor)"
 *          -> "Kenworth Northeast Group (Service Advisor)"
 *       "to MALCOLM REED - Amazon Logistics (Fleet Support)"
 *          -> "to Amazon Logistics (Fleet Support)"
 *       signature tails like "BETSY TA" / "CHRISTINA TA" -> "TA"
 *   - Dollar amounts ($4,210.30, $13,977) — reuses the deep-scan cost regex.
 *   - Phone numbers and email addresses.
 *
 * What it KEEPS (confirmed with the operator — these help the carrier):
 *   - Vendor / company names (TA, Kenworth, Volvo, Amerit, Amazon Logistics…)
 *   - Dealer location names ("Kenworth Northeast Group - Rochester")
 *   - Case / reference numbers, part names, dates, repair actions.
 *
 * Honest limitation: reliably removing a BARE first name buried in prose
 * ("spoke with Christina") without a name roster is not possible mechanically.
 * This targets the STRUCTURED patterns (which carry the vast majority of names
 * in these feeds) plus all dollar values. The AI-written timeline already
 * avoids bare names by construction; this is the mechanical safety net.
 *
 * NOTE: there is a byte-for-byte twin of this logic for the renderer at
 * renderer/src/js/util/redact.js (ESM). Keep the two in sync.
 */

// Company / vendor / org tokens that must survive even when they appear right
// after a stripped personal name. Mirrors convo_parse VENDOR_SIGNALS + the US
// (Amazon) side, so "Name - Company" keeps the Company.
const KEEP_ORG_RE = /(amazon|logistics|amzl|fleet|relay|volvo|freightliner|kenworth|peterbilt|mack|international|cummins|navistar|paccar|travelcenters|\bta\b|amerit|cox|velociti|fleetnet|rush|hunter|kooner|goodyear|penske|ryder|dealer|truck|group|northeast|insurance|vanliner|protective)/i;

// A personal-name token sequence: 1–3 Capitalized words, or ALL-CAPS words.
const NAME_SEQ = String.raw`[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,3}`;

function _stripMoney(text) {
  return text
    .replace(/\s*\$\s?[\d,]+(?:\.\d{1,2})?\s*/g, ' ')     // $4,210.30 / $ 13,977
    .replace(/\b(?:USD|dollars?)\s*[\d,]+(?:\.\d{1,2})?\b/gi, '')
    .replace(/\s+at\s+\.\s*/g, '. ')
    .replace(/\s+at\s+under\s/g, ' under ');
}

// strict (email only): a 10-digit run right after "#" or a word character is
// a reference number ("Order #3010287243"), not a phone.
function _stripContacts(text, strict) {
  const phone = strict
    ? /(?<![#\w])\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g
    : /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '')          // emails
    .replace(phone, '');                                    // phones
}

// Extra company/shop tokens for the strict (email) mode, on top of
// KEEP_ORG_RE: "Uptime Center", "Bergey's Truck Centers", "Berman", DTNA.
const EMAIL_ORG_RE = /(cent(?:er|re)s?|service|repair|shop|garage|motors|parts|diesel|tire|towing|uptime|dtna|daimler|decisiv|berman|bergey|\binc\b|\bllc\b|\bcorp\b)/i;
function _isOrg(s) { return KEEP_ORG_RE.test(s) || EMAIL_ORG_RE.test(s); }

// Remove the personal-name part of "<Name> - <Company> (Role)" style headers,
// keeping the company/role. Also handles "to <NAME> - <Company>".
// strict (email only): the dash must have a space before it, so hyphenated
// words ("Follow-up", "PM-B", "Return-to-service") are not read as a name
// header, and a "name" that is itself a company ("Bergey's Truck Centers -
// Pennsauken") is kept.
function _stripNameHeaders(text, strict) {
  let s = text;
  const dash = strict ? '\\s+-\\s*' : '\\s*-\\s*';
  // "to Firstname Lastname - Company" -> "to Company"
  s = s.replace(
    new RegExp('\\bto\\s+' + NAME_SEQ + dash + '(?=[A-Za-z])', 'g'),
    (m) => ((strict ? _isOrg(m) : KEEP_ORG_RE.test(m)) ? m : 'to ')
  );
  // "Firstname Lastname - Company" -> "Company"  (name immediately before " - Org")
  s = s.replace(
    new RegExp('(^|[\\n\\.;:,]\\s*)(' + NAME_SEQ + ')' + dash + '(?=[A-Za-z])', 'g'),
    (full, pre, name) => (strict && _isOrg(name) ? full : pre)
  );
  return s;
}

// Signature tails: a personal name immediately preceding a known vendor token,
// e.g. "BETSY TA", "CHRISTINA TA", "MARK L TA" -> "TA". Only fires when the
// trailing token is a company/vendor token (so we don't eat real sentences).
// strict (email only): ALL-CAPS signatures only ("BETSY TA", "MARK L TA"), so
// sentence-case prose ("Requested Amerit", "Two TA locations") is kept.
function _stripSignatureTails(text, strict) {
  const re = strict
    ? /\b([A-Z][A-Z'’.-]*(?:\s+[A-Z][A-Z'’.-]*){0,2})\s+(TA|KW|PACCAR|Volvo|Amerit|Kenworth)\b/g
    : /\b([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,2})\s+(TA|KW|PACCAR|Volvo|Amerit|Kenworth)\b/g;
  return text.replace(re, (m, name, org) => (strict && _isOrg(name) ? m : org));
}

/**
 * redactForSharing(text) -> redacted string. Never throws; returns '' for
 * empty/non-string input and the cleaned text otherwise.
 */
function redactForSharing(text) { return _redact(text, false); }

function _redact(text, strict) {
  if (text == null) return '';
  let s = String(text);
  if (!s.trim()) return s;
  try {
    s = _stripNameHeaders(s, strict);
    s = _stripSignatureTails(s, strict);
    s = _stripContacts(s, strict);
    s = _stripMoney(s);
    // Tidy whitespace/punctuation left by removals.
    s = s
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+-\s*$/g, '')
      .trim();
  } catch (_) {
    // never throw — sharing falls back to the original; email drops the text
    // rather than send it unredacted
    return strict ? '' : String(text);
  }
  return s;
}

// Email-attribution tails the AI timeline writer appends, e.g.
// "(per Z Santiago email 11/16)" / "(per Santiago, Z email 10/27)".
// Keeps vendor/shop attributions ("per Amerit email", "per Uptime Center
// email") via _isOrg.
const PER_ATTRIB_RE = /\bper\s+([A-Z][a-zA-Z'’.-]*(?:,?\s+[A-Z][a-zA-Z'’.-]*){0,3})\s+(e-?mail|call|text|message|msg|voicemail)\b/g;

/**
 * redactForEmail(text) -> the same redaction as redactForSharing() in strict
 * mode (see _stripNameHeaders / _stripContacts), plus shapes seen in the
 * SOS/EOS report data that the sharing redaction misses: "per <Name> email"
 * attributions and "$2.5K"-style / backslash-escaped ("\$2,340.00") dollar
 * amounts. Used only by src/scrapers/emailBuilder.js at render time, so
 * redactForSharing() (carrier briefing) and the renderer twin
 * (renderer/src/js/util/redact.js) behave exactly as before. Never throws.
 */
function redactForEmail(text) {
  if (text == null) return '';
  let s = String(text);
  if (!s.trim()) return s;
  try {
    s = s.replace(PER_ATTRIB_RE, (m, name, via) => (_isOrg(name) ? m : 'per ' + via));
    s = s.replace(/\\?\$\s?[\d,]*\.?\d+\s?[kKmM]\b/g, ' ').replace(/\\(?=\$)/g, '');
  } catch (_) { /* fall through to the shared redaction */ }
  return _redact(s, true);
}

module.exports = { redactForSharing, redactForEmail };
