// PM/DOT pills show how many days an overdue item is past due ("DOT 7d over")
// in the Fleet table PM Dates column (_pmPill / _augmentRow) and the unit
// drawer header (_pmLocationRow). The day count comes from the raw per-label
// due field (dotDue etc.); the short value is just 'overdue'. "Today" is
// pinned with fake timers so the tests are date-stable.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
const _store = {};
globalThis.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() { return () => {}; }, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { slice: () => ({}), get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/bridge.js', () => ({ relay: {}, ai: {}, aap: {}, fleet: {}, notes: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/components/context-menu.js', () => ({ showContextMenu() {} }));
vi.mock('../renderer/src/js/views/fleet-overview.js', () => ({ mount() {} }));
vi.mock('../renderer/src/js/rca-todo.js', () => ({ default: { start() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));
const { _pmPill, _augmentRow } = await import('../renderer/src/js/views/fleet.js');
const { _pmLocationRow } = await import('../renderer/src/js/views/unit-detail.js');
const { pmOverdueDays } = await import('../renderer/src/js/util/pm-overdue.js');

// Wed Nov 4 2026, 10:00 local.
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 4, 10, 0, 0)); });
afterAll(() => { vi.useRealTimers(); });

const val = (h) => (h.match(/__val">([^<]*)</) || [])[1];
const cls = (h) => (h.match(/class="(?:dp-)?pm-pill ([^"]+)"/) || [])[1];

describe('pmOverdueDays (raw due field)', () => {
  it('reads "Overdue N days" and past "Mon D, YYYY" dates as calendar days', () => {
    expect(pmOverdueDays('Overdue 12 days')).toBe(12);
    expect(pmOverdueDays('Overdue 1 day')).toBe(1);
    expect(pmOverdueDays('Oct 28, 2026')).toBe(7);
    expect(pmOverdueDays('Nov 3, 2026')).toBe(1);
  });
  it('returns null when no day count is known', () => {
    for (const r of [undefined, null, '', '--', 'Overdue 5 months', 'Sep 2026', 'Nov 4, 2026', 'Jan 19, 2027', 'garbage']) {
      expect(pmOverdueDays(r)).toBe(null);
    }
  });
});

describe('Fleet table _pmPill', () => {
  it('overdue with a known day count renders "<label> <N>d over" in red', () => {
    const h = _pmPill('DOT', 'overdue', 'Oct 28, 2026');
    expect(h).toContain('<span class="pm-pill__lbl">DOT</span><span class="pm-pill__val">7d over</span>');
    expect(cls(h)).toBe('pm-pill--overdue');
    const b = _pmPill('B', 'overdue', 'Overdue 12 days');
    expect(val(b)).toBe('12d over');
    expect(cls(b)).toBe('pm-pill--overdue');
  });
  it('due today renders "<label> due today" (not "0d over")', () => {
    const h = _pmPill('X', 'Nov 4');
    expect(val(h)).toBe('due today');
    expect(cls(h)).toBe('pm-pill--overdue');
  });
  it('literal "overdue" with no day count keeps "<label> overdue"', () => {
    for (const raw of [undefined, '', 'Overdue 5 months', 'Sep 2026']) {
      const h = _pmPill('DOT', 'overdue', raw);
      expect(val(h)).toBe('overdue');
      expect(cls(h)).toBe('pm-pill--overdue');
    }
  });
  it('future dates render unchanged with their soon/ok/far class', () => {
    expect([val(_pmPill('B', 'Nov 20')), cls(_pmPill('B', 'Nov 20'))]).toEqual(['Nov 20', 'pm-pill--soon']);
    expect([val(_pmPill('B', 'Dec 20')), cls(_pmPill('B', 'Dec 20'))]).toEqual(['Dec 20', 'pm-pill--ok']);
    expect([val(_pmPill('Q', 'Mar 1')), cls(_pmPill('Q', 'Mar 1'))]).toEqual(['Mar 1', 'pm-pill--far']);
    expect(_pmPill('B', '--')).toBe('');
  });
  it('PM Dates cell for an overdue unit shows "DOT 7d over" (via _augmentRow)', () => {
    const row = { equipmentId: 'U1', dot: 'overdue', dotDue: 'Oct 28, 2026', pmB: 'overdue', pmBDue: 'Overdue 12 days', pmX: 'Nov 20', pmXDue: 'Nov 20, 2026' };
    const h = _augmentRow(row)._pmDates;
    expect(h).toContain('<span class="pm-pill__lbl">DOT</span><span class="pm-pill__val">7d over</span>');
    expect(h).toContain('<span class="pm-pill__lbl">B</span><span class="pm-pill__val">12d over</span>');
    expect(h).toContain('<span class="pm-pill__lbl">X</span><span class="pm-pill__val">Nov 20</span>');
  });
});

describe('unit drawer _pmLocationRow', () => {
  it('mirrors the table: Nd over / due today / overdue / future date', () => {
    const h = _pmLocationRow({
      dot: 'overdue', dotDue: 'Oct 28, 2026',
      pmB: 'overdue', pmBDue: 'Overdue 5 months',
      pmX: 'Nov 4', pmXDue: 'Nov 4, 2026',
      quarterlyLift: 'Nov 20', quarterlyLiftDue: 'Nov 20, 2026',
    });
    expect(h).toContain('<span class="dp-pm-pill dp-pm-pill--overdue"><span class="dp-pm-pill__lbl">DOT</span><span class="dp-pm-pill__val">7d over</span>');
    expect(h).toContain('<span class="dp-pm-pill dp-pm-pill--overdue"><span class="dp-pm-pill__lbl">PM B</span><span class="dp-pm-pill__val">overdue</span>');
    expect(h).toContain('<span class="dp-pm-pill dp-pm-pill--overdue"><span class="dp-pm-pill__lbl">PM X</span><span class="dp-pm-pill__val">due today</span>');
    expect(h).toContain('<span class="dp-pm-pill dp-pm-pill--soon"><span class="dp-pm-pill__lbl">Qtrly Lift</span><span class="dp-pm-pill__val">Nov 20</span>');
  });
});
