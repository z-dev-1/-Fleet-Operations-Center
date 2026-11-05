// T-PARITY-PROMPT (AC-3): with no untrusted context, processOrchaAction builds the
// exact prompt, relay options and chatHistory payload it built before the Just Me
// context reader existed. The goldens were captured from the UNMODIFIED
// src/ipc/ai.js (base f839cd2) with JMCTX_CAPTURE_BASELINE=1.
// The clock is frozen at 2026-11-04 09:00 LOCAL time (not UTC) so the prompt's
// DATE/TIME line is the same in every timezone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-parity-prompt-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { install, describeOpts } = require('./helpers/orcha-action-harness.cjs');

const FIX = path.join(__dirname, 'fixtures', 'justme-context');
const CAPTURE = process.env.JMCTX_CAPTURE_BASELINE === '1';
const CASES = [
  { n: 1, msg: "what's the status of 208336?", focus: null },
  { n: 2, msg: 'tell me a fun fact about octopuses', focus: null },
  { n: 3, msg: 'summarize this', focus: '208336' },
];
// Option shapes that must all behave exactly like "no context".
const NO_CONTEXT = [
  ['absent', undefined],
  ['empty items', { typedText: 'x', items: [] }],
  ['no string text', { typedText: 'x', items: [{ id: 'c1', text: 5 }, null, 'str'] }],
  ['items not an array', { typedText: 'x', items: 'nope' }],
];

const maxTs = (saves) => Math.max(...saves.flat().map((m) => m.ts));
const relTs = (saves, now) => saves.map((list) => list.map((m) => Object.assign({}, m, { ts: m.ts - now })));

let h;
beforeEach(() => { vi.setSystemTime(new Date(2026, 10, 4, 9, 0, 0)); });
afterEach(() => { if (h) h.restore(); h = null; vi.useRealTimers(); });

async function runCase(c, untrustedContext) {
  h = install({ focusUnitId: c.focus, awarenessText: c.focus ? 'AWARENESS: screen shows ' + c.focus : '' });
  h.setRelay(async () => '{"reply":"answer-' + c.n + '","actions":[]}');
  const opts = { signal: new AbortController().signal, requestId: 'jm7', source: 'slack-justme' };
  if (untrustedContext !== undefined) opts.untrustedContext = untrustedContext;
  const res = await h.ai.processOrchaAction(c.msg, opts);
  const out = {
    res,
    prompt: h.relayCalls[0] && h.relayCalls[0].prompt,
    argc: h.relayCalls[0] && h.relayCalls[0].argc,
    opts: h.relayCalls[0] && describeOpts(h.relayCalls[0].opts),
    chat: h.savesOf('chatHistory'),
    logs: h.logs.map((l) => l.text),
  };
  h.restore(); h = null;
  return out;
}

if (CAPTURE) {
  describe('capture goldens (unmodified ai.js only)', () => {
    it('writes prompt/opts/chatHistory baselines', async () => {
      const optsAll = {};
      const chatAll = {};
      for (const c of CASES) {
        const o = await runCase(c);
        fs.writeFileSync(path.join(FIX, 'prompt-baseline-' + c.n + '.txt'), o.prompt);
        optsAll[c.n] = { argc: o.argc, opts: o.opts };
        chatAll[c.n] = o.chat;
      }
      fs.writeFileSync(path.join(FIX, 'relay-opts-baseline.json'), JSON.stringify(optsAll, null, 2) + '\n');
      fs.writeFileSync(path.join(FIX, 'chathistory-baseline.json'), JSON.stringify(chatAll, null, 2) + '\n');
    });
  });
}

describe('T-PARITY-PROMPT: no context → byte-identical prompt, relay opts, chatHistory', () => {
  const optsBase = CAPTURE ? null : JSON.parse(fs.readFileSync(path.join(FIX, 'relay-opts-baseline.json'), 'utf8'));
  const chatBase = CAPTURE ? null : JSON.parse(fs.readFileSync(path.join(FIX, 'chathistory-baseline.json'), 'utf8'));
  for (const c of CASES) {
    for (const [label, uc] of NO_CONTEXT) {
      it('case ' + c.n + ' (' + label + ')', async () => {
        if (CAPTURE) return;
        const o = await runCase(c, uc);
        const golden = fs.readFileSync(path.join(FIX, 'prompt-baseline-' + c.n + '.txt'), 'utf8');
        expect(o.prompt).toBe(golden);
        expect({ argc: o.argc, opts: o.opts }).toEqual(optsBase[c.n]);
        expect(o.opts.keys).not.toContain('isolated');
        // ts relative to the frozen "now" (the newest entry), so the golden holds in any timezone.
        expect(relTs(o.chat, Date.now())).toEqual(relTs(chatBase[c.n], maxTs(chatBase[c.n])));
        expect(o.res).toEqual({ ok: true, text: 'answer-' + c.n, action: 'chat', pendingConfirm: [] });
        expect(o.logs.some((l) => l.includes('context turn'))).toBe(false);
      });
    }
  }
  it('the fleet case carries the fleet report, the general case does not (sanity of the goldens)', () => {
    if (CAPTURE) return;
    expect(fs.readFileSync(path.join(FIX, 'prompt-baseline-1.txt'), 'utf8')).toContain('DETAILED FLEET REPORT (for delivery/attachment)');
    expect(fs.readFileSync(path.join(FIX, 'prompt-baseline-2.txt'), 'utf8')).not.toContain('FLEET-CONTEXT-MARKER');
    expect(fs.readFileSync(path.join(FIX, 'prompt-baseline-3.txt'), 'utf8')).toContain('[screen focus: 208336]');
  });
});
