'use strict';
/**
 * src/ai/context-budget.js — context budget manager (spec §13).
 *
 * The model should receive ONLY the evidence needed for the task. This packs a
 * prioritized set of context SECTIONS into a character budget, dropping
 * low-value content BEFORE high-value evidence as the fleet dataset grows.
 *
 * Priority (highest kept first, spec §13):
 *   1. required authoritative facts
 *   2. recent relevant conversation
 *   3. relevant historical context
 *   4. relevant memories
 *   5. optional supporting detail
 *
 * Tracks estimated tokens / evidence count / history size / memory size and
 * reports what was dropped (for the trace). Deterministic + pure.
 *
 * NOTE: this complements the existing FAS context-budget (orcha/fas/context-
 * budget.js) which packs the FAS prompt; this one operates on the AI Core
 * structured sections. It does not replace the FAS budgeter.
 */

// Priority weights by section kind (higher = kept longer).
const PRIORITY = {
  required_facts: 100,
  conversation: 80,
  history: 60,
  memory: 40,
  optional: 20,
};

const DEFAULT_BUDGET_CHARS = 24000;
// ~4 chars/token heuristic (provider-independent; matches the FAS budgeter's
// own conservative estimate).
function estimateTokens(chars) { return Math.ceil((chars || 0) / 4); }

function _len(text) { try { return typeof text === 'string' ? text.length : JSON.stringify(text).length; } catch (_) { return 0; } }

/**
 * pack(sections, opts) -> { kept, dropped, usedChars, estTokens, budget, stats }
 * sections: [{ kind, label, text|data, weight? }]
 *   - kind: one of PRIORITY keys (defaults to 'optional')
 *   - weight: optional override of the kind's priority
 * opts.budgetChars (default 24000).
 *
 * Sections are sorted by effective priority (desc), then packed until the
 * budget is exhausted. A section that would overflow is DROPPED (not truncated)
 * unless it is a required_facts section, which is always kept (and may push the
 * budget slightly — required authoritative facts are never dropped, spec §13/§16).
 */
function pack(sections, opts) {
  opts = opts || {};
  const budget = _posInt(opts.budgetChars, DEFAULT_BUDGET_CHARS);
  const list = (sections || []).map((s, i) => ({
    i,
    kind: PRIORITY[s.kind] != null ? s.kind : 'optional',
    label: s.label || s.kind || 'section',
    text: typeof s.text === 'string' ? s.text : (s.data != null ? _stringify(s.data) : ''),
    weight: typeof s.weight === 'number' ? s.weight : PRIORITY[s.kind] != null ? PRIORITY[s.kind] : PRIORITY.optional,
  }));

  // Sort by priority desc, then original order (stable).
  list.sort((a, b) => (b.weight - a.weight) || (a.i - b.i));

  const kept = [];
  const dropped = [];
  let used = 0;
  for (const s of list) {
    const size = _len(s.text);
    const isRequired = s.kind === 'required_facts';
    if (isRequired || used + size <= budget) {
      kept.push({ kind: s.kind, label: s.label, text: s.text, chars: size });
      used += size;
    } else {
      dropped.push({ kind: s.kind, label: s.label, chars: size });
    }
  }

  // Re-sort kept back to the intended presentation order (priority desc keeps
  // required facts first, which is the desired prompt order).
  kept.sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0));

  const stats = {
    requiredFactsChars: kept.filter((k) => k.kind === 'required_facts').reduce((n, k) => n + k.chars, 0),
    conversationChars: kept.filter((k) => k.kind === 'conversation').reduce((n, k) => n + k.chars, 0),
    historyChars: kept.filter((k) => k.kind === 'history').reduce((n, k) => n + k.chars, 0),
    memoryChars: kept.filter((k) => k.kind === 'memory').reduce((n, k) => n + k.chars, 0),
    optionalChars: kept.filter((k) => k.kind === 'optional').reduce((n, k) => n + k.chars, 0),
    sectionsKept: kept.length,
    sectionsDropped: dropped.length,
  };

  return { kept, dropped, usedChars: used, estTokens: estimateTokens(used), budget, stats };
}

/** render(packed) -> a single prompt string from the kept sections, labeled. */
function render(packed) {
  if (!packed || !Array.isArray(packed.kept)) return '';
  return packed.kept.map((k) => '=== ' + k.label.toUpperCase() + ' ===\n' + k.text).join('\n\n');
}

function _stringify(v) { try { return JSON.stringify(v, null, 0); } catch (_) { return String(v); } }
function _posInt(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; }

module.exports = { pack, render, estimateTokens, PRIORITY, DEFAULT_BUDGET_CHARS };
