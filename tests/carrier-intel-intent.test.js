// tests/carrier-intel-intent.test.js — carrier-intel design B4 / B4.1: the deterministic
// pre-router. AC-13, AC-13b, AC-13c (unit half), AC-14, AC-15, cue booleans, command rules.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const I = require('../src/carrier-intel/intent');
const { buildCatalog } = require('../src/dbr/target-resolver');

const catalog = buildCatalog({ rows: [{ operator: 'AUVTE', domicileSite: 'ROC5' }, { operator: 'SAPB', domicileSite: 'ROC5' }] });
const units = new Set(['B12267', 'B12195', 'B62059']);
const detect = (t) => I.detectCarrierIntel(t, catalog, units);

// Z's message 7, verbatim (curly quotes included).
const Q1 = 'When a box truck goes down, how long until a Cox tech actually shows up? The dashboard seems to count from assignment, not arrival.';
const Q2 = 'Have you seen Cox move techs off box trucks to trailers or hostlers? Can you name dates or units? The notes don\u2019t show it, and October is the only hint in the data.';
const Q3 = 'The CNG trucks keep coming back with misfires and voltage faults that the techs \u201Ccould not duplicate.\u201D Do the drivers report a pattern, like cold starts, after fueling or under load?';
const Q4 = 'Is box truck uptime low mainly because of repair time, or are there other causes, like units held for damage or the DSP not releasing them?';
const MSG7 = 'can you answer this questions for me real quick? ' + Q1 + '\n' + Q2 + '\n' + Q3 + '\n' + Q4
  + '\n\n \n\n \n\n \n\nthis are questions my aPP should be able to look up by itself and answer';
const ALL_CUES = ['arrival', 'reassign', 'driver', 'cnd', 'symptom', 'dsp', 'uptime'];

describe('AC-13 hits', () => {
  const cases = [
    'AUVTE trends and support needed',
    "why is AUVTE box-truck uptime low",
    'auvte: how long until a cox tech shows up?',
    'give me Trends Actions Support Needed FAS Input for AUVTE',
    'can my answer questions like this or questions like real quick for auvte can you give me Trends Actions Support Needed FAS Input',
    'AUVTE have you seen Cox move techs to trailers or hostlers? name dates or units',
    "why won't the DSP close out AUVTE's accident unit",
  ];
  for (const t of cases) it(t, () => { expect(detect(t)).toMatchObject({ scac: 'AUVTE', candidates: ['AUVTE'] }); });
  it('box-truck filter and reassign cue', () => {
    expect(detect('why is AUVTE box-truck uptime low').assetFilter).toBe('boxTruck');
    expect(detect('AUVTE trends and support needed').assetFilter).toBeNull();
    expect(detect('AUVTE have you seen Cox move techs to trailers or hostlers? name dates or units').cues.reassign).toBe(true);
  });
});

describe('AC-13b message-7 questions with an AUVTE prefix', () => {
  it('Q1 -> arrival, box truck', () => {
    const h = detect('AUVTE ' + Q1);
    expect(h).toMatchObject({ scac: 'AUVTE', assetFilter: 'boxTruck' });
    expect(h.cues.arrival).toBe(true);
  });
  it('Q2 -> reassign', () => { expect(detect('AUVTE ' + Q2).cues.reassign).toBe(true); });
  it('Q3 -> symptom, cnd, driver (curly quotes)', () => {
    const h = detect('AUVTE ' + Q3);
    expect(h.scac).toBe('AUVTE');
    expect(h.cues).toMatchObject({ symptom: true, cnd: true, driver: true });
  });
  it('Q4 -> uptime, dsp, box truck', () => {
    const h = detect('AUVTE ' + Q4);
    expect(h).toMatchObject({ scac: 'AUVTE', assetFilter: 'boxTruck' });
    expect(h.cues).toMatchObject({ uptime: true, dsp: true });
  });
  it('all four joined -> one hit with every cue', () => {
    const h = detect('AUVTE ' + [Q1, Q2, Q3, Q4].join(' '));
    expect(h.scac).toBe('AUVTE');
    expect(h.assetFilter).toBe('boxTruck');
    for (const k of ALL_CUES) expect(h.cues[k]).toBe(true);
  });
  it('the questions as typed (no SCAC) stay on today\u2019s path', () => {
    expect(detect(MSG7)).toBeNull();
    for (const q of [Q1, Q2, Q3, Q4]) expect(detect(q)).toBeNull();
  });
});

describe('AC-13c follow-up (unit half)', () => {
  const NOW = Date.parse('2026-11-17T18:00:00Z');
  const hist = (text, ageMin) => [{ role: 'user', text, ts: NOW - ageMin * 60000 }, { role: 'ai', text: 'Here is what I found.', ts: NOW - ageMin * 60000 + 1000 }];
  const fu = (text, history) => I.detectFollowUp(text, history, catalog, units, NOW);
  it('message 7 then "note we talking about auvte" -> hit with the replayed question', () => {
    const h = fu('note we talking about auvte', hist(MSG7, 5));
    expect(h).toMatchObject({ scac: 'AUVTE', followUp: true, userMsg: 'AUVTE ' + MSG7 });
    for (const k of ALL_CUES) expect(h.cues[k]).toBe(true);
  });
  it('null cases', () => {
    expect(fu('note we talking about auvte', hist(MSG7, 16))).toBeNull();
    expect(fu('note we talking about auvte', hist('SAPB trends', 5))).toBeNull();
    expect(fu('note we talking about auvte', hist('status of B12267', 5))).toBeNull();
    expect(fu('note we talking about auvte', hist('tell me a fun fact', 5))).toBeNull();
    expect(fu('note we talking about auvte', [])).toBeNull();
    expect(fu('note we talking about auvte', [{ role: 'ai', text: 'hi', ts: NOW - 1000 }])).toBeNull();
    expect(fu('note we talking about roc5', hist(MSG7, 5))).toBeNull();
    expect(fu('note we talking about auvte box trucks and sapb', hist(MSG7, 5))).toBeNull();
    expect(fu('note we talking about auvte', [{ role: 'user', text: null, ts: NOW - 1000 }])).toBeNull();
  });
  it('the newest user turn is the one replayed', () => {
    const h = [{ role: 'user', text: MSG7, ts: NOW - 10 * 60000 }, { role: 'ai', text: 'x', ts: NOW - 9 * 60000 }, { role: 'user', text: 'tell me a fun fact', ts: NOW - 60000 }];
    expect(fu('note we talking about auvte', h)).toBeNull();
  });
  it('the follow-up phrase itself is not a carrier-intel question', () => {
    expect(detect('note we talking about auvte')).toBeNull();
  });
  it('CI_FOLLOWUP_RE positive and negative strings', () => {
    for (const s of ['note we talking about auvte', 'we are talking about AUVTE.', 'for auvte', 're: auvte', 'I mean SAPB!']) expect(I.CI_FOLLOWUP_RE.test(s)).toBe(true);
    for (const s of ['note B12267 is down', 'about the AUVTE accident unit']) expect(I.CI_FOLLOWUP_RE.test(s)).toBe(false);
    expect(I.CI_FOLLOWUP_MS).toBe(15 * 60 * 1000);
  });
});

describe('AC-14 null cases', () => {
  const cases = [
    'status of B12267', 'why is B12267 down', 'dbr for AUVTE', "what's AUVTE's uptime", 'how many AUVTE units are down',
    'how many AUVTE and SAPB units are down', 'status of AUVTE and SAPB', 'send AUVTE trends to James',
    'sync and tell me why AUVTE uptime is low', 'add a note for AUVTE: support needed from the DSP', 'ROC5 trends', 'tell me a fun fact',
  ];
  for (const t of cases) it(t, () => { expect(detect(t)).toBeNull(); });
  it('text over 1,500 chars, empty or non-string', () => {
    expect(detect('AUVTE trends ' + 'x'.repeat(I.CI_MAX_TEXT))).toBeNull();
    expect(detect('   ')).toBeNull();
    expect(detect(null)).toBeNull();
    expect(I.CI_MAX_TEXT).toBe(1500);
  });
  it('"update me on AUVTE trends" is a hit (benign phrase)', () => {
    expect(detect('update me on AUVTE trends')).toMatchObject({ scac: 'AUVTE' });
  });
  it('an unknown unit-shaped token keeps today\u2019s path', () => {
    expect(detect('AUVTE trends for 208336')).toBeNull();
    expect(I.hasUnitToken('status of b62059', units)).toBe(true);
    expect(I.hasUnitToken('auvte trends', units)).toBe(false);
  });
});

describe('AC-15 two SCACs', () => {
  it('"AUVTE vs SAPB trends" -> ambiguous', () => {
    expect(detect('AUVTE vs SAPB trends')).toEqual({ ambiguous: true, candidates: ['AUVTE', 'SAPB'] });
  });
  it('scacCandidates skips STOP words and short tokens; domicile-only codes are not SCACs', () => {
    expect(I.scacCandidates('auvte and sapb and roc5', catalog)).toEqual(['AUVTE', 'SAPB']);
    expect(I.scacCandidates('', catalog)).toEqual([]);
  });
});

describe('cue booleans', () => {
  it('each cue regex', () => {
    const c = (t) => detect('AUVTE trends ' + t).cues;
    expect(c('response time').arrival).toBe(true);
    expect(c('when do technicians arrive').arrival).toBe(true);
    expect(c('did cox pull techs').reassign).toBe(true);
    expect(c('techs on yard trucks').reassign).toBe(true);
    expect(c('drivers report rough idle').driver).toBe(true);
    expect(c('no fault found').cnd).toBe(true);
    expect(c("can't duplicate").cnd).toBe(true);
    expect(c('methane alarm').symptom).toBe(true);
    expect(c('units held').dsp).toBe(true);
    expect(c('why').why).toBe(true);
    const none = detect('AUVTE trends').cues;
    for (const k of ALL_CUES.concat(['why'])) expect(none[k]).toBe(false);
  });
  it('dsp / uptime alone are not analytical', () => {
    expect(detect('AUVTE dsp uptime')).toBeNull();
    expect(detect('AUVTE misfires')).toMatchObject({ scac: 'AUVTE' });
    expect(detect('AUVTE could not duplicate')).toMatchObject({ scac: 'AUVTE' });
  });
});

describe('command rules', () => {
  it('CI_CMD_LEAD / CI_SEND_TO', () => {
    expect(detect('please email the AUVTE trends')).toBeNull();
    expect(detect('send AUVTE trends to James')).toBeNull();
    expect(detect('hey, can you post AUVTE trends')).toBeNull();
    expect(detect('AUVTE trends, then share them to the team')).toBeNull();
    expect(detect('send me AUVTE trends')).toMatchObject({ scac: 'AUVTE' });
    expect(detect('AUVTE have you seen Cox move techs')).toMatchObject({ scac: 'AUVTE' });
    expect(I.CI_CMD_LEAD.test('could you escalate the auvte trends')).toBe(true);
    expect(I.CI_CMD_LEAD.test('have you seen cox move techs')).toBe(false);
    expect(I.CI_SEND_TO.test('send auvte trends to james')).toBe(true);
    expect(I.CI_SEND_TO.test('why is auvte uptime low')).toBe(false);
  });
});
