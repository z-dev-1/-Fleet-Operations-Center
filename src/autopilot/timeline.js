'use strict';
/**
 * autopilot/timeline.js — published timeline reuse and timeline proposals (V2 design §7.3). Pure.
 *
 *   publishedItems(notesStoreDoc, equipmentId, { now, knownItems, staleDays }) -> evidence items
 *     One item per published timeline / priorHistory line (hidden lines removed by entrySig):
 *     source 'timeline', field 'line', trust derived_ai, or untrusted_text + flag manual_entry for
 *     lines the user typed. observedAt from the line's MM/DD (inferYmd). Plus one derived_ai item
 *     per line of a version-1 timelineDigest. At most 60 lines + 12 digest lines, values <= 300.
 *   publishedIndex(notesStoreDoc, equipmentId) -> { published: { 'MM/DD': [sig] }, hiddenSigs: [sig] }
 *   buildProposals({ rec, items, output, published, hiddenSigs, runId, now }) -> <= 20 proposal rows
 *
 * Requires only ../orcha/timeline-text (pure), ./evidence (createCollector) and ./constants.
 * notesStore is passed in by the caller (ports.readStore); this module never writes it.
 */

const crypto = require('crypto');
const TT = require('../orcha/timeline-text');
const { createCollector } = require('./evidence');
const { SOURCES: S, normUnit, localDate, isAuthoritativeEtcTag } = require('./constants');

const LINES_MAX = 60;
const DIGEST_MAX = 12;
const VALUE_MAX = 300;
const PROPOSALS_MAX = 20;
const INFERRED_MIN_CONF = 0.6;
const FALLBACK_OBSERVED_FROM = new Set(['buildAt', 'syncedAt', 'retrievedAt']);
const NO_SUPPORT_FLAGS = Object.freeze(['canonical_derived', 'derived_calc', 'manual_entry']);

function _arr(v) { return Array.isArray(v) ? v : []; }
function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _lines(v) {
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x));
  if (typeof v === 'string') return v.split(/\r?\n/);
  return [];
}
function _entryText(e) { return e && typeof e === 'object' ? String(e.text || e.entry || '') : String(e == null ? '' : e); }
function _flags(it) { return Array.isArray(it && it.flags) ? it.flags : []; }
function _p2(n) { return String(n).padStart(2, '0'); }
function _md(ms) { const d = new Date(ms); return _p2(d.getMonth() + 1) + '/' + _p2(d.getDate()); }

function _nsOf(doc, equipmentId) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const ns = d[equipmentId] || d[normUnit(equipmentId)];
  return ns && typeof ns === 'object' ? ns : {};
}

// observedAt of a 'MM/DD - ...' line (no year: inferYmd's same-year rule), or null.
function _lineAt(line, now) {
  const m = TT.LINE_RE.exec(String(line || '').trim());
  if (!m) return null;
  const [mm, dd] = m[1].split('/');
  const t = Date.parse(TT.inferYmd(mm, dd, now) + 'T12:00:00');
  return Number.isFinite(t) ? t : null;
}

function publishedItems(notesStoreDoc, equipmentId, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ns = _nsOf(notesStoreDoc, equipmentId);
  const hiddenSigs = new Set(_arr(ns.hiddenEntries).map((e) => TT.entrySig(_entryText(e))));
  const manualSigs = new Set(_arr(ns.manualEntries).map((e) => TT.entrySig(_entryText(e))));
  const col = createCollector({ now, staleDays: o.staleDays }, { knownItems: o.knownItems || [] });
  const prov = { retrievedAt: now };

  const dated = [];
  for (const raw of _lines(ns.priorHistory).concat(_lines(ns.timeline))) {
    const line = raw.trim();
    if (!line || !TT.LINE_RE.test(line)) continue;
    const sig = TT.entrySig(line);
    if (hiddenSigs.has(sig)) continue;
    dated.push({ line, sig });
  }
  for (const { line, sig } of dated.slice(-LINES_MAX)) {
    const manual = manualSigs.has(sig);
    const at = _lineAt(line, now);
    col.add(S.TIMELINE, 'line', line.slice(0, VALUE_MAX), prov, {
      sourceRef: 'timeline/' + _sha1(sig).slice(0, 12),
      flags: manual ? ['manual_entry'] : [],
      observedAt: at == null ? undefined : at,
    });
  }

  const d = ns.timelineDigest;
  if (d && typeof d === 'object' && d.v === 1 && Array.isArray(d.lines)) {
    const gen = Date.parse(d.generatedAt);
    d.lines.slice(0, DIGEST_MAX).forEach((raw, i) => {
      const line = String(raw == null ? '' : raw).trim();
      if (!line) return;
      const at = _lineAt(line, now);
      const observedAt = at != null ? at : (Number.isFinite(gen) ? gen : undefined);
      col.add(S.TIMELINE, 'digest', line.slice(0, VALUE_MAX), prov, { sourceRef: 'timeline/digest/' + i, observedAt });
    });
  }
  return col.items;
}

function publishedIndex(notesStoreDoc, equipmentId) {
  const ns = _nsOf(notesStoreDoc, equipmentId);
  const published = {};
  for (const raw of _lines(ns.priorHistory).concat(_lines(ns.timeline))) {
    const line = raw.trim();
    const m = TT.LINE_RE.exec(line);
    if (!m) continue;
    const [mm, dd] = m[1].split('/');
    const md = _p2(mm) + '/' + _p2(dd);
    (published[md] = published[md] || []).push(TT.entrySig(line));
  }
  return { published, hiddenSigs: _arr(ns.hiddenEntries).map((e) => TT.entrySig(_entryText(e))) };
}

// ── proposals ───────────────────────────────────────────────────────────────

const SOURCE_LABEL = Object.freeze({ decisiv: 'Decisiv', dtna: 'DTNA', aap_cache: 'AAP', aap_live: 'AAP' });

// Structured values only, as a short safe token for the description templates.
function _tok(v) { return String(v == null ? '' : v).replace(/[^A-Za-z0-9 ._:/-]/g, '').trim().slice(0, 60); }
function _clean(s) {
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, VALUE_MAX);
}
function _normDesc(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function _sourceTimed(it) {
  return it && it.trust === 'structured' && Number.isFinite(it.observedAt) && !FALLBACK_OBSERVED_FROM.has(it.observedFrom)
    && !NO_SUPPORT_FLAGS.some((f) => _flags(it).includes(f)) && !_flags(it).includes('wo_association_mismatch');
}
function _supports(it) {
  return it && (it.trust === 'structured' || it.trust === 'untrusted_text') && !NO_SUPPORT_FLAGS.some((f) => _flags(it).includes(f));
}

function _verified(it) {
  const label = SOURCE_LABEL[it.source] || it.source;
  const f = it.field;
  if ((it.source === 'decisiv' && f === 'stage') || (it.source === 'dtna' && f === 'offsiteStage') || (it.source === 'aap_cache' && f === 'offsiteStage')) {
    return { kind: 'stage', description: 'Stage: ' + _tok(it.value) + ' (' + label + ')' };
  }
  if (f === 'repairEtc' && isAuthoritativeEtcTag(it.authorityTag)) return { kind: 'eta', description: 'Repair ETC ' + _tok(it.value) + ' stated (' + _tok(it.authorityTag) + ')' };
  if (f === 'estimateStatus') return { kind: 'estimate', description: 'Estimate status: ' + _tok(it.value) + ' (' + label + ')' };
  if (f === 'partsStatus') return { kind: 'parts', description: 'Parts status: ' + _tok(it.value) + ' (' + label + ')' };
  if (f === 'partsEta') return { kind: 'parts', description: 'Parts ETA ' + _tok(it.value) + ' (' + label + ')' };
  if (f === 'wo') {
    let v = null;
    try { v = typeof it.value === 'string' ? JSON.parse(it.value) : it.value; } catch (_) { v = null; }
    if (!v || !v.id) return null;
    return { kind: 'wo', description: 'WO ' + _tok(v.id) + ' joined the case (' + _tok(v.role || 'secondary') + ')' };
  }
  return null;
}

function buildProposals(input) {
  const i = input || {};
  const rec = i.rec || {};
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  const items = _arr(i.items).filter(Boolean);
  const unit = normUnit(rec.unit_id);
  const episodeKey = rec.episode_key || 'unknown';
  const pub = i.published instanceof Map ? Object.fromEntries(i.published) : (i.published && typeof i.published === 'object' ? i.published : {});
  const hidden = new Set(i.hiddenSigs instanceof Set ? [...i.hiddenSigs] : _arr(i.hiddenSigs));
  const out = [];
  const fps = new Set();

  const push = (eventAt, source, evidenceRef, basis, kind, description) => {
    if (out.length >= PROPOSALS_MAX || !Number.isFinite(eventAt) || !description) return;
    const md = _md(eventAt);
    const sig = TT.entrySig(md + ' - ' + description);
    const pubSigs = pub[md];
    if (hidden.has(sig) || (pubSigs && (pubSigs instanceof Set ? pubSigs.has(sig) : _arr(pubSigs).includes(sig)))) return;
    const eventDate = localDate(eventAt);
    const fingerprint = _sha1([unit, episodeKey, eventDate, source, kind, _normDesc(description)].join('|'));
    if (fps.has(fingerprint)) return;
    fps.add(fingerprint);
    out.push({
      episode_key: episodeKey, event_at: eventAt, event_date: eventDate, discovered_at: now, source, evidence_ref: evidenceRef,
      basis, kind, description, fingerprint, run_id: i.runId || null,
    });
  };

  for (const it of items) {
    if (!_sourceTimed(it)) continue;
    const v = _verified(it);
    if (v) push(it.observedAt, it.source, it.evidenceId, 'verified', v.kind, v.description);
  }
  const comments = items.filter((it) => it.source === 'aap_live' && it.field === 'comments' && Number.isFinite(it.observedAt) && it.observedFrom !== 'retrievedAt');
  if (comments.length) {
    const newest = comments.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
    push(newest.observedAt, 'aap_live', newest.evidenceId, 'verified', 'comment', 'New AAP comment logged');
  }

  const byId = new Map(items.map((it) => [it.evidenceId, it]));
  const out0 = i.output && typeof i.output === 'object' ? i.output : null;
  if (out0 && out0.generatedBy === 'ai') {
    for (const inf of _arr(out0.inferences)) {
      if (!inf || !(Number(inf.confidence) >= INFERRED_MIN_CONF)) continue;
      const cited = _arr(inf.evidenceIds).map((id) => byId.get(id)).filter(Boolean);
      if (!cited.some(_supports)) continue;
      const ats = cited.map((c) => c.observedAt).filter(Number.isFinite);
      if (!ats.length) continue;
      const newest = Math.max(...ats);
      // An inference that also restates AI-written or prior-conclusion text is tagged derived_ai, not as a source event.
      const derived = cited.find((c) => c.trust === 'derived_ai' || c.trust === 'prior_conclusion');
      const ref = cited.find((c) => c.observedAt === newest) || cited[0];
      if (derived) push(newest, 'derived_ai', derived.evidenceId, 'inferred', 'inference', _clean(inf.statement));
      else push(newest, ref.source, ref.evidenceId, 'inferred', 'inference', _clean(inf.statement));
    }
  }
  return out;
}

module.exports = { publishedItems, publishedIndex, buildProposals, LINES_MAX, DIGEST_MAX, PROPOSALS_MAX };
