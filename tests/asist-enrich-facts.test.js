// tests/asist-enrich-facts.test.js — relay-extract §9.3 / §11.1 / §11.2: the ASIST /
// PACCAR enrich paths (direct estimate and SR -> estimate) return offsiteFacts mined from
// the raw API notes, offsiteStageHistory (sorted, <= 80), the dealer (fixes dealer:'' on
// the direct-estimate path) and dealerCode. The DOM fallback yields offsiteFacts:null;
// flag off makes no extra GET and adds no key (AC24). Electron and auto-login are faked in
// the require cache; decisiv_api is spied.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
import { estimateDetail } from './fixtures/extract/estimate-detail-39582.js';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'asist-enrich-facts-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

function injectFake(rel, exportsObj) {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
// Fake offscreen window: answers the in-page scripts of openAndScrape / openAndScrapeEstimate.
let SR_PAGE = null;
const DOM_THREAD = '11/09/26 Dealer Advisor: waiting on parts, PART # 85152780 on order, will update you';
class FakeWin {
  constructor() {
    this._h = {}; this._dead = false; const self = this;
    this.webContents = {
      once: (ev, cb) => { self._h[ev] = cb; }, on: () => {}, getURL: () => self._url,
      executeJavaScript: async (s) => {
        if (s.includes('estimateLinks')) return SR_PAGE;
        if (s.includes('toolbutton_notes')) return 'clicked';
        if (s.includes('notes_workspace')) return { commentThread: DOM_THREAD, notesReady: true, bodyLen: 2000, wsFound: true, wsLen: 90, stillLoading: false };
        if (s.includes('innerText.length')) return 2000;
        return null;
      },
    };
  }
  loadURL(u) { this._url = u; setTimeout(() => this._h['did-finish-load'] && this._h['did-finish-load'](), 0); }
  isDestroyed() { return this._dead; }
  destroy() { this._dead = true; }
}
injectFake('electron', { BrowserWindow: FakeWin });
injectFake('../src/orcha/auto-login', { partitionForUrl: () => 'persist:asist', attachAutoLogin: () => {} });
const decisiv = require('../src/scrapers/decisiv_api');
const ae = require('../src/scrapers/asist_enrich');

const EST_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/20945735';
const SR_URL = 'https://volvopg.asist.decisiv.net/service_requests/7788123';
const TEXT = decisiv.formatActivityLogs({ notes: N.pages[0] }).text;
// 27 case-status entries (39582 shape: June prior episode, then Sept..Nov), served unsorted.
const HISTORY = (() => {
  const out = [];
  const stages = ['arrival', 'diagnosis', 'approval', 'repair'];
  for (let i = 0; i < 27; i++) {
    const d = i < 6 ? new Date(Date.UTC(2026, 5, 15 + i, 14)) : new Date(Date.UTC(2026, 8, 20 + (i - 6) * 2, 14));
    out.push({ stage: stages[i % 4], status: i % 3 ? 'Hold (parts)' : 'Working', at: d.toISOString().replace('.000Z', '-00:00') });
  }
  return out.reverse();
})();
let spies;
function stubApi({ commentsOk = true } = {}) {
  spies = {
    comments: vi.spyOn(decisiv, 'getEstimateComments').mockImplementation(async (id, o) => (commentsOk
      ? Object.assign({ ok: true, text: TEXT, count: 50, newest: '', raw: { notes: N.pages[0] } },
        o && o.allPages ? { rawNotes: N.allNotes, total: 108, pages: 3, partial: false } : {})
      : { ok: false, error: 'x', text: '', count: 0 })),
    detail: vi.spyOn(decisiv, 'getEstimateDetail').mockResolvedValue({ ok: true, estimate: estimateDetail.estimate }),
    status: vi.spyOn(decisiv, 'getCaseStatusSummary').mockResolvedValue({ ok: true, stage: 'repair', stageDisplay: 'Repair', status: 'Hold (parts)', since: '2026-11-10T09:00:00-05:00', history: HISTORY }),
  };
}
beforeEach(() => {
  delete process.env.FLEET_EXTRACT; delete process.env.DECISIV_API;
  SR_PAGE = { pageReady: true, currentUrl: SR_URL, estimateLinks: [{ url: EST_URL, id: '20945735' }], caseLinks: [], srLinks: [], responseCaseLinks: [],
    caseNumbers: ['264113145'], srNumbers: [], srStatus: '', dealer: '', complaint: '', assetVin: '', unitNumber: '', responsesText: '',
    offsiteStage: '', offsiteStageConfidence: '', pageText: 'x'.repeat(400) };
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.FLEET_EXTRACT; });

describe('direct estimate path', () => {
  it('flag on: offsiteFacts from rawNotes, stage history (27 sorted), dealer + dealerCode filled', async () => {
    stubApi();
    const r = await ae.enrichVolvoAsist(EST_URL);
    expect(r.ok).toBe(true);
    expect(spies.comments).toHaveBeenCalledWith('20945735', { srUrl: EST_URL, allPages: true });
    expect(spies.detail).toHaveBeenCalledTimes(1);
    expect(r.offsiteFacts && r.offsiteFacts.v).toBe(2);
    expect(r.offsiteFacts.estimateId).toBe('20945735');
    expect(r.offsiteFacts.facts.some((f) => f.kind === 'ro' && f.value === '30319SP')).toBe(true);   // pre-cap DOM block note
    expect(r.dealer).toBe('M & K Truck Centers - Dunmore, PA');
    expect(r.dealerCode).toBe('5948D');
    expect(r.offsiteStageHistory).toHaveLength(27);
    const ats = r.offsiteStageHistory.map((h) => Date.parse(h.at));
    expect(ats).toEqual(ats.slice().sort((a, b) => a - b));
    expect(r.offsiteText).toBe(TEXT.trim().slice(0, 6000));
  });
  it('flag off: same text, no extra GET, no new keys, dealer stays empty', async () => {
    process.env.FLEET_EXTRACT = '0';
    stubApi();
    const r = await ae.enrichVolvoAsist(EST_URL);
    expect(spies.comments).toHaveBeenCalledWith('20945735', { srUrl: EST_URL });
    expect(spies.detail).not.toHaveBeenCalled();
    for (const k of ['offsiteFacts', 'offsiteStageHistory', 'dealerCode']) expect(k in r).toBe(false);
    expect(r.dealer).toBe('');
    expect(r.offsiteText).toBe(TEXT.trim().slice(0, 6000));
    expect(r.offsiteStage).toBe('repair');
  });
  it('DOM fallback (API gave no notes): offsiteFacts null, text from the Notes tab', async () => {
    stubApi({ commentsOk: false });
    const r = await ae.enrichVolvoAsist(EST_URL);
    expect(r.ok).toBe(true);
    expect(r.offsiteText).toBe(DOM_THREAD);
    expect(r.offsiteFacts).toBe(null);
    expect(r.dealerCode).toBe('');
    expect(r.dealer).toBe('');
  }, 15000);
});

describe('SR -> estimate path', () => {
  it('flag on: offsiteFacts, dealer from the facts when the SR page has none, stage history', async () => {
    stubApi();
    const r = await ae.enrichVolvoAsist(SR_URL);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('estimate');
    expect(r.offsiteFacts.v).toBe(2);
    expect(r.dealer).toBe('M & K Truck Centers - Dunmore, PA');
    expect(r.dealerCode).toBe('5948D');
    expect(r.offsiteStageHistory).toHaveLength(27);
  }, 15000);
  it('SR page dealer wins over the facts', async () => {
    stubApi();
    SR_PAGE.dealer = 'Page Dealer Name';
    const r = await ae.enrichVolvoAsist(SR_URL);
    expect(r.dealer).toBe('Page Dealer Name');
  }, 15000);
  it('flag off: SR dealer unchanged, no new keys, no detail GET', async () => {
    process.env.FLEET_EXTRACT = '0';
    stubApi();
    const r = await ae.enrichVolvoAsist(SR_URL);
    expect(r.dealer).toBe('');
    expect(spies.detail).not.toHaveBeenCalled();
    for (const k of ['offsiteFacts', 'offsiteStageHistory', 'dealerCode']) expect(k in r).toBe(false);
  }, 15000);
});

describe('_stageFields', () => {
  it('history only with extraction; [] on the empty and fallback branches', () => {
    expect('offsiteStageHistory' in ae._stageFields({ stage: 'repair', history: HISTORY }, '', '')).toBe(false);
    expect(ae._stageFields({ stage: 'repair', history: HISTORY }, '', '', true).offsiteStageHistory).toHaveLength(27);
    expect(ae._stageFields({ empty: true, history: [] }, '', '', true).offsiteStageHistory).toEqual([]);
    expect(ae._stageFields(null, 'ready', 'text-fallback', true).offsiteStageHistory).toEqual([]);
    const many = Array.from({ length: 90 }, (_, i) => ({ stage: 'repair', status: 's' + i, at: new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString() }));
    const h = ae._stageFields({ stage: 'repair', history: many.slice().reverse() }, '', '', true).offsiteStageHistory;
    expect(h).toHaveLength(80);
    expect(h[79].status).toBe('s89');
  });
});
