import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { provenanceOf } = require('../src/autopilot/provenance');
const freshness = require('../src/autopilot/freshness');
const conflicts = require('../src/autopilot/conflicts');
const { FIELD_AUTHORITY, resolveField } = require('../src/ai/authority');
const { trustOf } = require('../src/autopilot/classify');

const DAY = 86400000;
const NOW = Date.parse('2026-11-10T17:00:00Z');
const SYNC = NOW - 30 * 60000;
const BUILD = NOW - 2 * 3600000;

describe('provenance per source (§B7.4, R1)', () => {
  const row = { offsiteStageSince: '2026-11-08T10:00:00Z', repairEtcSource: 'OffsiteEvent/DTNA', _factEtc: { statedAt: '2026-11-07T09:00:00Z', source: 'relaygarage/fas' } };
  const ctx = { row, syncedAt: new Date(SYNC).toISOString(), buildAtMs: BUILD };

  it('aap_cache: field timestamps, else the build time; retrievedAt = buildAtMs ?? syncedAt', () => {
    expect(provenanceOf('aap_cache', 'offsiteStage', ctx)).toMatchObject({ observedAt: Date.parse(row.offsiteStageSince), retrievedAt: BUILD, authorityTag: 'fleetdata', observedFrom: 'offsiteStageSince' });
    expect(provenanceOf('aap_cache', 'repairEtc', ctx)).toMatchObject({ observedAt: Date.parse(row._factEtc.statedAt), authorityTag: 'offsiteevent/dtna' });
    expect(provenanceOf('aap_cache', '_factEtc.date', ctx).authorityTag).toBe('relaygarage/fas');
    expect(provenanceOf('aap_cache', 'lifecycleState', ctx)).toMatchObject({ observedAt: BUILD, retrievedAt: BUILD, authorityTag: 'aap' });
    expect(provenanceOf('aap_cache', 'partsEta', ctx).authorityTag).toBe('fleetdata');
    const noBuild = provenanceOf('aap_cache', 'lifecycleState', { row, syncedAt: new Date(SYNC).toISOString(), buildAtMs: null });
    expect(noBuild).toMatchObject({ observedAt: SYNC, retrievedAt: SYNC });
    expect(provenanceOf('aap_cache', 'repairEtc', { row: {}, buildAtMs: BUILD }).authorityTag).toBe('notes');
  });

  it('other sources', () => {
    expect(provenanceOf('aap_live', 'comment', { item: { timestamp: '2026-11-10T16:00:00Z' }, retrievedAt: NOW, commentDerived: true })).toMatchObject({ observedAt: Date.parse('2026-11-10T16:00:00Z'), retrievedAt: NOW, authorityTag: 'relaygarage' });
    expect(provenanceOf('aap_live', 'lifecycleState', { item: {}, retrievedAt: NOW })).toMatchObject({ observedAt: NOW, authorityTag: 'aap' });
    expect(provenanceOf('canonical', 'status', { record: { statusChangedAt: '2026-11-09T00:00:00Z' }, canonicalUpdatedAt: NOW - 1000 })).toMatchObject({ observedAt: Date.parse('2026-11-09T00:00:00Z'), retrievedAt: NOW - 1000, authorityTag: 'canonical' });
    expect(provenanceOf('dtna', 'offsiteStage', { entry: { stageSince: '2026-11-09T00:00:00Z', lastCommentAt: '2026-11-10T00:00:00Z', pulledAt: NOW - 5000 } })).toMatchObject({ observedAt: Date.parse('2026-11-09T00:00:00Z'), retrievedAt: NOW - 5000, authorityTag: 'offsiteevent' });
    expect(provenanceOf('dtna', 'thread', { entry: { stageSince: '2026-11-09T00:00:00Z', lastCommentAt: '2026-11-10T00:00:00Z' } }).observedAt).toBe(Date.parse('2026-11-10T00:00:00Z'));
    expect(provenanceOf('decisiv', 'stage', { entry: { since: '2026-11-08T00:00:00Z' }, retrievedAt: NOW })).toMatchObject({ authorityTag: 'decisiv', retrievedAt: NOW });
    expect(provenanceOf('email', 'repairEtc', { item: { observedAt: '2026-11-09T00:00:00Z' } })).toMatchObject({ observedAt: Date.parse('2026-11-09T00:00:00Z'), retrievedAt: Date.parse('2026-11-09T00:00:00Z'), authorityTag: 'notes' });
    expect(provenanceOf('long_dwell', 'delayReason', { entry: { importedAt: '2026-11-01T00:00:00Z' } })).toMatchObject({ authorityTag: 'notes' });
    expect(provenanceOf('slack', 'message', { message: { ts: '1762790400.000100' }, retrievedAt: NOW }).observedAt).toBe(1762790400000);
    expect(provenanceOf('repair_intel', 'event', { event: { reported_at: NOW - DAY }, retrievedAt: NOW })).toMatchObject({ observedAt: NOW - DAY, authorityTag: 'fleetdata' });
    expect(provenanceOf('fas_case', 'summary', { entry: { updatedAt: NOW - DAY }, retrievedAt: NOW }).authorityTag).toBe('notes');
    expect(provenanceOf('vendor_intel', 'medianDays', { scorecard: { computedAt: NOW - DAY }, retrievedAt: NOW }).authorityTag).toBe(null);
    expect(provenanceOf('aperia_cache', 'severity', { issue: { dateDetected: '2026-11-01T00:00:00Z' }, pulledAt: NOW - 60000 })).toMatchObject({ authorityTag: null, retrievedAt: NOW - 60000 });
  });
});

describe('freshness and confidence', () => {
  const it0 = (o) => Object.assign({ observedAt: NOW - DAY, retrievedAt: NOW - 1000 }, o);
  it('classes against staleDays only', () => {
    // Pinned (§B7.4 order): LIVE takes precedence over a null observedAt; AC-5's "null -> UNKNOWN"
    // applies to non-live items (a warm Decisiv answer without `since` is still LIVE).
    expect(freshness.classify(it0({ live: true, observedAt: null }), NOW, 3)).toBe('LIVE');
    expect(freshness.classify(it0({ observedAt: null }), NOW, 3)).toBe('UNKNOWN');
    expect(freshness.classify(it0({}), NOW, 3)).toBe('RECENT');
    expect(freshness.classify(it0({ observedAt: NOW - 4 * DAY }), NOW, 3)).toBe('STALE');
    expect(freshness.classify(it0({ observedAt: NOW - 4 * DAY }), NOW, 5)).toBe('RECENT');
    expect(freshness.classify(it0({ retrievedAt: NOW - 4 * DAY }), NOW, 3)).toBe('STALE');
    expect(freshness.classify(it0({ retrievedAt: NOW - 4 * DAY }), NOW, 5)).toBe('RECENT');
    expect(freshness.clampStaleDays(99)).toBe(30);
    expect(freshness.clampStaleDays('x')).toBe(3);
  });

  it('confidence table', () => {
    expect(freshness.confidence({ field: 'lifecycleState', authorityTag: 'aap', trust: 'structured', freshness: 'RECENT' })).toBe(0.9);
    expect(freshness.confidence({ field: 'lifecycleState', authorityTag: 'canonical', trust: 'structured', freshness: 'RECENT' })).toBe(0.8);
    expect(freshness.confidence({ field: 'lifecycleState', authorityTag: 'fleetdata', trust: 'structured', freshness: 'RECENT' })).toBe(0.65);
    expect(freshness.confidence({ field: 'noRuleField', authorityTag: 'aap', trust: 'structured', freshness: 'RECENT' })).toBe(0.65);
    expect(freshness.confidence({ field: 'stage', conflictField: 'repairStatus', authorityTag: 'relaygarage', trust: 'structured', freshness: 'RECENT' })).toBe(0.9);
    expect(freshness.confidence({ field: 'x', trust: 'untrusted_text', freshness: 'RECENT' })).toBe(0.4);
    expect(freshness.confidence({ source: 'email', field: 'x', trust: 'untrusted_text', confidence: 0.95, freshness: 'RECENT' })).toBe(0.7);
    expect(freshness.confidence({ source: 'email', field: 'x', trust: 'untrusted_text', confidence: 0.5, freshness: 'RECENT' })).toBe(0.5);
    expect(freshness.confidence({ field: 'lifecycleState', authorityTag: 'aap', trust: 'structured', freshness: 'STALE' })).toBe(0.63);
  });
});

const item = (o) => Object.assign({ trust: 'structured', freshness: 'RECENT', observedAt: NOW - DAY }, o);

describe('conflicts (§B7.4, R2)', () => {
  it('authority index: repairStatus decisiv -> Infinity, fleetdata -> 3; no rule -> 0', () => {
    expect(conflicts.authorityIndex('repairStatus', 'fleetdata')).toBe(3);
    expect(conflicts.authorityIndex('repairStatus', 'decisiv')).toBe(Infinity);
    expect(conflicts.authorityIndex('noSuchField', 'anything')).toBe(0);
    const ranked = conflicts.rankCandidates('repairStatus', [{ value: 'repair', authorityTag: 'decisiv', freshness: 'LIVE' }, { value: 'ready', authorityTag: 'fleetdata', freshness: 'STALE' }]);
    expect(ranked[0].authorityTag).toBe('fleetdata');
  });

  it('parity: authorityIndex + freshness ordering picks the same winner as resolveField', () => {
    const tags = ['aap', 'canonical', 'fleetdata', 'relaygarage', 'relaygarage/vendor', 'relaygarage/fas', 'offsiteevent', 'offsiteevent/dtna', 'decisiv', 'notes', 'notes/email', 'paccar', 'uptake', 'relaygarage/wo', 'fleetdata(dot)', 'unknown'];
    const fresh = ['LIVE', 'RECENT', 'STALE', 'UNKNOWN'];
    for (const field of Object.keys(FIELD_AUTHORITY)) {
      for (let i = 0; i < tags.length; i++) {
        for (let j = 0; j < tags.length; j++) {
          const a = { value: 'A', authorityTag: tags[i], freshness: fresh[i % 4] };
          const b = { value: 'B', authorityTag: tags[j], freshness: fresh[(j + 1) % 4] };
          const top = conflicts.rankCandidates(field, [a, b])[0];
          const r = resolveField(field, [a, b].map((c) => ({ value: c.value, source: c.authorityTag, freshness: c.freshness })));
          expect(top.value, field + ' ' + tags[i] + ' vs ' + tags[j]).toBe(r.value);
        }
      }
    }
  });

  it('same-field group with a winner; DTNA tagged offsiteevent', () => {
    const items = [
      item({ evidenceId: 'ev_a', source: 'aap_cache', field: 'lifecycleState', value: 'Unavailable', authorityTag: 'aap', freshness: 'RECENT' }),
      item({ evidenceId: 'ev_b', source: 'aap_live', field: 'lifecycleState', value: 'Active', authorityTag: 'aap', freshness: 'LIVE' }),
    ];
    const { groups, memberOf } = conflicts.buildConflicts(items, {});
    expect(groups.length).toBe(1);
    expect(groups[0].group).toBe('cf_lifecycleState');
    expect(groups[0].authorityWinner).toMatchObject({ evidenceId: 'ev_b', value: 'Active' });
    expect(memberOf.ev_a).toEqual(['cf_lifecycleState']);
    expect(conflicts.needsReview(groups)).toBe(false);
  });

  it('two tags outside FIELD_AUTHORITY with different values and the same freshness -> authorityWinner null -> needs review', () => {
    const items = [
      item({ evidenceId: 'ev_1', source: 'decisiv', field: 'stage', value: 'repair', authorityTag: 'decisiv' }),
      item({ evidenceId: 'ev_2', source: 'x', field: 'y', conflictField: 'repairStatus', value: 'approval', authorityTag: 'paccar' }),
    ];
    const { groups } = conflicts.buildConflicts(items, {});
    expect(groups[0].group).toBe('cf_repairStatus');
    expect(groups[0].authorityWinner).toBe(null);
    expect(conflicts.needsReview(groups)).toBe(true);
  });

  it('DTNA (offsiteevent) beats Decisiv (not in the repairStatus list): winner named', () => {
    const items = [
      item({ evidenceId: 'ev_1', source: 'decisiv', field: 'stage', value: 'repair', authorityTag: 'decisiv' }),
      item({ evidenceId: 'ev_2', source: 'dtna', field: 'offsiteStage', value: 'approval', authorityTag: 'offsiteevent' }),
    ];
    const { groups } = conflicts.buildConflicts(items, {});
    expect(groups[0].authorityWinner).toMatchObject({ source: 'dtna', authorityTag: 'offsiteevent' });
    expect(conflicts.needsReview(groups)).toBe(false);
  });

  it('R2: the row mirror plus a live Decisiv read with the same value -> no group; mirror disagreeing is dropped too', () => {
    const live = item({ evidenceId: 'ev_d', source: 'decisiv', field: 'stage', value: 'Repair', authorityTag: 'decisiv', freshness: 'LIVE' });
    expect(conflicts.buildConflicts([live, item({ evidenceId: 'ev_m', source: 'aap_cache', field: 'offsiteStage', value: 'repair', authorityTag: 'fleetdata' })], {}).groups).toEqual([]);
    expect(conflicts.buildConflicts([live, item({ evidenceId: 'ev_m', source: 'aap_cache', field: 'offsiteStage', value: 'ready', authorityTag: 'fleetdata' })], {}).groups).toEqual([]);
  });

  it("R2: a Decisiv '' stage answer normalizes to the structured enum none", () => {
    const v = conflicts.normalizeConflictValue('repairStatus', '', { source: 'decisiv' });
    expect(v).toBe('none');
    expect(trustOf('decisiv', 'stage', v)).toBe('structured');
    expect(conflicts.normalizeConflictValue('repairStatus', '', { source: 'dtna' })).toBe(null);
    const items = [
      item({ evidenceId: 'ev_d', source: 'decisiv', field: 'stage', value: '', normalizedValue: 'none', authorityTag: 'decisiv' }),
      item({ evidenceId: 'ev_t', source: 'dtna', field: 'offsiteStage', value: 'repair', authorityTag: 'offsiteevent' }),
    ];
    const g = conflicts.buildConflicts(items, {}).groups[0];
    expect(g.positions.map((p) => p.value).sort()).toEqual(['none', 'repair']);
  });

  it('R2: canonical ready_for_pickup is never a lifecycleState candidate; it feeds cf_status only', () => {
    const items = [
      item({ evidenceId: 'ev_a', source: 'aap_cache', field: 'lifecycleState', value: 'Unavailable', authorityTag: 'aap' }),
      item({ evidenceId: 'ev_c', source: 'canonical', field: 'status', value: 'ready_for_pickup', authorityTag: 'canonical' }),
    ];
    const { groups } = conflicts.buildConflicts(items, { isDown: true });
    expect(groups.map((g) => g.group)).toEqual(['cf_status']);
    expect(conflicts.buildConflicts(items, { isDown: false }).groups).toEqual([]);
  });

  it('cf_status for AAP Unavailable vs Decisiv ready lists both with sources (AC-6); no cf_stage', () => {
    const items = [
      item({ evidenceId: 'ev_a', source: 'aap_cache', field: 'lifecycleState', value: 'unavailable', authorityTag: 'aap' }),
      item({ evidenceId: 'ev_d', source: 'decisiv', field: 'stage', value: 'ready', authorityTag: 'decisiv' }),
      item({ evidenceId: 'ev_t', source: 'dtna', field: 'offsiteStage', value: 'repair', authorityTag: 'offsiteevent' }),
    ];
    const { groups, memberOf } = conflicts.buildConflicts(items, { isDown: true });
    const st = groups.find((g) => g.group === 'cf_status');
    expect(st.positions).toEqual([
      { source: 'aap_cache', field: 'lifecycleState', value: 'Unavailable', evidenceId: 'ev_a', authorityTag: 'aap' },
      { source: 'decisiv', field: 'stage', value: 'ready', evidenceId: 'ev_d', authorityTag: 'decisiv' },
    ]);
    expect(st.authorityWinner.evidenceId).toBe('ev_a');
    expect(st.informational).toBe(true);
    expect(groups.some((g) => g.group === 'cf_stage')).toBe(false);
    expect(groups.some((g) => g.group === 'cf_repairStatus')).toBe(true);
    expect(memberOf.ev_d.sort()).toEqual(['cf_repairStatus', 'cf_status']);
    expect(conflicts.needsReview(groups.filter((g) => g.group === 'cf_status'))).toBe(false);
  });

  it('untrusted items and same values never form a group; dates and names are normalized', () => {
    expect(conflicts.buildConflicts([
      item({ source: 'aap_cache', field: 'lifecycleState', value: 'Unavailable', authorityTag: 'aap' }),
      item({ source: 'aap_live', field: 'lifecycleState', value: 'Active', authorityTag: 'aap', trust: 'untrusted_text' }),
    ], {}).groups).toEqual([]);
    expect(conflicts.buildConflicts([
      item({ source: 'aap_cache', field: 'repairEtc', value: '11/12/2026', authorityTag: 'notes' }),
      item({ source: 'decisiv', field: 'repairEtc', value: '2026-11-12T00:00:00', authorityTag: 'decisiv' }),
    ], {}).groups).toEqual([]);
    expect(conflicts.buildConflicts([
      item({ source: 'aap_cache', field: 'dealerName', value: 'Rush  Truck', authorityTag: 'fleetdata' }),
      item({ source: 'decisiv', field: 'dealerName', value: 'rush truck', authorityTag: 'decisiv' }),
    ], {}).groups).toEqual([]);
    expect(conflicts.normalizeConflictValue('lifecycleState', ' ACTIVE ')).toBe('Active');
  });

  it('same authority index with different freshness: the fresher wins (aap LIVE vs aap RECENT)', () => {
    const { groups } = conflicts.buildConflicts([
      item({ evidenceId: 'ev_r', source: 'aap_cache', field: 'lifecycleState', value: 'Unavailable', authorityTag: 'aap', freshness: 'RECENT' }),
      item({ evidenceId: 'ev_l', source: 'aap_live', field: 'lifecycleState', value: 'Ordered', authorityTag: 'aap', freshness: 'LIVE' }),
    ], {});
    expect(groups[0].authorityWinner.evidenceId).toBe('ev_l');
  });
});
