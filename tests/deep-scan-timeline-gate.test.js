// tests/deep-scan-timeline-gate.test.js — relay-extract AC17 (§14.6 timeline consumer): with
// aiOutput on and a fact block on the unit, the deep-scan prompt carries VERIFIED FACTS, the
// draft ISSUE / NOTE / TIMELINE go through the shared gate, the self-review always runs and the
// timeline merge rule decides. Flag off: the prompt and output equal 1eabe04's, one askOrcha call.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Module, { createRequire } from 'module';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
import * as S from './fixtures/extract/deep-scan-output-shape.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

fx.installStubs();
const ds = require('../src/orcha/deep-scan');
const W = require('../src/repair-intel/wo-facts');
const O = require('../src/repair-intel/wo-fact-output');

const TODAY = '2026-11-11';
const ON = (o = {}) => ({ flags: Object.assign({ enabled: true, aiOutput: true, reviewRounds: 0, reviewMaxPerRun: 200 }, o), budget: { left: 200 } });

// The 1eabe04 deep-scan.js, compiled in place (same directory, so its requires hit the stubs).
function loadBase() {
  try {
    const src = execFileSync('git', ['-C', ROOT, 'show', '1eabe04:src/orcha/deep-scan.js'], { encoding: 'utf8' });
    const file = path.join(ROOT, 'src/orcha/deep-scan.base-1eabe04.js');
    const m = new Module(file, null);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(src + '\nmodule.exports._processUnit = _processUnit;\n', file);
    return m.exports;
  } catch (_) { return null; }
}
const BASE = loadBase();

function asker(responses) {
  const prompts = [];
  const opts = [];
  const fn = vi.fn(async (p, o) => {
    prompts.push(p); opts.push(o);
    const r = responses.length ? responses.shift() : null;
    return r ? { ok: true, text: r } : { ok: false, error: 'empty response' };
  });
  return { fn, prompts, opts };
}
const lines = (t) => String(t || '').split('\n');

beforeEach(() => { fx.resetRecorders(); vi.useFakeTimers({ toFake: ['Date'], now: S.NOW }); });
afterEach(() => { vi.useRealTimers(); });

describe('prompt shape (aiOutput on)', () => {
  it('carries VERIFIED FACTS with every fact id line; the timeline sheet has no $, contact names or [phone]', async () => {
    const u = S.unitRow();
    const a = asker([S.draftText(S.SHAPE_LINES)]);
    await ds._processUnit(u, {}, a.fn, ON());
    const p = a.prompts[0];
    const sheet = O.factSheet(W.buildFactSet(S.unitRow(), { today: TODAY }), { budget: 4000, purpose: 'timeline', row: S.unitRow() });
    expect(p).toContain('VERIFIED FACTS');
    for (const l of sheet.lines) expect(p).toContain(l);
    expect(sheet.text).not.toContain('$');
    expect(sheet.text).not.toContain('[phone]');
    expect(sheet.text).not.toContain('Pat');
    const rules = p.slice(p.indexOf('FACT RULES:'), p.indexOf('RESPOND IN EXACTLY'));
    expect(rules).not.toMatch(/\$ amount/);
    expect(p.indexOf('OFFSITE/VENDOR NOTES') < 0 || p.indexOf('OFFSITE/VENDOR NOTES') < p.indexOf('VERIFIED FACTS')).toBe(true);
    expect(p.indexOf('VERIFIED FACTS')).toBeLessThan(p.indexOf('RESPOND IN EXACTLY THIS FORMAT'));
  });
});

describe('line gate', () => {
  it('a real deep-scan output shape passes with zero drops (gap ranges, prefixes, 7b baseline, local-day date, marker)', async () => {
    const a = asker([S.draftText(S.SHAPE_LINES)]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(r.tlGate.drops).toEqual({});
    expect(r.tlGate.state).toBe('ok');
    expect(lines(r.timeline)).toEqual(S.SHAPE_LINES);
    expect(a.fn).toHaveBeenCalledTimes(1);   // rounds 0
  });
  it('planted lines: the returned timeline loses exactly the planted lines', async () => {
    const planted = ['11/05 - Dealer quoted Part #85152799 instead.', '11/06 - Estimate approved at $4,800.', '11/04 - Dealer gave ETC 10/26 for the unit.'];
    const a = asker([S.draftText(S.SHAPE_LINES.concat(planted))]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(lines(r.timeline)).toEqual(S.SHAPE_LINES);
    expect(Object.values(r.tlGate.drops).reduce((x, y) => x + y, 0)).toBe(3);
  });
  it('single-digit dates are accepted and stored zero-padded', async () => {
    const a = asker([S.draftText(['9/23 - Unit checked in.'])]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(r.timeline).toBe('09/23 - Unit checked in.');
  });
  it('relative dates bind to the prefix date only when the phrase is in a line of that date', async () => {
    const a = asker([S.draftText(['11/02 - Vendor hoping for the pins by thurs.', '11/02 - Parts arriving tomorrow.', '11/02 - Vendor expects pins by Thursday.', '11/03 - [Unplanned] Unit in bay; diagnosis started.'])]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(lines(r.timeline)).toEqual(['11/02 - Vendor hoping for the pins by thurs.', '11/03 - [Unplanned] Unit in bay; diagnosis started.']);
    // 'by Thursday' is dropped too: the shared gate matches the phrase as written (§27 residual 2).
    expect(r.tlGate.drops).toEqual({ 'unknown-rel-date': 2 });
  });
});

describe('stage events (rev 4)', () => {
  const fs = W.buildFactSet(S.unitRow(), { today: TODAY });
  const sheet = O.factSheet(fs, { budget: 4000, purpose: 'timeline', row: S.unitRow() });
  it('dealer stages line in CURRENT lists only current-episode changes and ends open since 11/2', async () => {
    const a = asker([S.draftText(['11/02 - Dealer moved repair to Waiting.'])]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    const p = a.prompts[0];
    const st = lines(p).find((l) => / dealer stages: /.test(l));
    expect(st).toBeTruthy();
    expect(p.indexOf('CURRENT')).toBeLessThan(p.indexOf(st));
    expect(st).not.toMatch(/\b6\/\d+/);
    expect(st).toMatch(/open since 11\/0?2$/);
    expect(r.timeline).toBe('11/02 - Dealer moved repair to Waiting.');
    expect(r.tlGate.drops).toEqual({});
  });
  it('a stage-change date never licenses an ETC; a June stage date in no prompt text is unknown-date', async () => {
    const ti = W.typedIndex(fs, { today: TODAY, rowDates: sheet.rowDates });
    const ctx = O.factContext(fs, { promptText: 'x', sheetText: sheet.text, rowDates: sheet.rowDates, today: TODAY });
    const stageMds = ['9/23', '10/1', '10/11'];
    const d = stageMds.find((m) => !ti.etcRepair.has(m) && !ti.partsDates.has(m) && !ctx.etcDates.U.has(m));
    expect(d).toBeTruthy();                                    // precondition: a stage date that is no ETC value
    const pad = d.split('/').map((x) => x.padStart(2, '0')).join('/');
    // A June (prior-episode) stage date that no prompt text and no typed fact carries.
    const june = S.stageHistory().slice(0, 6).map((h) => { const t = new Date(h.at); return (t.getMonth() + 1) + '/' + t.getDate(); })
      .find((m) => !ctx.dates.U.has(m));
    expect(june).toBeTruthy();
    const junePad = june.split('/').map((x) => x.padStart(2, '0')).join('/');
    const good = ['11/02 - Dealer moved repair to Waiting.', '11/03 - [Unplanned] Unit in bay; diagnosis started.', '11/04 - [Unplanned #2] Secondary vendor replaced the hood latch.'];
    const a = asker([S.draftText([pad + ' - Dealer ETC ' + pad + '.', junePad + ' - Dealer checked in.'].concat(good))]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(a.prompts[0]).not.toContain(junePad);
    expect(a.prompts[0]).not.toMatch(new RegExp('\\b' + june + '\\b'));
    expect(r.tlGate.drops).toEqual({ 'unknown-etc-date': 1, 'unknown-date': 1 });
    expect(lines(r.timeline)).toEqual(good);
  });
});

describe('ISSUE / NOTE', () => {
  it('a planted part # in ISSUE and NOTE returns both null and writes no fallback NOTE', async () => {
    const a = asker([S.draftText(S.SHAPE_LINES, 'Harness Part #85152799 failed') + '\nNOTE: 11/05 - Ordered Part #85152799']);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(r.summary).toBeNull();
    expect(r.correctedNotes).toBeNull();
    expect(r.timeline).not.toBeNull();
  });
  it('a clean ISSUE without NOTE gets the <today> - <summary> fallback (not dropped unknown-date)', async () => {
    const a = asker([S.draftText(S.SHAPE_LINES)]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(r.summary).toBe('Wiring harness failure');
    expect(r.correctedNotes).toBe('11/11 - Wiring harness failure');
  });
  it('a dropped ISSUE writes no fallback NOTE', async () => {
    const a = asker([S.draftText(S.SHAPE_LINES, 'Harness Part #85152799 failed')]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON());
    expect(r.summary).toBeNull();
    expect(r.correctedNotes).toBeNull();
  });
});

describe('self-review and the merge rule', () => {
  const BAD = ['11/05 - Dealer quoted Part #85152799 instead.', '11/06 - Estimate approved at $4,800.', '11/07 - Dealer quoted Part #85152798 too.', '11/03 - [Unplanned] Unit in bay; diagnosis started.'];
  it('> 50% dropped and the review FINAL also fails -> timeline null, state rejected', async () => {
    const a = asker([S.draftText(BAD), S.reviewText(BAD)]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON({ reviewRounds: 1 }));
    expect(a.fn).toHaveBeenCalledTimes(2);
    expect(r.timeline).toBeNull();
    expect(r.tlGate.state).toBe('rejected');
    expect(r.tlGate.rounds).toBe(1);
  });
  it('the review always runs; a passing FINAL replaces the rejected draft', async () => {
    const good = ['11/02 - Dealer moved repair to Waiting.', '11/03 - [Unplanned] Unit in bay; diagnosis started.'];
    const a = asker([S.draftText(BAD), S.reviewText(good)]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON({ reviewRounds: 1 }));
    expect(lines(r.timeline)).toEqual(good);
    expect(r.tlGate).toMatchObject({ state: 'reviewed', rounds: 1, selfQuestions: 1, qaDrops: 0 });
    const rp = a.prompts[1];
    expect(rp).toContain('SELF-REVIEW');
    expect(rp).toContain('VERIFIED FACTS');
    expect(rp).toContain('SOURCE DATA:');
    expect(rp).toContain('FACT-CHECK REMOVED');
    expect(a.opts[0]).toBeUndefined();                         // the draft call is unchanged
    expect(a.opts[1].timeoutMs).toBeGreaterThan(0);
    expect(a.opts[1].timeoutMs).toBeLessThanOrEqual(ds.TL_REVIEW_CALL_MS);
  });
  it('a clean draft is still reviewed; an unparseable review keeps the gated draft (ai-invalid)', async () => {
    const a = asker([S.draftText(S.SHAPE_LINES), 'no final here']);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON({ reviewRounds: 1 }));
    expect(a.fn).toHaveBeenCalledTimes(2);
    expect(lines(r.timeline)).toEqual(S.SHAPE_LINES);
    expect(r.tlGate).toMatchObject({ state: 'ok', reviewSkipped: 'ai-invalid' });
  });
  it('a FINAL keeping too few lines does not replace a good draft', async () => {
    const a = asker([S.draftText(S.SHAPE_LINES), S.reviewText(['11/02 - Dealer moved repair to Waiting.'])]);
    const r = await ds._processUnit(S.unitRow(), {}, a.fn, ON({ reviewRounds: 1 }));
    expect(lines(r.timeline)).toEqual(S.SHAPE_LINES);
    expect(r.tlGate.state).toBe('ok');
  });
  it('the run budget is counted per output across the run (_runOrchaDeepScanBody)', async () => {
    fx.rec.store.set('settings', { extract: { reviewMaxPerRun: 1 } });
    fx.rec.store.set('notesStore', {});
    let reviews = 0;
    fx.rec.relayImpl = async (id, prompt) => {
      if (/SELF-REVIEW/.test(prompt)) { reviews++; return S.reviewText(S.SHAPE_LINES); }
      return S.draftText(S.SHAPE_LINES);
    };
    const rows = [S.unitRow(), S.unitRow({ equipmentId: '39583' })];
    await ds.runOrchaDeepScan(rows, { pushData: () => {}, pushStatus: () => {}, payload: {}, force: true });
    expect(reviews).toBe(1);
    const info = fx.rec.logs.filter((l) => l.ns === 'deep-scan' && /^\[DS\] tlGate /.test(l.msg)).map((l) => l.msg);
    expect(info).toHaveLength(2);
    expect(info.some((m) => /skipped=budget/.test(m))).toBe(true);
    for (const m of info) expect(m).not.toMatch(/harness|Volvo|\$/i);   // counts / codes / ids only
    expect(rows[0].partNumbers).toBe('85152780');                      // apply loop refreshed the mirrors
  });
});

describe('flag off (AC17): byte-identical to 1eabe04, one askOrcha call', () => {
  it('the 1eabe04 deep-scan is available', () => { expect(BASE && typeof BASE._processUnit).toBe('function'); });
  for (const [name, tl] of [['no run context', undefined], ['extraction off', { flags: { enabled: false, aiOutput: false } }],
    ['aiOutput off', { flags: { enabled: true, aiOutput: false, reviewRounds: 1, reviewMaxPerRun: 200 }, budget: null }]]) {
    it(name + ': same prompt and result', async () => {
      const resp = S.draftText(S.SHAPE_LINES.concat(['11/05 - Dealer quoted Part #85152799 instead.']));
      const a = asker([resp]);
      const b = asker([resp]);
      const got = await ds._processUnit(S.unitRow(), {}, a.fn, tl);
      const want = await BASE._processUnit(S.unitRow(), {}, b.fn);
      expect(a.fn).toHaveBeenCalledTimes(1);
      expect(a.prompts[0]).toBe(b.prompts[0]);
      expect(a.prompts[0]).not.toContain('VERIFIED FACTS');
      expect(got).toEqual(want);
    });
  }
  it('aiOutput on but no fact block on the unit: same prompt and result as 1eabe04', async () => {
    const row = () => { const r = S.unitRow(); delete r.relayFacts; delete r.offsiteFacts; return r; };
    const a = asker([S.draftText(S.SHAPE_LINES)]);
    const b = asker([S.draftText(S.SHAPE_LINES)]);
    const got = await ds._processUnit(row(), {}, a.fn, ON({ reviewRounds: 1 }));
    const want = await BASE._processUnit(row(), {}, b.fn);
    expect(a.fn).toHaveBeenCalledTimes(1);
    expect(a.prompts[0]).toBe(b.prompts[0]);
    expect(got).toEqual(want);
  });
});
