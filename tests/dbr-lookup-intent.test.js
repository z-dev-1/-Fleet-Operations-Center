// DBR lookup intent pre-router + one-segment prompt patch.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { detectDbrLookup, patchPrompt, PROMPT_OLD, PROMPT_NEW } = require('../src/dbr/intent');
const { buildCatalog } = require('../src/dbr/target-resolver');

const CAT = buildCatalog({ rows: [
  { domicileSite: 'AUVTE', operator: 'ABEOW' },
  { domicileSite: 'OAK-W', operator: 'ABEOW' },
] });

const LOOKUP = [
  ['DBR for AUVTE', 'AUVTE', 'dbr'],
  ['dbr data for auvte', 'auvte', 'dbr'],
  ["what's the DBR data for AUVTE?", 'AUVTE', 'dbr'],
  ['give me the dbr data for AUVTE', 'AUVTE', 'dbr'],
  ['get dbr data for AUVTE', 'AUVTE', 'dbr'],
  ['pull dbr for AUVTE', 'AUVTE', 'dbr'],
  ['dbr for oak w', 'oak w', 'dbr'],
  ['dbr for OAK-W', 'OAK-W', 'dbr'],
  ["what's AUVTE's uptime", 'AUVTE', 'uptime'],
  ['what\u2019s AUVTE\u2019s uptime', 'AUVTE', 'uptime'],
  ['AUVTE uptime', 'AUVTE', 'uptime'],
  ['dbr for ABEOW', 'ABEOW', 'dbr'],
  ['tell me the dbr for AUVTE', 'AUVTE', 'dbr'],
  ['DBR for AUVTE, how many units are unavailable', 'AUVTE', 'dbr'],
  ['dbr for XYZZY', 'xyzzy', 'dbr'],
  ["xyzzy's dbr", 'xyzzy', 'dbr'],
];

const NULLS = [
  'pull dbr', 'get dbr data', 'refresh dbr', 'run the dbr pull', 'what is a DBR', 'what does dbr stand for',
  'send the DBR for AUVTE to Bob', 'email me the dbr for AUVTE', 'share the dbr for AUVTE', 'dm the dbr for AUVTE to bob',
  'who is the uptime manager for AUVTE', "what's the uptime goal for AUVTE", 'how many units are unavailable at AUVTE',
  'status of 208336', 'dbr for 208336', 'dbr for today', 'dbr for the week', 'what is uptime', 'uptime for XYZZY',
  '', '   ', 'x'.repeat(301), 'dbr for AUVTE ' + 'x'.repeat(300),
];

describe('detectDbrLookup routing table', () => {
  for (const [msg, raw, cue] of LOOKUP) {
    it('lookup: ' + msg, () => {
      const r = detectDbrLookup(msg, CAT);
      expect(r).not.toBeNull();
      expect(r.mine).toBe(false);
      expect(r.rawTarget).toBe(raw);
      expect(r.cue).toBe(cue);
    });
  }
  for (const msg of ['DBR for my sites', 'dbr for mine', 'dbr data for my domiciles', 'give me the dbr for my carriers']) {
    it('mine: ' + msg, () => {
      expect(detectDbrLookup(msg, CAT)).toEqual({ rawTarget: '', mine: true, cue: 'dbr', candidates: [] });
    });
  }
  for (const msg of NULLS) {
    it('null: ' + JSON.stringify(msg.slice(0, 60)), () => {
      expect(detectDbrLookup(msg, CAT)).toBeNull();
    });
  }
  it('non-string input and missing catalog never throw', () => {
    expect(detectDbrLookup(null, CAT)).toBeNull();
    expect(detectDbrLookup(42, CAT)).toBeNull();
    expect(detectDbrLookup('dbr for AUVTE', null)).toEqual({ rawTarget: 'auvte', mine: false, cue: 'dbr', candidates: ['auvte'] });
  });
  it('two known targets are both reported as candidates', () => {
    const r = detectDbrLookup('dbr for AUVTE and OAK-W', CAT);
    expect(r.rawTarget).toBe('AUVTE');
    expect(r.candidates).toEqual(['AUVTE', 'OAK-W']);
  });
});

describe('patchPrompt', () => {
  const AI_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'ai.js'), 'utf8');
  it('PROMPT_OLD is the exact segment in src/ipc/ai.js (once)', () => {
    expect(PROMPT_OLD).toBe('DBR_PULL({type:DBR_PULL}) (runs the DBR pull for AFP+DSP; for `pull dbr`/`get dbr data`)');
    expect(AI_SRC.split(PROMPT_OLD).length).toBe(2);
  });
  it('replaces exactly one segment', () => {
    const P = 'A, ' + PROMPT_OLD + ', B';
    expect(patchPrompt(P)).toBe(P.replace(PROMPT_OLD, PROMPT_NEW));
    expect(patchPrompt(P)).toBe('A, ' + PROMPT_NEW + ', B');
  });
  it('a prompt without the segment is unchanged', () => {
    expect(patchPrompt('no segment here')).toBe('no segment here');
  });
  it('PROMPT_NEW content', () => {
    expect(PROMPT_NEW).toContain('DBR_LOOKUP({type:DBR_LOOKUP,target:SITE_OR_SCAC');
    expect(PROMPT_NEW).toContain('kind:mine');
    expect(PROMPT_NEW).toContain('NEVER use DBR_PULL');
    expect(PROMPT_NEW).toContain('DBR_PULL({type:DBR_PULL})');
    expect(PROMPT_NEW).not.toContain('$');
  });
});
