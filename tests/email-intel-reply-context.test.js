// tests/email-intel-reply-context.test.js — thread-aware reply context and drafting (design 6.2, 6.3; R5.1, R5.2,
// R5.3, R5.5). The isolated lane is scripted; no Outlook, no model.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mk, ZILA, DEALER, COWORKER, person } from './fixtures/email-intel/emails.js';
import { recordOf, docOf } from './fixtures/email-intel/records.js';
import { phaseCWorld, PHASE_C } from './fixtures/email-intel/phase-c.js';
import { ME } from './fixtures/email-intel/fleet.js';
const require = createRequire(import.meta.url);
const ctxMod = require('../src/email-intel/reply/context');
const draftMod = require('../src/email-intel/reply/draft');
const identity = require('../src/email-intel/ingest/identity');
const { computeRecipients } = require('../src/email-intel/reply/recipients');

const REPLIES = Object.freeze(Object.assign({}, PHASE_C, { threadReplies: true }));
const thread = (n) => {
  const doc = docOf([]);
  const recs = [];
  for (let i = 1; i <= n; i++) {
    const r = recordOf(mk({ from: i % 2 ? DEALER : COWORKER, to: [ZILA], subject: 'Pickup 40123', conversationId: 'conv-ctx', messageId: 'ctx-' + i, receivedAt: '2026-11-04T1' + (i % 10) + ':00:00.000Z', body: 'Message number ' + i + ' about unit 40123.' }), { doc });
    r.analysis = { status: 'ok', deterministic: { units: [{ unit: '40123', scope: 'in' }, { unit: '51888', scope: 'out' }] } };
    recs.push(r);
  }
  return recs;
};

describe('reply context (R5.1, R5.3)', () => {
  it('R5.1 includes prior messages and question states', () => {
    const recs = thread(8);
    const questions = {
      q_0000000000000001: { questionId: 'q_0000000000000001', status: 'answered', owner: 'me', addressee: { kind: 'me' }, text: 'Can you confirm pickup?', answeredBy: { messageKey: recs[7].messageKey } },
      q_0000000000000002: { questionId: 'q_0000000000000002', status: 'open', owner: 'other-person', addressee: { kind: 'named-other' }, text: 'Mike, is the DPF in?' },
    };
    const c = ctxMod.buildReplyContext({ records: recs, questions, me: ME, nonce: 'abcdef0123456789' });
    expect(c.messages.map((m) => m.index)).toEqual([3, 4, 5, 6, 7, 8]);                        // the last 6, oldest first
    expect(c.text).not.toContain('Message number 2 ');
    for (let i = 3; i <= 8; i++) expect(c.text).toContain('Message number ' + i + ' about unit 40123.');
    expect(c.text.match(/<<<UNTRUSTED_EMAIL id=abcdef0123456789>>>/g)).toHaveLength(6);
    expect(c.text).toContain('Message 8 of 8 | from: Mike Rivera | received: 2026-11-04T18:00:00.000Z | you are in To');
    expect(c.text).toContain('- q_0000000000000001: status=answered, addressed to=me, owner=me');
    expect(c.text).toContain('- q_0000000000000002: status=open, addressed to=named-other, owner=other-person');
    expect(c.text).toMatch(/<<<UNTRUSTED_QUESTION_TEXT id=abcdef0123456789>>>\nq_0000000000000001: Can you confirm pickup\?/);
    expect(c.questionStates).toHaveLength(2);
    expect(c.units).toEqual(['40123']);                                                        // in-scope units only
  });

  it('per-message 1,500 and total 8,000 character bounds keep the newest messages', () => {
    const recs = thread(6);
    recs.forEach((r) => { r.body.newContent = 'x'.repeat(5000); });
    const c = ctxMod.buildReplyContext({ records: recs, questions: {}, me: ME });
    expect(c.messages.map((m) => m.chars)).toEqual([500, 1500, 1500, 1500, 1500, 1500]);
  });

  it('R5.3 unverified facts labeled; staged ready claims never offered as facts', () => {
    const recs = thread(2);
    const c = ctxMod.buildReplyContext({
      records: recs, questions: {}, me: ME,
      canonicalFor: (u) => (u === '40123' ? { status: 'in_repair', repairPhase: 'awaiting_parts', nextStep: 'install turbo' } : null),
      ledgerEntries: [
        { state: 'applied', unit: '40123', kind: 'parts_eta', fact: { value: 'Turbo ETA 11/12' } },
        { state: 'superseded', unit: '40123', kind: 'parts_eta', fact: { value: 'Old ETA 11/01' } },
        { state: 'applied', unit: '51888', kind: 'parts_eta', fact: { value: 'Out of scope unit' } },
      ],
      stagedItems: [
        { state: 'open', unit: '40123', fact: { kind: 'estimated_completion', value: 'Done by 11/20', state: 'estimated' } },
        { state: 'open', unit: '40123', fact: { kind: 'pickup_readiness', value: 'Ready for pickup', state: 'ready' } },
        { state: 'rejected', unit: '40123', fact: { kind: 'blocker', value: 'Rejected blocker' } },
      ],
    });
    expect(c.text).toContain('VERIFIED: Unit 40123: status in_repair; repair phase awaiting_parts; next step install turbo');
    expect(c.text).toContain('FROM EMAIL, applied: Unit 40123: Parts ETA: Turbo ETA 11/12');
    expect(c.text).toContain('UNVERIFIED, do not state as fact: Unit 40123: Est. completion: Done by 11/20');
    expect(c.text).not.toContain('Ready for pickup');
    expect(c.text).not.toContain('Old ETA');
    expect(c.text).not.toContain('Out of scope unit');
    expect(c.text).not.toContain('Rejected blocker');
    expect(c.text).toMatch(/<<<UNTRUSTED_FLEET_FACTS id=[0-9a-f]{16}>>>/);
    expect(ctxMod.buildReplyContext({ records: recs, questions: {}, me: ME }).text).toContain('FLEET FACTS: none available');
  });

  it('R5.5 reply vs reply-all recipients', () => {
    const r = recordOf(mk({ from: DEALER, to: [ZILA, COWORKER], cc: [person(4)], subject: 'S', body: 'b' }));
    expect(computeRecipients(r, 'reply', ME).to.map((e) => e.address)).toEqual(['parts@dealer.example.test']);
    const all = computeRecipients(r, 'reply-all', ME);
    expect(all.to.map((e) => e.address)).toEqual(['parts@dealer.example.test', 'mike.rivera@example.test']);
    expect(all.cc.map((e) => e.address)).toEqual(['person04@example.test']);
    expect(computeRecipients(Object.assign({}, r, { recipientsKnown: false }), 'reply-all', ME).blocked).toBe('RECIPIENTS_UNKNOWN');
  });
});

describe('drafting with the resolved gate (R5.2)', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const seedI = (world, answered) => {
    world.questions.push({ when: 'can you confirm pickup Friday', q: { ref: 'q1', text: 'Can you confirm pickup Friday for 40123?', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup Friday' }, isApprovalOrDecision: false, confidence: 0.9 } });
    world.answers.push({ when: 'Confirmed for Friday', evidence: 'Confirmed for Friday', confidence: 0.9 });
    const caps = [world.cap({ from: DEALER, to: [ZILA], subject: 'Pickup 40123', conversationId: 'conv-rc', messageId: 'rc-1', receivedAt: '2026-11-04T14:00:00.000Z', body: 'Zila, can you confirm pickup Friday for 40123?' })];
    if (answered) caps.push(world.cap({ from: COWORKER, to: [DEALER], cc: [ZILA], subject: 'RE: Pickup 40123', conversationId: 'conv-rc', messageId: 'rc-2', receivedAt: '2026-11-04T15:00:00.000Z', body: 'Confirmed for Friday, the truck is booked for 40123.' }));
    return caps;
  };
  const CK = identity.conversationKey('conv-rc');

  it('R5.2 refuses resolved question unless forced', async () => {
    w = phaseCWorld(REPLIES);
    await w.scan(seedI(w, true));
    const ask = vi.fn(async () => ({ ok: true, text: 'Thanks Mike, noted.' }));
    const r = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply' }, { _ask: ask });
    expect(r).toMatchObject({ ok: false, code: 'ALREADY_RESOLVED', resolvedBy: { senderName: 'Mike Rivera', receivedAt: '2026-11-04T15:00:00.000Z', basis: 'later-answer' } });
    expect(ask).not.toHaveBeenCalled();
    const f = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', force: true }, { _ask: ask });
    expect(f).toMatchObject({ ok: true, draft: 'Thanks Mike, noted.', mode: 'reply', aiUnavailable: false });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1]).toMatchObject({ trigger: 'manual' });
  });

  it('an open question to me drafts through the isolated lane prompt, persists on the item and mirrors the legacy record', async () => {
    w = phaseCWorld(REPLIES);
    await w.scan(seedI(w, false));
    const ask = vi.fn(async () => ({ ok: true, text: 'Hi,\n\nYes, I approve pickup Friday. Total $200.\n\nBest' }));
    const r = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'confirm Friday' }, { _ask: ask });
    expect(r).toMatchObject({ ok: true, mode: 'reply', replyAllAvailable: true });
    expect(r.warnings.map((x) => x.code)).toEqual(['approval', 'amount']);
    expect(r.recipients.to.map((e) => e.address)).toEqual(['parts@dealer.example.test']);
    const prompt = ask.mock.calls[0][0];
    expect(prompt).toContain('SECURITY RULES');
    expect(prompt).toContain('Do NOT approve, authorize, commit to spending');
    expect(prompt).toMatch(/<<<UNTRUSTED_EMAIL id=[0-9a-f]{16}>>>\nZila, can you confirm pickup Friday for 40123\?/);
    expect(prompt).toContain('status=open, addressed to=me, owner=me');
    expect(prompt).toContain('THE USER\'S GUIDANCE FOR THIS REPLY (trusted, from the user):\nconfirm Friday');
    const reply = w.open('reply');
    expect(reply).toHaveLength(1);
    expect(reply[0].draft).toMatchObject({ text: r.draft, mode: 'reply', basedOnMessageKey: r.basedOnMessageKey });
    const legacy = w.store.load('emailTriageResults').emails.find((e) => e.intel && e.intel.conversationKey === CK);
    expect(legacy).toMatchObject({ replyState: 'drafted', replyDraft: r.draft });
  });

  it('secret-like output is DRAFT_UNSAFE; lane failure gives the starter text; unknown conversation is NOT_FOUND', async () => {
    w = phaseCWorld(REPLIES);
    await w.scan(seedI(w, false));
    expect(await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply' }, { _ask: async () => ({ ok: true, text: 'key AKIAIOSFODNN7EXAMPLE here' }) })).toEqual({ ok: false, code: 'DRAFT_UNSAFE' });
    const s = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'Pickup Friday works.' }, { _ask: async () => ({ ok: false, kind: 'lane', error: 'lane-unavailable' }) });
    expect(s).toMatchObject({ ok: true, aiUnavailable: true, draft: 'Hi Dealer,\n\nPickup Friday works.\n\nBest regards' });
    expect(await draftMod.draftThreadReply({ conversationKey: 'cv_ffffffffffffffff', mode: 'reply' }, {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
