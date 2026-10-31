/**
 * repair-intel/parts-extract.js — pull the SPECIFIC back-ordered part(s) out of
 * a work order's comment thread. The AAP API has NO structured parts field, so
 * the part name lives in free text ("waiting on the alternator, back-ordered 2
 * weeks"). This is a DETERMINISTIC, conservative extractor:
 *   - it only fires on an explicit back-order / on-order / sourcing phrase,
 *   - it pulls the nearby noun phrase as a SUSPECTED part (never confirmed),
 *   - it returns [] when nothing is clearly stated (no guessing / fabrication).
 * The AI layer can refine this later; this gives a useful signal with zero AI.
 */

// Phrases that signal a part is on back-order / being sourced.
const _TRIGGER = /\b(back[\s-]?order(?:ed)?|on\s+order|on\s+back\s?order|sourcing|awaiting|waiting\s+(?:on|for)|ordered|parts?\s+delay|p\.?o\.?\s+(?:placed|sent)|eta\b)\b/i;

// A rough part-name vocabulary — common truck components. Used to pick the most
// likely part token near a trigger. Extend freely; unknown words are still
// captured via the "<trigger> the <phrase>" grammar fallback.
const _PART_WORDS = [
  'alternator','starter','battery','batteries','turbo','turbocharger','injector','injectors',
  'egr','egr valve','dpf','def','def pump','sensor','harness','wiring harness','compressor',
  'ac compressor','radiator','water pump','fuel pump','oil pump','clutch','transmission',
  'driveshaft','u-joint','wheel seal','hub','brake','brakes','brake chamber','air dryer',
  'air compressor','air bag','airbag','leaf spring','shock','shocks','steering gear','pitman arm',
  'windshield','wiper','wiper motor','headlight','headlamp','tail light','mirror','door','latch',
  'fifth wheel','kingpin','mudflap','bumper','hood','coolant','thermostat','belt','serpentine belt',
  'pulley','fan clutch','exhaust','muffler','dpf filter','catalyst','ecm','ecu','module','actuator',
  'solenoid','relay','fuse','gauge','cluster','apu','inverter','charger','tire','tires','rim','valve',
];
// Longest phrases first so 'egr valve' / 'water pump' win over 'egr' / 'pump'
// (regex alternation is leftmost-wins).
const _PART_RE = new RegExp('\\b(' +
  _PART_WORDS.slice().sort((a, b) => b.length - a.length)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')\\b', 'i');

// Normalize for de-dup + display (lowercase, collapse spaces).
function _norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// Extract suspected back-ordered parts from an array of comment objects
// ([{text, timestamp, createdBy}]) OR a raw string. Returns an array of
// { part, phrase, at } — part = the matched component word, phrase = the short
// surrounding snippet for evidence, at = comment timestamp when available.
function extractBackorderedParts(comments) {
  const items = [];
  const seen = new Set();
  const list = Array.isArray(comments)
    ? comments
    : (typeof comments === 'string' ? [{ text: comments }] : []);

  for (const c of list) {
    const text = String((c && c.text) || '');
    if (!text || !_TRIGGER.test(text)) continue;
    // Split into sentences/clauses so the trigger + part stay local.
    const clauses = text.split(/[.;\n]|,(?=\s)/).map(s => s.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (!_TRIGGER.test(clause)) continue;
      let part = null, phrase = null;
      const pm = clause.match(_PART_RE);
      if (pm) {
        part = _norm(pm[1]);
        phrase = clause.length > 140 ? clause.slice(0, 140) + '\u2026' : clause;
      } else {
        // Grammar fallback: "<trigger> [the|a|an] <1-3 words>" — capture the noun
        // phrase right after the trigger, so novel parts still surface (as lower
        // confidence). Skip pure stop-words.
        // Greedy up to a natural stop (end, punctuation, or a trailing verb/
        // preposition) so multi-word parts like "flux capacitor assembly" stay whole.
        const gm = clause.match(/\b(?:back[\s-]?order(?:ed)?|on\s+order|sourcing|awaiting|waiting\s+(?:on|for)|ordered)\b\s+(?:the\s+|a\s+|an\s+|new\s+)?([a-z][a-z0-9\- ]{2,40}?)(?=\s+(?:is|are|was|were|from|for|to|and|will|has|have|\d)\b|[.,;]|$)/i);
        if (gm && gm[1]) {
          const cand = _norm(gm[1]).replace(/\b(part|parts|it|them|this|that|is|are|was|were|and|to|for|from|of|on|in|will|be|been|still|the|a|an)\b/g, '').replace(/\s+/g, ' ').trim();
          if (cand && cand.length >= 3) { part = cand; phrase = clause.length > 140 ? clause.slice(0, 140) + '\u2026' : clause; }
        }
      }
      if (!part) continue;
      const key = part;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ part, phrase, at: (c && c.timestamp) || null });
      if (items.length >= 8) return items; // cap — a WO won't have dozens
    }
  }
  return items;
}

module.exports = { extractBackorderedParts, _TRIGGER, _PART_RE };
