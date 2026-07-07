/**
 * main.js — Fleet Operations App v3.0.0
 * Entry point: bootstraps the app, nothing else.
 * All logic lives in src/
 */

'use strict';

// Suppress EPIPE crashes when stdout/stderr pipe closes
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });
process.stderr.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

require('./src/app');
