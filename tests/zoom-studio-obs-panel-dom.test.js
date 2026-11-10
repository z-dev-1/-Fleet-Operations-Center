// FEAT-004 / plan item 14 (design §5.3, FR2, FR5-FR8, AC1, AC9, AC14; review F1, F5, F9, F12, F15, F16):
// the Studio panel with the OBS flag ON (obs-panel.js + the studio-panel.js integration) and the
// unchanged flag-OFF panel. Fake DOM, fake media, a fake feed and a fake zoomHub; no OBS, no socket.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeMedia, HP_DEVICES } from './fixtures/zoom/fake-media.js';
import { createExtDom, createBus } from './fixtures/zoom/fake-dom-ext.js';

const panel = await import('../renderer/src/js/zoom/studio-panel.js');
const L = await import('../renderer/src/js/zoom/studio-logic.js');
const O = await import('../renderer/src/js/zoom/obs-logic.js');
const { esc } = await import('../renderer/src/js/zoom/data-logic.js');

const FORBIDDEN = ['Go live', 'Send to Zoom', 'Virtual camera: on'];
const TOKEN = 'ab'.repeat(32);
const FEED_URL = `ws://127.0.0.1:50999/feed/${TOKEN}`;
const BAT = 'C:\\Users\\me\\Desktop\\Grim Reaper Zoom Face\\Start Grim Reaper.bat';
const LIB = 'l_aaaaaaaaaaaa';
const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

function status(o) {
  return Object.assign({
    ok: true, state: 'idle', reason: null, hint: false, canLaunch: false, passwordSaved: null,
    host: '127.0.0.1', port: 4455, exePath: null, obsVersion: null, outputLive: false, producer: false,
    vcamByFleet: false, recoveryPending: false, launchedByFleet: false,
  }, o || {});
}

function fakeHub(over = {}, initial = {}) {
  let cb = null;
  const hub = {
    mediaStatus: vi.fn(async () => ({ ok: true, camera: 'granted', microphone: 'granted' })),
    openPrivacy: vi.fn(async () => ({ ok: true })),
    libraryRead: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })),
    launcherGet: vi.fn(async () => ({ ok: true, path: BAT, exists: true, isDefault: true })),
    launcherRun: vi.fn(async () => ({ ok: true })),
    launcherPick: vi.fn(async () => ({ ok: true, path: BAT })),
    obsStatus: vi.fn(async () => status(initial)),
    obsConfigSet: vi.fn(async (p) => status({ passwordSaved: p && p.password ? true : null })),
    obsConnect: vi.fn(async () => status({ state: 'connected' })),
    obsDisconnect: vi.fn(async () => status({ state: 'idle' })),
    obsStart: vi.fn(async () => status({ state: 'live', outputLive: true, producer: false, feedUrl: FEED_URL })),
    obsStop: vi.fn(async () => status({ state: 'connected' })),
    obsLaunch: vi.fn(async () => status({ state: 'idle' })),
    onObsState: vi.fn((fn) => { cb = fn; return () => { cb = null; }; }),
  };
  Object.assign(hub, over);
  hub.emitState = (s) => { if (cb) cb(status(s)); };
  return hub;
}

function fakeFeed(order) {
  const listeners = new Set();
  const f = {
    live: false,
    canvas: { width: 640, height: 480, tag: 'feed-canvas' },
    prepare: vi.fn(async () => { order && order.push('prepare'); f.live = true; f.emit(true, null); return { ok: true, deviceId: 'cam-hp' }; }),
    connect: vi.fn((url) => { order && order.push('connect:' + url); return { ok: true }; }),
    stop: vi.fn(() => { order && order.push('feed.stop'); if (f.live) { f.live = false; f.emit(false, null); } }),
    setPreset: vi.fn(),
    switchCamera: vi.fn(async (id) => ({ ok: true, deviceId: id })),
    applyNativeBlur: vi.fn(async () => ({ ok: true })),
    onLiveChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    emit(live, reason) { for (const cb of Array.from(listeners)) cb(live, reason); },
  };
  return f;
}

function setup({ obs = true, hub, initial, feed, devices = HP_DEVICES, raf } = {}) {
  const fm = createFakeMedia({ devices });
  const { document, body } = createExtDom();
  const el = document.createElement('div');
  body.appendChild(el);
  const zoomHub = hub || fakeHub({}, initial);
  const f = feed || fakeFeed();
  const flags = obs ? { studio: true, obs: true } : { studio: true };
  panel.mount(el, {
    zoomHub, flags, bus: createBus(), document, window: null, feed: f,
    mediaDevices: fm.mediaDevices, AudioContext: fm.AudioContext, raf: raf || (() => 1), caf: () => {},
  });
  return { fm, el, zoomHub, feed: f, document, S: panel._state() };
}

function allText(node) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.textContent === 'string') out.push(n.textContent);
    if (typeof n.innerHTML === 'string') out.push(n.innerHTML);
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out.join('\n');
}

const obsHtml = (S) => S.obsPanel.root.children[0].innerHTML;   // status / buttons / guide
const formHtml = (S) => S.obsPanel.root.children[1].innerHTML;  // host / port / password
const obsClick = (S, action) => S.obsPanel.root.dispatch('click', { target: { dataset: { action } } });
const obsInput = (S, role, value) => S.obsPanel.root.dispatch('input', { target: { dataset: { role }, value } });
const click = (action) => panel._state().wrap.dispatch('click', { target: { dataset: { action } } });

function enabled(html, action) {
  const m = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html);
  if (!m) return null;
  return !/\sdisabled(\s|>|$)/.test(m[0]);
}

function buttons(html) {
  return {
    connect: enabled(html, 'obs-connect'), disconnect: enabled(html, 'obs-disconnect'), start: enabled(html, 'obs-start'),
    stop: enabled(html, 'obs-stop'), launch: enabled(html, 'obs-launch'),
  };
}

async function goLive(t) {
  await panel.show();
  await tick();
  obsClick(t.S, 'obs-start');
  await tick();
  expect(t.feed.live).toBe(true);
}

afterEach(() => { panel.destroy(); vi.restoreAllMocks(); });

describe('OBS section content and copy', () => {
  it('AC14: renders every status string, the hint, OBS_STEPS, the notes and the legacy details', async () => {
    const t = setup();
    await panel.show();
    await tick();
    const { S } = t;
    const cases = [
      [{ state: 'connected' }, 'connected'],
      [{ state: 'idle' }, 'idle'],
      [{ ok: false, state: 'error', code: 'OBS_NOT_RUNNING', reason: 'OBS_NOT_RUNNING', canLaunch: true }, 'OBS_NOT_RUNNING'],
      [{ ok: false, state: 'connecting', code: 'OBS_UNREACHABLE', reason: 'obs-starting' }, 'obs-starting'],
      [{ ok: false, state: 'error', code: 'OBS_SERVER_DISABLED', reason: 'OBS_SERVER_DISABLED', hint: true }, 'OBS_SERVER_DISABLED'],
      [{ ok: false, state: 'error', code: 'OBS_PASSWORD_REQUIRED', reason: 'OBS_PASSWORD_REQUIRED' }, 'OBS_PASSWORD_REQUIRED'],
      [{ ok: false, state: 'error', code: 'OBS_AUTH_FAILED', reason: 'OBS_AUTH_FAILED' }, 'OBS_AUTH_FAILED'],
      [{ state: 'live', outputLive: true }, 'live'],
      [{ state: 'live', outputLive: true, reason: 'vcam-stopped-in-obs' }, 'vcam-stopped-in-obs'],
      [{ state: 'obs-closed' }, 'obs-closed'],
      [{ state: 'connected', reason: 'feed-lost' }, 'feed-lost'],
      [{ state: 'connected', reason: 'recovered' }, 'recovered'],
    ];
    for (const [s, key] of cases) {
      t.zoomHub.emitState(s);
      expect([key, obsHtml(S).includes(esc(O.STATUS_MESSAGES[key]))]).toEqual([key, true]);
    }
    // Renderer feed states: obs-loop / in-use from prepare, camera-lost from the feed.
    t.zoomHub.emitState({ state: 'idle' });
    for (const st of ['obs-loop', 'in-use']) {
      t.feed.prepare.mockImplementationOnce(async () => ({ ok: false, state: st }));
      obsClick(S, 'obs-start');
      await tick();
      expect([st, obsHtml(S).includes(esc(O.STATUS_MESSAGES[st]))]).toEqual([st, true]);
    }
    obsClick(S, 'obs-start');
    await tick();
    t.feed.live = false;
    t.feed.emit(false, 'camera-lost');
    expect(obsHtml(S)).toContain(esc(O.STATUS_MESSAGES['camera-lost']));
    // The hint sits behind "?".
    t.zoomHub.emitState({ state: 'idle' });
    expect(obsHtml(S)).not.toContain(esc(O.OBS_HINT));
    obsClick(S, 'obs-hint');
    expect(obsHtml(S)).toContain(esc(O.OBS_HINT));
    expect(obsHtml(S)).toContain('data-action="obs-hint"');
    for (const step of O.OBS_STEPS) expect(obsHtml(S)).toContain(esc(step));
    expect(obsHtml(S)).toContain('<ol class="zs-obs-steps">');
    // Legacy launcher inside a collapsed <details>, after the OBS section.
    const kids = S.wrap.children;
    expect(kids.indexOf(S.obsHost)).toBeGreaterThan(-1);
    expect(kids.indexOf(S.legacy)).toBe(kids.indexOf(S.obsHost) + 1);
    expect(kids.includes(S.launcherHost)).toBe(false);
    expect(S.legacy.tagName).toBe('DETAILS');
    expect(S.legacy.attributes.open).toBeUndefined();
    expect(S.legacy.children[0].tagName).toBe('SUMMARY');
    expect(S.legacy.children[0].textContent).toBe('Legacy: Grim Reaper launcher (optional)');
    expect(S.legacy.children[1]).toBe(S.launcherHost);
    expect(S.launcherEl.innerHTML).toContain('data-action="launcher-run"');
    // The OBS status replaces the installed note.
    expect(S.obs.textContent).toBe('');
  });

  it('FR6/FR8: effects, restore, troubleshooting and backgrounds notes render with exact text', async () => {
    const { S } = setup();
    await panel.show();
    await tick();
    const html = obsHtml(S);
    for (const n of [O.OBS_EFFECTS_NOTE, O.OBS_RESTORE_NOTE, O.OBS_TROUBLESHOOT, O.OBS_BACKGROUNDS_NOTE]) {
      expect(html).toContain(`<p class="zs-note">${esc(n)}</p>`);
    }
  });

  it('F9: flag ON banner lead/rest use HONESTY_BANNER_OBS_LEAD without cutting the text', () => {
    const { S } = setup();
    expect(S.wrap.children[0]).toBe(S.banner);
    expect(S.banner.children[0].tagName).toBe('STRONG');
    expect(S.banner.children[0].textContent).toBe(O.HONESTY_BANNER_OBS_LEAD);
    expect(S.banner.children[1].textContent).toBe(O.HONESTY_BANNER_OBS.slice('Preview.'.length));
    expect(S.banner.children.map((c) => c.textContent).join('')).toBe(O.HONESTY_BANNER_OBS);
  });

  it('F15: the hint after a Fleet launch starts with the tray sentence', async () => {
    const t = setup();
    await panel.show();
    await tick();
    t.zoomHub.emitState({ ok: false, state: 'error', code: 'OBS_SERVER_DISABLED', reason: 'OBS_SERVER_DISABLED', hint: true, launchedByFleet: true });
    const m = /<p class="zs-note zs-obs-hint">([^<]*)<\/p>/.exec(obsHtml(t.S));
    expect(m).not.toBe(null);
    expect(m[1].startsWith(esc(O.OBS_TRAY_PREFIX))).toBe(true);
    expect(m[1]).toBe(esc(O.OBS_TRAY_PREFIX + O.OBS_HINT));
    t.zoomHub.emitState({ ok: false, state: 'error', code: 'OBS_SERVER_DISABLED', reason: 'OBS_SERVER_DISABLED', hint: true, launchedByFleet: false });
    expect(/<p class="zs-note zs-obs-hint">([^<]*)<\/p>/.exec(obsHtml(t.S))[1]).toBe(esc(O.OBS_HINT));
  });

  it('forbidden phrases are absent with the flag ON', async () => {
    const t = setup();
    await panel.show();
    await tick();
    const snaps = [allText(t.S.wrap)];
    for (const s of [{ state: 'connected' }, { state: 'error', code: 'OBS_SERVER_DISABLED', reason: 'OBS_SERVER_DISABLED', hint: true, launchedByFleet: true }, { state: 'obs-closed' }]) {
      t.zoomHub.emitState(s);
      snaps.push(allText(t.S.wrap));
    }
    await goLive(t);
    snaps.push(allText(t.S.wrap));
    for (const mode of L.EFFECT_MODES) {
      t.S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: mode } });
      await tick();
      snaps.push(allText(t.S.wrap));
    }
    const text = snaps.join('\n').toLowerCase();
    for (const f of FORBIDDEN) expect(text.includes(f.toLowerCase())).toBe(false);
  });

  it('AC1: flag OFF -> HONESTY_BANNER, OBS_NOTE_FOUND and the launcher are unchanged and no OBS section renders', async () => {
    const withObs = HP_DEVICES.concat([{ kind: 'videoinput', deviceId: 'cam-obs', label: 'OBS Virtual Camera' }]);
    const t = setup({ obs: false, devices: withObs });
    const { S } = t;
    await panel.show();
    await tick();
    expect(S.banner.children[0].textContent).toBe(L.HONESTY_BANNER_LEAD);
    expect(S.banner.children.map((c) => c.textContent).join('')).toBe(L.HONESTY_BANNER);
    expect(S.obs.textContent).toBe(L.OBS_NOTE_FOUND);
    expect(S.wrap.children.map((c) => c.className)).toEqual([
      'zs-honesty', 'zs-head', 'zs-privacy', 'zs-status', 'zs-obs', 'zs-controls', 'zs-level', 'zs-stage', 'zs-presets-host', 'zs-launcher-host',
    ]);
    expect(S.wrap.children[9]).toBe(S.launcherHost);
    expect(S.launcherEl.innerHTML).toBe(panel.renderLauncher({ path: BAT, exists: true, isDefault: true, busy: false, message: '', obsState: 'found' }));
    expect(S.obsPanel).toBe(null);
    expect(S.feed).toBe(null);
    const text = allText(S.wrap);
    expect(text).not.toContain('OBS output');
    expect(text).not.toContain('Legacy: Grim Reaper launcher');
    expect(text).not.toContain('data-action="obs-');
    for (const k of ['obsStatus', 'obsConfigSet', 'obsConnect', 'obsDisconnect', 'obsStart', 'obsStop', 'obsLaunch', 'onObsState']) expect(t.zoomHub[k]).not.toHaveBeenCalled();
    // The flag-OFF controls HTML is exactly the pre-OBS output.
    expect(S.controls.innerHTML).toBe(panel.renderControls({
      cameras: S.cameras, mics: S.mics, cameraId: S.cameraId, micId: S.micId, previewing: false, micOn: false,
      nativeBlurOk: false, effect: S.pipeline.getState().effect, adjust: S.pipeline.getState().adjust,
    }));
    S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'image' } });
    await tick();
    expect(S.controls.innerHTML).toContain('The camera stays off in this mode.');
  });
});

describe('OBS buttons and actions', () => {
  it('F5: buttons follow the per-state enable table; Start from idle calls obsStart', async () => {
    const t = setup();
    await panel.show();
    await tick();
    const { S } = t;
    expect(buttons(obsHtml(S))).toEqual({ connect: true, disconnect: false, start: true, stop: false, launch: false });
    t.zoomHub.emitState({ ok: false, state: 'error', code: 'OBS_NOT_RUNNING', reason: 'OBS_NOT_RUNNING', canLaunch: true });
    expect(buttons(obsHtml(S))).toEqual({ connect: true, disconnect: false, start: true, stop: false, launch: true });
    t.zoomHub.emitState({ state: 'connected' });
    expect(buttons(obsHtml(S))).toEqual({ connect: false, disconnect: true, start: true, stop: false, launch: false });
    t.zoomHub.emitState({ state: 'live', outputLive: true });
    expect(buttons(obsHtml(S))).toEqual({ connect: false, disconnect: true, start: false, stop: true, launch: false });
    t.zoomHub.emitState({ state: 'connecting', reason: 'obs-starting' });
    expect(buttons(obsHtml(S))).toEqual({ connect: false, disconnect: false, start: false, stop: false, launch: false });
    t.zoomHub.emitState({ state: 'obs-closed' });
    expect(buttons(obsHtml(S))).toEqual({ connect: true, disconnect: false, start: true, stop: false, launch: false });
    // Every button is disabled while an op is in flight.
    let release;
    t.zoomHub.obsConnect.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    t.zoomHub.emitState({ state: 'error', canLaunch: true });
    obsClick(S, 'obs-connect');
    await tick();
    expect(buttons(obsHtml(S))).toEqual({ connect: false, disconnect: false, start: false, stop: false, launch: false });
    release(status({ state: 'idle' }));
    await tick();
    expect(buttons(obsHtml(S))).toEqual({ connect: true, disconnect: false, start: true, stop: false, launch: false });
    // Start from idle: one click, main connects (F5) -> no separate obsConnect from the panel.
    const connects = t.zoomHub.obsConnect.mock.calls.length;
    obsClick(S, 'obs-start');
    await tick();
    expect(t.zoomHub.obsStart).toHaveBeenCalledTimes(1);
    expect(t.zoomHub.obsConnect.mock.calls.length).toBe(connects);
    expect(obsHtml(S)).toContain(esc(O.STATUS_MESSAGES.live));
    // Start OBS -> obsLaunch, then a connect (main's start window shows "Starting OBS…").
    t.zoomHub.emitState({ ok: false, state: 'error', code: 'OBS_NOT_RUNNING', reason: 'OBS_NOT_RUNNING', canLaunch: true });
    obsClick(S, 'obs-launch');
    await tick();
    expect(t.zoomHub.obsLaunch).toHaveBeenCalledTimes(1);
    expect(t.zoomHub.obsConnect.mock.calls.length).toBe(connects + 1);
  });

  it('Start order: stop preview -> feed.prepare -> obsStart -> feed.connect; a prepare failure makes no OBS call', async () => {
    const order = [];
    const feed = fakeFeed(order);
    const hub = fakeHub();
    const t = setup({ feed, hub });
    const { S, fm } = t;
    await panel.show();
    await tick();
    click('start');
    await tick();
    expect(fm.liveTracks().length).toBe(1);
    expect(S.previewing).toBe(true);
    const prep = feed.prepare.getMockImplementation();
    feed.prepare.mockImplementation(async (a) => {
      order.push('preview-tracks:' + fm.liveTracks().length + ':' + S.previewing);
      return prep(a);
    });
    hub.obsStart.mockImplementation(async () => { order.push('obsStart'); return status({ state: 'live', outputLive: true, feedUrl: FEED_URL }); });
    obsClick(S, 'obs-start');
    await tick();
    expect(order).toEqual(['preview-tracks:0:false', 'prepare', 'obsStart', 'connect:' + FEED_URL]);
    const args = feed.prepare.mock.calls[0][0];
    expect(args.cameraId).toBe(null);   // automatic pick -> the feed applies the IR / OBS default rule itself
    expect(args.preset.effect.mode).toBe('none');
    expect(typeof args.getImage).toBe('function');
    // The feed URL is never rendered.
    expect(allText(S.wrap)).not.toContain(TOKEN);
    // Stop: feed first, then main.
    order.length = 0;
    hub.obsStop.mockImplementation(async () => { order.push('obsStop'); return status({ state: 'connected' }); });
    obsClick(S, 'obs-stop');
    await tick();
    expect(order).toEqual(['feed.stop', 'obsStop']);
    // A prepare failure: no OBS call at all.
    hub.obsStart.mockClear();
    hub.obsStop.mockClear();
    feed.prepare.mockImplementationOnce(async () => ({ ok: false, state: 'blocked', name: 'NotAllowedError' }));
    obsClick(S, 'obs-start');
    await tick();
    expect(hub.obsStart).not.toHaveBeenCalled();
    expect(hub.obsStop).not.toHaveBeenCalled();
    expect(obsHtml(S)).toContain(esc(L.stateMessage({ state: 'blocked' })));
    // An obsStart failure stops the feed and shows the error.
    feed.stop.mockClear();
    hub.obsStart.mockImplementationOnce(async () => status({ ok: false, state: 'error', code: 'OBS_AUTH_FAILED', reason: 'OBS_AUTH_FAILED' }));
    obsClick(S, 'obs-start');
    await tick();
    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(feed.connect).toHaveBeenCalledTimes(1);
    expect(obsHtml(S)).toContain(esc(O.STATUS_MESSAGES.OBS_AUTH_FAILED));
  });

  it('F1/AC9: mount with recoveryPending:true and state idle -> exactly one obsConnect', async () => {
    const t = setup({ initial: { recoveryPending: true, state: 'idle' } });
    await tick();
    await panel.show();
    await tick();
    await panel.show();
    await tick();
    expect(t.zoomHub.obsConnect).toHaveBeenCalledTimes(1);
    expect(t.zoomHub.obsConnect.mock.calls[0]).toEqual([{}]);
    panel.destroy();
    for (const initial of [{ recoveryPending: true, state: 'connected' }, { recoveryPending: false, state: 'idle' }, { recoveryPending: true, state: 'error' }]) {
      const u = setup({ initial });
      await tick();
      await panel.show();
      await tick();
      expect([initial, u.zoomHub.obsConnect.mock.calls.length]).toEqual([initial, 0]);
      panel.destroy();
    }
  });

  it('password field is type=password, autocomplete=off and cleared after save; shows Password saved / kept for this session only', async () => {
    const SENTINEL = 'SENTINEL_PW_9f3';
    const t = setup();
    await panel.show();
    await tick();
    const { S } = t;
    const pw = /<input[^>]*data-role="obs-password"[^>]*>/.exec(formHtml(S))[0];
    expect(pw).toContain('type="password"');
    expect(pw).toContain('autocomplete="off"');
    expect(pw).toContain('value=""');
    obsInput(S, 'obs-password', SENTINEL);
    obsClick(S, 'obs-save');
    await tick();
    expect(t.zoomHub.obsConfigSet).toHaveBeenCalledTimes(1);
    expect(t.zoomHub.obsConfigSet.mock.calls[0]).toEqual([{ host: '127.0.0.1', port: 4455, password: SENTINEL }]);
    expect(S.obsPanel._state().pwDraft).toBe('');
    expect(allText(S.wrap)).not.toContain(SENTINEL);
    expect(formHtml(S)).toContain(O.PASSWORD_SAVED);
    // A second save without typing never resends a password.
    obsClick(S, 'obs-save');
    await tick();
    expect(t.zoomHub.obsConfigSet.mock.calls[1]).toEqual([{ host: '127.0.0.1', port: 4455 }]);
    // No safeStorage -> session only.
    t.zoomHub.obsConfigSet.mockImplementationOnce(async () => status({ passwordSaved: false }));
    obsInput(S, 'obs-password', SENTINEL);
    obsClick(S, 'obs-save');
    await tick();
    expect(formHtml(S)).toContain(esc(O.PASSWORD_SESSION));
    expect(allText(S.wrap)).not.toContain(SENTINEL);
    // Typed but unsaved settings are sent once before Connect.
    obsInput(S, 'obs-port', '4456');
    obsInput(S, 'obs-password', SENTINEL);
    obsClick(S, 'obs-connect');
    await tick();
    expect(t.zoomHub.obsConfigSet.mock.calls[3]).toEqual([{ host: '127.0.0.1', port: 4456, password: SENTINEL }]);
    expect(t.zoomHub.obsConnect).toHaveBeenCalledTimes(1);
    expect(S.obsPanel._state().pwDraft).toBe('');
    // Validation errors are field-aware.
    t.zoomHub.obsConfigSet.mockImplementationOnce(async () => ({ ok: false, code: 'INVALID_INPUT', field: 'port' }));
    obsInput(S, 'obs-port', '80');
    obsClick(S, 'obs-save');
    await tick();
    expect(obsHtml(S)).toContain('OBS port must be a whole number from 1024 to 65535.');
  });

  it('onObsState obs-closed / feed-lost -> feed.stop()', async () => {
    const t = setup();
    await goLive(t);
    t.feed.stop.mockClear();
    t.zoomHub.emitState({ state: 'obs-closed' });
    expect(t.feed.stop).toHaveBeenCalledTimes(1);
    expect(obsHtml(t.S)).toContain(esc(O.STATUS_MESSAGES['obs-closed']));
    obsClick(t.S, 'obs-start');
    await tick();
    t.feed.stop.mockClear();
    t.zoomHub.emitState({ state: 'connected', reason: 'feed-lost' });
    expect(t.feed.stop).toHaveBeenCalledTimes(1);
    expect(obsHtml(t.S)).toContain(esc(O.STATUS_MESSAGES['feed-lost']));
  });
});

describe('OBS live mode', () => {
  it('AC14: Start preview, Mic test and launcher are disabled while live; camera picker calls feed.switchCamera', async () => {
    const t = setup();
    const { S, fm } = t;
    await goLive(t);
    const html = S.controls.innerHTML;
    expect(html).toMatch(/data-action="start"[^>]*disabled/);
    expect(html).toMatch(/data-action="mic-test"[^>]*disabled/);
    expect(html).not.toContain('data-action="stop"');
    expect(html).toContain('data-action="obs-stop-output" aria-label="Stop OBS output">Stop OBS output</button>');
    expect(S.launcherEl.innerHTML).toMatch(/data-action="launcher-run"[^>]*disabled/);
    expect(S.launcherEl.innerHTML).toMatch(/data-action="launcher-pick"[^>]*disabled/);
    click('start');
    click('mic-test');
    click('launcher-run');
    await tick();
    expect(fm.calls.getUserMedia).toEqual([]);
    expect(t.zoomHub.launcherRun).not.toHaveBeenCalled();
    expect(S.badge.style.display).toBe('');   // the feed holds the camera
    S.wrap.dispatch('change', { type: 'change', target: { dataset: { role: 'camera' }, value: 'cam-emeet' } });
    await tick();
    expect(t.feed.switchCamera).toHaveBeenCalledWith('cam-emeet');
    expect(fm.calls.getUserMedia).toEqual([]);
    // stopAll stops only the panel preview / mic; the output keeps running.
    panel.stopAll();
    panel.hide();
    expect(t.feed.stop).not.toHaveBeenCalled();
    expect(t.feed.live).toBe(true);
    await panel.show();
    await tick();
    // Stop OBS output from the controls row.
    click('obs-stop-output');
    await tick();
    expect(t.feed.stop).toHaveBeenCalledTimes(1);
    expect(t.zoomHub.obsStop).toHaveBeenCalledTimes(1);
    expect(S.controls.innerHTML).toContain('data-action="stop"');
    expect(S.launcherEl.innerHTML).not.toMatch(/data-action="launcher-run"[^>]*disabled/);
    expect(S.badge.style.display).toBe('none');
  });

  it('_syncFeed reaches feed.setPreset from applyPreset, assignImage, clearImage, updateOverlay, forgetImage, _setMode and _onChange', async () => {
    const t = setup();
    const { S } = t;
    await goLive(t);
    const sp = t.feed.setPreset;
    const step = async (name, fn) => {
      sp.mockClear();
      await fn();
      await tick();
      expect([name, sp.mock.calls.length > 0]).toEqual([name, true]);
      const last = sp.mock.calls[sp.mock.calls.length - 1][0];
      expect(last).toEqual(panel.currentPreset());
    };
    await step('applyPreset', () => panel.applyPreset({ effect: { mode: 'edgeBlur' }, adjust: { brightness: 120 } }));
    await step('assignImage', () => panel.assignImage('overlay', LIB));
    await step('updateOverlay', () => panel.updateOverlay(0, { x: 0.25 }));
    await step('clearImage', () => panel.clearImage('overlay', 0));
    await step('forgetImage', () => { panel.assignImage('avatar', LIB); return panel.forgetImage(LIB); });
    await step('_setMode', () => S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'chromaKey' } }));
    await step('_onChange effect', () => S.wrap.dispatch('input', { target: { dataset: { role: 'effect', group: 'chromaKey', key: 'tolerance' }, value: '70' } }));
    await step('_onChange adjust', () => S.wrap.dispatch('input', { target: { dataset: { role: 'adjust', key: 'contrast' }, value: '110' } }));
    await step('_onChange mirror', () => S.wrap.dispatch('change', { target: { dataset: { role: 'adjust', key: 'mirror' }, checked: true } }));
    await step('_onChange camera', () => S.wrap.dispatch('change', { type: 'change', target: { dataset: { role: 'camera' }, value: 'cam-emeet' } }));
    await step('_onChange mic', () => S.wrap.dispatch('change', { type: 'change', target: { dataset: { role: 'mic' }, value: 'mic-1' } }));
    expect(sp.mock.calls[sp.mock.calls.length - 1][0].effect.chromaKey.tolerance).toBe(70);
    // Not live -> nothing is forwarded.
    obsClick(S, 'obs-stop');
    await tick();
    sp.mockClear();
    panel.applyPreset({ effect: { mode: 'none' } });
    expect(sp).not.toHaveBeenCalled();
  });

  it('FR5: while live the preview contain-fits feed.canvas into 16:9', async () => {
    const frames = [];
    const t = setup({ raf: (fn) => { frames.push(fn); return frames.length; } });
    const calls = [];
    const ctx = new Proxy({}, {
      get(o, k) { if (k in o) return o[k]; return (...a) => { calls.push([k, ...a]); }; },
      set(o, k, v) { o[k] = v; calls.push(['set', k, v]); return true; },
    });
    t.S.canvas.getContext = () => ctx;
    await goLive(t);
    expect(frames.length).toBeGreaterThan(0);
    const run = () => { const fns = frames.splice(0); for (const fn of fns) fn(); };
    run();
    expect(t.S.canvas.width).toBe(1280);
    expect(t.S.canvas.height).toBe(720);
    expect(calls).toContainEqual(['fillRect', 0, 0, 1280, 720]);
    expect(calls).toContainEqual(['drawImage', t.feed.canvas, 160, 0, 960, 720]);
    expect(frames.length).toBe(1);   // the loop keeps going while live
    t.feed.canvas.width = 1920;
    t.feed.canvas.height = 1080;
    run();
    expect(calls).toContainEqual(['drawImage', t.feed.canvas, 0, 0, 1280, 720]);
    expect(t.S.pipeline.running).toBe(false);   // the panel's own preview stays stopped
    obsClick(t.S, 'obs-stop');
    await tick();
    calls.length = 0;
    run();
    expect(calls.some((c) => c[0] === 'drawImage')).toBe(false);
    expect(frames.length).toBe(0);
  });

  it('F12: image mode while live shows the camera-stays-on note', async () => {
    const t = setup();
    await goLive(t);
    t.S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'image' } });
    await tick();
    expect(t.S.controls.innerHTML).toContain(`<p class="zs-note">${esc(O.IMAGE_LIVE_NOTE)}</p>`);
    expect(t.S.controls.innerHTML).not.toContain('The camera stays off in this mode.');
    obsClick(t.S, 'obs-stop');
    await tick();
    expect(t.S.controls.innerHTML).toContain('The camera stays off in this mode.');
    expect(t.S.controls.innerHTML).not.toContain(esc(O.IMAGE_LIVE_NOTE));
  });

  it('F16: a feed nativeBlur failure -> panel mode none and NATIVE_BLUR_UNSUPPORTED shown', async () => {
    const t = setup();
    await goLive(t);
    t.feed.applyNativeBlur.mockImplementation(async (on) => (on ? { ok: false, message: L.NATIVE_BLUR_UNSUPPORTED } : { ok: true }));
    t.S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'nativeBlur' } });
    await tick();
    expect(t.feed.applyNativeBlur).toHaveBeenCalledWith(true);
    expect(t.S.pipeline.getState().effect.mode).toBe('none');
    expect(t.S.status.innerHTML).toContain(esc(L.NATIVE_BLUR_UNSUPPORTED));
    const sp = t.feed.setPreset.mock.calls;
    expect(sp[sp.length - 1][0].effect.mode).toBe('none');   // the next sync can't push nativeBlur back
    // A working camera keeps nativeBlur.
    t.feed.applyNativeBlur.mockImplementation(async () => ({ ok: true }));
    t.S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'nativeBlur' } });
    await tick();
    expect(t.S.pipeline.getState().effect.mode).toBe('nativeBlur');
  });
});
