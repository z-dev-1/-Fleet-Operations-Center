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

// Per-category sound mapping. Each of the 5 notification CATEGORIES maps to a
// tone name (a key of SOUNDS) or 'off' to silence that category. The category
// is resolved from the notification icon by playForNotification(). Defaults
// mirror the original icon→tone routing so behavior is unchanged until the
// user customizes it.
const SOUND_CATEGORIES = ['alert', 'message', 'success', 'error', 'info'];
const DEFAULT_SOUND_MAP = {
  alert:   'alert',    // 🚨 escalation / 🔴 critical
  message: 'dm',       // 📩 Slack DM / message
  success: 'success',  // ✅ completed action / sync OK
  error:   'warning',  // ❌ error / ⚠️ warning
  info:    'info',     // everything else
};
let _soundMap = { ...DEFAULT_SOUND_MAP };

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
  if (!name || name === 'off') return;
  const fn = SOUNDS[name];
  if (fn) fn();
}

// Alias used by callers (notif-dropdown.js / settings.js test button).
export function play(name) { playSound(name); }

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
 * configure(prefs) — update sound settings in one call.
 * @param {{ enabled?: boolean, volume?: number, soundMap?: object }} prefs
 *   volume accepts 0-1 (fraction) or 0-100 (percent, auto-normalized).
 */
export function configure(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  if (typeof prefs.enabled === 'boolean') _enabled = prefs.enabled;
  if (typeof prefs.volume === 'number') {
    const v = prefs.volume > 1 ? prefs.volume / 100 : prefs.volume;
    _volume = Math.max(0, Math.min(1, v));
  }
  if (prefs.soundMap && typeof prefs.soundMap === 'object') {
    _soundMap = { ...DEFAULT_SOUND_MAP, ...prefs.soundMap };
  }
}

export function getConfig() {
  return { enabled: _enabled, volume: _volume, soundMap: { ..._soundMap } };
}

export function getDefaultSoundMap() { return { ...DEFAULT_SOUND_MAP }; }
export function getSoundCategories() { return [...SOUND_CATEGORIES]; }
export function getToneNames() { return Object.keys(SOUNDS); }

// Resolve a notification's CATEGORY from its icon (same routing as before).
function _categoryForIcon(icon) {
  if (!icon) return 'info';
  if (icon.includes('\u{1F6A8}') || icon.includes('🚨')) return 'alert';   // 🚨 escalation
  if (icon.includes('\u{1F534}') || icon.includes('🔴')) return 'alert';   // 🔴 critical
  if (icon.includes('\u{1F4E9}') || icon.includes('📩')) return 'message'; // 📩 DM / message
  if (icon.includes('\u2705') || icon.includes('✅'))    return 'success'; // ✅ success
  if (icon.includes('\u274C') || icon.includes('❌'))    return 'error';   // ❌ error
  if (icon.includes('\u26A0') || icon.includes('⚠'))    return 'error';   // ⚠️ warning
  return 'info';
}

// Preview the tone currently mapped to a category (for the settings UI).
export function previewCategory(category) {
  const tone = _soundMap[category];
  if (tone && tone !== 'off') playSound(tone);
}


/**
 * playForNotification(n) — Derives sound type from notification icon and plays it.
 * Called by notif-dropdown.js on every ui:notif-push event.
 * @param {{ icon, title, body }} n — notification payload
 */
export function playForNotification(n) {
  const category = _categoryForIcon(n && n.icon);
  const tone = _soundMap[category] || DEFAULT_SOUND_MAP[category];
  playSound(tone); // playSound() no-ops on 'off'/unknown
}
