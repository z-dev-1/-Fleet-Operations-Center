// DBR review-engine parity: src/dbr/review-engine.js must behave exactly like
// the CURRENT renderer DBR functions in renderer/src/js/views/daily-call.js.
// The renderer source is extracted and run in a sandbox (tests/helpers/
// dbr-renderer-src.js). Goldens under tests/fixtures/dbr-lookup/ were captured
// ONCE from the unmodified renderer with DBRLOOKUP_CAPTURE_BASELINE=1.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { extractBlocks, blockHashes, loadRenderer, BLOCK_SPECS } from './helpers/dbr-renderer-src.js';
const require = createRequire(import.meta.url);
const engine = require('../src/dbr/review-engine');

const FIX = path.join(__dirname, 'fixtures', 'dbr-lookup');
const CAPTURE = process.env.DBRLOOKUP_CAPTURE_BASELINE === '1';
const ROWS = JSON.parse(fs.readFileSync(path.join(FIX, 'fleet-rows.json'), 'utf8')).rows;

const dom = (code) => ROWS.filter((r) => (r.domicileSite || r.domicile || '').trim().toUpperCase() === code);
const scac = (code) => ROWS.filter((r) => (r.operator || '').trim().toUpperCase() === code);
const down = (rows) => rows.filter(engine.isUnavail);

function bigGroup(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      equipmentId: 'B' + String(9000 + i), domicileSite: 'BIG62', operator: i % 2 ? 'ABEOW' : 'TUZR',
      lifecycleState: 'Unavailable', lifecycleReason: i % 3 ? 'Offsite Shop Repair' : 'Parts Delay',
      vendor: i % 4 ? 'Amerit' : '--', savedRepairStatus: i % 5 ? 'Waiting for vendor' : 'Parts backordered',
      issueDetails: (i % 2 ? 'misfire and coolant leak ' : 'transmission slipping, brakes worn ') + 'x'.repeat(i * 20),
      workDuration: (i % 30) + 'd', fuelType: i % 7 ? 'CNG' : 'Diesel', make: 'Freightliner',
    });
  }
  return out;
}

const GROUPS = [
  ['domicile AUVTE', down(dom('AUVTE')), dom('AUVTE')],
  ['domicile OAK-W', down(dom('OAK-W')), dom('OAK-W')],
  ['SCAC ABEOW', down(scac('ABEOW')), scac('ABEOW')],
  ['domicile EMPTY', [], []],
  ['domicile BIG62', bigGroup(62), bigGroup(62)],
];

if (CAPTURE) {
  describe('capture goldens (unmodified renderer only)', () => {
    it('writes block hashes and review-prompt baselines', () => {
      const R = loadRenderer({ rows: ROWS });
      fs.writeFileSync(path.join(FIX, 'renderer-blocks-baseline.json'), JSON.stringify(blockHashes(), null, 2) + '\n');
      fs.writeFileSync(path.join(FIX, 'review-prompt-baseline-1.txt'), R._dbrBuildReviewPrompt('domicile AUVTE', R._computeGroup(down(dom('AUVTE')), down(dom('AUVTE')))));
      fs.writeFileSync(path.join(FIX, 'review-prompt-baseline-2.txt'), R._dbrBuildReviewPrompt('SCAC ABEOW', R._computeGroup(down(scac('ABEOW')), down(scac('ABEOW')))));
    });
  });
}

describe('renderer block extraction + tripwire', () => {
  it('every marker is found', () => {
    const b = extractBlocks();
    for (const [name] of BLOCK_SPECS) expect(b[name], name).toBeTruthy();
  });
  it('a missing marker throws', () => {
    expect(() => extractBlocks('const nothing = 1;\n')).toThrow(/not found/);
  });
  it.skipIf(CAPTURE)('block sha1s equal the baseline (renderer DBR logic changed, update src/dbr/review-engine.js and the baseline)', () => {
    const base = JSON.parse(fs.readFileSync(path.join(FIX, 'renderer-blocks-baseline.json'), 'utf8'));
    expect(blockHashes()).toEqual(base);
  });
  it('the port contains each ported renderer block verbatim', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dbr', 'review-engine.js'), 'utf8').replace(/\r\n/g, '\n');
    const b = extractBlocks();
    for (const n of ['TREND_TERMS', 'TREND_MIN_UNITS', 'BARRIER_TERMS', 'FLIP_SIGNAL', 'STATUS_BARRIER_MAP', '_unitText',
      '_parseDaysOpen', '_isUnavail', '_computeGroup', '_dbrBuildReviewPrompt', '_dbrNormalizeTrendsText', '_dbrNormalizeHelpText']) {
      expect(src.includes(b[n]), n).toBe(true);
    }
  });
});

describe('computeGroup parity', () => {
  const R = loadRenderer({ rows: ROWS });
  for (const [label, dn, all] of GROUPS) {
    it(label + ': (down, down) and (down, all) deep-equal the renderer', () => {
      expect(engine.computeGroup(dn, dn)).toEqual(R._computeGroup(dn, dn));
      expect(engine.computeGroup(dn, all)).toEqual(R._computeGroup(dn, all));
    });
  }
  it('uptime from all matched rows = round((total-down)/total*1000)/10 (84.2 for AUVTE)', () => {
    const all = dom('AUVTE');
    const g = engine.computeGroup(down(all), all);
    expect(g.total).toBe(38);
    expect(g.unavailCount).toBe(6);
    expect(g.uptime).toBe(Math.round(((38 - 6) / 38) * 1000) / 10);
    expect(g.uptime).toBe(84.2);
  });
  it('unavailRows carry fuelType/lifecycleReason and no canon fields', () => {
    const g = engine.computeGroup(down(dom('AUVTE')), down(dom('AUVTE')));
    expect(g.unavailRows[0]).toHaveProperty('fuelType', 'CNG');
    expect(g.unavailRows[0]).toHaveProperty('lifecycleReason', 'Parts Delay');
    expect(Object.keys(g.unavailRows[0]).some((k) => /^canon/.test(k))).toBe(false);
  });
  it('AUVTE has a 3+ misfire trend', () => {
    const g = engine.computeGroup(down(dom('AUVTE')), down(dom('AUVTE')));
    expect(g.trends.find((t) => t.label === 'Misfire').count).toBe(3);
  });
});

describe('buildReviewPrompt parity', () => {
  const R = loadRenderer({ rows: ROWS });
  for (const [label, dn] of GROUPS) {
    it(label + ': byte-identical to the renderer', () => {
      expect(engine.buildReviewPrompt(label, engine.computeGroup(dn, dn))).toBe(R._dbrBuildReviewPrompt(label, R._computeGroup(dn, dn)));
    });
  }
  it.skipIf(CAPTURE)('matches the captured goldens', () => {
    const p1 = engine.buildReviewPrompt('domicile AUVTE', engine.computeGroup(down(dom('AUVTE')), down(dom('AUVTE'))));
    const p2 = engine.buildReviewPrompt('SCAC ABEOW', engine.computeGroup(down(scac('ABEOW')), down(scac('ABEOW'))));
    expect(p1).toBe(fs.readFileSync(path.join(FIX, 'review-prompt-baseline-1.txt'), 'utf8'));
    expect(p2).toBe(fs.readFileSync(path.join(FIX, 'review-prompt-baseline-2.txt'), 'utf8'));
  });
  it('keeps the anti-fabrication contract', () => {
    const p = engine.buildReviewPrompt('domicile AUVTE', engine.computeGroup(down(dom('AUVTE')), down(dom('AUVTE'))));
    expect(p).toContain('never invent information not present in the unit data below');
    expect(p).toContain('Do not invent, guess, or extrapolate');
    expect(p).toContain('must use \\n for line breaks');
  });
});

describe('normalizer parity', () => {
  const R = loadRenderer({ rows: ROWS });
  const TRENDS = [
    'No trends',
    'No single system reaches 3+ units; checked engine, brakes and tires. No trends meeting threshold.',
    '**6 OOS; 5 CNG, 1 Diesel**\r\nAmerit; 3 Parts; 1 ETC today; 221019\n\n\n\nENGINE/MOTOR SYSTEMS: 3 units\n  - 521073: misfire',
    '', undefined, null, 42, 'x'.repeat(3000), '  short trend  ',
  ];
  const HELP = [
    'No help needed',
    'None of the five checks matched for any unit, so No help needed today.',
    'Help with getting estimate pushed through for 330002',
    '', undefined, 7, { a: 1 }, 'y'.repeat(500),
  ];
  it('normalizeTrendsText equals the renderer over the table', () => {
    for (const v of TRENDS) expect(engine.normalizeTrendsText(v)).toBe(R._dbrNormalizeTrendsText(v));
  });
  it('normalizeHelpText equals the renderer over the table', () => {
    for (const v of HELP) expect(engine.normalizeHelpText(v)).toBe(R._dbrNormalizeHelpText(v));
  });
});

describe('reviewRow parity vs the renderer _dbrReviewRow', () => {
  const FIELDS = ['trendsText', 'barriersText', 'flipsText', 'actionsText', 'helpText'];
  const GOOD = JSON.stringify({
    trends: '6 OOS; 5 CNG, 1 Diesel\nAmerit; 3 Parts; 1 ETC today; 221019',
    barriers: '521073 (27d): Parts delay — harness PN, ETA 8/13',
    expectedFlips: '1 (221019)', actions: 'Follow up with Amerit on parts ETA for 521073', helpNeeded: 'No help needed',
  });
  const EMPTY = JSON.stringify({ trends: '', barriers: '  ', expectedFlips: '', actions: '', helpNeeded: '' });
  const SCENARIOS = [
    ['good JSON', async () => ({ ok: true, text: 'Here: ' + GOOD + ' done' })],
    ['empty-field JSON', async () => ({ ok: true, text: EMPTY })],
    ['rejecting ask', async () => { throw new Error('AI down'); }],
    ['non-JSON text', async () => ({ ok: true, text: 'sorry, I cannot help' })],
  ];
  for (const [name, ask] of SCENARIOS) {
    it(name, async () => {
      const units = down(dom('AUVTE'));
      const R = loadRenderer({ rows: ROWS, ask });
      const r = await R._dbrReviewRow('domicile', 'AUVTE', 'domicile AUVTE');
      const prompts = [];
      const p = await engine.reviewRow(units, 'domicile AUVTE', async (pr) => { prompts.push(pr); return engine.parseAiJson(await ask(pr)); });
      for (const f of FIELDS) expect(p[f], f).toBe(r[f]);
      expect('aiError' in p).toBe('aiError' in r);
      if (r.aiError) expect(p.aiError).toBe(r.aiError);
      expect(prompts[0]).toBe(engine.buildReviewPrompt('domicile AUVTE', engine.computeGroup(units, units)));
    });
  }
  it('zero units', async () => {
    const R = loadRenderer({ rows: ROWS });
    const r = await R._dbrReviewRow('domicile', 'NOPE', 'domicile NOPE');
    let called = false;
    const p = await engine.reviewRow([], 'domicile NOPE', async () => { called = true; return {}; });
    expect(p).toEqual(r);
    expect(called).toBe(false);
  });
  it('mechanicalDrafts equals the fallback set', async () => {
    const units = down(dom('AUVTE'));
    const p = await engine.reviewRow(units, 'domicile AUVTE', async () => { throw new Error('x'); });
    const m = engine.mechanicalDrafts(engine.computeGroup(units, units));
    expect({ trendsText: p.trendsText, barriersText: p.barriersText, flipsText: p.flipsText }).toEqual(m);
  });
  it('parseAiJson keeps the renderer error message', () => {
    expect(() => engine.parseAiJson({ text: 'no json' })).toThrow(engine.AI_NO_DATA_MESSAGE);
    expect(engine.parseAiJson('{"a":1}')).toEqual({ a: 1 });
  });
});
