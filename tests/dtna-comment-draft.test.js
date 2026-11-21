// DTNA Phase B: src/dtna/comment-draft.js — dealer-facing AI draft for a DTNA case comment.
// The AI lane is a fake; nothing is sent and no DTNA network module is loaded.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { freshDtna } from './fixtures/dtna/fake-electron.js';
import { CASE_ID, NO_RO_CASE_ID, COMMENTS } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);
const caseUrl = (id) => 'https://dtna.my.site.com/Servicetracker/s/case/' + id + '/detail';
const NET = /[\\/]src[\\/](dtna[\\/](aura|session|capture|writes)\.js|writes[\\/]write-gate\.js)$/;

let draft;
let ENTRY;
beforeAll(() => {
  freshDtna(require);
  // Build the cache entry with plain data (the client module is not loaded by this test).
  ENTRY = {
    caseId: CASE_ID, caseNumber: '05123456', unitId: '122269', serial: 'NP6923', caseStatus: 'In Repair',
    repairOrderNo: 'R101048154', dealerName: 'HORWITH FREIGHTLINER',
    comments: COMMENTS.slice().reverse().map((c) => ({ id: c.CommentId, type: c.CommentType, at: c.CreatedDate, from: c.FromName, text: c.CommentText.replace(/<[^>]+>/g, ' ') })),
  };
  draft = require('../src/dtna/comment-draft.js');
});

const ROW = {
  equipmentId: '122269', vendor: 'HORWITH FREIGHTLINER', issueSummary: 'Coolant leak', offsiteShopEventUrl: caseUrl(CASE_ID),
  fullConversation: 'SENTINEL_RELAY_CONVO internal', savedNotes: 'SENTINEL_SAVED_NOTE', repairTimeline: 'SENTINEL_TIMELINE',
  escalations: 'SENTINEL_ESC', insights: 'SENTINEL_INSIGHT', delayReasonCodes: 'SENTINEL_DELAY', workRequestId: '0a1b2c3d-1111-2222-3333-444455556666',
};
const lastData = { rows: [ROW] };
let ask;
function use(reply, entries = { [CASE_ID]: ENTRY }) {
  ask = vi.fn(async () => reply);
  draft._setDepsForTest({ ask, dtnaStore: { get: (id) => entries[id] || null }, store: { load: () => ({}) }, now: () => new Date('2026-09-25T12:00:00Z') });
}

beforeEach(() => use('Could you share an ETA for the coolant repair?'));

describe('draftForCase', () => {
  it('the prompt carries the DTNA thread and dealer-facing rules and none of the internal fields', async () => {
    const r = await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData });
    expect(r).toEqual({ ok: true, aiDrafted: true, draft: 'Could you share an ETA for the coolant repair?', noUpdate: false, droppedCount: 0 });
    const prompt = ask.mock.calls[0][0];
    expect(prompt).toContain('TO THE REPAIR FACILITY');
    expect(prompt).toContain('No internal Amazon details');
    expect(prompt).toContain('Please send an ETA for unit 122269');
    expect(prompt).toContain('HORWITH FREIGHTLINER');
    expect(prompt).toContain('caseStatus: In Repair');
    expect(prompt).toContain('repairOrderNo: R101048154');
    expect(prompt).toContain('Coolant leak');
    expect(prompt).not.toMatch(/SENTINEL_/);
    expect(prompt).not.toContain('0a1b2c3d-1111');
  });

  it('a sentence citing an RO not in the evidence is dropped', async () => {
    use('Could you share an ETA for the coolant repair? RO R555123987 is approved.');
    const r = await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData });
    expect(r.ok).toBe(true);
    expect(r.draft).toBe('Could you share an ETA for the coolant repair?');
    expect(r.droppedCount).toBe(1);
    expect(r).not.toHaveProperty('dropped');
  });

  it('NO NEW UPDATE -> empty draft, noUpdate', async () => {
    use('NO NEW UPDATE');
    expect(await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData })).toEqual({ ok: true, aiDrafted: true, draft: '', noUpdate: true, droppedCount: 0 });
  });

  it('not pulled -> DTNA_NOT_PULLED; another unit\'s case -> DTNA_CASE_MISMATCH; no AI call', async () => {
    use('x', {});
    expect(await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData })).toEqual({ ok: false, code: 'DTNA_NOT_PULLED' });
    use('x', { [NO_RO_CASE_ID]: Object.assign({}, ENTRY, { caseId: NO_RO_CASE_ID, unitId: '133001' }) });
    expect(await draft.draftForCase({ equipmentId: '122269', caseId: NO_RO_CASE_ID, lastData })).toEqual({ ok: false, code: 'DTNA_CASE_MISMATCH' });
    expect(ask).not.toHaveBeenCalled();
    expect(await draft.draftForCase({ equipmentId: '122269', caseId: 'bad', lastData })).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT' });
  });

  it('the unit match alone is enough when the row has no DTNA offsite URL', async () => {
    const rows = { rows: [Object.assign({}, ROW, { offsiteShopEventUrl: '' })] };
    expect((await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData: rows })).ok).toBe(true);
  });

  it('an AI failure -> code only', async () => {
    ask = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'AI_TIMEOUT' }); });
    draft._setDepsForTest({ ask, dtnaStore: { get: () => ENTRY }, store: { load: () => ({}) } });
    expect(await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData })).toEqual({ ok: false, code: 'ai-timeout' });
  });

  it('nothing is sent: no aura / session / capture / writes / write-gate module is loaded', async () => {
    await draft.draftForCase({ equipmentId: '122269', caseId: CASE_ID, lastData });
    expect(Object.keys(require.cache).filter((k) => NET.test(k))).toEqual([]);
  });
});
