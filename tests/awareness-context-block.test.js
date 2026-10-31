// tests/awareness-context-block.test.js
//
// Bounded awareness prompt section (src/orcha/awareness/context-block.js), design §D8, §D16.5
// (AC18, AC19, AC25, AC30).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cb = require('../src/orcha/awareness/context-block');
const screen = require('../src/orcha/awareness/screen-context');
const actionLog = require('../src/orcha/awareness/action-log');

const M = 60 * 1000;
const H = 60 * M;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function deps(data = {}) {
  return { screen, actionLog, now: () => T0, load: (k, d) => (k in data ? data[k] : d) };
}
const digest = (at, entries) => ({ id: 'd_' + at, at, source: 'sync', entries });
const build = (source, data) => cb.buildAwarenessBlock({ source, messageText: 'x', resolvedUnitIds: [] }, deps(data));

beforeEach(() => { screen._resetForTests(); cb._resetForTests(); });

describe('screen section', () => {
  it('FAB fresh screen → unit, tab, WR, focus set', () => {
    screen.set({ unitId: '322504', tab: 'repair', wrId: 'WR1', secondaryWrCount: 2, view: 'fleet', filters: { vendor: 'Rush' } }, T0 - 5 * M);
    const r = build('fab', {});
    expect(r.text).toContain('=== WHAT Z IS LOOKING AT (desktop app, as of ');
    expect(r.text).toContain('Open unit: 322504 (tab: repair)');
    expect(r.text).toContain('WR: WR1 (+2 other WRs)');
    expect(r.text).toContain('"this"/"here" = 322504 unless Z names another unit.');
    expect(r.focusUnitId).toBe('322504');
  });

  it('Slack: 11 min old omitted, 9 min old included (AC19)', () => {
    screen.set({ unitId: 'A1' }, T0 - 11 * M);
    const r = build('slack-justme', {});
    expect(r.text).not.toContain('A1');
    expect(r.focusUnitId).toBeNull();
    screen.set({ unitId: 'A1' }, T0 - 9 * M);
    const r2 = build('slack-justme', {});
    expect(r2.text).toContain('Open unit: A1');
    expect(r2.focusUnitId).toBe('A1');
  });

  it('FAB 30 min old → LAST VIEWED header, no "this"/"here" line, focus null (AC30)', () => {
    screen.set({ unitId: 'A1', tab: 'intel' }, T0 - 30 * M);
    const r = build('fab', {});
    expect(r.text).toMatch(/=== LAST VIEWED IN DESKTOP APP \(\d\d:\d\d\) ===/);
    expect(r.text).not.toContain('"this"/"here"');
    expect(r.focusUnitId).toBeNull();
  });

  it('FAB older than 4 h → no screen section', () => {
    screen.set({ unitId: 'A1' }, T0 - 5 * H);
    expect(build('fab', {}).text).toBe('');
  });
});

describe('fail closed (AC30)', () => {
  it("source undefined or 'other' → empty even with fresh screen, digest and actions", () => {
    screen.set({ unitId: 'A1' }, T0 - M);
    const data = {
      assistantChangeDigest: { digests: [digest(T0 - M, [{ u: 'A1', k: 'stage', text: 'A1 went Ready' }])] },
      assistantActionLog: { actions: [{ at: T0 - M, type: 'escalation', unit: 'A1', detail: 'MCS Lead', actor: 'user' }] },
    };
    expect(cb.buildAwarenessBlock({ messageText: 'x' }, deps(data))).toEqual({ text: '', focusUnitId: null });
    expect(cb.buildAwarenessBlock({ source: 'other' }, deps(data))).toEqual({ text: '', focusUnitId: null });
    expect(cb.buildAwarenessBlock({ source: 'partner' }, deps(data))).toEqual({ text: '', focusUnitId: null });
  });

  it('empty inputs → empty text', () => {
    expect(build('fab', {})).toEqual({ text: '', focusUnitId: null });
    expect(build('slack-justme', {})).toEqual({ text: '', focusUnitId: null });
  });
});

describe('digest section', () => {
  it('NEW marker: stays NEW until markInjected, then cleared', () => {
    const data = { assistantChangeDigest: { digests: [digest(T0 - H, [{ u: 'A1', k: 'stage', text: 'A1 went Ready' }])] } };
    expect(build('fab', data).text).toMatch(/\[NEW \d\d:\d\d\] A1 went Ready/);
    expect(build('fab', data).text).toMatch(/\[NEW \d\d:\d\d\] A1 went Ready/);
    cb.markInjected(T0);
    const t = build('fab', data).text;
    expect(t).toMatch(/\[\d\d:\d\d\] A1 went Ready/);
    expect(t).not.toContain('[NEW ');
  });

  it('cu:true entries render "since last session"; digests older than 24 h dropped', () => {
    const data = { assistantChangeDigest: { digests: [
      digest(T0 - H, [{ u: 'A1', k: 'stage', text: 'A1 went Ready', cu: true }]),
      digest(T0 - 25 * H, [{ u: 'OLD1', k: 'stage', text: 'OLD1 went Ready' }]),
    ] } };
    const t = build('fab', data).text;
    expect(t).toMatch(/\[NEW \d\d:\d\d, since last session\] A1 went Ready/);
    expect(t).not.toContain('OLD1');
  });

  it('rules line present, permissive wording absent', () => {
    const data = { assistantChangeDigest: { digests: [digest(T0 - H, [{ u: 'A1', k: 'stage', text: 'A1 went Ready' }])] } };
    const t = build('fab', data).text;
    expect(t).toContain('Do not bring it up otherwise');
    expect(t).toContain(cb.RULES_LINE);
    expect(t).not.toContain('closing line');
  });
});

describe('actions and notices', () => {
  it('ready-notice lines: 4 recent + 1 old + 1 bogus → 3 newest first', () => {
    const data = { readyPickupNotices: {
      k1: { unit: 'R1', operator: 'ACME', at: iso(T0 - H) },
      k2: { unit: 'R2', operator: 'ACME', at: iso(T0 - 2 * H) },
      k3: { unit: 'R3', operator: 'BETA', at: iso(T0 - 3 * H) },
      k4: { unit: 'R4', operator: 'ACME', at: iso(T0 - 4 * H) },
      k5: { unit: 'ROLD', operator: 'ACME', at: iso(T0 - 80 * H) },
      k6: { unit: 'RBOGUS', operator: 'ACME', at: 'bogus' },
    } };
    const t = build('fab', data).text;
    const lines = t.split('\n').filter((l) => l.includes('App auto-sent ready-pickup notice'));
    expect(lines.map((l) => l.match(/for (\S+) to/)[1])).toEqual(['R1', 'R2', 'R3']);
    expect(lines[2]).toContain('to BETA');
  });

  it('recent actions included (max 8)', () => {
    const actions = Array.from({ length: 12 }, (_, i) => ({ at: T0 - i * M, type: 'timeline-add', unit: 'ACT' + i, detail: 'note', actor: 'user' }));
    const t = build('fab', { assistantActionLog: { actions } }).text;
    expect(t).toContain("=== Z'S RECENT ACTIONS (do not repeat or contradict these) ===");
    expect(t).toContain('ACT0');
    expect(t).toContain('ACT7');
    expect(t).not.toContain('ACT8');
  });

  it('notes section shows last 4 feed notes from the last 24 h', () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({ id: 'n' + i, at: T0 - i * M, text: 'NOTE' + i + ' text' }));
    notes.push({ id: 'old', at: T0 - 30 * H, text: 'NOTEOLD' });
    const t = build('fab', { assistantNotesFeed: { notes, lastSeenAt: 0 } }).text;
    expect(t).toContain('=== NOTES ORCHA ALREADY SENT Z ===');
    expect(t).toContain('NOTE3');
    expect(t).not.toContain('NOTE4');
    expect(t).not.toContain('NOTEOLD');
  });
});

describe('budget (AC18)', () => {
  it('500 digest entries + 50 actions → ≤ 6500 chars, screen intact, no unrelated unit ids', () => {
    screen.set({ unitId: 'SCR1', tab: 'repair', wrId: 'WR-SCR', view: 'fleet', search: 'abc' }, T0 - M);
    const entries = Array.from({ length: 500 }, (_, i) => ({ u: 'DG' + i, k: 'stage', text: 'DG' + i + ' ' + 'Diagnosis → Repair '.repeat(5) }));
    const actions = Array.from({ length: 50 }, (_, i) => ({ at: T0 - i * M, type: 'timeline-add', unit: 'AC' + i, detail: 'x'.repeat(160), actor: 'user' }));
    const rows = Array.from({ length: 300 }, (_, i) => ({ equipmentId: 'FLEETROW' + i }));
    const data = {
      fleetData: { rows },
      assistantChangeDigest: { digests: [digest(T0 - M, entries)] },
      assistantActionLog: { actions },
      assistantNotesFeed: { notes: [{ id: 'n1', at: T0 - M, text: 'NT1 is Ready' }] },
    };
    const r = build('fab', data);
    expect(r.text.length).toBeLessThanOrEqual(cb.AWARENESS_MAX_CHARS);
    expect(cb.AWARENESS_MAX_CHARS).toBe(6500);
    expect(r.text).toContain('Open unit: SCR1 (tab: repair)');
    expect(r.text).toContain('WR: WR-SCR');
    expect(r.text).toContain('"this"/"here" = SCR1');
    expect(r.text).toContain('DG0');
    expect(r.text).not.toContain('DG12 ');
    expect(r.text).not.toContain('FLEETROW');
    const ids = r.text.match(/\b(SCR1|DG\d+|AC\d+|NT1|FLEETROW\d+)\b/g) || [];
    expect(ids.every((id) => /^(SCR1|DG\d+|AC\d+|NT1)$/.test(id))).toBe(true);
  });
});

describe('isDeictic (AC25)', () => {
  it('drafting and general requests → false', () => {
    expect(cb.isDeictic('rewrite it nicer')).toBe(false);
    expect(cb.isDeictic('what does that mean')).toBe(false);
    expect(cb.isDeictic('rewrite this')).toBe(false);
  });
  it('screen-pointing requests → true', () => {
    expect(cb.isDeictic("what's going on")).toBe(true);
    expect(cb.isDeictic('escalate this')).toBe(true);
    expect(cb.isDeictic("what is this unit's ETA")).toBe(true);
    expect(cb.isDeictic("what's going on here?")).toBe(true);
  });
  it('exports the regexes', () => {
    expect(cb.DEICTIC_RE).toBeInstanceOf(RegExp);
    expect(cb.DRAFTING_RE.test('please rewrite this')).toBe(true);
  });
});
