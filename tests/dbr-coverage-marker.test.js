// tests/dbr-coverage-marker.test.js — AC46 (relay-extract output fix A, D7): a down unit with no
// surviving FAS entry gets a clean structured coverage marker, never raw / truncated evidence text.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const G = require('../src/dbr/fleet-dbr-gate');
const AI = require('../src/dbr/fleet-dbr-ai');
const { TODAY, rows } = require('./fixtures/extract/dbr-agnli-coverage');

const N = { yn: 'N', details: [] };
async function draft() {
  const built = F.buildFleetDbr(rows, { today: TODAY });
  const row = built.rows.find((r) => r.key === 'AVP40|AGNLI');
  const ask = async () => JSON.stringify({
    barriers: { vendor1p: N, oem: N, estimate: N, partner: N, parts: N, common: N },
    etc: [], fasActions: [], support: 'None',          // the model omits every unit's FAS line
  });
  return AI.draftRow({ row, unitRows: rows, built, ask, enrich: {}, fasNames: [], fleetIds: [], today: TODAY, reviewRounds: 0 });
}

describe('AC46 clean coverage marker', () => {
  it('omitted units get "⚠ <n>d, <status>, <vendor> — awaiting update (review)"; no raw text, no …, no latest:', async () => {
    const r = await draft();
    expect(r.ok).toBe(true);
    const lines = r.cells.fasActions.split('\n');
    const l39351 = lines.find((l) => l.startsWith('\u2022 39351: '));
    const l59080 = lines.find((l) => l.startsWith('\u2022 59080: '));
    expect(l39351).toMatch(/^\u2022 39351: \u26a0 (?:\d+d, )?Waiting for vendor, Volvo \(ASIST\) \u2014 awaiting update \(review\)$/);
    expect(l59080).toMatch(/^\u2022 59080: \u26a0 (?:\d+d, )?Under diagnosis, Amerit \u2014 awaiting update \(review\)$/);
    for (const l of [l39351, l59080]) {
      expect(l).not.toContain('latest:');
      for (const w of ['Approval notification', 'Diagnosis completed', 'Three findings']) expect(l).not.toContain(w);
      expect(l).not.toContain('\u2026');
      expect(l).not.toMatch(/555|@example/);
      expect(l.endsWith('(review)')).toBe(true);
    }
    expect(r.flags.fasActions).toBe('review');
  });
  it('a unit with no status, lifecycle or vendor -> "⚠ needs review" (when days down is unknown)', async () => {
    expect(G._codeLine({ daysDown: null, status: '', lifecycleReason: '', vendor: '' }, 200)).toBe('\u26a0 needs review');
    const r = await draft();
    expect(r.cells.fasActions.split('\n').find((l) => l.startsWith('\u2022 61001: '))).toMatch(/^\u2022 61001: \u26a0 (?:\d+d \u2014 awaiting update \(review\)|needs review)$/);
  });
  it('cuts: 60-char status and 45-char vendor cut at word boundaries; lineCap 50 keeps the ⚠ lead and the marker', () => {
    const info = { daysDown: 12, status: 'Waiting for vendor parts confirmation and final approval now', vendor: 'Mid Atlantic Heavy Truck Service Centers Inc' };
    const full = G._codeLine(info, 0);
    expect(full).not.toContain('\u2026');
    expect(full).not.toMatch(/[,-] \u2014/);
    const cut = G._codeLine(info, 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.startsWith('\u26a0 ')).toBe(true);
    expect(cut.endsWith('\u2014 awaiting update (review)')).toBe(true);
    expect(G._cutWord('ab cdefghij', 2)).toBe('');
  });
});
