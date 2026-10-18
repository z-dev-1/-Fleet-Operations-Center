import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-core-phase-f-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const router = require('../src/ai/router');
const trace = require('../src/ai/trace');
const aiCore = require('../src/ai/core');

beforeEach(() => { store.save('aiTraceLog', []); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

// Both lanes healthy unless a test overrides via opts.laneHealth.
const BOTH_UP = { laneHealth: { orcha: true, claude: true } };

describe('AI Core Phase F — task classification (spec #6)', () => {
  it('classifies a short unit-status question as low-complexity unit_status', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'what state is 321060?' });
    expect(t.taskType).toBe('unit_status');
    expect(t.complexity).toBe('low');
    expect(t.actionRisk).toBe('low');
  });

  it('classifies a flip/lifecycle request as high action risk -> action_reasoning', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'can you flip 321060 back to active?' });
    expect(t.actionRisk).toBe('high');
    expect(t.taskType).toBe('action_reasoning');
    expect(t.complexity).toBe('high');
  });

  it('classifies a fleet-wide "why/across" question as multi_source_reasoning', () => {
    const t = router.classifyTask({ source: 'ui', message: 'why are so many units down across all sites this week?' });
    expect(t.taskType).toBe('multi_source_reasoning');
    expect(t.complexity).toBe('high');
  });

  it('detects a visual attachment and requires vision', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'what does this show?', attachments: { files: [{ name: 'inspection.pdf' }] } });
    expect(t.requiresVision).toBe(true);
    expect(t.taskType).toBe('attachment_understanding');
  });

  it('treats a DBR/report source as a batch report task', () => {
    const t = router.classifyTask({ source: 'dbr', message: 'generate the daily call summary' });
    expect(t.taskType).toBe('report');
    expect(t.latencyClass).toBe('batch');
  });

  it('explicit task fields override inference', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'hi', task: { taskType: 'extraction', complexity: 'low', requiresVision: false } });
    expect(t.taskType).toBe('extraction');
  });
});

describe('AI Core Phase F — lane recommendation (spec #6)', () => {
  it('routes high-risk action reasoning to the strong (Orcha) lane', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'flip 321060' });
    const r = router.recommendLane(t, BOTH_UP);
    expect(r.lane).toBe('orcha');
    expect(r.rationale).toMatch(/high-risk/i);
  });

  it('routes vision tasks to the claude (vision-capable) lane', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'read this', attachments: { files: [{ name: 'photo.png' }] } });
    const r = router.recommendLane(t, BOTH_UP);
    expect(r.lane).toBe('claude');
    expect(r.modelHint).toMatch(/vision/i);
  });

  it('routes simple classification to the fast (claude) lane', () => {
    const t = router.classifyTask({ source: 'ui', message: 'ok', task: { taskType: 'classification', complexity: 'low' } });
    const r = router.recommendLane(t, BOTH_UP);
    expect(r.lane).toBe('claude');
  });

  it('routes a normal Slack reply to the balanced/auto lane', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'thanks, can you let the vendor know we need it by friday' });
    const r = router.recommendLane(t, BOTH_UP);
    expect(r.lane).toBe('auto');
  });

  it('falls back to a healthy lane when the recommended lane is down', () => {
    const t = router.classifyTask({ source: 'slack_dm', message: 'flip 321060' }); // wants orcha (strong)
    const r = router.recommendLane(t, { laneHealth: { orcha: false, claude: true } });
    expect(r.healthy).toBe(false);
    expect(r.lane).toBe('claude');            // fell back to the healthy lane
    expect(r.fallbackLane).toBe('claude');
  });
});

describe('AI Core Phase F — run() records routing WITHOUT changing execution', () => {
  const fasAgent = require('../src/orcha/fas/agent');
  let orig;
  beforeEach(() => { orig = fasAgent.runAgent; });
  afterEach(() => { fasAgent.runAgent = orig; });

  it('attaches a routing recommendation to the result + trace but still runs through FAS', async () => {
    let called = false;
    fasAgent.runAgent = async () => {
      called = true;
      return { decision: 'answer', confidence: 0.9, reason: 'x', reply: '321060 is in shop.', actions: [], _evidence: {}, _loop: {} };
    };
    const res = await aiCore.run({ actor: { slackId: 'U_INT', type: 'internal' }, source: 'slack_dm', message: 'what state is 321060?' });
    expect(called).toBe(true);                 // execution still flows through FAS agent
    expect(res.routing).toBeTruthy();
    expect(res.routing.task.taskType).toBe('unit_status');
    expect(res.routing.recommendation.lane).toBeTruthy();
    // The trace recorded the recommended lane/model.
    const rec = trace.recent(1)[0];
    expect(rec.lane).toBe(res.routing.recommendation.lane);
    expect(rec.taskType).toBe('unit_status');
  });
});
