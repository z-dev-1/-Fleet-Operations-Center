/**
 * views/autopilot-api.js -- thin wrapper over window.autopilot (preload expose block).
 * Same pattern as bridge.js _zm; no bridge.js edit. Every call resolves
 * { ok:false, code:'UNAVAILABLE' } when the preload API is missing.
 */
const _ap = (fn) => (...a) => (window.autopilot ? window.autopilot[fn](...a) : Promise.resolve({ ok: false, code: 'UNAVAILABLE' }));

export const autopilotApi = {
  status: _ap('status'),
  cases: _ap('cases'),
  getCase: _ap('getCase'),
  setConfig: _ap('setConfig'),
  control: _ap('control'),
  review: _ap('review'),
  harnessRun: _ap('harnessRun'),
  onChanged: (cb) => (window.autopilot && typeof window.autopilot.onChanged === 'function' ? window.autopilot.onChanged(cb) : () => {}),
};

export default autopilotApi;
