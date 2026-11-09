// renderer/src/js/util/ai-json.js — ESM twin of src/utils/ai-json.js.
//
// Tolerant JSON extraction from AI replies for the renderer (bundled by
// Vite/esbuild). AI replies (notably Aki) often wrap the JSON in leading prose,
// a ```json fence, or trailing commentary, and may put raw newlines inside
// string values. Finds the FIRST balanced top-level {...} / [...] that parses,
// ignoring brackets inside JSON strings. Pure string -> value; JSON.parse only,
// never evaluates anything. Returns null when no JSON is found.
//
// Keep the shared body byte-for-byte in sync with src/utils/ai-json.js
// (main process; tests/ai-json.test.js enforces this).

// >>> ai-json shared body
const _FENCE_RE = /```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;

function _fenceBodies(text) {
  const out = [];
  _FENCE_RE.lastIndex = 0;
  let m;
  while ((m = _FENCE_RE.exec(text)) !== null) {
    if (m[1] && m[1].trim()) out.push(m[1]);
    if (m[0].length === 0) _FENCE_RE.lastIndex++;
  }
  return out;
}

// String-aware repair: escape raw control chars inside string literals and
// drop trailing commas (outside strings) before a closing } or ].
function _repair(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

function _tryParse(candidate, isWanted) {
  const attempts = [candidate, _repair(candidate)];
  if (/[\u201C\u201D]/.test(candidate)) {
    attempts.push(_repair(candidate.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")));
  }
  for (let k = 0; k < attempts.length; k++) {
    try {
      const v = JSON.parse(attempts[k]);
      if (isWanted(v)) return { ok: true, value: v };
    } catch (_) { /* next attempt */ }
  }
  return { ok: false, value: null };
}

// Index of the bracket that closes the one at `start`, or -1 if unbalanced.
function _matchClose(src, start, open, close) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function _extract(text, open, close, isWanted) {
  try {
    if (typeof text !== 'string' || !text) return null;
    const sources = _fenceBodies(text);
    sources.push(text);
    for (let n = 0; n < sources.length; n++) {
      const src = sources[n];
      for (let s = src.indexOf(open); s >= 0; s = src.indexOf(open, s + 1)) {
        const e = _matchClose(src, s, open, close);
        if (e < 0) continue;
        const r = _tryParse(src.slice(s, e + 1), isWanted);
        if (r.ok) return r.value;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function _isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// First JSON object in an AI reply, or null.
function extractJsonObject(text) { return _extract(text, '{', '}', _isPlainObject); }

// First JSON array in an AI reply, or null.
function extractJsonArray(text) { return _extract(text, '[', ']', Array.isArray); }
// <<< ai-json shared body

export { extractJsonObject, extractJsonArray };
