// tests/fixtures/email-intel/scan-harness.js — run runIntelScan against a fake OWA world and a temp data dir.
// No Outlook, no AI (legacy triage is stubbed), no network. Each harness owns a fresh data dir.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { createWorld, warmOk, noSleep } from './fake-owa.js';
const require = createRequire(import.meta.url);

export function stubTriage(extra) {
  const calls = [];
  const fn = async (emails) => {
    calls.push(emails.map((e) => e.id));
    return {
      aiUsed: false,
      records: emails.map((e) => Object.assign({
        id: e.id, from: e.from, fromName: e.fromName, subject: e.subject, receivedText: e.receivedText, folder: e.folder, attachments: e.attachments,
        summary: 'Summary of ' + e.id, importance: 'normal', importanceWhy: '', replySuggested: false, deleteSuggested: false,
        unitRefs: [], decision: {}, triagedAt: new Date().toISOString(),
      }, typeof extra === 'function' ? extra(e) : (extra || {}))),
    };
  };
  fn.calls = calls;
  return fn;
}

export function makeHarness(foldersIn, worldOpts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-scan-'));
  require('../../../src/config/paths').setDataDir(tmp);
  const flags = require('../../../src/email-intel/flags');
  flags._setForTests({ enabled: true, capture: true });
  const lock = require('../../../src/email-intel/reliability/lock');
  lock._reset();
  const idx = require('../../../src/email-intel/index');
  const stores = require('../../../src/email-intel/stores');
  const fw = createWorld(foldersIn, worldOpts);
  const triage = stubTriage();
  const h = {
    tmp, world: fw.world, electron: fw.electron, flags, idx, stores, triage,
    /** one scan; opts override anything */
    run(opts, trigger) {
      return idx.runIntelScan(Object.assign({
        folders: Object.keys(fw.world.folders), _electron: fw.electron, _warm: warmOk, _sleep: noSleep, authGraceMs: 20, _triageEmails: triage,
      }, opts || {}), trigger || 'manual');
    },
    ck: () => stores.load('checkpoints'),
    msgs: () => stores.load('messages'),
    cleanup() { flags._setForTests(null); lock._reset(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp */ } },
  };
  return h;
}
