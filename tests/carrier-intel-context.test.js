// tests/carrier-intel-context.test.js — carrier-intel design B6.1, B6.6, B6.7, B7: context
// assembly, gate context and prompt. AC-17, AC-17b, AC-17g, AC-17i, AC-18 (40-unit SCAC,
// overhead), countBy keys, the EVIDENCE_CLOSE source check, idMap contents, records surviving
// allocate, tiering and the assertFits retry ladder.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const AI = require('../src/dbr/fleet-dbr-ai');
const EV = require('../src/dbr/fleet-dbr-evidence');
const C = require('../src/carrier-intel/context');
const Fx = require('../src/carrier-intel/facts');
const Syn = require('./fixtures/carrier-intel/synthetic-scac.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fleet = load('auvte-scac-rows.json');
const repairHistory = load('auvte-repair-history.json');
const TODAY = '2026-11-17';
const NOW = Date.parse('2026-11-17T18:00:00Z');
const MSG7 = 'When a box truck goes down, how long until a Cox tech actually shows up? The dashboard seems to count from assignment, not arrival. '
  + 'Have you seen Cox move techs off box trucks to trailers or hostlers? Can you name dates or units? The notes don\u2019t show it, and October is the only hint in the data. '
  + 'The CNG trucks keep coming back with misfires and voltage faults that the techs \u201ccould not duplicate.\u201d Do the drivers report a pattern, like cold starts, after fueling or under load? '
  + 'Is box truck uptime low mainly because of repair time, or are there other causes, like units held for damage or the DSP not releasing them?';
const CUES6 = { arrival: true, reassign: true, driver: true, cnd: true, symptom: true, dsp: true, uptime: true };

const auvte = (over = {}) => C.buildContext(Object.assign({
  scac: 'AUVTE', rows: fleet.rows, fleetRows: fleet.rows, stats: { total: 29, down: 7, uptime: 75.9 }, repairHistory,
  today: TODAY, now: NOW, cues: {}, userMsg: 'AUVTE trends and support needed', fd: fleet, fasAlias: '',
}, over));
const syn40 = (over = {}) => {
  const f = Syn.build();
  return C.buildContext(Object.assign({ scac: 'SYNX', rows: f.rows, fleetRows: f.rows, stats: { total: 50, down: 40, uptime: 20 },
    today: TODAY, now: NOW, cues: {}, userMsg: 'SYNX trends', fd: f, fasAlias: '' }, over));
};
const B = auvte();
const recordText = (id) => B.ciText.get(id).split('\n\n')[0];

afterEach(() => { vi.restoreAllMocks(); });

describe('AC-17 assembled context for the AUVTE fixture fleet', () => {
  const downIds = ['B13014', 'B12258', 'B12267', 'B62059', 'B12263', 'B12195', 'B62064'];
  it('every down unit has its fact record, longest-down first, B62064 (days unknown) last', () => {
    expect(B.model.records.map((r) => r.id)).toEqual(downIds);
    for (const id of downIds) {
      const t = B.ciText.get(id);
      expect(t.startsWith('CI FACTS ' + id + ' ')).toBe(true);
      expect(B.prompt).toContain('UNIT ' + id + '\n' + t);
      expect(t).toMatch(/\ncause: /);
      expect(t).toMatch(/\ndown: /);
      expect(t).toMatch(/\nETC \(Path B, counted\): /);
    }
  });
  it('records carry days down, vendor, cause, Path-B ETC, day slips, parts, estimate, PM/DOT and key lines', () => {
    const g1 = B.ciText.get('B12195');
    expect(g1).toContain('cause: parts-hold · owner vendor (COX) · in yard');
    expect(g1).toContain('down: 8.4 d since WR 11/7');
    expect(g1).toContain('ETC (Path B, counted): today 11/17 · set by COX 11/17');
    expect(g1).toContain('ETC history: completion date revised 9× · moved later 5× · moved earlier 1× · same-day re-times 3');
    expect(g1).toContain('parts: no ETA · delay reason PARTS_ON_BACK_ORDER');
    expect(g1).toContain('PM/DOT: AAP shows PM A overdue 306 d');
    expect(B.ciText.get('B12267')).toContain('parts: ordered · parts ETA 11/16 (passed, no arrival recorded)');
    expect(B.ciText.get('B12267')).toContain('$10,977.48');
    expect(B.ciText.get('B12258')).toContain('cause: dealer-offsite · owner dealer (KWNE) · offsite');
    // Key lines are kept when the record body fits CI_RECORD_MAX (the header line is not counted;
    // B6.2 drop order: key lines first). B12195 and B12267 still drop theirs (body + key line > 700).
    for (const id of ['B13014', 'B12258', 'B62059', 'B12263']) expect(B.ciText.get(id)).toMatch(/\nkey line \d{1,2}\/\d{1,2} /);
    expect(B.ciText.get('B12267')).toContain('flags: parts-eta-passed, etc-rolling, vendor-response-lag');
    for (const r of B.model.detailed) {
      if ((r.flags || []).length) expect(Fx.renderRecord(r)).toContain('\nflags: ');
      expect(Fx.renderRecord(r).split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(C.CI_RECORD_MAX);
    }
  });
  it('the roll-up with the cause split is the SCAC block; no raw slip count in any record', () => {
    expect(B.prompt).toContain('SCAC AUVTE\nCI ROLLUP AUVTE\n');
    expect(B.ciText.get('AUVTE')).toMatch(/\ndown-cause split: parts-hold 4 units /);
    for (const r of B.model.detailed) {
      const t = Fx.renderRecord(r);
      expect(t).not.toMatch(/raw slips/i);
      expect(t).not.toMatch(/slipped \d/);
    }
  });
  it('no Active unit without a compliance or theme hit is in the context', () => {
    const gate = new Set(B.ctx.downIds);
    const active = fleet.rows.filter((r) => !B.model.recById.has(r.equipmentId)).map((r) => r.equipmentId);
    const outside = active.filter((id) => !gate.has(id));
    expect(outside.length).toBeGreaterThan(10);
    for (const id of outside) expect(B.prompt).not.toContain(id);
    for (const id of outside) expect(B.ctx.foreign.has(id)).toBe(true);
  });
});

describe('AC-17b one unit, one evidence', () => {
  it('row.units ids are unique; pseudo -> down -> compliance -> theme', () => {
    expect(new Set(B.ctx.downIds).size).toBe(B.ctx.downIds.length);
    expect(B.ctx.downIds).toEqual(['AUVTE', 'B13014', 'B12258', 'B12267', 'B62059', 'B12263', 'B12195', 'B62064',
      'B12268', 'B12259', 'B13127', 'B12343', 'B20038', 'B12271', 'B62053']);
  });
  it('B12195 (down and theme) keeps its record, DBR block and gets the theme line', () => {
    const ev = B.ctx.unitEvidence.B12195;
    expect(ev).toContain('CI FACTS B12195');
    expect(ev).toContain('[B12195] 8.4d down');
    expect(ev).toContain('B12195: theme electrical 11/7–11/16 (7 d with mentions, 1 episode)');
  });
  it('a unit that is both compliance and theme has one evidence holding both lines', () => {
    const rh = Object.assign(clone(repairHistory), { B12259: [{ date: '2026-11-12', summary: 'Driver reports misfire under load on the hill route.' }] });
    const b = auvte({ repairHistory: rh });
    expect(b.ctx.downIds.filter((id) => id === 'B12259').length).toBe(1);
    const t = b.ciText.get('B12259');
    expect(t).toContain('B12259 (Active): DOT due 11/10, expired 7 d');
    expect(t).toContain('B12259: theme misfire 11/12 (1 d with mentions, 1 episode)');
    expect(b.ctx.unitEvidence.B12259).toContain('B12259 (Active): DOT due 11/10');
  });
  it('idMap holds the pseudo, down, compliance and theme ids', () => {
    for (const [k, v] of [['auvte', 'AUVTE'], ['b12195', 'B12195'], ['b62064', 'B62064'], ['b12259', 'B12259'], ['b12271', 'B12271'], ['b62053', 'B62053']]) {
      expect(B.ctx.idMap.get(k)).toBe(v);
    }
  });
});

describe('AC-17g one ETC and one days-down figure per unit', () => {
  it('g1 head reads 8.4d down, no work duration, parsed ETC from the extracted Path-B state', () => {
    const head = B.ciText.get('B12195').split('\n').find((l) => l.startsWith('[B12195]'));
    expect(head).toMatch(/^\[B12195\] 8\.4d down \|/);
    expect(head).not.toContain('work duration:');
    expect(head).toContain('parsed ETC: today 11/17 (from extracted)');
  });
  it('stale _factEtc + timeline "ETC 11/12" -> head reads parsed ETC: none; codeEtc is the Path-B state', () => {
    const rows = clone(fleet.rows);
    const r = rows.find((x) => x.equipmentId === 'B12258');
    r.repairTimeline = '11/10 - KWNE quoted ETC 11/12 for the harness repin.';
    r._factEtc = { state: 'missed', date: '2026-11-12', source: 'timeline' };
    const b = auvte({ rows, fleetRows: rows });
    const rec = b.model.recById.get('B12258');
    expect(rec.etc.state).toBe('none');
    const head = b.ciText.get('B12258').split('\n').find((l) => l.startsWith('[B12258]'));
    expect(head).toContain('parsed ETC: none (from extracted)');
    expect(head).toMatch(/^\[B12258\] 21\.1d down \|/);
    expect(head).not.toContain('work duration:');
    expect(b.ctx.codeEtc.B12258).toEqual({ state: rec.etc.state, date: rec.etc.date, source: 'extracted', snippet: '' });
  });
});

describe('AC-17i prompt text per id', () => {
  it('every ciText entry is a substring of the prompt; typed tokens only in the gate text', () => {
    for (const id of B.ctx.downIds) expect(B.prompt).toContain(B.ciText.get(id));
    const typedIds = Object.keys(B.ctx.typed || {}).filter((id) => String(B.ctx.typed[id].tokenText || '').length > 0);
    expect(typedIds.length).toBeGreaterThan(0);
    for (const id of typedIds) expect(B.ctx.unitEvidence[id].length).toBeGreaterThan(B.ciText.get(id).length);
  });
  it('EVIDENCE_CLOSE matches fleet-dbr-ai.js verbatim; the fence wraps the evidence', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'src', 'dbr', 'fleet-dbr-ai.js'), 'utf8');
    expect(src).toContain("const EVIDENCE_CLOSE = '=== END EVIDENCE ===';");
    expect(C.EVIDENCE_CLOSE).toBe('=== END EVIDENCE ===');
    expect(C.EVIDENCE_OPEN).toBe(AI.EVIDENCE_OPEN);
    expect(B.prompt.endsWith('\n' + C.EVIDENCE_CLOSE)).toBe(true);
    expect(B.prompt).toContain(AI.EVIDENCE_OPEN + '\nSCAC AUVTE\n');
  });
  it('prompt layout and rules 1-10 (rule 9 and 10 verbatim intent)', () => {
    const p = B.prompt;
    const order = ['You are writing Z\'s carrier review for SCAC AUVTE (ROC5), as Z\'s FAS analyst.', 'Z\'S QUESTION: ', 'TODAY: 11/17/2026', 'OUTPUT \u2014 JSON only', 'RULES:', 'KNOWN GAPS (state them as gaps; never fill them with numbers or examples):', AI.EVIDENCE_OPEN];
    const at = order.map((s) => p.indexOf(s));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(C.RULES.length).toBe(10);
    expect(p).toContain('9. In answer, trends, support and fasInput, never write the words FAS, I, we, our, my or me.');
    expect(p).toContain('10. If KNOWN GAPS says FAS-authored comments aren\'t identified (G-FASID)');
    expect(p).toMatch(/KNOWN GAPS[^\n]*\n1\. Your own Relay comments aren't identified/);
  });
});

describe('countBy', () => {
  it('holds every B6.4 key, zero counts included', () => {
    const cb = B.countBy;
    const want = { total: 29, down: 7, 'parts-hold': 4, accident: 1, impound: 1, 'DSP-hold': 0, 'dealer-offsite': 1, repair: 0,
      'owner:vendor': 5, 'owner:DSP': 2, 'vendor:COX': 4, 'vendor:KWNE': 1, 'vendor:DSP-managed (no vendor)': 2,
      'etc:today': 3, 'etc:future': 1, 'etc:missed': 0, 'etc:none': 3, noEta: 3, etaPassed: 1, DOT: 2, PM_B: 2, PM_X: 0, Lift: 0,
      pmaStale: 3, washStale: 0, arrivalN: 4, daysUnknown: 1, 'theme:misfire': 1, 'theme:cold start': 0 };
    for (const [k, v] of Object.entries(want)) expect([k, cb.get(k)]).toEqual([k, v]);
    expect(cb.has('detailed')).toBe(false);
    expect(B.countSet).toEqual(new Set(cb.values()));
  });
});

describe('AC-18 budget, tiering and the 40-unit SCAC', () => {
  const S = syn40();
  it('AUVTE prompt <= 56,000; mode ai; every block untrimmed or lightly trimmed', () => {
    expect(B.prompt.length).toBeLessThanOrEqual(56000);
    expect(B.mode).toBe('ai');
    expect(B.model.blockIds.size).toBe(7);
  });
  it('40 down units: prompt <= 56,000, the 30 longest-down detailed, G-NODETAIL "detail covers 30 of 40"', () => {
    expect(S.prompt.length).toBeLessThanOrEqual(C.CI_PROMPT_MAX);
    expect(S.model.records.length).toBe(40);
    expect(S.model.detailedIds.size).toBe(30);
    const top30 = S.model.records.slice(0, 30).map((r) => r.id);
    expect([...S.model.detailedIds]).toEqual(top30);
    const g = S.gaps.find((x) => x.id === 'G-NODETAIL');
    expect(g.text).toMatch(/detail covers 30 of 40/i);
    expect(S.countBy.get('detailed')).toBe(30);
    expect(S.countBy.get('down')).toBe(40);
    for (const id of top30) expect(S.prompt).toContain('UNIT ' + id + '\nCI FACTS ' + id);
  });
  it('no roll-up line names one of the 10 non-detailed units (they appear only as "+K more")', () => {
    const rest = S.model.records.slice(30).map((r) => r.id);
    expect(rest.length).toBe(10);
    for (const id of rest) expect(S.model.rollupText).not.toContain(id);
    expect(S.model.rollupText).toMatch(/\+\d+ more/);
    for (const id of rest) {
      if (S.ctx.idMap.has(id.toLowerCase())) continue;   // theme units are gate units (B6.1)
      expect(S.ctx.foreign.has(id)).toBe(true);
    }
  });
  it('records survive allocate: every detailed block is trimmed, every record is whole', () => {
    expect(S.model.blockIds.size).toBe(30);
    let trimmed = 0;
    for (const r of S.model.detailed) {
      const t = S.ciText.get(r.id);
      expect(t.startsWith(Fx.renderRecord(r))).toBe(true);
      if (/older lines not shown/.test(t)) trimmed += 1;
    }
    expect(trimmed).toBeGreaterThan(0);
  });
  it('overhead with all six cue gaps, every data gap and a 1,500-char question is <= CI_OVERHEAD_MAX', () => {
    const f = Syn.build();
    const rows = f.rows.map((r) => Object.assign({}, r, { assetType: 'van', bodyType: 'Van' }));
    const rh = {
      B71039: [{ date: '2026-11-10', summary: 'Driver says the unit will not start after fueling at the CNG station and stalls when pulling out of the lot again today.' }],
      B71038: [{ date: '2026-11-11', summary: 'Rough idle after fueling reported by driver; vendor checked injectors and the fuel rail and found leaks near the regulator.' }],
      B71037: [{ date: '2026-11-12', summary: 'Methane detector reset. METHANE SYSTEM IS OK. NO LIGHTS.' }],
    };
    const q = ('AUVTE ' + MSG7).padEnd(1500, ' ');
    expect(q.length).toBe(1500);
    const b = C.buildContext({ scac: 'SYNX', rows, fleetRows: rows, stats: { total: 50, down: 40, uptime: 20 }, repairHistory: rh,
      today: TODAY, now: Date.parse(f.syncedAt) + 6 * 3600 * 1000, cues: CUES6, assetFilter: 'boxTruck', userMsg: q, fd: f, fasAlias: '' });
    const ids = b.gaps.map((g) => g.id);
    for (const id of ['G-ARRIVAL', 'G-REASSIGN', 'G-DRIVER', 'G-CND', 'G-SYMPTOM', 'G-DSPHOLD', 'G-STALE', 'G-FASID', 'G-NOFACTS', 'G-NODETAIL', 'G-FILTER', 'G-PMA']) expect(ids).toContain(id);
    expect(b.gaps.find((g) => g.id === 'G-DRIVER').text).toContain('Free-text mentions: "');
    expect(b.gaps.find((g) => g.id === 'G-CND').text).toContain('The nearest is');
    const overhead = C.overheadOf(b.prompt);
    console.log('[carrier-intel AC-18] prompt overhead with all gaps and a 1,500-char question: ' + overhead + ' chars (max ' + C.CI_OVERHEAD_MAX + '); prompt ' + b.prompt.length);
    expect(overhead).toBeLessThanOrEqual(C.CI_OVERHEAD_MAX);
    expect(b.prompt.length).toBeLessThanOrEqual(C.CI_PROMPT_MAX);
  });
});

describe('assertFits retry ladder', () => {
  it('first prompt too large -> re-allocated once and fits', () => {
    const real = AI.assertFits;
    let calls = 0;
    vi.spyOn(AI, 'assertFits').mockImplementation((p) => { calls += 1; return calls === 1 ? { fits: false, overflow: 8000 } : real(p); });
    const b = syn40();
    expect(calls).toBe(2);
    expect(b.mode).toBe('ai');
    expect(b.prompt.length).toBeLessThanOrEqual(C.CI_PROMPT_MAX);
    expect(b.model.blockIds.size).toBeGreaterThan(0);
  });
  it('still too large -> records only for all units, with the tiered G-NODETAIL wording', () => {
    const real = AI.assertFits;
    let calls = 0;
    vi.spyOn(AI, 'assertFits').mockImplementation((p) => { calls += 1; return calls <= 2 ? { fits: false, overflow: 8000 } : real(p); });
    const b = auvte();
    expect(calls).toBe(3);
    expect(b.mode).toBe('ai');
    expect(b.model.blockIds.size).toBe(0);
    expect(b.ciText.get('B12195')).not.toContain('[B12195]');
    expect(b.gaps.find((g) => g.id === 'G-NODETAIL').text).toBe('Full notes cover the 0 longest-down units of 7; the rest come from extracted facts only.');
    expect(b.countBy.get('fullNotes')).toBe(0);
  });
  it('even records-only does not fit -> mode too-large', () => {
    vi.spyOn(AI, 'assertFits').mockImplementation(() => ({ fits: false, overflow: 100 }));
    const b = auvte();
    expect(b.mode).toBe('too-large');
    expect(b.diag).toContainEqual({ code: 'too-large', level: 'warn' });
  });
  it('a budget under k x MIN_BLOCK gives full notes only to the longest-down units (tiering)', () => {
    // fixed = the records-only prompt (what buildContext measures before allocating).
    let calls = 0;
    const real = AI.assertFits;
    vi.spyOn(AI, 'assertFits').mockImplementation((p) => { calls += 1; return calls <= 2 ? { fits: false, overflow: 1 } : real(p); });
    const fixed = syn40().prompt.length;
    vi.restoreAllMocks();
    const E = Math.min(C.CI_EVIDENCE_MAX, C.CI_PROMPT_MAX - fixed - C.FIT_MARGIN);
    const E2 = 10 * EV.MIN_BLOCK + 100;
    calls = 0;
    vi.spyOn(AI, 'assertFits').mockImplementation((p) => { calls += 1; return calls === 1 ? { fits: false, overflow: E - C.FIT_MARGIN - E2 } : real(p); });
    const b = syn40();
    expect(b.mode).toBe('ai');
    expect([...b.model.blockIds]).toEqual(b.model.records.slice(0, 10).map((r) => r.id));
    const g = b.gaps.find((x) => x.id === 'G-NODETAIL').text;
    expect(g).toContain('Detail covers 30 of 40 down units');
    expect(g).toContain('Full notes cover the 10 longest-down units of 40; the rest come from extracted facts only.');
    const recOnly = b.model.records[20].id;
    expect(b.ciText.get(recOnly)).not.toContain('[' + recOnly + ']');
    expect(b.countBy.get('fullNotes')).toBe(10);
  });
});

describe('failure handling', () => {
  it('buildFactSet throwing -> mirrors, factsFresh false, diag facts-failed, G-NOFACTS names it', () => {
    const W = require('../src/repair-intel/wo-facts');
    const real = W.buildFactSet;
    vi.spyOn(W, 'buildFactSet').mockImplementation((row, o) => { if (row.equipmentId === 'B12263') throw new Error('boom'); return real(row, o); });
    const b = auvte();
    expect(b.diag).toContainEqual({ code: 'facts-failed', level: 'warn', id: 'B12263' });
    expect(b.model.recById.get('B12263').factsFresh).toBe(false);
    expect(b.gaps.find((g) => g.id === 'G-NOFACTS').text).toContain('B12263');
    expect(b.ciText.get('B12263')).toContain('CI FACTS B12263');
  });
  it('buildFleetDbr throwing -> synthesized units, diag builder-failed', async () => {
    const F = require('../src/dbr/fleet-dbr');
    vi.spyOn(F, 'buildFleetDbr').mockImplementation(() => { throw new Error('x'); });
    const b = auvte();
    expect(b.diag).toContainEqual({ code: 'builder-failed', level: 'warn' });
    expect(b.ctx.downIds).toContain('B12195');
    expect(b.ctx.codeEtc.B12195.source).toBe('extracted');
  });
});
