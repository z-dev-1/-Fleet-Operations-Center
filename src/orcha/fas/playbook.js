'use strict';
/**
 * orcha/fas/playbook.js — Digital FAS Stage 9: editable, searchable FAS playbook
 * + knowledge-draft queue.
 *
 * The playbook holds the FAS's operating rules (role, lifecycle/PM/damage/WR
 * rules, escalation conditions, communication standards, operator/domicile
 * relationships). It lives OUTSIDE the prompt in the `fasPlaybook` store; only
 * the sections that MATCH the current request are retrieved and budgeted into
 * the decision prompt.
 *
 * Knowledge drafts: when the agent learns something via ASK_INTERNAL (or you
 * want to capture reusable guidance), it goes into a reviewable `fasKnowledgeDrafts`
 * queue — NOT auto-promoted to permanent policy. You approve a draft to fold it
 * into the playbook.
 *
 * The default seed encodes rules ALREADY enforced elsewhere in the app (lifecycle
 * block-states, duplicate-WR prevention, damage/safety holds) so the agent's
 * judgment matches the app's actual behavior — nothing invented.
 */

const store = require('../../store');
const now = () => new Date().toISOString();

// ── DEFAULT PLAYBOOK SEED ────────────────────────────────────────────────────
// Each section: { id, title, tags[], body }. tags drive retrieval matching.
const DEFAULT_SECTIONS = [
  {
    id: 'role', title: 'FAS role & responsibilities',
    tags: ['role', 'responsibility', 'who', 'what do you do', 'fas'],
    body: 'You are a Fleet Asset Specialist. You keep units in service: track repairs, chase ETCs, coordinate vendors, keep partners informed, and escalate when something stalls. You own the next step until the responsible party is clearly someone else. You deliver updates proactively and never leave a partner hanging.',
  },
  {
    id: 'lifecycle', title: 'Lifecycle change rules (flip / activate)',
    tags: ['flip', 'activate', 'lifecycle', 'available', 'unavailable', 'back in service', 'return to service'],
    body: 'Flipping a unit to Active means it is ready for service. NEVER flip a unit whose lifecycleReason is "PM Failed", "Expired Inspection", or a damage/accident state ("Damaged-Moderate", "Damaged-Severe") — those must be cleared first. Do not flip a unit that still has an open work order unless the repair is confirmed complete. When flipping to Active, the reason is normally "Healthy". Lifecycle changes are an approval-required action.',
  },
  {
    id: 'work_orders', title: 'Work request rules & duplicate prevention',
    tags: ['work order', 'work request', 'wr', 'create wr', 'open wr', 'duplicate'],
    body: 'Do not create a work request for a unit that already has an open WR (check openUnplanned + openPlanned and workRequestId) — that produces duplicates. Do not create a WR for an Active/available unit. A WR needs a vendor and component area; if those are unknown, draft for review rather than guessing. WR submission is an approval-required action.',
  },
  {
    id: 'pm_inspection', title: 'PM & inspection rules',
    tags: ['pm', 'pm-b', 'pmx', 'preventive', 'inspection', 'dot', 'expired'],
    body: 'A unit with a failed PM or an expired inspection is NOT roadworthy and must not be returned to service until the PM/inspection is completed and passed. Treat "PM Failed" and "Expired Inspection" lifecycle reasons as hard holds. Flag upcoming PM-B / PM-X / DOT dates when relevant to a status question.',
  },
  {
    id: 'damage_safety', title: 'Damage & safety restrictions',
    tags: ['damage', 'damaged', 'accident', 'safety', 'hold', 'grounded'],
    body: 'Units in a damage/accident state ("Damaged-Moderate", "Damaged-Severe") are safety holds: they cannot go back in service, cannot be flipped, and any request to override that must be escalated, never actioned automatically. Safety always outranks availability pressure.',
  },
  {
    id: 'stalled_ownership', title: 'Stalled repairs & next-owner',
    tags: ['stalled', 'stuck', 'delay', 'etc', 'estimate', 'approval', 'parts', 'technician', 'tow', 'vendor response', 'owner'],
    body: 'A repair is stalled when it is waiting on something with no movement: a missing ETC, an unapproved estimate, backordered parts, no technician assigned, a pending tow, or no vendor response. Identify what it is waiting on and WHO owns the next step (vendor, dealer, FAS, partner). If it has been sitting with no confirmed ETC, say so plainly and offer to chase the owner.',
  },
  {
    id: 'escalation', title: 'Escalation conditions',
    tags: ['escalate', 'escalation', 'urgent', 'safety', 'compliance', 'override', 'unauthorized'],
    body: 'Escalate (do not auto-answer/act) when: the request needs a decision or commitment only Z can make; it involves overriding a safety/compliance hold; it is outside the sender\'s operator/domicile scope; it asks for a lifecycle/WR/cost approval the sender is not authorized for; the data needed is missing/conflicting; or the situation is genuinely ambiguous. When escalating, still send a natural in-voice holding reply.',
  },
  {
    id: 'communication', title: 'Communication standards',
    tags: ['communication', 'tone', 'reply', 'message', 'update', 'ask'],
    body: 'Reply as Zila: first person, direct, calm, accountable, concise for Slack. Distinguish DELIVERING an update (you have the info, give it) from ASKING for one (you need it, request it) — never ask a partner for a status when you are the one who should be reporting it. Address every meaningful part of a multi-part message. Never claim an action happened until it is verified. No robotic disclaimers, no raw JSON, no mention that an AI wrote it.',
  },
  {
    id: 'scoping', title: 'Operator / domicile scoping',
    tags: ['operator', 'domicile', 'scac', 'scope', 'authorization', 'permission'],
    body: 'Only disclose data within the sender\'s authorized operators/domiciles. SCAC == operator. An external partner sees only their own units; an internal user sees the full fleet. Most operators\' units belong to their SharePoint/report regardless of domicile — AZNG is the exception and is domicile-specific. Never expose fleet-wide data just because someone asks.',
  },
];

function _loadPlaybook() {
  const raw = store.load('fasPlaybook', null);
  if (raw && Array.isArray(raw.sections) && raw.sections.length) return raw;
  const seeded = { sections: DEFAULT_SECTIONS.slice(), seededAt: now(), updatedAt: now() };
  store.save('fasPlaybook', seeded);
  return seeded;
}

function getPlaybook() { return _loadPlaybook(); }

/**
 * retrieveSections(text, opts) -> [{ id, title, body }]
 * Scores each section by tag/title/body keyword overlap with the request and
 * returns the top matches (default 3). Ensures the request only ever carries
 * the RELEVANT rules, not the whole playbook.
 */
function retrieveSections(text, opts = {}) {
  const pb = _loadPlaybook();
  const q = String(text || '').toLowerCase();
  if (!q.trim()) return [];
  const words = new Set(q.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 3));
  const scored = pb.sections.map(s => {
    let score = 0;
    (s.tags || []).forEach(t => { if (q.includes(t.toLowerCase())) score += 3; });
    const hay = (s.title + ' ' + (s.tags || []).join(' ')).toLowerCase();
    words.forEach(w => { if (hay.includes(w)) score += 1; });
    return { s, score };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.max || 3).map(x => ({ id: x.s.id, title: x.s.title, body: x.s.body }));
  // Always include the communication + escalation baseline if nothing matched
  // strongly, so the agent keeps its voice/escalation discipline.
  if (!top.length) {
    return pb.sections.filter(s => s.id === 'communication' || s.id === 'escalation').map(s => ({ id: s.id, title: s.title, body: s.body }));
  }
  return top;
}

// ── KNOWLEDGE-DRAFT QUEUE ────────────────────────────────────────────────────
function _loadDrafts() { const d = store.load('fasKnowledgeDrafts', []); return Array.isArray(d) ? d : []; }

function addDraft({ topic, guidance, source }) {
  if (!guidance) return { ok: false, error: 'guidance required' };
  const drafts = _loadDrafts();
  // De-dup identical guidance still pending.
  if (drafts.some(d => d.status === 'pending' && d.guidance === guidance)) return { ok: true, deduped: true };
  const item = { id: 'kd_' + Date.now().toString(36), topic: topic || '', guidance: String(guidance).slice(0, 2000),
    source: source || 'ASK_INTERNAL', status: 'pending', createdAt: now() };
  drafts.unshift(item);
  store.save('fasKnowledgeDrafts', drafts.slice(0, 200));
  return { ok: true, item };
}

function listDrafts(status) {
  const d = _loadDrafts();
  return status ? d.filter(x => x.status === status) : d;
}

// Approve a draft -> fold it into the playbook as a new/updated section.
function approveDraft(id, sectionMeta) {
  const drafts = _loadDrafts();
  const item = drafts.find(x => x.id === id);
  if (!item) return { ok: false, error: 'not found' };
  const pb = _loadPlaybook();
  const secId = (sectionMeta && sectionMeta.id) || ('kb_' + item.id);
  const existing = pb.sections.find(s => s.id === secId);
  if (existing) { existing.body = item.guidance; existing.tags = (sectionMeta && sectionMeta.tags) || existing.tags; }
  else pb.sections.push({ id: secId, title: (sectionMeta && sectionMeta.title) || item.topic || 'Learned guidance',
    tags: (sectionMeta && sectionMeta.tags) || (item.topic ? item.topic.toLowerCase().split(/\s+/) : []), body: item.guidance });
  pb.updatedAt = now();
  store.save('fasPlaybook', pb);
  item.status = 'approved'; item.approvedAt = now();
  store.save('fasKnowledgeDrafts', drafts);
  return { ok: true, sectionId: secId };
}

function rejectDraft(id) {
  const drafts = _loadDrafts();
  const item = drafts.find(x => x.id === id);
  if (!item) return { ok: false, error: 'not found' };
  item.status = 'rejected'; item.rejectedAt = now();
  store.save('fasKnowledgeDrafts', drafts);
  return { ok: true };
}

module.exports = { getPlaybook, retrieveSections, addDraft, listDrafts, approveDraft, rejectDraft, DEFAULT_SECTIONS };
