// tests/email-intel-staged.test.js — the staging store (design 4.5, 1.2; R3.4, R3.7, F-23). Real store on a
// temp dir for persistence; the cap / expiry rules on plain documents.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mk } from './fixtures/email-intel/emails.js';
import { recordOf } from './fixtures/email-intel/records.js';
import { factsWorld, vfact } from './fixtures/email-intel/facts-harness.js';
const require = createRequire(import.meta.url);
const staged = require('../src/email-intel/facts/staged');
const fk = require('../src/email-intel/facts/fact-key');

let w = null;
afterEach(() => { if (w) w.cleanup(); w = null; });
const msgOf = (o = {}) => recordOf(mk({ subject: 'Turbo 40123', body: 'Turbo ETA 11/12 for 40123', receivedAt: '2026-11-04T14:30:00.000Z', ...o }));
const DAY = 86_400_000;

describe('staging', () => {
  it('R3.4 staged provenance', () => {
    w = factsWorld();
    const msg = msgOf({ from: { name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' } });
    const f = vfact({ effectiveConfidence: 0.6, caps: ['not-stated'] });
    const r = staged.stageFact({ fact: f, unit: '40123', msg, reason: 'low-confidence', detail: 'confidence 0.60 is below the threshold', proposedLine: 'line [em:00000000]', canonicalSnapshot: { status: 'down', repairPhase: 'awaiting_parts', lastUpdateAt: '', lastUpdateSource: '' } });
    expect(r.ok).toBe(true);
    const it = r.item;
    expect(it.stagedId).toBe(staged.stagedIdOf(fk.keysOf(f, '40123').factKey, msg.messageKey));
    expect(it.stagedId).toMatch(/^st_[0-9a-f]{16}$/);
    expect(it).toMatchObject({
      unit: '40123', groupKey: '40123|parts_eta', reason: 'low-confidence', state: 'open', proposedLine: 'line [em:00000000]',
      fact: { kind: 'parts_eta', item: 'turbo', value: 'Turbo ETA 11/12', state: 'eta_given', date: '2026-11-12', assertion: 'stated', evidenceQuote: 'Turbo ETA 11/12 for 40123', confidenceEffective: 0.6, caps: ['not-stated'] },
      provenance: { messageKey: msg.messageKey, conversationKey: msg.conversationKey, source: 'email', senderName: 'Dealer Parts Desk', receivedAt: '2026-11-04T14:30:00.000Z', receivedAtQuality: 'exact', bodyStatus: 'complete' },
      canonicalSnapshot: { status: 'down' },
    });
    expect(JSON.stringify(it)).not.toContain('parts@dealer');
  });

  it('R3.7 each reason stages and persists', () => {
    w = factsWorld();
    for (const reason of staged.REASONS) {
      const r = staged.stageFact({ fact: vfact({ value: 'Turbo ETA ' + reason, date: null, state: 'delayed' }), unit: '40123', msg: msgOf(), reason, detail: reason });
      expect(r.ok, reason).toBe(true);
    }
    // a unit mention without a fact (unprocessed window / AI unavailable) stages too
    expect(staged.stageFact({ fact: null, unit: '40789', msg: msgOf(), reason: 'unprocessed-window', detail: 'x' }).item.fact).toBeNull();
    // reload from disk (a fresh module read of the file)
    const raw = JSON.parse(require('fs').readFileSync(require('path').join(w.tmp, 'email_intel_staged.json'), 'utf8'));
    const reasons = Object.values(raw.items).map((x) => x.reason);
    for (const reason of staged.REASONS) expect(reasons, reason).toContain(reason);
    expect(raw.version).toBe(1);
  });

  it('repeat sightings upsert (never duplicate) and corroborate; a newer fact supersedes older open items', () => {
    const doc = staged.ensureDoc({ version: 1 });
    const m1 = msgOf();
    const a = staged.stage(doc, { fact: vfact(), unit: '40123', msg: m1, reason: 'low-confidence' });
    const again = staged.stage(doc, { fact: vfact(), unit: '40123', msg: m1, reason: 'low-confidence', now: Date.now() + 1000 });
    expect(again.created).toBe(false);
    expect(Object.keys(doc.items)).toHaveLength(1);
    const m2 = msgOf({ subject: 'FW: Turbo 40123' });
    expect(staged.corroborate(doc, a.item.factKey, m2.messageKey)).toBe(1);
    expect(staged.corroborate(doc, a.item.factKey, m2.messageKey)).toBe(0);
    expect(doc.items[a.item.stagedId].corroboratedBy).toEqual([m2.messageKey]);
    // newer ETA for the same part (turbocharger ~ turbo) supersedes; another part does not
    const other = staged.stage(doc, { fact: vfact({ item: 'DPF', value: 'DPF ETA 11/14', date: '2026-11-14' }), unit: '40123', msg: m1, reason: 'low-confidence' });
    const m3 = msgOf({ receivedAt: '2026-11-05T10:00:00.000Z' });
    staged.stage(doc, { fact: vfact({ item: 'turbocharger', value: 'ETA 11/15', date: '2026-11-15' }), unit: '40123', msg: m3, reason: 'low-confidence' });
    expect(doc.items[a.item.stagedId]).toMatchObject({ state: 'superseded', resolution: 'newer-fact' });
    expect(doc.items[other.item.stagedId].state).toBe('open');
    // decisions are recorded with decidedBy user
    expect(staged.close(doc, other.item.stagedId, 'rejected', null, Date.now())).toMatchObject({ state: 'rejected', decidedBy: 'user' });
    // a decided item is not reopened by a later sighting
    staged.stage(doc, { fact: vfact({ item: 'DPF', value: 'DPF ETA 11/14', date: '2026-11-14' }), unit: '40123', msg: m1, reason: 'conflict-canonical' });
    expect(doc.items[other.item.stagedId]).toMatchObject({ state: 'rejected', reason: 'low-confidence' });
  });

  it('F-23 protected reasons never expire; banner counts expired', () => {
    const now = Date.parse('2026-11-04T16:00:00.000Z');
    const doc = staged.ensureDoc({ version: 1 });
    const add = (n, reason, ageDays) => {
      for (let i = 0; i < n; i++) {
        const id = 'st_' + reason.slice(0, 4) + String(ageDays).padStart(2, '0') + String(i).padStart(10, '0');
        doc.items[id] = { stagedId: id, reason, state: 'open', createdAt: new Date(now - ageDays * DAY - i * 1000).toISOString(), lastSeenAt: new Date(now).toISOString(), provenance: {} };
      }
    };
    add(200, 'conflict-canonical', 40);           // protected, older than 30 days: stays open
    add(100, 'spend-related', 1);
    add(150, 'low-confidence', 1);
    add(150, 'timeline-disabled', 1);
    add(5, 'timeline-disabled', 31);              // expirable and older than 30 days
    const r = staged.applyCaps(doc, now);
    const open = Object.values(doc.items).filter((x) => x.state === 'open');
    expect(open.length).toBe(500);
    expect(open.filter((x) => x.reason === 'conflict-canonical')).toHaveLength(200);
    expect(open.filter((x) => x.reason === 'spend-related')).toHaveLength(100);
    expect(open.filter((x) => x.reason === 'timeline-disabled')).toHaveLength(50);             // timeline-disabled expire first
    expect(open.filter((x) => x.reason === 'low-confidence')).toHaveLength(150);
    expect(r).toMatchObject({ expired: 105, overCap: false });
    expect(doc.expiredCount).toBe(105);                                                       // the "N expired" banner count
    // only protected reasons left over the cap: the cap is exceeded, overCap is reported, nothing protected expires
    const doc2 = staged.ensureDoc({ version: 1 });
    for (let i = 0; i < 510; i++) doc2.items['st_' + i] = { stagedId: 'st_' + i, reason: staged.PROTECTED[i % staged.PROTECTED.length], state: 'open', createdAt: new Date(now - 90 * DAY).toISOString(), provenance: {} };
    expect(staged.applyCaps(doc2, now)).toMatchObject({ expired: 0, overCap: true });
    expect(staged.openCount(doc2)).toBe(510);
    // resolved items older than 30 days are pruned
    const doc3 = staged.ensureDoc({ version: 1, items: { st_old: { stagedId: 'st_old', state: 'rejected', decidedAt: new Date(now - 31 * DAY).toISOString(), provenance: {} } } });
    expect(staged.applyCaps(doc3, now).pruned).toBe(1);
    expect(doc3.items).toEqual({});
  });

  it('list pages newest first and openMessageKeys pins messages of open items', () => {
    const doc = staged.ensureDoc({ version: 1 });
    const m = msgOf();
    staged.stage(doc, { fact: vfact(), unit: '40123', msg: m, reason: 'low-confidence', now: 1000 });
    staged.stage(doc, { fact: vfact({ item: 'DPF', date: '2026-11-14' }), unit: '40123', msg: msgOf(), reason: 'low-confidence', now: 2000 });
    const l = staged.list(doc, { state: 'open', offset: 0, limit: 1 });
    expect(l.total).toBe(2);
    expect(l.items[0].fact.item).toBe('DPF');
    expect(staged.openMessageKeys(doc).has(m.messageKey)).toBe(true);
  });
});
