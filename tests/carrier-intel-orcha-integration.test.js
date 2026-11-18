// tests/carrier-intel-orcha-integration.test.js — carrier-intel design B5 / B11 / B12 / B14 and
// plan D3: the CARRIER_INTEL pre-router in processOrchaAction, driven through the real
// src/ipc/ai.js with tests/helpers/orcha-action-harness.cjs (unchanged). AC-13c, AC-16, AC-19b,
// AC-24, AC-24b, AC-24c, AC-26, AC-27, AC-28, AC-29, AC-31, load failure, DBR precedence.
// Clock frozen at 2026-11-17 1:00 PM ET (run with TZ=America/New_York).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'carrier-intel-orcha-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { install } = require('./helpers/orcha-action-harness.cjs');
const I = require('../src/carrier-intel');
const C = require('../src/carrier-intel/context');
const A = require('../src/carrier-intel/answer');
const Gp = require('../src/carrier-intel/gaps');
const lookup = require('../src/dbr/lookup');

const FIX = path.join(__dirname, 'fixtures', 'carrier-intel');
const JM_FIX = path.join(__dirname, 'fixtures', 'justme-context');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const fleet = load('auvte-scac-rows.json');
const repairHistory = load('auvte-repair-history.json');
const NOW = Date.parse('2026-11-17T18:00:00Z');
const CI_INDEX = require.resolve('../src/carrier-intel/index.js');
// Z's message 7, verbatim (curly quotes included), as in tests/carrier-intel-intent.test.js.
const Q1 = 'When a box truck goes down, how long until a Cox tech actually shows up? The dashboard seems to count from assignment, not arrival.';
const Q2 = 'Have you seen Cox move techs off box trucks to trailers or hostlers? Can you name dates or units? The notes don\u2019t show it, and October is the only hint in the data.';
const Q3 = 'The CNG trucks keep coming back with misfires and voltage faults that the techs \u201Ccould not duplicate.\u201D Do the drivers report a pattern, like cold starts, after fueling or under load?';
const Q4 = 'Is box truck uptime low mainly because of repair time, or are there other causes, like units held for damage or the DSP not releasing them?';
const MSG7 = 'can you answer this questions for me real quick? ' + Q1 + '\n' + Q2 + '\n' + Q3 + '\n' + Q4
  + '\n\n \n\n \n\n \n\nthis are questions my aPP should be able to look up by itself and answer';
const COMBINED = 'AUVTE ' + [Q1, Q2, Q3, Q4].join(' ');
const FOLLOW = 'note we talking about auvte';

// A well-formed reply in imperatives and named parties (no FAS quote: enrichFor returns {}).
const GOOD = {
  answer: [{ text: 'COX holds 4 of 7 down units, all parts-holds; parts-holds are 37% of the down-days.', units: [] }],
  trends: [
    { text: 'COX moved ETC dates later 5×, 9×, 11× and 9× (B12195, B12263, B12267, B62059).', units: ['B12195', 'B12263', 'B12267', 'B62059'] },
    { text: 'Keep **this** _as is_', units: [] },
  ],
  actions: [],
  support: [{ text: 'Pay the impound fee for B62064.', units: ['B62064'], team: 'Carrier/DSP' }],
  fasInput: [{ text: 'Push COX for a parts ETA on B12195.', units: ['B12195'] }],
};
const ACTION_OBJS = ['MOVE_UNIT', 'CREATE_WR', 'TIMELINE', 'SLACK', 'APPROVE_WR', 'PIN', 'REMIND', 'SYNC']
  .map((type) => ({ type, unit: 'B12195', text: 'do it' }));
const NEG_RE = /\bnot\b|\bno\b|isn'?t|aren'?t/i;
const WRITE_FAKES = ['src/scrapers/aap_api', 'src/scrapers/aap_create_wr', 'src/writes/write-gate', 'src/orcha/repair-history',
  'src/scheduler', 'src/scrapers/carrier_briefing', 'src/scrapers/slack_send', 'src/ipc/relay-writes'];

let h, calls, writeCalls, laneCheck, enrichIds;
const setCi = (on) => { process.env.FLEET_AI_CARRIER_INTEL = on ? '1' : '0'; };
const jm = (extra) => Object.assign({ signal: new AbortController().signal, requestId: 'jm7', source: 'slack-justme' }, extra || {});
const fleetSeed = (extra) => Object.assign({ fleetData: { rows: fleet.rows, syncedAt: fleet.syncedAt }, repairHistory }, extra || {});
// A module fake whose every function records the call and throws (a write path must never run).
function throwing(name) {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
      return (...a) => { writeCalls.push(name + '.' + String(prop)); throw new Error('write path called: ' + name); };
    },
  });
}
/** Harness with a recorder relay, a read-only fleet-dbr fake and throwing write-path fakes. */
function setup(o = {}) {
  calls = { ask: [], awt: [] };
  writeCalls = [];
  enrichIds = [];
  laneCheck = vi.fn(() => true);
  const askImpl = o.ask || (async () => JSON.stringify({ reply: 'today path', actions: [] }));
  const awtImpl = o.awt || (async () => JSON.stringify(GOOD));
  const fakes = {
    'src/orcha/relay': {
      ask: (p, opts) => { calls.ask.push({ prompt: p, opts }); return askImpl(p, opts); },
      askWithTimeout: (p, opts) => { calls.awt.push({ prompt: p, opts }); return awtImpl(p, opts); },
      isolatedLaneAvailable: laneCheck,
    },
    'src/ipc/fleet-dbr': {
      enrichFor: (ids) => { enrichIds.push(ids); return {}; },
      fasNamesFor: () => [],
      cachedAapAlias: () => '',
    },
  };
  if (o.writeFakes !== false) for (const p of WRITE_FAKES) fakes[p] = throwing(p);
  h = install({ seed: o.seed === undefined ? fleetSeed() : o.seed, focusUnitId: o.focus || null,
    awarenessText: o.focus ? 'AWARENESS: screen shows ' + o.focus : '', fakes });
  return h;
}

/** The cue/data gaps the shell should render for `msg` (same inputs as index.run). */
function expectedGaps(msg, fd) {
  const hit = I.detect(msg, { rows: fleet.rows });
  const rows = fleet.rows.filter((r) => hit.assetFilter !== 'boxTruck' || r.assetType === 'boxTruck');
  const s = lookup.fleetStats({ rows, kind: 'scac', code: 'AUVTE' });
  const b = C.buildContext({ scac: 'AUVTE', rows: fleet.rows, fleetRows: fleet.rows, stats: { total: s.total, down: s.down, uptime: s.uptime },
    enrich: {}, fasNames: [], fasAlias: '', repairHistory, today: '2026-11-17', now: Date.now(), cues: hit.cues,
    assetFilter: hit.assetFilter, userMsg: msg, fd: fd || fleet });
  return b.gaps;
}
const notInData = (text) => text.slice(text.indexOf('Not in the data'));
const fill = (id, vals) => Gp.GAP_TEXT[id].replace(/\{(\w+)\}/g, (m, k) => String(vals[k]));

beforeEach(() => { vi.setSystemTime(new Date(NOW)); setCi(true); });
afterEach(() => { if (h) h.restore(); h = null; vi.useRealTimers(); setCi(false); process.env.FLEET_AI_DBR_LOOKUP = '0'; });
describe('AC-13c bounded follow-up, two turns', () => {
  it('message 7 takes today\'s path; "note we talking about auvte" answers it as carrier intel', async () => {
    setup();
    const r1 = await h.ai.processOrchaAction(MSG7, jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(r1.carrierIntel).toBeUndefined();
    expect(r1.text).toBe('today path');

    const r2 = await h.ai.processOrchaAction(FOLLOW, jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(1);
    expect(r2).toMatchObject({ ok: true, action: 'carrier-intel', carrierIntel: true });
    expect(calls.awt[0].prompt).toContain('how long until a Cox tech actually shows up');
    const nd = notInData(r2.text);
    expect(nd).toContain('Tech arrival is only captured for the current work order on 4 unit(s)');
    expect(nd).toContain(Gp.GAP_TEXT['G-REASSIGN']);
    expect(nd).toContain('Driver-reported conditions (cold start, after fueling, under load) aren\'t structured fields.');
    expect(nd).toContain('"Could not duplicate"');
    const saved = h.savesOf('chatHistory');
    expect(saved).toHaveLength(2);
    const added = saved[1].slice(-2);
    expect(added.map((m) => m.role)).toEqual(['user', 'ai']);
    expect(added[0].text).toBe(FOLLOW);
    expect(h.logs.some((l) => l.text.includes('carrier intel answered') && l.text.includes('followUp=true'))).toBe(true);
  });
  it('a 16-minute-old previous turn -> today\'s path', async () => {
    setup({ seed: fleetSeed({ chatHistory: [
      { role: 'user', text: MSG7, ts: NOW - 16 * 60 * 1000 },
      { role: 'ai', text: 'today path', ts: NOW - 16 * 60 * 1000 + 1000 },
    ] }) });
    const r = await h.ai.processOrchaAction(FOLLOW, jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(r.carrierIntel).toBeUndefined();
  });
});

describe('AC-16 one isolated askWithTimeout per carrier-intel turn, both surfaces', () => {
  for (const [source, priority] of [['slack-justme', 'high'], ['fab', 'normal']]) {
    it(source, async () => {
      setup();
      const r = await h.ai.processOrchaAction('AUVTE trends and support needed', source === 'fab' ? { source } : jm());
      expect(calls.ask).toHaveLength(0);
      expect(calls.awt).toHaveLength(1);
      expect(calls.awt[0].opts).toMatchObject({ source: 'carrier_intel', isolated: true, preferAki: true, timeoutMs: 200000, priority });
      expect(r).toMatchObject({ ok: true, action: 'carrier-intel', carrierIntel: true });
      expect(r.pendingConfirm).toBeUndefined();
      expect(enrichIds[0].slice().sort()).toEqual(['B12195', 'B12258', 'B12263', 'B12267', 'B13014', 'B62059', 'B62064']);
    });
  }
});

describe('AC-19b / plan D3 on the processOrchaAction result', () => {
  it('fab: render markers absent and item text untouched (no _toSlackFormat)', async () => {
    setup();
    const r = await h.ai.processOrchaAction('AUVTE trends and support needed', { source: 'fab' });
    expect(r.text).toContain('📈 Trends');
    expect(r.text).not.toContain('*Trends*');
    expect(r.text).toContain('• Keep **this** _as is_');
    expect(r.text.startsWith('AUVTE (ROC5) — carrier intel · 7 of 29 down')).toBe(true);
    expect(r.text.endsWith('AI analysis of extracted Relay/AAP facts.')).toBe(true);
  });
  it('slack: Slack markers present', async () => {
    setup();
    const r = await h.ai.processOrchaAction('AUVTE trends and support needed', jm());
    expect(r.text).toContain('📈 *Trends*');
    expect(r.text.startsWith('*AUVTE (ROC5) — carrier intel* · 7 of 29 down')).toBe(true);
    expect(r.text.endsWith('_AI analysis of extracted Relay/AAP facts._')).toBe(true);
  });
});
describe('AC-24 / AC-24b / AC-24c gaps end to end', () => {
  it('AC-24 arrival question -> G-ARRIVAL with n = 4, median 6.2 h, range 3.8 h to 34.3 h', async () => {
    setup();
    const r = await h.ai.processOrchaAction('AUVTE how long until a Cox tech shows up', jm());
    expect(r.carrierIntel).toBe(true);
    expect(notInData(r.text)).toContain('• ' + fill('G-ARRIVAL', { n: 4, median: '6.2', min: '3.8', max: '34.3' }));
  });

  it('AC-24b combined message: four cue gaps rendered from GAP_TEXT; planted reassignment / driver items removed', async () => {
    const reply = JSON.parse(JSON.stringify(GOOD));
    reply.trends.push({ text: 'COX moved techs from box trucks to hostlers on 10/21.', units: [] });
    reply.trends.push({ text: 'Drivers on B12271 reported cold-start misfires on 10/21.', units: ['B12271'] });
    setup({ awt: async () => JSON.stringify(reply) });
    const r = await h.ai.processOrchaAction(COMBINED, jm());
    expect(r).toMatchObject({ ok: true, carrierIntel: true });
    const gaps = expectedGaps(COMBINED);
    const nd = notInData(r.text);
    for (const id of ['G-ARRIVAL', 'G-REASSIGN', 'G-DRIVER', 'G-CND']) {
      const g = gaps.find((x) => x.id === id);
      expect(g, id).toBeTruthy();
      expect(nd).toContain('• ' + g.text);
    }
    expect(r.text).not.toContain('hostlers on 10/21');
    expect(r.text).not.toContain('cold-start misfires on 10/21');
    expect(r.text).toContain('Fact-check removed 2 item(s)');
    for (const l of r.text.split('\n')) {
      if (/reassign|moved techs|move techs/i.test(l)) expect(l).toMatch(NEG_RE);
    }
  });

  it('AC-24b maximal items + 6 h old syncedAt: <= 3,500 chars and every cue gap in full', async () => {
    const t300 = (k) => (k + ' item: keep pushing the vendor on parts for these trucks and follow up every morning ').repeat(5).slice(0, 300).trim();
    const reply = {};
    for (const k of A.SECTIONS) reply[k] = Array.from({ length: A.CAPS[k] }, () => Object.assign({ text: t300(k), units: [] }, k === 'support' ? { team: 'Vendor' } : {}));
    const fd = { rows: fleet.rows, syncedAt: new Date(NOW - 6 * 3600 * 1000).toISOString() };
    setup({ seed: fleetSeed({ fleetData: fd }), awt: async () => JSON.stringify(reply) });
    const r = await h.ai.processOrchaAction(COMBINED, jm());
    expect(r.carrierIntel).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(3500);
    const gaps = expectedGaps(COMBINED, fd);
    expect(gaps.map((g) => g.id)).toContain('G-STALE');
    const cue = gaps.filter((g) => g.kind === 'cue').map((g) => g.id);
    expect(cue).toEqual(['G-ARRIVAL', 'G-REASSIGN', 'G-DRIVER', 'G-CND', 'G-SYMPTOM', 'G-DSPHOLD']);
    for (const g of gaps.filter((x) => x.kind === 'cue')) expect(r.text).toContain('• ' + g.text);
  });

  it('AC-24c Q3 evidence: themes block in the prompt, G-DRIVER hit quote and G-CND none in the reply', async () => {
    setup();
    const r = await h.ai.processOrchaAction(COMBINED, jm());
    const p = calls.awt[0].prompt;
    const line = (pre) => p.split('\n').find((l) => l.startsWith(pre)) || '';
    expect(line('theme misfire:')).toContain('B12271 10/27–11/16');
    expect(line('theme after fueling:')).toContain('B62053 9/24–10/5');
    expect(line('theme after fueling:')).toContain('1 episode');
    expect(p).toContain('no hits: cold start, under load, could not duplicate');
    const nd = notInData(r.text);
    expect(nd).toMatch(/Free-text mentions: "10\/5 B62053: [^"]*after fueling/i);
    expect(nd).toContain(fill('G-CND-NONE', { SCAC: 'AUVTE' }));
    for (const l of r.text.split('\n')) {
      if (/cold[- ]start|under\s+load/i.test(l)) expect(l).toMatch(NEG_RE);
    }
  });
});

describe('AC-26 AI failures -> mechanical answer with the reason; abort -> ok:false', () => {
  const err = (msg, code) => { const e = new Error(msg); if (code) e.code = code; return e; };
  const cases = [
    ['lane failure (all lanes)', async () => { throw err('All AI lanes failed (preference=auto)'); }, 'AI unavailable'],
    ['lane failure (claude-code missing)', async () => { throw err('claude-code not installed on this machine'); }, 'AI unavailable'],
    ['AI timeout', async () => { throw err('timed out', 'AI_TIMEOUT'); }, 'AI timed out'],
    ['other AI error', async () => { throw err('boom', 'AKI_500'); }, 'AI unavailable'],
    ['unparseable output', async () => 'Sorry, I cannot help with that.', 'AI reply unreadable'],
  ];
  for (const [label, awt, reason] of cases) {
    it(label, async () => {
      setup({ awt });
      const r = await h.ai.processOrchaAction('AUVTE trends and support needed', jm());
      expect(r).toMatchObject({ ok: true, action: 'carrier-intel', carrierIntel: true });
      expect(r.text.endsWith('_Mechanical summary from the extracted facts (' + reason + ')._')).toBe(true);
      expect(r.text).toContain('📈 *Trends*');
      expect(laneCheck).not.toHaveBeenCalled();
      expect(calls.awt).toHaveLength(1);
      expect(calls.ask).toHaveLength(0);
    });
  }
  it('abort -> ok:false, nothing saved', async () => {
    const ac = new AbortController(); ac.abort();
    setup({ awt: async () => { throw new Error('aborted'); } });
    const r = await h.ai.processOrchaAction('AUVTE trends and support needed', jm({ signal: ac.signal }));
    expect(r).toEqual({ ok: false, text: 'Error:aborted', action: 'chat' });
    expect(h.savesOf('chatHistory')).toHaveLength(0);
    expect(laneCheck).not.toHaveBeenCalled();
  });
});
describe('AC-27 flag ON: non-carrier messages unchanged', () => {
  const CASES = [
    { n: 1, msg: "what's the status of 208336?", focus: null },
    { n: 2, msg: 'tell me a fun fact about octopuses', focus: null },
    { n: 3, msg: 'summarize this', focus: '208336' },
  ];
  async function once(on, msg, seed, focus) {
    setCi(on);
    setup({ seed, focus, ask: async () => JSON.stringify({ reply: 'answer', actions: [] }) });
    const res = await h.ai.processOrchaAction(msg, jm());
    const out = { res, prompts: calls.ask.map((c) => c.prompt), awt: calls.awt.length };
    h.restore(); h = null;
    return out;
  }
  for (const c of CASES) {
    it('golden ' + c.n + ': "' + c.msg + '" prompt byte-identical, same result', async () => {
      vi.setSystemTime(new Date(2026, 10, 4, 9, 0, 0));
      const golden = fs.readFileSync(path.join(JM_FIX, 'prompt-baseline-' + c.n + '.txt'), 'utf8');
      const on = await once(true, c.msg, {}, c.focus);
      const off = await once(false, c.msg, {}, c.focus);
      expect(on.prompts).toEqual([golden]);
      expect(on.awt).toBe(0);
      expect(on.res).toEqual(off.res);
      expect(on.res).toEqual({ ok: true, text: 'answer', action: 'chat', pendingConfirm: [] });
    });
  }
  it('"status of B12267" on the AUVTE fleet: same prompt and result as flag OFF', async () => {
    const on = await once(true, 'status of B12267', fleetSeed());
    const off = await once(false, 'status of B12267', fleetSeed());
    expect(on.awt).toBe(0);
    expect(on.prompts).toEqual(off.prompts);
    expect(on.res).toEqual(off.res);
    expect(on.res.carrierIntel).toBeUndefined();
  });
});

describe('AC-28 flag OFF -> today\'s path', () => {
  it('a carrier-intel message makes one relay.ask and no carrier-intel text', async () => {
    setCi(false);
    setup();
    const r = await h.ai.processOrchaAction('AUVTE trends and support needed', jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(calls.ask[0].prompt).not.toContain('CI ROLLUP');
    expect(calls.ask[0].prompt).not.toContain('carrier intel');
    expect(r.carrierIntel).toBeUndefined();
    expect(r.action).not.toBe('carrier-intel');
  });
});

describe('AC-29 write-path runtime check', () => {
  it('AI reply with action objects: no pendingConfirm, only chatHistory saved, no write fake called', async () => {
    setup({ awt: async () => JSON.stringify(Object.assign({}, GOOD, { actions: ACTION_OBJS })) });
    const r = await h.ai.processOrchaAction('AUVTE trends and support needed', jm());
    expect(r).toEqual({ ok: true, text: r.text, action: 'carrier-intel', carrierIntel: true });
    expect('pendingConfirm' in r).toBe(false);
    expect(h.saves.map((s) => s.key)).toEqual(['chatHistory']);
    expect(writeCalls).toEqual([]);
    expect(calls.ask).toHaveLength(0);
    expect(calls.awt).toHaveLength(1);
    for (const t of ['MOVE_UNIT', 'CREATE_WR', 'APPROVE_WR']) expect(r.text).not.toContain(t);
  });
});
describe('AC-31 context turns and unknown sources never enter carrier intel', () => {
  const doc = (text) => ({ id: 'c1', source: 'file', kind: 'pdf', label: 'report.pdf', status: 'read', text, meta: {} });
  it('untrustedContext present -> today\'s path', async () => {
    setup();
    const msg = 'AUVTE trends and support needed';
    const r = await h.ai.processOrchaAction(msg, jm({ untrustedContext: { typedText: msg, items: [doc('AUVTE trends doc body')] } }));
    expect(calls.awt.filter((c) => c.opts && c.opts.source === 'carrier_intel')).toHaveLength(0);
    expect(calls.ask).toHaveLength(1);
    expect(r.carrierIntel).toBeUndefined();
  });
  for (const opts of [{}, { source: 'phone' }, { source: 'slack' }]) {
    it('source ' + JSON.stringify(opts.source) + ' -> today\'s path', async () => {
      setup();
      const r = await h.ai.processOrchaAction('AUVTE trends and support needed', opts);
      expect(calls.ask).toHaveLength(1);
      expect(calls.awt).toHaveLength(0);
      expect(r.carrierIntel).toBeUndefined();
    });
  }
});

describe('shell edge cases', () => {
  it('require("../carrier-intel") failing -> today\'s path with a load-failed warn', async () => {
    setup();
    const prev = require.cache[CI_INDEX];
    require.cache[CI_INDEX] = { id: CI_INDEX, filename: CI_INDEX, loaded: true, children: [], get exports() { throw new SyntaxError('broken'); } };
    let r;
    try { r = await h.ai.processOrchaAction('AUVTE trends and support needed', jm()); } finally {
      if (prev) require.cache[CI_INDEX] = prev; else delete require.cache[CI_INDEX];
    }
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(r.carrierIntel).toBeUndefined();
    expect(h.logs.some((l) => l.level === 'warn' && l.text.includes('[carrier-intel] load-failed'))).toBe(true);
  });
  it('two SCACs -> "One carrier per question" with no AI call', async () => {
    const rows = fleet.rows.concat([{ equipmentId: 'S10001', operator: 'SAPB', domicileSite: 'ROC5', lifecycleState: 'Active' }]);
    setup({ seed: fleetSeed({ fleetData: { rows, syncedAt: fleet.syncedAt } }) });
    const r = await h.ai.processOrchaAction('AUVTE vs SAPB trends', jm());
    expect(r).toMatchObject({ ok: true, action: 'carrier-intel', carrierIntel: true, text: 'One carrier per question: AUVTE or SAPB?' });
    expect(calls.ask).toHaveLength(0);
    expect(calls.awt).toHaveLength(0);
  });
  it('DBR precedence: "dbr for AUVTE" -> DBR lookup; "why is AUVTE uptime low" -> carrier intel', async () => {
    process.env.FLEET_AI_DBR_LOOKUP = '1';
    setup({ awt: async (p, o) => (o.source === 'dbr_lookup' ? '{}' : JSON.stringify(GOOD)) });
    const d = await h.ai.processOrchaAction('dbr for AUVTE', jm());
    expect(d.action).toBe('dbr-lookup');
    expect(calls.awt.map((c) => c.opts.source)).toEqual(['dbr_lookup']);
    const c = await h.ai.processOrchaAction('why is AUVTE uptime low', jm());
    expect(c).toMatchObject({ action: 'carrier-intel', carrierIntel: true });
    expect(calls.awt.map((x) => x.opts.source)).toEqual(['dbr_lookup', 'carrier_intel']);
    expect(calls.ask).toHaveLength(0);
  });
});
