// tests/aperia-share-store.test.js — src/aperia/share-pref.js (OFF by default) and src/aperia/share-store.js
// (DM ledger + carrier-briefing approval items) on a temp data dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const paths = require('../src/config/paths');
const pref = require('../src/aperia/share-pref');
const store = require('../src/aperia/share-store');

const DAY = 24 * 3600e3;
let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-share-store-'));
  paths.setDataDir(tmp);
  logger.clear();
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const disk = () => JSON.parse(fs.readFileSync(store.filePath(), 'utf8'));

describe('share pref', () => {
  it('defaults to OFF when the file is missing', () => {
    expect(pref.filePath()).toBe(path.join(tmp, 'aperia_share_pref.json'));
    expect(pref.load()).toEqual({ enabled: false });
  });

  it('persists ON and OFF across reloads, atomically', () => {
    expect(pref.save(true)).toBe(true);
    expect(pref.load()).toEqual({ enabled: true });
    expect(JSON.parse(fs.readFileSync(pref.filePath(), 'utf8'))).toEqual({ version: 1, enabled: true });
    expect(fs.existsSync(pref.filePath() + '.tmp')).toBe(false);
    expect(pref.save(false)).toBe(true);
    expect(pref.load()).toEqual({ enabled: false });
  });

  it('a corrupt or wrong-shape file reads as OFF', () => {
    fs.writeFileSync(pref.filePath(), '{not json');
    expect(pref.load()).toEqual({ enabled: false });
    fs.writeFileSync(pref.filePath(), JSON.stringify({ version: 1, enabled: 'yes' }));
    expect(pref.load()).toEqual({ enabled: false });
  });
});

describe('share ledger', () => {
  it('send once per id; again only on a severity step up', () => {
    expect(store.shouldSend('9001', 'MAJOR')).toBe(true);
    expect(store.markSent('9001', 'MAJOR')).toBe(true);
    expect(store.shouldSend('9001', 'MAJOR')).toBe(false);
    expect(store.shouldSend('9001', 'MINOR')).toBe(false);
    expect(store.shouldSend('9001', 'CRITICAL')).toBe(true);
    store.markSent('9001', 'CRITICAL');
    expect(store.shouldSend('9001', 'CRITICAL')).toBe(false);
    store.markSent('9001', 'MINOR');                         // never lowers the record
    expect(disk().sent).toEqual({ 9001: 'CRITICAL' });
    expect(store.shouldSend('', 'MAJOR')).toBe(false);
  });

  it('an unknown severity records as ?', () => {
    store.markSent('x1', 'weird');
    expect(disk().sent).toEqual({ x1: '?' });
    expect(store.shouldSend('x1', '')).toBe(false);
    expect(store.shouldSend('x1', 'MINOR')).toBe(true);
  });

  it('caps the ledger at 2000 ids, newest kept', () => {
    const sent = {};
    for (let i = 0; i < 2005; i++) sent['id' + i] = 'MINOR';
    fs.writeFileSync(store.filePath(), JSON.stringify({ version: 1, sent, items: [] }));
    store.markSent('newest', 'MAJOR');
    const keys = Object.keys(disk().sent);
    expect(keys.length).toBe(2000);
    expect(keys).toContain('newest');
    expect(keys).not.toContain('id0');
  });

  it('a corrupt file reads as empty and never throws', () => {
    fs.writeFileSync(store.filePath(), '{broken');
    expect(store.shouldSend('1', 'MAJOR')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.pendingCount()).toBe(0);
  });
});

describe('share items', () => {
  const base = { issueId: '9001', unit: 'NP6923', operator: 'GWOP', severity: 'CRITICAL', state: 'UNDERINFLATION', text: 'NP6923 Right Steer low. Location: 1 Main St.' };

  it('addItem creates one pending item per issueId+severity', () => {
    const t = Date.now();
    const a = store.addItem(base, t);
    expect(a).toMatchObject({ issueId: '9001', unit: 'NP6923', operator: 'GWOP', severity: 'CRITICAL', status: 'pending', createdAt: t, decidedAt: null, sentAt: null });
    expect(a.id).toMatch(/^s[a-z0-9]{1,20}$/);
    const b = store.addItem(base, t + 1000);
    expect(b.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    store.addItem(Object.assign({}, base, { severity: 'MAJOR' }));
    expect(store.list()).toHaveLength(2);
    expect(store.pendingCount()).toBe(2);
  });

  it('decide approve / dismiss; approvedFor is case-insensitive; unknown id -> code', () => {
    const a = store.addItem(base);
    const b = store.addItem(Object.assign({}, base, { issueId: '9002' }));
    expect(store.decide('snope', 'approve')).toEqual({ ok: false, code: 'APERIA_SHARE_ITEM_NOT_FOUND' });
    const r = store.decide(a.id, 'approve', 5000);
    expect(r.ok).toBe(true);
    expect(r.item).toMatchObject({ status: 'approved', decidedAt: 5000 });
    expect(r.item.text).toBe(base.text);
    const d = store.decide(b.id, 'dismiss', 6000);
    expect(d.item).toMatchObject({ status: 'dismissed', text: '' });
    expect(store.pendingCount()).toBe(0);
    expect(store.approvedFor(' gwop ').map((x) => x.id)).toEqual([a.id]);
    expect(store.approvedFor('OTHER')).toEqual([]);
  });

  it('markItemsSent moves approved items to sent and blanks the text', () => {
    const a = store.addItem(base);
    store.decide(a.id, 'approve');
    expect(store.markItemsSent([a.id], 7000)).toBe(1);
    const it = store.list()[0];
    expect(it).toMatchObject({ status: 'sent', sentAt: 7000, text: '' });
    expect(store.approvedFor('GWOP')).toEqual([]);
    expect(store.markItemsSent([a.id])).toBe(0);
    expect(fs.readFileSync(store.filePath(), 'utf8')).not.toContain('1 Main St');
  });

  it('prunes items older than 30 days and caps at 200', () => {
    const now = Date.now();
    store.addItem(Object.assign({}, base, { issueId: 'old' }), now - 31 * DAY);
    store.addItem(Object.assign({}, base, { issueId: 'new' }), now);
    expect(store.list().map((x) => x.issueId)).toEqual(['new']);
    for (let i = 0; i < 205; i++) store.addItem(Object.assign({}, base, { issueId: 'n' + i }), now);
    expect(store.list()).toHaveLength(200);
    expect(store.list().some((x) => x.issueId === 'n204')).toBe(true);
  });

  it('retries a transiently locked file and never overwrites a store it could not read', () => {
    store.addItem(Object.assign({}, base, { issueId: 'a' }));
    const realRename = fs.renameSync;
    const realRead = fs.readFileSync;
    let fails = 2;
    fs.renameSync = (...a) => { if (fails-- > 0) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } return realRename(...a); };
    try { store.addItem(Object.assign({}, base, { issueId: 'b' })); } finally { fs.renameSync = realRename; }
    expect(store.list().map((x) => x.issueId)).toEqual(['a', 'b']);
    fs.readFileSync = (f, ...a) => {
      if (String(f) === store.filePath()) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
      return realRead(f, ...a);
    };
    try {
      expect(store.addItem(Object.assign({}, base, { issueId: 'c' }))).toBe(null);
      expect(store.shouldSend('never-sent', 'CRITICAL')).toBe(false);
    } finally { fs.readFileSync = realRead; }
    expect(store.list().map((x) => x.issueId)).toEqual(['a', 'b']);
    expect(logger.text()).toContain('APERIA_SHARE_STORE_UNREADABLE');
  });

  it('logs never carry item text', () => {
    store.addItem(base);
    fs.writeFileSync(store.filePath(), '{broken');
    store.list();
    expect(logger.text()).not.toContain('1 Main St');
  });
});
