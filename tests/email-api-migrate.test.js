// tests/email-api-migrate.test.js — derived (DOM) -> real (REST) identity: identity/ledger API branch, api-migrate
// (pass 1, R4-M1 uniqueness, R4-M2 window, R4-M3 planGroup) and legacy-adapter sameLatest (design 6; FR-2.7, FR-2.8,
// AC-8, AC-9). Pure (no store).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { restMessage } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);
const ledger = require('../src/email-intel/ingest/ledger');
const identity = require('../src/email-intel/ingest/identity');
const apiMigrate = require('../src/email-intel/ingest/api-migrate');
const adapter = require('../src/email-intel/ingest/legacy-adapter');
const map = require('../src/email-intel/transport/map');
const { segment } = require('../src/email-intel/ingest/segmenter');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const DAY = 86_400_000;
const REST_CONV = 'AAQk-CONV_1=';
const DOM_CONV = map.legacyConvId(REST_CONV);

function domCap(o) {
  const x = o || {};
  const convIdRaw = x.convIdRaw || DOM_CONV;
  return {
    itemId: null, conversationKey: identity.conversationKey(convIdRaw), convIdRaw, convIdSource: 'owa', legacySeed: convIdRaw, folder: 'Inbox',
    subject: x.subject || 'Unit 40123 status', from: x.from || { name: 'Shop Desk', address: null }, to: [], cc: [], toCount: 0, ccCount: 0, recipientsKnown: false,
    receivedAt: null, receivedAtQuality: 'unknown', receivedAtPrecision: null, receivedAtRaw: '', bodyText: x.text, bodyStatus: 'complete', bodySource: 'pane', textLen: x.text.length,
    attachments: [], flags: { unread: false }, isLatest: true, blockIndex: 0,
  };
}
function addDom(doc, o, now) {
  const r = ledger.buildRecord(domCap(o), doc, { now: now || NOW - DAY });
  ledger.upsert(doc, r.record);
  return doc.messages[r.record.messageKey];
}
function apiCap(o) {
  const x = o || {};
  return map.toCapture(restMessage(Object.assign({ ConversationId: x.conv || REST_CONV, ReceivedDateTime: x.at || '2026-11-07T08:00:00Z', Body: { ContentType: 'Text', Content: x.text } }, x.rest || {})), { folderLabel: 'Inbox' });
}
const ctx = (extra) => Object.assign({ now: NOW, lookbackDays: 14 }, extra || {});
const W10 = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';

afterEach(() => vi.restoreAllMocks());

describe('keys', () => {
  it('AC-8 the API record key starts with mi_ and messageIdSource is owa-item', () => {
    const doc = ledger.emptyDoc();
    const cap = apiCap({ text: 'Unit 40123 ready' });
    const r = ledger.buildRecord(cap, doc, ctx());
    expect(r.created).toBe(true);
    expect(r.record.messageKey).toMatch(/^mi_/);
    expect(r.record.messageKey).toBe(identity.itemKey(cap.keySeed));
    expect(r.record.messageKey).not.toBe(identity.itemKey(cap.itemId));
    expect(r.record).toMatchObject({ messageIdSource: 'owa-item', source: 'api', zoneExplicit: true, recipientsKnown: true, receivedAtQuality: 'exact',
      internetMessageId: cap.apiIds.internetMessageId, apiConversationId: REST_CONV, itemId: cap.itemId, convIdSource: 'owa' });
    expect(r.migrated).toBe(false);
  });

  it('a DOM capture reaches resolveMessageKey without a keySeed key and builds the same record as before', () => {
    const spy = vi.spyOn(identity, 'resolveMessageKey');
    const doc = ledger.emptyDoc();
    const r = ledger.buildRecord(domCap({ text: 'hello there' }), doc, { now: NOW });
    expect(Object.prototype.hasOwnProperty.call(spy.mock.calls[0][0], 'keySeed')).toBe(false);
    expect(r.record.messageKey).toMatch(/^md_/);
    expect(r.record.source).toBeUndefined();
    expect(r.record.zoneExplicit).toBeUndefined();
    expect(r).not.toHaveProperty('migrated');
  });

  it('a moved message keeps its key and refreshes the REST id', () => {
    const doc = ledger.emptyDoc();
    const cap = apiCap({ text: 'x', rest: { Id: 'ID-OLD', InternetMessageId: '<moved@example.test>' } });
    ledger.upsert(doc, ledger.buildRecord(cap, doc, ctx()).record);
    const again = apiCap({ text: 'x', rest: { Id: 'ID-NEW', InternetMessageId: '<moved@example.test>', ParentFolderId: 'F-ARCHIVE' } });
    again.folder = 'Archive';
    const r = ledger.buildRecord(again, doc, ctx());
    expect(r.created).toBe(false);
    expect(r.record.itemId).toBe('ID-NEW');
    expect(r.record.foldersSeen).toEqual(['Inbox', 'Archive']);
  });
});

describe('derived -> real dedupe', () => {
  it('AC-9 a DOM md_ record merges into one mi_ record keeping analysis, legacyId and drafted state', () => {
    const doc = ledger.emptyDoc();
    const dom = addDom(doc, { text: 'Unit 40123 is in repair, ETA Friday.' });
    dom.analysis = { status: 'ok', attempts: 1, result: { units: [] } };
    const prev = { emails: [{ id: dom.legacyId, replyState: 'drafted', replyDraft: 'Thanks!', triagedAt: '2026-11-06T00:00:00Z', intel: { latestMessageKey: dom.messageKey, conversationKey: dom.conversationKey } }] };
    const cap = apiCap({ text: 'Unit 40123 is in repair, ETA Friday.' });
    const r = ledger.buildRecord(cap, doc, ctx());
    expect(r.migrated).toBe(true);
    ledger.upsert(doc, r.record);
    expect(doc.messages[dom.messageKey]).toBeUndefined();
    expect(doc.aliasIndex[dom.messageKey]).toBe(r.record.messageKey);
    const rec = doc.messages[r.record.messageKey];
    expect(rec.analysis.status).toBe('ok');
    expect(rec.legacyId).toBe(dom.legacyId);
    expect(ledger.conversation(doc, dom.conversationKey).map((x) => x.messageKey)).toEqual([rec.messageKey]);
    const out = adapter.buildResults({ prev, views: [{ conversationKey: rec.conversationKey, records: [rec] }], triaged: {}, now: NOW });
    expect(out.emails[0]).toMatchObject({ id: dom.legacyId, replyState: 'drafted', replyDraft: 'Thanks!' });
    expect(out.emails[0].intel.latestMessageKey).toBe(rec.messageKey);
  });

  it('the address-less DOM sender is matched by display name', () => {
    const doc = ledger.emptyDoc();
    const dom = addDom(doc, { text: 'Same body text here.', from: { name: 'Shop Desk', address: null } });
    const r = ledger.buildRecord(apiCap({ text: 'Same body text here.' }), doc, ctx());
    expect(r.record.aliases).toEqual([dom.messageKey]);
  });

  it('AC-9 a different message in the same conversation is not merged', () => {
    const doc = ledger.emptyDoc();
    addDom(doc, { text: 'Parts arrived for unit 40123 yesterday morning at the dock.' });
    const r = ledger.buildRecord(apiCap({ text: 'Invoice 9921 attached, please approve by Monday.' }), doc, ctx());
    expect(r.migrated).toBe(false);
    expect(r.record.aliases).toBeUndefined();
  });

  it('R4-M1 pass-1 uniqueness merges the single unmatched md_ candidate with text >= 0.5', () => {
    const doc = ledger.emptyDoc();
    const dom = addDom(doc, { text: 'alpha bravo charlie delta echo foxtrot golf' }, NOW + 60_000);   // ingested after the API time
    const cap = apiCap({ text: W10 });
    const seg = segment(cap.bodyText, { subject: cap.subject });
    const m = apiMigrate.matchDerived(doc, cap, seg, ctx());
    expect(m).toMatchObject({ key: dom.messageKey, crossConversation: false });
    expect(m.text).toBeGreaterThanOrEqual(0.5);
    expect(m.text).toBeLessThan(0.8);
  });

  it('R4-M1 pass-1 uniqueness does not merge two tied candidates (ambiguous)', () => {
    const doc = ledger.emptyDoc();
    addDom(doc, { text: 'alpha bravo charlie delta echo foxtrot xray' });
    addDom(doc, { text: 'alpha bravo charlie delta echo foxtrot yankee' });
    const cap = apiCap({ text: W10 });
    const stats = {};
    expect(apiMigrate.matchDerived(doc, cap, segment(cap.bodyText, {}), ctx({ stats }))).toBeNull();
    expect(stats.ambiguous).toBe(1);
  });

  it('R4-M2 pass 2 matches a receivedAt:null record by ingestedAt inside lookbackDays + 2 d', () => {
    const doc = ledger.emptyDoc();
    const dom = addDom(doc, { text: W10, convIdRaw: 'DOM/OTHER+ENC=' }, NOW - 3 * DAY);
    expect(dom.receivedAt).toBeNull();
    const cap = apiCap({ text: W10 });
    const m = apiMigrate.matchDerived(doc, cap, segment(cap.bodyText, {}), ctx());
    expect(m).toMatchObject({ key: dom.messageKey, crossConversation: true, conversationKey: dom.conversationKey, legacyId: dom.legacyId });
    const r = ledger.buildRecord(cap, doc, ctx());
    expect(r.record.conversationKey).toBe(dom.conversationKey);
    expect(r.record.legacyId).toBe(dom.legacyId);
    expect(doc.convAliasIndex[cap.conversationKey]).toEqual({ conversationKey: dom.conversationKey, legacyId: dom.legacyId });
  });

  it('R4-M2 pass 2 skips a receivedAt:null record outside the window', () => {
    const doc = ledger.emptyDoc();
    addDom(doc, { text: W10, convIdRaw: 'DOM/OTHER+ENC=' }, NOW - 17 * DAY);
    const cap = apiCap({ text: W10 });
    expect(apiMigrate.matchDerived(doc, cap, segment(cap.bodyText, {}), ctx())).toBeNull();
  });

  it('R4-M2 pass 2 is skipped when ctx.lookbackDays is missing', () => {
    const doc = ledger.emptyDoc();
    addDom(doc, { text: W10, convIdRaw: 'DOM/OTHER+ENC=' }, NOW - 1 * DAY);
    const cap = apiCap({ text: W10 });
    expect(apiMigrate.matchDerived(doc, cap, segment(cap.bodyText, {}), { now: NOW })).toBeNull();
    expect(apiMigrate.matchDerived(doc, cap, segment(cap.bodyText, {}), ctx())).not.toBeNull();
  });

  it('R4-M3 planGroup applies the newest-member alias to all 3 group members', () => {
    const doc = ledger.emptyDoc();
    const dom = addDom(doc, { text: 'Final answer: unit 40123 picked up today, thanks all.', convIdRaw: 'DOM/OTHER+ENC=' }, NOW - DAY);
    const caps = [
      apiCap({ text: 'First question about unit 40123 timing.', at: '2026-11-05T08:00:00Z' }),
      apiCap({ text: 'Second message: parts on order for 40123.', at: '2026-11-06T08:00:00Z' }),
      apiCap({ text: 'Final answer: unit 40123 picked up today, thanks all.', at: '2026-11-07T08:00:00Z' }),
    ];
    const apiKey = caps[0].conversationKey;
    const plan = apiMigrate.planGroup(doc, caps, ctx());
    expect(plan).toEqual({ conversationKey: dom.conversationKey, legacyIdOverride: dom.legacyId });
    expect(doc.convAliasIndex).toBeUndefined();          // pure: no writes
    apiMigrate.recordConvAlias(doc, apiKey, { conversationKey: plan.conversationKey, legacyId: plan.legacyIdOverride });
    for (const c of caps) { c.conversationKey = plan.conversationKey; c.legacyIdOverride = plan.legacyIdOverride; }
    for (const c of caps) { const r = ledger.buildRecord(c, doc, ctx()); ledger.upsert(doc, r.record); }
    const recs = ledger.conversation(doc, dom.conversationKey);
    expect(recs).toHaveLength(3);
    expect(new Set(recs.map((r) => r.legacyId))).toEqual(new Set([dom.legacyId]));
    expect(recs.every((r) => r.source === 'api')).toBe(true);
    expect(doc.byConv[apiKey]).toBeUndefined();
    expect(apiMigrate.planGroup(doc, [apiCap({ text: 'later reply', at: '2026-11-08T08:00:00Z' })], ctx())).toEqual(plan);   // the alias wins next time
  });

  it('R4-M3 planGroup returns null on a cross-capture tie', () => {
    const doc = ledger.emptyDoc();
    addDom(doc, { text: 'Message one body text for the tie case.', convIdRaw: 'DOM/A=' }, NOW - DAY);
    addDom(doc, { text: 'Message two body text for the tie case.', convIdRaw: 'DOM/B=' }, NOW - DAY);
    const caps = [apiCap({ text: 'Message one body text for the tie case.', at: '2026-11-06T08:00:00Z' }), apiCap({ text: 'Message two body text for the tie case.', at: '2026-11-07T08:00:00Z' })];
    const stats = {};
    expect(apiMigrate.planGroup(doc, caps, ctx({ stats }))).toBeNull();
    expect(stats.ambiguous).toBe(1);
  });
});

describe('sameLatest', () => {
  it('unit cases: prev undefined, prev without intel, same key, alias key, different key', () => {
    const latest = { messageKey: 'mi_new', source: 'api', aliases: ['md_old'] };
    expect(adapter.sameLatest('mi_new', latest)).toBe(true);
    expect(adapter.sameLatest('md_old', latest)).toBe(true);
    expect(adapter.sameLatest('md_other', latest)).toBe(false);
    expect(adapter.sameLatest('md_old', { messageKey: 'md_x', aliases: ['md_old'] })).toBe(false);   // DOM record: plain ===
    expect(adapter.sameLatest(undefined, latest)).toBe(false);
    const view = { conversationKey: 'cv_1', records: [Object.assign({ legacyId: 'em_1', body: {}, from: {} }, latest)] };
    const keep = (p) => adapter.buildResults({ prev: { emails: p ? [p] : [] }, views: [view], triaged: { em_1: { id: 'em_1' } }, now: NOW }).emails[0];
    expect(keep(undefined).replyState).toBe('none');
    expect(keep({ id: 'em_1', replyState: 'drafted', replyDraft: 'd' }).replyState).toBe('drafted');                      // prev without intel
    expect(keep({ id: 'em_1', replyState: 'drafted', replyDraft: 'd', intel: { latestMessageKey: 'md_old' } }).replyState).toBe('drafted');
    expect(keep({ id: 'em_1', replyState: 'drafted', replyDraft: 'd', intel: { latestMessageKey: 'md_zzz' } }).replyState).toBe('none');
  });
});
