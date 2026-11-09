// tests/email-api-map.test.js — transport/map.js REST JSON -> MessageCapture (design 5.5; FR-2.4, AC-8). Pure.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { restMessage, restAttachment } from './fixtures/email-api/rest-messages.js';
const require = createRequire(import.meta.url);
const map = require('../src/email-intel/transport/map');
const identity = require('../src/email-intel/ingest/identity');
const C = require('../src/email-intel/constants');

describe('toCapture', () => {
  it('AC-8 a REST message maps to a full capture', () => {
    const m = restMessage({
      Id: 'AAMk-ID_1=', ConversationId: 'AAQk-CONV_9=', InternetMessageId: '<abc@example.test>', ReceivedDateTime: '2026-11-07T08:15:30Z', Subject: 'RE: Unit 40123',
      ToRecipients: [{ EmailAddress: { Name: 'Me Person', Address: 'ME@Example.test' } }, { EmailAddress: { Name: 'Ops', Address: 'ops@example.test' } }],
      CcRecipients: [{ EmailAddress: { Name: 'Lead', Address: 'lead@example.test' } }], ParentFolderId: 'FOLDER-INBOX', IsRead: false,
      Body: { ContentType: 'HTML', Content: '<html><body><p>Unit <b>40123</b> ready&nbsp;Friday</p><script>x()</script></body></html>' },
    });
    const cap = map.toCapture(m, { folderLabel: 'Inbox', labelOf: () => null, isLatest: true, blockIndex: 2 });
    expect(cap).toMatchObject({
      source: 'api', itemId: 'AAMk-ID_1=', keySeed: 'imid:<abc@example.test>', apiIds: { conversationId: 'AAQk-CONV_9=', internetMessageId: '<abc@example.test>' },
      convIdRaw: 'AAQk/CONV+9=', convIdSource: 'owa', conversationKey: identity.conversationKey('AAQk/CONV+9='), legacySeed: 'AAQk/CONV+9=',
      folder: 'Inbox', subject: 'RE: Unit 40123', from: { name: 'Shop Desk', address: 'shop@example.test', quality: 'ok' },
      to: [{ name: 'Me Person', address: 'me@example.test' }, { name: 'Ops', address: 'ops@example.test' }], cc: [{ name: 'Lead', address: 'lead@example.test' }],
      toCount: 2, ccCount: 1, recipientsKnown: true,
      receivedAt: '2026-11-07T08:15:30.000Z', receivedAtQuality: 'exact', receivedAtPrecision: 'minute', receivedAtRaw: '', zoneExplicit: true,
      bodyStatus: 'complete', bodySource: 'api', flags: { unread: true }, isLatest: true, blockIndex: 2, stub: false, attachments: [],
    });
    expect(cap.bodyText).toContain('Unit 40123 ready');
    expect(cap.bodyText).not.toMatch(/<b>|<script|x\(\)/);
    expect(cap.textLen).toBe(cap.bodyText.length);
  });

  it('keySeed falls back to the REST id; ParentFolderId resolves the folder label', () => {
    const cap = map.toCapture(restMessage({ Id: 'ID-2', InternetMessageId: null, ParentFolderId: 'F-SENT' }), { folderLabel: 'Inbox', labelOf: (id) => (id === 'F-SENT' ? 'Sent Items' : null) });
    expect(cap.keySeed).toBe('id:ID-2');
    expect(cap.apiIds.internetMessageId).toBeNull();
    expect(cap.folder).toBe('Sent Items');
  });

  it('a Text body is taken as is; long bodies are capped at RAW_BODY_CAP', () => {
    const long = 'word '.repeat(20_000);
    const cap = map.toCapture(restMessage({ Body: { ContentType: 'Text', Content: long } }), {});
    expect(cap.bodyStatus).toBe('truncated-cap');
    expect(cap.bodyText.length).toBe(C.RAW_BODY_CAP);
    expect(cap.truncatedAt).toBe(C.RAW_BODY_CAP);
    const pv = map.toCapture(restMessage({ BodyPreview: 'short preview' }), { preview: true });
    expect(pv).toMatchObject({ bodyStatus: 'preview-only', bodySource: 'api-preview', bodyText: '' });
  });

  it('invalid input is dropped and counted, never thrown; names and subjects are capped', () => {
    const stats = {};
    for (const bad of [null, 'x', {}, Object.assign(restMessage(), { Id: '' }), restMessage({ ReceivedDateTime: 'yesterday' }), Object.assign(restMessage(), { ConversationId: 7 })]) {
      expect(map.toCapture(bad, { stats })).toBeNull();
    }
    expect(stats.dropped).toBe(6);
    expect(map.toCapture(restMessage({ Id: 'x'.repeat(600) }), { stats })).toBeNull();
    expect(stats.badId).toBe(1);
    const cap = map.toCapture(restMessage({ Subject: 'S\u0000'.repeat(500), From: { EmailAddress: { Name: 'N'.repeat(300), Address: 'not-an-address' } } }), {});
    expect(cap.subject.length).toBe(400);
    expect(cap.subject).not.toMatch(/\u0000/);
    expect(cap.from).toEqual({ name: 'N'.repeat(120), address: null, quality: 'name-only' });
  });

  it('recipients are capped; legacyConvId maps the REST alphabet onto the EWS form', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ EmailAddress: { Name: 'P' + i, Address: 'p' + i + '@example.test' } }));
    expect(map.mapRecipients(many)).toHaveLength(C.RECIPIENTS_CAP);
    expect(map.mapRecipients('nope')).toEqual([]);
    expect(map.legacyConvId('AA-BB_CC=')).toBe('AA/BB+CC=');
    expect(map.rowSigOf('cv_1', [{ Id: 'a' }, { Id: 'b' }])).toBe(map.rowSigOf('cv_1', [{ Id: 'x' }, { Id: 'b' }]));
    expect(map.rowSigOf('cv_1', [{ Id: 'a' }])).not.toBe(map.rowSigOf('cv_1', [{ Id: 'a' }, { Id: 'b' }]));
  });

  it('attachments: inline dropped, item attachments not downloadable, HasAttachments with no list -> one placeholder', () => {
    const list = [restAttachment({ Id: 'A1', Name: 'Estimate.PDF', Size: 2048 }), restAttachment({ Id: 'A2', Name: 'logo.png', IsInline: true }),
      restAttachment({ Id: 'A3', Name: 'fwd.msg', type: '#Microsoft.OutlookServices.ItemAttachment' })];
    const a = map.mapAttachments(list, true);
    expect(a).toEqual([
      { attId: 'A1', name: 'Estimate.PDF', ext: 'pdf', sizeBytes: 2048, kind: 'document', placeholder: false, hasDownloadHandle: true, analysis: { status: 'filename-only' } },
      { attId: 'A3', name: 'fwd.msg', ext: 'msg', sizeBytes: 1000, kind: 'document', placeholder: false, hasDownloadHandle: false, analysis: { status: 'filename-only' } },
    ]);
    expect(map.mapAttachments([], true)).toEqual([{ attId: null, name: null, ext: '', sizeBytes: null, kind: 'file', placeholder: true, hasDownloadHandle: false, analysis: { status: 'filename-only' } }]);
    expect(map.mapAttachments([], false)).toEqual([]);
  });
});
