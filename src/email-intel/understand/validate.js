'use strict';
/**
 * email-intel/understand/validate.js — strict validation of v2 AI output (design 3.6; R2.4, R2.5,
 * R3.1, R6.4, R7.1, R7.2, R7.7, AC-0, AC-1).
 *
 *   validateAnalysis(raw, ctx) -> { ok, analysis, counts, errors[] }
 *   ctx: { expectedRef, candidateUnits[], scopeOf(id), priorQuestionIds[], text, receivedAt, now, me, oneToOne }
 *
 * Structural failure (the whole result is rejected; the caller counts an output attempt): not an
 * object, schemaVersion !== 2, messageRef mismatch, or missing / wrongly typed units, questions,
 * answers or classification containers. Everything else is dropped item by item with counters.
 *
 * Key rules: unit ids must be candidates found by the app; out-of-scope units keep no facts;
 * evidence must be an exact (case / whitespace normalized) substring of the text sent; amounts must
 * appear in the text; a unit not inside or near its evidence is `unitAttribution:'weak'`; a
 * confidence that is not a finite JSON number in [0,1] is stored as null with confidenceValid:false
 * (never clamped, never defaulted); every accepted string is screened with findSecret and a hit
 * drops the containing item. Unknown keys (for example "send", "recipients", "approve") are ignored
 * and never stored, so model output cannot add an action, a flag or a recipient.
 */
const C = require('../constants');
const schema = require('./schema');
const { findSecret } = require('../../justme-context/secret-scrub');
const vocab = require('../../scrapers/email_intel');

const L = schema.LIMITS;
const DAY = 86_400_000;
const CTRL = /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g;

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
function clean(s) { return String(s == null ? '' : s).replace(CTRL, ' ').replace(/\s+/g, ' ').trim(); }

function isValidConfidence(c) { return typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1; }
function conf(c) { return isValidConfidence(c) ? { confidence: c, confidenceValid: true } : { confidence: null, confidenceValid: false }; }

/** A cleaned string within [min,max] with no secret, or null. */
function str(v, min, max, counts) {
  if (typeof v !== 'string') return null;
  const s = clean(v);
  if (s.length < (min || 0) || s.length > max) return null;
  if (s && findSecret(s)) { if (counts) counts.dropped.secret++; return null; }
  return s;
}

/** Optional short string: blank (null) when missing/too long; a secret drops the item (returns false). */
function optStr(v, max, counts) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return null;
  const s = clean(v);
  if (findSecret(s)) { counts.dropped.secret++; return false; }
  return s.length > max ? null : s;
}

function validDate(v, base) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return false;
  return t >= base - 60 * DAY && t <= base + 400 * DAY;
}

function numbersIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function _unitOffsets(ntext, unitKey) {
  const out = [];
  const re = new RegExp('(^|[^a-z0-9])' + unitKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'g');
  let m;
  while ((m = re.exec(ntext)) !== null) { out.push(m.index + m[1].length); re.lastIndex = m.index + m[0].length; }
  return out;
}

function _emptyCounts() {
  return {
    units: 0, facts: 0, questions: 0, requests: 0, answers: 0, commitments: 0, otherUnits: 0,
    invalidConfidence: 0, weakAttribution: 0, downgradedAddressee: 0, scopeUnknownUnits: 0,
    dropped: { unknownUnit: 0, outOfScopeFacts: 0, invalidFact: 0, unverifiedEvidence: 0, secret: 0, overCap: 0, invalidQuestion: 0, invalidRequest: 0, invalidAnswer: 0, invalidCommitment: 0, amount: 0 },
  };
}

function _meEvidence(evidence, me) {
  const e = norm(evidence);
  if (!e || !me) return false;
  const terms = [].concat(me.names || [], me.addresses || []).map((x) => norm(x)).filter((x) => x.length >= 2);
  return terms.some((t) => e.includes(t));
}

function _addressee(a, ntext, ctx, counts) {
  const kind = isObj(a) && schema.ADDRESSEE_KINDS.includes(a.kind) ? a.kind : null;
  if (!kind) return null;
  const name = optStr(a.name, L.NAME_MAX, counts);
  const ev = optStr(a.evidence, L.ADDRESSEE_EVIDENCE_MAX, counts);
  if (name === false || ev === false) return false;
  const evOk = !!ev && ntext.includes(norm(ev));
  let k = kind;
  if (k === 'me' && !((evOk && _meEvidence(ev, ctx.me)) || ctx.oneToOne)) { k = 'unclear'; counts.downgradedAddressee++; }
  else if (k === 'named-other' && !evOk) { k = 'unclear'; counts.downgradedAddressee++; }
  return { kind: k, name: name || null, evidence: evOk ? ev : null, basis: k === 'me' ? (evOk && _meEvidence(ev, ctx.me) ? 'named' : 'direct-1to1') : null };
}

function _about(list, cand) {
  return (Array.isArray(list) ? list : []).map((u) => cand.get(norm(u))).filter(Boolean).filter((u, i, a) => a.indexOf(u) === i).slice(0, 10);
}

function validateAnalysis(raw, ctx) {
  ctx = ctx || {};
  const counts = _emptyCounts();
  const errors = [];
  const fail = (e) => { errors.push(e); return { ok: false, analysis: null, counts, errors }; };
  if (!isObj(raw)) return fail('not-object');
  if (raw.schemaVersion !== C.SCHEMA_VERSION) return fail('schema-version');
  if (raw.messageRef !== ctx.expectedRef) return fail('message-ref');
  if (!Array.isArray(raw.units)) return fail('units-container');
  if (!Array.isArray(raw.questions)) return fail('questions-container');
  if (!Array.isArray(raw.answers)) return fail('answers-container');
  if (!isObj(raw.classification)) return fail('classification-container');

  const text = String(ctx.text || '');
  const ntext = norm(text);
  const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const recMs = Date.parse(ctx.receivedAt || '');
  const base = Number.isFinite(recMs) ? recMs : nowMs;
  const scopeOf = typeof ctx.scopeOf === 'function' ? ctx.scopeOf : () => 'unknown';
  const cand = new Map((ctx.candidateUnits || []).map((u) => [norm(u), String(u)]));
  // Phase F (R6.4, design 7.7): extracted text of analyzed attachments is a second evidence source. Only
  // content / content-partial excerpts count; a filename is never text. Amounts must appear in the body or there.
  const attN = new Map();
  for (const a of Array.isArray(ctx.attachments) ? ctx.attachments : []) {
    if (a && Number.isInteger(a.index) && typeof a.text === 'string' && a.text && (a.status === 'content' || a.status === 'content-partial')) attN.set(a.index, norm(a.text));
  }
  if (attN.size) counts.attachmentConflicts = 0;
  const numbers = numbersIn(text);
  for (const a of Array.isArray(ctx.attachments) ? ctx.attachments : []) if (a && attN.has(a.index)) for (const n of numbersIn(a.text)) numbers.push(n);

  // ── units and facts ──
  const units = [];
  const seenUnits = new Map();
  let factTotal = 0;
  for (const u of raw.units) {
    if (!isObj(u) || typeof u.unit !== 'string' || !cand.has(norm(u.unit))) { counts.dropped.unknownUnit++; continue; }
    const id = cand.get(norm(u.unit));
    const scope = scopeOf(id);
    const facts = Array.isArray(u.facts) ? u.facts : [];
    if (scope === 'out') {
      counts.otherUnits++;
      counts.dropped.outOfScopeFacts += facts.length;
      continue;
    }
    let entry = seenUnits.get(id);
    if (!entry) {
      const gist = optStr(u.gist, L.GIST_MAX, counts);
      entry = { unit: id, scope, scopeUnknown: scope === 'unknown', gist: gist || '', facts: [], proposed: 0, dropped: 0 };
      seenUnits.set(id, entry); units.push(entry);
      if (scope === 'unknown') counts.scopeUnknownUnits++;
    }
    const occ = _unitOffsets(ntext, norm(id));
    for (const f of facts) {
      entry.proposed++;
      if (entry.facts.length >= L.FACTS_PER_UNIT || factTotal >= L.FACTS_PER_MESSAGE) { counts.dropped.overCap++; entry.dropped++; continue; }
      if (!isObj(f) || !schema.FACT_KINDS.includes(f.kind) || !schema.STATE_ENUMS[f.kind].includes(f.state) || !schema.ASSERTIONS.includes(f.assertion)) { counts.dropped.invalidFact++; entry.dropped++; continue; }
      const value = str(f.value, 1, L.VALUE_MAX, counts);
      if (!value) { counts.dropped.invalidFact++; entry.dropped++; continue; }
      const evidence = typeof f.evidence === 'string' ? clean(f.evidence) : '';
      // Evidence source: the body, or (Phase F) the attachment the model names / the one that holds the quote.
      let srcN = ntext; let source = 'body';
      if (attN.size && evidence) {
        const nev0 = norm(evidence);
        const m = typeof f.evidenceSource === 'string' ? /^attachment:(\d{1,2})$/.exec(f.evidenceSource) : null;
        if (m && attN.has(Number(m[1])) && attN.get(Number(m[1])).includes(nev0)) { srcN = attN.get(Number(m[1])); source = 'attachment:' + m[1]; }
        else if (!ntext.includes(nev0)) { for (const [i, t] of attN) { if (t.includes(nev0)) { srcN = t; source = 'attachment:' + i; break; } } }
      }
      if (evidence.length < L.EVIDENCE_MIN || evidence.length > L.EVIDENCE_MAX || !srcN.includes(norm(evidence))) { counts.dropped.unverifiedEvidence++; entry.dropped++; continue; }
      if (findSecret(evidence)) { counts.dropped.secret++; entry.dropped++; continue; }
      const item = optStr(f.item, L.ITEM_MAX, counts);
      if (item === false) { entry.dropped++; continue; }
      const fact = { kind: f.kind, item: item || null, value, state: f.state, date: null, dateInvalid: false, amount: null, amountUnverified: false, assertion: f.assertion, evidence, noteConflictHint: f.noteConflictHint === true };
      if (f.date != null && f.date !== '') {
        if (validDate(f.date, base)) fact.date = f.date; else fact.dateInvalid = true;
      }
      if (f.amount != null) {
        const a = f.amount;
        const v = isObj(a) ? a.value : NaN;
        const cur = isObj(a) ? a.currency : undefined;
        const okNum = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= L.AMOUNT_MAX && (cur === 'USD' || cur == null);
        if (okNum && numbers.some((n) => Math.abs(n - v) < 0.005)) fact.amount = { value: v, currency: cur || null };
        else { fact.amountUnverified = true; counts.dropped.amount++; }
        // R6.4 / case M: an unverified amount must not survive inside the value text either.
        if (fact.amountUnverified && numbersIn(value).some((n) => !numbers.some((x) => Math.abs(x - n) < 0.005))) { entry.dropped++; continue; }
      }
      // Unit attribution: id inside the evidence quote, or an occurrence near the evidence position.
      const nev = norm(evidence);
      const at = srcN.indexOf(nev);
      fact.evidenceAt = at;
      if (attN.size) fact.evidenceSource = source;
      const srcOcc = source === 'body' ? occ : _unitOffsets(srcN, norm(id));
      const inside = _unitOffsets(nev, norm(id)).length > 0;
      const near = srcOcc.some((o) => o >= at - C.EVIDENCE_PROXIMITY_CHARS && o <= at + nev.length + C.EVIDENCE_PROXIMITY_CHARS);
      fact.unitAttribution = inside || near ? 'strong' : 'weak';
      if (fact.unitAttribution === 'weak') counts.weakAttribution++;
      Object.assign(fact, conf(f.confidence));
      if (!fact.confidenceValid) counts.invalidConfidence++;
      entry.facts.push(fact);
      factTotal++;
      counts.facts++;
    }
  }
  counts.units = units.length;
  // Phase F: an attachment amount that disagrees with the email's amount for the same unit / kind / item is
  // flagged; reconcile stages it as attachment-conflict (never applied).
  if (attN.size) {
    for (const u of units) {
      for (const f of u.facts) {
        if (!f.amount || !String(f.evidenceSource || '').startsWith('attachment:')) continue;
        const clash = u.facts.some((b) => b !== f && b.evidenceSource === 'body' && b.amount && b.kind === f.kind && norm(b.item || '') === norm(f.item || '') && Math.abs(b.amount.value - f.amount.value) >= 0.005);
        if (clash) { f.attachmentConflict = true; counts.attachmentConflicts++; }
      }
    }
  }

  // ── questions and requests ──
  const items = (list, max, kindName, dropKey) => {
    const out = [];
    for (const q of Array.isArray(list) ? list : []) {
      if (out.length >= max) { counts.dropped.overCap++; continue; }
      if (!isObj(q)) { counts.dropped[dropKey]++; continue; }
      const t = str(q.text, 1, L.QUESTION_MAX, counts);
      const addressee = _addressee(q.addressee, ntext, ctx, counts);
      if (!t || !addressee) { counts.dropped[dropKey]++; continue; }
      const item = {
        ref: typeof q.ref === 'string' ? clean(q.ref).slice(0, 12) : kindName[0] + (out.length + 1), text: t, about: _about(q.about, cand), addressee,
        isApprovalOrDecision: q.isApprovalOrDecision === true,
        decisionKind: q.isApprovalOrDecision === true && schema.DECISION_KINDS.includes(q.decisionKind) ? q.decisionKind : (q.isApprovalOrDecision === true ? 'other' : null),
      };
      if (kindName === 'request') { const due = optStr(q.dueText, L.DUE_TEXT_MAX, counts); if (due === false) { counts.dropped[dropKey]++; continue; } item.dueText = due || null; }
      Object.assign(item, conf(q.confidence));
      if (!item.confidenceValid) counts.invalidConfidence++;
      out.push(item);
    }
    return out;
  };
  const questions = items(raw.questions, L.QUESTIONS, 'question', 'invalidQuestion');
  const requests = items(raw.requests, L.REQUESTS, 'request', 'invalidRequest');
  counts.questions = questions.length; counts.requests = requests.length;

  // ── answers to prior questions ──
  const prior = new Set(ctx.priorQuestionIds || []);
  const answers = [];
  for (const a of raw.answers) {
    if (answers.length >= L.ANSWERS) { counts.dropped.overCap++; continue; }
    const ev = isObj(a) ? str(a.evidence, 1, L.ANSWER_EVIDENCE_MAX, counts) : null;
    if (!isObj(a) || !prior.has(a.pqid) || !ev || !ntext.includes(norm(ev)) || !isValidConfidence(a.confidence)) { counts.dropped.invalidAnswer++; continue; }
    answers.push({ pqid: a.pqid, evidence: ev, confidence: a.confidence, confidenceValid: true });
  }
  counts.answers = answers.length;

  // ── commitments ──
  const commitments = [];
  for (const c of Array.isArray(raw.commitments) ? raw.commitments : []) {
    if (commitments.length >= L.COMMITMENTS) { counts.dropped.overCap++; continue; }
    if (!isObj(c) || !schema.COMMITMENT_BY.includes(c.by)) { counts.dropped.invalidCommitment++; continue; }
    const t = str(c.text, 1, L.COMMITMENT_MAX, counts);
    const who = optStr(c.who, L.NAME_MAX, counts);
    if (!t || who === false) { counts.dropped.invalidCommitment++; continue; }
    const item = { by: c.by, who: who || null, text: t, dueDate: c.dueDate != null && validDate(c.dueDate, base) ? c.dueDate : null };
    Object.assign(item, conf(c.confidence));
    commitments.push(item);
  }
  counts.commitments = commitments.length;

  // ── classification, relevance, delete suggestion, overall ──
  const cl = raw.classification;
  const classification = Object.assign({
    category: vocab.isCategory(cl.category) ? cl.category : 'unknown',
    intent: vocab.isIntent(cl.intent) ? cl.intent : 'none',
    informationalOnly: cl.informationalOnly === true,
  }, conf(cl.confidence));
  const rel = isObj(raw.relevance) ? raw.relevance : {};
  const relReason = optStr(rel.reason, L.REASON_MAX, counts);
  const relevance = Object.assign({ level: schema.RELEVANCE_LEVELS.includes(rel.level) ? rel.level : null, reason: relReason || '' }, conf(rel.confidence));
  const sd = isObj(raw.suggestDelete) ? raw.suggestDelete : {};
  const sdReason = optStr(sd.reason, L.DELETE_REASON_MAX, counts);
  const suggestDelete = Object.assign({ suggested: sd.suggested === true && sdReason !== false, reason: sdReason || '' }, conf(sd.confidence));
  const overallValid = isValidConfidence(raw.overallConfidence);

  return {
    ok: true,
    analysis: {
      schemaVersion: C.SCHEMA_VERSION, relevance, units, questions, requests, answers, commitments, classification, suggestDelete,
      overallConfidence: overallValid ? raw.overallConfidence : null, overallValid,
    },
    counts, errors,
  };
}

module.exports = { validateAnalysis, isValidConfidence, norm, numbersIn, validDate };
