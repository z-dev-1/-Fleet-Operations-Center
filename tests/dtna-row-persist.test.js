// DTNA Vendor WO (case number) and case stage on fleet rows: they persist across the save after a
// scan (overlay), are never blanked by a later empty read, and the stage counts as API-confirmed.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let cr;
let canonical;
beforeAll(() => {
  cr = require('../src/orcha/canonical_runner.js');
  canonical = require('../src/orcha/canonical_state.js');
});

const CASE_URL = 'https://dtna.my.site.com/Servicetracker/s/case/500AB00000ABCDEFGH/view';
const dtnaRow = (o) => Object.assign({
  equipmentId: 'FLD1', vendor: 'FREIGHTLINER (DAIMLER)', workRequestId: 'WR1', _offsiteWrId: 'WR1',
  offsiteShopEventUrl: CASE_URL, savedOffsiteUrl: CASE_URL, asistSrUrl: CASE_URL, asistSource: 'dtna',
  asistScrapedAt: '2026-11-23T06:00:00.000Z', offsiteStage: 'repair', offsiteStageDetail: 'In-repair',
  offsiteStageSince: '', _stageReadAt: '2026-11-23T06:00:00.000Z',
}, o || {});

describe('DTNA case number persistence (overlayDeepScanFields)', () => {
  it('a case number the scan set in memory is carried onto the stored row', () => {
    const stored = [dtnaRow()];
    const scanned = [dtnaRow({ dtnaCaseNumber: '12345678' })];
    expect(cr.overlayDeepScanFields(stored, scanned)).toBe(1);
    expect(stored[0].dtnaCaseNumber).toBe('12345678');
  });

  it('a later scan without a case number never blanks it; a rebuild that keeps the WR keeps stage + number', () => {
    const stored = [dtnaRow({ dtnaCaseNumber: '12345678' })];
    cr.overlayDeepScanFields(stored, [dtnaRow({ dtnaCaseNumber: '', asistScrapedAt: '2026-11-23T07:00:00.000Z' })]);
    expect(stored[0].dtnaCaseNumber).toBe('12345678');
    expect(stored[0]).toMatchObject({ offsiteStage: 'repair', offsiteStageDetail: 'In-repair' });
  });

  it('a DTNA stage read with newer notes (no stage stamp) reaches the stored row; an empty one never blanks it', () => {
    const stored = [dtnaRow({ offsiteStage: '', offsiteStageDetail: '' })];
    cr.overlayDeepScanFields(stored, [dtnaRow({ _stageReadAt: '' })]);
    expect(stored[0]).toMatchObject({ offsiteStage: 'repair', offsiteStageDetail: 'In-repair' });
    cr.overlayDeepScanFields(stored, [dtnaRow({ offsiteStage: '', offsiteStageDetail: '', _stageReadAt: '', asistScrapedAt: '2026-11-23T08:00:00.000Z' })]);
    expect(stored[0]).toMatchObject({ offsiteStage: 'repair', offsiteStageDetail: 'In-repair' });
  });

  it('a case joined by unit number onto a row with no link is adopted (same WR), with stage and number', () => {
    const stored = [{ equipmentId: 'FLD1', vendor: 'FREIGHTLINER', workRequestId: 'WR1' }];
    cr.overlayDeepScanFields(stored, [dtnaRow({ dtnaCaseNumber: '12345678' })]);
    expect(stored[0]).toMatchObject({ _offsiteWrId: 'WR1', offsiteShopEventUrl: CASE_URL, dtnaCaseNumber: '12345678', offsiteStage: 'repair', asistSource: 'dtna' });
  });

  it('a join for another WR is not adopted', () => {
    const stored = [{ equipmentId: 'FLD1', vendor: 'FREIGHTLINER', workRequestId: 'WR2' }];
    cr.overlayDeepScanFields(stored, [dtnaRow({ dtnaCaseNumber: '12345678' })]);
    expect(stored[0].offsiteShopEventUrl).toBeUndefined();
    expect(stored[0].dtnaCaseNumber).toBeUndefined();
  });

  it('Chatter + Files: the extracted estimate text survives the post-scan save (newer notes) and the join adopt', () => {
    const stored = [dtnaRow()];
    cr.overlayDeepScanFields(stored, [dtnaRow({ dtnaEstimateText: '[E101.pdf] Grand total $1,234.56', asistScrapedAt: '2026-11-23T07:00:00.000Z' })]);
    expect(stored[0].dtnaEstimateText).toBe('[E101.pdf] Grand total $1,234.56');
    const fresh = [{ equipmentId: 'FLD1', vendor: 'FREIGHTLINER', workRequestId: 'WR1' }];
    cr.overlayDeepScanFields(fresh, [dtnaRow({ dtnaEstimateText: 'est' })]);
    expect(fresh[0].dtnaEstimateText).toBe('est');
    expect(cr.DS_FIELDS).toContain('dtnaEstimateText');
    expect(require('../src/utils/offsite-owner.js').OFFSITE_FIELDS).toContain('dtnaEstimateText');
  });

  it('a row whose offsite is another DTNA case keeps its own number', () => {
    const other = 'https://dtna.my.site.com/Servicetracker/s/case/500AB00000ZZZZZZZZ/view';
    const stored = [dtnaRow({ offsiteShopEventUrl: other, savedOffsiteUrl: other, asistSrUrl: other, dtnaCaseNumber: '1' })];
    cr.overlayDeepScanFields(stored, [dtnaRow({ dtnaCaseNumber: '12345678' })]);
    expect(stored[0].dtnaCaseNumber).toBe('1');
  });
});

describe('DTNA case stage counts as API-confirmed (same Repair Status as Decisiv)', () => {
  it('DTNA Ready for Pickup -> ready_for_pickup with no offsiteStageSince', () => {
    expect(canonical._stageOverride(dtnaRow({ offsiteStage: 'ready', offsiteStageDetail: 'Ready for Pickup' }), 'in_repair')).toBe('ready_for_pickup');
  });
  it('DTNA In-repair vetoes a text-only "ready"', () => {
    expect(canonical._stageOverride(dtnaRow(), 'ready_for_pickup')).toBe('in_repair');
  });
  it('a non-DTNA stage with no since is still untrusted (unchanged)', () => {
    expect(canonical._stageOverride({ offsiteStage: 'ready', offsiteStageDetail: 'x', asistSource: 'decisiv' }, 'in_repair')).toBe('in_repair');
  });
  it('unit-detail shows the stepper for a DTNA stage without a since (source check)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'js', 'views', 'unit-detail.js'), 'utf8');
    expect(src).toMatch(/var _dtnaStage=unit\.asistSource==='dtna'&&String\(unit\.offsiteStageDetail\|\|''\)\.trim\(\);/);
    expect(src).toMatch(/var _stg=\(unit\.offsiteStageSince\|\|_dtnaStage\)\?/);
  });
});
