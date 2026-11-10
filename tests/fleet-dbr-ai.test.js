// Fleet DBR AI drafting (src/dbr/fleet-dbr-ai.js): prompt sections + evidence budget,
// the anti-fabrication gate (foreign IDs, invented numbers, token-boundary evidence match,
// invented tickets, invented ETC dates), caps, JSON handling, and draftRow failure codes.
// Fake `ask` only - no relay.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const AI = require('../src/dbr/fleet-dbr-ai');
const { makeFleetRows, makeUnit, downIdsOf } = require('./fixtures/fleet-dbr/make-rows');
const TODAY = '2026-11-10';

const ROC = downIdsOf(makeFleetRows(), 'ROC5', 'AUVTE');
const ABE_TUZR = downIdsOf(makeFleetRows(), 'ABE40', 'TUZR');
const NOTE = 'Tow order 00176990/amz-dr67qazvrtau54 placed via FleetNet; body shop says ETC 11/12';

function setup(overrides = {}, rowsIn) {
  const rows = rowsIn || makeFleetRows(Object.assign({ [ROC[0]]: { savedNotes: NOTE, vendor: 'CEI', lifecycleReason: 'Accident' } }, overrides));
  const built = F.buildFleetDbr(rows, { today: TODAY });
  return { rows, built };
}
function pairOf(s, key) {
  const row = s.built.rows.find((r) => r.key === key);
  const unitRows = s.rows.filter((r) => F.groupKey(r) === key && F.isDown(r));
  const fleetIds = s.rows.filter((r) => F.groupKey(r) !== key).map((r) => r.equipmentId);
  return { row, unitRows, built: s.built, fleetIds, today: TODAY };
}
const ctxOf = (p) => AI.draftContext(p);
const J = (o) => JSON.stringify(o);

describe('buildDraftPrompt', () => {
  it('has VERIFIED COUNTS, BARRIER FLAGS, ETC and DOWN UNITS sections with only this pair\'s IDs', () => {
    const s = setup();
    const p = pairOf(s, 'ROC5|AUVTE');
    const prompt = AI.buildDraftPrompt(p.row, p.unitRows, s.built, { today: TODAY });
    expect(prompt).toContain('VERIFIED COUNTS (exact — do not recount)');
    expect(prompt).toContain('pair down/total: 15/29');
    expect(prompt).toContain('domicile ROC5: uptime 48.3%, units down 15');
    expect(prompt).toContain('BARRIER FLAGS (computed in code — do not change)');
    expect(prompt).toContain('Partner Barrier: Y');
    expect(prompt).toContain('ETC (parsed from text, best-effort)');
    expect(prompt).toContain('DOWN UNITS (15)');
    expect(prompt).toContain('Return ONLY JSON {"fasActions": string, "support": string}');
    for (const id of ROC) expect(prompt).toContain('[' + id + ']');
    const ids = prompt.match(/\bT\d{4}\b/g) || [];
    expect(ids.every((id) => ROC.includes(id))).toBe(true);
    expect(prompt).toContain(NOTE);
  });

  it('stays within 48 000 chars on a 45-down pair with long text and summarizes past 40 units', () => {
    const long = 'x'.repeat(5000);
    const tl = Array.from({ length: 40 }, (_, i) => '10/' + (i % 28 + 1) + ' - timeline entry ' + i + ' ' + 'y'.repeat(100)).join('\n');
    const rows = Array.from({ length: 45 }, (_, i) => makeUnit({
      equipmentId: 'B' + String(10000 + i), domicileSite: 'BIG1', operator: 'BIGS',
      savedNotes: long, issueDetails: long, repairTimeline: tl, asistNotes: long,
    }));
    const built = F.buildFleetDbr(rows, { today: TODAY });
    const row = built.rows[0];
    const prompt = AI.buildDraftPrompt(row, rows, built, { today: TODAY });
    expect(prompt.length).toBeLessThanOrEqual(48000);
    expect(prompt).toContain('+5 more down units (IDs: ');
    expect(prompt).toContain('Return ONLY JSON');
  });

  it('a 1-unit pair with a 15-line timeline gets >= 10 timeline lines, newest first, plus the asist notes tail', () => {
    const tl = Array.from({ length: 15 }, (_, i) => '10/' + (i + 1) + ' - step number ' + (i + 1) + ' with vendor').join('\n');
    const s = setup({}, makeFleetRows({ T0078: { repairTimeline: tl, asistNotes: 'dealer note head ... dealer note TAIL' } }));
    const p = pairOf(s, 'ABE40|AGNLI');
    expect(p.unitRows.map((r) => r.equipmentId)).toEqual(['T0078']);
    const prompt = AI.buildDraftPrompt(p.row, p.unitRows, s.built, { today: TODAY });
    const lines = prompt.split('\n').filter((l) => /^10\/\d+ - step number/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(lines[0]).toBe('10/15 - step number 15 with vendor');
    expect(prompt).toContain('dealer note TAIL');
  });
});

describe('validateDraft', () => {
  const s = setup();
  const p = pairOf(s, 'ROC5|AUVTE');
  const ctx = ctxOf(p);
  const [a, b] = ROC;

  it('drops foreign IDs, invented numbers, partial-token numbers, invented tickets and invented ETC dates', () => {
    const fas = [
      '• ' + a + ': confirm drop-off date with carrier',
      '• ' + ABE_TUZR[0] + ': call the vendor',            // foreign fleet unit
      '• ' + a + ': follow up on claim 123456',              // invented 6-digit number
      '• ' + a + ': check tow order 17699',                  // only inside 00176990 (R18)
      '• ' + a + ': tow order 00176990 is complete',         // evidence-present
      '• ' + a + ': confirm ETC 11/14 with the shop',        // invented ETC date
      '• ' + a + ': confirm ETC 11/12 with the shop',        // parsed ETC date
      '• ' + a + ': FNA ticket amz-7cvf6f2xxxx99 open',      // invented ticket
    ].join('\n');
    const sup = ['• Carrier: ticket amz-dr67qazvrtau54 status (' + a + ')', '• MCS: follow up 11/12 on ' + b + ' re-escalated'].join('\n');
    const r = AI.validateDraft(J({ fasActions: fas, support: sup }), ctx);
    expect(r.ok).toBe(true);
    expect(r.dropped).toBe(5);
    expect(r.fasActions.split('\n')).toEqual([
      '• ' + a + ': confirm drop-off date with carrier',
      '• ' + a + ': tow order 00176990 is complete',
      '• ' + a + ': confirm ETC 11/12 with the shop',
    ]);
    expect(r.support.split('\n')).toEqual(['• Carrier: ticket amz-dr67qazvrtau54 status (' + a + ')', '• MCS: follow up 11/12 on ' + b + ' re-escalated']);
    expect(Object.keys(r).sort()).toEqual(['dropped', 'fasActions', 'ok', 'support']);
  });

  it('drops ETA-phrased repair dates, invented $ amounts and invented fact dates; keeps follow-up dates', () => {
    const c2 = Object.assign({}, ctx, { evidenceText: ctx.evidenceText + '\n12/20 - estimate $4,200 submitted, drop-off 12/21' });
    const fas = [
      '• ' + a + ': repair ETA 12/24 per shop',               // invented ETA-phrased ETC
      '• ' + a + ': ETA for completion 12/24',                // invented ETA-phrased ETC
      '• ' + a + ': repair ETA 11/12 per shop',               // parsed ETC date
      '• ' + a + ': estimate $9,999 approved',                // invented amount
      '• ' + a + ': estimate $4200.00 submitted',             // evidence amount
      '• ' + a + ': body-shop drop-off 12/24',                // invented fact date
      '• ' + a + ': drop-off 12/21 confirmed',                // evidence date
      '• ' + a + ': follow up 12/24 with carrier',            // proposed follow-up date stays
    ].join('\n');
    const r = AI.validateDraft(J({ fasActions: fas, support: 'None' }), c2);
    expect(r.ok).toBe(true);
    expect(r.dropped).toBe(4);
    expect(r.fasActions.split('\n')).toEqual([
      '• ' + a + ': repair ETA 11/12 per shop',
      '• ' + a + ': estimate $4200.00 submitted',
      '• ' + a + ': drop-off 12/21 confirmed',
      '• ' + a + ': follow up 12/24 with carrier',
    ]);
  });

  it('caps lines, line length and total chars; strips fences and control chars', () => {
    const many = Array.from({ length: 12 }, (_, i) => '• ' + a + ': action ' + i).join('\n');
    const r = AI.validateDraft('```json\n' + J({ fasActions: many, support: Array.from({ length: 7 }, (_, i) => '• MCS: ask ' + i).join('\n') }) + '\n```', ctx);
    expect(r.fasActions.split('\n')).toHaveLength(8);
    expect(r.support.split('\n')).toHaveLength(5);
    const longLine = '• ' + a + ': ' + 'z'.repeat(300);
    const r2 = AI.validateDraft(J({ fasActions: '```' + longLine + '\u0007\r\n\n\n\n• ' + b + ': ok```', support: '' }), ctx);
    const ls = r2.fasActions.split('\n');
    expect(ls[0].length).toBe(160);
    expect(ls[0].endsWith('…')).toBe(true);
    expect(ls[1]).toBe('• ' + b + ': ok');
    expect(r2.fasActions).not.toMatch(/```|\r|\u0007/);
    const big = Array.from({ length: 8 }, () => '• ' + a + ': ' + 'w'.repeat(200)).join('\n');
    expect(AI.validateDraft(J({ fasActions: big, support: '' }), ctx).fasActions.length).toBeLessThanOrEqual(1200);
  });

  it('accepts "None" support and prose-wrapped JSON', () => {
    const r = AI.validateDraft('Sure, here it is: ' + J({ fasActions: '• ' + a + ': call carrier', support: 'None' }) + ' Thanks.', ctx);
    expect(r).toEqual({ ok: true, fasActions: '• ' + a + ': call carrier', support: 'None', dropped: 0 });
  });

  it('non-JSON -> ai-invalid; empty after validation -> ai-empty; non-string fields are empty', () => {
    expect(AI.validateDraft('no json here', ctx)).toEqual({ ok: false, code: 'ai-invalid' });
    expect(AI.validateDraft('', ctx)).toEqual({ ok: false, code: 'ai-invalid' });
    expect(AI.validateDraft(J({ fasActions: '• ' + ABE_TUZR[0] + ': x', support: 42 }), ctx)).toEqual({ ok: false, code: 'ai-empty', dropped: 1 });
    expect(AI.validateDraft(J({ fasActions: '', support: '' }), ctx).code).toBe('ai-empty');
  });

  it('output never carries Y/N, count or Details fields even if the AI returns them', () => {
    const r = AI.validateDraft(J({ fasActions: '• ' + a + ': x', support: 'None', oemYN: 'Y', domicileDown: '99', partsDetails: 'made up' }), ctx);
    expect(Object.keys(r).sort()).toEqual(['dropped', 'fasActions', 'ok', 'support']);
  });
});

describe('draftRow', () => {
  const s = setup();
  const p = pairOf(s, 'ROC5|AUVTE');
  const a = ROC[0];

  it('sends the prompt to ask and validates a string result', async () => {
    const ask = vi.fn(async () => J({ fasActions: '• ' + a + ': call carrier', support: 'None' }));
    const r = await AI.draftRow(Object.assign({ ask }, p));
    expect(r).toEqual({ ok: true, fasActions: '• ' + a + ': call carrier', support: 'None', dropped: 0 });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain('VERIFIED COUNTS');
  });

  it('handles a { text } result', async () => {
    const ask = async () => ({ text: J({ fasActions: '', support: '• Accidents: claim status (' + a + ')' }) });
    const r = await AI.draftRow(Object.assign({ ask }, p));
    expect(r.ok).toBe(true);
    expect(r.support).toBe('• Accidents: claim status (' + a + ')');
  });

  it('AI_TIMEOUT -> ai-timeout, other rejection -> ai-failed, junk result -> ai-invalid; never any text', async () => {
    const t = await AI.draftRow(Object.assign({ ask: async () => { throw Object.assign(new Error('AI timeout after 90s'), { code: 'AI_TIMEOUT' }); } }, p));
    expect(t).toEqual({ ok: false, code: 'ai-timeout' });
    const f = await AI.draftRow(Object.assign({ ask: async () => { throw new Error('relay down'); } }, p));
    expect(f).toEqual({ ok: false, code: 'ai-failed' });
    const n = await AI.draftRow(Object.assign({ ask: async () => 12345 }, p));
    expect(n).toEqual({ ok: false, code: 'ai-invalid' });
    for (const r of [t, f, n]) { expect(r.fasActions).toBeUndefined(); expect(r.support).toBeUndefined(); }
  });

  it('passes the abort signal through when given', async () => {
    const ask = vi.fn(async () => J({ fasActions: '• ' + a + ': x', support: 'None' }));
    const ac = new AbortController();
    await AI.draftRow(Object.assign({ ask, signal: ac.signal }, p));
    expect(ask.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });
});

describe('static', () => {
  it('no Promise.race( in src/dbr/fleet-dbr*.js', () => {
    const dir = path.join(__dirname, '../src/dbr');
    const files = fs.readdirSync(dir).filter((f) => /^fleet-dbr.*\.js$/.test(f));
    expect(files).toEqual(expect.arrayContaining(['fleet-dbr.js', 'fleet-dbr-ai.js']));
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain('Promise.race(');
  });
});
