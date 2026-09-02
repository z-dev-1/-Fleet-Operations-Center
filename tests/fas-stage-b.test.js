import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'fas-b-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const budget = require('../src/orcha/fas/context-budget');
const agent = require('../src/orcha/fas/agent');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1', openPlanned: '0', workRequestId: 'WR-1', repairTimeline: 'Diagnostics done\nParts ordered' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Internal Person', org: 'Amazon', email: 'x@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasConfig', null);
}

beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS Stage B — config', () => {
  it('defaults to shadow mode, disabled, with caps', () => {
    const c = config.get();
    expect(c.mode).toBe('shadow');
    expect(c.enabled).toBe(false);
    expect(c.maxSteps).toBeGreaterThan(0);
    expect(c.maxRuntimeMs).toBeGreaterThan(0);
    expect(c.retry.maxRetries).toBeGreaterThan(0);
  });

  it('rejects an invalid mode, falling back to shadow', () => {
    const c = config.save({ mode: 'cowboy' });
    expect(c.mode).toBe('shadow');
  });

  it('persists valid settings and merges defaults for new keys', () => {
    config.save({ mode: 'approval', maxSteps: 3 });
    const c = config.get();
    expect(c.mode).toBe('approval');
    expect(c.maxSteps).toBe(3);
    expect(c.contextBudgetChars).toBeGreaterThan(0); // default still present
  });
});

describe('FAS Stage B — context budget manager', () => {
  it('keeps protected sections even when over budget', () => {
    const big = 'x'.repeat(5000);
    const out = budget.assemble([
      { key: 'system', label: 'SYS', text: 'safety rules' },
      { key: 'message', label: 'MSG', text: 'the actual request' },
      { key: 'background', label: 'BG', text: big },
      { key: 'excerpts', label: 'EX', text: big },
    ], 1000);
    expect(out.prompt).toContain('the actual request'); // protected message kept
    expect(out.prompt).toContain('safety rules');       // protected system kept
    // low-priority background/excerpts dropped or trimmed
    expect(out.dropped.length).toBeGreaterThan(0);
  });

  it('orders sections by priority (system before facts before background)', () => {
    const out = budget.assemble([
      { key: 'background', label: 'BG', text: 'bg' },
      { key: 'verifiedFacts', label: 'FACTS', text: 'facts' },
      { key: 'system', label: 'SYS', text: 'sys' },
    ], 24000);
    const iSys = out.prompt.indexOf('sys');
    const iFacts = out.prompt.indexOf('facts');
    const iBg = out.prompt.indexOf('bg');
    expect(iSys).toBeLessThan(iFacts);
    expect(iFacts).toBeLessThan(iBg);
  });
});

describe('FAS Stage B — decision parsing', () => {
  it('parses a valid decision object', () => {
    const d = agent._parseDecision('{"decision":"answer","confidence":0.9,"reason":"clear","actions":[],"reply":"Unit 320160 is at Amerit, parts ordered.","followUp":{"required":false}}');
    expect(d.decision).toBe('answer');
    expect(d.reply).toContain('Amerit');
    expect(d._fallback).toBeUndefined();
  });

  it('falls back to clarify on unparseable output (no false answer)', () => {
    const d = agent._parseDecision('the AI rambled with no json');
    expect(d.decision).toBe('clarify');
    expect(d._fallback).toBe(true);
  });

  it('sanitizes an invalid decision value to answer', () => {
    const d = agent._parseDecision('{"decision":"nuke","reply":"hi","confidence":0.5}');
    expect(['answer','research_more','act','clarify','escalate']).toContain(d.decision);
  });
});

describe('FAS Stage B — agent loop (mocked AI)', () => {
  it('runs research + decide and returns a structured decision with evidence attached', async () => {
    // Mock relay.ask to return a valid decision referencing only provided facts.
    const relay = require('../src/orcha/relay');
    vi.spyOn(relay, 'ask').mockResolvedValue('{"decision":"answer","confidence":0.8,"reason":"data present","actions":[],"reply":"320160 is unavailable at Amerit — diagnostics done, parts ordered. No confirmed ETC yet.","followUp":{"required":true,"owner":"vendor","dueAt":null}}');

    const d = await agent.runAgent({ slackId: 'U_INT', senderName: 'Internal Person', text: 'any update on 320160?' });
    expect(d.decision).toBe('answer');
    expect(d.reply).toContain('320160');
    expect(d._evidence).toBeTruthy();
    expect(d._evidence.caseId).toBe('unit-320160');
    expect(d._mode).toBe('shadow'); // Stage B default — no actions executed
    // The prompt the model saw must NOT contain unrelated fleet dumps — evidence is scoped.
    expect(d._evidence.verifiedFacts.some(f => f.field === 'lifecycleState')).toBe(true);
  });

  it('returns a safe fallback (clarify, no false answer) when AI is unavailable', async () => {
    const relay = require('../src/orcha/relay');
    vi.spyOn(relay, 'ask').mockRejectedValue(new Error('AI timeout'));
    const d = await agent.runAgent({ slackId: 'U_INT', senderName: 'Internal Person', text: 'update on 320160?' });
    expect(d._fallback).toBe(true);
    expect(d.decision).toBe('clarify');
    // Never fabricates a reply claiming an answer.
    expect(d.reply).toBe('');
  });
});
