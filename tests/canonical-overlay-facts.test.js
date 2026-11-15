// tests/canonical-overlay-facts.test.js — relay-extract §12.3 #7: overlayDeepScanFields
// copies offsiteFacts with the notes group and offsiteStageHistory with the stage group
// (newer read wins, same-WR guard), then refreshes the fact mirrors of every matched row
// whether or not it was touched. No scannedRows -> early return, no refresh. Flag off:
// byte-identical to today (AC24).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'canonical-overlay-facts-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const cr = require('../src/orcha/canonical_runner');
const X = require('../src/repair-intel/wo-extract');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const OF = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', wrCreatedAt: N.WR_CREATED_AT, now: NOW });
const H = [{ stage: 'repair', status: 'Hold (parts)', at: '2026-11-10T10:00:00-05:00' }];
const live = () => [{ equipmentId: '39582', _offsiteWrId: 'w1', workRequestId: 'w1', created: '2026-09-23T18:04:00.000Z',
  asistScrapedAt: '2026-11-09T10:00:00Z', asistNotes: 'old', _stageReadAt: '2026-11-09T10:00:00Z', offsiteStage: 'diagnosis' }];
const scanned = () => [{ equipmentId: '39582', _offsiteWrId: 'w1', asistScrapedAt: '2026-11-11T10:00:00Z', asistNotes: 'new', offsiteFacts: OF,
  _stageReadAt: '2026-11-11T10:00:00Z', offsiteStage: 'repair', offsiteStageDetail: 'Hold (parts)', offsiteStageSince: '2026-11-10', offsiteStageHistory: H }];

beforeEach(() => { delete process.env.FLEET_EXTRACT; });
afterEach(() => { delete process.env.FLEET_EXTRACT; });

describe('overlayDeepScanFields + facts', () => {
  it('field lists gain the two keys', () => {
    expect(cr.DS_FIELDS).toEqual(expect.arrayContaining(['offsiteFacts', 'offsiteStageHistory']));
  });
  it('newer scan: offsiteFacts + stage history copied, mirrors recomputed', () => {
    const rows = live();
    expect(cr.overlayDeepScanFields(rows, scanned())).toBe(1);
    expect(rows[0].offsiteFacts).toBe(OF);
    expect(rows[0].offsiteStageHistory).toBe(H);
    expect(rows[0].partNumbers).toBe('85152780');
    expect(rows[0].dealerCode).toBe('5948D');
    expect(rows[0]._factsOn).toBe(true);
  });
  it('an untouched matched row is still refreshed; a WR mismatch is skipped', () => {
    const rows = live();
    rows[0].offsiteFacts = OF;
    const s = scanned();
    s[0].asistScrapedAt = '2026-11-01T00:00:00Z';
    s[0]._stageReadAt = '2026-11-01T00:00:00Z';
    expect(cr.overlayDeepScanFields(rows, s)).toBe(0);
    expect(rows[0].partNumbers).toBe('85152780');
    const other = live();
    other[0].offsiteFacts = OF;
    const s2 = scanned(); s2[0]._offsiteWrId = 'w2';
    cr.overlayDeepScanFields(other, s2);
    expect('partNumbers' in other[0]).toBe(false);
  });
  it('a scanned row without a history array never blanks the row history', () => {
    const rows = live(); rows[0].offsiteStageHistory = H;
    const s = scanned(); delete s[0].offsiteStageHistory;
    cr.overlayDeepScanFields(rows, s);
    expect(rows[0].offsiteStageHistory).toBe(H);
  });
  it('no scannedRows: early return, rows untouched (the stage refresh path)', () => {
    const rows = live(); rows[0].offsiteFacts = OF;
    expect(cr.overlayDeepScanFields(rows, [])).toBe(0);
    expect('partNumbers' in rows[0]).toBe(false);
  });
  it('flag off: same result as today for rows without the new keys', () => {
    process.env.FLEET_EXTRACT = '0';
    const rows = live();
    const s = scanned(); delete s[0].offsiteFacts; delete s[0].offsiteStageHistory;
    expect(cr.overlayDeepScanFields(rows, s)).toBe(1);
    expect(rows[0]).toEqual(Object.assign(live()[0], { asistScrapedAt: '2026-11-11T10:00:00Z', asistNotes: 'new', _stageReadAt: '2026-11-11T10:00:00Z',
      offsiteStage: 'repair', offsiteStageDetail: 'Hold (parts)', offsiteStageSince: '2026-11-10' }));
  });
});
