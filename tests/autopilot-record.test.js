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
});
