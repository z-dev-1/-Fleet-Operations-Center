// tests/email-api-attachments.test.js — attachment metadata and bounded content fetch over the REST transport
// (design 5.4; FR-2.6, AC-11): the existing attach/policy + attach/extract pipeline with the API fetchOne.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { createFakeNet, fakeTokens } from './fixtures/email-api/fake-net.js';
import { restMessage, restAttachment, mailboxRoutes, WK } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);
const { readMailbox } = require('../src/email-intel/transport/reader');
const { createHttp } = require('../src/email-intel/transport/http');
const { createFolderResolver } = require('../src/email-intel/transport/folders');
const { createFetchOne } = require('../src/email-intel/transport/attachments');
const policyMod = require('../src/email-intel/attach/policy');
const fp = require('../src/email-intel/capture/folder-plan');
const owaRe = require('../src/scrapers/owa-mailer');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const PDF = Buffer.from('%PDF-1.4 unit 40123 estimate').toString('base64');
const extractItem = async (job) => ({ status: 'read', kind: 'pdf', text: 'Estimate for unit 40123: 1200 USD (' + job.name + ')' });

function setup(atts, extraRoutes, tokens) {
  const msg = restMessage({ Id: 'M1', ConversationId: 'CONV-A', InternetMessageId: '<a1@example.test>', ReceivedDateTime: '2026-11-07T10:00:00Z', HasAttachments: true, ParentFolderId: WK.inbox });
  const fn = createFakeNet((extraRoutes || []).concat(mailboxRoutes({ msgs: [msg], atts: { M1: atts } })));
  const http = createHttp({ electron: fn.electron, tokens: tokens || fakeTokens(), owaRe, sleep: () => Promise.resolve() });
  return { fn, http, transport: { http, folders: createFolderResolver({ http, owaRe }), owaRe } };
}
const contentRoute = (respond) => ({ method: 'GET', re: /\/messages\/M1\/attachments\/[^?]+$/, respond });
async function read(x, attachments, extra) {
  const batches = [];
  const r = await readMailbox(Object.assign({
    folders: ['Inbox'], plan: fp.planFolderBudgets({ folders: ['Inbox'], max: 3 }), checkpoints: {}, now: NOW, lookbackDays: 14, caps: { maxOpen: 10 },
    apiCursors: {}, _transport: x.transport, isKnownSeed: () => false, onBatch: async (_f, items) => { batches.push(...items); }, onApiCursor: async () => {},
  }, attachments ? { attachments } : {}, extra || {}));
  return { r, caps: batches.flatMap((b) => b.captures) };
}
const budget = (cfg) => policyMod.createBudget(policyMod.policyOf(cfg || {}), { now: Date.now() });

describe('attachments', () => {
  it('AC-11 attachments OFF does no content GET; ON fetches only allowed items under the caps', async () => {
    const atts = [restAttachment({ Id: 'A-PDF', Name: 'estimate.pdf', Size: 2000 }), restAttachment({ Id: 'A-EXE', Name: 'tool.exe', Size: 100 }),
      restAttachment({ Id: 'A-PNG', Name: 'photo.png', ContentType: 'image/png', Size: 500 }), restAttachment({ Id: 'A-IN', Name: 'logo.gif', IsInline: true })];
    const ok = contentRoute(() => ({ status: 200, json: { '@odata.type': '#Microsoft.OutlookServices.FileAttachment', ContentBytes: PDF, ContentType: 'application/pdf' } }));
    const off = setup(atts, [ok]);
    const r0 = await read(off, null);
    expect(off.fn.calls.filter((c) => /\/attachments\/A-/.test(c.decoded))).toHaveLength(0);
    expect(r0.caps[0].attachments.map((a) => [a.name, a.analysis.status])).toEqual([['estimate.pdf', 'filename-only'], ['tool.exe', 'filename-only'], ['photo.png', 'filename-only']]);
    const on = setup(atts, [ok]);
    const r1 = await read(on, { flagOn: true, budget: budget(), unitIds: ['40123'], deps: { extractItem } });
    const gets = on.fn.calls.filter((c) => /\/attachments\/A-/.test(c.decoded));
    expect(gets.map((c) => c.decoded.split('/').pop())).toEqual(['A-PDF']);
    const st = Object.fromEntries(r1.caps[0].attachments.map((a) => [a.name, a.analysis.status + ':' + (a.analysis.reason || '')]));
    expect(st).toEqual({ 'estimate.pdf': 'content:', 'tool.exe': 'skipped:extension-not-allowed', 'photo.png': 'skipped:vision-notice-pending' });
    expect(r1.caps[0].attachmentExcerpts).toEqual([expect.objectContaining({ index: 0, status: 'content' })]);
  });

  it('AC-11 over-size items are skipped before download and over-cap responses are aborted', async () => {
    const atts = [restAttachment({ Id: 'A-BIG', Name: 'big.pdf', Size: 200_000 }), restAttachment({ Id: 'A-LIE', Name: 'lies.pdf', Size: 1000 })];
    const x = setup(atts, [contentRoute(() => ({ status: 200, chunks: ['{"ContentBytes":"', 'A'.repeat(250_000), '"}'] }))]);
    const r = await read(x, { flagOn: true, budget: budget({ attachments: { maxBytes: 100_000 } }), unitIds: [], deps: { extractItem } });
    const by = Object.fromEntries(r.caps[0].attachments.map((a) => [a.name, a.analysis]));
    expect(by['big.pdf']).toMatchObject({ status: 'skipped', reason: 'over-size' });
    expect(by['lies.pdf']).toMatchObject({ status: 'unreadable', reason: 'too-large' });
    expect(x.fn.calls.filter((c) => /\/attachments\/A-/.test(c.decoded)).map((c) => c.decoded.split('/').pop())).toEqual(['A-LIE']);
  });

  it('an auth wall during a download stops the read as auth-blocked', async () => {
    const x = setup([restAttachment({ Id: 'A-PDF', Name: 'estimate.pdf' })], [contentRoute(() => ({ status: 401 }))]);
    const r = await read(x, { flagOn: true, budget: budget(), unitIds: [], deps: { extractItem } });
    expect(r.r.authBlocked).toBe(true);
    expect(r.r.ok).toBe(false);
  });

  it('re-extract by itemId; DOM targets without an item id are not-found (no DOM fallback)', async () => {
    const x = setup([restAttachment({ Id: 'A-PDF', Name: 'estimate.pdf' })], [contentRoute(() => ({ status: 200, json: { ContentBytes: PDF, ContentType: 'application/pdf' } })),
      { method: 'GET', re: /\/messages\/GONE\/attachments/, respond: () => ({ status: 404, json: { error: { code: 'ErrorItemNotFound' } } }) }]);
    const reports = [];
    const att = [{ attId: 'A-PDF', name: 'estimate.pdf', ext: 'pdf', sizeBytes: 100, kind: 'document', placeholder: false, hasDownloadHandle: true, analysis: { status: 'pending-reextract' } }];
    await read(x, { flagOn: true, budget: budget(), unitIds: [], deps: { extractItem } }, {
      reextract: [{ messageKey: 'mi_1', itemId: 'M1', attachments: att, indexes: [0] }, { messageKey: 'md_2', itemId: null, attachments: att, indexes: [0] }, { messageKey: 'mi_3', itemId: 'GONE', attachments: att, indexes: [0] }],
      onReextract: async (t, res) => { reports.push([t.messageKey, res.status, res.attachments ? res.attachments[0].analysis.status : null]); },
    });
    expect(reports).toEqual([['mi_1', 'ok', 'content'], ['md_2', 'not-found', null], ['mi_3', 'not-found', null]]);
  });

  it('createFetchOne refuses entries without a handle and decodes ContentBytes', async () => {
    const x = setup([], [contentRoute(() => ({ status: 200, json: { ContentBytes: PDF, ContentType: 'application/pdf; name=x' } }))]);
    const f = createFetchOne({ http: x.http, itemId: 'M1' });
    expect(await f({ attId: null, hasDownloadHandle: false }, 0, { maxBytes: 1000 })).toEqual({ ok: false, reason: 'no-handle' });
    expect(await f({ attId: 'A', hasDownloadHandle: true, sizeBytes: 5000 }, 0, { maxBytes: 1000 })).toEqual({ ok: false, reason: 'too-large' });
    const ok = await f({ attId: 'A', hasDownloadHandle: true, sizeBytes: 10 }, 0, { maxBytes: 1000, timeoutMs: 1000 });
    expect(ok).toMatchObject({ ok: true, mimetype: 'application/pdf', bytes: Buffer.from(PDF, 'base64').length });
  });
});
