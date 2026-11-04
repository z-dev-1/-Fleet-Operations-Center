import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-phase3-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const session = require('../src/ai/session');
const ctxBudget = require('../src/ai/context-budget');
const router = require('../src/ai/router');

beforeEach(() => { session.clearAll(); });
afterEach(() => { session.clearAll(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Phase 3 — session/task isolation (spec §11)', () => {
  it('separates scopes so a WR classification cannot contaminate a Slack draft', () => {
    const slack = session.scopeKey({ surface: 'slack_dm', taskType: 'slack_reply', conversationId: 'D1' });
    const wr = session.scopeKey({ surface: 'ui', taskType: 'wr_classification', conversationId: 'D1' });
    expect(slack).not.toBe(wr);
    session.append(slack, 'assistant', 'Hey, the truck is in the shop.');
    session.append(wr, 'assistant', '{"component":"brakes"}');
    // The Slack scope only sees Slack turns; the WR scope only sees WR turns.
    expect(session.history(slack).map((t) => t.text).join()).toMatch(/truck is in the shop/);
    expect(session.history(slack).map((t) => t.text).join()).not.toMatch(/component/);
    expect(session.history(wr).map((t) => t.text).join()).toMatch(/component/);
  });

  it('bounds the per-scope buffer (not a transcript store)', () => {
    const k = session.scopeKey({ surface: 'ui', taskType: 'chat', conversationId: 'C1' });
    for (let i = 0; i < 30; i++) session.append(k, 'user', 'msg ' + i);
    expect(session.history(k).length).toBeLessThanOrEqual(session.MAX_TURNS_PER_SCOPE);
    // Keeps the most recent turns.
    expect(session.history(k).slice(-1)[0].text).toBe('msg 29');
  });

  it('reset() clears a scope for a fresh task', () => {
    const k = session.scopeKey({ surface: 'ui', taskType: 'extraction', conversationId: 'X' });
    session.append(k, 'user', 'something');
    session.reset(k);
    expect(session.history(k)).toEqual([]);
  });
});

describe('Phase 3 — context budgeting (spec §13)', () => {
  it('keeps required authoritative facts even when over budget; drops optional first', () => {
    const packed = ctxBudget.pack([
      { kind: 'required_facts', label: 'facts', text: 'F'.repeat(300) },
      { kind: 'optional', label: 'extra', text: 'O'.repeat(5000) },
      { kind: 'memory', label: 'mem', text: 'M'.repeat(300) },
      { kind: 'conversation', label: 'convo', text: 'C'.repeat(300) },
    ], { budgetChars: 1000 });
    const keptKinds = packed.kept.map((k) => k.kind);
    expect(keptKinds).toContain('required_facts');     // never dropped
    expect(packed.dropped.some((d) => d.kind === 'optional')).toBe(true); // dropped first
  });

  it('prioritizes conversation over history over memory over optional', () => {
    const packed = ctxBudget.pack([
      { kind: 'optional', label: 'opt', text: 'x'.repeat(400) },
      { kind: 'memory', label: 'mem', text: 'x'.repeat(400) },
      { kind: 'history', label: 'hist', text: 'x'.repeat(400) },
      { kind: 'conversation', label: 'convo', text: 'x'.repeat(400) },
    ], { budgetChars: 900 }); // only ~2 sections fit
    const kinds = packed.kept.map((k) => k.kind);
    expect(kinds).toContain('conversation');
    expect(kinds).toContain('history');
    expect(kinds).not.toContain('optional');
  });

  it('renders kept sections with labels and reports token estimate', () => {
    const packed = ctxBudget.pack([{ kind: 'required_facts', label: 'facts', text: 'hello' }], { budgetChars: 1000 });
    const text = ctxBudget.render(packed);
    expect(text).toMatch(/=== FACTS ===/);
    expect(packed.estTokens).toBeGreaterThan(0);
  });
});

describe('Phase 3 — routing is a real decision (spec §7)', () => {
  it('user preference for a concrete lane OVERRIDES automatic routing', () => {
    const d = router.decide({ source: 'slack_dm', message: 'flip 321060' }, { preference: 'claude', laneHealth: { orcha: true, claude: true } });
    expect(d.userOverride).toBe(true);
    expect(d.effectiveLane).toBe('claude');
  });

  it('auto preference uses the task-aware recommendation (strong lane for action risk)', () => {
    const d = router.decide({ source: 'slack_dm', message: 'flip 321060' }, { preference: 'auto', laneHealth: { orcha: true, claude: true } });
    expect(d.userOverride).toBe(false);
    expect(d.effectiveLane).toBe('orcha');
  });

  it('performance hook breaks a tie only for an auto recommendation (advisory)', () => {
    // A normal Slack reply recommends 'auto'; the performance hook nudges it.
    const d = router.decide({ source: 'slack_dm', message: 'thanks, please tell the vendor friday works' }, {
      preference: 'auto',
      laneHealth: { orcha: true, claude: true },
      performance: (lane) => (lane === 'claude' ? 0.97 : 0.90),
    });
    expect(d.effectiveLane).toBe('claude');
    expect(d.rationale).toMatch(/performance tie-break/);
  });

  it('performance hook never overrides an explicit user preference', () => {
    const d = router.decide({ source: 'slack_dm', message: 'hi' }, {
      preference: 'orcha',
      performance: () => 0.99,
    });
    expect(d.effectiveLane).toBe('orcha');
    expect(d.userOverride).toBe(true);
  });
});
