'use strict';
/**
 * repair-intel/wo-summary.js — per-work-order AI 3C summary (Complaint / Cause /
 * Correction) for the History repair timeline. Gated by repairIntel.woSummaries.
 *
 * Hard rules (enforced in code, not just the prompt):
 *   - Every C must be backed by a verbatim quote found in the evidence text,
 *     else it is "Not recorded" (no invented cause).
 *   - 'confirmed' only when the quote sits inside a structured source field
 *     (complaint / vendor cause / vendor correction) or confirmed_root_cause is
 *     set; otherwise 'suspected'.
 *   - Writes ONLY wo_3c / wo_3c_hash (store.setWo3c). Never touches
 *     suspected_root_cause / corrective_actions / confirmed_root_cause.
 *   - Per-WO content-hash cache, bounded worker pool, per-call timeout via
 *     runWithTimeout (no Promise.race around ask). Logs counts/ids only.
 *
 * All side-effecting deps are injected (createWoSummarizer(deps)) so tests need
 * no module mocks; defaultDeps() wires the real relay/store/logger.
 */

const crypto = require('crypto');
const { _parseJson } = require('./analysis');

const WO3C_VERSION = 1;
const NOT_RECORDED = 'Not recorded';
const TEXT_CAP = 300;
const MIN_QUOTE = 8;
const KEYS = ['complaint', 'cause', 'correction'];

function _sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function _str(v) { return v == null ? '' : String(v).trim(); }
function _day(ms) {
  if (!ms) return '';
  try { return new Date(ms).toISOString().slice(0, 10); } catch (_) { return ''; }
}
function _norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function _evidence(e) {
  if (!e || !e.wo_evidence) return null;
  try { const o = JSON.parse(e.wo_evidence); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}

// Structured source fields for one event (complaint / vendor cause / correction).
function _fields(e) {
  const ev = _evidence(e) || {};
  return {
    complaint: _str(e && e.reported_complaint) || _str(ev.complaint),
    cause: _str(ev.cause),
    correction: _str(ev.correction),
    comments: Array.isArray(ev.comments) ? ev.comments : [],
  };
}

// Labeled evidence text built from the stored event row only (+ owned dealer notes).
function buildEvidenceText(event, offsiteNotes) {
  const e = event || {};
  const f = _fields(e);
  const out = [];
  if (f.complaint) out.push('REPORTED COMPLAINT: ' + f.complaint);
  const dates = [];
  if (e.reported_at) dates.push('reported ' + _day(e.reported_at));
  if (e.repair_completed_at) dates.push('completed ' + _day(e.repair_completed_at));
  out.push('STATUS: ' + (_str(e.status) || 'unknown') + (dates.length ? ' (' + dates.join(', ') + ')' : ''));
  if (f.cause) out.push('VENDOR CAUSE FIELD: ' + f.cause);
  if (f.correction) out.push('VENDOR CORRECTION FIELD: ' + f.correction);
  if (f.comments.length) {
    out.push('AAP COMMENTS:');
    for (const c of f.comments) {
      const t = _str(c && c.text);
      if (!t) continue;
      const d = _day(c.at);
      out.push((d || 'date?') + ': ' + t);
    }
  }
  const notes = _str(offsiteNotes);
  if (notes) out.push('DEALER NOTES: ' + notes);
  return out.join('\n');
}

function contentHash(event, offsiteNotes) {
  const e = event || {};
  return _sha1(JSON.stringify([
    WO3C_VERSION, e.reported_complaint == null ? null : e.reported_complaint, e.status == null ? null : e.status,
    e.repair_completed_at == null ? null : e.repair_completed_at, e.confirmed_root_cause == null ? null : e.confirmed_root_cause,
    e.wo_evidence == null ? null : e.wo_evidence, offsiteNotes ? _sha1(offsiteNotes) : '',
  ]));
}

function buildPrompt(event, evidenceText) {
  return [
    'You are a fleet maintenance writer producing the 3C summary (Complaint, Cause, Correction) of ONE work order.',
    'Complaint = the defect originally reported. Cause = what the technician found as the root cause. Correction = the work done to fix it.',
    'Write one or two plain sentences for each C, using ONLY the EVIDENCE below.',
    '',
    'EVIDENCE:',
    evidenceText,
    '',
    'RULES (strict):',
    '1. Use ONLY the evidence. For each C also return a "quote" copied VERBATIM from the evidence that supports it.',
    '2. If a C is not stated in the evidence, return an empty "text" and an empty "quote" for it.',
    '3. Never invent parts, part numbers, costs, dates, people, or a cause. Do not guess.',
    '4. Do not include any person or company contact names.',
    '',
    'Return ONLY JSON of this exact shape:',
    '{"complaint":{"text":"","quote":""},"cause":{"text":"","quote":""},"correction":{"text":"","quote":""}}',
  ].join('\n');
}

// Enforce the anti-fabrication rules on a parsed model response.
function validate3c(parsed, ctx) {
  const c = ctx || {};
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const ev = _norm(c.evidenceText);
  const fields = { complaint: c.complaintField, cause: c.causeField, correction: c.correctionField };
  const out = { v: WO3C_VERSION };
  for (const k of KEYS) {
    if (k === 'cause' && _str(c.confirmedRootCause)) {
      out.cause = { text: _str(c.confirmedRootCause).slice(0, TEXT_CAP), status: 'confirmed' };
      continue;
    }
    const item = p[k] && typeof p[k] === 'object' ? p[k] : {};
    const text = _str(item.text);
    const quote = _str(item.quote);
    const nq = _norm(quote);
    if (!text || !quote || quote.length < MIN_QUOTE || !ev.includes(nq)) {
      out[k] = { text: NOT_RECORDED, status: 'not_recorded' };
      continue;
    }
    const nf = _norm(fields[k]);
    out[k] = { text: text.slice(0, TEXT_CAP), status: nf && nf.includes(nq) ? 'confirmed' : 'suspected' };
  }
  out.basis = c.basis || 'aap';
  out.ai = true;
  out.at = typeof c.now === 'function' ? c.now() : Date.now();
  out.model = c.model == null ? null : c.model;
  return out;
}

const _silent = { info() {}, warn() {}, error() {} };

function createWoSummarizer(deps) {
  const d = deps || {};
  const ask = d.ask;
  const runWithTimeout = d.runWithTimeout;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const concurrency = Math.max(1, d.concurrency || 2);
  const timeoutMs = d.timeoutMs || 55000;
  const maxPerRun = d.maxPerRun || 40;
  const store = d.store;
  const logger = d.logger || _silent;
  const getModel = typeof d.getModel === 'function' ? d.getModel : () => null;

  function _save(sid, obj, hash) {
    try { if (store && typeof store.setWo3c === 'function') store.setWo3c(sid, obj, hash); } catch (_) {}
  }
  function _model() { try { const m = getModel(); return m == null ? null : m; } catch (_) { return null; } }
  const _nr = () => ({ text: NOT_RECORDED, status: 'not_recorded' });

  async function summarize(events, opts) {
    const o = opts || {};
    const force = !!o.force;
    const source = o.priority === 'normal' ? 'repair_intel_unit' : 'repair_intel_analysis';
    const results = {};
    const counts = { cached: 0, fresh: 0, structured: 0, no_evidence: 0, timeout: 0, error: 0 };
    const queue = [];
    let unit = '';
    const set = (sid, status, threeC) => {
      results[sid] = threeC ? { status, threeC } : { status };
      counts[status]++;
    };

    for (const e of (Array.isArray(events) ? events : [])) {
      if (!e || !e.source_id) continue;
      const sid = String(e.source_id);
      if (!unit && e.equipment_id) unit = String(e.equipment_id);
      try {
        let notes = '';
        try { notes = typeof o.offsiteFor === 'function' ? _str(o.offsiteFor(e)) : ''; } catch (_) { notes = ''; }
        const hash = contentHash(e, notes);
        if (!force && e.wo_3c && e.wo_3c_hash === hash) {
          let cached = null; try { cached = JSON.parse(e.wo_3c); } catch (_) {}
          if (cached) { set(sid, 'cached', cached); continue; }
        }
        const f = _fields(e);
        const crc = _str(e.confirmed_root_cause);
        const basis = notes ? 'aap+offsite' : 'aap';
        if (!f.complaint && !f.cause && !f.correction && !f.comments.length && !notes) {
          const obj = { v: WO3C_VERSION, complaint: _nr(),
            cause: crc ? { text: crc.slice(0, TEXT_CAP), status: 'confirmed' } : _nr(),
            correction: _nr(), basis, ai: false, at: now(), model: null };
          _save(sid, obj, hash); set(sid, 'no_evidence', obj); continue;
        }
        if (f.complaint && (crc || f.cause) && f.correction) {
          const ok = (t) => ({ text: t.slice(0, TEXT_CAP), status: 'confirmed' });
          const obj = { v: WO3C_VERSION, complaint: ok(f.complaint), cause: ok(crc || f.cause),
            correction: ok(f.correction), basis, ai: false, at: now(), model: null };
          _save(sid, obj, hash); set(sid, 'structured', obj); continue;
        }
        queue.push({ e, sid, hash, notes, f, crc, basis });
      } catch (_) { set(sid, 'error'); }
    }

    const work = queue.slice(0, maxPerRun);
    let next = 0;
    async function runOne(item) {
      try {
        if (typeof ask !== 'function' || typeof runWithTimeout !== 'function') { set(item.sid, 'error'); return; }
        const evidenceText = buildEvidenceText(item.e, item.notes);
        const prompt = buildPrompt(item.e, evidenceText);
        const raw = await runWithTimeout((sig) => ask(prompt, { signal: sig, source }), { timeoutMs, timeoutResult: null, source });
        if (raw == null) { set(item.sid, 'timeout'); return; }
        const parsed = _parseJson(typeof raw === 'string' ? raw : String((raw && raw.text) || ''));
        if (!parsed || typeof parsed !== 'object') { set(item.sid, 'error'); return; }
        const obj = validate3c(parsed, {
          evidenceText, complaintField: item.f.complaint, causeField: item.f.cause, correctionField: item.f.correction,
          confirmedRootCause: item.crc, basis: item.basis, now, model: _model(),
        });
        _save(item.sid, obj, item.hash);
        set(item.sid, 'fresh', obj);
      } catch (_) { set(item.sid, 'error'); }
    }
    async function worker() {
      while (next < work.length) { const item = work[next++]; await runOne(item); }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, work.length); i++) workers.push(worker());
    for (const w of workers) await w;

    try {
      logger.info('[' + (unit || '?') + '] wo-3c: cached ' + counts.cached + ', fresh ' + counts.fresh +
        ', structured ' + counts.structured + ', no_evidence ' + counts.no_evidence +
        ', timeout ' + counts.timeout + ', error ' + counts.error);
    } catch (_) {}
    return { results, counts };
  }

  return { summarize };
}

function defaultDeps() {
  let logger = _silent;
  try { logger = require('../utils/logger')('repair-intel'); } catch (_) {}
  let relay = null;
  const getRelay = () => { if (!relay) relay = require('../orcha/relay'); return relay; };
  return {
    ask: (p, o) => getRelay().ask(p, o),
    runWithTimeout: (run, o) => getRelay().runWithTimeout(run, o),
    getModel: () => { const r = getRelay(); return r.getStatus ? r.getStatus().model : null; },
    store: require('./store'),
    logger,
  };
}

module.exports = {
  WO3C_VERSION, NOT_RECORDED, buildEvidenceText, contentHash, buildPrompt, validate3c, createWoSummarizer, defaultDeps,
};
