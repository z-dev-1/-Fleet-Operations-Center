// tests/email-api-endpoints.test.js — transport/endpoints.js: builders, OData escaping, allow-list, bearer
// source ranking and nextLink rebasing (design 4.2; FR-1.2, R4-L8). Pure.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ep = require('../src/email-intel/transport/endpoints');
const { TC } = require('../src/email-intel/transport/constants');
const { RequestRefusedError } = require('../src/email-intel/transport/errors');
const { OUTLOOK_HOST_RE } = require('../src/scrapers/owa-mailer');

const dec = (p) => decodeURIComponent(p);
const q = (p, k) => new URLSearchParams(p.split('?')[1]).get(k);

describe('builders', () => {
  it('encode ids, double quotes in OData strings and keep timestamps unquoted', () => {
    expect(ep.message('A/B=+')).toBe('/api/v2.0/me/messages/' + encodeURIComponent('A/B=+') + '?$select=' + encodeURIComponent(ep.SELECT_FULL));
    expect(ep.odataString("O'Brien")).toBe("'O''Brien'");
    expect(q(ep.sentBySubject("RE: O'Brien", TC.SENT_TOP), '$filter')).toBe("Subject eq 'RE: O''Brien'");
    expect(q(ep.listForward('F1', '2026-11-07T08:00:00.000Z', true), '$filter')).toBe('ReceivedDateTime ge 2026-11-07T08:00:00.000Z');
    expect(q(ep.listForward('F1', '2026-11-07T08:00:00Z', true), '$orderby')).toBe('ReceivedDateTime asc');
    expect(q(ep.listForward('F1', '2026-11-07T08:00:00Z', false), '$orderby')).toBeNull();
    expect(q(ep.listSeed('F1', 9), '$orderby')).toBe('ReceivedDateTime desc');
    expect(q(ep.listBackfill('F1', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', true), '$filter')).toBe('ReceivedDateTime ge 2026-10-01T00:00:00Z and ReceivedDateTime lt 2026-11-01T00:00:00Z');
  });

  it('the conversation query is filter-first with $orderby and $top=11; the fallback is unordered', () => {
    const p = ep.conversation("C'1", true);
    expect(q(p, '$filter')).toBe("ReceivedDateTime ge 1900-01-01T00:00:00Z and ConversationId eq 'C''1'");
    expect(q(p, '$orderby')).toBe('ReceivedDateTime desc');
    expect(q(p, '$top')).toBe('11');
    const f = ep.conversation('C1', false);
    expect(q(f, '$orderby')).toBeNull();
    expect(q(f, '$top')).toBe(String(TC.CONVERSATION_TOP));
  });

  it('refuses bad timestamps, bad page sizes and bad ids', () => {
    expect(() => ep.listForward('F', '2026-11-07 08:00', true)).toThrow(RequestRefusedError);
    expect(() => ep.listForward('F', "2026-11-07T08:00:00Z' or 1 eq 1", true)).toThrow(RequestRefusedError);
    expect(() => ep.sentByConversation('C', 25)).toThrow(RequestRefusedError);
    expect(() => ep.sentBySubject('S', 10)).not.toThrow();
    expect(() => ep.message('')).toThrow(RequestRefusedError);
    expect(() => ep.message('x'.repeat(513))).toThrow(RequestRefusedError);
    expect(() => ep.wellKnown('root')).toThrow(RequestRefusedError);
  });

  it('every builder output passes the allow-list for its method', () => {
    for (const p of [ep.folders(), ep.childFolders('F'), ep.wellKnown('inbox'), ep.listSeed('F', 5), ep.message('M'), ep.attachments('M'), ep.attachment('M', 'A'),
      ep.byInternetMessageId('<a@example.test>'), ep.sentByInternetMessageId('<a@example.test>'), ep.probe(), ep.draft('D', true), ep.folderConversation('F', 'C')]) {
      expect(ep.assertAllowed('GET', p)).toBe(true);
    }
    expect(ep.assertAllowed('POST', ep.sendMail())).toBe(true);
    expect(ep.assertAllowed('POST', ep.createReply('M', false))).toBe(true);
    expect(ep.assertAllowed('POST', ep.createReply('M', true))).toBe(true);
    expect(ep.assertAllowed('POST', ep.sendDraft('D'))).toBe(true);
    expect(ep.assertAllowed('POST', ep.move('M'))).toBe(true);
    expect(ep.assertAllowed('PATCH', ep.draft('D'))).toBe(true);
    expect(ep.assertAllowed('DELETE', ep.draft('D'))).toBe(true);
  });
});

describe('allow-list', () => {
  it('FR-1.2 assertAllowed refuses /api/beta, /owa/, a foreign host and http', () => {
    for (const p of ['/api/beta/me/messages', '/owa/service.svc?action=GetItem', '/api/v2.0/users/x/messages', '/api/v1.0/me/messages', '/ews/exchange.asmx', '/api/v2.0/me/../beta/messages']) {
      expect(() => ep.assertAllowed('GET', p), p).toThrow(RequestRefusedError);
    }
    expect(() => ep.assertAllowed('GET', 'https://evil.example.test/api/v2.0/me/messages')).toThrow(RequestRefusedError);
    expect(ep.rebaseNextLink('https://evil.example.test/api/v2.0/me/messages?$skip=50', OUTLOOK_HOST_RE)).toBeNull();
    expect(ep.rebaseNextLink('http://outlook.office.com/api/v2.0/me/messages?$skip=50', OUTLOOK_HOST_RE)).toBeNull();
    expect(ep.rebaseNextLink('https://outlook.office.com.evil.example.test/api/v2.0/me/messages', OUTLOOK_HOST_RE)).toBeNull();
    expect(ep.rebaseNextLink('https://outlook.office.com/api/beta/me/messages', OUTLOOK_HOST_RE)).toBeNull();
    expect(ep.API_HOST).toBe('outlook.cloud.microsoft');
  });

  it("R4-L8 GET assertAllowed accepts MailFolders('id')/messages/?%24skip=50", () => {
    expect(ep.assertAllowed('GET', "/api/v2.0/me/MailFolders('AAMkFOLDER=')/messages/?%24skip=50")).toBe(true);
    expect(ep.rebaseNextLink("https://outlook.office.com/api/v2.0/me/MailFolders('AAMkFOLDER=')/messages/?%24skip=50", OUTLOOK_HOST_RE))
      .toBe("/api/v2.0/me/MailFolders('AAMkFOLDER=')/messages/?%24skip=50");
    expect(() => ep.assertAllowed('GET', "/api/v2.0/me/MailFolders('a/b')/messages")).toThrow(RequestRefusedError);
  });

  it('R4-L8 GET assertAllowed accepts Me/Messages casing', () => {
    expect(ep.assertAllowed('GET', '/api/v2.0/Me/Messages?$skip=10')).toBe(true);
    expect(ep.rebaseNextLink('https://outlook.cloud.microsoft/api/v2.0/Me/Messages?%24top=10&%24skip=10', OUTLOOK_HOST_RE)).toBe('/api/v2.0/Me/Messages?%24top=10&%24skip=10');
  });

  it('R4-L8 POST, PATCH and DELETE paths stay strict and API_HOST only', () => {
    expect(() => ep.assertAllowed('POST', '/api/v2.0/Me/SendMail')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('POST', "/api/v2.0/me/messages('X')/send")).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('POST', '/api/v2.0/me/sendmail?x=1')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('POST', '/api/v2.0/me/messages/X/forward')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('POST', '/api/v2.0/me/messages/X/delete')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('PATCH', '/api/v2.0/me/messages/X/attachments')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('DELETE', '/api/v2.0/me/mailfolders/F')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('DELETE', '/api/v2.0/me/messages/X?$select=Id')).toThrow(RequestRefusedError);
    expect(() => ep.assertAllowed('PUT', ep.draft('D'))).toThrow(RequestRefusedError);
    // a nextLink is only ever a GET path on an Outlook host, rebased onto API_HOST
    expect(ep.rebaseNextLink('https://login.microsoftonline.com/api/v2.0/me/messages', OUTLOOK_HOST_RE)).toBeNull();
  });
});

describe('bearer source ranking and nextLink rebasing', () => {
  it('authSourceRank 3 / 2 / 1 / 0', () => {
    expect(ep.authSourceRank('https://outlook.cloud.microsoft/api/v2.0/me/messages')).toBe(3);
    expect(ep.authSourceRank('https://outlook.cloud.microsoft/api/beta/me/x')).toBe(2);
    expect(ep.authSourceRank('https://outlook.cloud.microsoft/owa/startupdata.ashx')).toBe(1);
    expect(ep.authSourceRank('https://outlook.cloud.microsoft/mail/')).toBe(0);
    expect(ep.authSourceRank('https://outlook.office.com/api/v2.0/me/messages')).toBe(0);
    expect(ep.authSourceRank('not a url')).toBe(0);
  });

  it('rebaseNextLink rebases an Outlook host onto a path', () => {
    expect(ep.rebaseNextLink('https://outlook.office.com/api/v2.0/me/mailfolders/F/messages?%24skip=50', OUTLOOK_HOST_RE)).toBe('/api/v2.0/me/mailfolders/F/messages?%24skip=50');
    expect(ep.rebaseNextLink('https://outlook.office365.com/api/v2.0/me/messages?%24skip=5', OUTLOOK_HOST_RE)).toBe('/api/v2.0/me/messages?%24skip=5');
    expect(ep.rebaseNextLink('garbage', OUTLOOK_HOST_RE)).toBeNull();
  });
});
