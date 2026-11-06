// tests/fixtures/email-intel/fake-owa.js — a fake `electron` for the OWA reader (no real Outlook, no network).
// BrowserWindow.webContents.executeJavaScript dispatches on the page-script text the reader sends and answers
// from a small in-memory world:  world.folders[name] = { rows:[rowDesc], snapshots?:{[convId]:snapshot} }.
// Hooks: world.onExec(kind, n, api) can trigger an auth wall (api.navigate(url)) or throw.
import { rowDesc, snapshot, block } from './emails.js';

export const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/authorize?x=1';
export const MAIL_URL = 'https://outlook.office365.com/mail/inbox';

/** Default pane for a row: unique body so every message gets its own contentHash. */
export function defaultSnapshot(row, folder) {
  return snapshot({
    subject: 'Subject ' + (row.convId || row.aria).slice(0, 40),
    blocks: [block({ text: 'Body for ' + (row.convId || row.aria) + ' in ' + folder + ' about unit 40123.', convId: row.convId, time: '2026-11-04T14:30:00-05:00' })],
  });
}

export function createWorld(foldersIn, o = {}) {
  const world = {
    folders: {}, current: 'Inbox', url: MAIL_URL, opened: null, openLog: [], execLog: [], windows: [], loadLog: [],
    onExec: o.onExec || null, snapshotFor: o.snapshotFor || defaultSnapshot, execCount: 0, warmAuthWall: !!o.warmAuthWall,
  };
  for (const [name, rows] of Object.entries(foldersIn || {})) world.folders[name] = { rows: Array.isArray(rows) ? rows : rows.rows, snapshots: rows.snapshots || {} };

  class FakeWebContents {
    constructor(win) { this.win = win; this.listeners = {}; }
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, ...a) { (this.listeners[ev] || []).slice().forEach((fn) => fn(...a)); }
    setWindowOpenHandler() {}
    getURL() { return world.url; }
    async executeJavaScript(script) { return world.exec(String(script), this.win); }
  }
  class FakeBrowserWindow {
    constructor() { this.destroyed = false; this.webContents = new FakeWebContents(this); this.handlers = {}; world.windows.push(this); }
    on(ev, fn) { this.handlers[ev] = fn; }
    hide() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; }
    loadURL(url) {
      world.loadLog.push(url); world.url = MAIL_URL; world.current = 'Inbox';
      setTimeout(() => this.webContents.emit('did-finish-load'), 0);
    }
  }
  const api = {
    navigate(url) { world.url = url; world.windows.forEach((w) => w.webContents.emit('did-navigate', {}, url)); },
  };
  const curRows = () => (world.folders[world.current] ? world.folders[world.current].rows : []);

  world.exec = async (script, win) => {
    if (win && win.destroyed) throw new Error('Object has been destroyed');
    let kind = 'other';
    if (script.includes('? "yes" : "no"')) kind = 'wait';
    else if (script.includes('role="treeitem"') && script.includes('var want =')) kind = 'folder';
    else if (script.includes('reachedEnd')) kind = 'rows';
    else if (script.includes('status: "opened"')) kind = 'open';
    else if (script.includes('paneFallback')) kind = 'pane';
    world.execCount += 1;
    world.execLog.push(kind);
    if (world.onExec) await world.onExec(kind, world.execCount, api, world);
    if (win && win.destroyed) throw new Error('Object has been destroyed');
    if (kind === 'wait') return curRows().length || world.folders[world.current] ? 'yes' : 'no';
    if (kind === 'folder') {
      const want = JSON.parse(/var want = ("(?:[^"\\]|\\.)*");/.exec(script)[1]);
      const hit = Object.keys(world.folders).find((f) => f.toLowerCase() === want);
      if (!hit) return 'not-found';
      world.current = hit; world.url = 'https://outlook.office365.com/mail/' + encodeURIComponent(hit);
      return 'clicked';
    }
    if (kind === 'rows') {
      const max = Number(/MAX = (\d+)/.exec(script)[1]);
      return JSON.stringify({ rows: curRows().slice(0, max).map((r, i) => Object.assign({}, r, { index: i })), reachedEnd: curRows().length <= max });
    }
    if (kind === 'open') {
      const m = /CID = ("(?:[^"\\]|\\.)*"), AK = ("(?:[^"\\]|\\.)*")/.exec(script);
      const cid = JSON.parse(m[1]); const ak = JSON.parse(m[2]);
      const row = curRows().find((r) => (cid ? r.convId === cid : String(r.aria).slice(0, 120) === ak));
      if (!row) return JSON.stringify({ status: 'row-not-found' });
      world.opened = row; world.openLog.push({ folder: world.current, convId: row.convId });
      return JSON.stringify({ status: 'opened' });
    }
    if (kind === 'pane') {
      const f = world.folders[world.current] || { snapshots: {} };
      const snap = world.opened ? (f.snapshots[world.opened.convId] || world.snapshotFor(world.opened, world.current)) : null;
      if (snap === 'throw') throw new Error('pane read failed');
      return snap == null ? JSON.stringify({ error: 'no-pane' }) : JSON.stringify(snap);
    }
    return '';
  };

  const electron = {
    BrowserWindow: FakeBrowserWindow,
    session: { defaultSession: {} },
    ipcMain: { handle() {} },
  };
  return { world, electron, api };
}

/** warm stub: resolves like owa-mailer.warmOwaSession (no network). */
export const warmOk = async () => ({ ok: true });
export const noSleep = async () => {};
export { rowDesc };
