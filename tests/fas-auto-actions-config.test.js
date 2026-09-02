import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-autocfg-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const config = require('../src/orcha/fas/config');
const reg = require('../src/orcha/fas/action-registry');

beforeEach(() => { store.save('fasConfig', null); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 12: automatic-action catalog + config safety', () => {
  it('catalog marks lifecycle/WR/send as approval-only (never automatic-eligible)', () => {
    const cat = reg.listActionCatalog();
    const byName = Object.fromEntries(cat.map(a => [a.name, a]));
    expect(byName.ADD_TIMELINE.eligibleForAutomatic).toBe(true);
    expect(byName.MOVE_UNIT.eligibleForAutomatic).toBe(false);
    expect(byName.SUBMIT_WORK_REQUEST.eligibleForAutomatic).toBe(false);
    expect(byName.SEND_SLACK_MESSAGE.eligibleForAutomatic).toBe(false);
  });

  it('defaults to NO automatic actions', () => {
    expect(config.get().approvedAutomaticActions).toEqual([]);
  });

  it('save() strips approval-level actions from approvedAutomaticActions', () => {
    const saved = config.save({ enabled: true, mode: 'autonomous',
      approvedAutomaticActions: ['ADD_TIMELINE', 'MOVE_UNIT', 'SEND_SLACK_MESSAGE', 'SUBMIT_WORK_REQUEST'] });
    expect(saved.approvedAutomaticActions).toEqual(['ADD_TIMELINE']); // mutations dropped
  });

  it('save() strips unknown/bogus action names', () => {
    const saved = config.save({ approvedAutomaticActions: ['ADD_TIMELINE', 'HACK_THE_FLEET', 42, null] });
    expect(saved.approvedAutomaticActions).toEqual(['ADD_TIMELINE']);
  });

  it('get() sanitizes a hand-edited config file that lists a mutation as automatic', () => {
    // Simulate a hostile/hand-edited file on disk.
    store.save('fasConfig', { enabled: true, mode: 'autonomous', approvedAutomaticActions: ['MOVE_UNIT', 'ADD_TIMELINE'] });
    const cfg = config.get();
    expect(cfg.approvedAutomaticActions).toEqual(['ADD_TIMELINE']); // MOVE_UNIT can never be automatic
  });

  it('_sanitizeAutoActions handles non-array input safely', () => {
    expect(config._sanitizeAutoActions(null)).toEqual([]);
    expect(config._sanitizeAutoActions('MOVE_UNIT')).toEqual([]);
  });
});
