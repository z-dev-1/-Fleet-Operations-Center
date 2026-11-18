// tests/deep-scan-planned-dedupe.test.js — the API path lists an open PLANNED WO
// both as _plannedWRData and as a _secondaryWRs entry. The deep-scan prompt
// must carry that WO's conversation once; other secondaries are unchanged.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
import * as S from './fixtures/extract/deep-scan-output-shape.js';
const require = createRequire(import.meta.url);

fx.installStubs();
const ds = require('../src/orcha/deep-scan');
const ON = () => ({ flags: { enabled: true, aiOutput: true, reviewRounds: 0, reviewMaxPerRun: 200 }, budget: { left: 200 } });

beforeEach(() => { fx.resetRecorders(); vi.useFakeTimers({ toFake: ['Date'], now: S.NOW }); });
afterEach(() => { vi.useRealTimers(); });

const count = (s, sub) => s.split(sub).length - 1;
async function promptFor(u) {
  const prompts = [];
  const fn = vi.fn(async (p) => { prompts.push(p); return { ok: true, text: S.draftText(S.SHAPE_LINES) }; });
  await ds._processUnit(u, {}, fn, ON());
  return prompts[0];
}

describe('deep-scan planned WO dedupe', () => {
  it('a planned WO in both _plannedWRData and _secondaryWRs is fed once; a second unplanned WO still is', async () => {
    const planned = { workRequestId: 'svc-dd-p', vendor: 'Cummins', _wrType: 'planned', serviceState: 'Scheduled',
      fullConversation: 'Conversation\n2026-11-10 PLANNEDTHREAD pm booked friday' };
    const other = { workRequestId: 'svc-dd-u2', vendor: 'Amerit', _wrType: 'unplanned', serviceState: 'In Progress',
      fullConversation: 'Conversation\n2026-11-10 OTHERTHREAD battery on order' };
    const u = Object.assign(S.unitRow(), { _plannedWRData: planned, _secondaryWRs: [other, planned] });
    const p = await promptFor(u);
    expect(count(p, 'PLANNEDTHREAD')).toBe(1);
    expect(p).toContain('RELAY GARAGE CONVERSATION (Planned WR -- Cummins)');
    expect(count(p, 'OTHERTHREAD')).toBe(1);
  });
});
