// tests/email-intel-ownership.test.js — relevance / ownership / reply as separate determinations
// (design 3.8; PG-1, PG-3, R2.1, R2.2, R2.5, R2.8, R2.9).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { ME } from './fixtures/email-intel/fleet.js';
import { mk, person, ZILA, COWORKER, DEALER } from './fixtures/email-intel/emails.js';
import { recordOf, scopeIndex } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const own = require('../src/email-intel/understand/ownership');
const scope = require('../src/email-intel/understand/scope');

const idx = scopeIndex('fresh');
const DL = { name: 'Fleet Ops', address: 'fleet-ops@example.test' };
const factUnit = (unit) => ({ unit, scope: idx.scopeOf(unit), facts: [{ kind: 'parts_eta', state: 'eta_given', value: 'ETA 11/12', assertion: 'stated', confidence: 0.9, confidenceValid: true }] });
const q = (o) => Object.assign({ id: 'pq_' + Math.random().toString(16).slice(2, 10), ref: 'q1', text: 'Can you confirm pickup Friday?', about: ['40123'], addressee: { kind: 'unclear', name: null, evidence: null }, isApprovalOrDecision: false, decisionKind: null, confidence: 0.8, confidenceValid: true }, o);
const result = (o = {}) => Object.assign({ units: [factUnit('40123')], questions: [], requests: [], answers: [], commitments: [], relevance: { level: 'high' }, classification: { category: 'fleet_status_update', intent: 'provide_update' } }, o);
function det(m, res, extra = {}) {
  const rec = recordOf(m, { me: extra.me || ME, over: extra.over });
  const scan = scope.scanMessage(rec, idx);
  return own.determine(res, rec, { me: extra.me || ME, mentions: scan.all, scopeOf: idx.scopeOf, answered: extra.answered, now: Date.parse('2026-11-04T16:00:00Z') });
}

const RECIPIENT_VARIANTS = [
  { label: 'sole To', to: [ZILA], cc: [] },
  { label: '20 To', to: Array.from({ length: 20 }, (_, i) => (i === 7 ? ZILA : person(i + 1))), cc: [] },
  { label: 'CC', to: [COWORKER], cc: [ZILA] },
  { label: 'DL', to: [DL], cc: [] },
  { label: 'not listed', to: [COWORKER], cc: [person(9)] },
];

describe('recipient role', () => {
  it('to-direct / cc / to-dl / cc-dl / sender-self / unknown', () => {
    const role = (m, over, me) => own.recipientRole(recordOf(m, { over, me }), me || ME);
    expect(role(mk({ to: [ZILA] }))).toBe('to-direct');
    expect(role(mk({ to: [COWORKER], cc: [ZILA] }))).toBe('cc');
    expect(role(mk({ to: [DL] }))).toBe('to-dl');
    expect(role(mk({ to: [COWORKER], cc: [DL] }))).toBe('cc-dl');
    expect(role(mk({ from: ZILA, to: [COWORKER] }))).toBe('sender-self');
    expect(role(mk({ to: [ZILA] }), { recipientsKnown: false })).toBe('unknown');
    expect(role(mk({ to: [ZILA] }), null, { names: [], addresses: [], distributionLists: [] })).toBe('unknown');
    const heur = own.roleDetail(recordOf(mk({ to: [{ name: 'DL-Fleet East', address: 'dl-fleet-east@example.test' }] })), ME);
    expect(heur).toMatchObject({ role: 'to-dl', viaDistribution: 'possible' });
  });
});

describe('PG-1 / R2.1 relevance is content-only', () => {
  it('PG-1 relevance is identical for sole-To, 20-To, CC, DL', () => {
    const levels = RECIPIENT_VARIANTS.map((v) => det(mk({ to: v.to, cc: v.cc, subject: 'Parts 40123', body: 'Parts arrived for unit 40123.' }), result()).informationRelevance);
    for (const l of levels) expect(l).toEqual(levels[0]);
    expect(levels[0]).toMatchObject({ level: 'high', reasonCode: 'in-scope-fact' });
  });
  it('R2.1 recipient count never lowers relevance (property over random recipient sets)', () => {
    const bodies = ['Parts arrived for unit 40123.', 'Unit 40456 mentioned only.', 'Only 51888 here.', 'Nothing about units.'];
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    for (const body of bodies) {
      const ref = own.deriveRelevance({ units: [], mentions: scope.extractUnits(body, idx), aiLevel: 'low' });
      for (let i = 0; i < 25; i++) {
        const to = Array.from({ length: Math.floor(rnd() * 30) }, (_, k) => person(k + 1));
        if (rnd() < 0.5) to.push(ZILA);
        const cc = Array.from({ length: Math.floor(rnd() * 10) }, (_, k) => person(k + 40));
        const d = det(mk({ to, cc, subject: 'x', body }), result({ units: [], relevance: { level: 'low' } }));
        expect(d.informationRelevance).toEqual(ref);
      }
    }
  });
  it('R2.1 AI scope cannot downgrade deterministic in-scope', () => {
    expect(own.deriveRelevance({ units: [], mentions: [{ id: '40123', scope: 'in' }], aiLevel: 'none' }).level).toBe('medium');
    expect(own.deriveRelevance({ units: [factUnit('40123')], mentions: [{ id: '40123', scope: 'in' }], aiLevel: 'low' }).level).toBe('high');
    expect(own.deriveRelevance({ units: [], mentions: [{ id: '40123', scope: 'unknown' }], aiLevel: 'none' })).toMatchObject({ level: 'medium', scopeUnknown: true });
    expect(own.deriveRelevance({ units: [], mentions: [{ id: '51888', scope: 'out' }], aiLevel: 'high' })).toMatchObject({ level: 'low', outOfScope: true });
    expect(own.deriveRelevance({ units: [], mentions: [], aiLevel: 'medium' }).level).toBe('medium');
  });
});

describe('ownership and reply', () => {
  it('R2.2 relevance/ownership/reply are separate fields', () => {
    const d = det(mk({ to: [COWORKER], cc: [ZILA], subject: 'DPF 40123', body: 'Mike, can you check the DPF on 40123? Dealer says ETA 11/14.' }),
      result({ questions: [q({ addressee: { kind: 'named-other', name: 'Mike', evidence: 'Mike, can you check' } })] }));
    expect(d.informationRelevance.level).toBe('high');
    expect(d.actionOwnership.items[0].owner).toBe('other-person');
    expect(d.replyRequirement).toMatchObject({ value: 'none', basis: 'owned-by-other' });
  });
  it('PG-3 three independent fields with reasons', () => {
    const d = det(mk({ to: [ZILA] }), result());
    for (const k of ['informationRelevance', 'replyRequirement', 'decisionRequirement', 'otherResponsible', 'followUpOverdue', 'informationalOnly']) expect(typeof d[k].reason).toBe('string');
    expect(d.actionOwnership.reason).toEqual(expect.any(String));
  });
  it('R2.5 named-other is not mine, even about my unit and even when I am in To', () => {
    for (const v of RECIPIENT_VARIANTS) {
      const d = det(mk({ to: v.to, cc: v.cc, subject: 'x', body: 'Mike, can you check 40123?' }), result({ questions: [q({ addressee: { kind: 'named-other', name: 'Mike', evidence: 'Mike, can you check' } })] }));
      expect(d.replyRequirement.value, v.label).toBe('none');
      expect(d.actionOwnership.items[0].owner).toBe('other-person');
    }
  });
  it('R2.5 me requires evidence: a validated me (named) is required; unclear in a group mail stays unknown', () => {
    expect(det(mk({ to: [COWORKER], cc: [ZILA] }), result({ questions: [q({ addressee: { kind: 'me', basis: 'named' } })] })).replyRequirement.value).toBe('required');
    const d = det(mk({ to: [COWORKER, ZILA] }), result({ questions: [q()] }));
    expect(d.actionOwnership.items[0].owner).toBe('unknown');
    expect(d.replyRequirement.value).toBe('none');
  });
  it('the 1:1 rule turns an unclear second-person question into mine', () => {
    const d = det(mk({ from: DEALER, to: [ZILA], subject: 'Pickup 40123', body: 'Can you confirm pickup Friday?' }), result({ questions: [q()] }));
    expect(d.oneToOne).toBe(true);
    expect(d.actionOwnership.items[0]).toMatchObject({ owner: 'me', basis: 'direct-1to1' });
    expect(d.replyRequirement.value).toBe('required');
    // the same question with one CC is not 1:1
    expect(det(mk({ from: DEALER, to: [ZILA], cc: [COWORKER], body: 'Can you confirm pickup Friday?' }), result({ questions: [q()] })).replyRequirement.value).not.toBe('required');
  });
  it('R2.8 assigned task / request to me / shared question / question to other', () => {
    const m = mk({ to: [ZILA, COWORKER], subject: 'Status 40123', body: 'Team, status of 40123?' });
    const task = det(m, result({ requests: [q({ text: 'Please schedule the tow for 40123', addressee: { kind: 'me', basis: 'named' } })] }));
    expect(task.actionOwnership.items[0]).toMatchObject({ type: 'request', owner: 'me' });
    expect(task.replyRequirement.value).toBe('required');
    const shared = det(m, result({ questions: [q({ addressee: { kind: 'group' } })] }));
    expect(shared.actionOwnership.items[0].owner).toBe('shared');
    expect(shared.replyRequirement.value).toBe('suggested');
    const other = det(m, result({ questions: [q({ addressee: { kind: 'named-other', name: 'Mike' } })] }));
    expect(other.replyRequirement.value).toBe('none');
    expect(other.otherResponsible).toMatchObject({ value: true, who: 'other-person' });
  });
  it('R2.9 distribution list is not assignment', () => {
    const d = det(mk({ to: [DL], subject: 'All units', body: 'Can you all confirm pickup for 40123?' }), result({ questions: [q()] }));
    expect(d.recipientRole).toBe('to-dl');
    expect(d.actionOwnership.items[0].owner).not.toBe('me');
    expect(d.actionOwnership.items[0].viaDistribution).toBe(true);
    expect(d.replyRequirement.value).not.toBe('required');
    const g = det(mk({ to: [DL], body: 'Can you all confirm pickup for 40123?' }), result({ questions: [q({ addressee: { kind: 'group' } })] }));
    expect(g.actionOwnership.items[0].owner).toBe('shared');
    expect(g.replyRequirement.value).toBe('none');            // shared via a DL: not To-direct, no suggestion
  });
  it('my own message never creates an item for me; an answered question needs no reply', () => {
    const mine = det(mk({ from: ZILA, to: [COWORKER] }), result({ questions: [q({ addressee: { kind: 'me', basis: 'named' } })] }));
    expect(mine.replyRequirement).toMatchObject({ value: 'none', basis: 'sender-self' });
    const qq = q({ addressee: { kind: 'me', basis: 'named' } });
    const answered = det(mk({ to: [ZILA] }), result({ questions: [qq] }), { answered: new Set([qq.id]) });
    expect(answered.actionOwnership.items[0].state).toBe('answered');
    expect(answered.replyRequirement.value).toBe('none');
  });
  it('decision requirement mirrors ownership for approvals', () => {
    const appr = q({ text: 'Please approve the $1,840 estimate', isApprovalOrDecision: true, decisionKind: 'estimate', addressee: { kind: 'me', basis: 'named' } });
    expect(det(mk({ to: [COWORKER], cc: [ZILA] }), result({ questions: [appr] })).decisionRequirement).toMatchObject({ value: 'me', kind: 'estimate' });
    const unclear = Object.assign({}, appr, { addressee: { kind: 'unclear' } });
    expect(det(mk({ to: [COWORKER], cc: [ZILA] }), result({ questions: [unclear] })).decisionRequirement.value).toBe('suggested');
  });
});
