// tests/dbr-asist-order.test.js — relay-extract §15.1 shared helper
// (utils/offsite-notes-order). FEAT-004 extends this file with AC19 / AC20 (DBR fixes).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.TZ = 'America/New_York';
const { offsiteEntries, offsiteNewestFirst } = require('../src/utils/offsite-notes-order');

describe('offsiteNewestFirst', () => {
  it('Decisiv API shape: already newest-first -> unchanged', () => {
    const t = '2026-11-10 15:28 Uptime Agent (Originator: Uptime): Current Case — ETR is 11/11/2026\n'
      + '2026-11-09 18:38 Dealer Advisor (M & K): Status — Waiting on parts\n'
      + '2026-09-28 18:05 Dealer Advisor (M & K): Parts info — RO # 30319SP';
    expect(offsiteNewestFirst(t)).toBe(t);
    expect(offsiteEntries(t).map((e) => e.atMs != null)).toEqual([true, true, true]);
  });
  it('Decisiv API shape: oldest-first -> reversed', () => {
    const t = '2026-09-28 18:05 Dealer: RO # 30319SP\n2026-11-09 18:38 Dealer: Waiting on parts\n2026-11-10 15:28 Uptime: ETR is 11/11/2026';
    expect(offsiteNewestFirst(t).split('\n')).toEqual([
      '2026-11-10 15:28 Uptime: ETR is 11/11/2026', '2026-11-09 18:38 Dealer: Waiting on parts', '2026-09-28 18:05 Dealer: RO # 30319SP',
    ]);
  });
  it('DTNA shape: already newest-first -> unchanged; multi-line entries stay whole', () => {
    const t = 'October 26, 2026 — ROSync API: closed this case as Closed (Post-Repair to Closed)\n'
      + 'October 23, 2026 — Horwith Advisor: Unit received\ncontinued line\n'
      + 'October 23, 2026 — E2E Geofence API User: has entered HORWITH FREIGHTLINER';
    expect(offsiteNewestFirst(t)).toBe(t);
    const rev = t.split('\n').length && offsiteNewestFirst(
      'October 23, 2026 — Horwith Advisor: Unit received\ncontinued line\nOctober 26, 2026 — ROSync API: closed');
    expect(rev).toBe('October 26, 2026 — ROSync API: closed\nOctober 23, 2026 — Horwith Advisor: Unit received\ncontinued line');
  });
  it('DOM shape (MM/DD/YY h:mm am) oldest-first -> newest-first, undated head moves after dated', () => {
    const t = 'ASIST notes\n09/28/26 2:05 pm Dealer: RO # 30319SP\n11/10/26 10:28 am Uptime: ETR is 11/11/2026';
    expect(offsiteNewestFirst(t)).toBe('11/10/26 10:28 am Uptime: ETR is 11/11/2026\n09/28/26 2:05 pm Dealer: RO # 30319SP\nASIST notes');
  });
  it('fewer than 2 dated entries -> unchanged; non-strings are safe', () => {
    expect(offsiteNewestFirst('just text\nmore text')).toBe('just text\nmore text');
    expect(offsiteNewestFirst('2026-11-10 15:28 one entry')).toBe('2026-11-10 15:28 one entry');
    expect(offsiteNewestFirst('')).toBe('');
    expect(offsiteNewestFirst(null)).toBe('');
    expect(offsiteEntries(null)).toEqual([]);
  });
});

// AC19 / AC20 (FEAT-004): written first against the unpatched module (red), then patched.
const EV = require('../src/dbr/fleet-dbr-evidence');
const F = require('../src/dbr/fleet-dbr');
const A = require('./fixtures/extract/asist-39582-9000.js');

const asistSeg = (ev) => ev.segments.find((s) => s.kind === 'asist');

describe('AC19 bug fix 1: newest-first asistNotes keep the head', () => {
  const raw = { equipmentId: '39582', vendor: 'Volvo (ASIST)', asistNotes: A.asistNotes };
  const unit = { id: '39582', daysDown: 49, barriers: [], etc: { state: 'today', date: '2026-11-11', source: 'asistNotes' } };

  it('fixture is ~9,000 chars, newest-first, head carries the ETR', () => {
    expect(A.asistNotes.length).toBeGreaterThanOrEqual(8500);
    expect(A.asistNotes.startsWith(A.HEAD)).toBe(true);
  });

  it('buildUnitEvidence keeps "ETR is 11/11/2026" under the newest-first label, no leading ellipsis', () => {
    const ev = EV.buildUnitEvidence(raw, unit, {}, '2026-11-11', [], '');
    const text = ev.text();
    expect(text).toContain('ETR is 11/11/2026');
    expect(text).toContain('ASIST notes (newest first):');
    expect(text).not.toContain('ASIST notes (latest):');
    const seg = asistSeg(ev);
    expect(seg.lines[0].text.startsWith('\u2026')).toBe(false);
    expect(seg.lines[0].text.startsWith('2026-11-10 10:28 Uptime Center')).toBe(true);
  });

  it('after allocate([ev], 1500) (trim path) the kept asist text still starts with the newest entry', () => {
    const ev = EV.buildUnitEvidence(raw, unit, {}, '2026-11-11', [], '');
    const [t] = EV.allocate([ev], 1500);
    const seg = asistSeg(t);
    expect(seg && seg.lines.length).toBeTruthy();
    expect(seg.lines[0].text.startsWith('2026-11-10 10:28 Uptime Center')).toBe(true);
    expect(t.text()).toContain('ETR is 11/11/2026');
  });

  it('oldest-first asistNotes are reordered newest-first before the clip', () => {
    const old = A.asistNotes.split('\n').reverse().join('\n');
    const ev = EV.buildUnitEvidence(Object.assign({}, raw, { asistNotes: old }), unit, {}, '2026-11-11', [], '');
    expect(asistSeg(ev).lines[0].text.startsWith('2026-11-10 10:28 Uptime Center')).toBe(true);
  });
});

describe('AC20 bug fix 2: parseEtc asistNotes reads the newest-dated mention', () => {
  it('newest entry ETR 11/11 beats the older ETC 10/15 written after it', () => {
    const r = F.parseEtc({ asistNotes: '2026-11-10 10:28 Uptime: ETR is 11/11/2026\n2026-10-01 09:00 Dealer: ETC 10/15' }, '2026-11-11');
    expect(r).toMatchObject({ state: 'today', date: '2026-11-11', source: 'asistNotes' });
  });
  it('oldest-first text still picks the newest-dated entry', () => {
    const r = F.parseEtc({ asistNotes: '2026-10-01 09:00 Dealer: ETC 10/15\n2026-11-10 10:28 Uptime: ETR is 11/11/2026' }, '2026-11-11');
    expect(r).toMatchObject({ state: 'today', date: '2026-11-11', source: 'asistNotes' });
  });
  it('undated two-mention text returns the first mention', () => {
    const r = F.parseEtc({ asistNotes: 'Dealer says ETC 11/20 now. Earlier ETC 11/05.' }, '2026-11-11');
    expect(r).toMatchObject({ state: 'future', date: '2026-11-20', source: 'asistNotes' });
  });
  it('the 9,000-char fixture resolves to today', () => {
    expect(F.parseEtc({ asistNotes: A.asistNotes }, '2026-11-11')).toMatchObject({ state: 'today', date: '2026-11-11' });
  });
  it('repairTimeline / savedNotes behavior is unchanged', () => {
    expect(F.parseEtc({ savedNotes: 'ETC 11/05 then ETC 11/20' }, '2026-11-11')).toMatchObject({ date: '2026-11-20', source: 'savedNotes' });
    expect(F.parseEtc({ repairTimeline: '11/09 - ETC 11/20\n11/10 - ETC 11/12' }, '2026-11-11')).toMatchObject({ date: '2026-11-12', source: 'repairTimeline' });
  });
});
