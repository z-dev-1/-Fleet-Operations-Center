// tests/fixtures/email-intel/records.js — MessageRecords for Phase B (analysis-level) tests.
// Builds real ledger records (identity + segmenter) from the synthetic mk() objects in emails.js,
// plus a scripted isolated lane that answers with the JSON fixtures in ./ai/*.json.
// No Outlook, no network, no real model.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { ME, fleetData } from './fleet.js';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ledger = require('../../../src/email-intel/ingest/ledger');
const identity = require('../../../src/email-intel/ingest/identity');

export const NOW = Date.parse('2026-11-04T16:00:00.000Z');

/** capOf(mkObj, over) -> the capture shape ledger.buildRecord consumes. */
export function capOf(m, over = {}) {
  const convId = m.conversationId;
  return Object.assign({
    itemId: m.messageId, conversationKey: identity.conversationKey(convId), convIdRaw: convId, convIdSource: 'owa', legacySeed: convId,
    folder: m.folder || 'Inbox', from: m.from, to: m.to || [], cc: m.cc || [], toCount: (m.to || []).length, ccCount: (m.cc || []).length,
    recipientsKnown: true, subject: m.subject, receivedAt: m.receivedAt, receivedAtQuality: 'exact', receivedAtPrecision: 'minute', receivedAtRaw: m.receivedText,
    bodyText: m.bodyText, textLen: (m.bodyText || '').length, bodyStatus: 'complete', bodySource: 'pane', attachments: (m.attachments || []).map((a) => Object.assign({ ext: '', kind: 'document' }, a)),
    flags: { unread: true },
  }, over);
}

/** recordOf(mkObj, { me, over, doc }) -> a fresh MessageRecord (inserted into `doc` when given). */
export function recordOf(m, o = {}) {
  const doc = o.doc || ledger.emptyDoc();
  const res = ledger.buildRecord(capOf(m, o.over || {}), doc, { me: o.me || ME, now: NOW, scanId: 'sc_test' });
  if (o.doc) ledger.upsert(doc, res.record);
  return res.record;
}

export const scopeIndex = (variant = 'fresh', extra = {}) =>
  require('../../../src/email-intel/understand/scope').buildScopeIndex(Object.assign({ now: NOW, fleetData: fleetData(variant, NOW) }, extra));

/** Load an AI fixture (JSON with "$REF" placeholders for messageRef). */
export function aiFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'ai', name + '.json'), 'utf8'));
}

/** The messageRef the prompt carries in MESSAGE META. */
export function refOf(prompt) {
  const m = /MESSAGE META[^\n]*\n(\{.*\})/.exec(prompt);
  return m ? JSON.parse(m[1]).messageRef : null;
}

/**
 * scriptedRelay(answer) — fake relay for lane.js. `answer(prompt, opts, n)` returns a string, an object
 * (serialized, with "$REF" replaced by the prompt's messageRef), null (empty reply) or throws.
 */
export function scriptedRelay(answer, o = {}) {
  const calls = [];
  const relay = {
    calls, available: o.available !== false, inFlight: 0, maxInFlight: 0, events: [],
    isolatedLaneAvailable: () => relay.available,
    async askWithTimeout(prompt, opts) {
      const n = calls.length;
      calls.push({ prompt, opts });
      relay.inFlight++; relay.maxInFlight = Math.max(relay.maxInFlight, relay.inFlight);
      relay.events.push('start:' + n);
      try {
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        let out = await answer(prompt, opts, n);
        if (out && typeof out === 'object') out = JSON.stringify(out).split('"$REF"').join(JSON.stringify(refOf(prompt)));
        return out;
      } finally { relay.inFlight--; relay.events.push('end:' + n); }
    },
  };
  return relay;
}

/** docOf(records) -> a messages document holding the records (conversation order kept by the ledger). */
export function docOf(records) {
  const d = ledger.emptyDoc();
  for (const r of records) ledger.upsert(d, r);
  return d;
}

/** analyzeDoc(doc, relay, over) -> runScanAnalysis stats, with the scripted relay installed in lane.js. */
export async function analyzeDoc(doc, relay, over = {}) {
  const lane = require('../../../src/email-intel/understand/lane');
  lane._setRelayForTests(relay);
  const an = require('../../../src/email-intel/understand/analyze');
  const cfgMod = require('../../../src/email-intel/config');
  return an.runScanAnalysis(doc, Object.assign({ index: scopeIndex('fresh'), me: ME, cfg: cfgMod.normalize({}), trigger: 'manual', now: NOW, lookbackDays: 14 }, over));
}

/** Replace "$REF" in an object with the messageRef of the prompt (for direct validator tests). */
export function withRef(obj, ref) {
  return JSON.parse(JSON.stringify(obj).split('"$REF"').join(JSON.stringify(ref)));
}
