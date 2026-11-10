// tests/fleet-dbr-render.test.js — pure renderer helpers of the Daily Call
// Fleet DBR panel (renderer/src/js/views/fleet-dbr-logic.js): the 24-column
// table, TSV copy order/quoting, hide-zero, auto-draft eligibility, notes and
// the panel frame. The view model is the real main-process one
// (buildFleetDbr + applyOverlays on the synthetic fixture), no real data.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

vi.mock('../renderer/src/js/bridge.js', () => ({ fleetDbr: {} }));

const L = await import('../renderer/src/js/views/fleet-dbr-logic.js');
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeFleetRows } = require('./fixtures/fleet-dbr/make-rows');

const HEADERS = [
  'FAS Name', 'Domicile', 'Domicile Uptime', 'Domicile Units Down', 'SCAC', 'SCAC Uptime', 'SCAC Units Down',
  '1P Vendor Barrier Y/N?', '1P Vendor Barrier \u2014 Details', 'OEM Barrier Y/N?', 'OEM Barrier \u2014 Details',
  'Estimate Barrier Y/N?', 'Estimate Barrier \u2014 Details', 'Partner Barrier Y/N?', 'Partner Barrier \u2014 Details',
  'Parts Delay Y/N?', 'Parts Delay \u2014 Details', 'Common Repairs Y/N?', 'Common Repairs \u2014 Details',
  'Expected units with ETC for Today', 'NO ETC', 'Missed ETC', 'FAS Actions', 'Where Do You Need Support?',
];
const TODAY = '2026-11-10';

function model(overlays = {}) {
  const built = F.buildFleetDbr(makeFleetRows(), { today: TODAY });
  built.builtAt = '2026-11-10T15:31:00Z';
  built.fleetSyncedAt = '2026-11-10T15:30:00Z';
  return F.applyOverlays(built, { today: TODAY, flags: { aiDraft: true }, ...overlays });
}
const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

describe('tableHtml', () => {
  const m = model();
  const html = L.tableHtml(m, { aiDraft: true });

  it('renders the 24 headers in exact order plus one UI-only column', () => {
    const ths = [...html.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((x) => unescape(x[1]));
    expect(ths.length).toBe(25);
    expect(ths.slice(0, 24)).toEqual(HEADERS);
    expect(ths[24]).toBe('Units / Row');
    expect(m.columns.map((c) => c.header)).toEqual(HEADERS);
  });

  it('textareas only for editable columns, each with an aria-label; Y/N and metric cells are read-only', () => {
    const tas = [...html.matchAll(/<textarea[^>]*data-key="([^"]+)" data-col="([^"]+)" aria-label="([^"]+)"/g)];
    expect(tas.length).toBe(m.rows.length * F.EDITABLE_IDS.length);
    expect(new Set(tas.map((t) => t[2]))).toEqual(new Set(F.EDITABLE_IDS));
    for (const ro of ['domicile', 'domicileUptime', 'domicileDown', 'scac', 'scacUptime', 'scacDown', 'vendor1pYN', 'oemYN', 'estimateYN', 'partnerYN', 'partsYN', 'commonYN']) {
      expect(html).not.toContain('data-col="' + ro + '"');
    }
    expect(html).toContain('aria-label="FAS Actions \u2014 ROC5/AUVTE"');
    expect(html).toMatch(/<textarea class="dc-input fdbr-cell"/);
  });

  it('escapes every interpolated value (no raw <script>)', () => {
    const m2 = model({ edits: { 'ROC5|AUVTE': { fasActions: '<script>alert(1)</script>' } } });
    const h = L.tableHtml(m2, { aiDraft: true });
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toContain('edited');
  });

  it('per-row Redraft only when aiDraft and the row has down units; drill-down shows FAS source', () => {
    const zero = m.rows.find((r) => r.pair.down === 0);
    const down = m.rows.find((r) => r.pair.down > 0);
    expect(html).toContain('data-fdbr-action="redraft" data-key="' + down.key + '"');
    expect(html).not.toContain('data-fdbr-action="redraft" data-key="' + zero.key + '"');
    expect(L.tableHtml(m, { aiDraft: false })).not.toContain('data-fdbr-action="redraft"');
    expect(html).toContain('FAS source: none');
    const r = model({ rosterFas: { [down.key]: 'Roster Person' } }).rows.find((x) => x.key === down.key);
    expect(L.unitsDrillHtml(r)).toContain('FAS source: roster (roster: Roster Person)');
  });

  it('hideZero drops 0-down rows from the table', () => {
    const h = L.tableHtml(m, { hideZero: true });
    const keys = [...h.matchAll(/<tr data-key="([^"]+)">/g)].map((x) => x[1]);
    expect(keys.length).toBe(m.rows.filter((r) => r.pair.down > 0).length);
  });

  it('getValue overrides the model value in the cell', () => {
    const k = m.rows[0].key;
    const h = L.tableHtml(m, { getValue: (r, c) => (r.key === k && c === 'fasActions' ? 'LIVE TEXT' : r.cells[c]) });
    expect(h).toContain('>LIVE TEXT</textarea>');
  });
});

describe('rowsToTsv', () => {
  const m = model();
  it('emits exactly 24 tab-separated cells per row in model.columns order', () => {
    const tsv = L.rowsToTsv(m.columns, m.rows, null, {});
    const lines = tsv.split('\n');
    expect(lines.length).toBe(m.rows.length);
    for (const [i, line] of lines.entries()) {
      const cells = line.split('\t');
      expect(cells.length).toBe(24);
      expect(cells).toEqual(m.columns.map((c) => L.tsvCell(m.rows[i].cells[c.id])));
    }
  });
  it('with header puts the 24 headers first', () => {
    const tsv = L.rowsToTsv(m.columns, m.rows.slice(0, 1), null, { header: true });
    const [h, r] = tsv.split('\n');
    expect(h.split('\t')).toEqual(HEADERS);
    expect(r.split('\t').length).toBe(24);
  });
  it('quotes tab / newline / quote cells and live values override the model', () => {
    const row = m.rows[0];
    const live = (r, c) => (c === 'fasActions' ? 'a\tb' : c === 'support' ? 'line1\nline2 "x"' : r.cells[c]);
    const tsv = L.rowsToTsv(m.columns, [row], live);
    expect(tsv.endsWith('\t"a\tb"\t"line1\nline2 ""x"""')).toBe(true);
    expect(L.tsvCell('plain')).toBe('plain');
    expect(L.tsvCell(null)).toBe('');
    expect(L.tsvCell('a\rb')).toBe('"a\rb"');
  });
});

describe('visibleRows / eligibleForAutoDraft', () => {
  it('visibleRows hideZero', () => {
    const m = model();
    expect(L.visibleRows(m, false).length).toBe(21);
    expect(L.visibleRows(m, true).every((r) => r.pair.down > 0)).toBe(true);
    expect(L.visibleRows(null, true)).toEqual([]);
  });
  it('none/stale eligible; ok not; both-edited not; 0-down not', () => {
    const base = model();
    const downKeys = base.rows.filter((r) => r.pair.down > 0).map((r) => r.key);
    const zeroKey = base.rows.find((r) => r.pair.down === 0).key;
    const [okKey, staleKey, bothKey, oneKey] = downKeys;
    const okHash = base.rows.find((r) => r.key === okKey).unitsHash;
    const m = model({
      drafts: {
        [okKey]: { fasActions: 'a', support: 'b', unitsHash: okHash },
        [staleKey]: { fasActions: 'a', support: 'b', unitsHash: 'old' },
      },
      edits: { [bothKey]: { fasActions: 'x', support: 'y' }, [oneKey]: { fasActions: 'x' } },
    });
    const keys = L.eligibleForAutoDraft(m);
    expect(keys).not.toContain(okKey);
    expect(keys).toContain(staleKey);
    expect(keys).not.toContain(bothKey);
    expect(keys).toContain(oneKey);
    expect(keys).not.toContain(zeroKey);
    expect(keys.length).toBe(downKeys.length - 2);
  });
});

describe('statusLine', () => {
  it('counts rows/down, AI progress and rows using your name', () => {
    const m = model({ fasNameOverride: 'Me', rosterFas: { 'ROC5|AUVTE': 'R' } });
    const s = L.statusLine(m, { ai: { done: 3, total: 7 } });
    expect(s).toContain('21 rows');
    expect(s).toContain(m.downCount + ' down');
    expect(s).toContain('AI 3/7');
    expect(s).toContain('20 rows use your name (no roster match)');
    expect(s).toMatch(/^Built \d\d:\d\d from fleet sync \d\d:\d\d/);
    expect(L.statusLine(model())).not.toContain('your name');
  });
});

describe('panelHtml', () => {
  const ready = L.panelHtml({ status: 'ready', aiDraft: true, fasName: '' });
  it('has its own #dbr-overlay scoped styles (copied from the old panel) plus sticky header and fdbr-cell', () => {
    expect(ready).toContain('#dbr-overlay .dc-table { width: 100%; border-collapse: collapse; }');
    expect(ready).toContain('#dbr-overlay .dc-input.dbr-cell--autogrow { resize: none; overflow: hidden; min-height: 36px; }');
    expect(ready).toContain('#dbr-overlay .fdbr-cell { resize: none; overflow: hidden; min-height: 36px; }');
    expect(ready).toMatch(/thead th \{ position: sticky; top: 0;/);
  });
  it('shows Build from fleet data, Copy buttons, hide-zero, the ETC best-effort note and the OEM note', () => {
    expect(ready).toContain('data-fdbr-action="build">\u21ba Build from fleet data</button>');
    expect(ready).toContain('data-fdbr-action="copy"');
    expect(ready).toContain('data-fdbr-action="copy-header"');
    expect(ready).toContain('data-fdbr-field="hideZero"');
    expect(ready).toContain(L.esc(L.ETC_NOTE));
    expect(ready).toContain('ETC is best-effort');
    expect(ready).toContain(L.esc(L.OEM_NOTE));
    expect(ready).toContain('id="fdbr-title"');
    expect(ready).toContain('placeholder="Enter your FAS name"');
  });
  it('AI buttons present only when aiDraft; Stop while drafting', () => {
    expect(ready).toContain('data-fdbr-action="draft-all"');
    expect(L.panelHtml({ status: 'ready', aiDraft: true, drafting: true })).toContain('data-fdbr-action="stop"');
    const noAi = L.panelHtml({ status: 'ready', aiDraft: false });
    expect(noAi).not.toContain('draft-all');
    expect(noAi).not.toContain('data-fdbr-action="stop"');
    expect(noAi).not.toContain(L.AI_NOTE);
  });
  it('off notice when disabled (no toolbar, no table)', () => {
    const off = L.panelHtml({ status: 'off' });
    expect(off).toContain('Fleet DBR is turned off (settings.dbr.fleetData = false).');
    expect(off).not.toContain('data-fdbr-action="build"');
    expect(L.panelHtml({ status: 'unavailable' })).toContain('Fleet DBR unavailable in this build');
  });
  it('escapes the FAS name and lists conflicts', () => {
    const h = L.panelHtml({ status: 'ready', fasName: '"><img src=x>', conflicts: [{ id: 'T0001' }] });
    expect(h).not.toContain('<img');
    expect(h).toContain('T0001');
  });
});
