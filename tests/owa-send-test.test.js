// tests/owa-send-test.test.js — unit tests for the DEV-ONLY, double-env-gated LIVE self-addressed
// SEND test (src/dev/owa-send-test.js, spike findings 2026-11-07). Proves, with fakes and NO network:
//  - inert unless BOTH FLEET_OWA_PROBE_DIR and FLEET_OWA_PROBE_SEND=1 are set,
//  - the only recipient is ever the user's own address; anything else (other recipient, CC/BCC,
//    missing self address) is refused,
//  - exactly 3 sends (plain text / HTML / HTML+attachments) with the right payload shapes,
//  - the minimal PDF is valid (%PDF- header, %%EOF, a parsable xref whose offsets point at objects),
//  - no blind resend on an uncertain (timeout) result,
//  - a relaunch skips a test whose subject is already in Sent Items (no duplicate),
//  - redaction: no token/cookie/header value or raw address appears in the output or logs.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const send = require('../src/dev/owa-send-test');

const SELF = 'me@corp.test';

describe('gate — runs only with both env vars', () => {
  it('engaged() is true only when FLEET_OWA_PROBE_DIR is set AND FLEET_OWA_PROBE_SEND=1', () => {
    expect(send.engaged({})).toBe(false);
    expect(send.engaged({ FLEET_OWA_PROBE_DIR: os.tmpdir() })).toBe(false);
    expect(send.engaged({ FLEET_OWA_PROBE_SEND: '1' })).toBe(false);
    expect(send.engaged({ FLEET_OWA_PROBE_DIR: os.tmpdir(), FLEET_OWA_PROBE_SEND: '0' })).toBe(false);
    expect(send.engaged({ FLEET_OWA_PROBE_DIR: os.tmpdir(), FLEET_OWA_PROBE_SEND: '1' })).toBe(true);
  });
});

describe('recipient guard — only ever the self address', () => {
  it('buildSendPayload addresses exactly the self address, no CC/BCC', () => {
    for (const i of [0, 1, 2]) {
      const p = send.buildSendPayload(i, SELF);
      expect(p.Message.ToRecipients).toEqual([{ EmailAddress: { Address: SELF } }]);
      expect(p.Message.CcRecipients).toBeUndefined();
      expect(p.Message.BccRecipients).toBeUndefined();
      expect(p.SaveToSentItems).toBe(true);
    }
  });
  it('buildSendPayload throws on a missing/blank/invalid self address', () => {
    expect(() => send.buildSendPayload(0, '')).toThrow(/no-self-address/);
    expect(() => send.buildSendPayload(0, '   ')).toThrow(/no-self-address/);
    expect(() => send.buildSendPayload(0, 'not-an-email')).toThrow(/no-self-address/);
  });
  it('assertRecipientsAreSelf rejects any other recipient, extra recipient, CC or BCC', () => {
    const ok = send.buildSendPayload(0, SELF);
    expect(send.assertRecipientsAreSelf(ok, SELF)).toBe(true);
    const other = { Message: { ToRecipients: [{ EmailAddress: { Address: 'someone@else.test' } }] } };
    expect(() => send.assertRecipientsAreSelf(other, SELF)).toThrow(/recipient-not-self/);
    const two = { Message: { ToRecipients: [{ EmailAddress: { Address: SELF } }, { EmailAddress: { Address: SELF } }] } };
    expect(() => send.assertRecipientsAreSelf(two, SELF)).toThrow(/recipient-count-2/);
    const cc = { Message: { ToRecipients: [{ EmailAddress: { Address: SELF } }], CcRecipients: [{ EmailAddress: { Address: SELF } }] } };
    expect(() => send.assertRecipientsAreSelf(cc, SELF)).toThrow(/cc-present/);
    const bcc = { Message: { ToRecipients: [{ EmailAddress: { Address: SELF } }], BccRecipients: [{ EmailAddress: { Address: SELF } }] } };
    expect(() => send.assertRecipientsAreSelf(bcc, SELF)).toThrow(/bcc-present/);
    expect(() => send.assertRecipientsAreSelf(ok, '')).toThrow(/no-self-address/);
  });
});

describe('payload shapes — text / HTML / attachments', () => {
  it('(a) test 1 is plain text', () => {
    const p = send.buildSendPayload(0, SELF);
    expect(p.Message.Subject).toMatch(/plain text/);
    expect(p.Message.Body.ContentType).toBe('Text');
    expect(p.Message.Body.Content).toBe('test plain text');
    expect(p.Message.Attachments).toBeUndefined();
  });
  it('(b) test 2 is HTML with a heading, bold, a 2x2 table and an example.com link, no remote images', () => {
    const p = send.buildSendPayload(1, SELF);
    expect(p.Message.Body.ContentType).toBe('HTML');
    const html = p.Message.Body.Content;
    expect(html).toMatch(/<h2>/);
    expect(html).toMatch(/<b>/);
    expect(html).toMatch(/<table[\s>]/);
    expect((html.match(/<tr>/g) || []).length).toBe(3);        // header + 2 data rows = 2x2 grid
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/<img/i);                         // no remote images
    expect(p.Message.Attachments).toBeUndefined();
  });
  it('(c) test 3 is HTML plus 3+ synthetic FileAttachments (.txt, .csv, .pdf[, .png]) under 50 KB', () => {
    const p = send.buildSendPayload(2, SELF);
    expect(p.Message.Body.ContentType).toBe('HTML');
    const atts = p.Message.Attachments;
    expect(atts.length).toBeGreaterThanOrEqual(3);
    const names = atts.map((a) => a.Name);
    expect(names).toContain('foc-send-test.txt');
    expect(names).toContain('foc-send-test.csv');
    expect(names).toContain('foc-send-test.pdf');
    for (const a of atts) {
      expect(a['@odata.type']).toBe('#Microsoft.OutlookServices.FileAttachment');
      expect(typeof a.ContentBytes).toBe('string');
      expect(a._bytes).toBeUndefined();                        // internal field stripped from the request
      const bytes = Buffer.from(a.ContentBytes, 'base64').length;
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(50 * 1024);
    }
    // the CSV has a header + exactly 3 rows
    const csv = atts.find((a) => a.Name.endsWith('.csv'));
    const csvText = Buffer.from(csv.ContentBytes, 'base64').toString('utf8').trim();
    expect(csvText.split(/\r?\n/).length).toBe(4);
  });
});

describe('minimal PDF is valid', () => {
  it('starts with %PDF-, ends with %%EOF, and has a parsable xref whose offsets point at each object', () => {
    const pdf = send.buildMinimalPdf();
    expect(Buffer.isBuffer(pdf)).toBe(true);
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // startxref points at the 'xref' keyword
    const m = text.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    expect(m).toBeTruthy();
    const xrefStart = Number(m[1]);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');
    // each in-use xref entry offset lands on 'N 0 obj'
    const section = text.slice(xrefStart);
    const entryRe = /^(\d{10}) \d{5} n /gm;
    let e; let n = 0;
    while ((e = entryRe.exec(section))) {
      const off = Number(e[1]);
      expect(text.slice(off)).toMatch(new RegExp('^' + (n + 1) + ' 0 obj'));
      n++;
    }
    expect(n).toBe(4);                                         // catalog, pages, page, contents
  });
});

describe('minimal PNG is a valid PNG', () => {
  it('has the PNG signature', () => {
    const png = send.buildMinimalPng();
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});

describe('runSendTest — orchestration with a fake transport', () => {
  function fakeElectron(handler) {
    const { EventEmitter } = require('events');
    const calls = [];
    return {
      _calls: calls,
      session: { defaultSession: {} },
      net: {
        request(opts) {
          const req = new EventEmitter();
          const call = { opts, headers: {}, body: '' };
          calls.push(call);
          req.setHeader = (k, v) => { call.headers[String(k).toLowerCase()] = v; };
          req.write = (d) => { call.body += String(d); };
          req.abort = () => { req.emit('abort'); };
          req.end = () => { setTimeout(() => handler(opts, call, req), 0); };
          return req;
        },
      },
    };
  }
  function respond(req, status, json) {
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = status; res.headers = {};
    req.emit('response', res);
    if (json != null) res.emit('data', Buffer.from(JSON.stringify(json)));
    res.emit('end');
  }
  function recordingLog() { const lines = []; const p = (m) => lines.push(String(m)); return { lines, info: p, warn: p, error: p }; }

  it('refuses to send (no requests) when the self address is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-send-'));
    const electron = fakeElectron(() => {});
    const logs = recordingLog();
    const out = await send.runSendTest({ electron, dir, log: logs, selfAddress: '' });
    expect(out.ok).toBe(false);
    expect(out.refused).toBe('no-self-address');
    expect(out.recipientIsSelf).toBe(false);
    expect(electron._calls.length).toBe(0);                    // nothing hit the wire
    expect(logs.lines.some((l) => l === '[owa-probe] send done')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends exactly 3, each only to self, verifies each, and redacts the output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-send-'));
    const sentSubjects = [];
    // Handler: GET pre-check -> empty; POST -> 202; GET verify -> the item in sent items.
    const handler = (opts, call, req) => {
      if (opts.method === 'POST') { sentSubjects.push(JSON.parse(call.body).Message.Subject); respond(req, 202); return; }
      // GET: a verify/pre-check filtered by subject.
      const m = decodeURIComponent(opts.url).match(/Subject eq '([^']+)'/);
      const subj = m && m[1];
      const isSent = /sentitems/.test(opts.url);
      const alreadySent = sentSubjects.includes(subj);
      if (opts.url.includes('/attachments')) { respond(req, 200, { value: [{ Name: 'foc-send-test.pdf', ContentType: 'application/pdf', Size: 500 }, { Name: 'foc-send-test.txt', ContentType: 'text/plain', Size: 100 }, { Name: 'foc-send-test.csv', ContentType: 'text/csv', Size: 60 }] }); return; }
      if (isSent && alreadySent) { respond(req, 200, { value: [{ Id: 'id-' + subj, Subject: subj, HasAttachments: /attachments/.test(subj), Body: { ContentType: /HTML|attachments/.test(subj) ? 'HTML' : 'Text' } }] }); return; }
      respond(req, 200, { value: [] });
    };
    const electron = fakeElectron(handler);
    const logs = recordingLog();
    const headers = () => ({ authorization: 'Bearer TOKEN_SECRET', 'x-anchormailbox': SELF, cookie: 'SID=COOKIE_SECRET' });
    const out = await send.runSendTest({ electron, dir, log: logs, selfAddress: SELF, headers, verifyWindowMs: 5_000, _sleep: async () => {} });
    expect(out.ok).toBe(true);
    expect(out.sent).toBe(3);
    expect(sentSubjects.length).toBe(3);
    expect(out.results.every((r) => r.recipientIsSelf === true && r.verified === true)).toBe(true);
    // test 2 + 3 preserved HTML; test 3 reports the attachment metadata
    expect(out.results[1].bodyContentTypePreserved).toBe('HTML');
    expect(out.results[2].attachmentCount).toBe(3);
    expect(out.results[2].attachmentsObserved.map((a) => a.name)).toContain('foc-send-test.pdf');
    // every POST carried only the self recipient and the auth header (cookie never set as a header)
    for (const c of electron._calls.filter((x) => x.opts.method === 'POST')) {
      const b = JSON.parse(c.body);
      expect(b.Message.ToRecipients).toEqual([{ EmailAddress: { Address: SELF } }]);
      expect(c.headers.authorization).toBe('Bearer TOKEN_SECRET');
      expect(c.headers.cookie).toBeUndefined();                // cookies ride useSessionCookies, not a header
    }
    // redaction: no token/cookie value or raw address in the written JSON or logs
    const file = fs.readdirSync(dir).find((f) => f.startsWith('owa-probe-send-'));
    const blob = fs.readFileSync(path.join(dir, file), 'utf8') + '\n' + logs.lines.join('\n');
    expect(blob).not.toContain('TOKEN_SECRET');
    expect(blob).not.toContain('COOKIE_SECRET');
    expect(blob).not.toContain(SELF);                          // the raw self address is masked everywhere
    expect(blob).toContain('m***@corp.test');
    expect(blob).toContain('"recipientIsSelf": true');
    expect(logs.lines.some((l) => l === '[owa-probe] send done')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT resend on an uncertain (timeout) send, stops at the first failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-send-'));
    let posts = 0;
    const handler = (opts, call, req) => {
      if (opts.method === 'POST') { posts++; /* never respond -> timeout */ return; }
      respond(req, 200, { value: [] });                        // verify never finds it
    };
    const electron = fakeElectron(handler);
    const logs = recordingLog();
    const out = await send.runSendTest({ electron, dir, log: logs, selfAddress: SELF, headers: () => ({}), timeoutMs: 20, verifyWindowMs: 60, _sleep: async () => {} });
    expect(out.ok).toBe(false);
    expect(out.sent).toBe(0);
    expect(out.stoppedAt).toBe(1);
    expect(posts).toBe(1);                                      // exactly one POST — never resent
    expect(out.results[0].uncertainSend).toBe(true);
    expect(out.results[0].failed).toBe(true);
    expect(logs.lines.some((l) => l === '[owa-probe] send done')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a relaunch skips a test whose subject is already in Sent Items (no duplicate send)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-send-'));
    const alreadyLanded = send.TEST_SUBJECTS[0];               // test 1 already sent on a prior run
    const posts = [];
    const handler = (opts, call, req) => {
      if (opts.method === 'POST') { posts.push(JSON.parse(call.body).Message.Subject); respond(req, 202); return; }
      const m = decodeURIComponent(opts.url).match(/Subject eq '([^']+)'/);
      const subj = m && m[1];
      const isSent = /sentitems/.test(opts.url);
      if (opts.url.includes('/attachments')) { respond(req, 200, { value: [{ Name: 'x', ContentType: 't', Size: 1 }] }); return; }
      // test 1 is present in sent items from the start; the others appear only after this run POSTs them
      const present = isSent && (subj === alreadyLanded || posts.includes(subj));
      if (present) { respond(req, 200, { value: [{ Id: 'id', Subject: subj, HasAttachments: true, Body: { ContentType: 'HTML' } }] }); return; }
      respond(req, 200, { value: [] });
    };
    const electron = fakeElectron(handler);
    const logs = recordingLog();
    const out = await send.runSendTest({ electron, dir, log: logs, selfAddress: SELF, headers: () => ({}), verifyWindowMs: 5_000, _sleep: async () => {} });
    expect(out.ok).toBe(true);
    expect(out.skipped).toContain(1);
    expect(posts).not.toContain(alreadyLanded);                // the already-landed test was not re-sent
    expect(posts.length).toBe(2);                              // only tests 2 and 3 were sent
    expect(out.results[0].skipped).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pre-check / verify GETs filter by subject with NO $orderby (avoids 400 InefficientFilter)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-send-'));
    const posts = [];
    const handler = (opts, call, req) => {
      if (opts.method === 'POST') { posts.push(JSON.parse(call.body).Message.Subject); respond(req, 202); return; }
      if (opts.url.includes('/attachments')) { respond(req, 200, { value: [] }); return; }
      const subj = (decodeURIComponent(opts.url).match(/Subject eq '([^']+)'/) || [])[1];
      if (/sentitems/.test(opts.url) && posts.includes(subj)) { respond(req, 200, { value: [{ Id: 'id', Subject: subj, Body: { ContentType: 'HTML' } }] }); return; }
      respond(req, 200, { value: [] });
    };
    const electron = fakeElectron(handler);
    await send.runSendTest({ electron, dir, log: recordingLog(), selfAddress: SELF, headers: () => ({}), verifyWindowMs: 5_000, _sleep: async () => {} });
    const gets = electron._calls.filter((c) => c.opts.method === 'GET' && !c.opts.url.includes('/attachments'));
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) {
      const u = decodeURIComponent(g.opts.url);
      expect(u).toContain("$filter=Subject eq '");
      expect(u.toLowerCase()).not.toContain('$orderby');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, preCheck] of [
    ['returns 400', (req) => respond(req, 400, { error: { code: 'ErrorInefficientFilter' } })],
    ['returns 401', (req) => respond(req, 401, null)],
    ['times out', () => { /* never respond -> timeout */ }],
  ]) {
    it('fails closed when the pre-check ' + label + ': zero POSTs, stop with precheck-unavailable', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-send-'));
      let posts = 0;
      const handler = (opts, call, req) => {
        if (opts.method === 'POST') { posts++; respond(req, 202); return; }
        preCheck(req);
      };
      const electron = fakeElectron(handler);
      const logs = recordingLog();
      const out = await send.runSendTest({ electron, dir, log: logs, selfAddress: SELF, headers: () => ({}), timeoutMs: 20, verifyWindowMs: 60, _sleep: async () => {} });
      expect(posts).toBe(0);
      expect(out.ok).toBe(false);
      expect(out.sent).toBe(0);
      expect(out.stoppedAt).toBe(1);
      expect(out.failure.reason).toMatch(/^precheck-unavailable:/);
      expect(logs.lines.some((l) => l === '[owa-probe] send done')).toBe(true);
      expect(fs.readdirSync(dir).some((f) => f.startsWith('owa-probe-send-'))).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe('host allow-list', () => {
  it('allows only the outlook mail hosts', () => {
    expect(send.hostAllowed('outlook.cloud.microsoft')).toBe(true);
    expect(send.hostAllowed('https://outlook.office.com/api/v2.0/me/sendmail')).toBe(true);
    expect(send.hostAllowed('graph.microsoft.com')).toBe(false);
    expect(send.hostAllowed('https://evil.test/outlook.office.com')).toBe(false);
  });
});
