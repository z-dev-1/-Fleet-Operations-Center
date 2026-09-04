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

// Run the generated Sent-Items check script against a fake DOM. The script is a
// self-contained IIFE string, so we can eval it with a minimal document stub to
// prove the matching logic — this is the exact code that runs in the OWA page.
function runSentItemsCheck({ marker, normSubject, recipients, bodyText, rows, attrNodes }) {
  const script = owa._buildSentItemsCheckScript(marker, normSubject, recipients);
  const fakeDoc = {
    body: { innerText: bodyText || '' },
    querySelectorAll(sel) {
      if (sel.indexOf('[title]') !== -1 && sel.indexOf('listitem') === -1) {
        return (attrNodes || []).map(a => ({ getAttribute: (k) => a[k] || '' }));
      }
      return (rows || []).map(r => ({ innerText: r, getAttribute: () => '' }));
    },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'return ' + script);
  return fn(fakeDoc);
}

describe('Sent-Items verification matching (the delivery-uncertain fix)', () => {
  const marker = 'FOC-abc123def45678';
  // The caller passes normalizeSubject(subject); the real subject uses an
  // em-dash: "Fleet Status TUZR — SOS AM". Use that same normalized form here.
  const subj = owa.normalizeSubject('Fleet Status TUZR — SOS AM');
  const recips = ['ops@amazon.com'];

  it('matches the just-sent message at the top of Sent Items by subject', () => {
    const r = runSentItemsCheck({ marker, normSubject: subj, recipients: recips,
      rows: ['Fleet Status TUZR — SOS AM  ops@amazon.com  9:07 AM', 'Some older email  yesterday'] });
    expect(r.indexOf('found')).toBe(0);
  });
  it('matches even when OWA truncates the subject in the list row', () => {
    const r = runSentItemsCheck({ marker, normSubject: subj, recipients: recips,
      rows: ['Fleet Status TUZR — S\u2026', 'unrelated'] });
    expect(r.indexOf('found')).toBe(0);
  });
  it('reports subject+recipient when a recipient token is visible', () => {
    const r = runSentItemsCheck({ marker, normSubject: subj, recipients: recips,
      rows: ['Fleet Status TUZR — SOS AM to ops@amazon.com'] });
    expect(r).toBe('found:subject+recipient');
  });
  it('matches by hidden correlation marker if OWA surfaces it', () => {
    const r = runSentItemsCheck({ marker, normSubject: subj, recipients: recips,
      bodyText: 'reading pane ... ' + marker + ' ... end' });
    expect(r).toBe('found:marker');
  });
  it('does NOT match when the message is absent (honest not-found)', () => {
    const r = runSentItemsCheck({ marker, normSubject: subj, recipients: recips,
      rows: ['Totally different subject', 'Another unrelated one'] });
    expect(r).toBe('not-found');
  });
  it('ignores [TEST] prefix + marker noise when normalizing rows', () => {
    const r = runSentItemsCheck({ marker, normSubject: '[test] ' + subj, recipients: recips,
      rows: ['[TEST] Fleet Status TUZR — SOS AM'] });
    expect(r.indexOf('found')).toBe(0);
  });
});

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

describe('OWA host recognition — new outlook.cloud.microsoft domain (silent-SSO landing)', () => {
  it('MAILBOX_RE recognizes the migrated cloud.microsoft mailbox as a success landing', () => {
    // Live probe confirmed OWA now silently lands here after SSO completes.
    expect(owa.MAILBOX_RE.test('https://outlook.cloud.microsoft/mail/')).toBe(true);
    expect(owa.MAILBOX_RE.test('https://outlook.cloud.microsoft/mail/oauthRedirect.html#code=abc')).toBe(true);
    // Legacy hosts still recognized.
    expect(owa.MAILBOX_RE.test('https://outlook.office365.com/mail/')).toBe(true);
    expect(owa.MAILBOX_RE.test('https://outlook.office.com/mail/')).toBe(true);
  });
  it('the cloud.microsoft mailbox landing is NOT treated as an auth wall', () => {
    // The silent oauthRedirect completion is on an Outlook host, not a login host.
    expect(owa.AUTH_HOST_RE.test('https://outlook.cloud.microsoft/mail/oauthRedirect.html#code=abc')).toBe(false);
    expect(owa.MAILBOX_RE.test('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(false);
  });
  it('OUTLOOK_HOST_RE recognizes all three outlook hosts (compose-page gate)', () => {
    expect(owa.OUTLOOK_HOST_RE.test('https://outlook.cloud.microsoft/mail/deeplink/compose')).toBe(true);
    expect(owa.OUTLOOK_HOST_RE.test('https://outlook.office365.com/mail/deeplink/compose')).toBe(true);
    expect(owa.OUTLOOK_HOST_RE.test('https://login.microsoftonline.com/')).toBe(false);
  });
});

// A fake Electron whose API SHAPE matches the real one: setWindowOpenHandler
// lives on webContents (NOT on BrowserWindow). This guards the regression where
// win.setWindowOpenHandler threw "is not a function" and killed every send.
function makeFakeElectron(navUrl, scriptCalls) {
  const listeners = {};
  const wc = {
    setWindowOpenHandler() {},               // correct location (on webContents)
    on(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); },
    getURL() { return navUrl; },
    executeJavaScript: async (s) => { if (Array.isArray(scriptCalls)) scriptCalls.push(String(s)); return 'no'; },
    isDestroyed() { return false; },
  };
  function FakeWin() {
    this.webContents = wc;
    this.on = () => {};
    this.close = () => {};
    this.hide = () => {};
    this.isDestroyed = () => false;
    // loadURL lives on BrowserWindow in the real Electron API.
    this.loadURL = () => {
      // Fire the auth-wall navigation shortly after load, like real navigation.
      setTimeout(() => { (listeners['did-navigate'] || []).forEach(cb => cb({}, navUrl)); }, 5);
    };
  }
  return { BrowserWindow: FakeWin, session: { defaultSession: {} } };
}

describe('sendViaOwa window setup (regression guard)', () => {
  it('uses webContents.setWindowOpenHandler and does not throw on window setup', async () => {
    const fake = makeFakeElectron('https://login.microsoftonline.com/common/oauth2/authorize');
    // skipWarmup:true so this exercises the COMPOSE window setup directly (its
    // purpose), not the warmup window. Warmup is covered by its own tests below.
    const r = await owa.sendViaOwa({
      to: 'zilasant@amazon.com', subject: 'Fleet', html: '<html><body>' + 'x'.repeat(300) + '</body></html>',
      _electron: fake, timeoutMs: 3000, skipWarmup: true,
    });
    // The exact regression: win.setWindowOpenHandler threw "is not a function"
    // and every job failed with a 'window error'. Assert that NEVER happens —
    // window setup must succeed (any legitimate outcome is fine here).
    expect((r.errors || []).some(e => /setWindowOpenHandler|is not a function|window error/.test(e))).toBe(false);
    expect(['blocked-auth', 'failed', 'delivery-uncertain', 'sent']).toContain(r.status);
  });
});

describe('warmOwaSession — silent session warmup (auto sign-in fix)', () => {
  it('reports ok as soon as the mailbox loads (non-auth outlook host)', async () => {
    const fake = makeFakeElectron('https://outlook.office365.com/mail/');
    const r = await owa.warmOwaSession({ _electron: fake, timeoutMs: 3000, settleMs: 5 });
    expect(r.ok).toBe(true);
    expect(r.authWall).toBe(false);
  });

  it('does NOT bail immediately on a login host — waits for the SSO chain, then reports authWall only if still stuck at the deadline', async () => {
    const fake = makeFakeElectron('https://login.microsoftonline.com/common/oauth2/authorize');
    const start = Date.now();
    // Short deadline so the test is fast; the key assertion is that it did NOT
    // resolve near-instantly (which was the old bail-on-first-sight bug) and
    // ultimately reports an auth wall because the fake never leaves the login host.
    const r = await owa.warmOwaSession({ _electron: fake, timeoutMs: 800, settleMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.authWall).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(700); // waited for the deadline
  });

  it('never types credentials — only attempts the "Stay signed in?" click', async () => {
    // The fake records executeJavaScript calls; assert we only ran the stay-in
    // probe script and never any credential-filling script.
    const calls = [];
    const fake = makeFakeElectron('https://login.microsoftonline.com/common/oauth2/authorize', calls);
    await owa.warmOwaSession({ _electron: fake, timeoutMs: 800, settleMs: 5 });
    // Every executed script must be the harmless stay-in/Yes probe.
    expect(calls.every(s => /idSIButton9|Stay|Yes|Signin_Submit/i.test(s))).toBe(true);
    expect(calls.some(s => /password|type=password|value.*@/i.test(s))).toBe(false);
  });
});

describe('sendViaOwa warmup gate — honest blocked-auth when truly stuck on login', () => {
  it('returns blocked-auth (no send) when warmup cannot get past the login host', async () => {
    const fake = makeFakeElectron('https://login.microsoftonline.com/common/oauth2/authorize');
    // No skipWarmup: the warmup runs first, tries to drive the SSO chain, and
    // only after failing to reach the mailbox reports the honest auth wall — the
    // send stops with blocked-auth WITHOUT ever attempting compose/typing/click.
    const r = await owa.sendViaOwa({
      to: 'zilasant@amazon.com', subject: 'Fleet', html: '<html><body>' + 'x'.repeat(300) + '</body></html>',
      _electron: fake, timeoutMs: 3000, warmupTimeoutMs: 800,
    });
    expect(r.status).toBe('blocked-auth');
    expect(r.sentItemsMatch).toBeFalsy();
  });
});
