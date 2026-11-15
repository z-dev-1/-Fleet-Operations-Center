// tests/decisiv-paging.test.js — relay-extract §11.2 / AC14: getEstimateComments
// {allPages} reads up to 4 pages x 50 (stops on a short page / total_count), returns
// rawNotes with every field kept, partial on a later-page failure, and a page-1 `text`
// byte-identical to allPages:false. getEstimateDetail never throws. The windowed GET is
// replaced through decisiv_api._setApiGetForTest.
process.env.TZ = 'America/New_York';
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
import { estimateDetail } from './fixtures/extract/estimate-detail-39582.js';
const require = createRequire(import.meta.url);
const api = require('../src/scrapers/decisiv_api');

const EST = '20945735';
function serve(pages, { failPage = 0, total = 108, detail = null, detailFails = false } = {}) {
  const seen = [];
  api._setApiGetForTest(async (origin, path) => {
    seen.push(path);
    const d = /\/mobilecomm\/api\/estimates\/\d+\.json$/.test(path);
    if (d) { if (detailFails) throw Object.assign(new Error('Decisiv API 500: x'), { code: 'DECISIV_API_ERROR' }); return detail; }
    const m = /activity_logs\?page=(\d+)&per_page=(\d+)/.exec(path);
    const p = Number(m[1]);
    if (p === failPage) throw Object.assign(new Error('Decisiv API 502: bad gateway'), { code: 'DECISIV_API_ERROR' });
    return { notes: pages[p - 1] || [], total_count: total, page: p, per_page: 50 };
  });
  return seen;
}
afterEach(() => api._setApiGetForTest(null));

describe('getEstimateComments allPages (AC14)', () => {
  it('50/50/8 -> 108 raw notes in served order, fields kept, 3 pages, not partial', async () => {
    const seen = serve(N.pages);
    const r = await api.getEstimateComments(EST, { allPages: true });
    expect(r.ok).toBe(true);
    expect(r.rawNotes).toHaveLength(108);
    expect(r.rawNotes.map((n) => n.id)).toEqual(N.allNotes.map((n) => n.id));
    expect(r.rawNotes[0].from.job_role).toBe('customer_service_representative');
    expect(r.rawNotes[0].from.groupId).toBe(-3);
    expect(Array.isArray(r.rawNotes[0].recipients)).toBe(true);
    expect(r).toMatchObject({ total: 108, pages: 3, partial: false });
    expect(seen.filter((p) => /activity_logs/.test(p))).toHaveLength(3);
  });
  it('text/count/newest equal allPages:false (page 1 only)', async () => {
    serve(N.pages);
    const one = await api.getEstimateComments(EST, {});
    serve(N.pages);
    const all = await api.getEstimateComments(EST, { allPages: true });
    expect(all.text).toBe(one.text);
    expect(all.count).toBe(one.count);
    expect(all.newest).toBe(one.newest);
    expect(one.text).toBe(api.formatActivityLogs({ notes: N.pages[0] }).text);
    expect('rawNotes' in one).toBe(false);
  });
  it('page 1 shorter than 8000 chars still byte-identical', async () => {
    const short = N.pages[0].map((n, i) => Object.assign({}, n, { message: 'short note ' + i }));
    serve([short, N.pages[1], N.pages[2]]);
    const one = await api.getEstimateComments(EST, {});
    serve([short, N.pages[1], N.pages[2]]);
    const all = await api.getEstimateComments(EST, { allPages: true });
    expect(one.text.length).toBeLessThan(8000);
    expect(all.text).toBe(one.text);
    expect(all.rawNotes).toHaveLength(108);
  });
  it('page-2 failure -> the 50 page-1 notes, partial:true', async () => {
    serve(N.pages, { failPage: 2 });
    const r = await api.getEstimateComments(EST, { allPages: true });
    expect(r.ok).toBe(true);
    expect(r.rawNotes).toHaveLength(50);
    expect(r).toMatchObject({ partial: true, pages: 1 });
  });
  it('page-1 failure behaves as today (ok:false)', async () => {
    serve(N.pages, { failPage: 1 });
    const r = await api.getEstimateComments(EST, { allPages: true });
    expect(r.ok).toBe(false);
    expect(r.text).toBe('');
  });
  it('stops at total_count and never reads more than 4 pages', async () => {
    let seen = serve([N.pages[0]], { total: 50 });
    await api.getEstimateComments(EST, { allPages: true });
    expect(seen.filter((p) => /activity_logs/.test(p))).toHaveLength(1);
    const full = N.pages[0];
    seen = serve([full, full.map((n) => Object.assign({}, n, { id: n.id + 1e6 })), full.map((n) => Object.assign({}, n, { id: n.id + 2e6 })),
      full.map((n) => Object.assign({}, n, { id: n.id + 3e6 })), full.map((n) => Object.assign({}, n, { id: n.id + 4e6 }))], { total: 999 });
    const r = await api.getEstimateComments(EST, { allPages: true });
    expect(seen.filter((p) => /activity_logs/.test(p))).toHaveLength(4);
    expect(r.rawNotes).toHaveLength(200);
  });
  it('dedupes notes by id across pages', async () => {
    serve([N.pages[0], N.pages[0].slice(0, 10).concat(N.pages[1].slice(10)), N.pages[2]]);
    const r = await api.getEstimateComments(EST, { allPages: true });
    expect(r.rawNotes).toHaveLength(98);
  });
});

describe('getEstimateDetail', () => {
  it('returns {ok, estimate} with the dealer', async () => {
    serve([], { detail: estimateDetail });
    const r = await api.getEstimateDetail(EST);
    expect(r.ok).toBe(true);
    expect(r.estimate.dealer.name).toBe(estimateDetail.estimate.dealer.name);
  });
  it('never throws: error or empty body -> {ok:false}', async () => {
    serve([], { detailFails: true });
    expect(await api.getEstimateDetail(EST)).toEqual({ ok: false });
    serve([], { detail: {} });
    expect(await api.getEstimateDetail(EST)).toEqual({ ok: false });
    expect(await api.getEstimateDetail('')).toEqual({ ok: false });
  });
});
