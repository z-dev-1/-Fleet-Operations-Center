// tests/autopilot-record.test.js — Autopilot V2 §7.4 structured findings record (AC-29, FR-14).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildRecord } = require('../src/autopilot/record');
const evidence = require('../src/autopilot/evidence');

const NOW = Date.parse('2026-11-20T15:00:00Z');
const FIELDS = ['case_id', 'unit_id', 'schema_version', 'operator', 'owner', 'domicile', 'oos_status', 'days_down', 'repair_phase', 'root_cause',
  'blocker', 'responsible_party', 'last_verified_update_at', 'last_verified_update_source', 'parts_eta', 'repair_eta', 'confidence', 'ai_status',
  'investigated_at', 'record_json'];

const col = evidence.createCollector({ now: NOW });
const stage = col.add('decisiv', 'stage', 'repair', { entry: { since: '2026-11-19T14:00:00Z' }, retrievedAt: NOW }, { sourceRef: 'decisiv/1' });
const parts = col.add('aap_cache', 'partsEta', '2026-11-27', { row: {}, buildAtMs: NOW }, { sourceRef: 'row/partsEta' });
const tl = col.add('timeline', 'line', '11/18 - Vendor: turbo', { retrievedAt: NOW }, { sourceRef: 'timeline/x', observedAt: NOW - 86400e3 });
const canon = col.add('canonical', 'status', 'in_repair', { record: {} }, { sourceRef: 'canonical/status' });
const pack = { items: col.items, conflicts: { groups: [{ group: 'cf_repairStatus', fields: ['repairStatus'], positions: [{ evidenceId: stage.evidenceId, source: 'decisiv', field: 'stage', value: 'repair' }], authorityWinner: null }] } };
const rec = { case_id: 'c1', unit_id: '322283', operator: 'TUZR', owner: 'AZNG', domicile: 'ABE40', episode_key: '322283:2026-11-15', wo_set_json: JSON.stringify([{ id: 'svc-1', role: 'primary', firstSeenAt: NOW - 5 }]) };
const analysis = { reasons: ['OOS', 'WAITING_PARTS'], daysDown: 5.2, repairPhase: 'in_repair', blockers: ['parts'], responsibleParty: 'parts_supplier',
  lastVendorUpdate: { at: NOW - 3600e3, source: 'aap_live' }, eta: { status: 'FUTURE', date: '2026-11-28', source: 'decisiv' } };
const aiOut = (ids, extra) => Object.assign({
  schemaVersion: 1, generatedBy: 'ai', summary: 's',
  confirmedFacts: [{ statement: 'Decisiv shows repair', evidenceIds: ids }],
  inferences: [{ statement: 'Turbo parts are the blocker', confidence: 0.8, evidenceIds: ids }],
  stageStall: { stalled: false, stage: 'unknown', evidenceIds: [] }, missingInfo: [{ item: 'parts ETA', whyNeeded: 'w', likelySource: 'vendor' }],
  responsibleParty: { party: 'vendor', evidenceIds: ids },
  recommendedActions: [{ action: 'Watch', actionClass: 'monitor', evidenceIds: ids, rationale: 'secret rationale' }],
  actionsRequiringApproval: [{ action: 'Ask the vendor', actionClass: 'vendor_follow_up', evidenceIds: ids }], urgency: 'normal',
}, extra || {});

describe('buildRecord', () => {
  it('all FR-14.1 fields present; values from analysis, output and evidence', () => {
    const r = buildRecord({ rec, row: { lifecycleState: 'Unavailable' }, analysis, output: aiOut([stage.evidenceId]), pack, proposals: [{ proposal_id: 'tp_1' }],
      memory: { confirmedBlocker: { code: 'parts' }, evidenceRefs: [{ evidenceId: stage.evidenceId }], openQuestions: [{ question: 'When?', likelySource: 'vendor' }], sourceFreshness: { decisiv: { status: 'ok' } } },
      agent: { status: 'concluded', tier: 'standard', turns: 2, toolCalls: 1 }, now: NOW });
    for (const f of FIELDS) expect(r, f).toHaveProperty(f);
    expect(r).toMatchObject({ case_id: 'c1', unit_id: '322283', schema_version: 1, operator: 'TUZR', owner: 'AZNG', domicile: 'ABE40', oos_status: 'OOS',
      days_down: 5.2, repair_phase: 'in_repair', blocker: 'parts', responsible_party: 'vendor', last_verified_update_at: NOW - 3600e3,
      last_verified_update_source: 'aap_live', parts_eta: '2026-11-27', repair_eta: '2026-11-28', ai_status: 'ok', investigated_at: NOW });
    expect(r.root_cause).toBe('parts: Decisiv shows repair');
    expect(r.confidence).toBe(stage.confidence);
    const j = r.record_json;
    expect(j.woRefs).toEqual([{ id: 'svc-1', role: 'primary', firstSeenAt: NOW - 5 }]);
    expect(j.episodeKey).toBe('322283:2026-11-15');
    expect(j.recommendedActions).toEqual([{ action: 'Watch', actionClass: 'monitor' }]);
    expect(j.actionsRequiringApproval).toEqual([{ action: 'Ask the vendor', actionClass: 'vendor_follow_up' }]);
    expect(j.proposalIds).toEqual(['tp_1']);
    expect(j.conflicts[0]).toMatchObject({ group: 'cf_repairStatus', tie: true });
    expect(j.openQuestions).toEqual([{ question: 'When?', likelySource: 'vendor' }]);
    expect(j.missingInfo[0].item).toBe('parts ETA');
    expect(JSON.stringify(j)).not.toMatch(/secret rationale/);
    expect(JSON.stringify(j)).not.toMatch(/fleet(Rows|Count)|totalCases/i);
  });

  it('root_cause is null without non-derived support, and for fallback output', () => {
    expect(buildRecord({ rec, analysis, output: aiOut([tl.evidenceId]), pack, now: NOW }).root_cause).toBe(null);
    expect(buildRecord({ rec, analysis, output: aiOut([canon.evidenceId]), pack, now: NOW }).root_cause).toBe(null);
    const fb = buildRecord({ rec, analysis, output: aiOut([stage.evidenceId], { generatedBy: 'deterministic' }), pack, now: NOW });
    expect(fb.root_cause).toBe(null);
    expect(fb.confidence).toBe(null);
    const stalled = buildRecord({ rec, analysis, output: aiOut([stage.evidenceId], { stageStall: { stalled: true, stage: 'parts', evidenceIds: [stage.evidenceId] } }), pack, now: NOW });
    expect(stalled.root_cause).toBe('Stalled at parts: Turbo parts are the blocker');
    expect(parts.trust).toBe('structured');
  });

  it('record_json stays <= 16 KB by trimming lists', () => {
    const refs = Array.from({ length: 400 }, (_, k) => ({ evidenceId: 'ev_' + k, source: 'aap_cache', field: 'f' + k + 'x'.repeat(200), value: 'v'.repeat(80) }));
    const r = buildRecord({ rec, analysis, output: aiOut([stage.evidenceId]), pack, memory: { evidenceRefs: refs }, now: NOW });
    expect(Buffer.byteLength(JSON.stringify(r.record_json), 'utf8')).toBeLessThanOrEqual(16384);
    expect(r.record_json.evidenceRefs.length).toBeLessThan(60);
  });

  it('a source tagged unavailable_in_run in memory keeps that status in record_json.sourceFreshness', () => {
    const fr = { dtna: { newestObservedAt: null, retrievedAt: null, status: 'unavailable_in_run' }, aap_cache: { newestObservedAt: NOW, retrievedAt: NOW, status: 'ok' } };
    const r = buildRecord({ rec, analysis, output: aiOut([stage.evidenceId]), pack, memory: { sourceFreshness: fr }, sourceStatus: { dtna: 'cache_only:live_disabled_v1' }, now: NOW });
    expect(r.record_json.sourceFreshness.dtna).toEqual({ newestObservedAt: null, retrievedAt: null, status: 'unavailable_in_run' });
  });

  // Change 3: blocker precision (321185: deterministic 'stale_updates' vs the cited AI 'parts').
  const svc = col.add('aap_cache', 'serviceState', 'Waiting on Parts', { row: {}, buildAtMs: NOW }, { sourceRef: 'row/serviceState' });
  const memStale = { confirmedBlocker: { code: 'stale_updates' } };
  const a321185 = Object.assign({}, analysis, { reasons: ['OOS', 'UPDATE_STALE', 'AWAITING_SCHEDULING'], blockers: ['stale_updates', 'scheduling'] });
  const stall = (stalled, stg, ids) => ({ stageStall: { stalled, stage: stg, reasoning: 'r', confidence: 0.7, evidenceIds: ids } });

  it('a cited AI stall stage that disagrees wins over memory and the reason-code blocker', () => {
    const r = buildRecord({ rec, analysis: a321185, memory: memStale, output: aiOut([svc.evidenceId], stall(true, 'parts', [svc.evidenceId, tl.evidenceId])), pack, now: NOW });
    expect(r.blocker).toBe('parts');
    const appr = buildRecord({ rec, analysis: a321185, memory: memStale, output: aiOut([svc.evidenceId], stall(true, 'approval', [svc.evidenceId])), pack, now: NOW });
    expect(appr.blocker).toBe('estimate_approval');
  });

  it('an uncited or unsupported AI stall never overrides the deterministic blocker', () => {
    const keep = (output, mem) => buildRecord({ rec, analysis: a321185, memory: mem, output, pack, now: NOW }).blocker;
    expect(keep(aiOut([svc.evidenceId], stall(true, 'parts', [tl.evidenceId, canon.evidenceId])), memStale)).toBe('stale_updates');
    expect(keep(aiOut([svc.evidenceId], stall(true, 'parts', [])), memStale)).toBe('stale_updates');
    expect(keep(aiOut([svc.evidenceId], stall(true, 'parts', ['ev_missing'])), {})).toBe('stale_updates');
    expect(keep(aiOut([svc.evidenceId], stall(true, 'repair', [svc.evidenceId])), memStale)).toBe('stale_updates');
    expect(keep(aiOut([svc.evidenceId], stall(false, 'parts', [svc.evidenceId])), memStale)).toBe('stale_updates');
    expect(keep(aiOut([svc.evidenceId], Object.assign({ generatedBy: 'deterministic' }, stall(true, 'parts', [svc.evidenceId]))), memStale)).toBe('stale_updates');
    expect(keep(aiOut([svc.evidenceId], stall(true, 'parts', [tl.evidenceId])), {})).toBe('stale_updates');
  });

  // Change 1: the close-out label on the record.
  const cfStatus = { groups: [{ group: 'cf_status', fields: ['lifecycleState', 'repairStatus'], positions: [], authorityWinner: null, informational: true }] };
  const coAnalysis = Object.assign({}, analysis, {
    reasons: ['OOS', 'STATUS_CONFLICT', 'REPAIRED_UNVERIFIED'], blockers: ['status_conflict'], repairPhase: 'ready_for_pickup',
    closeout: { subState: 'READY_PENDING_CLOSEOUT', readySources: ['aap_cache offsiteStage', 'decisiv stage'], readySince: NOW - 86400e3, evidenceIds: [stage.evidenceId, canon.evidenceId] },
  });
  const coPack = { items: col.items, conflicts: cfStatus };
  const detOut = (extra) => aiOut([stage.evidenceId], Object.assign({ generatedBy: 'deterministic' }, extra || {}));

  it('deterministic output on a close-out analysis -> ready_pending_closeout, closeable, phase unchanged', () => {
    const r = buildRecord({ rec, analysis: coAnalysis, output: detOut(), pack: coPack, conflicts: cfStatus, now: NOW });
    expect(r.blocker).toBe('ready_pending_closeout');
    expect(r.repair_phase).toBe('ready_for_pickup');
    expect(r.record_json).toMatchObject({ subState: 'READY_PENDING_CLOSEOUT', closeable: true, closeoutEvidenceIds: [stage.evidenceId, canon.evidenceId] });
  });

  it('no close-out label for AI output or a non-cf_status published group', () => {
    const ai = buildRecord({ rec, analysis: coAnalysis, output: aiOut([stage.evidenceId]), pack: coPack, conflicts: cfStatus, now: NOW });
    expect(ai.blocker).toBe('status_conflict');
    expect(ai.record_json).toMatchObject({ subState: null, closeable: false, closeoutEvidenceIds: [] });
    const mixed = { groups: cfStatus.groups.concat([{ group: 'cf_dealerName', fields: ['dealerName'], positions: [], authorityWinner: null }]) };
    const m = buildRecord({ rec, analysis: coAnalysis, output: detOut(), pack: { items: col.items, conflicts: mixed }, conflicts: mixed, now: NOW });
    expect(m.blocker).toBe('status_conflict');
    expect(m.record_json.closeable).toBe(false);
  });

  it('a pre-change analysis shape (no closeout, no party evidence ids) still builds a record', () => {
    const old = { reasons: ['OOS', 'STATUS_CONFLICT'], daysDown: 3, repairPhase: 'ready_for_pickup', blockers: ['status_conflict'], responsibleParty: 'dealer', eta: { status: 'NOT_PROVIDED' } };
    const r = buildRecord({ rec, analysis: old, output: detOut({ responsibleParty: { party: 'unknown', evidenceIds: [] } }), pack, now: NOW });
    expect(r.blocker).toBe('status_conflict');
    expect(r.responsible_party).toBe('unknown');
    expect(r.record_json).toMatchObject({ subState: null, closeable: false });
  });

  // Change 2: one responsible party.
  it('responsible party: cited output party wins; else cited analysis party; else unknown', () => {
    const party = (outRp, a) => buildRecord({ rec, analysis: Object.assign({}, analysis, a), output: aiOut([stage.evidenceId], { responsibleParty: outRp }), pack, now: NOW }).responsible_party;
    const aCited = { responsibleParty: 'parts_supplier', responsiblePartyEvidenceIds: [parts.evidenceId] };
    expect(party({ party: 'dealer', evidenceIds: [stage.evidenceId] }, aCited)).toBe('dealer');
    expect(party({ party: 'unknown', evidenceIds: [] }, aCited)).toBe('parts_supplier');
    expect(party({ party: 'unknown', evidenceIds: [] }, { responsibleParty: 'parts_supplier', responsiblePartyEvidenceIds: [] })).toBe('unknown');
    expect(party({ party: 'dealer', evidenceIds: [] }, aCited)).toBe('parts_supplier');
    expect(party({ party: 'dealer', evidenceIds: [] }, { responsibleParty: 'parts_supplier' })).toBe('unknown');
    expect(party(undefined, { responsibleParty: undefined })).toBe(null);
  });

  it('no ETA provided is never stored as a repair ETA', () => {
    const a = Object.assign({}, analysis, { eta: { status: 'NOT_PROVIDED', date: null } });
    const r = buildRecord({ rec, analysis: a, output: aiOut([stage.evidenceId]), pack, now: NOW });
    expect(r.repair_eta).toBe(null);
    expect(r.record_json.repairEtaStatus).toBe('NOT_PROVIDED');
  });
});
