/**
 * workflow-recorder-hud.js -- Recorder control surface [Phase 8, Phase 1]
 *
 * Small floating control docked to the left of the Orcha FAB (48px circle at
 * bottom:24px/right:24px -- see fleet.css .orcha-fab). This HUD is the only
 * UI that drives renderer/src/js/workflow-recorder.js directly.
 *
 * States: idle -> naming -> recording <-> paused -> (stopped back to idle)
 * '_localState' tracks the UI-only 'naming' step (recorder.js has no concept
 * of "about to record" -- it only knows idle/recording/paused). Once a real
 * recording starts, recorder.getStatus().status is treated as the source of
 * truth and _localState is kept in sync with it.
 *
 * See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md for the full design.
 */

import bus from '../bus.js';
import * as recorder from '../workflow-recorder.js';

let _el = null;
let _timerInterval = null;
let _pendingName = '';
let _localState = 'idle'; // 'idle' | 'naming' (recording/paused come from recorder.getStatus())

const GLASS_BG     = 'rgba(22,27,34,.85)';
const GLASS_BORDER = 'rgba(240,246,252,.12)';
const ACCENT_RED   = '#f85149';
const ACCENT_BLUE  = '#58a6ff';

function _fmtElapsed() {
  const { startedAt } = recorder.getStatus();
  if (!startedAt) return '00:00';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return m + ':' + s;
}

function _stopTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

function _startTimer() {
  _stopTimer();
  _timerInterval = setInterval(() => {
    const timeEl = _el && _el.querySelector('#wi-hud-time');
    if (timeEl) timeEl.textContent = _fmtElapsed();
  }, 1000);
}

function _pillStyle() {
  return `display:flex;align-items:center;gap:6px;background:${GLASS_BG};border:1px solid ${GLASS_BORDER};
          border-radius:20px;padding:8px 14px;color:#e6edf3;cursor:pointer;backdrop-filter:blur(12px);
          box-shadow:0 4px 16px rgba(0,0,0,.3);`;
}

function _panelStyle() {
  return `display:flex;align-items:center;gap:8px;background:${GLASS_BG};border:1px solid ${GLASS_BORDER};
          border-radius:20px;padding:8px 12px;backdrop-filter:blur(12px);box-shadow:0 4px 16px rgba(0,0,0,.3);`;
}

function _iconBtnStyle(color) {
  return `background:transparent;border:none;color:${color};font-size:13px;cursor:pointer;
          width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:50%;`;
}

// -- Single render function; decides the effective state each call ------------
function _render() {
  if (!_el) return;
  const real = recorder.getStatus(); // { status: 'idle'|'recording'|'paused', stepCount, startedAt }

  // Once a real recording exists, it always wins over the local 'naming' flag.
  const effective = (real.status === 'recording' || real.status === 'paused') ? real.status : _localState;

  if (effective === 'idle') {
    _stopTimer();
    _el.innerHTML = `
      <button id="wi-hud-record-btn" title="Record a workflow" style="${_pillStyle()}">
        <span style="font-size:13px;line-height:1">&#9210;</span>
        <span style="font-size:12px;font-weight:600;white-space:nowrap">Record</span>
      </button>
    `;
    _el.querySelector('#wi-hud-record-btn').addEventListener('click', () => {
      _pendingName = '';
      _localState = 'naming';
      _render();
    });
    return;
  }

  if (effective === 'naming') {
    _stopTimer();
    _el.innerHTML = `
      <div style="${_panelStyle()}">
        <input id="wi-hud-name-input" type="text" placeholder="Workflow name..."
          style="background:rgba(255,255,255,.06);border:1px solid ${GLASS_BORDER};border-radius:6px;
                 color:#e6edf3;font-size:12px;padding:6px 8px;width:150px;outline:none"
          autocomplete="off" spellcheck="false" />
        <button id="wi-hud-start-btn" title="Start recording" style="${_iconBtnStyle(ACCENT_RED)}">&#9210;</button>
        <button id="wi-hud-cancel-btn" title="Cancel" style="${_iconBtnStyle('#8b949e')}">&#10005;</button>
      </div>
    `;
    const input = _el.querySelector('#wi-hud-name-input');
    input.value = _pendingName;
    input.focus();
    input.addEventListener('input', (e) => { _pendingName = e.target.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _startRecording();
      if (e.key === 'Escape') { _localState = 'idle'; _render(); }
    });
    _el.querySelector('#wi-hud-start-btn').addEventListener('click', _startRecording);
    _el.querySelector('#wi-hud-cancel-btn').addEventListener('click', () => { _localState = 'idle'; _render(); });
    return;
  }

  // effective === 'recording' | 'paused'
  const isPaused = effective === 'paused';
  _el.innerHTML = `
    <div style="${_panelStyle()}">
      <span style="width:8px;height:8px;border-radius:50%;background:${isPaused ? '#8b949e' : ACCENT_RED};
                    ${isPaused ? '' : 'animation:wiPulse 1.2s ease-in-out infinite;'}"></span>
      <span id="wi-hud-time" style="font-family:'SF Mono','Fira Code',monospace;font-size:12px;color:#e6edf3;min-width:40px">${_fmtElapsed()}</span>
      <span style="font-size:11px;color:#8b949e;white-space:nowrap">${real.stepCount} step${real.stepCount === 1 ? '' : 's'}</span>
      <button id="wi-hud-pause-btn" title="${isPaused ? 'Resume' : 'Pause'}" style="${_iconBtnStyle(ACCENT_BLUE)}">${isPaused ? '&#9654;' : '&#9208;'}</button>
      <button id="wi-hud-stop-btn" title="Stop and save" style="${_iconBtnStyle('#3fb950')}">&#9632;</button>
      <button id="wi-hud-discard-btn" title="Discard" style="${_iconBtnStyle('#8b949e')}">&#10005;</button>
    </div>
    <style>@keyframes wiPulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }</style>
  `;
  _el.querySelector('#wi-hud-pause-btn').addEventListener('click', () => {
    if (isPaused) recorder.resume(); else recorder.pause();
    _render();
  });
  _el.querySelector('#wi-hud-stop-btn').addEventListener('click', _stopRecording);
  _el.querySelector('#wi-hud-discard-btn').addEventListener('click', _discardRecording);
  if (isPaused) _stopTimer(); else _startTimer();
}

async function _startRecording() {
  const name = (_pendingName || '').trim() || 'Untitled Workflow';
  try {
    await recorder.start({ name, category: 'Uncategorized' });
    _localState = 'idle'; // no longer relevant -- recorder.getStatus() now drives rendering
    _render();
    bus.emit('ui:toast', { type: 'info', message: `Recording "${name}"...` });
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Could not start recording: ' + e.message });
    _localState = 'idle';
    _render();
  }
}

async function _stopRecording() {
  try {
    const saved = await recorder.stop({ name: _pendingName || undefined });
    _localState = 'idle';
    _render();
    bus.emit('ui:toast', { type: 'success', message: `Saved "${saved.name}" (${saved.steps.length} steps)` });
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Could not save recording: ' + e.message });
  }
}

async function _discardRecording() {
  if (!window.confirm('Discard this recording? This cannot be undone.')) return;
  await recorder.discard();
  _localState = 'idle';
  _render();
  bus.emit('ui:toast', { type: 'info', message: 'Recording discarded.' });
}

export function init() {
  _el = document.createElement('div');
  _el.id = 'wi-recorder-hud';
  _el.className = 'wi-hud';
  _el.style.cssText = 'position:fixed;bottom:24px;right:84px;z-index:9500;';
  document.body.appendChild(_el);
  _localState = 'idle';
  _render();

  // Shift left when the unit-detail panel is open, mirroring orcha-fab's own
  // offset logic, so the HUD never sits underneath the detail drawer.
  bus.on('ui:unit-select',   () => { _el.style.right = '484px'; });
  bus.on('ui:unit-deselect', () => { _el.style.right = '84px'; });

  bus.on('wi:recording-step', () => { if (recorder.getStatus().status === 'recording') _render(); });
}
