// tests/email-api-reader.test.js — transport/reader.js readMailbox over a fake REST mailbox (design 5.2-5.4;
// FR-2.1 to FR-2.3, FR-2.5, AC-5 to AC-7, AC-10, AC-10a, R4-L8, R4-L10, R4-L11). Fake net + fake token source.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { createFakeNet, fakeTokens } from './fixtures/email-api/fake-net.js';
import { restMessage, restFolder, mailboxRoutes, WK } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);
const { readMailbox } = require('../src/email-intel/transport/reader');
const { createHttp } = require('../src/email-intel/transport/http');
const { createFolderResolver } = require('../src/email-intel/transport/folders');
const fp = require('../src/email-intel/capture/folder-plan');
const owaRe = require('../src/scrapers/owa-mailer');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const at = (h) => new Date(NOW - h * 3600_000).toISOString().replace('.000Z', 'Z');
const noSleep = () => Promise.resolve();

function world(w, routesExtra) {
  const fn = createFakeNet((routesExtra || []).concat(mailboxRoutes(w)));
  const http = createHttp({ electron: fn.electron, tokens: fakeTokens(), owaRe, sleep: noSleep, log: { info() {}, warn() {} } });
  const folders = createFolderResolver({ http, owaRe });
  return { fn, http, folders, transport: { http, folders, owaRe } };
}
function harness(x, folders, o) {
  const opt = o || {};
  const known = new Set(opt.known || []);
  const order = [];
  const batches = [];
  const cursors = Object.assign({}, opt.cursors || {});
  const res = readMailbox(Object.assign({
    folders, plan: opt.plan || fp.planFolderBudgets({ folders, max: opt.max || 9, rotationNext: opt.rotation || 0 }), checkpoints: {},
    now: NOW, lookbackDays: 14, caps: { maxOpen: 60 }, apiCursors: cursors, _transport: x.transport,
    isKnownSeed: (s) => known.has(s),
    onBatch: async (folder, items) => { if (opt.failBatch) throw new Error('store-write'); order.push('batch:' + folder); batches.push({ folder, items }); },
    onApiCursor: async (folder, c) => { order.push('cursor:' + folder); cursors[folder] = c; },
  }, opt.extra || {}));
  return res.then((r) => ({ r, order, batches, cursors, caps: batches.flatMap((b) => b.items.flatMap((i) => i.captures)), groups: batches.flatMap((b) => b.items) }));
}
const conv = (n) => 'CONV-' + n;
const inbox = (n, h, extra) => restMessage(Object.assign({ Id: 'M' + n, ConversationId: conv(n), InternetMessageId: '<m' + n + '@example.test>', ReceivedDateTime: at(h), ParentFolderId: WK.inbox }, extra || {}));

describe('folder resolution', () => {
  it('FR-2.1 folder resolution: well-known, nested Parent/Child, not-found, 404 re-resolve', async () => {
    let n404 = 0;
    const x = world({ msgs: [], folders: [restFolder({ Id: 'F-FLEET', DisplayName: 'Fleet', ChildFolderCount: 1 })], children: { 'F-FLEET': [restFolder({ Id: 'F-SHOPS', DisplayName: 'Shops' })] } },
      [{ method: 'GET', re: /\/mailfolders\/F-FLAKY\/childfolders/, respond: () => (++n404 === 1 ? { status: 404 } : { status: 200, json: { value: [] } }) }]);
    expect(await x.folders.resolve('inbox')).toBe(WK.inbox);
    expect(await x.folders.resolve('Sent Items')).toBe(WK.sentitems);
    expect(await x.folders.resolve('Junk')).toBe(WK.junkemail);
    expect(await x.folders.resolve('Fleet/Shops')).toBe('F-SHOPS');
    expect(await x.folders.resolve(' fleet / SHOPS ')).toBe('F-SHOPS');
    expect(await x.folders.resolve('Shops')).toBe('F-SHOPS');                    // single segment: breadth-first
    expect(await x.folders.resolve('Nope')).toBe('not-found');
    expect(await x.folders.resolve('Fleet/Nope')).toBe('not-found');
    expect(x.folders.labelOf('F-SHOPS')).toBe('Fleet/Shops');
    const before = x.fn.calls.length;
    await x.folders.resolve('Fleet/Shops');
    expect(x.fn.calls.length).toBe(before);                                    // cached
    x.folders.invalidate('Fleet/Shops');
    await x.folders.resolve('Fleet/Shops');
    expect(x.fn.calls.length).toBeGreaterThan(before);
    // a 404 during resolution resolves once more
    const y = world({ msgs: [], folders: [restFolder({ Id: 'F-FLAKY', DisplayName: 'Flaky', ChildFolderCount: 1 })] });
    y.fn.routes.unshift({ method: 'GET', re: /\/mailfolders\/F-FLAKY\/childfolders/, respond: () => (++n404 === 1 ? { status: 404 } : { status: 200, json: { value: [restFolder({ Id: 'F-SUB', DisplayName: 'Sub' })] } }) });
    expect(await y.folders.resolve('Flaky/Sub')).toBe('F-SUB');
    // a not-found folder is reported like the DOM reader does
    const h = await harness(world({ msgs: [] }), ['Nope'], { max: 3 });
    expect(h.r.folders[0].status).toBe('not-found');
  });
});

describe('fairness and cursors', () => {
  it('AC-6 3 folders with max=9 get their quota in rotated order, spill goes to fuller folders', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' }); const fB = restFolder({ Id: 'F-B', DisplayName: 'B' }); const fC = restFolder({ Id: 'F-C', DisplayName: 'C' });
    const msgs = [inbox(1, 1, { ParentFolderId: 'F-A' })];
    for (let i = 0; i < 6; i++) msgs.push(inbox(10 + i, 1 + i, { ParentFolderId: 'F-B' }), inbox(20 + i, 1 + i, { ParentFolderId: 'F-C' }));
    const x = world({ msgs, folders: [fA, fB, fC] });
    const h = await harness(x, ['A', 'B', 'C'], { max: 9, rotation: 1 });
    const firstList = x.fn.calls.filter((c) => /\/mailfolders\/F-[ABC]\/messages/.test(c.decoded)).map((c) => /F-([ABC])/.exec(c.decoded)[1]);
    expect(firstList.slice(0, 3)).toEqual(['B', 'C', 'A']);                   // rotated order
    const by = Object.fromEntries(h.r.folders.map((f) => [f.folder, f.ingested]));
    expect(by).toEqual({ A: 1, B: 4, C: 4 });                                 // quota 3 each, 2 spill to the fuller folders
    expect(h.r.ok).toBe(true);
    expect(h.r.ingested).toBe(9);
  });

  it('FR-2.2 the first scan seeds newest-first and later scans back-fill to the lookback horizon', async () => {
    const msgs = [];
    for (let i = 0; i < 8; i++) msgs.push(inbox(i, 2 + i * 10));               // 2 h .. 72 h old
    msgs.push(inbox(99, 24 * 20));                                            // past the 14-day horizon
    const x = world({ msgs });
    const s1 = await harness(x, ['Inbox'], { max: 3 });
    expect(s1.caps.map((c) => c.itemId)).toEqual(['M0', 'M1', 'M2']);          // newest first
    expect(s1.cursors.Inbox).toMatchObject({ v: 1, folderId: WK.inbox, wm: new Date(Date.parse(at(2))).toISOString(), backfillBefore: new Date(Date.parse(at(22))).toISOString() });
    expect(s1.r.folders[0]).toMatchObject({ status: 'skipped-budget', backlog: true });
    const known = s1.caps.map((c) => c.keySeed);
    const s2 = await harness(x, ['Inbox'], { max: 3, cursors: s1.cursors, known });
    expect(s2.caps.map((c) => c.itemId)).toEqual(['M3', 'M4', 'M5']);
    const s3 = await harness(x, ['Inbox'], { max: 3, cursors: s2.cursors, known: known.concat(s2.caps.map((c) => c.keySeed)) });
    expect(s3.caps.map((c) => c.itemId)).toEqual(['M6', 'M7']);
    expect(s3.cursors.Inbox.backfillBefore).toBeNull();
    expect(s3.r.folders[0]).toMatchObject({ status: 'ok', caughtUp: true, backlog: false });
    expect([...s1.caps, ...s2.caps, ...s3.caps].some((c) => c.itemId === 'M99')).toBe(false);
  });

  it('AC-7 the second scan requests ge watermark, skips wmIds, advances only after commit', async () => {
    const msgs = [inbox(1, 5), inbox(2, 3)];
    const x = world({ msgs });
    const s1 = await harness(x, ['Inbox'], { max: 3 });
    expect(s1.order).toEqual(['batch:Inbox', 'cursor:Inbox']);
    const wm = s1.cursors.Inbox.wm;
    msgs.push(inbox(3, 1));
    x.fn.calls.length = 0;
    const s2 = await harness(x, ['Inbox'], { max: 3, cursors: s1.cursors, known: s1.caps.map((c) => c.keySeed) });
    const list = x.fn.calls.find((c) => /mailfolders\/FOLDER-INBOX\/messages/.test(c.decoded));
    expect(list.decoded).toContain('$filter=ReceivedDateTime ge ' + wm);
    expect(list.decoded).toContain('$orderby=ReceivedDateTime asc');
    expect(s2.caps.map((c) => c.itemId)).toEqual(['M3']);                      // M2 (at wm, in wmIds) skipped
    expect(s2.cursors.Inbox.wm).toBe(new Date(Date.parse(at(1))).toISOString());
    // a failed commit never advances the cursor
    msgs.push(inbox(4, 0.5));
    const s3 = await harness(x, ['Inbox'], { max: 3, cursors: s2.cursors, known: [], failBatch: true }).catch((e) => e);
    expect(s3).toBeInstanceOf(Error);
  });

  it('an InefficientFilter on an ordered list falls back to an unordered query and remembers orderby:false', async () => {
    const msgs = [inbox(1, 5), inbox(2, 3)];
    const x = world({ msgs });
    const s1 = await harness(x, ['Inbox'], { max: 3 });
    msgs.push(inbox(3, 1));
    const y = world({ msgs, listOrderby: false });
    const s2 = await harness(y, ['Inbox'], { max: 3, cursors: s1.cursors, known: s1.caps.map((c) => c.keySeed) });
    expect(s2.caps.map((c) => c.itemId)).toEqual(['M3']);
    expect(s2.cursors.Inbox.orderby).toBe(false);
    expect(y.fn.calls.filter((c) => /mailfolders\/FOLDER-INBOX\/messages/.test(c.decoded)).map((c) => /\$orderby/.test(c.decoded))).toEqual([true, false]);
  });

  it('R4-L11 two consecutive reads with persisted cursors advance the rotation', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' }); const fB = restFolder({ Id: 'F-B', DisplayName: 'B' });
    const x = world({ msgs: [inbox(1, 1, { ParentFolderId: 'F-A' }), inbox(2, 1, { ParentFolderId: 'F-B' })], folders: [fA, fB] });
    const first = (calls) => /F-([AB])\/messages/.exec(calls.find((c) => /F-[AB]\/messages/.test(c.decoded)).decoded)[1];
    let rotation = 0;
    const s1 = await harness(x, ['A', 'B'], { max: 6, rotation });
    const f1 = first(x.fn.calls);
    rotation = fp.nextRotation(rotation, 2);
    x.fn.calls.length = 0;
    await harness(x, ['A', 'B'], { max: 6, rotation, cursors: s1.cursors, known: s1.caps.map((c) => c.keySeed) });
    expect(first(x.fn.calls)).not.toBe(f1);
  });

  it('R4-L8 the reader follows nextLinks in both the OData key form and the casing form', async () => {
    const msgs = [inbox(1, 3), inbox(2, 2), inbox(3, 1)];
    const first = { value: [msgs[0]].map((m) => ({ Id: m.Id, ConversationId: m.ConversationId, InternetMessageId: m.InternetMessageId, ReceivedDateTime: m.ReceivedDateTime })),
      '@odata.nextLink': "https://outlook.office.com/api/v2.0/me/MailFolders('FOLDER-INBOX')/messages/?%24skip=1" };
    const second = { value: [msgs[1]].map((m) => ({ Id: m.Id, ConversationId: m.ConversationId, InternetMessageId: m.InternetMessageId, ReceivedDateTime: m.ReceivedDateTime })),
      '@odata.nextLink': 'https://outlook.office.com/api/v2.0/Me/Messages?%24skip=2' };
    const third = { value: [msgs[2]].map((m) => ({ Id: m.Id, ConversationId: m.ConversationId, InternetMessageId: m.InternetMessageId, ReceivedDateTime: m.ReceivedDateTime })) };
    const x = world({ msgs }, [
      { method: 'GET', re: /MailFolders\('FOLDER-INBOX'\)\/messages\/\?\$skip=1/, respond: () => ({ status: 200, json: second }) },
      { method: 'GET', re: /\/Me\/Messages\?\$skip=2/, respond: () => ({ status: 200, json: third }) },
      { method: 'GET', re: /mailfolders\/FOLDER-INBOX\/messages\?\$filter=ReceivedDateTime ge/, respond: () => ({ status: 200, json: first }) },
    ]);
    const cursors = { Inbox: { v: 1, folderId: WK.inbox, wm: '2026-11-01T00:00:00.000Z', wmIds: [], backfillBefore: null, horizon: '2026-10-24T12:00:00.000Z', orderby: true } };
    const h = await harness(x, ['Inbox'], { max: 9, cursors });
    expect(h.caps.map((c) => c.itemId).sort()).toEqual(['M1', 'M2', 'M3']);
    expect(x.fn.calls.every((c) => c.host === 'outlook.cloud.microsoft')).toBe(true);
  });

  it('a nextLink on a foreign host stops paging with hasMore and keeps the committed prefix', async () => {
    const m = inbox(1, 3);
    const x = world({ msgs: [m] }, [{ method: 'GET', re: /mailfolders\/FOLDER-INBOX\/messages\?\$filter=ReceivedDateTime ge/, respond: () => ({ status: 200, json: {
      value: [{ Id: m.Id, ConversationId: m.ConversationId, InternetMessageId: m.InternetMessageId, ReceivedDateTime: m.ReceivedDateTime }], '@odata.nextLink': 'https://evil.example.test/api/v2.0/me/messages?$skip=1' } }) }]);
    const cursors = { Inbox: { v: 1, folderId: WK.inbox, wm: '2026-11-01T00:00:00.000Z', wmIds: [], backfillBefore: null, horizon: 'x', orderby: true } };
    const h = await harness(x, ['Inbox'], { max: 9, cursors });
    expect(h.caps.map((c) => c.itemId)).toEqual(['M1']);
    expect(h.r.folders[0]).toMatchObject({ backlog: true, caughtUp: false });
    expect(h.cursors.Inbox.wm).toBe(new Date(Date.parse(m.ReceivedDateTime)).toISOString());
    expect(x.fn.calls.some((c) => c.host !== 'outlook.cloud.microsoft')).toBe(false);
  });
});

describe('conversation context', () => {
  it('AC-10 conversation context captures the unknown members, max 10, newest isLatest', async () => {
    const members = [];
    for (let i = 0; i < 13; i++) members.push(restMessage({ Id: 'C' + i, ConversationId: 'CONV-BIG', InternetMessageId: '<c' + i + '@example.test>', ReceivedDateTime: at(40 - i), ParentFolderId: i % 4 === 0 ? WK.sentitems : WK.inbox }));
    const x = world({ msgs: members });
    const known = ['imid:<c11@example.test>'];
    const h = await harness(x, ['Inbox'], { max: 3, known });
    const g = h.groups.find((it) => it.captures.some((c) => c.itemId === 'C12'));
    expect(g).toBeTruthy();
    const ids = g.captures.map((c) => c.itemId);
    expect(ids).toEqual(['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C12']);   // newest 10, known C11 skipped
    expect(g.captures.filter((c) => c.isLatest).map((c) => c.itemId)).toEqual(['C12']);
    expect(g.captures.every((c) => c.threadContextIncomplete === true)).toBe(true);
    expect(g.captures.find((c) => c.itemId === 'C4').folder).toBe('Inbox');
    expect(h.groups.length).toBe(1);                                                // one conversation = one budget unit
  });

  it('AC-10a the filter-first ordered conversation query, with a bounded client sort fallback', async () => {
    const x = world({ msgs: [inbox(1, 2)] });
    await harness(x, ['Inbox'], { max: 3 });
    const q = x.fn.calls.find((c) => /\/me\/messages\?/.test(c.decoded));
    const p = new URLSearchParams(q.path.split('?')[1]);
    expect(p.get('$filter')).toBe("ReceivedDateTime ge 1900-01-01T00:00:00Z and ConversationId eq 'CONV-1'");
    expect(p.get('$orderby')).toBe('ReceivedDateTime desc');
    expect(p.get('$top')).toBe('11');
    // fallback: 30 members, ordered query rejected, served out of order over 2 pages
    const many = [];
    for (let i = 0; i < 30; i++) many.push(restMessage({ Id: 'Z' + i, ConversationId: 'CONV-Z', InternetMessageId: '<z' + i + '@example.test>', ReceivedDateTime: at(100 - i), ParentFolderId: i === 29 ? WK.sentitems : WK.inbox }));
    const old = many[0];
    const other = inbox(2, 50);
    const y = world({ msgs: many.concat([other]), convOrderby: false, shuffle: (l) => l.slice().reverse().sort((a, b) => (a.Id.length - b.Id.length) || a.Id.localeCompare(b.Id)) });
    const cursors = { Inbox: { v: 1, folderId: WK.inbox, wm: new Date(Date.parse(old.ReceivedDateTime)).toISOString(), wmIds: [], backfillBefore: null, horizon: 'x', orderby: true } };
    const h = await harness(y, ['Inbox'], { max: 9, cursors, extra: { lookbackDays: 30 } });
    const g = h.groups.find((it) => it.captures.some((c) => c.itemId === 'Z29'));
    const ids = g.captures.map((c) => c.itemId);
    expect(ids[0]).toBe('Z0');                                                      // the listed (old) item stays in the context
    expect(ids.slice(1)).toEqual(['Z21', 'Z22', 'Z23', 'Z24', 'Z25', 'Z26', 'Z27', 'Z28', 'Z29']);
    expect(g.captures.find((c) => c.isLatest).itemId).toBe('Z29');
    expect(g.captures.find((c) => c.itemId === 'Z29').folder).toBe('Inbox');      // Sent Items not resolved: scanned label
    const convCalls = y.fn.calls.filter((c) => /\/me\/messages\?/.test(c.decoded));
    expect(convCalls.filter((c) => /\$orderby/.test(c.decoded))).toHaveLength(1);  // the second group skipped the ordered attempt
    expect(convCalls.filter((c) => /CONV-Z/.test(c.decoded) && !/\$orderby/.test(c.decoded))).toHaveLength(2);   // first page + 1 nextLink
  });

  it('R4-L10 a deleted newest conversation member is dropped and is not isLatest', async () => {
    const a = inbox(1, 5);
    const del = restMessage({ Id: 'DEL', ConversationId: conv(1), InternetMessageId: '<del@example.test>', ReceivedDateTime: at(1), ParentFolderId: WK.deleteditems });
    const x = world({ msgs: [a, del] });
    const h = await harness(x, ['Inbox'], { max: 3 });
    expect(h.caps.map((c) => c.itemId)).toEqual(['M1']);
    expect(h.caps[0].isLatest).toBe(true);
  });

  it('R4-L10 a junk member is kept when junkemail is a configured scan folder', async () => {
    const a = inbox(1, 5);
    const junk = restMessage({ Id: 'JNK', ConversationId: conv(1), InternetMessageId: '<jnk@example.test>', ReceivedDateTime: at(1), ParentFolderId: WK.junkemail });
    const x = world({ msgs: [a, junk] });
    const h = await harness(x, ['Inbox', 'Junk Email'], { max: 6 });
    const ids = h.caps.map((c) => c.itemId).sort();
    expect(ids).toEqual(['JNK', 'M1']);
    expect(h.caps.find((c) => c.isLatest).itemId).toBe('JNK');
    const y = world({ msgs: [inbox(1, 5), Object.assign({}, junk)] });
    const h2 = await harness(y, ['Inbox'], { max: 3 });
    expect(h2.caps.map((c) => c.itemId)).toEqual(['M1']);
  });

  it('a too-large message falls back to the lite GET and is captured preview-only', async () => {
    const x = world({ msgs: [inbox(1, 2)], tooLarge: ['M1'] });
    const h = await harness(x, ['Inbox'], { max: 3 });
    expect(h.caps[0]).toMatchObject({ itemId: 'M1', bodyStatus: 'preview-only', bodySource: 'api-preview' });
  });
});

describe('errors and the result flags', () => {
  it('AC-5 three throttled attempts fail THROTTLED and the folder is partial', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' });
    const x = world({ msgs: [inbox(1, 1, { ParentFolderId: 'F-A' }), inbox(2, 1)], folders: [fA], failFolder: { 'F-A': { status: 429 } } });
    const h = await harness(x, ['A', 'Inbox'], { max: 6 });
    const a = h.r.folders.find((f) => f.folder === 'A');
    expect(a).toMatchObject({ status: 'partial', error: 'throttled' });
    expect(x.fn.calls.filter((c) => /F-A\/messages/.test(c.decoded))).toHaveLength(3);
    expect(h.r.folders.find((f) => f.folder === 'Inbox').status).toBe('ok');      // the next folder still read
    expect(h.r.ok).toBe(true);
  });

  it('ok rules: one folder http-500 + one ok -> ok; token unavailable -> not ok with api-token-unavailable', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' });
    const x = world({ msgs: [inbox(2, 1)], folders: [fA], failFolder: { 'F-A': { status: 500 } } });
    const h = await harness(x, ['A', 'Inbox'], { max: 6 });
    expect(h.r.folders.find((f) => f.folder === 'A')).toMatchObject({ status: 'error', error: 'http-500' });
    expect(h.r).toMatchObject({ ok: true, authBlocked: false, error: null });
    const E = require('../src/email-intel/transport/errors');
    const fn = createFakeNet(mailboxRoutes({ msgs: [] }));
    const http = createHttp({ electron: fn.electron, tokens: fakeTokens({ getAuthError: () => new E.TokenUnavailableError('timeout') }), owaRe, sleep: noSleep });
    const t = await harness({ fn, transport: { http, folders: createFolderResolver({ http, owaRe }), owaRe } }, ['Inbox'], { max: 3 });
    expect(t.r).toMatchObject({ ok: false, authBlocked: false, error: 'api-token-unavailable' });
  });

  it('an auth block keeps committed batches, stops the read and leaves later folders not reached', async () => {
    const fA = restFolder({ Id: 'F-A', DisplayName: 'A' });
    const x = world({ msgs: [inbox(1, 2), inbox(2, 1, { ParentFolderId: 'F-A' })], folders: [fA], failFolder: { 'F-A': { status: 401 } } });
    const h = await harness(x, ['Inbox', 'A', 'B'], { max: 9 });
    expect(h.caps.map((c) => c.itemId)).toEqual(['M1']);
    expect(h.r).toMatchObject({ ok: false, authBlocked: true });
    expect(h.r.folders.map((f) => f.status)).toEqual(['ok', 'partial', 'not-reached']);
  });
});
