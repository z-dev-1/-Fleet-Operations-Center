import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-loop-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const agent = require('../src/orcha/fas/agent');
const relay = require('../src/orcha/relay');

function seed(cfg) {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40',
      lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit',
      workDuration: '20d', openUnplanned: '1', workRequestId: 'WR-777' },
  ] });
  // Internal contact so resolveSender gives broad scope.
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasConfig', Object.assign({ enabled: true, mode: 'shadow', maxSteps: 6, maxRuntimeMs: 20000,
    maxToolResultChars: 6000, retry: { inLoopRetries: 0 } }, cfg || {}));
}
beforeEach(() => { seed(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const R = (o) => JSON.stringify(o);

describe('FAS iterative research loop', () => {
  it('AI drives tool selection then answers (multi-step)', async () => {
    const calls = [];
    vi.spyOn(relay, 'ask').mockImplementation(async (prompt) => {
      calls.push(prompt);
      if (calls.length === 1) {
        // First turn: ask to research the open work orders for the unit.
        return R({ decision: 'research_more', confidence: 0.4, reason: 'need WR status',
          research: [{ tool: 'GET_OPEN_WORK_ORDERS', args: { unit: '320160' } }], actions: [], reply: '' });
      }
      // Second turn: final answer.
      return R({ decision: 'answer', confidence: 0.8, reason: 'have WR',
        research: [], actions: [], reply: '320160 has an open WR at Amerit.',
        followUp: { required: false } });
    });

    const d = await agent.runAgent({ slackId: 'U_INT', senderName: 'Zila', text: 'any update on 320160?' });
    expect(relay.ask).toHaveBeenCalledTimes(2);
    expect(d.decision).toBe('answer');
    expect(d._loop.steps).toBe(2);
    expect(d._loop.toolCalls).toBeGreaterThanOrEqual(1);
    // The requested tool actually ran and appeared in the research timeline.
    expect(d._loop.research.some(r => r.tool === 'GET_OPEN_WORK_ORDERS')).toBe(true);
    // Second prompt must contain the research results section content.
    expect(calls[1]).toContain('ADDITIONAL RESEARCH');
  });

  it('enforces maxSteps when the AI never stops researching', async () => {
    seed({ maxSteps: 3 });
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'research_more', confidence: 0.3,
      reason: 'loop', research: [{ tool: 'GET_REPAIR_TIMELINE', args: { unit: '320160' } }],
      actions: [], reply: 'partial' }));
    const d = await agent.runAgent({ slackId: 'U_INT', senderName: 'Zila', text: 'status 320160?' });
    // Never exceeds maxSteps; research_more must not escape as final.
    expect(d._loop.steps).toBeLessThanOrEqual(3);
    expect(relay.ask).toHaveBeenCalledTimes(3);
    expect(d.decision).not.toBe('research_more');
    expect(/budget exhausted|loop ended/.test(d.reason)).toBe(true);
  });

  it('skips duplicate tool+args and rejects unregistered tools', async () => {
    const calls = [];
    vi.spyOn(relay, 'ask').mockImplementation(async () => {
      calls.push(1);
      if (calls.length === 1) {
        return R({ decision: 'research_more', confidence: 0.3, reason: 'x',
          research: [
            { tool: 'GET_UNIT', args: { unit: '320160' } },
            { tool: 'GET_UNIT', args: { unit: '320160' } },          // duplicate
            { tool: 'DROP_TABLE_UNITS', args: {} },                   // not registered
          ], actions: [], reply: '' });
      }
      return R({ decision: 'answer', confidence: 0.7, reason: 'done', research: [], actions: [], reply: 'ok' });
    });
    const d = await agent.runAgent({ slackId: 'U_INT', senderName: 'Zila', text: 'about 320160' });
    const research = d._loop.research;
    expect(research.some(r => r.text && /SKIPPED/.test(r.text))).toBe(true);
    expect(research.some(r => r.tool === 'DROP_TABLE_UNITS' && /REJECTED/.test(r.text))).toBe(true);
  });

  it('research_more never escapes as a final decision', async () => {
    vi.spyOn(relay, 'ask').mockResolvedValue(R({ decision: 'research_more', confidence: 0.2,
      reason: 'x', research: [], actions: [], reply: '' })); // research_more but empty research
    const d = await agent.runAgent({ slackId: 'U_INT', senderName: 'Zila', text: 'hi' });
    expect(d.decision).not.toBe('research_more');
  });
});
