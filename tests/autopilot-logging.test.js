// tests/autopilot-logging.test.js — Autopilot V2 log hygiene during a full multi-turn run (AC-32,
// FR-15.5, design §11.4): with SENTINEL-<nonce> texts in every untrusted fixture field and in the
// model output, no captured log line carries the sentinel, nor cookie / token / bearer text.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('./helpers/autopilot-fakes.cjs');
const { runInvestigation } = require('../src/autopilot/investigate');
const { createLimiter } = require('../src/autopilot/limiter');

const U = '322283';

describe('AC-32: logs carry codes, counts, ids and ms only', () => {
  it('no log line contains the sentinel or cookie/token/bearer text after a multi-turn run', async () => {
    F.freshDb('log');
    F.schema.ensureSchema();
    const SENT = 'SENTINEL-' + crypto.randomBytes(6).toString('hex');
    const ck = F.clock();
    const row = F.baseRow({ asistSrUrl: F.SR, decisivCaseId: '21350186', fullConversation: '11/19 - Vendor: ' + SENT + ' cookie=abc token=xyz', asistNotes: SENT });
    const w = F.mkWorld({
      rows: [row], isolated: true,
      dtna: { [U]: [{ caseId: 'C1', unitId: U, offsiteStage: 'repair', stageSince: '2026-11-18T00:00:00Z', thread: [{ at: '2026-11-19', text: SENT + ' Bearer abc' }] }] },
      decisivStatus: () => ({ ok: true, value: { stage: 'ready', status: SENT } }),
      slack: [{ ts: '1', when: '2026-11-19T10:00:00Z', excerpt: SENT }],
    });
    w.docs.decisivCaseCache = { 21350186: { estimateId: '21350186', stage: 'repair', scrapedAt: new Date(F.T0 - 24 * F.H).toISOString() } };
    w.docs.notesStore = { [U]: { timeline: '11/18 - ' + SENT } };
    w.docs.emailEvidence = { [U]: [{ messageId: 'm1', field: 'repairUpdate', value: SENT, quote: SENT }] };
    const lines = [];
    const cap = (lvl) => (...a) => lines.push(lvl + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const logger = { debug: cap('debug'), info: cap('info'), warn: cap('warn'), error: cap('error') };
    const turn = (tools, memory) => ({ schemaVersion: 2, decision: 'request_tools', tools, memory: memory || {} });
    const reason = F.fakePlanner([
      turn([{ tool: 'dtna_case', args: { unit: U }, why: SENT }, { tool: 'slack_evidence', args: { unit: U } }], { hypotheses: [{ statement: SENT, confidence: 0.4 }], openQuestions: [{ question: SENT }] }),
      turn([{ tool: 'decisiv_activity', args: { unit: U } }, { tool: 'outlook_evidence', args: { unit: U } }]),
      (o) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(o.prompt, { summary: SENT + ' token' }) }),
    ]);
    const { caseId } = F.seedCase(U);
    const r = await runInvestigation(caseId, {
      ports: F.fakePorts(w), cfg: F.cfgOf({ features: { liveReads: true, multiTurn: true } }), now: ck.now, rand: () => 0.5, owner: 'own',
      reason, limiter: createLimiter({ now: ck.now, random: () => 0 }), trigger: 'new', logger,
    });
    expect(r.ok).toBe(true);
    expect(reason.calls.length).toBe(3);
    expect(lines.length).toBeGreaterThan(0);                 // the adapter summary line and the run line were captured
    for (const l of lines) {
      expect(l).not.toContain(SENT);
      expect(l).not.toMatch(/cookie|token|bearer/i);
    }
  });
});
