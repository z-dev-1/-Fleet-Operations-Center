import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-9-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const playbook = require('../src/orcha/fas/playbook');

function reset() {
  store.save('fasPlaybook', null);
  store.save('fasKnowledgeDrafts', []);
}
beforeEach(() => { reset(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('FAS Stage 9 — playbook seeding + retrieval', () => {
  it('seeds a default playbook with the core rule sections', () => {
    const pb = playbook.getPlaybook();
    const ids = pb.sections.map(s => s.id);
    expect(ids).toContain('lifecycle');
    expect(ids).toContain('work_orders');
    expect(ids).toContain('damage_safety');
    expect(ids).toContain('escalation');
  });

  it('retrieves ONLY the relevant sections for a flip request', () => {
    const secs = playbook.retrieveSections('can you flip 320160 back to active?');
    const ids = secs.map(s => s.id);
    expect(ids).toContain('lifecycle');
    expect(ids.length).toBeLessThanOrEqual(3); // not the whole playbook
  });

  it('retrieves work-order rules for a create-WR request', () => {
    const secs = playbook.retrieveSections('please open a work order for this unit');
    expect(secs.map(s => s.id)).toContain('work_orders');
  });

  it('retrieves damage/safety rules for a damaged unit', () => {
    const secs = playbook.retrieveSections('unit is damaged in an accident, can we still use it?');
    expect(secs.map(s => s.id)).toContain('damage_safety');
  });

  it('falls back to communication+escalation baseline when nothing matches', () => {
    const secs = playbook.retrieveSections('zzzz qqqq');
    const ids = secs.map(s => s.id);
    expect(ids).toContain('communication');
    expect(ids).toContain('escalation');
  });
});

describe('FAS Stage 9 — knowledge-draft queue', () => {
  it('adds a draft (pending), dedupes identical pending guidance', () => {
    const r1 = playbook.addDraft({ topic: 'ARC claim', guidance: 'ARC claims route through X', source: 'ASK_INTERNAL' });
    expect(r1.ok).toBe(true);
    const r2 = playbook.addDraft({ topic: 'ARC claim', guidance: 'ARC claims route through X' });
    expect(r2.deduped).toBe(true);
    expect(playbook.listDrafts('pending')).toHaveLength(1);
  });

  it('approving a draft folds it into the playbook (retrievable) and marks approved', () => {
    playbook.addDraft({ topic: 'towing', guidance: 'Towing must be pre-approved by FAS before dispatch.' });
    const d = playbook.listDrafts('pending')[0];
    const res = playbook.approveDraft(d.id, { id: 'towing_rule', title: 'Towing approval', tags: ['tow', 'towing'] });
    expect(res.ok).toBe(true);
    // Now retrievable from the playbook.
    const secs = playbook.retrieveSections('do we need approval to tow this unit?');
    expect(secs.some(s => /pre-approved/i.test(s.body))).toBe(true);
    expect(playbook.listDrafts('approved')).toHaveLength(1);
  });

  it('rejecting a draft does not add it to the playbook', () => {
    playbook.addDraft({ topic: 'x', guidance: 'some unverified claim' });
    const d = playbook.listDrafts('pending')[0];
    playbook.rejectDraft(d.id);
    expect(playbook.listDrafts('rejected')).toHaveLength(1);
    const secs = playbook.retrieveSections('some unverified claim');
    expect(secs.some(s => /unverified claim/i.test(s.body))).toBe(false);
  });
});

describe('FAS Stage 9 — agent uses the playbook', () => {
  it('includes relevant playbook rules in the decision prompt', async () => {
    // Seed minimal fleet + contact so evidence builds.
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
      { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed', vendor: 'Amerit' },
    ] });
    store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Z', org: 'Amazon', email: 'z@amazon.com' }]);
    store.save('slackSenderProfiles', {});
    store.save('fasCases', {});
    store.save('fasConfig', { enabled: true, mode: 'shadow' });

    const relay = require('../src/orcha/relay');
    let capturedPrompt = '';
    vi.spyOn(relay, 'ask').mockImplementation(async (p) => { capturedPrompt = p; return '{"decision":"escalate","confidence":0.9,"reason":"pm failed hold","actions":[],"reply":"can\'t flip — it failed PM","followUp":{"required":false}}'; });

    const agent = require('../src/orcha/fas/agent');
    await agent.runAgent({ slackId: 'U_INT', senderName: 'Z', text: 'flip 320160 back to active' });
    expect(capturedPrompt).toContain('FAS PLAYBOOK');
    expect(capturedPrompt).toMatch(/PM Failed|Expired Inspection|damage/i); // lifecycle rule pulled in
  });
});
