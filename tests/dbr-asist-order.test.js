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
