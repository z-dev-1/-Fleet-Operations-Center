// tests/ri-analysis-gate.test.js — relay-extract AC30 (§14.6 Trends): analyzeUnit validates in
// memory, gates every prose field through the shared gate, runs the self-review, and only then
// writes. An invented part # never reaches applyAiToEvent / replaceRecommendations. The cache key
// gains '|x:<extract_hash>' only for events with facts; ANALYSIS_VERSION is 2.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import * as T from './fixtures/extract/ri-trends-3.js';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const analysis = require('../src/repair-intel/analysis');

let tmpDir;
const INVENTED = '85152799';
const draft = JSON.stringify({
  summary: 'Harness repair on a dealer work order. Dealer replaced Part #' + INVENTED + ' twice.',
  events: [{ id: 'S39582', suspected_root_cause: 'chafed wiring harness', corrective_actions: 'replaced harness Part #' + INVENTED, outcome: 'partial' }],
  recommendations: [
    { kind: 'technical', finding: 'Harness failures recur', reason: 'dealer installed Part #' + INVENTED, recommendedAction: 'inspect the harness routing', priority: 'medium', confidence: 'low', supportingWos: ['S39582'] },
    { kind: 'monitor', finding: 'Order #3010287299 still open', reason: 'x', priority: 'low', confidence: 'low', supportingWos: [] },
  ],
});

describe('analysis gate ordering (AC30)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-ag-'));
    setDataDir(tmpDir);
    engine.close();
    T.seed(store, T.specs());
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('dropped values never reach the writes; writes happen after the review loop', async () => {
    const order = [];
    const asked = [];
    const relay = {
      ask: async (p) => { asked.push(p); order.push('ask'); return asked.length === 1 ? draft : 'QA:\nQ-GEN-1 | candidates: a / b | best: kept the facts\nFINAL:\n' + draft; },
      getStatus: () => ({ model: 'test-model' }),
    };
    const apply = vi.spyOn(store, 'applyAiToEvent').mockImplementation((sid, ai) => { order.push('apply'); return true; });
    const recs = vi.spyOn(store, 'replaceRecommendations').mockImplementation(() => { order.push('recs'); });
    const res = await analysis.analyzeUnit('39582', { force: true, relay });
    expect(res.ok).toBe(true);
    expect(asked).toHaveLength(2);                              // the review always runs
    expect(asked[1]).toContain('SELF-REVIEW');
    expect(asked[1]).toContain('VERIFIED FACTS');
    expect(order).toEqual(['ask', 'ask', 'apply', 'recs']);
    const all = JSON.stringify([apply.mock.calls, recs.mock.calls]);
    expect(all).not.toContain(INVENTED);
    expect(all).not.toContain('3010287299');
    expect(apply.mock.calls[0]).toEqual(['S39582', { suspected_root_cause: 'chafed wiring harness', outcome: 'partial' }]);
    const written = recs.mock.calls[0][2];
    expect(written).toHaveLength(1);                            // the rec whose finding dropped is removed
    expect(written[0]).toMatchObject({ finding: 'Harness failures recur', reason: null, recommendedAction: 'inspect the harness routing' });
    expect(res.summary).toBe('Harness repair on a dealer work order.');
    expect(res.aiGate).toBe('ok');
  });

  it('the prompt head line carries the facts digest; sourceData is facts JSON + WORK ORDERS', () => {
    const evs = store.eventsForUnit('39582');
    const b = analysis._buildPrompt('39582', { executiveSummary: {} }, evs, {});
    expect(b.prompt).toMatch(/ \| facts: parts 85152780; dealer M & K Truck Centers - Dunmore, PA/);
    expect(b.sourceData.startsWith('{')).toBe(true);
    expect(b.sourceData).toContain('WORK ORDERS (newest first):\n- id=S39582');
    expect(analysis._factsLine(null)).toBe('');
  });

  it('_evidenceHash changes with extract_hash; rows without one hash as before', () => {
    const evs = store.eventsForUnit('39582');
    const h1 = analysis._evidenceHash(evs);
    const h2 = analysis._evidenceHash(evs.map((e) => Object.assign({}, e, { extract_hash: 'other' })));
    const legacy = evs.map((e) => Object.assign({}, e, { extract_hash: null }));
    expect(h1).not.toBe(h2);
    expect(analysis._evidenceHash(legacy)).toBe(analysis._evidenceHash(legacy.map((e) => { const o = Object.assign({}, e); delete o.extract_hash; return o; })));
    expect(analysis._evidenceHash(legacy)).not.toBe(h1);
  });

  it('ANALYSIS_VERSION is 2', () => { expect(analysis.ANALYSIS_VERSION).toBe(2); });
});
