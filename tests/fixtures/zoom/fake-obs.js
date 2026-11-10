// Fake obs-websocket v5 client (the obs-client.js surface) backed by an in-memory OBS model, for
// tests/zoom-studio-obs*.test.js. It records every request, rejects a missing required field of the
// design §4.6 request table with status 300, and implements the 600 / 601 / 500 / 501 semantics.
//
//   const f = createFakeObs({version:'5.5.2', scenes:['Scene'], program:'Scene'});
//   f.client                      -> {connect, request, sendRaw, close, on, connected}
//   f.obs                         -> the model (scenes, inputs, sceneItems, program, vcam, requests, raw ...)
//   f.emitEvent(type, data)       -> op 5 event to subscribers
//   f.emitClose(code)             -> OBS-side socket close
//   f.mutating() / f.types()      -> recorded mutating requests / request types
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ERRORS = path.join(ROOT, 'src', 'zoom', 'errors.js');

const zerr = (code, extra) => { const { ZoomError } = require(ERRORS); return new ZoomError(code, extra); };

export const MUTATING = Object.freeze([
  'CreateScene', 'RemoveScene', 'CreateInput', 'RemoveInput', 'SetInputSettings', 'SetInputName',
  'CreateSceneItem', 'RemoveSceneItem', 'SetSceneItemEnabled', 'SetSceneItemTransform',
  'SetCurrentProgramScene', 'StartVirtualCam', 'StopVirtualCam', 'SetSceneName',
]);

const REQUIRED = Object.freeze({
  CreateScene: ['sceneName'],
  GetInputSettings: ['inputName'],
  CreateInput: ['sceneName', 'inputName', 'inputKind', 'inputSettings'],
  SetInputSettings: ['inputName', 'inputSettings'],
  GetSceneItemList: ['sceneName'],
  CreateSceneItem: ['sceneName', 'sourceName'],
  SetSceneItemEnabled: ['sceneName', 'sceneItemId', 'sceneItemEnabled'],
  SetSceneItemTransform: ['sceneName', 'sceneItemId', 'sceneItemTransform'],
  SetCurrentProgramScene: ['sceneName'],
});

export function createFakeObs(opts = {}) {
  let uuidSeq = 0;
  let itemSeq = 100;
  const uuid = (p) => p + '-' + (++uuidSeq);
  const obs = {
    version: opts.version || '5.5.2',
    noUuids: opts.noUuids === true,
    password: opts.password || null,
    scenes: [],                 // {sceneName, sceneUuid}
    inputs: [],                 // {inputName, inputUuid, inputKind, inputSettings}
    sceneItems: {},             // sceneName -> [{sceneItemId, sourceName, sceneItemEnabled, transform}]
    program: opts.program || 'Scene',
    vcam: opts.vcam === true,
    baseWidth: 1920,
    baseHeight: 1080,
    requests: [],               // {type, data}
    raw: [],                    // sendRaw {type, data}
    connects: 0,
    connectArgs: [],            // {host, port, password}
    connectFail: null,          // 'ECONNREFUSED' | 4009 | 'password-required' | 4010 | (n) => one of them | null
    failNext: {},               // requestType -> status (one shot)
    closes: 0,
  };
  for (const s of opts.scenes || ['Scene']) addScene(s);

  function addScene(name, sceneUuid) {
    const s = { sceneName: name, sceneUuid: sceneUuid || uuid('scene') };
    obs.scenes.push(s);
    obs.sceneItems[name] = obs.sceneItems[name] || [];
    return s;
  }
  function addInput(name, kind = 'browser_source', settings = {}, inputUuid) {
    const i = { inputName: name, inputUuid: inputUuid || uuid('input'), inputKind: kind, inputSettings: Object.assign({}, settings) };
    obs.inputs.push(i);
    return i;
  }
  function addItem(sceneName, sourceName, enabled = true) {
    const it = { sceneItemId: ++itemSeq, sourceName, sceneItemEnabled: enabled, transform: null };
    (obs.sceneItems[sceneName] = obs.sceneItems[sceneName] || []).push(it);
    return it;
  }

  const listeners = { event: new Set(), close: new Set() };
  let connected = false;
  const fail = (status, type) => zerr('OBS_REQUEST_FAILED', { status, reason: type });
  const sceneByName = (n) => obs.scenes.find((s) => s.sceneName === n);
  const inputByName = (n) => obs.inputs.find((i) => i.inputName === n);
  const scenesOut = () => obs.scenes.map((s) => (obs.noUuids ? { sceneName: s.sceneName } : { sceneName: s.sceneName, sceneUuid: s.sceneUuid }));

  function handle(type, d) {
    switch (type) {
      case 'GetVersion': return { obsWebSocketVersion: obs.version, rpcVersion: 1, obsVersion: '30.2.3' };
      case 'GetVideoSettings': return { baseWidth: obs.baseWidth, baseHeight: obs.baseHeight, outputWidth: obs.baseWidth, outputHeight: obs.baseHeight };
      case 'GetSceneList': return { currentProgramSceneName: obs.program, scenes: scenesOut() };
      case 'CreateScene': {
        if (sceneByName(d.sceneName) || inputByName(d.sceneName)) throw fail(601, type);
        const s = addScene(d.sceneName);
        return obs.noUuids ? {} : { sceneUuid: s.sceneUuid };
      }
      case 'GetInputSettings': {
        const i = inputByName(d.inputName);
        if (!i) throw fail(600, type);
        return { inputKind: i.inputKind, inputSettings: Object.assign({}, i.inputSettings) };
      }
      case 'GetInputList': return {
        inputs: obs.inputs.filter((i) => !d || !d.inputKind || i.inputKind === d.inputKind)
          .map((i) => (obs.noUuids ? { inputName: i.inputName, inputKind: i.inputKind } : { inputName: i.inputName, inputUuid: i.inputUuid, inputKind: i.inputKind })),
      };
      case 'CreateInput': {
        if (!sceneByName(d.sceneName)) throw fail(600, type);
        if (inputByName(d.inputName) || sceneByName(d.inputName)) throw fail(601, type);
        const i = addInput(d.inputName, d.inputKind, d.inputSettings);
        const it = addItem(d.sceneName, d.inputName, d.sceneItemEnabled !== false);
        return obs.noUuids ? { sceneItemId: it.sceneItemId } : { inputUuid: i.inputUuid, sceneItemId: it.sceneItemId };
      }
      case 'SetInputSettings': {
        const i = inputByName(d.inputName);
        if (!i) throw fail(600, type);
        i.inputSettings = d.overlay === false ? Object.assign({}, d.inputSettings) : Object.assign({}, i.inputSettings, d.inputSettings);
        return {};
      }
      case 'GetSceneItemList': {
        if (!sceneByName(d.sceneName)) throw fail(600, type);
        return { sceneItems: (obs.sceneItems[d.sceneName] || []).map((it) => ({ sceneItemId: it.sceneItemId, sourceName: it.sourceName, sceneItemEnabled: it.sceneItemEnabled })) };
      }
      case 'CreateSceneItem': {
        if (!sceneByName(d.sceneName) || !(inputByName(d.sourceName) || sceneByName(d.sourceName))) throw fail(600, type);
        return { sceneItemId: addItem(d.sceneName, d.sourceName, d.sceneItemEnabled !== false).sceneItemId };
      }
      case 'SetSceneItemEnabled': {
        const it = (obs.sceneItems[d.sceneName] || []).find((x) => x.sceneItemId === d.sceneItemId);
        if (!it) throw fail(600, type);
        it.sceneItemEnabled = d.sceneItemEnabled;
        return {};
      }
      case 'SetSceneItemTransform': {
        const it = (obs.sceneItems[d.sceneName] || []).find((x) => x.sceneItemId === d.sceneItemId);
        if (!it) throw fail(600, type);
        it.transform = Object.assign({}, d.sceneItemTransform);
        return {};
      }
      case 'GetCurrentProgramScene': return obs.noUuids ? { currentProgramSceneName: obs.program } : { currentProgramSceneName: obs.program, currentProgramSceneUuid: (sceneByName(obs.program) || {}).sceneUuid };
      case 'SetCurrentProgramScene': {
        if (!sceneByName(d.sceneName)) throw fail(600, type);
        obs.program = d.sceneName;
        return {};
      }
      case 'GetVirtualCamStatus': return { outputActive: obs.vcam };
      case 'StartVirtualCam': if (obs.vcam) throw fail(500, type); obs.vcam = true; return {};
      case 'StopVirtualCam': if (!obs.vcam) throw fail(501, type); obs.vcam = false; return {};
      default: throw fail(204, type);
    }
  }

  const client = {
    async connect({ host, port, password } = {}) {
      obs.connects++;
      obs.connectArgs.push({ host, port, password });
      const f = typeof obs.connectFail === 'function' ? obs.connectFail(obs.connects) : obs.connectFail;
      if (f === 'ECONNREFUSED') throw zerr('OBS_UNREACHABLE');
      if (f === 4009) throw zerr('OBS_AUTH_FAILED');
      if (f === 'password-required') throw zerr('OBS_PASSWORD_REQUIRED');
      if (f === 4010) throw zerr('OBS_UNSUPPORTED');
      if (obs.password) {
        if (!password) throw zerr('OBS_PASSWORD_REQUIRED');
        if (password !== obs.password) throw zerr('OBS_AUTH_FAILED');
      }
      connected = true;
      return { obsWebSocketVersion: obs.version, rpcVersion: 1 };
    },
    async request(type, data) {
      obs.requests.push({ type, data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)) });
      await Promise.resolve();
      if (!connected) throw zerr('OBS_CLOSED');
      if (Object.prototype.hasOwnProperty.call(obs.failNext, type)) {
        const st = obs.failNext[type];
        delete obs.failNext[type];
        throw fail(st, type);
      }
      for (const k of REQUIRED[type] || []) {
        if (!data || data[k] === undefined || data[k] === null) throw fail(300, type);
      }
      return handle(type, data || {});
    },
    sendRaw(type, data) {
      obs.raw.push({ type, data });
      return connected;
    },
    close() {
      obs.closes++;
      if (!connected) return;
      connected = false;
      Promise.resolve().then(() => { for (const cb of listeners.close) cb({ code: 1000 }); });
    },
    on(evt, cb) {
      (listeners[evt] || (listeners[evt] = new Set())).add(cb);
      return () => listeners[evt].delete(cb);
    },
    get connected() { return connected; },
  };

  return {
    obs,
    client,
    addScene,
    addInput,
    addItem,
    emitEvent(eventType, eventData = {}) { for (const cb of listeners.event) cb({ eventType, eventData }); },
    emitClose(code = 1001) { connected = false; for (const cb of listeners.close) cb({ code }); },
    types: () => obs.requests.map((r) => r.type),
    mutating: () => obs.requests.filter((r) => MUTATING.includes(r.type)),
    reset() { obs.requests.length = 0; obs.raw.length = 0; },
  };
}
