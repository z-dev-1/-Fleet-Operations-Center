// tests/fixtures/email-intel/log-spy.js — logger spy harness (AC-9 / NFR-4).
// Install BEFORE requiring any src/email-intel module (they capture their logger
// at load time), then drop the module cache so they re-require against the spy.
// Every FEAT that adds code with dynamic content extends tests/email-intel-logging.test.js
// with its scenarios and calls assertClean() with the sentinel strings it fed in.
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const lines = [];
let saved;
let installed = false;

function spyLogger(ns) {
  const r = (level) => (...a) => lines.push({ ns, level, text: a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })())).join(' ') });
  return { debug: r('debug'), info: r('info'), warn: r('warn'), error: r('error'), log: r('info') };
}
spyLogger.createLogger = spyLogger;
spyLogger.setLogDir = () => {}; spyLogger.setLevel = () => {}; spyLogger.setSilent = () => {};
spyLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export function installLogSpy() {
  if (installed) return;
  installed = true;
  const p = require.resolve(path.join(ROOT, 'src/utils/logger'));
  saved = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: spyLogger };
  // Re-load email-intel modules (and the IPC skeleton) against the spy.
  for (const k of Object.keys(require.cache)) {
    const norm = k.replace(/\\/g, '/');
    if (/\/src\/email-intel\//.test(norm) || /\/src\/ipc\/email-intel\.js$/.test(norm)) delete require.cache[k];
  }
}

export function restoreLogSpy() {
  if (!installed) return;
  installed = false;
  const p = require.resolve(path.join(ROOT, 'src/utils/logger'));
  if (saved) require.cache[p] = saved; else delete require.cache[p];
  for (const k of Object.keys(require.cache)) {
    const norm = k.replace(/\\/g, '/');
    if (/\/src\/email-intel\//.test(norm) || /\/src\/ipc\/email-intel\.js$/.test(norm)) delete require.cache[k];
  }
}

export const logLines = () => lines.slice();
export const logText = () => lines.map((l) => l.level + ' ' + l.ns + ' ' + l.text).join('\n');
export function clearLog() { lines.length = 0; }

/** Throws (via the returned list) when any sentinel string appears in any captured log line. */
export function leaks(sentinels) {
  const hay = logText();
  return sentinels.filter((s) => hay.includes(s));
}
