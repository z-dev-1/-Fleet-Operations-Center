/**
 * notif-sounds.js — Notification sounds using Web Audio API
 *
 * No external audio files needed — generates tones programmatically.
 * Sounds are short, professional, and non-intrusive.
 *
 * Usage:
 *   import { playSound } from './notif-sounds.js';
 *   playSound('alert');    // critical alert
 *   playSound('dm');       // new Slack DM
 *   playSound('success');  // action completed
 *   playSound('info');     // general notification
 */

let _ctx = null;
let _enabled = true;
let _volume = 0.3; // 0-1

function _getCtx() {
  if (!_ctx) {
    try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (_) { return null; }
  }
  return _ctx;
}

function _playTone(freq, duration, type = 'sine', ramp = true) {
  const ctx = _getCtx();
  if (!ctx || !_enabled) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(_volume, ctx.currentTime);

  if (ramp) {
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
  }

  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

const SOUNDS = {
  // Critical alert: two-tone urgent beep (high-low)
  alert: () => {
    _playTone(880, 0.12, 'square');
    setTimeout(() => _playTone(660, 0.15, 'square'), 140);
    setTimeout(() => _playTone(880, 0.12, 'square'), 320);
  },

  // New Slack DM: gentle double-tap (like a message received)
  dm: () => {
    _playTone(587, 0.08, 'sine');
    setTimeout(() => _playTone(784, 0.1, 'sine'), 100);
  },

  // Success: rising chime
  success: () => {
    _playTone(523, 0.08, 'sine');
    setTimeout(() => _playTone(659, 0.08, 'sine'), 80);
    setTimeout(() => _playTone(784, 0.12, 'sine'), 160);
  },

  // Info: soft single tap
  info: () => {
    _playTone(440, 0.1, 'sine');
  },

  // Warning: descending tone
  warning: () => {
    _playTone(660, 0.1, 'triangle');
    setTimeout(() => _playTone(440, 0.15, 'triangle'), 120);
  },
};

export function playSound(name) {
  const fn = SOUNDS[name];
  if (fn) fn();
}

export function setSoundEnabled(enabled) {
  _enabled = !!enabled;
}

export function setSoundVolume(vol) {
  _volume = Math.max(0, Math.min(1, vol));
}

export function isSoundEnabled() {
  return _enabled;
}


/**
 * playForNotification(n) — Derives sound type from notification icon and plays it.
 * Called by notif-dropdown.js on every ui:notif-push event.
 * @param {{ icon, title, body }} n — notification payload
 */
export function playForNotification(n) {
  if (!n || !n.icon) { playSound('info'); return; }
  const icon = n.icon;
  if (icon.includes('\u{1F6A8}') || icon.includes('🚨')) { playSound('alert'); return; }   // 🚨 escalation
  if (icon.includes('\u{1F534}') || icon.includes('🔴')) { playSound('alert'); return; }   // 🔴 critical
  if (icon.includes('\u{1F4E9}') || icon.includes('📩')) { playSound('dm'); return; }      // 📩 DM / message
  if (icon.includes('\u2705') || icon.includes('✅'))    { playSound('success'); return; } // ✅ success
  if (icon.includes('\u274C') || icon.includes('❌'))    { playSound('warning'); return; } // ❌ error
  if (icon.includes('\u26A0') || icon.includes('⚠'))    { playSound('warning'); return; } // ⚠️ warning
  playSound('info'); // default
}
