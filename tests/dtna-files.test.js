// DTNA Chatter + Files: src/dtna/files.js — attachment list parsing and the guarded, authenticated PDF
// download. aura and fetch are fakes; nothing reaches the network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { freshDtna } from './fixtures/dtna/fake-electron.js';

const require = createRequire(import.meta.url);
let logger;
let files;
let C;
beforeAll(() => {
  logger = installFakeLogger(require);
  freshDtna(require);
  files = require('../src/dtna/files.js');
  C = require('../src/dtna/constants.js');
});
afterAll(() => { logger.restore(); files._setDeps({}); freshDtna(require); });
beforeEach(() => { files._setDeps({}); logger.clear(); });

const CASE_ID = '500gx000002E4U5AAK';
const V1 = '068gx000001AbCdAAK';
const V2 = '068gx000001AbCeAAK';
const D1 = '069gx000001AbCdAAK';
const APEX_CFG = {
  source: 'apex', classname: 'E2E_UTP_CommentController', method: 'getFilesOnCase', params: { caseId: '$caseId' },
  listPath: 'files', fields: { versionId: 'ContentVersionId', documentId: 'ContentDocumentId', name: 'Title', ext: 'FileExtension', size: 'ContentSize', createdAt: 'CreatedDate' },
};
const DL = { urlTemplate: 'https://dtna.my.site.com/Servicetracker/sfc/servlet.shepherd/version/download/{versionId}' };
const SENTINEL_NAME = 'SENTINEL_FILE_NAME_77';

function res(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
  const h = Object.assign({}, headers);
  return {
    status, type: 'basic',
    headers: { get: (k) => (h[k.toLowerCase()] == null ? null : String(h[k.toLowerCase()])) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}
function streamRes(chunks, headers = {}) {
  let i = 0;
  const cancel = vi.fn(async () => {});
  return {
    status: 200, type: 'basic', cancel,
    headers: { get: (k) => (headers[k.toLowerCase()] == null ? null : String(headers[k.toLowerCase()])) },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel }) },
  };
}
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 0x20)]);

describe('parseAttachmentList', () => {
  it('apex shape: listPath + field map; junk ids dropped; dedup; ext from the file name when missing', () => {
    files._setDeps({ downloadConfig: DL });
    const value = { files: [
      { ContentVersionId: V1, ContentDocumentId: D1, Title: 'Dealer estimate E101048154.pdf', ContentSize: 12345, CreatedDate: '2026-11-20T10:00:00.000Z' },
      { ContentVersionId: V2, Title: 'photo', FileExtension: 'JPG', ContentSize: 999 },
      { ContentVersionId: 'nope', Title: 'x.pdf' },
      { ContentVersionId: V1, Title: 'dup.pdf' },
      'junk',
    ] };
    expect(files.parseAttachmentList(value, APEX_CFG)).toEqual([
      { versionId: V1, documentId: D1, name: 'Dealer estimate E101048154.pdf', ext: 'pdf', size: 12345, createdAt: '2026-11-20T10:00:00.000Z' },
      { versionId: V2, documentId: '', name: 'photo', ext: 'jpg', size: 999, createdAt: '' },
    ]);
  });

  it('comments shape: reads the configured field (JSON string or array) off each raw comment row', () => {
    files._setDeps({ downloadConfig: DL });
    const cfg = { source: 'comments', field: 'Attachments', fields: { versionId: 'contentVersionId', name: 'FileName' } };
    const raw = [
      { CommentText: 'x', Attachments: JSON.stringify([{ contentVersionId: V1, FileName: 'R101048154.pdf' }]) },
      { CommentText: 'y', Attachments: [{ contentVersionId: V2, FileName: 'E1.pdf' }] },
      { CommentText: 'z' },
    ];
    expect(files.parseAttachmentList(null, cfg, raw).map((a) => a.versionId)).toEqual([V1, V2]);
  });

  it('caps the list at ATTACHMENT_LIST_MAX', () => {
    files._setDeps({ downloadConfig: DL });
    const rows = [];
    for (let i = 0; i < 80; i++) rows.push({ ContentVersionId: '068gx00000' + String(i).padStart(5, '0') + 'AAK', Title: i + '.pdf' });
    expect(files.parseAttachmentList({ files: rows }, APEX_CFG).length).toBe(C.ATTACHMENT_LIST_MAX);
  });

  it('{documentId} template: rows keyed by a valid ContentDocument id', () => {
    files._setDeps({ downloadConfig: { urlTemplate: 'https://dtna.my.site.com/Servicetracker/sfc/servlet.shepherd/document/download/{documentId}' } });
    const r = files.parseAttachmentList({ files: [{ ContentDocumentId: D1, Title: 'a.pdf' }, { ContentVersionId: V1, Title: 'b.pdf' }] }, APEX_CFG);
    expect(r.map((a) => a.documentId)).toEqual([D1]);
  });
});

describe('listAttachments', () => {
  it('shipped config is null -> DTNA_ATTACHMENTS_NOT_CONFIGURED with zero requests', async () => {
    expect(C.ATTACHMENT_LIST_READ).toBeNull();
    const aura = { listAttachmentsRaw: vi.fn() };
    files._setDeps({ aura });
    expect(await files.listAttachments(CASE_ID, [])).toEqual({ ok: false, code: 'DTNA_ATTACHMENTS_NOT_CONFIGURED' });
    expect(aura.listAttachmentsRaw).not.toHaveBeenCalled();
  });

  it('apex source -> one aura.listAttachmentsRaw read; comments source -> zero requests', async () => {
    const aura = { listAttachmentsRaw: vi.fn(async () => ({ ok: true, value: { files: [{ ContentVersionId: V1, Title: 'a.pdf' }] } })) };
    files._setDeps({ aura, listConfig: APEX_CFG, downloadConfig: DL });
    const r = await files.listAttachments(CASE_ID, [], { silent: true });
    expect(r.ok).toBe(true);
    expect(r.list.length).toBe(1);
    expect(aura.listAttachmentsRaw).toHaveBeenCalledWith(CASE_ID, { silent: true });
    aura.listAttachmentsRaw.mockClear();
    files._setDeps({ aura, listConfig: { source: 'comments', field: 'Attachments', fields: {} }, downloadConfig: DL });
    expect((await files.listAttachments(CASE_ID, [{ Attachments: [{ versionId: V1, name: 'a.pdf' }] }])).list.length).toBe(1);
    expect(aura.listAttachmentsRaw).not.toHaveBeenCalled();
    aura.listAttachmentsRaw.mockResolvedValueOnce({ ok: false, code: 'DTNA_APEX_ERROR' });
    files._setDeps({ aura, listConfig: APEX_CFG, downloadConfig: DL });
    expect(await files.listAttachments(CASE_ID, [])).toEqual({ ok: false, code: 'DTNA_APEX_ERROR' });
  });
});

describe('downloadPdf', () => {
  const ATT = { versionId: V1, name: SENTINEL_NAME + '.pdf', ext: 'pdf', size: 1000 };

  it('shipped download config is null -> DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED with zero fetches', async () => {
    expect(C.ATTACHMENT_DOWNLOAD).toBeNull();
    const fetch = vi.fn();
    files._setDeps({ fetch });
    expect(await files.downloadPdf(ATT, { caseId: CASE_ID })).toEqual({ ok: false, code: 'DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('non-PDF and declared size > 15MB are skipped with zero fetches', async () => {
    const fetch = vi.fn();
    files._setDeps({ fetch, downloadConfig: DL });
    expect((await files.downloadPdf(Object.assign({}, ATT, { ext: 'jpg', name: 'a.jpg' }))).code).toBe('DTNA_ATTACHMENT_NOT_PDF');
    expect((await files.downloadPdf(Object.assign({}, ATT, { size: C.ATTACHMENT_MAX_BYTES + 1 }))).code).toBe('DTNA_ATTACHMENT_TOO_LARGE');
    expect((await files.downloadPdf(Object.assign({}, ATT, { versionId: 'bad' }))).code).toBe('DTNA_INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a template on another host is refused with zero fetches', async () => {
    const fetch = vi.fn();
    files._setDeps({ fetch, downloadConfig: { urlTemplate: 'https://evil.example/download/{versionId}' } });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('happy path: one authenticated GET (credentials include, manual redirect) returns the bytes', async () => {
    const fetch = vi.fn(async () => res(200, PDF, { 'content-type': 'application/pdf', 'content-length': PDF.length }));
    files._setDeps({ fetch, downloadConfig: DL });
    const r = await files.downloadPdf(ATT, { caseId: CASE_ID });
    expect(r.ok).toBe(true);
    expect(Buffer.compare(r.buffer, PDF)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://dtna.my.site.com/Servicetracker/sfc/servlet.shepherd/version/download/' + V1);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'manual' });
    const t = logger.text();
    expect(t).toContain('[dtna] attachment');
    expect(t).not.toContain(SENTINEL_NAME);
    expect(t).not.toContain(V1);
    expect(t).not.toContain('servlet.shepherd');
    expect(t).not.toContain('%PDF');
  });

  it('content-length over the cap is aborted before the body is read', async () => {
    const arrayBuffer = vi.fn();
    const fetch = vi.fn(async () => Object.assign(res(200, PDF, { 'content-length': C.ATTACHMENT_MAX_BYTES + 10 }), { arrayBuffer }));
    files._setDeps({ fetch, downloadConfig: DL });
    expect((await files.downloadPdf(Object.assign({}, ATT, { size: null }))).code).toBe('DTNA_ATTACHMENT_TOO_LARGE');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('a streamed body over the cap is aborted mid-read', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const r0 = streamRes([Buffer.from('%PDF-'), big, big, big]);
    const fetch = vi.fn(async () => r0);
    files._setDeps({ fetch, downloadConfig: DL });
    expect((await files.downloadPdf(Object.assign({}, ATT, { size: null }))).code).toBe('DTNA_ATTACHMENT_TOO_LARGE');
    expect(r0.cancel).toHaveBeenCalled();
  });

  it('a body that is not a PDF (%PDF- magic) is refused', async () => {
    const fetch = vi.fn(async () => res(200, '<html>login</html>'));
    files._setDeps({ fetch, downloadConfig: DL });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_ATTACHMENT_NOT_PDF');
  });

  it('401 / a redirect to sign-in / an opaque redirect -> DTNA_SESSION_EXPIRED; other redirects -> DTNA_HTTP_ERROR', async () => {
    files._setDeps({ fetch: vi.fn(async () => res(401, '')), downloadConfig: DL });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_SESSION_EXPIRED');
    files._setDeps({ fetch: vi.fn(async () => res(302, '', { location: 'https://login.dtna.com/x' })), downloadConfig: DL });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_SESSION_EXPIRED');
    files._setDeps({ fetch: vi.fn(async () => ({ type: 'opaqueredirect', status: 0, headers: { get: () => null } })), downloadConfig: DL });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_SESSION_EXPIRED');
    files._setDeps({ fetch: vi.fn(async () => res(302, '', { location: 'https://dtna.my.site.com/x' })), downloadConfig: DL });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_HTTP_ERROR');
  });

  it('a network error -> DTNA_NETWORK, never the message', async () => {
    files._setDeps({ fetch: vi.fn(async () => { throw new Error('boom SENTINEL_MSG'); }), downloadConfig: DL });
    expect((await files.downloadPdf(ATT)).code).toBe('DTNA_NETWORK');
    expect(logger.text()).not.toContain('SENTINEL_MSG');
  });
});
