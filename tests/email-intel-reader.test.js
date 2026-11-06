// tests/email-intel-reader.test.js — the message-level OWA reader and its orchestration (design 2.2, 2.7):
// AC-2 / AC-2b folder fairness and backlog drain, F-04, F-05, AC-K / case K (auth wall mid-scan), R8.4 caps,
// NFR-9, the F-03 preview-only retry, and the read-only guarantees of the in-page scripts.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { rowDesc, rowsScenarios, inboxRows } from './fixtures/email-intel/emails.js';
import { createWorld, warmOk, noSleep, AUTH_URL } from './fixtures/email-intel/fake-owa.js';
import { makeHarness } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const ps = require('../src/email-intel/capture/page-scripts');
const cap = require('../src/email-intel/capture/owa_capture');
const fp = require('../src/email-intel/capture/folder-plan');
const C = require('../src/email-intel/constants');
const HERE = path.dirname(fileURLToPath(import.meta.url));

let h = null;
afterEach(() => { if (h) h.cleanup(); h = null; });
const uniqueOpens = (w) => new Set(w.openLog.map((o) => o.folder + '|' + o.convId));

describe('in-page scripts are syntax-valid and read-only', () => {
  const scripts = {
    wait: ps.buildWaitScript('div[role="option"]'), rows: ps.buildRowCollector({ max: 150, scrollPages: 3 }),
    open: ps.buildOpenRowScript({ convId: 'conv/a=', ariaKey: 'Dealer Subject' }), pane: ps.buildPaneCollector({ maxBlocks: 12, rawCap: 60000 }),
  };
  it('every collector compiles with new Function (async scripts included)', () => {
    for (const [k, s] of Object.entries(scripts)) expect(() => new Function(s), k).not.toThrow();
  });
  it('only the open-row script clicks anything, and it clicks the row itself (never Reply, Forward, Delete or compose)', () => {
    expect((scripts.rows.match(/\.click\(/g) || []).length).toBe(0);
    expect((scripts.pane.match(/\.click\(/g) || []).length).toBe(0);
    expect((scripts.wait.match(/\.click\(/g) || []).length).toBe(0);
    expect((scripts.open.match(/\.click\(/g) || []).length).toBe(1);
    for (const s of Object.values(scripts)) {
      expect(s).not.toMatch(/sendBtn|sendViaOwa|dispatchEvent|\.submit\(|keydown|DeleteRegular/i);
      expect(s).not.toMatch(/\bfetch\(|XMLHttpRequest|\.ashx|service\.svc|\/api\//);
    }
    expect(scripts.open).toContain('ROW_SEL');
  });
  it('R8.4 scroll and row bounds are embedded as constants (3 pages, 150 rows)', () => {
    expect(scripts.rows).toContain('MAX = 150, PAGES = 3');
    expect(ps.buildRowCollector({ max: 99999, scrollPages: 99 })).toContain('MAX = 400, PAGES = 10');   // clamped
    expect(scripts.pane).toContain('MAXB = 12');
  });
  it('the row and body selector lists include the shared reader selector and the documented fallbacks', () => {
    expect(ps.ROW_SELECTOR).toContain('div[role="option"][aria-label]');
    expect(ps.BODY_SELECTORS.join(' ')).toContain('Message body');
    expect(ps.PANE_SELECTORS.join(' ')).toContain('Reading Pane');
  });
});

describe('AC-2 / R1.6 folder fairness', () => {
  it('R1.6 busy inbox does not starve other folders; AC-2 three folders, 60 inbox rows, max 25', async () => {
    h = makeHarness(rowsScenarios.busyInbox());
    const res = await h.run({ max: 25 });
    const f = (n) => h.ck().scan.last.folders.find((x) => x.folder === n);
    expect(f('DOMO')).toMatchObject({ status: 'ok', ingested: 2, caughtUp: true, backlog: false });
    expect(f('Relay Garage')).toMatchObject({ status: 'ok', ingested: 4, caughtUp: true });
    expect(f('Inbox').ingested).toBeGreaterThan(8);                // pass 2 gave Inbox the quiet folders' unused budget
    const sum = h.ck().scan.last.folders.reduce((a, x) => a + x.ingested, 0);
    expect(sum).toBe(25);
    expect(f('Inbox')).toMatchObject({ status: 'skipped-budget', caughtUp: false, backlog: true });
    expect(f('Inbox').backlogRemaining).toBe(60 - f('Inbox').ingested);
    expect(res.intel).toMatchObject({ outcome: 'partial', partial: true });
    expect(res.readError).toBe('partial: budget');
    expect(Object.keys(h.msgs().messages)).toHaveLength(25);
  });

  it('R1.6 known rows are skipped without opening them, and the folder order rotates', async () => {
    h = makeHarness(rowsScenarios.busyInbox());
    await h.run({ max: 25 });
    const firstFolder = h.world.openLog[0].folder;
    expect(firstFolder).toBe('Inbox');
    const before = h.world.openLog.length;
    await h.run({ max: 25 });
    const second = h.world.openLog.slice(before);
    expect(second.every((o) => o.folder === 'Inbox')).toBe(true);        // DOMO and Relay Garage were fully read: nothing to open
    expect(uniqueOpens(h.world).size).toBe(h.world.openLog.length);       // no row opened twice
    expect(h.ck().rotation).toBe(2);
  });

  it('F-04 60-row inbox drains over ceil(60/q) scans; committed rows are never re-opened', async () => {
    h = makeHarness(rowsScenarios.backlogInbox());
    const q = 8; const scans = Math.ceil(60 / q);
    const inbox = () => h.ck().scan.last.folders.find((x) => x.folder === 'Inbox');
    for (let i = 1; i <= scans; i++) {
      const res = await h.run({ max: q });
      expect(inbox().ingested).toBe(i < scans ? q : 60 - q * (scans - 1));
      if (i < scans) {
        expect(inbox().caughtUp).toBe(false);                             // F-04 caughtUp stays false until drained
        expect(inbox().backlogRemaining).toBe(60 - q * i);
        expect(res.intel.outcome).toBe('partial');
      } else {
        expect(inbox()).toMatchObject({ caughtUp: true, backlog: false, backlogRemaining: 0 });
        expect(res.intel.outcome).toBe('complete');
      }
    }
    expect(uniqueOpens(h.world).size).toBe(60);
    expect(h.world.openLog).toHaveLength(60);                             // F-04 no re-open of committed rows while draining
    expect(Object.keys(h.msgs().messages)).toHaveLength(60);
  }, 30_000);

  it('F-05 second scan with no new mail opens 0 rows, even after the rows were marked read and the time token changed (NFR-9)', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 12, { time: '18:09', unread: true }) });
    await h.run({ max: 25 });
    expect(h.world.openLog).toHaveLength(12);
    // Opening marked every row read and the day rolled over: unread prefix gone, time token changed.
    h.world.folders.Inbox.rows = inboxRows('Inbox', 12, { time: 'Mon 11/2', unread: false });
    const res = await h.run({ max: 25 });
    expect(h.world.openLog).toHaveLength(12);                             // NFR-9: zero messages opened
    expect(res.intel.outcome).toBe('complete');
    expect(h.ck().scan.last.folders[0]).toMatchObject({ opened: 0, ingested: 0, skippedKnown: 8, caughtUp: true });   // stopped on 8 known rows
  });

  it('a new reply changes the row preview, so only that conversation is opened again', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 10) });
    await h.run({ max: 25 });
    const before = h.world.openLog.length;
    h.world.folders.Inbox.rows[3] = rowDesc({ i: 3, folder: 'inbox', from: 'Inbox Sender', subject: 'Status Inbox 3', preview: 'A brand new reply about unit 40123', convId: h.world.folders.Inbox.rows[3].convId });
    await h.run({ max: 25 });
    expect(h.world.openLog.slice(before)).toEqual([{ folder: 'Inbox', convId: h.world.folders.Inbox.rows[3].convId }]);
  });
});

describe('AC-K / case K: auth wall mid-scan', () => {
  it('AC-K case K auth expiry mid-scan keeps committed batches and checkpoints, reports auth-blocked with accurate per-folder statuses', async () => {
    const opensBeforeWall = 8;                                          // Inbox (6 rows) + 2 DOMO rows
    h = makeHarness(rowsScenarios.authExpiryMidScan(), {
      onExec: async (kind, n, api, world) => { if (kind === 'open' && world.openLog.length === opensBeforeWall) api.navigate(AUTH_URL); },
    });
    const res = await h.run({ max: 25 });
    expect(res.authBlocked).toBe(true);
    expect(res.readError).toBe('auth blocked');
    expect(res.intel).toMatchObject({ outcome: 'auth-blocked', partial: true });
    const folders = h.ck().scan.last.folders;
    expect(folders.map((f) => [f.folder, f.status])).toEqual([['Inbox', 'ok'], ['DOMO', 'partial'], ['Relay Garage', 'not-reached']]);
    expect(h.ck().scan.last.outcome).toBe('auth-blocked');
    expect(h.ck().scan.current).toBeNull();
    // Inbox's 6 rows were committed and checkpointed; the DOMO rows in flight (a batch below 5) were not.
    expect(Object.keys(h.ck().folders.Inbox.seenRows)).toHaveLength(6);
    expect(Object.keys(h.ck().folders.DOMO ? h.ck().folders.DOMO.seenRows : {})).toHaveLength(0);
    expect(h.ck().folders.DOMO).toMatchObject({ lastOutcome: 'partial', backlog: true });
    expect(Object.keys(h.msgs().messages)).toHaveLength(6);
    expect(h.ck().owaAuth).toMatchObject({ state: 'blocked', blockedCount: 1 });
    expect(res.emails).toHaveLength(6);                                  // committed mail is triaged and visible
    // After signing in again the next scan resumes: Inbox is known, the rest is read.
    h.world.url = 'https://outlook.office365.com/mail/inbox'; h.world.onExec = null;
    const before = h.world.openLog.length;
    const again = await h.run({ max: 25 });
    expect(again.intel.outcome).toBe('complete');
    expect(h.world.openLog.slice(before).every((o) => o.folder !== 'Inbox')).toBe(true);
    expect(Object.keys(h.msgs().messages)).toHaveLength(14);
    expect(h.ck().owaAuth).toMatchObject({ state: 'ok' });
  }, 20_000);

  it('an auth wall at warmup is reported before any window opens', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    const res = await h.run({ _warm: async () => ({ authWall: true, url: 'https://login.microsoftonline.com/x' }) });
    expect(res.authBlocked).toBe(true);
    expect(res.intel.outcome).toBe('auth-blocked');
    expect(h.world.windows).toHaveLength(0);
    expect(res.intel.partial).toBe(false);
  });

  it('a transient SSO hop (back on Outlook within the grace window) is not an auth wall', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) }, {
      onExec: async (kind, n, api, world) => { if (n === 2) { api.navigate(AUTH_URL); setTimeout(() => api.navigate('https://outlook.office365.com/mail/inbox'), 5); } },
    });
    const res = await h.run({ max: 25, authGraceMs: 400 });
    expect(res.authBlocked).toBe(false);
    expect(res.intel.outcome).toBe('complete');
    expect(Object.keys(h.msgs().messages)).toHaveLength(3);
  });
});

describe('R8.4 caps, not-found folders, abort and the F-03 preview retry', () => {
  it('R8.4 open cap: no more than caps.maxOpen messages are opened and the rest is a backlog', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 30) });
    h.stores.save('config', Object.assign(h.stores.defaults('config'), { caps: { maxEmails: 25, maxOpen: 4, aiCalls: 24, lookbackDays: 14 } }));
    const res = await h.run({ max: 25 });
    expect(h.world.openLog).toHaveLength(4);
    expect(h.ck().scan.last.folders[0]).toMatchObject({ status: 'skipped-budget', backlog: true, ingested: 4 });
    expect(res.intel.outcome).toBe('partial');
  });

  it('R8.4 raw cap: reading stops once the per-scan raw character budget is used', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 10) });
    const folders = ['Inbox'];
    const batches = [];
    const r = await cap.readMailbox({
      folders, plan: fp.planFolderBudgets({ folders, max: 25 }), checkpoints: {}, caps: { maxOpen: 40, rawCap: 120 },
      onBatch: async (f, items) => { batches.push(items.length); }, _electron: h.electron, _warm: warmOk, _sleep: noSleep, authGraceMs: 20,
    });
    expect(r.ingested).toBeLessThan(10);
    expect(r.folders[0].status).toBe('skipped-budget');
    expect(r.rawChars).toBeGreaterThanOrEqual(120);
  });

  it('a folder that cannot be selected gets one retry, then not-found; the scan is partial but still reads the others', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    const res = await h.run({ folders: ['Inbox', 'Missing Folder'], max: 25 });
    const f = h.ck().scan.last.folders;
    expect(f.find((x) => x.folder === 'Missing Folder').status).toBe('not-found');
    expect(h.world.execLog.filter((k) => k === 'folder')).toHaveLength(2);        // original click + one retry
    expect(res.intel.outcome).toBe('partial');
    expect(res.readError).toBe('partial: folder-not-found');
    expect(Object.keys(h.msgs().messages)).toHaveLength(3);
  });

  it('an abort signal ends the scan as aborted and closes the window; committed rows stay', async () => {
    const ac = new AbortController();
    h = makeHarness({ Inbox: inboxRows('Inbox', 20) }, { onExec: async (kind, n, api, world) => { if (kind === 'open' && world.openLog.length === 7) ac.abort(); } });
    const res = await h.run({ max: 25, signal: ac.signal });
    expect(res.intel.outcome).toBe('aborted');
    expect(h.world.windows[0].destroyed).toBe(true);
    expect(h.ck().scan.current).toBeNull();
    expect(Object.keys(h.msgs().messages).length).toBeGreaterThanOrEqual(5);         // the first full batch was committed
    expect(Object.keys(h.msgs().messages).length).toBeLessThan(20);
  });

  it('F-03 a row whose pane cannot be read is retried and committed as preview-only only on the third scan', async () => {
    const rows = inboxRows('Inbox', 2);
    h = makeHarness({ Inbox: { rows, snapshots: { [rows[1].convId]: 'throw' } } });
    const counts = [];
    for (let i = 0; i < 3; i++) { await h.run({ max: 25 }); counts.push(Object.keys(h.msgs().messages).length); }
    expect(counts).toEqual([1, 1, 2]);
    const pv = Object.values(h.msgs().messages).find((m) => m.body.status === 'preview-only');
    expect(pv).toBeTruthy();
    expect(pv.body.source).toBe('preview');
    expect(h.world.openLog.filter((o) => o.convId === rows[1].convId)).toHaveLength(3);
    // committed now: a fourth scan does not open it again
    const before = h.world.openLog.length;
    await h.run({ max: 25 });
    expect(h.world.openLog).toHaveLength(before);
  });

  it('R8.4 per-folder soft time: a folder that takes longer than its soft time stops and keeps the rest as a backlog', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 10) }, { onExec: async (kind, n, api, world) => { if (kind === 'pane' && world.openLog.length === 2) await new Promise((r) => setTimeout(r, 60)); } });
    const folders = ['Inbox'];
    const r = await cap.readMailbox({ folders, plan: fp.planFolderBudgets({ folders, max: 25 }), checkpoints: {}, folderSoftMs: 40, onBatch: async () => {}, _electron: h.electron, _warm: warmOk, _sleep: noSleep, authGraceMs: 20 });
    expect(r.opened).toBe(2);
    expect(r.folders[0]).toMatchObject({ status: 'skipped-budget', backlog: true, backlogRemaining: 8 });
    expect(C.FOLDER_SOFT_MS).toBe(90_000);
  });

  it('F-20 the scan deadline stops opening rows and ends partial with a deadline reason', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 10) });
    const folders = ['Inbox'];
    const r = await cap.readMailbox({
      folders, plan: fp.planFolderBudgets({ folders, max: 25 }), checkpoints: {}, deadlineAt: Date.now() + 1000,   // < DEADLINE_MARGIN_MS left
      onBatch: async () => {}, _electron: h.electron, _warm: warmOk, _sleep: noSleep, authGraceMs: 20,
    });
    expect(r.opened).toBe(0);
    expect(r.folders[0]).toMatchObject({ status: 'skipped-budget', deadline: true });
    expect(C.DEADLINE_MARGIN_MS).toBe(60_000);
  });
});

describe('fixtures', () => {
  it('rows-*.json fixture files match the scenario builders', () => {
    for (const [file, key] of [['rows-busy-inbox.json', 'busyInbox'], ['rows-backlog-inbox.json', 'backlogInbox'], ['rows-auth-expiry.json', 'authExpiryMidScan']]) {
      const j = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'email-intel', file), 'utf8'));
      expect(j.folders).toEqual(JSON.parse(JSON.stringify(rowsScenarios[key]())));
    }
    expect(createWorld({}).world.current).toBe('Inbox');
    expect(isSig()).toBe(true);
  });
});
function isSig() { return fp.rowSig({ convKey: 'a', preview: '11/2 Preview text' }) === fp.rowSig({ convKey: 'a', preview: 'Preview text' }); }
