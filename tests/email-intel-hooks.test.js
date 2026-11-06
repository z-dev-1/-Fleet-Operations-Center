// tests/email-intel-hooks.test.js — the inert hooks in email_triage.js (design 1.8), F2-04 _trigger,
// and the IPC/preload skeleton. Every hook is a single early branch whose guard is false with flags OFF.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as fx from './fixtures/email-intel-fixture.js';
const require = createRequire(import.meta.url);
const flags = require('../src/email-intel/flags');
const indexPath = require.resolve('../src/email-intel/index');

let calls;
let savedIndex;
function stubIndex() {
  savedIndex = require.cache[indexPath];
  require.cache[indexPath] = {
    id: indexPath, filename: indexPath, loaded: true,
    exports: {
      engaged: () => true,
      runIntelScan: async (opts, trigger) => { calls.scan.push({ opts, trigger }); return { emails: [{ id: 'from-intel' }], ranAt: 'x' }; },
      scheduledTick: async (ctx, cfg, deps) => { calls.tick.push({ ctx, cfg, deps }); return { skipped: 'stub' }; },
      getStatus: () => ({ stub: true }),
    },
  };
}

const READY = { scope: 'mine', informationType: 'new', confidence: 0.9, decisionRequired: false, category: 'fleet_status_update', intent: 'provide_update', hasConflict: false };
const results = () => ({ emails: [{ id: 'em_h1', unitRefs: [{ unit: '40123', update: '11/04 - parts arrived' }], decision: READY }] });

beforeEach(() => {
  fx.installStubs();
  fx.resetWorld({ fleetData: { rows: fx.FLEET_ROWS.map((r) => ({ ...r })) } });
  calls = { scan: [], tick: [], read: 0 };
  flags._setForTests(null);
});
afterEach(() => {
  flags._setForTests(null);
  if (savedIndex) require.cache[indexPath] = savedIndex; else delete require.cache[indexPath];
  savedIndex = undefined;
});

describe('F2-04 _trigger', () => {
  it('maps scheduled to scheduled and manual, chat, missing or junk to manual', () => {
    const { triage } = fx.freshLegacy();
    expect(triage._trigger({ _trigger: 'scheduled' })).toBe('scheduled');
    expect(triage._trigger({ _trigger: 'manual' })).toBe('manual');
    expect(triage._trigger({ _trigger: 'chat' })).toBe('manual');
    for (const v of [undefined, null, {}, { _trigger: 'SCHEDULED' }, { _trigger: 5 }, 'scheduled']) expect(triage._trigger(v)).toBe('manual');
  });
});

describe('hooks are inert with flags OFF', () => {
  it('runTriage takes the legacy path and never requires the intel module', async () => {
    stubIndex();
    const { triage } = fx.freshLegacy();
    fx.rec.reasonImpl = async () => ({ ok: false });
    const out = await triage.runTriage({ _readInbox: async () => { calls.read++; return { emails: [] }; } });
    expect(calls.read).toBe(1);
    expect(calls.scan).toEqual([]);
    expect(out.emails).toEqual([]);
  });

  it('master enabled alone (Phase 0 turns on nothing else) does not engage the intel path', async () => {
    flags._setForTests({ enabled: true });
    stubIndex();
    const { triage } = fx.freshLegacy();
    await triage.runTriage({ _readInbox: async () => { calls.read++; return { emails: [] }; } });
    expect(calls.read).toBe(1);
    expect(calls.scan).toEqual([]);
  });

  it('applyPendingUnitUpdates applies as before; getAutoScanStatus has no intel field', () => {
    const { triage } = fx.freshLegacy();
    expect(triage.applyPendingUnitUpdates(results())).toBe(1);
    expect(fx.doc('notesStore')['40123'].timeline).toContain('parts arrived');
    expect(triage.getAutoScanStatus()).not.toHaveProperty('intel');
  });

  it('_autoTick runs the legacy scan when enabled and autoScan are on', async () => {
    stubIndex();
    fx.resetWorld({ fleetData: { rows: fx.FLEET_ROWS }, emailTriageConfig: { enabled: true, autoScan: true } });
    const ow = require('../src/scrapers/owa_reader');
    const orig = ow.readInbox;
    ow.readInbox = async () => { calls.read++; return { emails: [] }; };
    try {
      const { triage } = fx.freshLegacy();
      await triage._autoTick({ signal: null });
      expect(calls.read).toBe(1);
      expect(calls.tick).toEqual([]);
    } finally { ow.readInbox = orig; }
  });
});

describe('hooks route to the intel module when capture is effective', () => {
  beforeEach(() => { flags._setForTests({ enabled: true, capture: true }); stubIndex(); });

  it('runTriage returns runIntelScan(opts, _trigger(opts)) as its first statement and reads nothing itself', async () => {
    const { triage } = fx.freshLegacy();
    const opts = { max: 5, _readInbox: async () => { calls.read++; return { emails: [] }; } };
    const out = await triage.runTriage(opts);
    expect(out).toEqual({ emails: [{ id: 'from-intel' }], ranAt: 'x' });
    expect(calls.read).toBe(0);
    expect(calls.scan).toEqual([{ opts, trigger: 'manual' }]);
    await triage.runTriage({ _trigger: 'scheduled' });
    await triage.runTriage();
    expect(calls.scan.map((c) => c.trigger)).toEqual(['manual', 'scheduled', 'manual']);
  });

  it('applyPendingUnitUpdates stays legacy under capture alone, and returns 0 once multiRecipient is effective', () => {
    const { triage } = fx.freshLegacy();
    expect(triage.applyPendingUnitUpdates(results())).toBe(1);
    flags._setForTests({ enabled: true, capture: true, multiRecipient: true });
    fx.resetWorld({ fleetData: { rows: fx.FLEET_ROWS.map((r) => ({ ...r })) } });
    expect(triage.applyPendingUnitUpdates(results())).toBe(0);
    expect(fx.doc('notesStore')).toBe('<absent>');
    expect(fx.rec.saves).toEqual([]);
  });

  it('_autoTick calls scheduledTick(ctx, cfg, deps) after the enabled/autoScan check', async () => {
    fx.resetWorld({ emailTriageConfig: { enabled: true, autoScan: true } });
    const { triage } = fx.freshLegacy();
    const ctx = { signal: { aborted: false } };
    const r = await triage._autoTick(ctx);
    expect(r).toEqual({ skipped: 'stub' });
    expect(calls.tick).toHaveLength(1);
    expect(calls.tick[0].ctx).toBe(ctx);
    expect(calls.tick[0].cfg).toMatchObject({ enabled: true, autoScan: true });
    expect(Object.keys(calls.tick[0].deps).sort()).toEqual(['autoStatus', 'loadResults', 'notify']);
    expect(typeof calls.tick[0].deps.loadResults).toBe('function');
    expect(calls.tick[0].deps.autoStatus).toHaveProperty('runs');
  });

  it('_autoTick does nothing when the feature or autoScan is off, even when engaged', async () => {
    for (const cfg of [{ enabled: false, autoScan: true }, { enabled: true, autoScan: false }, {}]) {
      fx.resetWorld({ emailTriageConfig: cfg });
      const { triage } = fx.freshLegacy();
      await triage._autoTick({});
    }
    expect(calls.tick).toEqual([]);
  });

  it('getAutoScanStatus adds the intel summary only when engaged', () => {
    const { triage } = fx.freshLegacy();
    expect(triage.getAutoScanStatus().intel).toEqual({ stub: true });
    flags._setForTests(null);
    expect(triage.getAutoScanStatus()).not.toHaveProperty('intel');
  });
});

describe('IPC and preload skeleton', () => {
  const read = (p) => fs.readFileSync(path.join(fx.ROOT, p), 'utf8');

  it('registerEmailIntelIPC is registered right after registerEmailTriageIPC', () => {
    const src = read('src/ipc/index.js').replace(/\r\n/g, '\n');
    expect(src).toMatch(/registerEmailTriageIPC\(ctx\);\n\s*registerEmailIntelIPC\(ctx\);/);
    expect(src).toMatch(/require\('\.\/email-intel'\)/);
  });

  it('preload exposes emailIntel with the full D§9 key list; the emailTriage bridge keys are unchanged', () => {
    expect(fx.preloadKeys('emailIntel')).toEqual(['status', 'scan', 'getConfig', 'setConfig', 'getActions', 'actionUpdate', 'getStaged', 'prepareAction', 'confirmAction', 'draftThreadReply', 'getSendAttempts', 'reconcileSend', 'domProbe', 'probeLane', 'setTzVerified', 'ackVisionNotice', 'onUpdated']);
    expect(fx.preloadKeys('emailTriage')).toEqual(['getConfig', 'setConfig', 'getResults', 'run', 'probe', 'draftReply', 'sendReply', 'dismissReply', 'deleteEmail', 'keepEmail', 'deleteSuggested', 'draftReadyDm', 'sendReadyDm', 'onUpdated']);
  });

  it('every preload emailIntel method targets a registered emailIntel:* channel', () => {
    const ipc = require('../src/ipc/email-intel');
    const text = read('preload.js');
    const block = text.slice(text.indexOf("expose('emailIntel'"), text.indexOf('\n});', text.indexOf("expose('emailIntel'")));
    const used = Array.from(block.matchAll(/'(emailIntel:[a-z-]+)'/g)).map((m) => m[1]);
    expect(used.sort()).toEqual(Object.keys(ipc.GATES).concat(['emailIntel:updated']).sort());
  });

  describe('channel behavior', () => {
    let ipc;
    beforeEach(() => {
      fx.rec.handlers = {};
      ipc = require('../src/ipc/email-intel');
      ipc.registerEmailIntelIPC({});
    });
    const call = (ch, ...a) => fx.rec.handlers[ch]({}, ...a);

    it('capture effective: status answers, gated-by-phase channels report NOT_IMPLEMENTED, others stay inert', async () => {
      flags._setForTests({ enabled: true, capture: true });
      expect(await call('emailIntel:status')).toEqual({ ok: true, enabled: true, phase: 0, flags: flags.get().effective });
      expect((await call('emailIntel:scan')).code).toBe('NOT_IMPLEMENTED');
      expect((await call('emailIntel:get-config')).code).toBe('NOT_IMPLEMENTED');
      expect(await call('emailIntel:get-actions')).toEqual({ ok: true, enabled: false });       // actionsView not effective
      expect(await call('emailIntel:draft-thread-reply')).toEqual({ ok: true, enabled: false }); // threadReplies not effective
      expect(await call('emailIntel:ack-vision-notice')).toEqual({ ok: true, enabled: false });
    });

    it('prepare-action validates the kind and honors the per-kind gate; confirm-action validates the token', async () => {
      flags._setForTests({ enabled: true, capture: true });
      expect(await call('emailIntel:prepare-action', 'format-disk', {})).toEqual({ ok: false, code: 'BAD_ARG', field: 'kind' });
      expect(await call('emailIntel:prepare-action', 'send-reply', {})).toEqual({ ok: true, enabled: false });   // needs threadReplies
      expect(await call('emailIntel:prepare-action', 'send-ready-dm', {})).toEqual({ ok: false, code: 'KIND_UNAVAILABLE' });  // no executor in Phase 0
      expect(await call('emailIntel:confirm-action', 'not-a-token')).toEqual({ ok: false, code: 'BAD_ARG', field: 'token' });
      expect(await call('emailIntel:confirm-action', '0'.repeat(32))).toEqual({ ok: false, code: 'TOKEN_UNKNOWN' });
    });

    it('prepare-action then confirm-action runs a registered executor only after the native dialog is accepted', async () => {
      flags._setForTests({ enabled: true, capture: true, multiRecipient: true, actionsView: true });
      const confirm = require('../src/email-intel/confirm');
      const ran = [];
      confirm._resetForTests();
      confirm.registerExecutor('delete', { summarize: () => ({ headline: 'Delete 1 email' }), run: async (p) => { ran.push(p); return { ok: true }; } });
      try {
        const prep = await call('emailIntel:prepare-action', 'delete', { conversationKey: 'cv_0123456789abcdef' });
        expect(prep.ok).toBe(true);
        expect(prep.token).toMatch(/^[0-9a-f]{32}$/);
        expect(Object.keys(prep).sort()).toEqual(['expiresAt', 'ok', 'summary', 'token']);
        // no native dialog in this process -> fail closed, nothing deleted
        expect(await call('emailIntel:confirm-action', prep.token)).toEqual({ ok: false, code: 'DIALOG_UNAVAILABLE' });
        expect(ran).toEqual([]);
      } finally { confirm._resetForTests(); }
    });
  });
});
