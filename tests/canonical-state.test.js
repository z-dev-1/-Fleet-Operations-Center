import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const canonical = require('../src/orcha/canonical_state');

describe('canonical_state — deterministic baseline (computeCanonical)', () => {
  it('returns null when there is no equipmentId', () => {
    expect(canonical.computeCanonical({})).toBeNull();
    expect(canonical.computeCanonical(null)).toBeNull();
  });

  it('derives available for an in-service unit', () => {
    const rec = canonical.computeCanonical({ equipmentId: '1', lifecycleState: 'Available' });
    expect(rec.status).toBe('available');
    expect(rec.aiReconciled).toBe(false);
    expect(rec.flags).not.toContain('down');
  });

  it('derives down for an unavailable unit with no finer state', () => {
    const rec = canonical.computeCanonical({ equipmentId: '2', lifecycleState: 'Unavailable' });
    expect(rec.status).toBe('down');
    expect(rec.flags).toContain('down');
    expect(canonical.isDown({ lifecycleState: 'Unavailable' })).toBe(true);
  });

  it('prefers a specific repair state over generic down', () => {
    const parts = canonical.computeCanonical({ equipmentId: '3', lifecycleState: 'Unavailable', serviceState: 'Awaiting parts on order' });
    expect(parts.status).toBe('awaiting_parts');
    expect(parts.flags).toContain('parts');
    expect(parts.waitingOn).toBe('parts');

    const appr = canonical.computeCanonical({ equipmentId: '4', lifecycleState: 'Unavailable', serviceState: 'estimate pending approval' });
    expect(appr.status).toBe('awaiting_estimate_approval');
    expect(appr.waitingOn).toBe('approval');

    const repair = canonical.computeCanonical({ equipmentId: '5', lifecycleState: 'Unavailable', serviceState: 'In repair — teardown' });
    expect(repair.status).toBe('in_repair');
  });

  it('treats a completed-but-still-unavailable unit as ready_for_pickup', () => {
    const rec = canonical.computeCanonical({ equipmentId: '6', lifecycleState: 'Unavailable', serviceState: 'Repair complete' });
    expect(rec.status).toBe('ready_for_pickup');
    expect(rec.flags).toContain('ready');
    expect(rec.waitingOn).toBe('us');
  });

  it('flags decommissioned as terminal', () => {
    const rec = canonical.computeCanonical({ equipmentId: '7', lifecycleReason: 'Unit totaled / salvage' });
    expect(rec.status).toBe('decommissioned');
  });

  it('raises stale + high_risk flags from existing fields', () => {
    const rec = canonical.computeCanonical({
      equipmentId: '8', lifecycleState: 'Unavailable',
      riskScore: 92, asistScrapedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    expect(rec.flags).toContain('high_risk');
    expect(rec.flags).toContain('stale');
    expect(rec.stale).toBe(true);
  });

  it('picks offsite provenance when a fresh offsite thread exists', () => {
    const rec = canonical.computeCanonical({
      equipmentId: '9', lifecycleState: 'Unavailable',
      asistNotes: 'Dealer: parts arrived', asistScrapedAt: new Date().toISOString(),
    });
    expect(rec.source).toBe('offsite');
  });

  it('only emits statuses from the canonical vocabulary', () => {
    const rows = [
      { equipmentId: 'a', lifecycleState: 'Available' },
      { equipmentId: 'b', lifecycleState: 'Unavailable' },
      { equipmentId: 'c', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' },
      { equipmentId: 'd', lifecycleReason: 'retired' },
      { equipmentId: 'e' },
    ];
    for (const r of rows) {
      const rec = canonical.computeCanonical(r);
      expect(canonical.isValidStatus(rec.status)).toBe(true);
    }
  });
});

describe('canonical_state — AI upgrade (reconcileCanonical)', () => {
  const downRow = { equipmentId: '100', lifecycleState: 'Unavailable', vendor: 'Amerit' };

  it('folds an AI decision into a sharper record and marks aiReconciled', () => {
    const decision = {
      equipmentId: '100',
      currentStatus: 'Waiting on DEF pump parts, ETC next week',
      nextStep: 'Chase dealer for parts ETA',
      relayHasLatest: false,
      missingUpdate: 'Parts on order per dealer 10/14',
      isStale: false,
      followUpNeeded: true,
      lastCommentBy: 'us',
      dealerAsk: 'Any update on the DEF pump parts ETA?',
      confidence: 0.82,
    };
    const rec = canonical.reconcileCanonical(downRow, { decision });
    expect(rec.aiReconciled).toBe(true);
    expect(rec.status).toBe('awaiting_parts'); // sharpened from the decision text
    expect(rec.confidence).toBeCloseTo(0.82, 2);
    expect(rec.source).toBe('offsite');          // relay lacked the latest -> offsite trusted
    expect(rec.waitingOn).toBe('vendor');         // we spoke last -> ball in vendor's court
    expect(rec.flags).toContain('needs_followup');
    expect(rec.flags).toContain('dealer_ask');
    expect(rec.flags).toContain('relay_gap');
  });

  it('falls back to the deterministic baseline when the AI was unavailable', () => {
    const rec = canonical.reconcileCanonical(downRow, { decision: { aiUnavailable: true, isStale: true } });
    expect(rec.aiReconciled).toBe(false);
    expect(rec.status).toBe('down');
    expect(rec.flags).toContain('stale'); // staleness read still folded in
  });

  it('sets waitingOn=us when the vendor commented last', () => {
    const rec = canonical.reconcileCanonical(downRow, {
      decision: { equipmentId: '100', currentStatus: 'In repair', nextStep: 'Monitor', lastCommentBy: 'vendor', confidence: 0.7 },
    });
    expect(rec.waitingOn).toBe('us');
    expect(rec.status).toBe('in_repair');
  });
});

describe('canonical_state — buildAll + mirrorFields', () => {
  it('computes a record for every unit and upgrades only those with a decision', () => {
    const rows = [
      { equipmentId: 'A', lifecycleState: 'Available' },
      { equipmentId: 'B', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' },
      { equipmentId: 'C', lifecycleState: 'Unavailable', vendor: 'Amerit' },
      { noId: true }, // skipped
    ];
    const decisions = {
      C: { equipmentId: 'C', currentStatus: 'Repair in progress', nextStep: 'Monitor', lastCommentBy: 'vendor', confidence: 0.9 },
    };
    const { units, mirrored, counts } = canonical.buildAll(rows, { decisions });
    expect(counts.total).toBe(3);
    expect(counts.reconciled).toBe(1);
    expect(counts.baseline).toBe(2);
    expect(units.A.aiReconciled).toBe(false);
    expect(units.C.aiReconciled).toBe(true);
    // mirrored rows carry canonical* fields
    const mC = mirrored.find(r => r.equipmentId === 'C');
    expect(mC.canonicalStatus).toBe('in_repair');
    expect(mC.canonicalAiReconciled).toBe(true);
    expect(Array.isArray(mC.canonicalFlags)).toBe(true);
    // row without equipmentId is passed through untouched
    expect(mirrored.find(r => r.noId)).toBeTruthy();
  });

  it('accepts a Map of decisions as well as a plain object', () => {
    const rows = [{ equipmentId: 'X', lifecycleState: 'Unavailable' }];
    const decisions = new Map([['X', { equipmentId: 'X', currentStatus: 'ready for pickup', nextStep: 'close', confidence: 0.95, completed: true }]]);
    const { units } = canonical.buildAll(rows, { decisions });
    expect(units.X.status).toBe('ready_for_pickup');
    expect(units.X.aiReconciled).toBe(true);
  });

  it('repairs mojibake in emitted text (double-encoded middle dot / em dash)', () => {
    // "Ã‚Â·" is a middle dot that was UTF-8 decoded as Latin-1 twice;
    // "Ã¢â‚¬â€œ" is an en dash likewise. The record must come out clean.
    const rec = canonical.reconcileCanonical(
      { equipmentId: 'MOJI', lifecycleState: 'Unavailable', vendor: 'Amerit' },
      { decision: { equipmentId: 'MOJI', currentStatus: 'Waiting on parts Ã‚Â· ETC Ã¢â‚¬â€œ next week', nextStep: 'Chase dealer', confidence: 0.8, relayHasLatest: true } }
    );
    expect(rec.situation).not.toMatch(/[ÃÂ]/);
    expect(rec.situation).toContain('·');
  });

  it('leaves clean ASCII/UTF-8 text untouched', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'CLEAN', lifecycleState: 'Unavailable', lifecycleReason: 'Engine fault', vendor: 'Amerit', workDuration: '5 days' });
    expect(rec.situation).toBe('Engine fault - @ Amerit - 5 days down');
  });

  it('mirrorFields produces the canonical* prefixed snapshot', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'M', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' });
    const m = canonical.mirrorFields(rec);
    expect(m.canonicalStatus).toBe('awaiting_parts');
    expect(m.canonicalWaitingOn).toBe('parts');
    expect(m).toHaveProperty('canonicalConfidence');
    expect(m).toHaveProperty('canonicalUpdatedAt');
  });
});

describe('canonical_state — shared read accessors (the consumer API)', () => {
  it('fromRow reconstructs a record from mirrored canonical* fields', () => {
    const base = canonical.computeCanonical({ equipmentId: 'R1', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' });
    const row = Object.assign({ equipmentId: 'R1' }, canonical.mirrorFields(base));
    const rec = canonical.fromRow(row);
    expect(rec).not.toBeNull();
    expect(rec.status).toBe('awaiting_parts');
    expect(rec.waitingOn).toBe('parts');
  });

  it('fromRow returns null for a row with no mirror', () => {
    expect(canonical.fromRow({ equipmentId: 'R2', lifecycleState: 'Unavailable' })).toBeNull();
  });

  it('getCanonical prefers mirrored row fields (no store I/O)', () => {
    const base = canonical.computeCanonical({ equipmentId: 'G1', lifecycleState: 'Unavailable', serviceState: 'in repair' });
    const row = Object.assign({ equipmentId: 'G1' }, canonical.mirrorFields(base));
    // store stub that would THROW if touched — proves the mirror path short-circuits.
    const store = { load() { throw new Error('store must not be read when mirror present'); } };
    const rec = canonical.getCanonical(row, { store });
    expect(rec.status).toBe('in_repair');
  });

  it('getCanonical falls back to the store when given a bare id', () => {
    const store = { load: (k) => (k === 'canonicalState' ? { units: { G2: { equipmentId: 'G2', status: 'awaiting_vendor', nextStep: 'chase', confidence: 0.7, flags: [], waitingOn: 'vendor' } } } : {}) };
    const rec = canonical.getCanonical('G2', { store });
    expect(rec.status).toBe('awaiting_vendor');
    expect(rec.waitingOn).toBe('vendor');
  });

  it('getCanonical falls back to a fresh deterministic compute when no mirror and no store record', () => {
    const store = { load: () => ({}) };
    const rec = canonical.getCanonical({ equipmentId: 'G3', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' }, { store });
    expect(rec.status).toBe('awaiting_parts');
    expect(rec.aiReconciled).toBe(false);
  });

  it('getCanonical returns null for an unknown bare id with empty store', () => {
    const store = { load: () => ({}) };
    expect(canonical.getCanonical('NOPE', { store })).toBeNull();
  });

  it('statusLabel humanizes the enum', () => {
    expect(canonical.statusLabel('awaiting_estimate_approval')).toBe('Awaiting estimate approval');
    expect(canonical.statusLabel('down')).toBe('Down');
    expect(canonical.statusLabel('')).toBe('Unknown');
  });

  it('signalTokens emits compact prompt tokens from a reconciled record (via mirror)', () => {
    const base = canonical.reconcileCanonical(
      { equipmentId: 'S1', lifecycleState: 'Unavailable' },
      { decision: { equipmentId: 'S1', currentStatus: 'awaiting parts', nextStep: 'chase dealer', lastCommentBy: 'us', followUpNeeded: true, confidence: 0.8, isStale: true, relayHasLatest: false, missingUpdate: 'parts on order' } }
    );
    const row = Object.assign({ equipmentId: 'S1' }, canonical.mirrorFields(base));
    const store = { load() { throw new Error('should use mirror'); } };
    const tokens = canonical.signalTokens(row, { store });
    expect(tokens).toContain('canon=awaiting_parts');
    expect(tokens).toContain('STALE');
    expect(tokens).toContain('wait=vendor');
    expect(tokens).toContain('ai-reconciled');
    expect(tokens).toContain('next="chase dealer"');
  });

  it('signalTokens returns empty string when there is no canonical record', () => {
    const store = { load: () => ({}) };
    expect(canonical.signalTokens('UNKNOWN', { store })).toBe('');
  });
});

describe('canonical_state — evidence + lastMeaningfulUpdate', () => {
  it('emits evidence tagged by source with usedInConclusion on the trusted source', () => {
    const rec = canonical.computeCanonical({
      equipmentId: 'E1', lifecycleState: 'Unavailable', lifecycleReason: 'DEF fault',
      serviceState: 'awaiting parts', asistNotes: 'Dealer: parts on order, ETC 10/16',
      asistScrapedAt: new Date().toISOString(),
    });
    expect(Array.isArray(rec.evidence)).toBe(true);
    const sources = rec.evidence.map(e => e.source);
    expect(sources).toContain('aap');
    expect(sources).toContain('relay');
    expect(sources).toContain('offsite');
    // offsite is the fresh trusted source -> its evidence is marked used.
    const off = rec.evidence.find(e => e.source === 'offsite');
    expect(off.usedInConclusion).toBe(true);
    expect(off.observedAt).toBeTruthy();
  });

  it('lastMeaningfulUpdate prefers the offsite thread with its scrape time', () => {
    const at = new Date().toISOString();
    const rec = canonical.computeCanonical({ equipmentId: 'E2', lifecycleState: 'Unavailable', asistNotes: 'line1\nparts arrived 10/14', asistScrapedAt: at });
    expect(rec.lastMeaningfulUpdate).toMatchObject({ source: 'offsite', at });
    expect(rec.lastMeaningfulUpdate.text).toContain('parts arrived');
  });

  it('detects an obvious AAP-down vs repair-complete conflict', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'E3', lifecycleState: 'Unavailable', serviceState: 'Repair complete' });
    expect(rec.status).toBe('ready_for_pickup');
    expect(rec.conflicts.length).toBeGreaterThanOrEqual(1);
    const c = rec.conflicts[0];
    expect(c.field).toBe('status');
    expect(c.positions.map(p => p.source)).toContain('aap');
    expect(canonical.STATUSES).toContain(rec.status);
  });
});

describe('canonical_state — AI conflict sanitization (_normalizeConflicts)', () => {
  it('drops conflicts with fewer than 2 positions and invented resolutions', () => {
    const raw = [
      { field: 'status', positions: [{ source: 'aap', value: 'down' }], resolution: 'aap', reason: 'only one' }, // <2 positions -> dropped
      { field: 'eta', positions: [{ source: 'relay', value: '10/10' }, { source: 'offsite', value: '10/16' }], resolution: 'mars', reason: 'invented src' },
    ];
    const out = canonical._normalizeConflicts(raw, 'offsite');
    expect(out.length).toBe(1);
    expect(out[0].field).toBe('eta');
    // resolution 'mars' isn't a position source; trusted 'offsite' IS -> falls back to it.
    expect(out[0].resolution).toBe('offsite');
  });

  it('returns null for empty/garbage so the deterministic set is kept', () => {
    expect(canonical._normalizeConflicts(null, 'aap')).toBeNull();
    expect(canonical._normalizeConflicts([], 'aap')).toBeNull();
    expect(canonical._normalizeConflicts(['nonsense'], 'aap')).toBeNull();
  });

  it('reconcileCanonical folds AI conflicts + statusChangeReason into the record', () => {
    const rec = canonical.reconcileCanonical(
      { equipmentId: 'C9', lifecycleState: 'Unavailable' },
      { decision: {
        equipmentId: 'C9', currentStatus: 'ready for pickup', nextStep: 'arrange pickup', confidence: 0.9, completed: true,
        statusChangeReason: 'Dealer marked repair complete 10/15',
        conflicts: [{ field: 'status', positions: [{ source: 'aap', value: 'unavailable' }, { source: 'offsite', value: 'complete' }], resolution: 'offsite', reason: 'offsite fresher' }],
      } }
    );
    expect(rec.statusChangeReason).toContain('repair complete');
    expect(rec.conflicts.length).toBe(1);
    expect(rec.conflicts[0].resolution).toBe('offsite');
  });
});

describe('canonical_state — temporal diffing (diffAgainstPrior)', () => {
  it('first observation sets a baseline statusChangedAt and empty change-set', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'T1', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' });
    const diffed = canonical.diffAgainstPrior(rec, null);
    expect(diffed.changedFields).toEqual([]);
    expect(diffed.previousStatus).toBeNull();
    expect(diffed.statusChangedAt).toBeTruthy();
    expect(diffed.history).toEqual([]);
  });

  it('records a status transition into history with from/to/reason', () => {
    const prior = canonical.diffAgainstPrior(
      canonical.computeCanonical({ equipmentId: 'T2', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' }), null
    );
    const next = canonical.computeCanonical({ equipmentId: 'T2', lifecycleState: 'Unavailable', serviceState: 'Repair complete', asistNotes: 'done 10/15', asistScrapedAt: new Date().toISOString() });
    const diffed = canonical.diffAgainstPrior(next, prior);
    expect(diffed.previousStatus).toBe('awaiting_parts');
    expect(diffed.status).toBe('ready_for_pickup');
    expect(diffed.history.length).toBe(1);
    expect(diffed.history[0]).toMatchObject({ from: 'awaiting_parts', to: 'ready_for_pickup' });
    expect(diffed.changedFields.some(c => c.field === 'status')).toBe(true);
    expect(diffed.statusChangeReason).toBeTruthy();
  });

  it('carries prior history/statusChangedAt when status is unchanged', () => {
    let rec = canonical.diffAgainstPrior(canonical.computeCanonical({ equipmentId: 'T3', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' }), null);
    const firstChangedAt = rec.statusChangedAt;
    // same status next cycle
    const next = canonical.computeCanonical({ equipmentId: 'T3', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' });
    rec = canonical.diffAgainstPrior(next, rec);
    expect(rec.previousStatus).toBeNull();
    expect(rec.statusChangedAt).toBe(firstChangedAt); // unchanged -> carried
    expect(rec.history).toEqual([]);
  });

  it('caps history at 10 transitions', () => {
    let rec = canonical.diffAgainstPrior(canonical.computeCanonical({ equipmentId: 'T4', lifecycleState: 'Unavailable', serviceState: 'in repair' }), null);
    const states = ['awaiting parts', 'in repair', 'awaiting parts', 'in repair', 'awaiting parts', 'in repair', 'awaiting parts', 'in repair', 'awaiting parts', 'in repair', 'awaiting parts', 'in repair'];
    for (const s of states) {
      const n = canonical.computeCanonical({ equipmentId: 'T4', lifecycleState: 'Unavailable', serviceState: s });
      rec = canonical.diffAgainstPrior(n, rec);
    }
    expect(rec.history.length).toBeLessThanOrEqual(10);
  });
});

describe('canonical_state — event trigger (detectChangedUnits) + buildAll with prior', () => {
  it('treats units with no prior record as changed (first observation)', () => {
    const rows = [{ equipmentId: 'N1', lifecycleState: 'Unavailable' }, { equipmentId: 'N2', lifecycleState: 'Available' }];
    const changed = canonical.detectChangedUnits(rows, {});
    expect(changed.has('N1')).toBe(true);
    expect(changed.has('N2')).toBe(true);
  });

  it('flags a unit whose status moved and NOT one that is unchanged', () => {
    // build prior records
    const priorBuild = canonical.buildAll([
      { equipmentId: 'M1', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' },
      { equipmentId: 'M2', lifecycleState: 'Unavailable', serviceState: 'in repair' },
    ], {});
    const prior = priorBuild.units;
    // M1 moved to ready; M2 unchanged
    const rows = [
      { equipmentId: 'M1', lifecycleState: 'Unavailable', serviceState: 'Repair complete' },
      { equipmentId: 'M2', lifecycleState: 'Unavailable', serviceState: 'in repair' },
    ];
    const changed = canonical.detectChangedUnits(rows, prior);
    expect(changed.has('M1')).toBe(true);
    expect(changed.has('M2')).toBe(false);
  });

  it('flags a unit whose offsite thread refreshed (asistScrapedAt moved)', () => {
    const prior = canonical.buildAll([{ equipmentId: 'O1', lifecycleState: 'Unavailable', asistNotes: 'old', asistScrapedAt: '2026-10-01T00:00:00Z' }], {}).units;
    const rows = [{ equipmentId: 'O1', lifecycleState: 'Unavailable', asistNotes: 'new', asistScrapedAt: '2026-10-14T00:00:00Z' }];
    expect(canonical.detectChangedUnits(rows, prior).has('O1')).toBe(true);
  });

  it('buildAll with prior fills temporal fields + counts.changed', () => {
    const prior = canonical.buildAll([{ equipmentId: 'B1', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' }], {}).units;
    const out = canonical.buildAll([{ equipmentId: 'B1', lifecycleState: 'Unavailable', serviceState: 'Repair complete' }], { prior });
    expect(out.counts.changed).toBe(1);
    expect(out.units.B1.previousStatus).toBe('awaiting_parts');
    expect(out.units.B1.history.length).toBe(1);
  });

  it('mirrorFields exposes lean temporal summary without the big arrays', () => {
    const rec = canonical.diffAgainstPrior(
      canonical.computeCanonical({ equipmentId: 'MF', lifecycleState: 'Unavailable', serviceState: 'Repair complete' }),
      canonical.computeCanonical({ equipmentId: 'MF', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' })
    );
    const m = canonical.mirrorFields(rec);
    expect(m).toHaveProperty('canonicalPreviousStatus', 'awaiting_parts');
    expect(m).toHaveProperty('canonicalStatusChangedAt');
    expect(m).toHaveProperty('canonicalConflictCount');
    expect(m).not.toHaveProperty('evidence');
    expect(m).not.toHaveProperty('history');
  });
});

describe('canonical_state — next-action intent', () => {
  const row = { equipmentId: 'B62064', lifecycleState: 'Unavailable', vendor: 'Hunter Truck' };

  it('reply_to_vendor -> waitingOn us, question_open flag, open question in evidence', () => {
    const rec = canonical.reconcileCanonical(row, { decision: {
      equipmentId: 'B62064', currentStatus: 'Awaiting our freight decision', nextStep: 'answer the dealer',
      nextActionType: 'reply_to_vendor', weOweReply: true,
      awaitingReply: 'order the mirror normal or with freight?', threadOfRecord: 'offsite',
      confidence: 0.8,
    } });
    expect(rec.nextActionType).toBe('reply_to_vendor');
    expect(rec.waitingOn).toBe('us');
    expect(rec.flags).toContain('question_open');
    expect(rec.awaitingReply).toContain('normal or with freight');
    expect(rec.threadOfRecord).toBe('offsite');
    // the open question is recorded as evidence from the offsite thread
    const q = rec.evidence.find(e => e.field === 'openQuestion');
    expect(q).toBeTruthy();
    expect(q.source).toBe('offsite');
  });

  it('request_update (we already answered) -> waitingOn vendor, awaiting_vendor_reply flag', () => {
    // B62064's REAL state: we replied asking for a freight estimate, now THEY owe us.
    const rec = canonical.reconcileCanonical(row, { decision: {
      equipmentId: 'B62064', currentStatus: 'Awaiting dealer freight estimate', nextStep: 'chase the freight estimate',
      nextActionType: 'request_update', weOweReply: false, lastCommentBy: 'us', followUpNeeded: true,
      dealerAsk: 'Any update on the freight shipping estimate and revised ETC?', threadOfRecord: 'offsite',
      confidence: 0.82,
    } });
    expect(rec.nextActionType).toBe('request_update');
    expect(rec.waitingOn).toBe('vendor');
    expect(rec.flags).toContain('awaiting_vendor_reply');
    expect(rec.flags).not.toContain('question_open');
  });

  it('signalTokens surfaces the intent + open question', () => {
    const base = canonical.reconcileCanonical(row, { decision: {
      equipmentId: 'B62064', currentStatus: 'awaiting freight decision', nextActionType: 'reply_to_vendor',
      weOweReply: true, awaitingReply: 'normal or freight?', threadOfRecord: 'offsite', confidence: 0.8,
    } });
    const r2 = Object.assign({ equipmentId: 'B62064' }, canonical.mirrorFields(base));
    const store = { load() { throw new Error('use mirror'); } };
    const tokens = canonical.signalTokens(r2, { store });
    expect(tokens).toContain('action=reply_to_vendor');
    expect(tokens).toContain('OPEN-Q=');
  });

  it('deterministic record has intent none (cannot read a conversation)', () => {
    const rec = canonical.computeCanonical({ equipmentId: 'D1', lifecycleState: 'Unavailable', serviceState: 'awaiting parts' });
    expect(rec.nextActionType).toBe('none');
    expect(rec.awaitingReply).toBe('');
  });
});

describe('relay_reconcile_apply — reply_to_vendor is always confirm-gated', () => {
  it('a reply_to_vendor decision is STAGED even when MODE A auto-post is on', async () => {
    const apply = require('../src/scrapers/relay_reconcile_apply');
    // Stub the pending store + dedup ledger via the store module the apply layer uses.
    const store = require('../src/store');
    const origLoad = store.load, origSave = store.save;
    const mem = {};
    store.load = (k, d) => (k in mem ? mem[k] : (d !== undefined ? d : null));
    store.save = (k, v) => { mem[k] = v; };
    try {
      const decision = {
        equipmentId: 'RV1', _serviceUrl: 'https://relay/wr/1', _workRequestId: 'WR1',
        nextActionType: 'reply_to_vendor', followUpNeeded: true, weOweReply: true,
        dealerAsk: 'Yes, proceed with freight shipping.', confidence: 0.9,
        relayHasLatest: true, missingUpdate: '',
      };
      // MODE A on (autoPostToRelay true) + confidence above threshold.
      const res = await apply.applyReconcile(decision, { cfg: { autoPostToRelay: true, minConfidence: 0.5, staleDays: 3 } });
      const reply = res.posts.find(p => p.kind === 'reply-to-vendor');
      expect(reply).toBeTruthy();
      expect(reply.action).toBe('staged'); // NOT 'posted', despite MODE A
      // and it was placed in the pending queue
      const pending = mem['relayReconcilePending'];
      expect(pending && pending.items.some(it => it.equipmentId === 'RV1' && it.kind === 'reply-to-vendor')).toBe(true);
    } finally {
      store.load = origLoad; store.save = origSave;
    }
  });
});
