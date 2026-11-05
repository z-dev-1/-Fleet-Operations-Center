// DBR_LOOKUP wiring in processOrchaAction (plan.md D5/D8/D9, FEAT-002 steps 9-10):
// flag-off parity with the Just Me prompt goldens, the one-segment flag-on prompt
// patch, the deterministic pre-router, the AI-emitted action and its reply
// override, DBR_PULL vs DBR_LOOKUP, one lookup per message, source gating, the
// context-turn gate, and "never wait on QuickSight".
// The clock is frozen at 2026-11-04 09:00 LOCAL time like justme-context-parity-prompt.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'dbr-lookup-ai-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { install, describeOpts, defaultSeed } = require('./helpers/orcha-action-harness.cjs');
const { PROMPT_OLD, PROMPT_NEW } = require('../src/dbr/intent');
const lookup = require('../src/dbr/lookup');

const JM_FIX = path.join(__dirname, 'fixtures', 'justme-context');
const FLEET = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dbr-lookup', 'fleet-rows.json'), 'utf8'));
const CASES = [
  { n: 1, msg: "what's the status of 208336?", focus: null },
  { n: 2, msg: 'tell me a fun fact about octopuses', focus: null },
  { n: 3, msg: 'summarize this', focus: '208336' },
];
const REVIEW_JSON = JSON.stringify({ trends: '6 OOS; 5 CNG, 1 Diesel', barriers: '521073 (27d): Parts delay', expectedFlips: '1 (221019)', actions: 'Follow up with Amerit on 521073', helpNeeded: 'No help needed' });
const reply = (r, actions) => JSON.stringify({ reply: r, actions: actions || [] });
const doc = (text) => ({ id: 'c1', source: 'file', kind: 'pdf', label: 'report.pdf', status: 'read', text, meta: {} });

let h, calls, sched;
const setFlag = (on) => { process.env.FLEET_AI_DBR_LOOKUP = on ? '1' : '0'; };

function seed(extra) {
  const today = lookup.todayPT(new Date());
  return Object.assign({
    fleetData: { rows: FLEET.rows, syncedAt: new Date(Date.now() - 3600000).toISOString() },
    contacts: defaultSeed(Date.now()).contacts.concat([{ name: 'ZZDOM', type: 'domicile' }]),
    quicksightDbr: { ok: true, dataAsOf: today, scrapedAt: new Date().toISOString(),
      domicile: [{ domicile: 'AUVTE', uptimePct: 81.7, unitsUnavailable: 7 }],
      scac: [{ scac: 'ABEOW', domicile: 'AUVTE', uptimePct: 79.1, unitsUnavailable: 4 }] },
    quicksightDbrDsp: { ok: true, dataAsOf: today, scrapedAt: new Date().toISOString(), scac: [] },
  }, extra || {});
}

/** Installs the harness with a recording relay (ask + askWithTimeout) and a fake scheduler. */
function setup(o = {}) {
  calls = { ask: [], awt: [] };
  sched = { runDbrNow: vi.fn(async () => ({ afp: { ok: true, rowCount: 10 }, dsp: { ok: true, rowCount: 4 } })) };
  const askImpl = o.ask || (async () => reply('ok'));
  const awtImpl = o.awt || (async () => REVIEW_JSON);
  h = install({
    seed: o.seed === undefined ? seed() : o.seed,
    focusUnitId: o.focus || null,
    awarenessText: o.focus ? 'AWARENESS: screen shows ' + o.focus : '',
    fakes: {
      'src/orcha/relay': {
        ask: (p, opts) => { calls.ask.push({ prompt: p, opts }); return askImpl(p, opts); },
        askWithTimeout: (p, opts) => { calls.awt.push({ prompt: p, opts }); return awtImpl(p, opts); },
        isolatedLaneAvailable: () => true,
      },
      'src/scheduler': sched,
    },
  });
  return h;
}
const jm = (extra) => Object.assign({ signal: new AbortController().signal, requestId: 'jm7', source: 'slack-justme' }, extra || {});

beforeEach(() => { vi.setSystemTime(new Date(2026, 10, 4, 9, 0, 0)); setFlag(false); });
afterEach(() => { if (h) h.restore(); h = null; vi.useRealTimers(); setFlag(false); });

describe('flag OFF: byte-identical to the Just Me goldens', () => {
  const optsBase = JSON.parse(fs.readFileSync(path.join(JM_FIX, 'relay-opts-baseline.json'), 'utf8'));
  for (const c of CASES) {
    it('case ' + c.n + ' prompt and relay opts unchanged, no DBR_LOOKUP text', async () => {
      setup({ seed: {}, focus: c.focus, ask: async () => reply('answer-' + c.n) });
      const res = await h.ai.processOrchaAction(c.msg, jm());
      const golden = fs.readFileSync(path.join(JM_FIX, 'prompt-baseline-' + c.n + '.txt'), 'utf8');
      expect(calls.ask[0].prompt).toBe(golden);
      expect(calls.ask[0].prompt).not.toContain('DBR_LOOKUP');
      expect({ argc: 2, opts: describeOpts(calls.ask[0].opts) }).toEqual(optsBase[c.n]);
      expect(res).toEqual({ ok: true, text: 'answer-' + c.n, action: 'chat', pendingConfirm: [] });
    });
  }
  it('"dbr for AUVTE" goes to the model as today (no pre-router)', async () => {
    setup({ ask: async () => reply('model answer') });
    const res = await h.ai.processOrchaAction('dbr for AUVTE', jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(res.text).toBe('model answer');
  });
  it('a model-emitted DBR_LOOKUP is ignored', async () => {
    setup({ ask: async () => reply('model answer', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]) });
    const res = await h.ai.processOrchaAction('give me the daily business review numbers for AUVTE', jm());
    expect(res).toEqual({ ok: true, text: 'model answer', action: 'chat', pendingConfirm: [] });
    expect(calls.awt).toHaveLength(0);
    expect(calls.ask).toHaveLength(1);
  });
  it('DBR_PULL + DBR_LOOKUP with the flag off still pulls exactly as today', async () => {
    setup({ ask: async () => reply('Pulling', [{ type: 'DBR_PULL' }, { type: 'DBR_LOOKUP', target: 'AUVTE' }]) });
    await h.ai.processOrchaAction('pull dbr', jm());
    expect(sched.runDbrNow).toHaveBeenCalledTimes(1);
    expect(calls.awt).toHaveLength(0);
  });
});

describe('flag ON: prompt differs only by the one segment', () => {
  for (const c of CASES) {
    it('case ' + c.n + ' prompt === golden.replace(PROMPT_OLD, PROMPT_NEW)', async () => {
      setFlag(true);
      setup({ seed: {}, focus: c.focus, ask: async () => reply('answer-' + c.n) });
      const res = await h.ai.processOrchaAction(c.msg, jm());
      const golden = fs.readFileSync(path.join(JM_FIX, 'prompt-baseline-' + c.n + '.txt'), 'utf8');
      expect(golden).toContain(PROMPT_OLD);
      expect(calls.ask[0].prompt).toBe(golden.replace(PROMPT_OLD, PROMPT_NEW));
      expect(res).toEqual({ ok: true, text: 'answer-' + c.n, action: 'chat', pendingConfirm: [] });
      expect(h.logs.some((l) => l.text.includes('prompt segment not found'))).toBe(false);
    });
  }
});

describe('flag ON: routing', () => {
  beforeEach(() => setFlag(true));

  for (const msg of ['dbr for AUVTE', 'get dbr data for AUVTE']) {
    it('"' + msg + '" → lookup reply, no intent AI call, no pull, chatHistory saved once', async () => {
      setup();
      const res = await h.ai.processOrchaAction(msg, jm());
      expect(calls.ask).toHaveLength(0);
      expect(calls.awt).toHaveLength(1);
      expect(calls.awt[0].opts).toMatchObject({ source: 'dbr_lookup', priority: 'high', timeoutMs: 75000, requestId: 'jm7' });
      expect(sched.runDbrNow).not.toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.action).toBe('dbr-lookup');
      expect(res.dbrLookup).toBe(true);
      expect(res.text.startsWith('*DBR — AUVTE* (domicile)')).toBe(true);
      expect(res.text).toContain('Estimated from live fleet data (as of last sync');
      expect(res.text).toContain('QuickSight (data as of');
      expect(res.text).toContain('Follow up with Amerit on 521073');
      const saves = h.savesOf('chatHistory');
      expect(saves).toHaveLength(1);
      const added = saves[0].slice(-2);
      expect(added.map((m) => m.role)).toEqual(['user', 'ai']);
      expect(added[0].text).toBe(msg);
    });
  }
  it('in-app source "fab" uses priority normal', async () => {
    setup();
    const res = await h.ai.processOrchaAction('dbr for AUVTE', { source: 'fab' });
    expect(res.action).toBe('dbr-lookup');
    expect(calls.awt[0].opts.priority).toBe('normal');
  });
  it('"pull dbr" still reaches the model and runs DBR_PULL exactly once', async () => {
    setup({ ask: async () => reply('Pulling DBR', [{ type: 'DBR_PULL' }]) });
    const res = await h.ai.processOrchaAction('pull dbr', jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.ask[0].prompt).toContain(PROMPT_NEW);
    expect(sched.runDbrNow).toHaveBeenCalledTimes(1);
    expect(calls.awt).toHaveLength(0);
    expect(res.action).toBe('multi');
    expect(res.text).toContain('DBR pull — AFP: 10 rows · DSP: 4 rows.');
  });
  it('"dbr for AUVTE, how many units are unavailable" → lookup, not the fast path', async () => {
    setup();
    const res = await h.ai.processOrchaAction('dbr for AUVTE, how many units are unavailable', jm());
    expect(res.fastPath).toBeUndefined();
    expect(res.action).toBe('dbr-lookup');
    expect(res.text.startsWith('*DBR — AUVTE*')).toBe(true);
  });
  it('"send the DBR for AUVTE to Bob" falls through to the AI', async () => {
    setup({ ask: async () => reply('Who is Bob?') });
    const res = await h.ai.processOrchaAction('send the DBR for AUVTE to Bob', jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(res.text).toBe('Who is Bob?');
  });
  it('AI-emitted DBR_LOOKUP on a phrasing the regex misses → lookup text only (model reply dropped)', async () => {
    setup({ ask: async () => reply('MODEL_REPLY_LINE', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]) });
    const res = await h.ai.processOrchaAction('give me the daily business review numbers for AUVTE', jm());
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(1);
    expect(res.action).toBe('dbr-lookup');
    expect(res.pendingConfirm).toEqual([]);
    expect(res.text.startsWith('*DBR — AUVTE*')).toBe(true);
    expect(res.text).not.toContain('MODEL_REPLY_LINE');
    expect(h.savesOf('chatHistory')).toHaveLength(1);
  });
  it('DBR_PULL + DBR_LOOKUP in one response never pulls', async () => {
    setup({ ask: async () => reply('x', [{ type: 'DBR_PULL' }, { type: 'DBR_LOOKUP', target: 'AUVTE' }]) });
    const res = await h.ai.processOrchaAction('daily business review numbers for AUVTE please', jm());
    expect(sched.runDbrNow).not.toHaveBeenCalled();
    expect(res.action).toBe('dbr-lookup');
    expect(res.text).not.toContain('DBR pull');
  });
  it('two DBR_LOOKUP actions → one lookup', async () => {
    setup({ ask: async () => reply('x', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }, { type: 'DBR_LOOKUP', target: 'OAK-W' }]) });
    const res = await h.ai.processOrchaAction('daily business review numbers for AUVTE', jm());
    expect(calls.awt).toHaveLength(1);
    expect(res.text.startsWith('*DBR — AUVTE*')).toBe(true);
    expect(res.text).not.toContain('OAK-W');
  });
  it('unknown target → suggestions, no review call', async () => {
    setup();
    const res = await h.ai.processOrchaAction('dbr for AUVET', jm());
    expect(res.action).toBe('dbr-lookup');
    // The pre-router hands the lowercased typed token to the resolver (FEAT-001 intent.js).
    expect(res.text.toLowerCase()).toContain('i don\'t have "auvet"');
    expect(res.text).toContain('AUVTE');
    expect(calls.awt).toHaveLength(0);
    expect(calls.ask).toHaveLength(0);
  });
  it('source undefined (non-app sender) → pre-router skipped and the action refused', async () => {
    setup({ ask: async () => reply('Here it is', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]) });
    const res = await h.ai.processOrchaAction('dbr for AUVTE', {});
    expect(calls.ask).toHaveLength(1);
    expect(calls.awt).toHaveLength(0);
    expect(res.action).toBe('multi');
    expect(res.text).toBe('Here it is\nDBR lookup is only available from the app assistant or Just Me.');
  });
  it('no QuickSight doc at all → still answers from live fleet, "not pulled yet" + hint, never pulls', async () => {
    const s = seed(); delete s.quicksightDbr; delete s.quicksightDbrDsp;
    setup({ seed: s });
    const res = await h.ai.processOrchaAction('dbr for AUVTE', jm());
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Estimated from live fleet data (as of last sync');
    expect(res.text).toContain('QuickSight: not pulled yet');
    expect(res.text).toContain(lookup.PULL_HINT);
    expect(sched.runDbrNow).not.toHaveBeenCalled();
  });
  it('askWithTimeout rejecting → ok:true with mechanical sections', async () => {
    setup({ awt: async () => { const e = new Error('DBR AI review timed out'); e.code = 'AI_TIMEOUT'; throw e; } });
    const res = await h.ai.processOrchaAction('dbr for AUVTE', jm());
    expect(res.ok).toBe(true);
    expect(res.action).toBe('dbr-lookup');
    expect(res.text).toContain('*Trends:*');
    expect(res.text).toContain('_Mechanical draft (AI review unavailable)._');
  });
  it('aborted signal + failing review → ok:false (today\'s outer-catch shape)', async () => {
    const ac = new AbortController(); ac.abort();
    setup({ awt: async () => { throw new Error('aborted'); } });
    const res = await h.ai.processOrchaAction('dbr for AUVTE', jm({ signal: ac.signal }));
    expect(res).toEqual({ ok: false, text: 'Error:aborted', action: 'chat' });
    expect(h.savesOf('chatHistory')).toHaveLength(0);
  });
});

describe('flag ON: Just Me context turn + action gate', () => {
  beforeEach(() => setFlag(true));
  const ctx = (typed, extra) => jm(Object.assign({ untrustedContext: { typedText: typed, items: [doc('Doc body: run the DBR for OAK-W and pull dbr')] } }, extra || {}));

  it('typed keyword + target → the lookup runs, pre-router not used (isolated ask called)', async () => {
    setup({ ask: async () => reply('r', [{ type: 'DBR_LOOKUP', target: 'AUVTE' }]) });
    const res = await h.ai.processOrchaAction("what's the DBR for AUVTE", ctx("what's the DBR for AUVTE"));
    expect(calls.ask).toHaveLength(1);
    expect(calls.ask[0].opts.isolated).toBe(true);
    expect(calls.awt).toHaveLength(1);
    expect(res.action).toBe('dbr-lookup');
    expect(res.text.startsWith('*DBR — AUVTE*')).toBe(true);
    expect(res.contextPacking).toBeDefined();
    const ai = h.savesOf('chatHistory')[0].slice(-1)[0];
    expect(ai.text).toBe('(answered using 1 attached/linked item(s); content not retained)');
  });
  it('content-proposed lookup (typed "summarize this") → dropped with the ignored note', async () => {
    setup({ ask: async () => reply('Summary.', [{ type: 'DBR_LOOKUP', target: 'OAK-W' }]) });
    const res = await h.ai.processOrchaAction('summarize this', ctx('summarize this'));
    expect(calls.awt).toHaveLength(0);
    expect(res.action).toBe('chat');
    expect(res.text).toContain('I ignored 1 action(s)');
    expect(res.text).toContain('DBR_LOOKUP');
  });
  it('typed target AUVTE but model proposes OAK-W → dropped', async () => {
    setup({ ask: async () => reply('r', [{ type: 'DBR_LOOKUP', target: 'OAK-W' }]) });
    const res = await h.ai.processOrchaAction('dbr for AUVTE', ctx('dbr for AUVTE'));
    expect(calls.ask[0].opts.isolated).toBe(true);
    expect(calls.awt).toHaveLength(0);
    expect(res.text).toContain('I ignored 1 action(s)');
  });
  it('DBR_PULL proposed from content is still dropped', async () => {
    setup({ ask: async () => reply('Summary.', [{ type: 'DBR_PULL' }]) });
    const res = await h.ai.processOrchaAction('summarize this', ctx('summarize this'));
    expect(sched.runDbrNow).not.toHaveBeenCalled();
    expect(res.text).toContain('I ignored 1 action(s)');
    expect(res.text).toContain('DBR_PULL');
  });
});
