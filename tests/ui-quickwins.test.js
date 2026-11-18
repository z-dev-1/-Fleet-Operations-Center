// UI audit quick wins (Q1, Q4, Q5, Q6).
// Q1: the Fleet table comparator sorts Score and Duration numerically.
// Q4/Q5/Q6: regression guards on the stylesheet / view handlers. The live
// behaviour (computed styles, hit-testing, view visibility) was checked in a
// real Chromium renderer; see verification.md.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const _store = {};
globalThis.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() { return () => {}; }, emit() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { slice: () => ({}) } }));
vi.mock('../renderer/src/js/bridge.js', () => ({ relay: {}, ai: {}, aap: {}, fleet: {} }));
vi.mock('../renderer/src/js/components/context-menu.js', () => ({ showContextMenu() {} }));
vi.mock('../renderer/src/js/views/fleet-overview.js', () => ({ mount() {} }));
vi.mock('../renderer/src/js/rca-todo.js', () => ({ default: { start() {} } }));

const { compareRows } = await import('../renderer/src/js/views/fleet.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ids = (rows) => rows.map((r) => r.id);
const sortBy = (rows, key, dir) => ids(rows.slice().sort((a, b) => compareRows(a, b, key, dir)));

describe('Q1 fleet column sort', () => {
  const rows = [
    { id: '6d', duration: '6d', riskScore: 100 },
    { id: '62d', duration: '62d', riskScore: 60 },
    { id: '3d2h', duration: '3d 2h', riskScore: 6 },
    { id: 'none', duration: '--' },
    { id: '100d', duration: '100d', riskScore: 9 },
    { id: '12h', duration: '12h', riskScore: '75' },
  ];

  it('Duration sorts by days ascending and descending; "--" always last', () => {
    expect(sortBy(rows, 'duration', 'asc')).toEqual(['12h', '3d2h', '6d', '62d', '100d', 'none']);
    expect(sortBy(rows, 'duration', 'desc')).toEqual(['100d', '62d', '6d', '3d2h', '12h', 'none']);
  });

  it('Score sorts numerically ascending and descending; missing score always last', () => {
    expect(sortBy(rows, 'riskScore', 'asc')).toEqual(['3d2h', '100d', '62d', '12h', '6d', 'none']);
    expect(sortBy(rows, 'riskScore', 'desc')).toEqual(['6d', '12h', '62d', '100d', '3d2h', 'none']);
  });

  it('text columns keep the text compare', () => {
    const t = [{ id: 'b', vendor: 'Beta' }, { id: 'a', vendor: 'alpha' }, { id: 'c', vendor: 'Charlie' }];
    expect(sortBy(t, 'vendor', 'asc')).toEqual(['a', 'b', 'c']);
    expect(sortBy(t, 'vendor', 'desc')).toEqual(['c', 'b', 'a']);
  });
});

describe('Q4 unit-detail drawer shell', () => {
  const css = read('renderer/src/css/fleet.css');
  it('.detail-panel is declared once and anchored between topbar and status bar', () => {
    const shells = css.match(/(^|[}\s])\.detail-panel\s*\{[^}]*\}/g) || [];
    expect(shells).toHaveLength(1);
    expect(shells[0]).toContain('top:var(--topbar-h)');
    expect(shells[0]).toContain('bottom:var(--statusbar-h)');
    expect(shells[0]).not.toContain('!important');
  });
});

describe('Q5 checkbox toggle-switch styling', () => {
  const css = read('renderer/src/css/fleet.css');
  it('the switch rule is scoped to the Settings drawer, not every checkbox', () => {
    expect(css).not.toMatch(/(^|[}\n])\s*input\[type="checkbox"\](::after|:checked)*\s*\{/);
    expect(css).toMatch(/#settings-drawer input\[type="checkbox"\] \{[^}]*appearance: none/);
  });
});

describe('Q6 views ignore the settings overlay view-change', () => {
  const VIEWS = ['daily-call', 'analytics', 'schedulers', 'email-composer', 'notes-links', 'daily-notes', 'rca-queue', 'trends'];
  for (const v of VIEWS) {
    it(v + ' returns early when to === "settings"', () => {
      const src = read('renderer/src/js/views/' + v + '.js');
      const m = src.match(/bus\.on\(\s*'ui:view-change'[^\n]*\n([^\n]*)/);
      expect(m, 'ui:view-change handler').toBeTruthy();
      expect(m[1]).toMatch(/to === 'settings'\) return;/);
    });
  }
});
