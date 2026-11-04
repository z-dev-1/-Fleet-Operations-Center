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

function _stripContacts(text) {
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '')          // emails
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, ''); // phones
}

// Remove the personal-name part of "<Name> - <Company> (Role)" style headers,
// keeping the company/role. Also handles "to <NAME> - <Company>".
function _stripNameHeaders(text) {
  let s = text;
  // "to Firstname Lastname - Company" -> "to Company"
  s = s.replace(
    new RegExp('\\bto\\s+' + NAME_SEQ + '\\s*-\\s*(?=[A-Za-z])', 'g'),
    (m) => (KEEP_ORG_RE.test(m) ? m : 'to ')
  );
  // "Firstname Lastname - Company" -> "Company"  (name immediately before " - Org")
  s = s.replace(
    new RegExp('(^|[\\n\\.;:,]\\s*)' + NAME_SEQ + '\\s*-\\s*(?=[A-Za-z])', 'g'),
    (full, pre) => pre
  );
  return s;
}

// Signature tails: a personal name immediately preceding a known vendor token,
// e.g. "BETSY TA", "CHRISTINA TA", "MARK L TA" -> "TA". Only fires when the
// trailing token is a company/vendor token (so we don't eat real sentences).
function _stripSignatureTails(text) {
  return text.replace(
    /\b([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,2})\s+(TA|KW|PACCAR|Volvo|Amerit|Kenworth)\b/g,
    (m, name, org) => org
  );
}

/**
 * redactForSharing(text) -> redacted string. Never throws; returns '' for
 * empty/non-string input and the cleaned text otherwise.
 */
function redactForSharing(text) {
  if (text == null) return '';
  let s = String(text);
  if (!s.trim()) return s;
  try {
    s = _stripNameHeaders(s);
    s = _stripSignatureTails(s);
    s = _stripContacts(s);
    s = _stripMoney(s);
    // Tidy whitespace/punctuation left by removals.
    s = s
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s+-\s*$/g, '')
      .trim();
  } catch (_) {
    return String(text); // never throw — fall back to original on any error
  }
  return s;
}

module.exports = { redactForSharing };
