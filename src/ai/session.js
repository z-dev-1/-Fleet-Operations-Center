'use strict';
/**
 * src/ai/session.js — explicit session/task namespaces (spec §11).
 *
 * Persistent AI sessions (e.g. Fleet Brain) can inherit formatting/instructions
 * from unrelated tasks. Existing code defends against this with context-reset
 * prefixes; this module eliminates the root cause by giving every AI request a
 * SCOPED session namespace so a WR classification can't contaminate a Slack
 * draft, a DBR task can't bleed into a channel reply, etc.
 *
 * A scope is a stable key derived from (surface, taskType, conversation id).
 * Conversation context is kept PER SCOPE and bounded. Long-term knowledge
 * belongs in durable memory (src/ai/memory), NOT in arbitrary raw session
 * history — so this store holds only a small, recent, scope-local turn buffer.
 *
 * In-memory + bounded. No persistence (session history is ephemeral by design;
 * durable facts go to memory). Safe to use from any surface.
 */

const MAX_TURNS_PER_SCOPE = 12;   // small recent buffer; not a transcript store
const MAX_SCOPES = 200;           // bound total scopes in memory
const SCOPE_TTL_MS = 2 * 60 * 60 * 1000; // evict idle scopes after 2h

// scopeKey -> { turns: [{role, text, at}], lastAt }
const _scopes = new Map();

/**
 * scopeKey({ surface, taskType, conversationId }) -> stable namespace string.
 * conversationId is the thread/channel/DM id (or 'none'); taskType separates a
 * classification task from a drafting task on the SAME conversation so they
 * never share a buffer.
 */
function scopeKey(parts) {
  parts = parts || {};
  const surface = _tok(parts.surface || 'unknown');
  const task = _tok(parts.taskType || 'general');
  const convo = _tok(parts.conversationId || 'none');
  return surface + '::' + task + '::' + convo;
}

function _tok(s) { return String(s).trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 80) || 'none'; }

/** append(key, role, text) — add a scope-local turn (bounded). */
function append(key, role, text) {
  if (!key) return;
  _evictIfNeeded();
  const s = _scopes.get(key) || { turns: [], lastAt: 0 };
  s.turns.push({ role: String(role || 'user'), text: String(text || '').slice(0, 4000), at: Date.now() });
  if (s.turns.length > MAX_TURNS_PER_SCOPE) s.turns = s.turns.slice(-MAX_TURNS_PER_SCOPE);
  s.lastAt = Date.now();
  _scopes.set(key, s);
}

/** history(key, limit) -> recent scope-local turns (oldest-first), or []. */
function history(key, limit) {
  const s = _scopes.get(key);
  if (!s) return [];
  const turns = s.turns;
  return (limit ? turns.slice(-limit) : turns).map((t) => ({ role: t.role, text: t.text }));
}

/** reset(key) — clear a scope's buffer (e.g. a fresh structured-extraction task). */
function reset(key) { _scopes.delete(key); }

/** clearAll() — test/maintenance helper. */
function clearAll() { _scopes.clear(); }

/** stats() — observability: scope count + total buffered turns. */
function stats() {
  let turns = 0; _scopes.forEach((s) => { turns += s.turns.length; });
  return { scopes: _scopes.size, turns };
}

// Evict idle/oldest scopes so the map stays bounded and stale context never
// lingers to contaminate a later task.
function _evictIfNeeded() {
  const now = Date.now();
  for (const [k, s] of _scopes) { if (now - s.lastAt > SCOPE_TTL_MS) _scopes.delete(k); }
  if (_scopes.size > MAX_SCOPES) {
    const entries = Array.from(_scopes.entries()).sort((a, b) => a[1].lastAt - b[1].lastAt);
    const drop = entries.slice(0, _scopes.size - MAX_SCOPES);
    for (const [k] of drop) _scopes.delete(k);
  }
}

module.exports = { scopeKey, append, history, reset, clearAll, stats, MAX_TURNS_PER_SCOPE };
