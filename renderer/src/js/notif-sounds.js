/**
 * notif-sounds.js — Sound notifications for the app's existing 'ui:notif-push'
 * bus event (see notif-dropdown.js for the notification payload shape:
 * { icon, title, body, tag, time }).
 *
 * DESIGN: uses the Web Audio API to synthesize short, distinct tones per
 * notification type rather than shipping audio asset files -- no binary
 * files to add to the repo/build, no licensing concerns, and each sound
 * is generated on the fly so volume scaling is exact and consistent.
 *
 * Type is inferred from the notification's `icon` field (the app's
 * existing, already-consistent vocabulary -- confirmed live across every
 * ui:notif-push call site in the codebase):
 *   ✅          -> success   (e.g. WR Created)
 *   ❌          -> error     (e.g. Submit Failed)
 *   🚨          -> alert     (e.g. Partner Auto-Reply escalation)
 *   📩          -> message   (e.g. Slack DM/incoming)
 *   anything else -> default (generic single blip)
 *
 * Settings persisted via the existing generic settings store under the
 * same 'notifications' key already used by the OS-notification toggles in
 * Settings -> Integrations -> Notifications (see settings.js
 * _wireNotifications/_populate) -- new fields: soundsEnabled, soundVolume.
 */

let _enabled = true;
let _volume = 0.5; // 0..1
let _ctx = null;

function _getCtx() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  }
  return _ctx;
}

/**
 * configure({enabled, volume}) — called once on init (loaded from saved
 * settings) and again live whenever the user changes the toggle/slider in
 * Settings (via bus event 'notif-sounds:config' -- see settings.js).
 */
export function configure(prefs) {
  if (!prefs) return;
  if (typeof prefs.enabled === 'boolean') _enabled = prefs.enabled;
  if (typeof prefs.volume === 'number') _volume = Math.max(0, Math.min(1, prefs.volume));
}

export function getConfig() {
  return { enabled: _enabled, volume: _volume };
}

// Plays a single tone: frequency (Hz), duration (seconds), start delay (seconds)
function _tone(ctx, freq, dur, delay, gainScale = 1) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const startAt = ctx.currentTime + delay;
  const peak = _volume * 0.25 * gainScale; // 0.25 base ceiling -- keeps synth tones comfortably quiet even at volume=1
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

// Distinct tone patterns per type -- pitch/rhythm chosen so each is
// recognizable by ear alone, not just by volume/length:
//   success: bright two-note rising chime (like a soft "ta-da")
//   error:   two-note falling tone (lower, slightly longer -- unmistakably "wrong")
//   alert:   three quick short beeps at an urgent, higher pitch
//   message: single short, soft mid-pitch blip
//   default: single plain tone
const PATTERNS = {
  success: (ctx) => { _tone(ctx, 660, 0.12, 0); _tone(ctx, 880, 0.16, 0.1); },
  error:   (ctx) => { _tone(ctx, 400, 0.18, 0, 1.1); _tone(ctx, 300, 0.22, 0.12, 1.1); },
  alert:   (ctx) => { _tone(ctx, 950, 0.09, 0, 1.2); _tone(ctx, 950, 0.09, 0.14, 1.2); _tone(ctx, 950, 0.09, 0.28, 1.2); },
  message: (ctx) => { _tone(ctx, 520, 0.1, 0, 0.8); },
  default: (ctx) => { _tone(ctx, 600, 0.12, 0, 0.8); },
};

const ICON_TYPE_MAP = {
  '\u2705': 'success', // ✅
  '\u274c': 'error',   // ❌
  '\u{1f6a8}': 'alert',   // 🚨
  '\u{1f4e9}': 'message', // 📩
};

export function typeForIcon(icon) {
  return ICON_TYPE_MAP[icon] || 'default';
}

/**
 * play(type) — type is one of 'success' | 'error' | 'alert' | 'message' |
 * 'default'. Silently no-ops if sounds are disabled, volume is 0, or the
 * browser's autoplay policy hasn't yet granted audio (AudioContext
 * requires a prior user gesture on first use in Chromium -- this is a
 * best-effort notification sound, not a critical alert, so failing
 * silently here is the correct behavior rather than surfacing an error
 * for something the user has no direct action to take on).
 */
export function play(type) {
  if (!_enabled || _volume <= 0) return;
  try {
    const ctx = _getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const fn = PATTERNS[type] || PATTERNS.default;
    fn(ctx);
  } catch (e) { /* best-effort -- never let a sound failure break notifications */ }
}

/**
 * playForNotification(n) — convenience wrapper: derives type from the
 * notification object's icon field and plays it. This is the function
 * notif-dropdown.js actually calls from its existing 'ui:notif-push'
 * handler.
 */
export function playForNotification(n) {
  play(typeForIcon(n && n.icon));
}
