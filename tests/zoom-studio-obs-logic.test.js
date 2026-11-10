// FEAT-004 / plan item 12 (design §5.1; review F1, F3, F4, F5, F9, F12, F15): pure OBS section logic.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as O from '../renderer/src/js/zoom/obs-logic.js';
import { codeMessage } from '../renderer/src/js/zoom/data-logic.js';

const require = createRequire(import.meta.url);
const FORBIDDEN = ['Go live', 'Send to Zoom', 'Virtual camera: on'];

const TABLE = {
  connected: 'Connected to OBS.',
  idle: 'Not connected.',
  OBS_NOT_RUNNING: "OBS isn't running.",
  'obs-starting': 'Starting OBS…',
  OBS_SERVER_DISABLED: 'The WebSocket server is off in OBS.',
  OBS_PASSWORD_REQUIRED: 'OBS needs its WebSocket password. Copy it from Tools → WebSocket Server Settings → Show Connect Info.',
  OBS_AUTH_FAILED: 'OBS rejected the password.',
  live: 'OBS output running. In Zoom, choose OBS Virtual Camera.',
  'vcam-stopped-in-obs': 'OBS Virtual Camera was stopped in OBS.',
  'obs-closed': 'OBS closed.',
  'feed-lost': "OBS output stopped because Fleet's feed ended.",
  recovered: 'Switched OBS back to your previous scene.',
  'obs-loop': "Fleet can't use OBS Virtual Camera as its own input. Pick your real camera.",
  'in-use': 'Your camera is busy. If Zoom or an OBS Video Capture source is using it, switch Zoom to OBS Virtual Camera or remove that source.',
  'camera-lost': 'OBS output stopped because the camera was disconnected or taken by another app.',
};

describe('obs-logic statusMessage', () => {
  it('statusMessage returns every exact §5.1 string plus camera-lost', () => {
    expect(O.STATUS_MESSAGES).toEqual(TABLE);
    // states
    for (const st of ['connected', 'idle', 'live', 'obs-closed']) expect(O.statusMessage({ state: st, reason: null })).toBe(TABLE[st]);
    // codes (failures carry reason = code, F4)
    for (const c of ['OBS_NOT_RUNNING', 'OBS_SERVER_DISABLED', 'OBS_PASSWORD_REQUIRED', 'OBS_AUTH_FAILED']) {
      expect(O.statusMessage({ ok: false, state: 'error', code: c, reason: c })).toBe(TABLE[c]);
    }
    // reasons
    expect(O.statusMessage({ state: 'connecting', reason: 'obs-starting', code: 'OBS_UNREACHABLE' })).toBe(TABLE['obs-starting']);
    for (const r of ['vcam-stopped-in-obs', 'feed-lost', 'recovered']) expect(O.statusMessage({ state: 'connected', reason: r })).toBe(TABLE[r]);
    // renderer feed states
    for (const f of ['obs-loop', 'in-use', 'camera-lost']) expect(O.statusMessage({ state: 'connected', feedState: f })).toBe(TABLE[f]);
    // nothing matches -> codeMessage(code) or "Not connected."
    expect(O.statusMessage({ state: 'error', code: 'OBS_UNREACHABLE', reason: 'OBS_UNREACHABLE' })).toBe(codeMessage('OBS_UNREACHABLE'));
    expect(O.statusMessage(null)).toBe('Not connected.');
    expect(O.statusMessage({})).toBe('Not connected.');
  });

  it('F4: statusMessage precedence feedState > reason > code > state (one example per level)', () => {
    // (1) feedState beats everything
    expect(O.statusMessage({ feedState: 'camera-lost', reason: 'feed-lost', code: 'OBS_AUTH_FAILED', state: 'live' })).toBe(TABLE['camera-lost']);
    // (2) reason (in the table) beats code and state
    expect(O.statusMessage({ feedState: null, reason: 'recovered', code: 'OBS_AUTH_FAILED', state: 'connected' })).toBe(TABLE.recovered);
    // (3) code beats state when the reason is not in the table
    expect(O.statusMessage({ reason: 'something-else', code: 'OBS_NOT_RUNNING', state: 'error' })).toBe(TABLE.OBS_NOT_RUNNING);
    // (4) state last
    expect(O.statusMessage({ reason: 'something-else', code: 'NOT_A_TABLE_CODE', state: 'live' })).toBe(TABLE.live);
    // a non-feed feedState is ignored at level 1
    expect(O.statusMessage({ feedState: 'feed-lost', state: 'connected' })).toBe(TABLE.connected);
  });
});

describe('obs-logic buttons / hint', () => {
  it('F5: buttonStates follows the per-state enable table and disables everything while in flight', () => {
    const rows = {
      idle: { connect: true, disconnect: false, start: true },
      connecting: { connect: false, disconnect: false, start: false },
      connected: { connect: false, disconnect: true, start: true },
      starting: { connect: false, disconnect: false, start: false },
      live: { connect: false, disconnect: true, start: false },
      stopping: { connect: false, disconnect: false, start: false },
      'obs-closed': { connect: true, disconnect: false, start: true },
      error: { connect: true, disconnect: false, start: true },
    };
    for (const [state, exp] of Object.entries(rows)) {
      expect([state, O.buttonStates({ state, outputLive: false, canLaunch: false }, false)])
        .toEqual([state, Object.assign({ stop: false, launch: false }, exp)]);
    }
    expect(O.buttonStates({ state: 'live', outputLive: true }, false).stop).toBe(true);
    expect(O.buttonStates({ state: 'error', canLaunch: true }, false).launch).toBe(true);
    expect(O.buttonStates({ state: 'error', canLaunch: false }, false).launch).toBe(false);
    const all = { connect: false, disconnect: false, start: false, stop: false, launch: false };
    for (const state of Object.keys(rows)) expect(O.buttonStates({ state, outputLive: true, canLaunch: true }, true)).toEqual(all);
    expect(O.buttonStates(null, false)).toEqual({ connect: true, disconnect: false, start: true, stop: false, launch: false });
  });

  it('F15: hintText prefixes the tray sentence after a Fleet launch', () => {
    expect(O.OBS_TRAY_PREFIX).toBe('OBS is running in the system tray; open it from the tray icon. ');
    expect(O.OBS_HINT).toBe('Enable it in OBS: Tools → WebSocket Server Settings → Enable WebSocket server. Then click Show Connect Info and copy the Server Password into Fleet.');
    expect(O.hintText({ code: 'OBS_SERVER_DISABLED', launchedByFleet: true })).toBe(O.OBS_TRAY_PREFIX + O.OBS_HINT);
    expect(O.hintText({ code: 'OBS_SERVER_DISABLED', launchedByFleet: false })).toBe(O.OBS_HINT);
    expect(O.hintText(null)).toBe(O.OBS_HINT);
  });
});

describe('obs-logic copy', () => {
  it('F9: HONESTY_BANNER_OBS starts with HONESTY_BANNER_OBS_LEAD', () => {
    expect(O.HONESTY_BANNER_OBS_LEAD).toBe('Preview.');
    expect(O.HONESTY_BANNER_OBS.startsWith(O.HONESTY_BANNER_OBS_LEAD)).toBe(true);
    expect(O.HONESTY_BANNER_OBS_LEAD + O.HONESTY_BANNER_OBS.slice(O.HONESTY_BANNER_OBS_LEAD.length)).toBe(O.HONESTY_BANNER_OBS);
  });

  it('F1: OBS_RESTORE_NOTE is the feed-stopped wording', () => {
    expect(O.OBS_RESTORE_NOTE).toBe("Fleet switches OBS back to your previous scene when you stop output. If Fleet or OBS closes first, OBS shows a black 'feed stopped' screen and Fleet switches it back the next time you open Studio.");
  });

  it('copy constants exact and free of forbidden phrases', () => {
    expect(O.HONESTY_BANNER_OBS).toBe("Preview. Zoom doesn't see Fleet directly: start OBS output below, then in Zoom choose 'OBS Virtual Camera' as your camera. Fleet can't be a camera by itself.");
    expect(O.OBS_STEPS).toEqual(['Start OBS output here.', 'In Zoom, choose OBS Virtual Camera.', "Don't select your real camera in Zoom, because Fleet is using it."]);
    // code review #4: the one click covers the OBS side only; the Zoom camera pick stays with the user
    expect(O.OBS_SETUP_NOTE).toBe('One-time setup in OBS: turn on the WebSocket server and enter its password here. After that, one click on Start OBS output handles the OBS side; then choose OBS Virtual Camera in Zoom.');
    expect(O.OBS_EFFECTS_NOTE).toBe("Background replace needs a green screen. Avatar shows a full image or overlay, with no face tracking. Person-aware blur and replacement aren't available yet.");
    expect(O.OBS_TROUBLESHOOT).toBe('If Zoom shows something else, set OBS → Start Virtual Camera ⚙ → Output type: Program.');
    expect(O.OBS_BACKGROUNDS_NOTE).toBe("Zoom's built-in backgrounds stay inside Zoom. Fleet uses images you import into the library.");
    expect(O.IMAGE_LIVE_NOTE).toBe('The camera stays on while OBS output runs, so switching back is instant.');
    expect(O.PASSWORD_SAVED).toBe('Password saved');
    expect(O.PASSWORD_SESSION).toBe('Password kept for this session only.');
    const strings = Object.values(O).filter((v) => typeof v === 'string')
      .concat(O.OBS_STEPS, Object.values(O.STATUS_MESSAGES))
      .concat([
        O.renderObsSection({ status: { state: 'live', outputLive: true, hint: true, launchedByFleet: true } }),
        O.renderObsSection({ status: { state: 'idle' }, showHint: true }),
        O.renderObsForm({ host: '127.0.0.1', port: 4455, passwordNote: O.PASSWORD_SAVED }),
      ]);
    const text = strings.join('\n').toLowerCase();
    for (const f of FORBIDDEN) expect(text.includes(f.toLowerCase())).toBe(false);
  });
});

describe('obs-logic feed helpers', () => {
  it('shouldSend, FEED_URL_RE and FEED_INTERVAL_MS', () => {
    expect(O.FEED_INTERVAL_MS).toBe(33);
    expect(O.shouldSend({ inFlight: false, bufferedAmount: 0 })).toBe(true);
    expect(O.shouldSend({ inFlight: true, bufferedAmount: 0 })).toBe(false);
    expect(O.shouldSend({ inFlight: false, bufferedAmount: O.SEND_BUFFER_LIMIT })).toBe(false);
    expect(O.shouldSend({ inFlight: false, bufferedAmount: O.SEND_BUFFER_LIMIT - 1 })).toBe(true);
    const tok = 'a'.repeat(64);
    expect(O.FEED_URL_RE.test(`ws://127.0.0.1:51234/feed/${tok}`)).toBe(true);
    for (const bad of [
      `ws://localhost:51234/feed/${tok}`, `wss://127.0.0.1:51234/feed/${tok}`, `ws://127.0.0.1:51234/feed/${'A'.repeat(64)}`,
      `ws://127.0.0.1:51234/feed/${'a'.repeat(63)}`, `ws://127.0.0.1:512345/feed/${tok}`, `ws://127.0.0.1:51234/obs/${tok}/view`,
      `ws://127.0.0.1:51234/feed/${tok}?x=1`, `ws://10.0.0.1:51234/feed/${tok}`, '',
    ]) expect([bad, O.FEED_URL_RE.test(bad)]).toEqual([bad, false]);
  });

  it('FR5/D5: containRect matches the viewer script on the same cases', () => {
    const server = require('../src/zoom/studio/obs-feed-server.js');
    // The containRect the OBS viewer page actually evaluates (inlined into VIEWER_JS).
    const m = /var containRect = (function[\s\S]*?\n\});/.exec(server.VIEWER_JS);
    expect(m).not.toBe(null);
    const viewerContain = new Function('return (' + m[1].replace(/;$/, '') + ');')();
    const cases = [
      [1280, 720, 1280, 720], [640, 480, 1280, 720], [1920, 1080, 1280, 720], [720, 1280, 1280, 720],
      [1000, 1000, 1280, 720], [1, 1, 1280, 720], [0, 480, 1280, 720], [640, 0, 1280, 720], [-1, 5, 10, 10], [640, 480, 0, 0],
    ];
    for (const c of cases) {
      const mine = O.containRect(...c);
      expect([c, mine]).toEqual([c, viewerContain(...c)]);
      expect([c, mine]).toEqual([c, server.containRect(...c)]);
    }
    expect(O.containRect(640, 480, 1280, 720)).toEqual({ x: 160, y: 0, w: 960, h: 720 });
  });
});
