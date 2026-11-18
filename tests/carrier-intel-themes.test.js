// tests/carrier-intel-themes.test.js — carrier-intel design B6.5: symptom themes over
// tests/fixtures/carrier-intel/auvte-repair-history.json (episodes, line format, quotes, hits,
// the no-hits line, the 120-day window).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const Th = require('../src/carrier-intel/themes');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const TODAY = '2026-11-17';
const RH = load('auvte-repair-history.json');
const ROWS = ['B12271', 'B62053', 'B20038', 'B62059'].map((id) => ({ equipmentId: id, operator: 'AUVTE' }));
const lineOf = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));

describe('repair-history fixture', () => {
  it('matches design B18.2 and carries no cold-start / under-load / could-not-duplicate wording', () => {
    const days = (id) => RH[id].map((e) => e.date);
    expect(days('B12271')).toEqual(['2026-10-27', '2026-10-28', '2026-10-29', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
    expect(RH.B12271.slice(0, 3).every((e) => e.summary.includes('cylinder 3 misfire and voltage concerns on CNG unit'))).toBe(true);
    expect(RH.B12271.slice(3).every((e) => e.summary.includes('multi-cylinder misfire with compression loss'))).toBe(true);
    expect(days('B62053')[0]).toBe('2026-09-24');
    expect(days('B62053').slice(-1)[0]).toBe('2026-10-05');
    expect(days('B62053').length).toBe(12);
    expect(RH.B62053.every((e) => e.summary.includes('will not start after fueling'))).toBe(true);
    expect(new Set(days('B20038')).size).toBe(28);
    expect(days('B20038')[0]).toBe('2026-09-09');
    expect(days('B20038').slice(-1)[0]).toBe('2026-11-10');
    expect(RH.B62059.map((e) => e.summary)).toEqual(Array(5).fill('methane detector fault; METHANE SYSTEM IS OK. NO LIGHTS'));
    const all = JSON.stringify(RH);
    expect(all).not.toMatch(/cold[- ]start|under\s+load|duplicate|replicate|reproduce/i);
  });
});

describe('symptomThemes', () => {
  const th = Th.symptomThemes(ROWS, RH, TODAY);
  it('groups daily repeats into episodes (B12271 -> 2 misfire episodes, B62053 -> 1)', () => {
    expect(th.episodes.B12271.misfire).toBe(2);
    expect(th.episodes.B62053['after fueling']).toBe(1);
    expect(th.episodes.B62059['CNG/methane']).toBe(1);
  });
  it('theme lines carry first–last, mention days and episodes', () => {
    expect(lineOf(th.text, 'theme misfire: ')).toMatch(/^theme misfire: 1 unit · B12271 10\/27–11\/16 \(10 d with mentions, 2 episodes\)/);
    expect(lineOf(th.text, 'theme after fueling: ')).toMatch(/^theme after fueling: 1 unit · B62053 9\/24–10\/5 \(12 d with mentions, 1 episode\)/);
    expect(lineOf(th.text, 'theme electrical: ')).toContain('B20038 9/9–11/10 (28 d with mentions, ');
    expect(th.text.split('\n').pop()).toBe('no hits: cold start, under load, could not duplicate');
    expect(th.text.length).toBeLessThanOrEqual(Th.CI_THEMES_MAX);
  });
  it('quotes are the matching sentence (<= 120 chars), dated, newest first', () => {
    expect(lineOf(th.text, 'theme after fueling: ')).toContain('"10/5 B62053: Unit will not start after fueling"');
    expect(lineOf(th.text, 'theme misfire: ')).toContain('"11/16 B12271: Vendor diagnosed multi-cylinder misfire with compression loss"');
    for (const name of Object.keys(th.hits)) for (const h of th.hits[name]) expect(h.quote.length).toBeLessThanOrEqual(120);
  });
  it('hits per theme, newest first; zero-hit themes present and empty', () => {
    expect(th.hits['after fueling'][0]).toEqual({ id: 'B62053', date: '2026-10-05', quote: 'Unit will not start after fueling' });
    expect(th.hits['after fueling'].length).toBe(12);
    expect(th.hits.misfire.every((h) => h.id === 'B12271')).toBe(true);
    const dates = th.hits.misfire.map((h) => h.date);
    expect(dates).toEqual(dates.slice().sort().reverse());
    for (const k of ['cold start', 'under load', 'could not duplicate']) expect(th.hits[k]).toEqual([]);
    expect(th.hits['vendor found no fault'].map((h) => h.id)).toContain('B62059');
    expect(Th.THEMES.map((t) => t.name)).toEqual(['electrical', 'CNG/methane', 'misfire', 'no-start', 'after fueling', 'cold start', 'under load', 'could not duplicate', 'vendor found no fault']);
  });
  it('per-unit theme lines repeat the unit figures', () => {
    expect(th.units).toEqual(expect.arrayContaining(['B12271', 'B62053', 'B20038', 'B62059']));
    expect(th.unitLines.B12271).toContain('B12271: theme misfire 10/27–11/16 (10 d with mentions, 2 episodes)');
    expect(th.unitLines.B20038[0]).toMatch(/^B20038: theme electrical 9\/9–11\/10 \(28 d with mentions, \d+ episodes?\)$/);
  });
  it('a single hit date renders "<id> <M/D> (1 d with mentions, 1 episode)"', () => {
    const t = Th.symptomThemes([{ equipmentId: 'B1' }], { B1: [{ date: '2026-11-01', summary: 'misfire on cyl 2' }] }, TODAY);
    expect(lineOf(t.text, 'theme misfire: ')).toBe('theme misfire: 1 unit · B1 11/1 (1 d with mentions, 1 episode) · "11/1 B1: misfire on cyl 2"');
  });
  it('only items within 120 days of today are used', () => {
    const rh = { B1: [{ date: '2026-07-19', summary: 'misfire' }, { date: '2026-07-20', summary: 'cold start issue' }] };
    const t = Th.symptomThemes([{ equipmentId: 'B1' }], rh, TODAY);
    expect(t.hits.misfire).toEqual([]);
    expect(t.hits['cold start'].map((h) => h.date)).toEqual(['2026-07-20']);
  });
  it('reads repairTimeline, issue text and conversation entries', () => {
    const row = { equipmentId: 'B2', created: '2026-11-01T15:00:00Z', issueSummary: 'Low voltage at start.',
      repairTimeline: '11/05 - Tech could not duplicate the fault. Road test ok.',
      fullConversation: 'Conversation\n11/06 - COX: unit misfires under load' };
    const t = Th.symptomThemes([row], {}, TODAY);
    expect(t.hits.electrical[0]).toMatchObject({ id: 'B2', date: '2026-11-01' });
    expect(t.hits['could not duplicate'][0]).toEqual({ id: 'B2', date: '2026-11-05', quote: 'Tech could not duplicate the fault' });
    expect(t.hits['under load'][0]).toMatchObject({ date: '2026-11-06', quote: 'unit misfires under load' });
  });
});
