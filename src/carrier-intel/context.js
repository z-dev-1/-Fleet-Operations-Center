'use strict';
/**
 * carrier-intel/context.js — evidence composition, gate context and prompt (design B6.1,
 * B6.6, B6.7, B7.1–B7.3).
 *
 * buildContext(args) -> { model, ctx, ciText, countBy, countSet, evidences, prompt, gaps, mode, diag }.
 * One fact set per down unit (the same call fleet-dbr-ai._typedIndexes makes), one gate unit
 * and one evidence per id (pseudo -> down -> compliance -> theme), records composed after
 * EV.allocate so they are never trimmed, and a tiered budget with the assertFits retry
 * ladder. Pure: no I/O, no logging; failures are returned as diag entries.
 */

const F = require('../dbr/fleet-dbr');
const EV = require('../dbr/fleet-dbr-evidence');
const G = require('../dbr/fleet-dbr-gate');
const AI = require('../dbr/fleet-dbr-ai');
const W = require('../repair-intel/wo-facts');
const O = require('../repair-intel/wo-fact-output');
const T = require('./taxonomy');
const Fx = require('./facts');
const Th = require('./themes');
const Gp = require('./gaps');

const CI_PROMPT_MAX = AI.CALL_PROMPT_MAX;
const CI_EVIDENCE_MAX = EV.EVIDENCE_BUDGET;
const CI_OVERHEAD_MAX = 9000;
const CI_RECORD_MAX = Fx.CI_RECORD_MAX;
const CI_ROLLUP_MAX = Fx.CI_ROLLUP_MAX;
const CI_THEMES_MAX = Th.CI_THEMES_MAX;
const CI_OTHER_UNIT_MAX = 200;
const CI_MAX_DETAILED = 30;
const CI_QUESTION_MAX = 1500;
const FIT_MARGIN = 500;
const EVIDENCE_OPEN = AI.EVIDENCE_OPEN;
// fleet-dbr-ai does not export its EVIDENCE_CLOSE; tests/carrier-intel-context.test.js checks
// this copy against the source text so drift fails.
const EVIDENCE_CLOSE = '=== END EVIDENCE ===';
const TZ = 'America/New_York';
const LEAD_MD_RE = /^\s*(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\s*-?\s*/;
const BOX_RE = /box\s*truck/i;

const SECTION_CAPS = Object.freeze({ answer: 3, trends: 5, actions: 6, support: 5, fasInput: 4 });

const CONTRACT = [
  '{"answer":[{"text":"...","units":["B12195"]}],"trends":[{"text":"...","units":[]}],'
    + '"actions":[{"text":"...","units":["B13014"],"src":{"fas":[{"date":"M/D","quote":"verbatim words from a [FAS] line"}]}}],'
    + '"support":[{"text":"...","units":["B13014"],"team":"Accidents/insurance"}],"fasInput":[{"text":"...","units":[]}]}',
  'Item counts: answer <= ' + SECTION_CAPS.answer + ', trends <= ' + SECTION_CAPS.trends + ', actions <= ' + SECTION_CAPS.actions
    + ', support <= ' + SECTION_CAPS.support + ', fasInput <= ' + SECTION_CAPS.fasInput + '.',
  'Each item: "text" 1-300 chars; "units" <= 12 unit ids, the units the text is about; "src" optional, only for a FAS action (actions); "team" optional, one of: ' + G.SUPPORT_TEAMS.join(', ') + '.',
  'answer: a direct 1-3 sentence answer to Z\'s question.',
  'trends: patterns across units, such as the cause split, ETC rolling, parts with no ETA, arrival times and recurring symptoms.',
  'actions: what FAS has done or is doing, plus vendor work in progress. A FAS-action claim needs src.fas.',
  'support: who must act, phrased as the ask ("Carrier/DSP: pay the impound fee for B62064").',
  'fasInput: the analyst read for the carrier review: what drives the down-days and what to push, written as statements about named parties or as imperatives ("Push COX for a parts ETA on B12195"), never in the first person.',
].join('\n');

const RULES = Object.freeze([
  '1. Use only the EVIDENCE. Cite unit ids, dates, $, case/RO numbers, counts, hours and dealer names exactly as they appear there. List in "units" every unit the text names.',
  '2. Use the down cause from "cause:" lines and the roll-up. Never call a unit an accident or damage from lifecycleReason alone.',
  '3. For ETC counts, use only the "ETC history" line of a CI FACTS record or the roll-up, and phrase them as "<vendor> moved the ETC date later N times" (or "earlier N times", "re-timed the same day N times", "revised N times"). The "slipped N×" figure in a unit\'s verified-facts lines counts timestamp edits, not date moves, and timeline narrative counts are AI summaries; cite neither. The ETC state is the "ETC (Path B, counted)" line; never call an ETC missed unless that line says missed. Timeline lines are AI summaries: for dates, ETAs, counts and amounts use CI FACTS, [FAS] lines, conversation lines or verified facts, and do not cite a date that appears only in the timeline.',
  '4. Write fractions as "4 of 7", never "4/7" (a slash reads as a date). Take every unit count from the roll-up. Write dates as M/D. Copy days and hours exactly as the records print them ("8.5 days", "34.3 h"); do not round or convert them.',
  '5. A FAS action ("FAS called/emailed/escalated ...") needs a src.fas quote copied from a [FAS] line on that date. Otherwise describe the status without claiming a FAS action.',
  '6. For anything in KNOWN GAPS, say it is not in the data. Do not estimate, extrapolate or give examples.',
  '7. No recommendations to send, flip, create, approve or comment. Support items are asks for other teams, not actions you take.',
  '8. JSON only.',
  '9. In answer, trends, support and fasInput, never write the words FAS, I, we, our, my or me. Name the party (COX, the DSP, the dealer) or write an imperative ("Push COX for a parts ETA on B12195"). Only actions items may describe what FAS did, and each needs src.fas.',
  '10. If KNOWN GAPS says FAS-authored comments aren\'t identified (G-FASID), never write that no FAS action was taken or logged.',
]);

function _s(v) { return v == null ? '' : String(v); }
function _plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function _clipQ(s) { const t = _s(s).replace(/\s+/g, ' ').trim(); return t.length > CI_QUESTION_MAX ? t.slice(0, CI_QUESTION_MAX) : t; }
function _clipLine(s, max) { return s.length > max ? s.slice(0, max) : s; }
function _mdy(today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_s(today));
  return m ? (+m[2]) + '/' + (+m[3]) + '/' + m[1] : _s(today);
}
function _isBox(r) { return r.assetType === 'boxTruck' || BOX_RE.test(_s(r.bodyType)); }

/**
 * buildPrompt({ scac, domiciles, userMsg, today, gaps, evidence:[{ head, text }] }) -> string (B7.1).
 * `gaps` are strings or { text } objects, numbered in order.
 */
function buildPrompt(args = {}) {
  const scac = _s(args.scac);
  const doms = Array.isArray(args.domiciles) ? args.domiciles.filter(Boolean).join(', ') : _s(args.domiciles);
  const gaps = (Array.isArray(args.gaps) ? args.gaps : []).map((g) => (g && typeof g === 'object' ? _s(g.text) : _s(g))).filter(Boolean);
  const ev = Array.isArray(args.evidence) ? args.evidence : [];
  const L = [
    'You are writing Z\'s carrier review for SCAC ' + scac + (doms ? ' (' + doms + ')' : '') + ', as Z\'s FAS analyst. Read-only: you answer a question; you never take or propose actions.',
    'Z\'S QUESTION: ' + _clipQ(args.userMsg),
    'TODAY: ' + _mdy(args.today),
    'OUTPUT \u2014 JSON only, no prose outside it:\n' + CONTRACT,
    'RULES:\n' + RULES.join('\n'),
    'KNOWN GAPS (state them as gaps; never fill them with numbers or examples):' + (gaps.length ? '\n' + gaps.map((g, i) => (i + 1) + '. ' + g).join('\n') : ' none'),
    EVIDENCE_OPEN + '\n' + ev.map((b) => _s(b.head) + '\n' + _s(b.text)).join('\n\n') + '\n' + EVIDENCE_CLOSE,
  ];
  return L.join('\n');
}

/** Prompt overhead: everything outside the EVIDENCE fence (B6.6). */
function overheadOf(prompt) {
  const p = _s(prompt);
  const a = p.indexOf(EVIDENCE_OPEN);
  const b = p.lastIndexOf(EVIDENCE_CLOSE);
  if (a < 0 || b < 0) return p.length;
  return a + (p.length - (b + EVIDENCE_CLOSE.length));
}

// compose(recordEv, block) (B6.7): the record first, never trimmed; the block's FAS index.
function compose(recordEv, block) {
  return {
    id: recordEv.id,
    segments: [...recordEv.segments, ...block.segments],
    lines: [...recordEv.lines, ...block.lines],
    fasLines: block.fasLines,
    fasDates: block.fasDates,
    demand: block.demand,
    rawDemand: block.rawDemand,
    text: () => recordEv.text() + '\n' + block.text(),
  };
}

function _synthUnit(raw, rec) {
  return {
    id: rec.id, daysDown: rec.daysDown, lifecycleReason: _s(raw.lifecycleReason).trim(), vendor: _s(raw.vendor).trim(),
    status: _s(raw.savedRepairStatus).trim(), serviceState: _s(raw.serviceState).trim(),
    etc: { state: 'none', date: null, source: null, snippet: '' }, barriers: [], categories: [],
  };
}

function _byDays(a, b) {
  const x = a.rec.daysDown;
  const y = b.rec.daysDown;
  if (x == null && y != null) return 1;
  if (y == null && x != null) return -1;
  if (x != null && y != null && x !== y) return y - x;
  return a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0;
}

function _fasLog(ev) {
  const seg = (ev && Array.isArray(ev.segments) ? ev.segments : []).find((s) => s.kind === 'fasLog');
  if (!seg) return [];
  return seg.lines.map((l) => {
    const raw = _s(l.text).slice(l.bodyAt || 0);
    const lead = LEAD_MD_RE.exec(raw);
    const md = l.entryMd || (lead ? (+lead[1]) + '/' + (+lead[2]) : '');
    return { md, body: raw.replace(LEAD_MD_RE, '').trim() };
  }).filter((x) => x.md && x.body);
}

/**
 * buildContext({ scac, rows, fleetRows, stats, enrich, fasNames, fasAlias, repairHistory, today,
 *   now, cues, assetFilter, userMsg, fd }) -> see the file header.
 * `rows` are fleet rows (filtered here to the SCAC); `fleetRows` every fleet row (foreign ids);
 * `fd` the fleetData object (only `syncedAt` is read).
 */
function buildContext(args = {}) {
  const diag = [];
  const scac = T.normKey(args.scac);
  const today = _s(args.today);
  const enrich = _plain(args.enrich);
  const fasNames = Array.isArray(args.fasNames) ? args.fasNames : [];
  const fasAlias = typeof args.fasAlias === 'string' ? args.fasAlias : '';
  const cues = _plain(args.cues);
  const fd = _plain(args.fd);

  let scacRows = (Array.isArray(args.rows) ? args.rows : []).filter((r) => r && typeof r === 'object' && T.normKey(r.operator) === scac);
  let filterFallback = false;
  let boxTrucks = false;
  if (args.assetFilter === 'boxTruck') {
    const box = scacRows.filter(_isBox);
    if (box.length) { scacRows = box; boxTrucks = true; } else filterFallback = true;
  }
  const domiciles = [...new Set(scacRows.map((r) => T.normKey(r.domicileSite || r.domicile)).filter(Boolean))].sort();
  const downRaws = scacRows.filter((r) => F.isDown(r));
  const st = _plain(args.stats);
  const total = Number.isFinite(st.total) ? st.total : scacRows.length;
  const stats = {
    total,
    down: Number.isFinite(st.down) ? st.down : downRaws.length,
    uptime: st.uptime != null && Number.isFinite(Number(st.uptime)) ? Number(st.uptime)
      : (total ? Math.round(((total - downRaws.length) / total) * 1000) / 10 : null),
  };

  // Builder units (B6.1): id, daysDown, vendor, lifecycleReason, status, barriers, etc.
  const builder = new Map();
  try {
    const b = F.buildFleetDbr(scacRows, { today });
    for (const row of b.rows || []) for (const u of row.units || []) if (!builder.has(u.id)) builder.set(u.id, u);
  } catch (_) { diag.push({ code: 'builder-failed', level: 'warn' }); }

  // One fact set per down unit (B6.7).
  const down = downRaws.map((raw) => {
    const id = _s(raw.equipmentId).trim();
    const en = _plain(enrich[id]);
    let fs = null;
    try { fs = W.buildFactSet(raw, { today, notesFacts: EV.userNotesFacts(en) }); } catch (_) { fs = null; diag.push({ code: 'facts-failed', level: 'warn', id }); }
    const rec = Fx.unitRecord(raw, builder.get(id) || {}, fs, today, TZ, { enrichRec: en, fasNames, fasAlias });
    return { id: rec.id, raw, fs, rec, en };
  }).sort(_byDays);
  const records = down.map((d) => d.rec);
  const detailed = down.slice(0, CI_MAX_DETAILED);
  const detailedIds = new Set(detailed.map((d) => d.id));

  let comp = { units: [], lines: {}, counts: {}, text: '' };
  try { comp = Fx.compliance(scacRows, today, F.isDown); } catch (_) { diag.push({ code: 'compliance-failed', level: 'warn' }); }
  const emptyThemes = { text: '', units: [], unitLines: {}, hits: {}, episodes: {} };
  let themes = emptyThemes;
  try { themes = Th.symptomThemes(scacRows, _plain(args.repairHistory), today); } catch (_) { themes = emptyThemes; diag.push({ code: 'themes-failed', level: 'warn' }); }
  const roll = Fx.rollup({ scac, records, stats: { total: stats.total, uptime: stats.uptime }, asOf: fd.syncedAt, tz: TZ,
    compliance: comp, themes, detailedIds });
  const countBy = roll.countBy;
  const wm = /\(last recorded (\d{1,2}\/\d{1,2}\/\d{4})\)/.exec(_s(comp.text));
  const pseudoText = roll.text + (themes.text ? '\n' + themes.text : '');
  const pseudoEv = EV.textEvidence(scac, pseudoText, today);

  // Gate units, de-duplicated, precedence pseudo -> down -> compliance -> theme (B6.7).
  const themeLines = (id) => (themes.unitLines && themes.unitLines[id]) || [];
  const recEvs = detailed.map((d) => {
    const tl = themeLines(d.id);
    return EV.textEvidence(d.id, Fx.renderRecord(d.rec) + (tl.length ? '\n' + tl.join('\n') : ''), today);
  });
  const units = detailed.map((d) => {
    const base = builder.get(d.id) || _synthUnit(d.raw, d.rec);
    return Object.assign({}, base, {
      id: d.id,
      daysDown: d.rec.daysDown,
      etc: { state: d.rec.etc.state, date: d.rec.etc.date, source: 'extracted', snippet: '' },
    });
  });
  const blocks = detailed.map((d, i) => {
    try {
      const rawForEv = Object.assign({}, d.raw, { workDuration: '' });
      return EV.buildUnitEvidence(rawForEv, units[i], d.en, today, fasNames, fasAlias);
    } catch (_) { diag.push({ code: 'evidence-failed', level: 'warn', id: d.id }); return null; }
  });
  const gateIds = new Set([scac.toUpperCase(), ...detailed.map((d) => d.id.toUpperCase())]);
  const others = [];
  const addOther = (id, lines) => {
    const key = _s(id).toUpperCase();
    if (!key || gateIds.has(key)) return;
    gateIds.add(key);
    others.push({ id, lines });
  };
  for (const u of comp.units || []) addOther(u.id, [comp.lines[u.id]].filter(Boolean).concat(themeLines(u.id)));
  for (const id of themes.units || []) addOther(id, themeLines(id));
  const otherEvs = others.map((o) => EV.textEvidence(o.id, o.lines.map((l) => _clipLine(_s(l), CI_OTHER_UNIT_MAX)).join('\n'), today));
  const otherUnits = others.map((o) => ({ id: o.id, status: 'Active' }));

  const noFactsIds = down.filter((d) => !d.fs || d.raw._factsOn !== true).map((d) => d.id);
  const base = {
    scac, domiciles, today, now: args.now, stats, boxTrucks, filterFallback, records, detailed: detailed.map((d) => d.rec),
    detailedIds, recById: new Map(records.map((r) => [r.id, r])), countBy, rollupText: roll.text, themes, compliance: comp,
    washLast: wm ? wm[1] : null, cues, fasAlias, fasNames, noFactsIds, asOf: fd.syncedAt || null, userMsg: _s(args.userMsg),
  };

  const heads = ['SCAC ' + scac].concat(detailed.map((d) => 'UNIT ' + d.id), others.map((o) => 'UNIT ' + o.id));
  const assemble = (alloc) => {
    const blockIds = new Set(detailed.filter((d, i) => alloc[i]).map((d) => d.id));
    const model = Object.assign({}, base, { blockIds });
    const g = Gp.selectGaps({ cues, model, stats, fd, now: args.now });
    const evs = [pseudoEv].concat(detailed.map((d, i) => (alloc[i] ? compose(recEvs[i], alloc[i]) : recEvs[i])), otherEvs);
    const prompt = buildPrompt({ scac, domiciles, userMsg: args.userMsg, today, gaps: g.gaps,
      evidence: evs.map((e, i) => ({ head: heads[i], text: e.text() })) });
    return { alloc, blockIds, model, gaps: g.gaps, gapDiag: g.diag, evs, prompt };
  };
  // Water-fill the available blocks to E; below k x MIN_BLOCK only the longest-down get blocks (B6.6 step 4).
  const fitBlocks = (E) => {
    const avail = blocks.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    const take = E >= avail.length * EV.MIN_BLOCK ? avail : avail.slice(0, Math.max(0, Math.floor(E / EV.MIN_BLOCK)));
    const out = blocks.map(() => null);
    if (!take.length) return out;
    const got = EV.allocate(take.map((i) => blocks[i]), Math.max(E, take.length * EV.MIN_BLOCK));
    take.forEach((i, k) => { out[i] = got[k]; });
    return out;
  };

  const none = blocks.map(() => null);
  const bare = assemble(none);
  const fixed = bare.prompt.length;
  const E = Math.min(CI_EVIDENCE_MAX, CI_PROMPT_MAX - fixed - FIT_MARGIN);
  let mode = 'ai';
  let r = assemble(fitBlocks(E));
  let fit = AI.assertFits(r.prompt);
  if (!fit.fits) {
    r = assemble(fitBlocks(E - fit.overflow - FIT_MARGIN));
    fit = AI.assertFits(r.prompt);
    if (!fit.fits) {
      r = bare;
      fit = AI.assertFits(r.prompt);
      if (!fit.fits) { mode = 'too-large'; diag.push({ code: 'too-large', level: 'warn' }); }
    }
  }
  if (r.blockIds.size < detailedIds.size) countBy.set('fullNotes', r.blockIds.size);
  diag.push(...r.gapDiag);

  // Gate context (B6.7).
  const gateUnits = [{ id: scac }].concat(units, otherUnits);
  const typed = {};
  detailed.forEach((d) => {
    if (!d.raw._factsOn || !d.fs) return;
    try { typed[d.id] = W.typedIndex(d.fs, { today, rowDates: O.rowDates(d.raw) }); } catch (_) { diag.push({ code: 'typed-failed', level: 'debug', id: d.id }); }
  });
  const fleetIds = (Array.isArray(args.fleetRows) ? args.fleetRows : (Array.isArray(args.rows) ? args.rows : []))
    .map((x) => _s(x && x.equipmentId).trim()).filter((id) => id && !gateIds.has(id.toUpperCase()));
  const ctx = G.gateContext({ row: { units: gateUnits }, evidences: r.evs, fleetIds, today, unitRows: detailed.map((d) => d.raw),
    typed: Object.keys(typed).length ? typed : undefined });
  const ciText = new Map();
  gateUnits.forEach((u, i) => ciText.set(ctx.downIds[i], r.evs[i].text()));
  const fasLogs = new Map();
  detailed.forEach((d, i) => { if (r.alloc[i]) fasLogs.set(d.id, _fasLog(r.alloc[i])); });

  const model = Object.assign(r.model, { gaps: r.gaps, mode, fasLogs, idMap: ctx.idMap, gateIds: ctx.downIds.slice() });
  return { model, ctx, ciText, countBy, countSet: new Set(countBy.values()), evidences: r.evs, prompt: r.prompt, gaps: r.gaps, mode, diag };
}

module.exports = {
  buildContext, buildPrompt, overheadOf, compose, RULES, CONTRACT, SECTION_CAPS,
  CI_PROMPT_MAX, CI_EVIDENCE_MAX, CI_OVERHEAD_MAX, CI_RECORD_MAX, CI_ROLLUP_MAX, CI_THEMES_MAX, CI_OTHER_UNIT_MAX,
  CI_MAX_DETAILED, CI_QUESTION_MAX, FIT_MARGIN, EVIDENCE_OPEN, EVIDENCE_CLOSE,
};
