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
    for (const ro of ['domicile', 'domicileUptime', 'domicileDown', 'scac', 'scacUptime', 'scacDown']) {
      expect(html).not.toContain('data-col="' + ro + '"');
    }
    // The 6 Y/N AI cells are read-only <td data-key data-col> (patchable), never textareas.
    for (const yn of ['vendor1pYN', 'oemYN', 'estimateYN', 'partnerYN', 'partsYN', 'commonYN']) {
      expect(html).not.toMatch(new RegExp('<textarea[^>]*data-col="' + yn + '"'));
      expect(html).toContain('<td data-key="ROC5|AUVTE" data-col="' + yn + '">');
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
    const r = model({ rosterExact: { [down.key]: 'Roster Person' }, rosterFas: { [down.key]: 'Roster Person' } }).rows.find((x) => x.key === down.key);
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
      // "both edited" = every editable AI cell edited (Details, ETC, FAS Actions, Support).
      edits: { [bothKey]: Object.fromEntries(F.AI_CELL_IDS.filter((id) => F.EDITABLE_IDS.includes(id)).map((id) => [id, 'x'])), [oneKey]: { fasActions: 'x', support: 'y' } },
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

// A v3 draft over the real builder row (overlay v3: only d.sheet prose cells overlay).
const KEY = 'ROC5|AUVTE';
function v2Model(draftOver = {}, overlays = {}) {
  const built = F.buildFleetDbr(makeFleetRows(), { today: TODAY });
  const row = built.rows.find((r) => r.key === KEY);
  const u0 = row.units[0].id;
  const d = Object.assign({
    version: 3, unitsHash: row.unitsHash, evidenceHash: row.evidenceHash, draftedAt: 'X',
    unitNotes: { oemDetails: '\u2022 ' + u0 + ': at dealer', fasActions: '\u2022 ' + u0 + ': called TA' },
    sheet: { oemYN: 'Y', oemDetails: 'Volvo offsite: ' + u0 + '.', fasActions: 'Following up on ' + u0 + ' <b>diag</b>.' },
    sources: { oemYN: 'ai', oemDetails: 'ai', partsYN: 'ai', partsDetails: 'ai', fasActions: 'ai' },
    flags: { partsYN: 'review', fasActions: 'review' },
    disagreements: ['parts'],
    etcUnits: [{ unit: u0, state: 'none', date: '', origin: 'ai', why: "ETC 11/08 cancelled <i>x</i>" }],
    etcDisagreements: [{ unit: u0, ai: '11/08', code: '11/14' }],
    etcOverrides: [{ unit: u0, code: '11/08' }],
    provenance: { fasActions: { [u0]: [{ date: '11/10', quote: 'called TA re <tech>' }] }, oemDetails: { [u0]: [{ date: '11/10', quote: 'called TA re <tech>' }] } },
    unverifiedNames: [{ name: 'Vanguard<script>', units: [u0], cell: 'partsDetails' }],
    unboundDates: [{ unit: u0, cell: 'partsDetails', date: '11/09', kw: 'eta' }],
    identity: { alias: true, names: 1, fasTagged: 1 },
  }, draftOver);
  const m = F.applyOverlays(built, Object.assign({ today: TODAY, flags: { aiDraft: true }, drafts: { [KEY]: d } }, overlays));
  return { m, row: m.rows.find((r) => r.key === KEY), u0 };
}

describe('AI markers, drill-down and flags (FEAT-004)', () => {
  it('24 <th> with AI on and off; AI off shows no AI / ⚠ markers even with a stored v2 draft (AC12)', () => {
    const on = v2Model().m;
    const off = v2Model({}, { flags: { aiDraft: false } }).m;
    for (const [mm, ai] of [[on, true], [off, false]]) {
      const h = L.tableHtml(mm, { aiDraft: ai });
      const ths = [...h.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((x) => unescape(x[1]));
      expect(ths.slice(0, 24)).toEqual(HEADERS);
      expect(ths.length).toBe(25);
    }
    const hOff = L.tableHtml(off, { aiDraft: false });
    expect(hOff).not.toContain('<span class="fdbr-mark">AI</span>');
    expect(hOff).not.toContain('\u26a0 check');
  });

  it('AI marker on AI sheet cells only; Y/N cells stay computed (Yes/No on screen, no AI marker); escaped values', () => {
    const { m, row } = v2Model();
    const h = L.tableHtml(m, { aiDraft: true });
    expect(h).toContain('<td data-key="ROC5|AUVTE" data-col="oemYN">No</td>');
    expect(h).toContain('<td data-key="ROC5|AUVTE" data-col="partsYN">No</td>');
    expect(row.cells.oemDetails).toBe(''); // computed N -> the draft's Details is not overlaid
    expect(row.source.fasActions).toBe('ai');
    expect(L.markHtml(row, 'fasActions')).toBe('<span class="fdbr-mark">AI</span>');
    expect(h).not.toContain('<b>diag</b>');
    expect(h).toContain('&lt;b&gt;diag&lt;/b&gt;');
    expect(L.cellInnerHtml(row, 'oemYN')).toBe('No');
    // An edited cell shows "edited".
    const e = v2Model({}, { edits: { [KEY]: { fasActions: 'mine' } } }).row;
    expect(L.markHtml(e, 'fasActions')).toBe('<span class="fdbr-mark">edited</span>');
    expect(L.PANEL_CSS).toContain('.fdbr-mark--warn');
  });

  it('drill-down: AI ETC, ETC disagreement / override, sources, unit notes, unverified names, unbound dates, AI vs rules (all escaped)', () => {
    const { row, u0 } = v2Model();
    const d = L.unitsDrillHtml(row);
    expect(d).toContain('AI note (oemDetails): at dealer');
    expect(d).toContain('AI note (fasActions): called TA \u26a0 check'); // the draft's soft flag, drill-down only
    expect(d).not.toContain('AI note (oemDetails): at dealer \u26a0');
    expect(d.indexOf('AI note')).toBeGreaterThan(d.indexOf('<strong>' + u0 + '</strong>'));
    expect(d).toContain('AI ETC: none (ai)');
    expect(d).toContain('ETC: AI 11/08 vs rules 11/14');
    expect(d).toContain('ETC: AI none (rules 11/08) \u2014 &#39;ETC 11/08 cancelled &lt;i&gt;x&lt;/i&gt;&#39;');
    expect((d.match(/sources: 11\/10 \[FAS\] &#39;called TA re &lt;tech&gt;&#39;/g) || []).length).toBe(1); // de-duplicated
    expect(d).toContain('unverified name: Vanguard&lt;script&gt; (partsDetails)');
    expect(d).toContain('unbound date: eta 11/09 (partsDetails)');
    expect(d).toContain('AI vs rules: Parts Delay AI=Y rules=N'); // the cell holds the rules' N
    expect(d).not.toContain('<script>');
    expect(d).not.toContain('<tech>');
  });

  it('AC37: rules own partsYN (N kept, never flagged); draft soft flags stay on the unit notes, so flaggedCount counts only row.flags', () => {
    const { row } = v2Model();
    expect(row.cells.partsYN).toBe('N');
    expect(row.source.partsYN).toBe('computed');
    expect(row.flags).toEqual({});
    expect(row.unitNoteFlags).toEqual({ fasActions: 'review' });
    expect(L.flaggedCount([row])).toBe(0);
    const flagged = { flags: { fasActions: 'review', support: 'review' }, source: {} };
    expect(L.flaggedCount([flagged])).toBe(2);
    expect(L.flaggedCount([flagged], (r, id) => id === 'fasActions')).toBe(1);
  });

  it('AC13 / AC32: auto queue = units/identity-stale rows; format/evidence-stale only when mine; Draft all queues them all', () => {
    const mine = { rosterExact: { [KEY]: 'Me' }, rosterLoaded: true, fasNameOverride: 'Me' };
    for (const [over, why] of [[{ evidenceHash: 'old' }, 'evidence'], [{ version: 2 }, 'format']]) {
      const notMine = v2Model(over).m;
      expect(notMine.rows.find((r) => r.key === KEY).draft.staleReason).toBe(why);
      expect(L.eligibleForAutoDraft(notMine)).not.toContain(KEY);
      expect(L.eligibleForAutoDraft(notMine, { includeEvidenceStale: true })).toContain(KEY);
      const m = v2Model(over, mine).m;
      expect(m.rows.find((r) => r.key === KEY).mine).toBe(true);
      expect(L.eligibleForAutoDraft(m)).toContain(KEY);
    }
    const units = v2Model({ unitsHash: 'old' }).m;
    expect(L.eligibleForAutoDraft(units)).toContain(KEY);
    const id = v2Model({ identity: { alias: false, names: 0, fasTagged: 0 } }, { fasAliasKnown: true }).m;
    expect(id.rows.find((r) => r.key === KEY).draft.staleReason).toBe('identity');
    expect(L.eligibleForAutoDraft(id)).toContain(KEY);
    expect(L.eligibleForAutoDraft(v2Model().m)).not.toContain(KEY);
    expect(L.eligibleForAutoDraft(v2Model({}, mine).m)).not.toContain(KEY); // ok draft: never re-queued
  });

  it('AC40: ETA in the status line', () => {
    expect(L.etaMinutes({ done: 2, total: 20, startedAt: 1000, now: 1000 + 4 * 60000, slots: 2 })).toBe(36);
    expect(L.etaMinutes({ done: 0, total: 20, startedAt: 1000, now: 5000, slots: 2 })).toBe(40);
    expect(L.statusLine(model(), { ai: { done: 2, total: 20, etaMin: 36 } })).toContain('AI 2/20 \u00b7 ~36 min left');
    expect(L.statusLine(model(), { ai: { done: 20, total: 20, etaMin: 0 } })).not.toContain('min left');
  });

  it('notes describe who owns the cells (DR2-9) and the ETC / OEM rules', () => {
    expect(L.AI_NOTE).toBe('Y/N and counts come from rules. AI writes only Details, FAS Actions and Support, and only when its sentence passes the fact check; otherwise auto text is shown.');
    expect(L.ETC_NOTE).toContain('whole-number');
    expect(L.ETC_NOTE).toContain('drill-down');
    expect(L.ETC_NOTE).toContain("saved 'No ETC' note");
    expect(L.OEM_NOTE).toContain('released');
    expect(L.OEM_NOTE).not.toContain('stalled');
  });
});

describe('statusLine', () => {
  it('counts rows/down, AI progress and rows using your name', () => {
    const m = model({ fasNameOverride: 'Me', rosterExact: { 'ROC5|AUVTE': 'R' } });
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

describe('SCAC filter', () => {
  const SCACS = ['AGNLI', 'AKJJI', 'AUVTE', 'AZNG', 'EOFE', 'MIMY', 'SAPB', 'SHIL', 'TUZR', 'UNNE', 'YTSC'];
  const m = model();
  const keysOf = (rows) => rows.map((r) => r.key);

  it('scacOptions: distinct, sorted SCACs; [] for no model', () => {
    expect(L.scacOptions(m)).toEqual(SCACS);
    expect(L.scacOptions(null)).toEqual([]);
    expect(L.scacOptions({ rows: [{ scac: 'B' }, { scac: 'A' }, { scac: 'B' }, { scac: '' }, {}] })).toEqual(['A', 'B']);
  });

  it('normalizeScacs drops absent SCACs, dedupes and sorts; accepts a Set', () => {
    expect(L.normalizeScacs(['TUZR', 'ZZZZ', 'SAPB', 'TUZR'], m)).toEqual(['SAPB', 'TUZR']);
    expect(L.normalizeScacs(new Set(['TUZR']), m)).toEqual(['TUZR']);
    expect(L.normalizeScacs(['ZZZZ'], m)).toEqual([]);
    expect(L.normalizeScacs(undefined, m)).toEqual([]);
    expect(L.normalizeScacs('TUZR', m)).toEqual([]);
  });

  it('visibleRows narrows to the selected SCACs; empty = all; honours hideZero; absent SCACs ignored', () => {
    const tuzr = L.visibleRows(m, false, ['TUZR']);
    expect(tuzr.length).toBe(3);
    expect(tuzr.every((r) => r.scac === 'TUZR')).toBe(true);
    expect(L.visibleRows(m, false, ['TUZR', 'SAPB']).length).toBe(5);
    expect(L.visibleRows(m, false, new Set(['TUZR', 'SAPB'])).length).toBe(5);
    expect(L.visibleRows(m, false, []).length).toBe(21);
    expect(L.visibleRows(m, false, undefined).length).toBe(21);
    const hz = L.visibleRows(m, true, ['TUZR']);
    expect(hz.length).toBe(2);
    expect(hz.every((r) => r.pair.down > 0 && r.scac === 'TUZR')).toBe(true);
    expect(keysOf(L.visibleRows(m, false, ['TUZR', 'ZZZZ']))).toEqual(keysOf(tuzr));
    expect(L.visibleRows(m, false, ['ZZZZ']).length).toBe(21);
  });

  it('eligibleForAutoDraft only returns visible rows; other rules unchanged', () => {
    const tuzrDown = m.rows.filter((r) => r.scac === 'TUZR' && r.pair.down > 0).map((r) => r.key);
    expect(L.eligibleForAutoDraft(m, { scacs: ['TUZR'] })).toEqual(tuzrDown);
    expect(tuzrDown.length).toBe(2);
    expect(L.eligibleForAutoDraft(m).length).toBe(m.rows.filter((r) => r.pair.down > 0).length);
    expect(L.eligibleForAutoDraft(m, { scacs: ['TUZR'], hideZero: true })).toEqual(tuzrDown);
    // an ok-drafted TUZR row is not re-drafted
    const okKey = tuzrDown[0];
    const okHash = m.rows.find((r) => r.key === okKey).unitsHash;
    const withOk = model({ drafts: { [okKey]: { fasActions: 'a', support: 'b', unitsHash: okHash } } });
    expect(L.eligibleForAutoDraft(withOk, { scacs: ['TUZR'] })).toEqual([tuzrDown[1]]);
    // evidence-stale still honours includeEvidenceStale under a SCAC filter (KEY = ROC5|AUVTE)
    const ev = v2Model({ evidenceHash: 'old' }).m;
    expect(L.eligibleForAutoDraft(ev, { scacs: ['AUVTE'] })).toEqual([]);
    expect(L.eligibleForAutoDraft(ev, { scacs: ['AUVTE'], includeEvidenceStale: true })).toEqual([KEY]);
    expect(L.eligibleForAutoDraft(ev, { scacs: ['TUZR'], includeEvidenceStale: true })).not.toContain(KEY);
  });

  it('aiProgress counts only visible keys', () => {
    expect(L.aiProgress({ sessionKeys: ['a', 'b', 'c'], doneKeys: ['a', 'c'], visibleKeys: ['a', 'b'] })).toEqual({ done: 1, total: 2 });
    expect(L.aiProgress({ sessionKeys: new Set(['a']), doneKeys: new Set(), visibleKeys: new Set() })).toEqual({ done: 0, total: 0 });
    expect(L.aiProgress()).toEqual({ done: 0, total: 0 });
  });

  it('statusLine reflects the filtered rows; unchanged with no filter', () => {
    const s = L.statusLine(m, { scacs: ['TUZR'], ai: { done: 1, total: 2 } });
    expect(s).toContain('3 of 21 rows');
    expect(s).toContain('7 down');
    expect(s).toContain('SCAC: TUZR');
    expect(s).toContain('AI 1/2');
    expect(L.statusLine(m, { scacs: ['SAPB', 'TUZR'] })).toContain('SCAC: SAPB, TUZR');
    expect(L.statusLine(m, {})).toBe(L.statusLine(m));
    expect(L.statusLine(m, { scacs: ['ZZZZ'] })).toBe(L.statusLine(m));
    expect(L.statusLine(m, {})).toContain('21 rows');
  });

  it('panelHtml renders the checkbox group (escaped), checked state and All SCACs button', () => {
    const h = L.panelHtml({ status: 'ready', scacOptions: ['SAPB', 'TUZR'], scacs: ['TUZR'] });
    expect((h.match(/data-fdbr-field="scac"/g) || []).length).toBe(2);
    expect(h).toContain('<legend>SCAC</legend>');
    expect(h).toContain('data-scac="TUZR" value="TUZR" checked>');
    expect(h).toContain('data-scac="SAPB" value="SAPB">');
    expect(h).toContain('data-fdbr-action="scac-all"');
    expect(L.panelHtml({ status: 'ready', scacOptions: ['SAPB'], scacs: [] })).not.toContain('scac-all');
    expect(L.panelHtml({ status: 'ready' })).not.toContain('fdbr-scac"');
    const x = L.panelHtml({ status: 'ready', scacOptions: ['"><b>'], scacs: [] });
    expect(x).not.toContain('"><b>');
    expect(x).toContain('&quot;&gt;&lt;b&gt;');
    expect(L.PANEL_CSS).toContain('.fdbr-scac {');
  });

  it('tableHtml renders only the filtered rows, keeps 25 <th>, and explains an empty filtered view', () => {
    const h = L.tableHtml(m, { scacs: ['TUZR'] });
    expect((h.match(/<tr data-key=/g) || []).length).toBe(3);
    expect((h.match(/<th scope="col">/g) || []).length).toBe(25);
    const onlyZero = { ...m, rows: m.rows.map((r) => (r.scac === 'UNNE' ? r : { ...r })) };
    expect(L.tableHtml(onlyZero, { scacs: ['UNNE'], hideZero: true })).toContain('No rows with down units for the selected SCACs');
    expect(L.tableHtml({ ...m, rows: m.rows.map((r) => ({ ...r, pair: { ...r.pair, down: 0 } })) }, { hideZero: true })).toContain('Every row has 0 down');
  });
});

describe('Copy fill columns', () => {
  const FILL = [
    '1P Vendor Barrier Y/N?', '1P Vendor Barrier \u2014 Details', 'OEM Barrier Y/N?', 'OEM Barrier \u2014 Details',
    'Estimate Barrier Y/N?', 'Estimate Barrier \u2014 Details', 'Partner Barrier Y/N?', 'Partner Barrier \u2014 Details',
    'Parts Delay Y/N?', 'Parts Delay \u2014 Details', 'Common Repairs Y/N?', 'Common Repairs \u2014 Details',
    'Expected units with ETC for Today', 'NO ETC', 'Missed ETC', 'FAS Actions', 'Where Do You Need Support?',
  ];
  const IDENTITY = ['fasName', 'domicile', 'domicileUptime', 'domicileDown', 'scac', 'scacUptime', 'scacDown'];

  it('fillColumns = the 17 AI fill columns in sheet order, identity/count columns excluded', () => {
    const m = model();
    const cols = L.fillColumns(m);
    expect(cols.map((c) => c.header)).toEqual(FILL);
    expect(FILL).toEqual(HEADERS.slice(7));
    for (const id of IDENTITY) expect(cols.map((c) => c.id)).not.toContain(id);
    expect(L.fillColumns(null)).toEqual([]);
  });

  it('fillColumnsTsv: 17 cells per row, one line per row, tabs / newlines flattened, live values used', () => {
    const { m, row } = v2Model();
    const rows = [row, m.rows.find((r) => r.key !== KEY)];
    const live = (r, c) => (r.key === KEY && c === 'support' ? 'a\tb\r\n  c\n\nd' : r.cells[c]);
    const tsv = L.fillColumnsTsv(m, rows, live);
    const lines = tsv.split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line.split('\t').length).toBe(17);
    const first = lines[0].split('\t');
    expect(first[16]).toBe('a b c d');
    expect(first[2]).toBe('N'); // oemYN stays the rules' value; the draft's Y is never overlaid
    expect(first[15]).toBe(L.fillCell(row.cells.fasActions));
    expect(lines[1].split('\t')).toEqual(L.fillColumns(m).map((c) => L.fillCell(rows[1].cells[c.id])));
    expect(L.fillCell(null)).toBe('');
    expect(L.fillCell('\u2022 x\n\u2022 y')).toBe('\u2022 x \u2022 y');
  });

  it('panelHtml has the Copy fill columns button next to the other copy actions', () => {
    expect(L.panelHtml({ status: 'ready' })).toContain('data-fdbr-action="copy-fill">\ud83d\udccb Copy fill columns</button>');
  });
});

// ── Copy for SharePoint, freshness, markers (design §3.5, §3.12, §3.13; FEAT-004) ──
const ME = 'Z Santiago';
const MINE_KEYS = ['ROC5|AUVTE', 'ABE40|SAPB', 'AVP40|YTSC'];
const rosterModel = (over = {}) => model(Object.assign({
  rosterExact: Object.fromEntries(MINE_KEYS.map((k) => [k, ME]).concat([['HBD1|AKJJI', 'Other FAS']])),
  rosterFas: { 'MIMY01|MIMY': 'Site Match' }, rosterLoaded: true, fasNameOverride: ME,
}, over));

describe('sheetValue / sheetTsv (golden format, I4)', () => {
  it('sheetValue per column type; user-edited counts are copied as typed (DR2-6)', () => {
    expect(L.sheetValue('oemYN', 'Y')).toBe('Yes');
    expect(L.sheetValue('oemYN', 'n')).toBe('No');
    expect(L.sheetValue('domicileUptime', '69%')).toBe('69');
    expect(L.sheetValue('scacUptime', '83.3%')).toBe('83.3');
    expect(L.sheetValue('missedEtc', '1\n\u2022 211022 (ETC 11/9): waiting')).toBe('1');
    expect(L.sheetValue('missedEtc', '1\n\u2022 211022 (ETC 11/9): waiting', 'computed')).toBe('1');
    expect(L.sheetValue('missedEtc', '1 \u2013 211022: waiting on parts', 'edit')).toBe('1 \u2013 211022: waiting on parts');
    expect(L.sheetValue('missedEtc', '1 \u2013 211022:\nwaiting on parts', 'edit')).toBe('1 \u2013 211022: waiting on parts');
    expect(L.sheetValue('noEtc', '7')).toBe('7');
    expect(L.sheetValue('fasActions', 'a\tb\n c')).toBe('a b c');
    expect(L.sheetValue('domicile', 'ROC5')).toBe('ROC5');
    expect(L.sheetValue('fasName', null)).toBe('');
  });

  it('AC10: header = the 24 headers; Y/N in {Yes, No}; bare uptimes; single-line cells; bare Missed; FAS Name on the user rows', () => {
    const m = rosterModel();
    const rows = L.copyRows(m, 'mine', false, []);
    const tsv = L.sheetTsv(m.columns, rows, null, { header: true });
    const lines = tsv.split('\n');
    expect(lines[0]).toBe(HEADERS.join('\t'));
    expect(lines).toHaveLength(1 + rows.length);
    const ids = m.columns.map((c) => c.id);
    for (const line of lines.slice(1)) {
      const cells = line.split('\t');
      expect(cells).toHaveLength(24);
      for (const [i, id] of ids.entries()) {
        if (/YN$/.test(id)) expect(['Yes', 'No']).toContain(cells[i]);
        if (/Uptime$/.test(id)) expect(cells[i]).toMatch(/^\d+(\.\d)?$/);
        if (['etcToday', 'noEtc', 'missedEtc'].includes(id)) expect(cells[i]).toMatch(/^\d+$/);
      }
      expect(cells[0]).toBe(ME);
      expect(line).not.toMatch(/[\r\u2022]/);
    }
    expect(L.sheetTsv(m.columns, rows.slice(0, 1), null, {})).toBe(lines[1]);
    // getSource override: a live (unsaved) count edit copies as typed.
    const live = L.sheetTsv([{ id: 'missedEtc', header: 'Missed ETC' }], rows.slice(0, 1), () => '2 \u2013 x', { getSource: () => 'edit' });
    expect(live).toBe('2 \u2013 x');
    expect(L.sheetTsv([{ id: 'support', header: 'S' }], [{ cells: { support: 'say "hi"' }, source: {} }], null, {})).toBe('"say ""hi"""');
  });

  it('sheetOrder: mine first, then pair down desc, SCAC down desc, domicile asc, SCAC asc', () => {
    const r = (key, mine, down, sdown) => ({ key, mine, domicile: key.split('|')[0], scac: key.split('|')[1], pair: { down }, scacStats: { down: sdown } });
    const rows = [r('B|X', false, 9, 9), r('A|Z', true, 1, 4), r('A|Y', true, 1, 4), r('C|Q', true, 1, 1), r('Z|Z', true, 2, 2), r('D|D', true, 1, 4)];
    expect(L.sheetOrder(rows).map((x) => x.key)).toEqual(['Z|Z', 'A|Y', 'A|Z', 'D|D', 'C|Q', 'B|X']);
    expect(rows[0].key).toBe('B|X'); // not mutated
    expect(L.sheetOrder(null)).toEqual([]);
    // The table uses the same order.
    const m = rosterModel();
    const keys = [...L.tableHtml(m, {}).matchAll(/<tr data-key="([^"]+)">/g)].map((x) => x[1]);
    expect(keys).toEqual(L.sheetOrder(m.rows).map((x) => x.key));
    expect(keys.slice(0, 3).sort()).toEqual(MINE_KEYS.slice().sort());
  });

  it('copyRows / copyScopeInfo: mine = the user pairs with units down; visible = SCAC filter + hide-zero; DR2-13 notes', () => {
    const m = rosterModel();
    const mine = L.copyRows(m, 'mine', false, []);
    expect(mine.every((x) => x.mine && x.pair.down > 0)).toBe(true);
    expect(mine.map((x) => x.key).sort()).toEqual(MINE_KEYS.slice().sort());
    expect(L.copyRows(m, 'visible', false, []).map((x) => x.key)).toEqual(L.sheetOrder(m.rows).map((x) => x.key));
    expect(L.copyRows(m, 'visible', true, ['TUZR']).every((x) => x.scac === 'TUZR' && x.pair.down > 0)).toBe(true);
    expect(L.copyScopeInfo(m, false, [])).toEqual({ mineOk: true, note: '', mineCount: 3, visibleCount: 21 });
    const noRoster = model({ fasNameOverride: ME });
    expect(L.copyScopeInfo(noRoster).note).toBe('FAS roster not loaded \u2014 copying all visible rows');
    expect(L.copyRows(noRoster, 'mine', true, []).length).toBe(noRoster.rows.filter((x) => x.pair.down > 0).length);
    expect(L.copyScopeInfo(rosterModel({ fasNameOverride: '' })).note).toBe('Set your FAS name to copy only your pairs');
    const typo = rosterModel({ fasNameOverride: 'Z Santiagoo' });
    expect(L.copyScopeInfo(typo)).toMatchObject({ mineOk: false, note: "No roster pairs match 'Z Santiagoo' \u2014 check your FAS name" });
    expect(L.copyRows(typo, 'mine', false, []).length).toBe(21);
  });

  it('AC15: with the roster loaded, rows without an exact pair have an empty FAS Name in every scope; "site match" is screen-only', () => {
    const m = rosterModel();
    const mimy = m.rows.find((x) => x.key === 'MIMY01|MIMY');
    expect([mimy.cells.fasName, mimy.rosterHint]).toEqual(['', 'Site Match']);
    const h = L.tableHtml(m, {});
    expect(h).toContain('<span class="fdbr-muted">site match: Site Match</span>');
    expect((h.match(/site match:/g) || []).length).toBe(1);
    for (const scope of ['mine', 'visible']) {
      const tsv = L.sheetTsv(m.columns, L.copyRows(m, scope, false, []), null, { header: true });
      expect(tsv).not.toContain('Site Match');
      expect(tsv).not.toContain('site match');
    }
    const visible = L.sheetTsv(m.columns, L.copyRows(m, 'visible', false, []), null, {}).split('\n');
    const names = new Set(visible.map((l) => l.split('\t')[0]));
    expect(names).toEqual(new Set([ME, 'Other FAS', '']));
  });

  it('on-screen non-editable cells use the sheet format (Yes/No, bare uptime)', () => {
    const h = L.tableHtml(model(), {});
    expect(h).toContain('<td>48.3</td>');
    expect(h).not.toContain('48.3%');
    expect(h).toContain('data-col="oemYN">No</td>');
  });
});

describe('freshness / stale banner / status age (AC12)', () => {
  const SYNC = Date.parse('2026-11-10T15:30:00Z');
  it('freshness: 119 min fresh, 121 min stale, missing / invalid ts stale-unknown', () => {
    const m = model();
    expect(L.FRESH_MAX_MS).toBe(2 * 60 * 60 * 1000);
    expect(L.freshness(m, SYNC + 119 * 60000)).toMatchObject({ ageMin: 119, stale: false, label: '1h 59m' });
    expect(L.freshness(m, SYNC + 121 * 60000)).toMatchObject({ ageMin: 121, stale: true, label: '2h 1m' });
    expect(L.freshness(m, SYNC + 45 * 60000).label).toBe('45m');
    expect(L.freshness({ ...m, fleetSyncedAt: null }, SYNC)).toMatchObject({ stale: true, ageMin: null, label: '' });
    expect(L.freshness({ ...m, fleetSyncedAt: 'garbage' }, SYNC).stale).toBe(true);
  });
  it('staleBannerHtml: role=alert, class fdbr-banner--stale, age + last sync; unknown text; empty when fresh', () => {
    const m = model();
    const h = L.staleBannerHtml(L.freshness(m, SYNC + 189 * 60000));
    expect(h).toContain('class="fdbr-banner fdbr-banner--stale" role="alert"');
    expect(h).toContain('\u26a0 Fleet data is 3h 9m old (last sync ' + L.fmtClock(m.fleetSyncedAt) + '). Sync, then \u21ba Rebuild before you copy for SharePoint.');
    expect(L.staleBannerHtml(L.freshness({ ...m, fleetSyncedAt: null }, SYNC))).toContain('\u26a0 Fleet sync time unknown \u2014 sync before copying.');
    expect(L.staleBannerHtml(L.freshness(m, SYNC + 119 * 60000))).toBe('');
    expect(L.PANEL_CSS).toContain('.fdbr-banner--stale');
    expect(L.VIEW_CSS).toContain('#view-dbr .fdbr-banner--stale');
  });
  it('statusLine shows the fleet data age when nowMs is given', () => {
    const m = model();
    expect(L.statusLine(m, { nowMs: SYNC + 189 * 60000 })).toMatch(/^Built \d\d:\d\d from fleet sync \d\d:\d\d \(3h 9m old\)/);
    expect(L.statusLine(m)).not.toContain(' old)');
  });

  // model.dataFreshness (main): data-as-of = the last AAP build, never the re-stamped sync time.
  const BUILD = SYNC - 60 * 60000; // AAP build 1 h before the (re-stamped) sync
  const df = (over = {}) => Object.assign({ v: 1, status: 'fresh', reasons: [], dataAsOf: new Date(BUILD).toISOString(), dataAsOfSource: 'fleet-build', rowCount: 10, lastOkCount: 10 }, over);
  it('freshness reads dataFreshness.dataAsOf before fleetSyncedAt and recomputes the age', () => {
    const m = { ...model(), dataFreshness: df() };
    expect(L.freshness(m, SYNC + 30 * 60000)).toMatchObject({ status: 'fresh', ageMin: 90, source: 'fleet-build', stale: false });
    // fleetSyncedAt is only 61 min old but the AAP build is 121 min old -> stale.
    expect(L.freshness(m, SYNC + 61 * 60000)).toMatchObject({ status: 'stale', stale: true, ageMin: 121 });
    expect(L.freshness(m, SYNC + 61 * 60000).reasons).toContain('age>120m');
  });
  it('freshness: a build from yesterday is stale (not-today) even when it is under 2 h old', () => {
    const lateBuild = new Date(2026, 10, 9, 23, 30).getTime();
    const m = { ...model(), fleetSyncedAt: new Date(2026, 10, 10, 0, 20).toISOString(), dataFreshness: df({ dataAsOf: new Date(lateBuild).toISOString() }) };
    const f = L.freshness(m, new Date(2026, 10, 10, 0, 30).getTime());
    expect(f).toMatchObject({ status: 'stale', sameDay: false });
    expect(f.reasons).toEqual(['not-today']);
    const h = L.staleBannerHtml(f, new Date(2026, 10, 10, 0, 30).getTime());
    expect(h).toContain('fdbr-banner--stale');
    expect(h).toContain('(AAP build 23:30 yesterday)');
  });
  it('staleBannerHtml red names the AAP build time; partial and refresh-failed are amber', () => {
    const m = { ...model(), dataFreshness: df() };
    const red = L.staleBannerHtml(L.freshness(m, BUILD + 189 * 60000));
    expect(red).toContain('\u26a0 Fleet data is 3h 9m old (AAP build ' + L.fmtClock(new Date(BUILD).toISOString()) + '). Sync, then \u21ba Rebuild before you copy for SharePoint.');
    const part = L.staleBannerHtml(L.freshness({ ...m, dataFreshness: df({ status: 'partial', reasons: ['rows-differ-from-last-build'], rowCount: 8 }) }, BUILD + 10 * 60000));
    expect(part).toContain('class="fdbr-banner fdbr-banner--partial" role="alert"');
    expect(part).toContain('fleet data has 8 units but the last AAP build had 10');
    const failAt = new Date(BUILD + 5 * 60000).toISOString();
    const fail = L.staleBannerHtml(L.freshness({ ...m, dataFreshness: df({ reasons: ['last-refresh-failed'], lastFailAt: failAt, lastFailCode: 'AUTH' }) }, BUILD + 10 * 60000));
    expect(fail).toContain('fdbr-banner--partial');
    expect(fail).toContain('\u26a0 AAP refresh failing since ' + L.fmtClock(failAt) + ' (AUTH) \u2014 showing the ' + L.fmtClock(new Date(BUILD).toISOString()) + ' build');
    expect(L.staleBannerHtml(L.freshness(m, BUILD + 10 * 60000))).toBe('');
    expect(L.PANEL_CSS).toContain('.fdbr-banner--partial');
    expect(L.VIEW_CSS).toContain('#view-dbr .fdbr-banner--partial');
  });
  it('statusLine: "from fleet data as of" the AAP build when dataFreshness has one', () => {
    const m = { ...model(), dataFreshness: df() };
    expect(L.statusLine(m, { nowMs: BUILD + 7 * 60000 })).toMatch(/^Built \d\d:\d\d from fleet data as of \d\d:\d\d \(7m old\)/);
    expect(L.statusLine(m, { nowMs: BUILD + 7 * 60000 })).toContain('as of ' + L.fmtClock(new Date(BUILD).toISOString()));
  });
  it('badge: an ok draft written on non-fresh data says so; evidence gap marker on the row', () => {
    const asOf = new Date(BUILD).toISOString();
    expect(L.badgeHtml({ draft: { state: 'ok', dataStatus: 'stale', dataAsOf: asOf } })).toContain('\u26a0 AI draft \u2014 drafted on stale data (as of ' + L.fmtClock(asOf) + ')');
    expect(L.badgeHtml({ draft: { state: 'ok', dataStatus: 'fresh', dataAsOf: asOf } })).toContain('\u2713 AI draft');
    expect(L.badgeHtml({ draft: { state: 'ok' } })).toContain('\u2713 AI draft');
    expect(L.evidenceGapHtml({ evidenceGaps: 2 })).toContain('\u26a0 2 unit(s) not hydrated yet \u2014 ETC may be NO ETC by default');
    expect(L.evidenceGapHtml({ evidenceGaps: 0 })).toBe('');
  });
});

describe('override marker, counts marker, drill-down lines, badge (AC7, AC13)', () => {
  const row = {
    key: 'K|S', domicile: 'K', scac: 'S', pair: { down: 2, total: 3 }, source: {},
    cells: { etcToday: '0', noEtc: '1', missedEtc: '1' },
    units: [
      { id: 'U1', daysDown: 4, etc: { state: 'missed', date: '2026-11-20', source: 'extracted', bucket: 'missed', bucketReason: 'explicit-miss',
        overrode: { field: 'savedNotes', was: 'none', userSnippet: '11/22 - No ETC' } }, why: { parts: 'Parts ordered at COX' }, systems: ['Engine', 'Cooling'] },
      { id: 'U2', daysDown: 1, etc: { state: 'none', missDowngraded: true, passedDate: '2026-11-18', bucket: 'none', bucketReason: 'newer-negation', undercut: 'Repair <b>blocked</b>' } },
    ],
    userEtcOverrides: [{ unit: 'U1', date: '2026-11-20', userSnippet: "11/22 - No ETC <x>", extractedSnippet: 'missed the ETC of 11/20' }],
    missedWhy: [{ unit: 'U1', date: '2026-11-20', why: 'ETC 11/20 explicitly missed' }],
  };
  it('Missed cell: "↺ overrode the saved note" with an escaped title naming the unit (DR2-11); not on an edited cell', () => {
    const h = L.markHtml(row, 'missedEtc');
    expect(h).toContain('>\u21ba overrode the saved note</span>');
    expect(h).toContain('title="U1: saved note &#39;11/22 - No ETC &lt;x&gt;&#39; \u2192 Relay/offsite: &#39;missed the ETC of 11/20&#39;"');
    expect(h).not.toContain('<x>');
    expect(L.markHtml({ ...row, source: { missedEtc: 'edit' } }, 'missedEtc')).toBe('<span class="fdbr-mark">edited</span>');
    expect(L.markHtml({ ...row, userEtcOverrides: [] }, 'missedEtc')).toBe('');
    // The copied cell stays a bare number.
    expect(L.sheetTsv([{ id: 'missedEtc', header: 'Missed ETC' }], [row], null, {})).toBe('1');
  });
  it('NO ETC cell: "⚠ counts ≠ N down" when the three counts do not add up', () => {
    expect(L.markHtml(row, 'noEtc')).toBe('');
    const broken = { ...row, cells: { etcToday: '0', noEtc: '5', missedEtc: '1' } };
    expect(L.markHtml(broken, 'noEtc')).toContain('\u26a0 counts \u2260 2 down');
  });
  it('drill-down: bucket reason, undercut, override line, passed-ETR line, barrier why, systems, missed why (escaped)', () => {
    const d = L.unitsDrillHtml(row);
    expect(d).toContain('Sheet: Missed ETC \u2014 explicit miss reported');
    expect(d).toContain('Missed ETC 11/20 (extracted) \u2014 overrode the saved note &#39;11/22 - No ETC&#39;');
    expect(d).toContain('Sheet: NO ETC \u2014 a newer line says the ETC is gone, unsure or blocked: &#39;Repair &lt;b&gt;blocked&lt;/b&gt;&#39;');
    expect(d).toContain('ETR 11/18 passed, no miss reported');
    expect(d).toContain('Parts Delay: Parts ordered at COX');
    expect(d).toContain('systems: Engine, Cooling');
    expect(d).toContain('Missed ETC: U1 (ETC 11/20): ETC 11/20 explicitly missed');
    expect(d).not.toContain('<b>');
  });
  it('badge: stale -> "⚠ AI draft out of date — showing auto text"', () => {
    expect(L.badgeHtml({ draft: { state: 'stale', staleReason: 'format' } })).toContain('\u26a0 AI draft out of date \u2014 showing auto text');
  });
  it('panelHtml: copy-scope select with counts; mine disabled with the note', () => {
    const ok = L.panelHtml({ status: 'ready', copyScope: 'mine', copyInfo: { mineOk: true, note: '', mineCount: 9, visibleCount: 22 } });
    expect(ok).toContain('data-fdbr-field="copyScope"');
    expect(ok).toContain('<option value="mine" selected>My pairs with units down (9)</option>');
    expect(ok).toContain('<option value="visible">All visible rows (22)</option>');
    const off = L.panelHtml({ status: 'ready', copyScope: 'mine', copyInfo: { mineOk: false, note: 'FAS roster not loaded \u2014 copying all visible rows', mineCount: 0, visibleCount: 22 } });
    expect(off).toContain('<option value="mine" disabled>My pairs with units down (0)</option>');
    expect(off).toContain('<option value="visible" selected>All visible rows (22)</option>');
    expect(off).toContain('FAS roster not loaded \u2014 copying all visible rows');
    expect(L.panelHtml({ status: 'ready' })).not.toContain('copyScope');
  });
});
