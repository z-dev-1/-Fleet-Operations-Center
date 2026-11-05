// DBR lookup orchestrator: live fleet values, QuickSight states, labels, AI
// review + mechanical fallback, no invented numbers, Slack safety, relay call
// shape, never triggers a pull. Everything injected (no relay, no store).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const lookup = require('../src/dbr/lookup');
const engine = require('../src/dbr/review-engine');

const FIXDOC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dbr-lookup', 'fleet-rows.json'), 'utf8'));
const ROWS = FIXDOC.rows;
const META = { syncedAt: FIXDOC.syncedAt, stale: false, partial: false };
// 2026-11-05 07:00 PT (PST, UTC-8)
const NOW = new Date('2026-11-05T15:00:00.000Z');
const NOW_LATE = new Date('2026-11-06T07:30:00.000Z'); // 2026-11-05 23:30 PT
const NOW_UTC_MIDNIGHT = new Date('2026-11-06T00:30:00.000Z'); // 2026-11-05 16:30 PT
const NOW_NEXT_DAY = new Date('2026-11-06T08:30:00.000Z'); // 2026-11-06 00:30 PT

const AFP_FRESH = {
  ok: true, dataAsOf: '2026-11-05', scrapedAt: '2026-11-05T14:10:00.000Z',
  domicile: [{ domicile: 'AUVTE', uptimePct: 81.7, unitsUnavailable: 7 }],
  scac: [{ scac: 'ABEOW', domicile: 'AUVTE', uptimePct: 79.1, unitsUnavailable: 4 }],
};
const AFP_STALE = Object.assign({}, AFP_FRESH, { dataAsOf: '2026-11-03', scrapedAt: '2026-11-03T14:10:00.000Z' });
const DSP_FRESH = { ok: true, dataAsOf: '2026-11-05', scrapedAt: '2026-11-05T14:12:00.000Z', scac: [{ scac: 'ABEOW', uptimePct: 77.5, unitsUnavailable: 5, unitsUnavailableEstimated: true }] };

const down = (rows) => rows.filter(engine.isUnavail);
const auvte = ROWS.filter((r) => (r.domicileSite || r.domicile) === 'AUVTE');

const GOOD_AI = JSON.stringify({
  trends: '6 OOS; 5 CNG, 1 Diesel\nAmerit; 3 Parts; 1 ETC today; 221019',
  barriers: '521073 (27d): Parts delay — harness PN, ETA 8/13',
  expectedFlips: '1 (221019)', actions: 'Follow up with Amerit on parts ETA for 521073', helpNeeded: 'No help needed',
});

function base(extra) {
  return Object.assign({ target: 'AUVTE', rows: ROWS, fleetMeta: META, contacts: [], afp: AFP_FRESH, dsp: DSP_FRESH, now: NOW,
    ask: vi.fn(async () => GOOD_AI), source: 'fab' }, extra || {});
}

afterEach(() => { vi.restoreAllMocks(); });

describe('todayPT / qsStatus', () => {
  it('todayPT uses the Pacific day', () => {
    expect(lookup.todayPT(NOW)).toBe('2026-11-05');
    expect(lookup.todayPT(NOW_LATE)).toBe('2026-11-05');
    expect(lookup.todayPT(NOW_UTC_MIDNIGHT)).toBe('2026-11-05');
    expect(lookup.todayPT(NOW_NEXT_DAY)).toBe('2026-11-06');
  });
  it('states: fresh, stale, none, ok:false, fresh-unverified', () => {
    const s = (afp, now) => lookup.qsStatus({ afp, kind: 'domicile', code: 'AUVTE', now: now || NOW })[0].state;
    expect(s(AFP_FRESH)).toBe('fresh');
    expect(s(AFP_FRESH, NOW_LATE)).toBe('fresh');
    expect(s(AFP_FRESH, NOW_NEXT_DAY)).toBe('stale');
    expect(s(AFP_STALE)).toBe('stale');
    expect(s(null)).toBe('none');
    expect(s(Object.assign({}, AFP_FRESH, { ok: false }))).toBe('none');
    const noAsOf = Object.assign({}, AFP_FRESH, { dataAsOf: undefined });
    expect(s(noAsOf)).toBe('fresh-unverified');
    expect(s(noAsOf, NOW_NEXT_DAY)).toBe('stale');
    // scrapedAt 2026-11-06T02:00Z is 11-05 18:00 PT: still today PT at UTC midnight+
    expect(s(Object.assign({}, AFP_FRESH, { dataAsOf: undefined, scrapedAt: '2026-11-06T02:00:00.000Z' }), NOW_LATE)).toBe('fresh-unverified');
  });
  it('ok:false rows are ignored', () => {
    expect(lookup.qsStatus({ afp: Object.assign({}, AFP_FRESH, { ok: false }), kind: 'domicile', code: 'AUVTE', now: NOW })[0].rows).toEqual([]);
  });
  it('SCAC reads AFP scac and DSP scac', () => {
    const r = lookup.qsStatus({ afp: AFP_FRESH, dsp: DSP_FRESH, kind: 'scac', code: 'ABEOW', now: NOW });
    expect(r.map((x) => x.table)).toEqual(['AFP scac', 'DSP scac']);
    expect(r[0].rows).toHaveLength(1);
    expect(r[1].rows).toHaveLength(1);
  });
});

describe('fleetStats', () => {
  it('domicile and SCAC values', () => {
    const d = lookup.fleetStats({ rows: ROWS, kind: 'domicile', code: 'AUVTE' });
    expect([d.total, d.down, d.uptime]).toEqual([38, 6, 84.2]);
    const g = engine.computeGroup(down(auvte), auvte);
    expect(d.uptime).toBe(g.uptime);
    const s = lookup.fleetStats({ rows: ROWS, kind: 'scac', code: 'ABEOW' });
    expect([s.total, s.down]).toEqual([19, 3]);
    expect(lookup.fleetStats({ rows: ROWS, kind: 'domicile', code: 'OAK-W' }).total).toBe(10);
    expect(lookup.fleetStats({ rows: ROWS, kind: 'domicile', code: 'NOPE' })).toMatchObject({ total: 0, down: 0, uptime: null });
  });
});

describe('lookupDbr reply', () => {
  it('fresh row: header, live line, QuickSight line, AI sections, no pull hint', async () => {
    const r = await lookup.lookupDbr(base());
    expect(r).toMatchObject({ status: 'ok', code: 'AUVTE', kind: 'domicile', ai: 'ok' });
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('*DBR — AUVTE* (domicile) · 84.2% uptime · 6 of 38 units down');
    expect(lines[1]).toBe('• Estimated from live fleet data (as of last sync 11/05 6:42 AM PT): 84.2% · 6 down / 38 units');
    expect(lines[2]).toBe('• QuickSight (data as of 11/05): 81.7% · 7 units unavailable');
    expect(r.text).toContain('*Trends:* 6 OOS; 5 CNG, 1 Diesel\n  Amerit; 3 Parts; 1 ETC today; 221019');
    expect(r.text).toContain('*Barriers:* 521073 (27d): Parts delay — harness PN, ETA 8/13');
    expect(r.text).toContain('*Expected Flips:* 1 (221019)');
    expect(r.text).toContain('*Actions:* Follow up with Amerit on parts ETA for 521073');
    expect(r.text).toContain('*Help Needed:* No help needed');
    expect(r.text).toContain('*Down units (6):*');
    expect(r.text).toContain('_Trends/Barriers/Actions: AI review of live fleet data._');
    expect(r.text).not.toContain('pull dbr');
  });
  it('down units sorted by days down (unknown last)', async () => {
    const r = await lookup.lookupDbr(base());
    const ids = r.text.split('\n').filter((l) => /^• \w+ · /.test(l) && !l.includes('QuickSight') && !l.includes('Estimated')).map((l) => l.slice(2).split(' · ')[0]);
    expect(ids).toEqual(['330003', '521073', '521054', '330002', '330001', '221019']);
    expect(r.text).toContain('• 521073 · Amerit · Parts Delay · 27d · Parts backordered');
    expect(r.text).toContain('• 330001 · no vendor · Onsite Repair · 5d');
  });
  it('fresh but absent: not in today\'s WTD bottom 10, no hint', async () => {
    const r = await lookup.lookupDbr(base({ target: 'OAK-W' }));
    expect(r.text).toContain("• QuickSight: not in today's WTD bottom 10 (data as of 11/05)");
    expect(r.text).not.toContain('pull dbr');
  });
  it('stale row: labeled older, with hint', async () => {
    const r = await lookup.lookupDbr(base({ afp: AFP_STALE }));
    expect(r.text).toContain("• QuickSight (older, data as of 11/03, not today's): 81.7% · 7 units unavailable");
    expect(r.text).toContain('Say "pull dbr" to refresh QuickSight.');
  });
  it('stale absent: not pulled today, with hint', async () => {
    const r = await lookup.lookupDbr(base({ target: 'OAK-W', afp: AFP_STALE }));
    expect(r.text).toContain('• QuickSight: not pulled today (last data as of 11/03)');
    expect(r.text).toContain('pull dbr');
  });
  it('none: not pulled yet, with hint, reply still produced', async () => {
    const r = await lookup.lookupDbr(base({ afp: null, dsp: null }));
    expect(r.text).toContain('• QuickSight: not pulled yet');
    expect(r.text).toContain('• Estimated from live fleet data');
    expect(r.text).toContain('pull dbr');
  });
  it('missing dataAsOf with scrapedAt today: fresh-unverified label', async () => {
    const r = await lookup.lookupDbr(base({ afp: Object.assign({}, AFP_FRESH, { dataAsOf: undefined }) }));
    expect(r.text).toContain('• QuickSight (scraped 6:10 AM PT, data-as-of not recorded): 81.7% · 7 units unavailable');
    expect(r.text).not.toContain('pull dbr');
  });
  it('ok:false doc is treated as none', async () => {
    const r = await lookup.lookupDbr(base({ afp: Object.assign({}, AFP_FRESH, { ok: false }) }));
    expect(r.text).toContain('• QuickSight: not pulled yet');
  });
  it('SCAC with AFP and DSP rows shows both; DSP estimate as ~N (est.)', async () => {
    const r = await lookup.lookupDbr(base({ target: 'abeow' }));
    expect(r.text.split('\n')[0]).toBe('*DBR — ABEOW* (SCAC) · 84.2% uptime · 3 of 19 units down');
    expect(r.text).toContain('• QuickSight AFP (data as of 11/05) [AUVTE]: 79.1% · 4 units unavailable');
    expect(r.text).toContain('• QuickSight DSP (data as of 11/05): 77.5% · ~5 (est.) units unavailable');
  });
  it('PT-day boundary: 23:30 PT still fresh; 00:30 PT next day stale', async () => {
    const late = await lookup.lookupDbr(base({ now: NOW_LATE }));
    expect(late.text).toContain('• QuickSight (data as of 11/05): 81.7%');
    const utc = await lookup.lookupDbr(base({ now: NOW_UTC_MIDNIGHT }));
    expect(utc.text).toContain('• QuickSight (data as of 11/05): 81.7%');
    const next = await lookup.lookupDbr(base({ now: NOW_NEXT_DAY }));
    expect(next.text).toContain("(older, data as of 11/05, not today's)");
  });
  it('stale-sync warnings', async () => {
    expect((await lookup.lookupDbr(base({ now: NOW_LATE }))).text).toContain('(as of last sync 11/05 6:42 AM PT) ⚠ 16h old');
    expect((await lookup.lookupDbr(base({ fleetMeta: Object.assign({}, META, { partial: true }) }))).text).toContain('⚠ partial');
    expect((await lookup.lookupDbr(base({ fleetMeta: Object.assign({}, META, { stale: true }) }))).text).toContain('⚠ stale');
  });
  it('0 down: no AI call, nothing-down line, 100% only with units', async () => {
    const rows = ROWS.filter((r) => (r.domicileSite || r.domicile) !== 'OAK-W' || r.lifecycleState === 'Active');
    const ask = vi.fn();
    const r = await lookup.lookupDbr(base({ target: 'OAK-W', rows, ask }));
    expect(ask).not.toHaveBeenCalled();
    expect(r.text).toContain('• Estimated from live fleet data (as of last sync 11/05 6:42 AM PT): 100% · 0 down / 8 units');
    expect(r.text).toContain('Nothing down at OAK-W right now.');
    expect(r.text).not.toContain('*Trends:*');
  });
  it('0 units (Contact Book domicile): no uptime, no AI', async () => {
    const ask = vi.fn();
    const r = await lookup.lookupDbr(base({ target: 'BOOKONLY', contacts: [{ type: 'domicile', name: 'BOOKONLY' }], ask }));
    expect(r.status).toBe('nodata');
    expect(r.text).toContain('No units for BOOKONLY in the live fleet data (last sync 11/05 6:42 AM PT).');
    expect(r.text).not.toMatch(/uptime|\d%/);
    expect(ask).not.toHaveBeenCalled();
  });
  it('no fleet data at all: sync hint, no numbers', async () => {
    const ask = vi.fn();
    const r = await lookup.lookupDbr(base({ rows: [], afp: null, dsp: null, contacts: [{ type: 'domicile', name: 'AUVTE' }], ask }));
    expect(r.text).toContain('No live fleet data loaded yet. Sync first (say "sync").');
    expect(r.text).toContain('QuickSight: not pulled yet');
    expect(r.text).not.toContain('%');
    expect(r.text.replace(/AUVTE/g, '')).not.toMatch(/\d/);
    expect(ask).not.toHaveBeenCalled();
  });
  it('rows: [] and no QuickSight: unknown target, no digits', async () => {
    const r = await lookup.lookupDbr(base({ rows: [], afp: null, dsp: null }));
    expect(r.status).toBe('unknown');
    expect(r.text).not.toContain('%');
    expect(r.text.replace(/AUVTE/g, '')).not.toMatch(/\d/);
  });
  it('unknown with suggestions; ZZZZZ no matches; ambiguous', async () => {
    const ask = vi.fn();
    const u = await lookup.lookupDbr(base({ target: 'AUVET', ask }));
    expect(u).toMatchObject({ status: 'unknown', ai: 'skipped' });
    expect(u.text).toBe('I don\'t have "AUVET" in your domiciles or carriers. Closest: AUVTE.');
    expect((await lookup.lookupDbr(base({ target: 'ZZZZZ', ask }))).text).toContain('No close matches.');
    const amb = await lookup.lookupDbr(base({ target: 'oak w', rows: ROWS.concat([{ equipmentId: 'Z1', domicileSite: 'OAKW', lifecycleState: 'Active' }]), ask }));
    expect(amb.text).toBe('"oak w" matches more than one: OAK-W, OAKW. Which one?');
    const two = await lookup.lookupDbr(base({ target: 'AUVTE', candidates: ['AUVTE', 'OAK-W'], ask }));
    expect(two.status).toBe('ambiguous');
    expect(two.text).toContain('AUVTE, OAK-W');
    expect(ask).not.toHaveBeenCalled();
  });
  it('mine roll-up: no AI, worst first, QuickSight bottom-10 line', async () => {
    const ask = vi.fn();
    const r = await lookup.lookupDbr(base({ kind: 'mine', target: '', ask }));
    expect(r.status).toBe('mine');
    expect(ask).not.toHaveBeenCalled();
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('*DBR — my sites* · 2 of 2 domiciles with units down');
    expect(lines[1]).toContain('Estimated from live fleet data (as of last sync');
    expect(lines[2]).toBe('• OAK-W: 80% · 2 down / 10 units');
    expect(lines[3]).toBe('• AUVTE: 84.2% · 6 down / 38 units');
    expect(r.text).toContain('• QuickSight bottom-10 includes (data as of 11/05): AUVTE (81.7%)');
    expect(r.text).toContain('Ask "DBR for <site>" for Trends/Barriers/Actions.');
    const none = await lookup.lookupDbr(base({ target: 'my sites', afp: null, ask }));
    expect(none.status).toBe('mine');
    expect(none.text).toContain('pull dbr');
  });
});

describe('AI review', () => {
  it('the ask receives exactly buildReviewPrompt(label, computeGroup(down, down))', async () => {
    const ask = vi.fn(async () => GOOD_AI);
    await lookup.lookupDbr(base({ ask }));
    const dn = down(auvte);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe(engine.buildReviewPrompt('domicile AUVTE', engine.computeGroup(dn, dn)));
    await lookup.lookupDbr(base({ ask, target: 'ABEOW' }));
    const sd = down(ROWS.filter((r) => r.operator === 'ABEOW'));
    expect(ask.mock.calls[1][0]).toBe(engine.buildReviewPrompt('SCAC ABEOW', engine.computeGroup(sd, sd)));
  });
  for (const [name, ask] of [
    ['timeout (AI_TIMEOUT)', async () => { const e = new Error('DBR AI review timed out'); e.code = 'AI_TIMEOUT'; throw e; }],
    ['rejection', async () => { throw new Error('relay down'); }],
    ['non-JSON', async () => 'I cannot do that'],
  ]) {
    it('fallback on ' + name + ': mechanical sections, Actions/Help "—", mechanical footer', async () => {
      const r = await lookup.lookupDbr(base({ ask }));
      expect(r.ai).toBe('fallback');
      const dn = down(auvte);
      const m = engine.mechanicalDrafts(engine.computeGroup(dn, dn));
      expect(r.text).toContain('*Trends:* ' + m.trendsText.split('\n')[0]);
      expect(r.text).toContain('*Barriers:* ' + m.barriersText);
      expect(r.text).toContain('*Expected Flips:* ' + m.flipsText);
      expect(r.text).toContain('*Actions:* —');
      expect(r.text).toContain('*Help Needed:* —');
      expect(r.text).toContain('_Mechanical draft (AI review unavailable)._');
    });
  }
  it('aborted signal + failing ask rejects', async () => {
    const ac = new AbortController();
    const ask = async () => { ac.abort(); throw new Error('aborted by caller'); };
    await expect(lookup.lookupDbr(base({ ask, signal: ac.signal }))).rejects.toThrow('aborted by caller');
  });
  it('62 down units: first-60 note and length cap', async () => {
    const big = [];
    for (let i = 0; i < 62; i++) {
      big.push({ equipmentId: 'B' + (9000 + i), domicileSite: 'BIG62', operator: 'TUZR', lifecycleState: 'Unavailable', vendor: 'Amerit ' + 'v'.repeat(30),
        lifecycleReason: 'Offsite Shop Repair', savedRepairStatus: 'Waiting for vendor', workDuration: (i % 30) + 'd', issueDetails: 'misfire' });
    }
    big.push({ equipmentId: 'B1', domicileSite: 'BIG62', lifecycleState: 'Active' });
    const long = JSON.stringify({ trends: 't'.repeat(3000), barriers: 'b'.repeat(3000), expectedFlips: 'f'.repeat(900), actions: 'a'.repeat(3000), helpNeeded: 'Help with ' + 'h'.repeat(900) });
    const r = await lookup.lookupDbr(base({ target: 'BIG62', rows: big, ask: async () => long }));
    expect(r.text.length).toBeLessThanOrEqual(3500);
    expect(r.text.split('\n')[0]).toBe('*DBR — BIG62* (domicile) · 1.6% uptime · 62 of 63 units down');
    expect(r.text).toContain('(AI review covered the first 60 of 62 down units)');
    expect(r.text).toMatch(/• \.\.\. \+\d+ more/);
    expect(r.text.split('\n').filter((l) => l.startsWith('• B')).length).toBeLessThanOrEqual(8);
  });
  it('down list capped at 8 with +N more', async () => {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push({ equipmentId: 'C' + i, domicileSite: 'TWELVE', lifecycleState: 'Unavailable', workDuration: i + 'd' });
    const r = await lookup.lookupDbr(base({ target: 'TWELVE', rows, ask: async () => GOOD_AI }));
    expect(r.text.split('\n').filter((l) => l.startsWith('• C')).length).toBe(8);
    expect(r.text).toContain('• ... +4 more');
  });
});

describe('no invented numbers', () => {
  it('every N% in a reply is the fleet uptime, a QuickSight uptime or from the AI text', async () => {
    const aiText = GOOD_AI + ' 12.5%';
    const allowed = new Set(['84.2%', '81.7%', '79.1%', '77.5%', '80%', '100%', '12.5%']);
    for (const extra of [{}, { target: 'ABEOW' }, { target: 'OAK-W' }, { kind: 'mine', target: '' }, { afp: AFP_STALE }, { afp: null, dsp: null }]) {
      const r = await lookup.lookupDbr(base(Object.assign({ ask: async () => aiText }, extra)));
      for (const m of r.text.match(/\d+(\.\d+)?%/g) || []) expect(allowed.has(m), m + ' in ' + JSON.stringify(extra)).toBe(true);
    }
  });
});

describe('safety', () => {
  it('AI text mentions are defanged', async () => {
    const ask = async () => JSON.stringify({ trends: '<!channel> look', barriers: 'ping <@U123|bob>', expectedFlips: '<!here>', actions: '<@U999>', helpNeeded: 'Help <!everyone>' });
    const r = await lookup.lookupDbr(base({ ask }));
    expect(r.text).not.toMatch(/<!channel>|<!here>|<!everyone>|<@U/);
    expect(r.text).toContain('@\u200Bchannel look');
    expect(r.text).toContain('ping @bob');
  });
  it('unit-derived mentions are defanged', async () => {
    const rows = ROWS.map((r) => (r.equipmentId === '521073' ? Object.assign({}, r, { vendor: '<!channel> Amerit', savedRepairStatus: '<@U77>' }) : r));
    const r = await lookup.lookupDbr(base({ rows }));
    expect(r.text).not.toMatch(/<!channel>|<@U/);
  });
  it('a hostile or oversized target is never echoed', async () => {
    for (const target of ['<!channel>', 'x'.repeat(200), '']) {
      const r = await lookup.lookupDbr(base({ target }));
      expect(r.status).toBe('unknown');
      expect(r.text).toBe('Which site, domicile or carrier? Try "DBR for AUVTE".');
    }
  });
  it('never invokes scheduler.runDbrNow and never requires the scheduler or the pull scraper', async () => {
    const schedPath = require.resolve('../src/scheduler');
    const prev = require.cache[schedPath];
    const runDbrNow = vi.fn(() => { throw new Error('must not pull'); });
    require.cache[schedPath] = { id: schedPath, filename: schedPath, loaded: true, exports: { runDbrNow } };
    try {
      for (const extra of [{}, { target: 'ABEOW' }, { kind: 'mine', target: '' }, { afp: null, dsp: null }, { ask: async () => { throw new Error('x'); } }, { target: 'ZZZZZ' }]) {
        await lookup.lookupDbr(base(extra));
      }
      expect(runDbrNow).not.toHaveBeenCalled();
    } finally {
      if (prev) require.cache[schedPath] = prev; else delete require.cache[schedPath];
    }
    for (const f of ['lookup.js', 'intent.js', 'target-resolver.js', 'review-engine.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dbr', f), 'utf8');
      expect(src, f).not.toMatch(/require\(['"][./]*(scheduler|scrapers\/dbr_pull|scrapers\/quicksight_dbr)/);
      expect(src, f).not.toMatch(/require\(['"]electron['"]\)/);
      expect(src, f).not.toContain('Promise.race');
    }
  });
});

describe('production shell: run / detect', () => {
  const store = (docs) => ({ load: vi.fn((k, d) => (k in docs ? docs[k] : d)) });
  it('loads the four store keys and calls relay.askWithTimeout with the D6 shape (slack-justme -> high)', async () => {
    const st = store({ fleetData: { rows: ROWS, syncedAt: META.syncedAt }, contacts: [], quicksightDbr: AFP_FRESH, quicksightDbrDsp: DSP_FRESH });
    const relay = { askWithTimeout: vi.fn(async () => GOOD_AI) };
    const ac = new AbortController();
    const r = await lookup.run({ target: 'AUVTE', source: 'slack-justme', signal: ac.signal, requestId: 'jm42' }, { store: st, relay, now: NOW });
    expect(r.status).toBe('ok');
    expect(st.load.mock.calls.map((c) => c[0]).sort()).toEqual(['contacts', 'fleetData', 'quicksightDbr', 'quicksightDbrDsp']);
    expect(relay.askWithTimeout).toHaveBeenCalledTimes(1);
    expect(relay.askWithTimeout.mock.calls[0][1]).toEqual({ source: 'dbr_lookup', priority: 'high', timeoutMs: 75000, timeoutMessage: 'DBR AI review timed out', signal: ac.signal, requestId: 'jm42' });
  });
  it("source 'fab' -> priority normal; deps.fd / deps.contacts skip those store reads", async () => {
    const st = store({ quicksightDbr: null, quicksightDbrDsp: null });
    const relay = { askWithTimeout: vi.fn(async () => GOOD_AI) };
    await lookup.run({ target: 'AUVTE', source: 'fab' }, { store: st, relay, now: NOW, fd: { rows: ROWS, syncedAt: META.syncedAt }, contacts: [] });
    expect(relay.askWithTimeout.mock.calls[0][1].priority).toBe('normal');
    expect(st.load.mock.calls.map((c) => c[0]).sort()).toEqual(['quicksightDbr', 'quicksightDbrDsp']);
  });
  it('run with every dep injected never touches the store', async () => {
    const r = await lookup.run({ target: 'AUVTE', source: 'fab' }, { fd: { rows: ROWS }, contacts: [], afp: null, dsp: null, ask: async () => GOOD_AI, now: NOW });
    expect(r.text).toContain('as of last sync time unknown');
  });
  it('detect builds the catalog from rows / contacts / QuickSight', () => {
    expect(lookup.detect('dbr for AUVTE', { rows: ROWS })).toMatchObject({ rawTarget: 'AUVTE', mine: false });
    expect(lookup.detect('dbr for DSPONLY', { rows: [], dsp: { scac: [{ scac: 'DSPONLY' }] } })).toMatchObject({ rawTarget: 'DSPONLY' });
    expect(lookup.detect('pull dbr', { rows: ROWS })).toBeNull();
    expect(lookup.detect('dbr for my sites', {})).toMatchObject({ mine: true });
  });
});
