// tests/awareness-assistant-ipc.test.js
// assistant:* IPC handlers (src/ipc/assistant.js), design §D11. Same harness as
// tests/aap-escalation-ipc.test.js: fake electron.ipcMain in require.cache and
// an isolated data dir.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'awareness-assistant-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });

const screen = require('../src/orcha/awareness/screen-context');
const sent = [];
require('../src/ipc/assistant').registerAssistantIPC({ send: (ch, p) => sent.push([ch, p]) });

const sender = (url) => ({ sender: { getURL: () => url } });
const APP = sender('file:///C:/app/dist/renderer/index.html');
const AAP = sender('https://aap-na.corp.amazon.com/assets/123');

beforeEach(() => { screen._resetForTests(); });

describe('assistant IPC', () => {
  it('registers the four channels', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'assistant:dismiss-note', 'assistant:get-notes', 'assistant:mark-notes-seen', 'assistant:set-screen-context',
    ]);
  });

  it('non-app sender -> NOT_APP_UI on every channel, holder unchanged', async () => {
    const r = await handlers['assistant:set-screen-context'](AAP, { view: 'fleet', unitId: '322504' });
    expect(r).toEqual({ ok: false, code: 'NOT_APP_UI' });
    expect(screen.get()).toBeNull();
    expect(await handlers['assistant:get-notes'](AAP)).toEqual({ ok: false, code: 'NOT_APP_UI' });
    expect(await handlers['assistant:mark-notes-seen'](AAP)).toEqual({ ok: false, code: 'NOT_APP_UI' });
    expect(await handlers['assistant:dismiss-note'](AAP, 'n_abc')).toEqual({ ok: false, code: 'NOT_APP_UI' });
  });

  it('spoofed sender URL is rejected', async () => {
    const r = await handlers['assistant:set-screen-context'](sender('https://evil.example/?a=localhost:5173'), { view: 'fleet' });
    expect(r.code).toBe('NOT_APP_UI');
    expect(screen.get()).toBeNull();
  });

  it('app sender set-screen-context -> ok and holder updated', async () => {
    const r = await handlers['assistant:set-screen-context'](APP, { view: 'unit', unitId: '322504', tab: 'repair' });
    expect(r).toEqual({ ok: true });
    expect(screen.get()).toMatchObject({ view: 'unit', unitId: '322504', tab: 'repair' });
  });

  it('dev-server sender is accepted', async () => {
    const r = await handlers['assistant:set-screen-context'](sender('http://localhost:5173/'), { view: 'fleet' });
    expect(r).toEqual({ ok: true });
  });

  it('invalid payload -> ok:false via safeIPC, holder unchanged', async () => {
    const r = await handlers['assistant:set-screen-context'](APP, { search: 'x'.repeat(81) });
    expect(r.ok).toBe(false);
    expect(screen.get()).toBeNull();
  });

  it('get-notes shape {ok, notes, unseen}', async () => {
    const r = await handlers['assistant:get-notes'](APP);
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
    expect(typeof r.unseen).toBe('number');
  });

  it('mark-notes-seen -> ok', async () => {
    expect(await handlers['assistant:mark-notes-seen'](APP)).toEqual({ ok: true });
  });

  it('dismiss unknown id -> NOT_FOUND; over-long id -> ok:false', async () => {
    expect(await handlers['assistant:dismiss-note'](APP, 'n_doesnotexist')).toEqual({ ok: false, code: 'NOT_FOUND' });
    const r = await handlers['assistant:dismiss-note'](APP, 'x'.repeat(65));
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe('NOT_FOUND');
  });
});
