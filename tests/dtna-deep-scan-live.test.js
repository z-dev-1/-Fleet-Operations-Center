// DTNA Phase D: the deep-scan offsite pass reads DTNA cases exactly where and when it reads Decisiv
// cases (same isOffsiteCacheFresh / OFFSITE_CACHE_FRESH_MS gate), through the real facade and a stubbed
// src/dtna/auto.js. Pattern: tests/timeline-freshness.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'dtna-ds-live-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

const _ask = vi.fn();
const _enrich = vi.fn();
const _pullIfStale = vi.fn();
const _applyCachedCase = vi.fn();
function _stub(rel, exportsObj) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
_stub('../src/orcha/relay', { ask: (...a) => _ask(...a) });
_stub('../src/scrapers/asist_enrich', { enrichVolvoAsist: (...a) => _enrich(...a) });
_stub('../src/dtna/auto', { pullIfStale: (...a) => _pullIfStale(...a), applyCachedCase: (...a) => _applyCachedCase(...a) });
delete require.cache[require.resolve('../src/scrapers/dtna_enrich')];

const deepScan = require('../src/orcha/deep-scan');

const HOUR = 3600 * 1000;
const CASE = '500gx000002E4U5AAK';
const DURL = 'https://dtna.my.site.com/Servicetracker/s/case/' + CASE + '/detail';
const STALE = '2026-11-18 Dealer: unit arrived, diag pending.';
const FRESH = '2026-11-22 10:00 HORWITH FREIGHTLINER: [Estimate] DPF replaced, road test today.\n' + STALE;
const AI_TEXT = 'REPAIR_STATUS: In repair\nPRIMARY_COMPONENT: ENGINE/MOTOR SYSTEMS\nISSUE: DPF\nTIMELINE:\n11/18 - Arrived.\n11/22 - DPF replaced.\n';

function dtnaRow(extra) {
  return {
    equipmentId: '122269', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'FREIGHTLINER',
    workRequestId: 'WR1', offsiteShopEventUrl: DURL, fullConversation: 'Conversation\n11/18 WR created', ...extra,
  };
}
function volvoRow(extra) {
  return {
    equipmentId: '320160', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'VOLVO',
    workRequestId: 'WR2', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/21349860',
    fullConversation: 'Conversation\n10/09 WR created', ...extra,
  };
}
const liveEntry = () => ({
  caseId: CASE, caseNumber: '15667050', caseStatus: 'In Repair', stageSince: '2026-11-21T14:00:00.000Z', offsiteStage: 'repair',
  offsiteText: FRESH, thread: FRESH, pulledAt: new Date().toISOString(),
});

beforeEach(() => {
  store.save('notesStore', {});
  _ask.mockReset(); _enrich.mockReset(); _pullIfStale.mockReset(); _applyCachedCase.mockReset();
  _ask.mockResolvedValue(AI_TEXT);
  _enrich.mockResolvedValue({ ok: true, offsiteText: 'Volvo fresh notes 10/27 clutch here.', scrapedAt: new Date().toISOString(), source: 'estimate' });
  _pullIfStale.mockResolvedValue({ ok: true, entry: liveEntry(), live: true });
  _applyCachedCase.mockReturnValue({ applied: false, reason: 'no-case' });
});

const run = (rows) => deepScan.runOrchaDeepScan(rows, { pushData: () => {}, pushStatus: () => {}, payload: {} });
const promptFor = (id) => (_ask.mock.calls.find((c) => String(c[0]).includes(id)) || [''])[0];

describe('deep-scan DTNA offsite pass (Decisiv-identical gating)', () => {
  it('stale cached notes -> one DTNA read with the Decisiv freshness window; the fresh thread feeds the AI and the row', async () => {
    const row = dtnaRow({ asistNotes: STALE, asistScrapedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
    await run([row]);
    expect(_pullIfStale).toHaveBeenCalledTimes(1);
    expect(_pullIfStale).toHaveBeenCalledWith(CASE, { freshMs: deepScan.OFFSITE_CACHE_FRESH_MS });
    expect(promptFor('122269')).toContain('DPF replaced');
    expect(row.asistNotes).toContain('DPF replaced');
    expect(row).toMatchObject({ dtnaCaseNumber: '15667050', offsiteStageDetail: 'In Repair', offsiteStageSince: '2026-11-21T14:00:00.000Z', asistSource: 'dtna' });
    expect(_enrich).not.toHaveBeenCalled();
  });

  it('undated cached notes count as stale', async () => {
    await run([dtnaRow({ asistNotes: STALE, asistScrapedAt: '' })]);
    expect(_pullIfStale).toHaveBeenCalledTimes(1);
  });

  it('fresh cached notes (10 min) -> no DTNA read (throttle honored)', async () => {
    await run([dtnaRow({ asistNotes: FRESH, asistScrapedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })]);
    expect(_pullIfStale).not.toHaveBeenCalled();
    expect(promptFor('122269')).toContain('DPF replaced');
  });

  it('signed out (no entry) -> the stale cached notes still feed the AI', async () => {
    _pullIfStale.mockResolvedValue({ ok: false, entry: null, live: false, code: 'DTNA_AUTO_SIGNED_OUT' });
    const row = dtnaRow({ asistNotes: STALE, asistScrapedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
    await run([row]);
    expect(_pullIfStale).toHaveBeenCalledTimes(1);
    expect(promptFor('122269')).toContain('unit arrived, diag pending');
    expect(row.dtnaCaseNumber).toBeUndefined();
  });

  it('a Volvo row in the same run takes the Decisiv path only (unchanged)', async () => {
    const stale = new Date(Date.now() - 5 * HOUR).toISOString();
    await run([dtnaRow({ asistNotes: STALE, asistScrapedAt: stale }), volvoRow({ asistNotes: 'old volvo', asistScrapedAt: stale })]);
    expect(_enrich).toHaveBeenCalledTimes(1);
    expect(_enrich.mock.calls[0][0]).toContain('decisiv.net');
    expect(_pullIfStale).toHaveBeenCalledTimes(1);
    expect(_pullIfStale.mock.calls[0][0]).toBe(CASE);
  });

  it('Chatter + Files: the extracted estimate PDF text and its grand total reach the timeline prompt and the row', async () => {
    const e = liveEntry();
    e.attachments = [{
      kind: 'pdf', status: 'read', name: 'Dealer estimate E101048154.pdf', createdAt: '2026-11-21T09:00:00.000Z',
      text: 'Brake chamber P/N K123-456 $245.10\nGrand Total $1,234.56', total: 1234.56, totalLabeled: true,
      lineItems: [{ desc: 'Brake chamber P/N K123-456', amount: 245.1, kind: 'part' }],
    }];
    _pullIfStale.mockResolvedValue({ ok: true, entry: e, live: true });
    const row = dtnaRow({ asistNotes: STALE, asistScrapedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
    await run([row]);
    const prompt = promptFor('122269');
    expect(prompt).toContain('DTNA ESTIMATE PDFs (extracted text, dealer-supplied):');
    expect(prompt).toContain('Grand total $1,234.56 (labelled)');
    expect(prompt).toContain('Brake chamber P/N K123-456');
    expect(row.dtnaEstimateText).toContain('Dealer estimate E101048154.pdf');
  });

  it('Chatter + Files: no read PDFs -> no estimate block in the prompt', async () => {
    const row = dtnaRow({ asistNotes: STALE, asistScrapedAt: new Date(Date.now() - 5 * HOUR).toISOString() });
    await run([row]);
    expect(promptFor('122269')).not.toContain('DTNA ESTIMATE PDFs');
    expect(row.dtnaEstimateText || '').toBe('');
  });

  it('a FREIGHTLINER row with no offsite link gets the cache join; a Volvo row with no link does not', async () => {
    _applyCachedCase.mockImplementation((u) => {
      u.offsiteShopEventUrl = DURL; u.asistSrUrl = DURL; u._offsiteWrId = u.workRequestId;
      return { applied: true, reason: 'ok' };
    });
    const fl = dtnaRow({ offsiteShopEventUrl: '' });
    const vo = volvoRow({ offsiteShopEventUrl: '' });
    await run([fl, vo]);
    expect(_applyCachedCase).toHaveBeenCalledTimes(1);
    expect(_applyCachedCase.mock.calls[0][0]).toBe(fl);
    expect(_pullIfStale).toHaveBeenCalledWith(CASE, { freshMs: deepScan.OFFSITE_CACHE_FRESH_MS });
    expect(fl.dtnaCaseNumber).toBe('15667050');
  });
});
