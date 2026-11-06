// tests/fixtures/email-intel/actions.js — hand-built MessageRecords with an analysis already attached, for the
// pure Phase D modules (questions, derive, store, notify). The shapes follow the ledger record (ingest/ledger.js)
// and the Phase B analysis record (understand/analyze.js + ownership.determine). No model, no Outlook.
export const CONV = 'cv_00000000000000aa';
export const T = (d, h = 15) => new Date(Date.UTC(2026, 10, d, h, 0, 0)).toISOString();
export const NOW = Date.parse('2026-11-04T20:00:00.000Z');

/** q(id, text, o) -> a validated question/request as stored in analysis.result (with its stable pq_ id). */
export function q(id, text, o = {}) {
  return {
    id, ref: o.ref || 'q1', text, about: o.about || ['40123'], addressee: { kind: o.addressee || 'me', name: o.name || null, evidence: null },
    isApprovalOrDecision: !!o.decision, decisionKind: o.decision ? (o.decisionKind || 'estimate') : null, confidence: 0.9, confidenceValid: true,
  };
}

/**
 * rec({ key, conv, from, at, text, questions, requests, answers, commitments, owners:{[pqid]:owner}, role, oneToOne, fromMe,
 *       status, analyzedAt, units, relevance, toCount, ccCount, bodyStatus, reply, viaDistribution, injection, incomplete })
 */
export function rec(o = {}) {
  const at = o.at || T(4, 14);
  const questions = o.questions || [];
  const requests = o.requests || [];
  const owners = o.owners || {};
  const items = [].concat(
    questions.map((x) => ({ id: x.id, type: 'question', owner: owners[x.id] || (x.addressee.kind === 'me' ? 'me' : x.addressee.kind === 'named-other' ? 'other-person' : 'unknown'), basis: 'named', viaDistribution: false, about: x.about, addressee: x.addressee.kind, isApprovalOrDecision: x.isApprovalOrDecision, decisionKind: x.decisionKind, state: 'open', inScope: o.inScope !== false })),
    requests.map((x) => ({ id: x.id, type: 'request', owner: owners[x.id] || 'me', basis: 'named', viaDistribution: false, about: x.about, addressee: x.addressee.kind, isApprovalOrDecision: x.isApprovalOrDecision, decisionKind: x.decisionKind, state: 'open', inScope: true })),
    (o.commitments || []).map((c) => ({ id: null, type: 'commitment', owner: c.owner || (c.by === 'sender' ? 'vendor' : 'other-person'), basis: 'commitment-' + c.by, about: [], dueDate: c.dueDate || null, state: 'open', inScope: false })),
  );
  const level = o.relevance || (o.units && o.units.some((u) => u.scope === 'in') ? 'medium' : 'none');
  return {
    messageKey: o.key || 'mi_0000000000000001', conversationKey: o.conv || CONV, legacyId: o.legacyId || 'em_test1', convIdRaw: o.convIdRaw === undefined ? 'conv/raw=' : o.convIdRaw,
    convIdSource: o.convIdSource || 'owa', messageIdSource: o.messageIdSource || 'owa-item',
    subject: o.subject || 'Unit 40123 status', from: o.from || { name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' },
    to: [], cc: [], toCount: o.toCount == null ? 1 : o.toCount, ccCount: o.ccCount || 0, recipientsKnown: o.recipientsKnown !== false,
    receivedAt: at, ingestedAt: at, folder: 'Inbox',
    body: { status: o.bodyStatus || 'complete', newContent: o.text == null ? 'Message text for 40123.' : o.text },
    flags: { fromMe: !!o.fromMe, injectionSuspected: !!o.injection, threadContextIncomplete: !!o.incomplete },
    analysis: {
      status: o.status || 'ok', analyzedAt: o.analyzedAt || at,
      result: o.status && o.status !== 'ok' ? null : { questions, requests, answers: o.answers || [], commitments: o.commitments || [], units: o.resultUnits || [] },
      deterministic: { units: o.units || [{ unit: '40123', scope: 'in', mentions: 1 }] },
      determinations: o.status && o.status !== 'ok' ? null : {
        recipientRole: o.role || 'to-direct', viaDistribution: !!o.viaDistribution, oneToOne: !!o.oneToOne,
        informationRelevance: { level, reasonCode: 'x', reason: 'x', outOfScope: level === 'none' && (o.units || []).every((u) => u.scope === 'out'), inScopeUnits: (o.units || [{ unit: '40123', scope: 'in' }]).filter((u) => u.scope === 'in').map((u) => u.unit) },
        actionOwnership: { items, reason: '' },
        replyRequirement: o.reply || { value: 'none', reason: '', basis: 'informational' },
        decisionRequirement: { value: 'none', kind: null, reason: '' },
        otherResponsible: o.other || { value: false, who: null, reason: '' },
        followUpOverdue: { value: false, reason: '' }, informationalOnly: { value: true, reason: '' }, hasFleetInfo: level !== 'none', hasQuestions: questions.length > 0,
      },
    },
  };
}

/** view(records, extra) -> the deriveActions input with fresh question states. */
export function viewOf(records, questions, extra = {}) {
  return Object.assign({ conversationKey: records[0].conversationKey, records, questions: questions || {}, staged: [], applied: [] }, extra);
}
