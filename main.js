/**
 * main.js — Fleet Operations App v3.0.0
 * Entry point: bootstraps the app, nothing else.
 * All logic lives in src/
 */

'use strict';

// Suppress EPIPE crashes when stdout/stderr pipe closes
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

// ── GPU stability guard (Windows) ───────────────────────────────────────────
// Some Windows machines hit a fatal Electron GPU-process crash loop
// ("GPU process exited unexpectedly: exit_code=-2147483645" → "GPU process
// isn't usable. Goodbye."), which kills the whole app before any window opens.
// This is a host GPU/driver-state problem, not an app bug — confirmed live:
// with GPU disabled the identical build boots fully and runs normally. We
// disable GPU hardware acceleration + compositing BEFORE the app bootstraps so
// the single GPU error becomes non-fatal and the app renders via software. This
// MUST run before anything in src/app touches `app`. Opt back into GPU with
// FLEET_ENABLE_GPU=1 once the driver issue is resolved.
if (process.env.FLEET_ENABLE_GPU !== '1') {
  try {
    const { app } = require('electron');
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    // The window's renderer still spins up a GPU process for compositing; when
    // that process crash-loops, Electron escalates to a FATAL "GPU process isn't
    // usable. Goodbye." that kills the whole app. These two switches (a) keep the
    // GPU process out of its own sandbox (the -2147483645/STATUS_BREAKPOINT death
    // on this host is a sandbox-init failure) and (b) remove the crash-count
    // ceiling so a transient GPU death can never escalate to the app-killing
    // fatal — the app keeps running via software rendering regardless.
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
  } catch (_) { /* electron unavailable (e.g. required outside the runtime) — ignore */ }
}

require('./src/app');
