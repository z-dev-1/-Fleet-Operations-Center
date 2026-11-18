// tests/carrier-intel-answer.test.js — carrier-intel design B8.1–B8.3, B10: parse, grounding
// gate, mechanical fallback and render. AC-19, AC-19b (render half), AC-20, AC-20b–e, AC-21,
// AC-21b–e, AC-22, AC-22b, AC-25, AC-25b, AC-32, mechanical lines on the AUVTE and 40-unit
// contexts, mechanical envelopes, the "Called COX … and emailed DSP" clause case, render order
// and the 3,500 cap.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const G = require('../src/dbr/fleet-dbr-gate');
const C = require('../src/carrier-intel/context');
const A = require('../src/carrier-intel/answer');
const Gp = require('../src/carrier-intel/gaps');
const Syn = require('./fixtures/carrier-intel/synthetic-scac.cjs');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fleet = load('auvte-scac-rows.json');
const repairHistory = load('auvte-repair-history.json');
const TODAY = '2026-11-17';
const NOW = Date.parse('2026-11-17T18:00:00Z');
const FAS_NOTE = '11/10 - Called COX for update and emailed DSP re release; left VM';
const ENRICH = { B12195: { manualEntries: [FAS_NOTE] } };
const ALL_CUES = { arrival: true, reassign: true, driver: true, cnd: true, symptom: true, dsp: true, uptime: true };

const auvte = (over = {}) => C.buildContext(Object.assign({
  scac: 'AUVTE', rows: fleet.rows, fleetRows: fleet.rows, stats: { total: 29, down: 7, uptime: 75.9 }, repairHistory,
  today: TODAY, now: NOW, cues: {}, userMsg: 'AUVTE trends and support needed', fd: fleet, fasAlias: '', enrich: ENRICH,
}, over));
const syn40 = () => {
  const f = Syn.build();
  return C.buildContext({ scac: 'SYNX', rows: f.rows, fleetRows: f.rows, stats: { total: 50, down: 40, uptime: 20 },
    today: TODAY, now: NOW, cues: { arrival: true, symptom: true }, userMsg: 'SYNX trends', fd: f, fasAlias: '' });
};
const B = auvte();
const chk = (text, units = [], section = 'trends', b = B) => A.checkItem({ text, units }, section, b);
const rec = (id, b = B) => b.model.recById.get(id);

afterEach(() => { vi.restoreAllMocks(); });

// A well-formed reply written in imperatives and named parties (AC-19, AC-22b).
const GOOD = {
  answer: [{ text: 'COX holds 4 of 7 down units, all parts-holds; parts-holds are 37% of the down-days.', units: [] }],
  trends: [
    { text: 'COX moved ETC dates later 5×, 9×, 11× and 9× (B12195, B12263, B12267, B62059).', units: ['B12195', 'B12263', 'B12267', 'B62059'] },
    { text: 'Tech arrival from vendor assignment: median 6.2 h, range 3.8 h to 34.3 h (n = 4).', units: [] },
    { text: 'B12271 came back 2 times for misfire.', units: ['B12271'] },
  ],
  actions: [{ text: '11/10 Called COX for update and emailed DSP re release', units: ['B12195'],
    src: { fas: [{ date: '11/10', quote: 'Called COX for update and emailed DSP re release' }] } }],
  support: [
    { text: 'Pay the impound fee for B62064.', units: ['B62064'], team: 'Carrier/DSP' },
    { text: 'Parts ETA for B12195 from COX.', units: ['B12195'], team: 'Vendor' },
  ],
  fasInput: [{ text: 'Push COX for a parts ETA on B12195.', units: ['B12195'] }],
};

describe('parseAnswer (B8.1)', () => {
  it('bad JSON or no section arrays -> ai-bad-json', () => {
    expect(A.parseAnswer('not json')).toEqual({ ok: false, code: 'ai-bad-json' });
    expect(A.parseAnswer('{"foo":[]}')).toEqual({ ok: false, code: 'ai-bad-json' });
    expect(A.parseAnswer(null)).toEqual({ ok: false, code: 'ai-bad-json' });
  });
  it('caps, bad items, over-cap, 300-char word cut, team filter, extra keys ignored', () => {
    const long = ('word ').repeat(80).trim();
    const raw = {
      answer: [{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }, { text: 'a4' }],
      trends: [{ text: long, units: ['B12195'] }, { text: '' }, { text: 5 }, { text: 'x', units: 'B1' }, 'str'],
      actions: { MOVE_UNIT: true },
      support: [{ text: 's1', team: 'Carrier/DSP' }, { text: 's2', team: 'Nope' }],
      fasInput: [{ text: 'f1', extra: 1 }],
      other: [{ text: 'z' }],
    };
    const p = A.parseAnswer('```json\n' + JSON.stringify(raw) + '\n```');
    expect(p.ok).toBe(true);
    expect(p.answer.map((x) => x.text)).toEqual(['a1', 'a2', 'a3']);
    expect(p.overCap).toBe(1);
    expect(p.trends.length).toBe(1);
    expect(p.trends[0].text.length).toBeLessThanOrEqual(300);
    expect(p.trends[0].text).toBe(G._cutWord(long, 300));
    expect(p.badItems).toBe(4);
    expect(p.actions).toEqual([]);
    expect(p.support[0].team).toBe('Carrier/DSP');
    expect(p.support[1].team).toBeUndefined();
    expect(p.fasInput[0]).toEqual({ text: 'f1', units: [] });
    expect(p.other).toBeUndefined();
  });
});

describe('AC-19 / AC-22b well-formed reply', () => {
  it('every item survives and renders in order within 3,500 chars', () => {
    const g = A.gateAnswer(A.parseAnswer(JSON.stringify(GOOD)), B);
    expect(g.removals).toEqual([]);
    expect(g.mechanical).toEqual([]);
    for (const k of A.SECTIONS) expect(g.sections[k].map((x) => x.text)).toEqual(GOOD[k].map((x) => x.text));
    const out = A.render(B.model, { sections: g.sections, removed: g.removed });
    expect(out.length).toBeLessThanOrEqual(A.REPLY_MAX);
    const heads = ['*Answer:*', '📈 *Trends*', '✅ *Actions*', '🆘 *Support Needed*', '📝 *FAS Input*', 'ℹ️ *Not in the data:*'];
    const at = heads.map((h) => out.indexOf(h));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.startsWith('*AUVTE (ROC5) — carrier intel* · 7 of 29 down · 75.9% uptime\n_Live fleet data as of 11/17 12:38 PM ET_\n')).toBe(true);
    expect(out).toContain('• (Carrier/DSP) Pay the impound fee for B62064.');
    expect(out.endsWith('_AI analysis of extracted Relay/AAP facts._')).toBe(true);
  });
  it('AC-19b fab drops the render-added markers; item text unchanged on both surfaces', () => {
    const sections = clone(GOOD);
    sections.trends.push({ text: 'Keep **this** _as is_', units: [] });
    const slack = A.render(B.model, { sections, surface: 'slack' });
    const fab = A.render(B.model, { sections, surface: 'fab' });
    expect(slack).toContain('📈 *Trends*');
    expect(fab).toContain('📈 Trends');
    expect(fab).not.toContain('*Trends*');
    expect(fab).toContain('AUVTE (ROC5) — carrier intel · 7 of 29 down');
    expect(fab).toContain('\nLive fleet data as of 11/17 12:38 PM ET\n');
    expect(fab.split('\n').some((l) => l.startsWith('_'))).toBe(false);
    for (const out of [slack, fab]) expect(out).toContain('• Keep **this** _as is_');
    const strip = (s) => s.replace(/\*([^*\n]+)\*/g, '$1').replace(/^_(.*)_$/gm, '$1');
    expect(strip(slack.replace('• Keep **this** _as is_', ''))).toBe(fab.replace('• Keep **this** _as is_', ''));
  });
  it('AC-22b rule 9 is in the prompt; a first-person FAS Input item is removed', () => {
    expect(B.prompt).toContain('never write the words FAS, I, we, our, my or me');
    expect(chk('We should push COX for parts ETAs', ['B12195'], 'fasInput')).toBe('unfounded-fas-action');
  });
});

describe('AC-20 / AC-20b ETC counts (B12195: revised 9, day slips 5, pull-ins 1, same-day 3, raw slips 8)', () => {
  it('per-unit values first', () => {
    expect(rec('B12195').etcHistory).toMatchObject({ revised: 9, daySlips: 5, dayPullIns: 1, sameDay: 3 });
    expect(B.ciText.get('B12195')).toContain('slipped 8×');
  });
  it.each([
    ['COX moved the ETC 12 times', 'unknown-etc-count'],
    ['COX slipped the ETC 8 times', 'unknown-etc-count'],
    ['COX moved the ETC 9 times', 'unknown-etc-count'],
    ['COX moved the ETC date later 5 times', null],
    ['the ETC was revised 9×', null],
    ['B12195 had 8 ETC slips', 'unknown-etc-count'],
    ['B12195 had 5 ETC date slips', null],
    ['B12195 had 3 same-day re-times', null],
    ['B12195 had 9 ETC revisions', null],
  ])('%s -> %s', (text, code) => { expect(chk(text, ['B12195'])).toBe(code); });
});

describe('AC-20c lists and verb-less counts', () => {
  it('day slips per unit are [5, 9, 11, 9]', () => {
    expect(['B12195', 'B12263', 'B12267', 'B62059'].map((id) => rec(id).etcHistory.daySlips)).toEqual([5, 9, 11, 9]);
  });
  it('list inheritance and verb-less union', () => {
    expect(chk('COX moved ETC dates later 5×, 12× and 9× on B12195', ['B12195'])).toBe('unknown-etc-count');
    expect(chk('COX moved ETC dates later 5×, 9×, 11× and 9× (B12195, B12263, B12267, B62059)', ['B12195', 'B12263', 'B12267', 'B62059'])).toBeNull();
    expect(chk('B12195: 9×', ['B12195'])).toBeNull();
    expect(chk('B12195: 12×', ['B12195'])).toBe('unknown-etc-count');
    expect(chk('B12195: 8×', ['B12195'])).toBe('unknown-etc-count');
  });
});

describe('AC-20d ETC state', () => {
  it('CI_MISS_NEG_RE on the four negation strings and the non-negated ones', () => {
    const pre = (s) => s.slice(0, s.search(/missed|overdue/));
    for (const s of ["None of AUVTE's ETCs are counted missed", "B12195's ETC is not missed", 'No ETC was missed', 'COX has 0 missed ETCs']) {
      expect(A.CI_MISS_NEG_RE.test(pre(s))).toBe(true);
    }
    for (const s of ['ETC 11/12 was missed, not met', 'The ETC 11/12 was missed on B12195', "B12195's completion date is overdue"]) {
      expect(A.CI_MISS_NEG_RE.test(pre(s))).toBe(false);
    }
    expect(A.CI_MISS_NEG_RE.test(' and the ETC was ')).toBe(false);
  });
  it('counted none + timeline "ETC 11/12": a missed claim is removed', () => {
    const rows = clone(fleet.rows);
    const r = rows.find((x) => x.equipmentId === 'B12258');
    r.repairTimeline = '11/10 - KWNE quoted ETC 11/12 for the harness repin.';
    r._factEtc = { state: 'missed', date: '2026-11-12', source: 'timeline' };
    const b = auvte({ rows, fleetRows: rows });
    expect(rec('B12258', b).etc.state).toBe('none');
    expect(b.ciText.get('B12258')).toContain('ETC 11/12');
    expect(chk('The ETC 11/12 was missed on B12258', ['B12258'], 'trends', b)).toBe('etc-state-mismatch');
    expect(chk("B12258's completion date is overdue", ['B12258'], 'trends', b)).toBe('etc-state-mismatch');
  });
  it('a counted missed state allows the claim; a negated claim with a missed unit is removed', () => {
    const b = auvte();
    const r = rec('B12263', b);
    r.etc = Object.assign({}, r.etc, { state: 'missed' });
    expect(chk('The ETC 11/17 was missed on B12263', ['B12263'], 'trends', b)).toBeNull();
    expect(chk('No ETC was missed on B12263', ['B12263'], 'trends', b)).toBe('etc-state-mismatch');
  });
  it('negated statements on AUVTE (etc:missed 0) and a DOT item untouched', () => {
    expect(B.countBy.get('etc:missed')).toBe(0);
    expect(chk("None of AUVTE's ETCs are counted missed", [])).toBeNull();
    expect(chk("B12195's ETC is not missed", ['B12195'])).toBeNull();
    expect(chk('Parts are not in, and the ETC was missed', ['B12195'])).toBe('etc-state-mismatch');
    expect(chk("B12259's DOT is overdue", ['B12259'])).toBeNull();
  });
});

describe('AC-20e recurrence counts', () => {
  it('episode allowance', () => {
    expect(B.model.themes.episodes.B12271.misfire).toBe(2);
    expect(chk('B12271 came back 2 times for misfire', ['B12271'])).toBeNull();
    expect(chk('B12271 came back 3 times for misfire', ['B12271'])).toBe('unknown-etc-count');
    const h = rec('B12195').etcHistory;
    const eps = Object.values(B.model.themes.episodes.B12195 || {});
    const used = new Set([h.revised, h.daySlips, h.dayPullIns, h.sameDay, ...eps]);
    let n = 2;
    while (used.has(n)) n += 1;
    expect(chk('B12195 came back ' + n + ' times', ['B12195'])).toBe('unknown-etc-count');
    if (eps.length) expect(chk('B12195 came back ' + eps[0] + ' times', ['B12195'])).toBeNull();
  });
});

describe('AC-21 planted specifics', () => {
  const foreignId = fleet.rows.map((r) => r.equipmentId).find((id) => !B.ctx.idMap.has(id.toLowerCase()));
  it('amount, date, foreign id and hours are removed and counted in the footer', () => {
    expect(foreignId).toBeTruthy();
    expect(chk('The B12267 estimate is $4,250', ['B12267'])).toBe('unknown-ref');
    expect(chk('B12195 has been waiting since 10/21', ['B12195'])).toBe('unknown-date');
    expect(chk(foreignId + ' is also waiting on parts', [])).toBe('foreign-id');
    expect(chk("COX's tech arrived after 2.5 h on B12195", ['B12195'])).toBe('unknown-number');
    const parsed = A.parseAnswer(JSON.stringify({ trends: [
      { text: 'The B12267 estimate is $4,250', units: ['B12267'] },
      { text: 'B12195 has been waiting since 10/21', units: ['B12195'] },
      { text: foreignId + ' is also waiting on parts', units: [] },
      { text: "COX's tech arrived after 2.5 h on B12195", units: ['B12195'] },
      GOOD.trends[0],
    ] }));
    const g = A.gateAnswer(parsed, B);
    expect(g.removed).toBe(4);
    expect(g.removals.map((r) => r.code)).toEqual(['unknown-ref', 'unknown-date', 'foreign-id', 'unknown-number']);
    expect(g.sections.trends.map((x) => x.text)).toEqual([GOOD.trends[0].text]);
    expect(A.render(B.model, { sections: g.sections, removed: g.removed })).toContain('_Fact-check removed 4 item(s) that cited details not in the data._');
  });
});

describe('AC-21b counts', () => {
  it.each([
    ['5 of 7 down units are COX parts-holds', [], 'unknown-count'],
    ['4 of 7 down units are COX parts-holds', [], null],
    ['9 trucks are on parts hold', [], 'unknown-count'],
    ['COX has 5 parts-holds', [], 'unknown-count'],
    ['COX has 4 parts-holds', [], null],
    ['AUVTE had 3 accidents', [], 'unknown-count'],
    ['COX has 12 WRs open', ['B12195'], 'unknown-number'],
    ['AUVTE has 9 down units', [], 'unknown-count'],
    ['AUVTE has 7 down units', [], null],
    ['COX holds 4 of 7 down units', [], null],
  ])('%s -> %s', (text, units, code) => { expect(chk(text, units)).toBe(code); });
  it('"2.5 h" is not read inside "12.5 h"', () => {
    const ciText = new Map(B.ciText);
    ciText.set('B12195', ciText.get('B12195') + '\nwaited 12.5 h');
    const b = Object.assign({}, B, { ciText });
    expect(chk('B12195 waited 12.5 h', ['B12195'], 'trends', b)).toBeNull();
    expect(chk('B12195 waited 2.5 h', ['B12195'], 'trends', b)).toBe('unknown-number');
  });
});

describe('AC-21c day figures', () => {
  it.each([
    ['B12195 has been down 8.4 days', ['B12195'], null],
    ['B12195 has been down 9.4 days', ['B12195'], 'unknown-number'],
    ['B12195 has been down 8 days', ['B12195'], 'unknown-number'],
    ["B12259's DOT expired 7 days ago", ['B12259'], null],
    ["B12259's DOT expired 8 days ago", ['B12259'], 'unknown-number'],
    ["COX's tech arrived after 34.3 hours", ['B12195'], null],
    ["COX's tech arrived after 34.3 days", ['B12195'], 'unknown-number'],
  ])('%s -> %s', (text, units, code) => { expect(chk(text, units)).toBe(code); });
});

describe('AC-21e scope tiers', () => {
  it('per-unit values first', () => {
    const ids = ['B12195', 'B12263', 'B12267', 'B62059'];
    expect(ids.map((id) => rec(id).etcHistory.daySlips)).toEqual([5, 9, 11, 9]);
    expect(ids.map((id) => rec(id).arrival.hours)).toEqual([34.3, 4.0, 3.8, 8.4]);
  });
  it('unit-scoped items read only their units; pseudo-scoped items read the roll-up', () => {
    const down = B.countBy.get('down');
    const share = /parts-hold 4 units [\d.]+ unit-days \((\d+)%\)/.exec(B.model.rollupText)[1];
    expect(chk('COX moved the ETC 9 times', ['B12195'])).toBe('unknown-etc-count');
    expect(chk("B12263's tech arrived after 34.3 h", ['B12263'])).toBe('unknown-number');
    expect(chk("B12263's tech arrived after 4.0 h", ['B12263'])).toBeNull();
    expect(chk('KWNE has held B12195 since 11/9', ['B12195'])).toBe('unknown-name');
    expect(chk('COX holds 4 of 7 down units', [])).toBeNull();
    expect(chk('B12195 is one of ' + down + ' down units; parts-holds are ' + share + '% of the down-days', ['B12195'])).toBeNull();
    expect(chk("COX moved B12195's ETC date later 11 times", ['B12195'])).toBe('unknown-etc-count');
    expect(chk("B12267's ETC date moved later 11 times", ['B12267'])).toBeNull();
  });
});

describe('AC-21d vendor and dealer names', () => {
  it('lexicon names must be bounded in the scoped prompt text', () => {
    // Step 4 runs before step 6, so the unbacked "10 days" is what removes this one first.
    expect(chk('KWNE has held B12195 for 10 days', ['B12195'])).not.toBeNull();
    expect(chk('KWNE has held B12195', ['B12195'])).toBe('unknown-name');
    expect(B.ciText.get('B12258')).toContain('11/10');
    expect(chk('KWNE has held B12258 since 11/10', ['B12258'])).toBeNull();
    expect(chk('COX holds 4 of 7 down units', [])).toBeNull();
    expect(chk('Kenworth Rochester has B12258', ['B12258'])).toBe('unknown-name');
    for (const n of ['cox', 'kwne', 'fleetnet']) expect(A.CI_NAME_ALLOW.has(n)).toBe(false);
  });
  it('generic lexicon words are skipped', () => {
    expect(chk("COX's tech arrived onsite on B12195 after 34.3 h", ['B12195'])).toBeNull();
    expect(chk('The DSP must pick a dealer or body shop for B13014', ['B13014'])).toBeNull();
    expect(chk('a mobile tech from the dealership', ['B12195'])).toBeNull();
  });
});

describe('AC-22 FAS claims', () => {
  it('needs a src.fas quote from a [FAS] line on that date', () => {
    expect(chk('FAS called COX 11/10 for update', ['B12195'], 'actions')).toBe('unfounded-fas-action');
    expect(A.checkItem({ text: 'FAS called COX 11/10 for update', units: ['B12195'],
      src: { fas: [{ date: '11/10', quote: 'Called COX for update' }] } }, 'actions', B)).toBeNull();
    expect(chk('FAS called COX 11/10 for update', ['B12195'], 'trends')).toBe('unfounded-fas-action');
  });
});

describe('AC-25 / AC-25b mechanical fallback', () => {
  it('a section whose AI items are all removed shows the deterministic lines', () => {
    const g = A.gateAnswer(A.parseAnswer(JSON.stringify({ trends: [{ text: 'AUVTE had 3 accidents', units: [] }] })), B);
    expect(g.removed).toBe(1);
    expect(g.mechanical).toContain('trends');
    expect(g.sections.trends.length).toBeGreaterThan(0);
    for (const it of g.sections.trends) expect(it.text.endsWith('(from the extracted facts)')).toBe(true);
    expect(g.sections.trends[0].text.startsWith('down-cause split: ')).toBe(true);
  });
  it('no alias, no [FAS] line: Actions holds the italic G-FASID line, gaps hold G-FASID, a no-action item is removed', () => {
    const b = auvte({ enrich: {} });
    expect([...b.model.fasLogs.values()].every((l) => l.length === 0)).toBe(true);
    const g = A.gateAnswer(A.parseAnswer(JSON.stringify({ actions: [{ text: A.NO_FAS_LINE, units: [] }] })), b);
    expect(g.removals).toEqual([{ section: 'actions', code: 'unfounded-no-action' }]);
    expect(g.sections.actions).toEqual([{ text: Gp.GAP_TEXT['G-FASID'], units: [], system: true }]);
    const out = A.render(b.model, { sections: g.sections, removed: g.removed });
    const act = out.slice(out.indexOf('✅ *Actions*'), out.indexOf('🆘'));
    expect(act).not.toContain('No FAS action logged');
    expect(act).toContain('• _' + Gp.GAP_TEXT['G-FASID'] + '_');
    expect(out.slice(out.indexOf('ℹ️'))).toContain(Gp.GAP_TEXT['G-FASID']);
  });
  it('with a cached alias and no [FAS] line the no-action item survives and is the mechanical line', () => {
    const b = auvte({ enrich: {}, fasAlias: 'nobody-alias' });
    expect(chk(A.NO_FAS_LINE, [], 'actions', b)).toBeNull();
    expect(A.mechanical('actions', b.model)).toEqual([{ text: A.NO_FAS_LINE, units: [] }]);
  });
  it('the "Called COX … and emailed DSP" clause case', () => {
    const m = A.mechanical('actions', B.model);
    expect(m[0]).toEqual({ text: '11/10 Called COX for update and emailed DSP re release', units: ['B12195'],
      src: { fas: [{ date: '11/10', quote: 'Called COX for update and emailed DSP re release' }] } });
    const q = m[0].src.fas[0].quote.toLowerCase();
    expect(q).toContain('called');
    expect(q).toContain('emailed');
    expect(A.checkItem(m[0], 'actions', B)).toBeNull();
  });
  it('gated-out Actions with [FAS] lines -> "Unit notes for … hold more detail (see Relay)."', () => {
    const b = auvte();
    b.model.fasLogs.set('B12195', [{ md: '11/10', body: 'ok' }]);   // a too-short clause: no envelope item
    const g = A.gateAnswer({ ok: false }, b);
    expect(g.sections.actions).toEqual([{ text: 'Unit notes for B12195 hold more detail (see Relay).', units: ['B12195'] }]);
  });
});

describe('mechanical lines pass the gate (AUVTE and the 40-unit context)', () => {
  const S = syn40();
  for (const [name, b] of [['AUVTE', B], ['AUVTE no alias', auvte({ enrich: {} })], ['AUVTE all cues', auvte({ cues: ALL_CUES })], ['SYNX 40', S]]) {
    it(name + ': every mechanical line passes; envelopes parse', () => {
      let n = 0;
      for (const sec of A.SECTIONS) {
        for (const it of A.mechanical(sec, b.model)) {
          if (it.system) continue;
          n += 1;
          expect([sec, it.text, A.checkItem(it, sec, b)]).toEqual([sec, it.text, null]);
          if (it.src) expect(G.parseEnvelope(it.src, 'fasActions', TODAY).ok).toBe(true);
        }
      }
      expect(n).toBeGreaterThan(3);
      const g = A.gateAnswer({ ok: false }, b);
      expect(g.diag.filter((d) => d.code === 'mech-drop')).toEqual([]);
    });
  }
  it('40-unit cause split with unit-days passes and "unit-days" is not a unit count', () => {
    const split = A.mechanical('trends', S.model)[0];
    expect(split.text).toMatch(/\d+\.\d unit-days/);
    expect(A.checkItem(split, 'trends', S)).toBeNull();
    expect(chk('repair holds 763.1 unit-days', [], 'trends', S)).toBe(S.model.rollupText.includes('763.1 unit-days') ? null : 'unknown-number');
  });
});

describe('gate-error', () => {
  it('a throwing gateEntry removes the item and adds one warn diag', () => {
    vi.spyOn(G, 'gateEntry').mockImplementation(() => { throw new Error('x'); });
    const g = A.gateAnswer(A.parseAnswer(JSON.stringify({ trends: [{ text: 'a' }, { text: 'b' }] })), B);
    expect(g.removals.filter((r) => r.code === 'gate-error').length).toBe(2);
    expect(g.diag.filter((d) => d.code === 'gate-error')).toEqual([{ code: 'gate-error', level: 'warn' }]);
  });
});

describe('render (B10)', () => {
  it('AC-32 Slack mentions in AI text are defanged', () => {
    const out = A.render(B.model, { sections: { answer: [{ text: 'Heads up <!channel> and @here, ping <@U12345>' }], trends: [], actions: [], support: [], fasInput: [] } });
    expect(out).not.toContain('<!channel>');
    expect(out).not.toContain('<@U12345>');
    expect(out).not.toMatch(/(^|\s)@here\b/);
    expect(out).toContain('Heads up @\u200Bchannel and @\u200Bhere, ping @U12345');
  });
  it('mode footer for the mechanical answer', () => {
    const out = A.render(B.model, { sections: A.gateAnswer({ ok: false }, B).sections, reason: 'AI timed out' });
    expect(out.endsWith('_Mechanical summary from the extracted facts (AI timed out)._')).toBe(true);
  });
  it('3,500 cap with maximal items and G-STALE; every cue gap kept in full', () => {
    const b = auvte({ cues: ALL_CUES, now: Date.parse(fleet.syncedAt) + 6 * 3600 * 1000 });
    expect(b.gaps.map((g) => g.id)).toContain('G-STALE');
    const t300 = (k) => (k + ' ' + 'lorem ipsum '.repeat(30)).slice(0, 300);
    const sections = {};
    for (const k of A.SECTIONS) sections[k] = Array.from({ length: A.CAPS[k] }, (_, i) => ({ text: t300(k + i), units: [] }));
    const out = A.render(b.model, { sections, removed: 3 });
    expect(out.length).toBeLessThanOrEqual(A.REPLY_MAX);
    for (const g of b.gaps.filter((x) => x.kind === 'cue')) expect(out).toContain('• ' + g.text);
    expect(b.gaps.filter((x) => x.kind === 'cue').length).toBe(6);
    expect(out).toContain('_Fact-check removed 3 item(s)');
    expect(out).toContain('📈 *Trends*');
    expect(out.endsWith('_AI analysis of extracted Relay/AAP facts._')).toBe(true);
  });
  it('zero down units: "Nothing down at <SCAC> right now." with compliance Support lines and gaps', () => {
    const rows = clone(fleet.rows).map((r) => Object.assign(r, { lifecycleState: 'Active' }));
    const b = C.buildContext({ scac: 'AUVTE', rows, fleetRows: rows, today: TODAY, now: NOW, cues: {}, userMsg: 'x', fd: fleet, fasAlias: '' });
    expect(b.model.records.length).toBe(0);
    const g = A.gateAnswer({ ok: false }, b);
    const out = A.render(b.model, { sections: { support: g.sections.support } });
    expect(out).toContain('\nNothing down at AUVTE right now.\n');
    expect(out).toContain('Carrier/DSP: B12259 DOT expired 11/10');
    expect(out).toContain('ℹ️ *Not in the data:*');
    expect(out).toContain('0 of 29 down');
  });
});
