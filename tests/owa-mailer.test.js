// tests/owa-mailer.test.js
//
// Task #6 — OWA-only hidden background email service. Exercises the PURE
// decision logic and helpers with NO Electron and NO live mailbox:
//   - classifyOutcome: the "never fake success" decision table
//     (blocked-auth / failed / sent / delivery-uncertain)
//   - subject + recipient normalization (used for Sent-Items matching)
//   - correlation marker embedding (round-trips into the sent body)
//   - insertion script is CLIPBOARD-FREE
//
// The live BrowserWindow send + Sent-Items verify is validated in the acceptance
// checklist (Task #9), not here — no real email is sent in dev.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const owa = require('../src/scrapers/owa-mailer');

describe('classifyOutcome — never fake success', () => {
  const happy = { authWall: false, editorReady: true, insertOk: true, sendButtonEnabled: true, sendClicked: true, composeClosed: true, sentItemsFound: true };
  it('sent ONLY when send clicked AND Sent Items confirmed', () => {
    expect(owa.classifyOutcome(happy)).toBe('sent');
  });
  it('blocked-auth wins over everything', () => {
    expect(owa.classifyOutcome({ ...happy, authWall: true })).toBe('blocked-auth');
  });
  it('delivery-uncertain when clicked but Sent Items NOT found', () => {
    expect(owa.classifyOutcome({ ...happy, sentItemsFound: false })).toBe('delivery-uncertain');
  });
  it('failed when editor never ready', () => {
    expect(owa.classifyOutcome({ ...happy, editorReady: false, sentItemsFound: false })).toBe('failed');
  });
  it('failed when insertion failed', () => {
    expect(owa.classifyOutcome({ ...happy, insertOk: false, sentItemsFound: false })).toBe('failed');
  });
  it('failed when send button disabled', () => {
    expect(owa.classifyOutcome({ ...happy, sendButtonEnabled: false, sendClicked: false, sentItemsFound: false })).toBe('failed');
  });
  it('failed when send never clicked', () => {
    expect(owa.classifyOutcome({ ...happy, sendClicked: false, sentItemsFound: false })).toBe('failed');
  });
  it('failed on error before a send click', () => {
    expect(owa.classifyOutcome({ authWall: false, error: 'boom', sendClicked: false })).toBe('failed');
  });
});

describe('normalization for Sent-Items matching', () => {
  it('strips [TEST], marker, collapses whitespace, lowercases', () => {
    expect(owa.normalizeSubject('[TEST] Fleet   Report FOC-abcdef1234')).toBe('[test] fleet report');
  });
  it('normalizes recipients from Name <email> and lists', () => {
    expect(owa.normalizeRecipient('Jane Doe <Jane.Doe@AMAZON.com>')).toBe('jane.doe@amazon.com');
    expect(owa.toRecipientArray('a@x.com; B@x.com , c@x.com')).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });
});

describe('correlation marker embedding', () => {
  it('embeds a hidden marker before </body> that round-trips', () => {
    const marker = owa.genCorrelationMarker();
    const html = owa.embedMarker('<html><body><p>hi</p></body></html>', marker);
    expect(html).toContain(marker);
    expect(html).toMatch(/display:none/);
    expect(html.indexOf(marker)).toBeLessThan(html.indexOf('</body>'));
  });
  it('appends marker when no body tag', () => {
    const marker = 'FOC-deadbeef';
    expect(owa.embedMarker('<p>hi</p>', marker)).toContain(marker);
  });
});

describe('insertion is clipboard-free', () => {
  it('insert script sets innerHTML / execCommand, never uses clipboard', () => {
    const script = owa._buildInsertScript('<p>body</p>');
    expect(script).toMatch(/innerHTML|insertHTML/);
    expect(script).not.toMatch(/clipboard/i);
    expect(script).not.toMatch(/paste/i);
  });
  it('send click script targets the Send button and has a Ctrl+Enter fallback', () => {
    const s = owa._buildSendClickScript();
    expect(s).toMatch(/Send/);
    expect(s).toMatch(/ctrlKey/);            // keyboard fallback present
    expect(s).toMatch(/clicked-keyboard/);
  });
});

describe('selectors tolerate OWA markup variance', () => {
  it('editor selector has multiple contenteditable fallbacks', () => {
    expect(owa.EDITOR_SELECTOR).toMatch(/contenteditable="true"/);
    expect(owa.EDITOR_SELECTOR.split(',').length).toBeGreaterThanOrEqual(3);
  });
  it('send selector has multiple fallbacks', () => {
    expect(owa.SEND_SELECTOR.split(',').length).toBeGreaterThanOrEqual(3);
    expect(owa.SEND_SELECTOR).toMatch(/Send/);
  });
});

describe('auth host detection', () => {
  it('matches microsoft login / mfa / consent hosts', () => {
    expect(owa.AUTH_HOST_RE.test('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(true);
    expect(owa.AUTH_HOST_RE.test('https://outlook.office365.com/mail/deeplink/compose')).toBe(false);
  });
});
