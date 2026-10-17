'use strict';
/**
 * orcha/reason.js — the shared REASONING primitive.
 *
 * Every "decide-and-act" flow in the app follows the same shape: assemble
 * grounded facts, ask the AI to DECIDE (strict JSON out, not prose), parse it
 * robustly, and fall back deterministically when the AI is unavailable. That
 * glue was duplicated in email_triage.js and relay_reconcile.js (and would be
 * duplicated again by every new engine). This module is the single place that
 * owns it, so "everything reasons the same way":
 *
 *   - one AI call path (relay.ask) with a bounded timeout so a slow backend
 *     can never hang a caller,
 *   - one robust JSON extractor (regex-extract the {...} + trailing-comma
 *     retry — identical to what the two engines already used),
 *   - a never-throw contract: returns { ok:false } on empty/unparseable/throw
 *     so callers fall back cleanly instead of crashing a sync pass,
 *   - a hard prompt-size guard (truncate, never silently overflow the backend).
 *
 * Engine-specific logic — building the prompt and normalizing/validating the
 * decision against real data — stays in each engine. This core only turns
 * "a prompt that expects JSON" into "a parsed object or a clean miss".
 *
 * It is intentionally dependency-light: relay is required lazily so this module
 * is trivially unit-testable with a stubbed relay.
 */

let logger; try { logger = require('../utils/logger')('reason'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

// Keep prompts safely under the backend's ~60k-char claude-code cap. Callers
// should already clip their own fields; this is the final backstop.
const PROMPT_CAP = 58000;
const DEFAULT_TIMEOUT_MS = 90000;

// Robust JSON extraction — matches the pattern both engines used verbatim:
// grab the first {...} block, JSON.parse, retry once after stripping trailing
// commas, else null. Exported so engines can share the exact same parser.
function parseJson(text) {
  if (!text) return null;
  const str = (typeof text === 'string') ? text : (text && text.text ? String(text.text) : '');
  const m = str.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (_) {}
  return null;
}

/**
 * reason(opts) -> Promise<{ ok, data, raw, aiUsed, error }>
 *
 * opts:
 *   prompt       (string, required unless facts+question given) — a prompt that
 *                instructs the model to RETURN STRICT JSON.
 *   facts, question, schemaHint (optional) — if `prompt` is omitted, a prompt is
 *                assembled as: question + "\nFACTS:\n" + facts +
 *                "\nReturn STRICT JSON ONLY: " + schemaHint. Most engines pass
 *                a fully-built `prompt` instead and get full control.
 *   expectArray  (string) — if set, require data[expectArray] to be an array for
 *                ok:true (e.g. 'emails' for a batch); otherwise ok requires a
 *                parsed object.
 *   signal, requestId — passed straight to relay.ask.
 *   timeoutMs    (default 90000) — hard bound; on timeout returns ok:false.
 *   label        (string) — for log lines.
 *   _relay       — injected for tests (defaults to require('../orcha/relay')).
 *
 * Returns ok:true with the parsed `data` object, or ok:false (never throws) so
 * the caller can run its deterministic fallback.
 */
async function reason(opts) {
  opts = opts || {};
  const label = opts.label || 'reason';
  let prompt = opts.prompt;
  if (!prompt) {
    const parts = [];
    if (opts.question) parts.push(String(opts.question));
    if (opts.facts) parts.push('\nFACTS:\n' + String(opts.facts));
    if (opts.schemaHint) parts.push('\nReturn STRICT JSON ONLY (no prose, no markdown): ' + String(opts.schemaHint));
    prompt = parts.join('\n');
  }
  if (!prompt || !String(prompt).trim()) {
    return { ok: false, data: null, raw: '', aiUsed: false, error: 'empty prompt' };
  }
  // Final backstop on prompt size.
  if (prompt.length > PROMPT_CAP) {
    prompt = prompt.slice(0, PROMPT_CAP) + '\n...[truncated]';
  }

  const relay = opts._relay || require('../orcha/relay');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  let raw = '';
  try {
    raw = await Promise.race([
      relay.ask(prompt, { signal: opts.signal, requestId: opts.requestId }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('reason-timeout')), timeoutMs)),
    ]);
  } catch (e) {
    logger.warn('[' + label + '] AI call failed: ' + (e && e.message));
    return { ok: false, data: null, raw: '', aiUsed: false, error: (e && e.message) || 'ai-failed' };
  }

  const data = parseJson(raw);
  if (!data) {
    logger.warn('[' + label + '] AI returned no parseable JSON');
    return { ok: false, data: null, raw: (typeof raw === 'string' ? raw : ''), aiUsed: false, error: 'unparseable' };
  }
  if (opts.expectArray && !Array.isArray(data[opts.expectArray])) {
    logger.warn('[' + label + '] AI JSON missing expected array "' + opts.expectArray + '"');
    return { ok: false, data, raw: (typeof raw === 'string' ? raw : ''), aiUsed: false, error: 'missing-array' };
  }
  return { ok: true, data, raw: (typeof raw === 'string' ? raw : ''), aiUsed: true, error: null };
}

/**
 * reasonMany(items, buildPrompt, opts) -> Promise<{ results: Map-by-key, aiUsed }>
 * Helper for batching a list of items under the prompt cap. Each batch is a
 * single reason() call; buildPrompt(batch) returns the batch prompt. Returns the
 * raw parsed `data` objects per batch (the caller maps verdicts to items). Kept
 * minimal — most engines batch themselves; this is here for new fleet-wide ones.
 */
async function reasonMany(batches, buildPrompt, opts) {
  opts = opts || {};
  const out = [];
  let aiUsed = false;
  for (const batch of (Array.isArray(batches) ? batches : [])) {
    const r = await reason({ ...opts, prompt: buildPrompt(batch) });
    if (r.ok) aiUsed = true;
    out.push({ batch, result: r });
  }
  return { batches: out, aiUsed };
}

module.exports = {
  reason,
  reasonMany,
  parseJson,
  PROMPT_CAP,
  DEFAULT_TIMEOUT_MS,
};
