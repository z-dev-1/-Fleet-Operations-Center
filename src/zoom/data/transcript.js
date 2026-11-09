'use strict';
/**
 * src/zoom/data/transcript.js — meeting transcripts (design §9 + review F-3, A2).
 *
 *   parseVtt(text) / parseTxt(text)  pure; 1-based GLOBAL segment index i; empty cues dropped;
 *                                    at most MAX_SEGMENTS (then truncated:true); sha256 over normalized text
 *   getTranscript({key})             LRU hit, else transport.getTranscriptFile(key) (portal)
 *   importTranscript({key})          main-process open dialog; .vtt/.txt, <= 2 MB, valid UTF-8
 *   peek(key)                        {segments, source, sha256, truncated} | null — NEVER fetches
 *
 * Both getTranscript and importTranscript store their result in the in-memory LRU (5 entries, 30 min
 * TTL) with source 'portal' | 'import'; summarize() reads it only through peek(). Nothing is persisted
 * and only counts are logged (never text, speaker names, file paths or URLs).
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { ZoomError, fail } = require('../errors');
const { safeErr, keyHash } = require('../redact');
const log = require('../../utils/logger')('zoom:data');

const MAX_SEGMENTS = 5000;
const LRU_MAX = 5;
const LRU_TTL_MS = 30 * 60 * 1000;
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const IMPORT_EXTS = Object.freeze(['.vtt', '.txt']);

// ── Pure parsing ───────────────────────────────────────────────────────────
const TIME_RE = /^\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
const VOICE_RE = /^<v(?:\.[^\s>]*)?\s+([^>]{1,80})>/i;
const SPEAKER_RE = /^([^:\n]{1,60}?):\s+(\S[\s\S]*)$/;

function _secs(t) {
  const parts = String(t).replace(',', '.').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return Math.round(s * 1000) / 1000;
}

function _clean(s) { return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }

/** _speakerSplit(text) -> {speaker|null, text}; a <v Name> tag or a "Name: text" prefix. */
function _speakerSplit(raw) {
  const s = String(raw || '').trim();
  const v = VOICE_RE.exec(s);
  if (v) return { speaker: _clean(v[1]) || null, text: _clean(s.slice(v[0].length)) };
  const t = _clean(s);
  const m = SPEAKER_RE.exec(t);
  if (m && !/^\d+$/.test(m[1].trim())) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: null, text: t };
}

function _sha(segments) {
  const norm = segments.map((g) => (g.speaker ? g.speaker + ': ' : '') + g.text).join('\n').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

function _finish(raw) {
  const truncated = raw.length > MAX_SEGMENTS;
  const kept = truncated ? raw.slice(0, MAX_SEGMENTS) : raw;
  const segments = kept.map((g, n) => ({ i: n + 1, startSec: g.startSec, endSec: g.endSec, speaker: g.speaker, text: g.text }));
  return { segments, truncated, sha256: _sha(segments) };
}

/** parseVtt(text) -> {segments, truncated, sha256}. Skips the WEBVTT header and NOTE / STYLE / REGION blocks. */
function parseVtt(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = src.split(/\n\s*\n/);
  const out = [];
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b].trim();
    if (!block) continue;
    if (b === 0 && /^WEBVTT\b/.test(block)) {
      // The header block may also carry a first cue when no blank line follows it.
      const lines = block.split('\n');
      const ti = lines.findIndex((l) => TIME_RE.test(l));
      if (ti < 0) continue;
      _cue(lines.slice(ti), out);
      continue;
    }
    if (/^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => TIME_RE.test(l));
    if (ti < 0) continue;
    _cue(lines.slice(ti), out);
    if (out.length > MAX_SEGMENTS) break;
  }
  return _finish(out);
}

function _cue(lines, out) {
  const m = TIME_RE.exec(lines[0]);
  const body = lines.slice(1).join(' ');
  const { speaker, text } = _speakerSplit(body);
  if (!text) return;
  out.push({ startSec: m ? _secs(m[1]) : null, endSec: m ? _secs(m[2]) : null, speaker, text });
}

/** parseTxt(text) -> {segments, truncated, sha256}. One segment per non-empty line; timings null. */
function parseTxt(text) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of src.split('\n')) {
    if (!line.trim()) continue;
    const { speaker, text: t } = _speakerSplit(line);
    if (!t) continue;
    out.push({ startSec: null, endSec: null, speaker, text: t });
    if (out.length > MAX_SEGMENTS) break;
  }
  return _finish(out);
}

/** parseAny(text) — parseVtt when the text starts with WEBVTT, else parseTxt. */
function parseAny(text) {
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  return /^WEBVTT\b/.test(s) ? parseVtt(s) : parseTxt(s);
}

// ── In-memory LRU (never persisted) ────────────────────────────────────────
const _lru = new Map();   // key -> {value:{segments, source, sha256, truncated}, at}

function _put(key, parsed, source) {
  const value = { segments: parsed.segments, source, sha256: parsed.sha256, truncated: parsed.truncated };
  _lru.delete(key);
  _lru.set(key, { value, at: Date.now() });
  while (_lru.size > LRU_MAX) _lru.delete(_lru.keys().next().value);
  return value;
}

/** peek(key) -> {segments, source, sha256, truncated} | null. Never fetches, never opens a dialog. */
function peek(key) {
  const e = _lru.get(key);
  if (!e) return null;
  if (Date.now() - e.at > LRU_TTL_MS) { _lru.delete(key); return null; }
  _lru.delete(key);
  _lru.set(key, e);
  return e.value;
}

// ── Channels ───────────────────────────────────────────────────────────────
function _result(value) { return { ok: true, transcript: value }; }

/** getTranscript({key}) -> {ok:true, transcript} | {ok:false, code, reason?} */
async function getTranscript(input) {
  const key = input.key;
  const hit = peek(key);
  if (hit) return _result(hit);
  const session = require('./session');
  await session.ensureSeeded('transcript');
  const r = await require('./transport').getTranscriptFile(key);
  if (!r || !r.ok) {
    // SIGN_IN_REQUIRED is returned as-is: per review F-5 only a capture or a status() cookie GET may set
    // signed-in state, so the renderer offers Connect and the next status() check emits auth-changed.
    const code = (r && r.code) || 'TRANSCRIPT_UNAVAILABLE';
    return fail(code, { reason: r && r.reason, status: r && r.status });
  }
  const parsed = parseAny(r.text);
  if (!parsed.segments.length) return fail('TRANSCRIPT_UNAVAILABLE', { reason: 'empty' });
  const value = _put(key, parsed, 'portal');
  try { log.info('[zoom] transcript', { op: 'transcript-parse', idHash: keyHash(key), segments: value.segments.length, truncated: value.truncated }); } catch (_) {}
  return _result(value);
}

function _keyKnown(key) {
  try { if (require('./client').getItem(key)) return true; } catch (_) {}
  try {
    const doc = require('../../store').load('zoomLinks', null);
    return !!(doc && doc.links && typeof doc.links === 'object' && Object.prototype.hasOwnProperty.call(doc.links, key));
  } catch (_) { return false; }
}

function _fsCode(e) {
  const c = e && e.code;
  if (c === 'ENOENT' || c === 'ENOTDIR') return 'NOT_FOUND';
  return 'IO_ERROR';
}

/** importTranscript({key}, {ctx}) -> {ok:true, transcript} | CANCELLED | INVALID_FILE | NOT_FOUND | IO_ERROR */
async function importTranscript(input, env) {
  const key = input.key;
  if (!_keyKnown(key)) return fail('NOT_FOUND');
  const { dialog } = require('./session')._electron();
  let parent = null;
  try {
    const w = env && env.ctx && env.ctx.mainWindow;
    parent = w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()) ? w : null;
  } catch (_) { parent = null; }
  const opts = { properties: ['openFile'], filters: [{ name: 'Transcript', extensions: ['vtt', 'txt'] }] };
  let pick;
  try {
    pick = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  } catch (e) {
    log.warn('[zoom] import dialog', safeErr(e));
    return fail('IO_ERROR');
  }
  if (!pick || pick.canceled || !Array.isArray(pick.filePaths) || !pick.filePaths.length) return fail('CANCELLED');
  const file = String(pick.filePaths[0] || '');
  if (!IMPORT_EXTS.includes(path.extname(file).toLowerCase())) return fail('INVALID_FILE');
  let text;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > IMPORT_MAX_BYTES) return fail('INVALID_FILE');
    const buf = await fs.promises.readFile(file);
    if (buf.length > IMPORT_MAX_BYTES) return fail('INVALID_FILE');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { return fail('INVALID_FILE'); }
  } catch (e) {
    if (e instanceof ZoomError) throw e;
    log.warn('[zoom] import read', safeErr(e));
    return fail(_fsCode(e));
  }
  const parsed = parseAny(text);
  if (!parsed.segments.length) return fail('INVALID_FILE');
  const value = _put(key, parsed, 'import');
  try { log.info('[zoom] transcript', { op: 'transcript-import', idHash: keyHash(key), segments: value.segments.length, truncated: value.truncated }); } catch (_) {}
  return _result(value);
}

function _resetForTests() { _lru.clear(); }

module.exports = {
  parseVtt, parseTxt, parseAny, peek, getTranscript, importTranscript, _resetForTests,
  MAX_SEGMENTS, LRU_MAX, LRU_TTL_MS, IMPORT_MAX_BYTES,
};
