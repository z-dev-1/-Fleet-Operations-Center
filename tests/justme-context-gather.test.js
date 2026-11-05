// index.js: gatherContext order/caps/budget, T-NOCRAWL, worker-session cleanup,
// buildReport (design §12.2) and the default intents vs processOrchaAction's _fleetKw.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const J = require('../src/justme-context');
const { LIMITS, REASONS } = require('../src/justme-context/constants');

const okItem = (kind, text) => ({ kind, status: 'read', text, chars: text.length, truncated: false, reason: '', meta: {} });
let logger, calls, deps;
beforeEach(() => {
  logger = H.makeLogger(vi);
  calls = [];
  let active = 0;
  const track = (name, fn) => vi.fn(async (...a) => {
    active++;
    expect(active).toBe(1);   // strictly sequential
    calls.push([name, a[0] && a[0].id ? a[0].id : a[0]]);
    try { await new Promise((r) => setImmediate(r)); return await fn(...a); } finally { active--; }
  });
  deps = {
    logger,
    readSlackFile: track('file', async (f) => Object.assign(okItem('pdf', 'file text ' + f.id), { label: f.name || 'file' })),
    fetchInternal: track('internal', async (u) => okItem('page', 'internal ' + u)),
    fetchExternal: track('external', async (u) => okItem('page', 'external ' + u)),
  };
});
const files = (n) => Array.from({ length: n }, (_, i) => ({ id: 'F' + i, name: 'f' + i + '.pdf' }));
const links = (n) => Array.from({ length: n }, (_, i) => 'https://example.com/p' + i).join(' ');

describe('gatherContext order and caps', () => {
  it('files first, then links, sequentially; ids and sources assigned', async () => {
    const msg = { text: 'see https://w.amazon.com/a and <https://example.com/b|b>', files: files(2) };
    const r = await J.gatherContext(msg, { deadline: Date.now() + 60000, jobId: 'jm1' }, deps);
    expect(calls.map((c) => c[0])).toEqual(['file', 'file', 'internal', 'external']);
    expect(r.hasFiles).toBe(true);
    expect(r.hasLinks).toBe(true);
    expect(r.items.map((i) => [i.id, i.source, i.label])).toEqual([
      ['c1', 'file', 'f0.pdf'], ['c2', 'file', 'f1.pdf'], ['c3', 'link', 'w.amazon.com/a'], ['c4', 'link', 'example.com/b']]);
    expect(deps.fetchInternal.mock.calls[0][1]).toMatchObject({ kind: 'internal' });
  });
  it('MAX_FILES / MAX_LINKS: extras are skipped and never read', async () => {
    const r = await J.gatherContext({ text: links(12), files: files(12) }, { deadline: Date.now() + 60000 }, deps);
    expect(deps.readSlackFile).toHaveBeenCalledTimes(LIMITS.MAX_FILES);
    expect(deps.fetchExternal).toHaveBeenCalledTimes(LIMITS.MAX_LINKS);
    const skipped = r.items.filter((i) => i.status === 'skipped');
    expect(skipped.map((i) => i.reason)).toEqual([REASONS.MORE_FILES, REASONS.MORE_FILES, REASONS.MORE_LINKS, REASONS.MORE_LINKS]);
  });
  it('blocked links are reported without a fetch; Slack message links unsupported; Slack file links read by id', async () => {
    const msg = { text: 'http://127.0.0.1/x http://intranet/ https://a.slack.com/archives/C1/p1 https://a.slack.com/files/U1/F0LINK/x.pdf' };
    const r = await J.gatherContext(msg, { deadline: Date.now() + 60000 }, deps);
    expect(r.items.map((i) => i.status)).toEqual(['blocked', 'blocked', 'unsupported', 'read']);
    expect(r.items[0].reason).toBe(REASONS.PRIVATE_ADDRESS);
    expect(r.items[2].reason).toBe(REASONS.SLACK_MESSAGE_LINK);
    expect(deps.readSlackFile.mock.calls[0][0]).toEqual({ id: 'F0LINK' });
    expect(r.items[3].source).toBe('file');
    expect(deps.fetchExternal).not.toHaveBeenCalled();
    expect(deps.fetchInternal).not.toHaveBeenCalled();
    expect(r.hasFiles).toBe(false);
  });
  it('a failed link falls back to the matching Slack unfurl', async () => {
    deps.fetchExternal = vi.fn(async () => ({ kind: 'page', status: 'failed', text: '', chars: 0, reason: REASONS.UNREACHABLE, meta: {} }));
    const msg = { text: '<https://example.com/news>', attachments: [{ from_url: 'https://example.com/news', title: 'Headline', text: 'Unfurl body' }] };
    const r = await J.gatherContext(msg, { deadline: Date.now() + 60000 }, deps);
    expect(r.items[0]).toMatchObject({ status: 'read', text: 'Headline\nUnfurl body', reason: REASONS.SLACK_PREVIEW, meta: { via: 'slack-preview' } });
  });
  it('a throwing dependency becomes a failed item; nothing of the error is logged', async () => {
    deps.fetchExternal = vi.fn(async () => { throw new TypeError('boom SENTINEL https://x?token=abc'); });
    const r = await J.gatherContext({ text: 'https://example.com/a' }, { deadline: Date.now() + 60000, jobId: 'jm2' }, deps);
    expect(r.items[0]).toMatchObject({ status: 'failed', reason: REASONS.PARSE_FAILED });
    expect(H.allLogged(logger)).toContain('[jmctx][jm2] link read failed: TypeError');
    expect(H.allLogged(logger)).not.toContain('SENTINEL');
  });
});

describe('budget', () => {
  it('a hanging fetch is cut at the deadline; the rest is skipped BUDGET', async () => {
    deps.fetchExternal = vi.fn((u, ctx) => new Promise(() => { calls.push(['hang', ctx.signal]); }));
    const t0 = Date.now();
    const msg = { text: 'https://example.com/1 https://example.com/2 https://example.com/3' };
    const r = await J.gatherContext(msg, { deadline: Date.now() + 150, jobId: 'jm9' }, deps);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.items.map((i) => [i.status, i.reason])).toEqual([['skipped', REASONS.BUDGET], ['skipped', REASONS.BUDGET], ['skipped', REASONS.BUDGET]]);
    expect(deps.fetchExternal).toHaveBeenCalledTimes(1);
    expect(calls[0][1].aborted).toBe(true);   // the fetcher's signal was aborted too
    expect(logger.warn.mock.calls.filter((c) => /time budget reached/.test(c[0]))).toHaveLength(1);
  });
  it('the caller signal aborts the gather', async () => {
    const ac = new AbortController();
    deps.readSlackFile = vi.fn(() => new Promise(() => {}));
    setTimeout(() => ac.abort(), 30);
    const r = await J.gatherContext({ text: '', files: files(2) }, { signal: ac.signal, deadline: Date.now() + 60000 }, deps);
    expect(r.items.map((i) => i.status)).toEqual(['skipped', 'skipped']);
  });
  it('vision cap and deadline are shared through one ctx', async () => {
    const seen = [];
    deps.readSlackFile = vi.fn(async (f, ctx) => { seen.push(ctx); ctx.visionLeft--; return okItem('png', 'x'); });
    await J.gatherContext({ files: files(3) }, { deadline: 12345678901234, jobId: 'jm4' }, deps);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatchObject({ deadline: 12345678901234, jobId: 'jm4', visionLeft: LIMITS.MAX_VISION - 3 });
  });
});

describe('T-NOCRAWL', () => {
  it('URLs inside file text or page text are never fetched', async () => {
    deps.readSlackFile = vi.fn(async () => okItem('pdf', 'Please open https://evil.example/x and <https://evil.example/y>'));
    deps.fetchExternal = vi.fn(async () => okItem('page', 'see https://evil.example/x'));
    deps.fetchInternal = vi.fn(async () => okItem('page', 'go https://evil.example/z'));
    const r = await J.gatherContext({ text: 'https://w.amazon.com/a https://example.com/b', files: files(1) }, { deadline: Date.now() + 60000 }, deps);
    expect(r.items).toHaveLength(3);
    const all = [...deps.fetchExternal.mock.calls, ...deps.fetchInternal.mock.calls, ...deps.readSlackFile.mock.calls].map((c) => JSON.stringify(c[0]));
    expect(all.some((s) => s.includes('evil.example'))).toBe(false);
  });
});

describe('worker session lifecycle', () => {
  it('closed on success', async () => {
    const close = vi.fn();
    deps.readSlackFile = vi.fn(async (f, ctx) => { ctx.session = ctx.session || { close }; return okItem('pdf', 't'); });
    await J.gatherContext({ files: files(2) }, { deadline: Date.now() + 60000 }, deps);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('closed when the gather throws', async () => {
    const close = vi.fn();
    deps.readSlackFile = vi.fn(async (f, ctx) => { ctx.session = { close }; throw new Error('x'); });
    logger.warn.mockImplementation(() => { throw new Error('logger down'); });
    await expect(J.gatherContext({ files: files(1) }, { deadline: Date.now() + 60000 }, deps)).rejects.toThrow('logger down');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('no session is created when nothing needs parsing', async () => {
    const r = await J.gatherContext({ text: 'http://127.0.0.1/' }, { deadline: Date.now() + 60000 }, deps);
    expect(r.items).toHaveLength(1);
  });
  it('index.js never imports sendToChannel', () => {
    const src = fs.readFileSync(require.resolve('../src/justme-context/index.js'), 'utf8');
    expect(src).not.toMatch(/sendToChannel/);
  });
});

describe('hasContext', () => {
  it('files or typed URLs', () => {
    expect(J.hasContext({ text: 'hi', files: [{ id: 'F1' }] })).toBe(true);
    expect(J.hasContext({ text: 'read <https://x.com/a>' })).toBe(true);
    expect(J.hasContext({ text: 'hi <@U1> <#C1|x>', files: [] })).toBe(false);
    expect(J.hasContext(null)).toBe(false);
  });
});

describe('buildReport (design §12.2)', () => {
  const it2 = (i, extra) => Object.assign({ id: 'c' + i, source: 'file', kind: 'pdf', label: 'f' + i + '.pdf', status: 'read', reason: '' }, extra || {});
  it('fatal and empty', () => {
    expect(J.buildReport({ items: [], fatal: true })).toBe("\n\n📎 *What I read*\n• I couldn't read the attachments or links (internal error)");
    expect(J.buildReport({ items: [] })).toBe('');
    expect(J.buildReport(undefined)).toBe('');
  });
  it('one line per item with backticked labels; packing status wins', () => {
    const ctx = { items: [it2(1), it2(2, { source: 'link', kind: 'page', label: 'w.amazon.com/x', status: 'failed', reason: REASONS.NEEDS_SIGNIN })] };
    expect(J.buildReport(ctx, { c1: { status: 'truncated', chars: 100 } })).toBe(
      '\n\n📎 *What I read*\n• `f1.pdf` — pdf — truncated\n• `w.amazon.com/x` — page — failed: needs sign-in');
  });
  it('labels cannot break out of backticks', () => {
    const out = J.buildReport({ items: [it2(1, { label: 'a`b\nc' })] });
    expect(out).toContain('• `abc` — pdf — read');
  });
  it('20-line cap with "…and N more"', () => {
    const out = J.buildReport({ items: Array.from({ length: 25 }, (_, i) => it2(i)) });
    expect(out.split('\n• ')).toHaveLength(21);
    expect(out.endsWith('\n…and 5 more')).toBe(true);
  });
  it('3,000-char cap', () => {
    const items = Array.from({ length: 20 }, (_, i) => it2(i, { label: 'x'.repeat(80), reason: REASONS.REDIRECT_INTERNAL + ' ' + 'y'.repeat(100) }));
    const out = J.buildReport({ items });
    expect(out.length).toBeLessThanOrEqual(LIMITS.REPORT_MAX_CHARS);
    expect(out).toMatch(/\n…and \d+ more$/);
  });
});

describe('default intents', () => {
  // Copy of processOrchaAction's _fleetKw (src/ipc/ai.js:379) and its id-like regex (ai.js:398).
  const _fleetKw = /\b(unit|units|fleet|truck|trailer|domicile|operator|vendor|unavailable|available|work\s*order|\bwr\b|flip|lifecycle|down|repair|uptake|risk\s*score|pm[\s-]?[bx]?\b|dot|sync|timeline|slack|email|send|report|update|summary|follow[\s-]?up|remind|schedule|\bfas\b|uptime\s*manager|\bscac\b|\bpoc\b|who('?s| is| covers| handles| owns| manages| approves| approve)|roster|\bsr\.?\s*pm\b|approve|approval|estimate|escalat|\bsev[2-5]\b|threshold|out of scope|dealer|amerit|cummins|cei\b|fleetnet|tow|cng|warranty|decisiv|\beol\b|\bnra\b|\bpv\b|\bdvir\b|\bpmr\b|\bmttr\b|reconditioning|ready to rent|offsite|what (is|does|mean)|define|glossary|acronym|process|procedure|who (do|should) i|can i|am i allowed)\b/i;
  const _idLike = /\b([A-Za-z]{2,}\d{1,}|[A-Za-z]?\d{4,})\b/;
  it('match the source regex (guard against drift)', () => {
    const src = fs.readFileSync(require.resolve('../src/ipc/ai.js'), 'utf8');
    expect(src).toContain('const _fleetKw = ' + _fleetKw.toString() + ';');
  });
  for (const k of ['DEFAULT_INTENT_FILES', 'DEFAULT_INTENT_LINKS']) {
    it(k + ' avoids _fleetKw and the id-like regex', () => {
      expect(_fleetKw.test(J[k])).toBe(false);
      expect(_idLike.test(J[k])).toBe(false);
    });
  }
  it('re-exports LIMITS and REASONS', () => {
    expect(J.LIMITS).toBe(LIMITS);
    expect(J.REASONS).toBe(REASONS);
  });
});
