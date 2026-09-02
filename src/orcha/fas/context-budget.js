'use strict';
/**
 * orcha/fas/context-budget.js — Digital FAS Stage 12: context-budget manager.
 *
 * Assembles the model prompt from prioritized sections and trims to a
 * configurable character budget (provider-independent — not tied to one fixed
 * context window). Priority order (highest first):
 *   1. System + safety rules            (NEVER truncated)
 *   2. Current sender + authorization   (NEVER truncated)
 *   3. Current message + immediate convo(NEVER truncated)
 *   4. Action results this turn         (NEVER truncated)
 *   5. Relevant case summary
 *   6. Verified facts (newest / conflicts / safety holds preserved first)
 *   7. Relevant FAS playbook sections
 *   8. Recent supporting conversation excerpts
 *   9. Optional background
 *
 * When over budget: drop/summarize from the LOWEST priority up. Protected
 * sections (1–4) are always kept in full; if they alone exceed budget we still
 * keep them (correctness over size).
 */

// Section priority — lower number = higher priority = kept first.
const PRIORITY = {
  system: 1, safety: 1,
  sender: 2, authorization: 2,
  message: 3, conversation: 3,
  actionResults: 4,
  caseSummary: 5,
  verifiedFacts: 6,
  playbook: 7,
  excerpts: 8,
  background: 9,
};
// Sections that must never be dropped or truncated.
const PROTECTED = new Set(['system', 'safety', 'sender', 'authorization', 'message', 'conversation', 'actionResults']);

/**
 * assemble(sections, budgetChars) -> { prompt, dropped, usedChars }
 * `sections` is an array of { key, label, text }. Order in output follows
 * priority, then original order within the same priority.
 */
function assemble(sections, budgetChars) {
  const budget = Number(budgetChars) || 24000;
  const items = (sections || [])
    .filter(s => s && s.text != null && String(s.text).length)
    .map((s, i) => ({ ...s, text: String(s.text), pri: PRIORITY[s.key] != null ? PRIORITY[s.key] : 9, ord: i }));

  // Sort by priority then original order.
  items.sort((a, b) => (a.pri - b.pri) || (a.ord - b.ord));

  const kept = [];
  const dropped = [];
  let used = 0;

  for (const it of items) {
    const block = _fmt(it);
    const cost = block.length;
    if (PROTECTED.has(it.key)) {
      kept.push(it); used += cost; continue; // always keep, even if over budget
    }
    if (used + cost <= budget) {
      kept.push(it); used += cost; continue;
    }
    // Over budget: try to fit a trimmed version, else drop.
    const remaining = budget - used;
    if (remaining > 300) {
      const trimmedText = _trimText(it.text, remaining - (block.length - it.text.length) - 40);
      if (trimmedText) {
        const trimmed = { ...it, text: trimmedText + '\n[…trimmed to fit budget…]' };
        kept.push(trimmed); used += _fmt(trimmed).length;
        dropped.push({ key: it.key, label: it.label, action: 'trimmed' });
        continue;
      }
    }
    dropped.push({ key: it.key, label: it.label, action: 'dropped' });
  }

  // Re-sort kept back into priority order for a coherent prompt.
  kept.sort((a, b) => (a.pri - b.pri) || (a.ord - b.ord));
  const prompt = kept.map(_fmt).join('\n\n');
  return { prompt, dropped, usedChars: prompt.length, budget };
}

function _fmt(it) {
  const label = it.label || it.key;
  return '=== ' + label + ' ===\n' + it.text;
}

// Trim text to ~maxChars, preferring to keep the FIRST portion (which for
// verified facts holds the newest / most important entries when the caller
// pre-sorts that way).
function _trimText(text, maxChars) {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNl = cut.lastIndexOf('\n');
  return lastNl > maxChars * 0.5 ? cut.slice(0, lastNl) : cut;
}

module.exports = { assemble, PRIORITY, PROTECTED };
