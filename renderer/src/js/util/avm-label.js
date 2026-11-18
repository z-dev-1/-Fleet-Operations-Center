// renderer/src/js/util/avm-label.js — human label for AAP AVM category codes.
//
// AAP's avmCodes tree keys categories by underscore codes (e.g. TOTAL_VEHICLE,
// CHECK_ENGINE_LIGHT). When a node has no displayName (the tree parser then
// falls back to the code) or the displayName itself is underscored/ALL CAPS,
// the WR dropdowns showed the raw code. formatAvmLabel turns that into readable
// text for DISPLAY ONLY. Never use it on a value that is submitted to AAP: the
// option VALUE and the areaPairs payload must keep the original code.
//
// Rules:
//   - underscores -> spaces, whitespace collapsed
//   - text that already has lowercase letters (a real displayName such as
//     "Steer Left" or "HALO TIRE INFLATOR (GEN 1 and GEN 2)") keeps its casing
//   - ALL-CAPS text is Title Cased, keeping known acronyms upper case
//     (CEL, HVAC, ADAS, ECU, GPS, EV, DEF, CVT, TOW, ...) and small joining
//     words lower case (except as the first word)

const ACRONYMS = new Set([
  'CEL', 'HVAC', 'ADAS', 'ECU', 'ECM', 'GPS', 'EV', 'DEF', 'CVT', 'TOW',
  'ABS', 'AC', 'AI', 'DPF', 'EGR', 'SCR', 'PTO', 'TPMS', 'LED', 'VIN', 'DOT',
  'PM', 'OEM', 'CNG', 'LNG', 'ID', 'NE', 'HD', 'GEN',
]);
const SMALL_WORDS = new Set(['AND', 'OR', 'OF', 'THE', 'A', 'AN', 'IN', 'ON', 'FOR', 'TO', 'WITH']);

function _caseToken(tok, isFirst) {
  // tok is a run of letters/digits only.
  if (!tok) return tok;
  if (ACRONYMS.has(tok)) return tok;
  if (!isFirst && SMALL_WORDS.has(tok)) return tok.toLowerCase();
  return tok.charAt(0) + tok.slice(1).toLowerCase();
}

export function formatAvmLabel(text) {
  if (text == null) return '';
  const s = String(text).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/[a-z]/.test(s)) return s;
  let first = true;
  // Case each alphanumeric run; punctuation (/, -, (, ), commas) passes through.
  return s.replace(/[A-Z0-9]+/g, (tok) => {
    const out = _caseToken(tok, first);
    first = false;
    return out;
  });
}
