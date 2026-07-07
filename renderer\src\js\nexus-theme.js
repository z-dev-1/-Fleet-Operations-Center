/**
 * nexus-theme.js — Runtime Theme Engine (Year 3030 UI)
 *
 * Controls:
 *  - Theme presets (default/void/solar/arctic/ember)
 *  - Custom accent color (any hex)
 *  - Density (compact/default/spacious)
 *  - Blur intensity (0-40px)
 *  - Animation speed (off/fast/default/slow)
 *  - Custom background gradient
 *  - Glow intensity
 *
 * Persists all settings to localStorage.
 * Emits 'nexus:theme-change' on bus when anything updates.
 */

import bus from './bus.js';

const STORAGE_KEY = 'nexus_theme';

const DEFAULTS = {
  preset:     'default',
  accent:     '#00d4ff',
  density:    'default',
  blur:       20,
  animSpeed:  'default',
  glowIntensity: 1,
  bgGradient: true,
  gridLines:  true,
};

// Preset accent maps
const PRESETS = {
  default: { accent: '#00d4ff', purple: '#a855f7', bg: '#05080d' },
  void:    { accent: '#ff00ff', purple: '#00ffcc', bg: '#000000' },
  solar:   { accent: '#f59e0b', purple: '#f97316', bg: '#1a1510' },
  arctic:  { accent: '#38bdf8', purple: '#818cf8', bg: '#020b18' },
  ember:   { accent: '#ef4444', purple: '#f97316', bg: '#0d0506' },
};

let _config = { ...DEFAULTS };

function _load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) _config = { ...DEFAULTS, ...JSON.parse(saved) };
  } catch (_) {}
}

function _save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_config));
}

function _apply() {
  const root = document.documentElement;

  // Preset
  root.setAttribute('data-theme', _config.preset);
  root.setAttribute('data-density', _config.density);

  // Custom accent (override preset)
  if (_config.accent && _config.accent !== PRESETS[_config.preset]?.accent) {
    root.style.setProperty('--nx-accent', _config.accent);
    root.style.setProperty('--nx-accent-dim', _hexToDim(_config.accent, .15));
    root.style.setProperty('--nx-accent-glow', `0 0 20px ${_hexToDim(_config.accent, .3)}, 0 0 60px ${_hexToDim(_config.accent, .1)}`);
  } else {
    root.style.removeProperty('--nx-accent');
    root.style.removeProperty('--nx-accent-dim');
    root.style.removeProperty('--nx-accent-glow');
  }

  // Blur
  root.style.setProperty('--nx-blur', _config.blur + 'px');
  root.style.setProperty('--nx-glass-blur', _config.blur + 'px');

  // Animation speed
  const speeds = { off: '0s', fast: '.15s', default: '.35s', slow: '.6s' };
  root.style.setProperty('--nx-duration', speeds[_config.animSpeed] || '.35s');

  // Glow intensity
  const glow = _config.glowIntensity;
  root.style.setProperty('--nx-glow-mult', String(glow));

  // Background effects
  const bg = document.getElementById('nexus-bg');
  if (bg) {
    bg.style.opacity = _config.bgGradient ? '1' : '0';
    if (bg.querySelector('.nx-grid')) {
      bg.querySelector('.nx-grid').style.opacity = _config.gridLines ? '1' : '0';
    }
  }

  bus.emit('nexus:theme-change', _config);
}

function _hexToDim(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initTheme() {
  _load();
  _apply();
}

export function getThemeConfig() {
  return { ..._config };
}

export function setTheme(key, value) {
  _config[key] = value;
  _save();
  _apply();
}

export function setPreset(preset) {
  if (!PRESETS[preset]) return;
  _config.preset = preset;
  _config.accent = PRESETS[preset].accent;
  _save();
  _apply();
}

export function resetTheme() {
  _config = { ...DEFAULTS };
  _save();
  _apply();
}

export { PRESETS, DEFAULTS };
