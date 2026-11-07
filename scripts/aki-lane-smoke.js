#!/usr/bin/env node
/**
 * aki-lane-smoke.js — live smoke test for the Aki AI lane (plan.md D7).
 *
 *   node scripts/aki-lane-smoke.js           # direct: createAkiLane() with real deps
 *   node scripts/aki-lane-smoke.js --relay   # through relay.ask() in 'aki' mode
 *
 * Sends "Reply with exactly PONG" (120 s timeout). Prints the resolved binary,
 * latency, tools used and the reply text. Never prints environment variables.
 *
 * Exit codes: 0 = reply contains PONG, 2 = aki not found, 1 = any other failure.
 * Unit tests never run this (it spawns the real aki binary).
 */
'use strict';

const PROMPT = 'Reply with exactly PONG';
const TIMEOUT_MS = 120000;

function _toolList(tools) {
  const e = Object.entries(tools || {});
  return e.length ? e.map(([n, c]) => n + '×' + c).join(', ') : '(none)';
}

async function direct() {
  const { createAkiLane, resolveAkiBin } = require('../src/orcha/aki-lane');
  const bin = resolveAkiBin({ platform: process.platform, env: process.env });
  console.log('[aki-smoke] bin: ' + (bin || '(not found)'));
  if (!bin) return 2;

  const lane = createAkiLane();
  lane.configure({ concurrency: 1, timeoutMs: TIMEOUT_MS });
  const t0 = Date.now();
  try {
    const text = await lane.ask(PROMPT, { requestId: 'aki-smoke' });
    const st = lane.stats();
    console.log('[aki-smoke] latency: ' + (Date.now() - t0) + 'ms');
    console.log('[aki-smoke] tools used: ' + st.toolsUsed + ' ' + _toolList(st.lastTools));
    console.log('[aki-smoke] text: ' + JSON.stringify(text));
    return /PONG/.test(String(text)) ? 0 : 1;
  } catch (e) {
    const st = lane.stats();
    console.log('[aki-smoke] latency: ' + (Date.now() - t0) + 'ms');
    console.log('[aki-smoke] tools used: ' + st.toolsUsed + ' ' + _toolList(st.lastTools));
    console.log('[aki-smoke] FAILED: ' + (e && (e.code || e.message)));
    return e && e.code === 'AKI_NOT_FOUND' ? 2 : 1;
  }
}

async function viaRelay() {
  const relay = require('../src/orcha/relay');
  relay.setPreference('aki');
  relay.__test__.setAkiFlags({ enabled: true });
  const t0 = Date.now();
  try {
    const text = await relay.ask(PROMPT, { source: 'aki_smoke' });
    let via = '(unknown)';
    try { via = (require('../src/ai/trace').gatewayRecent(1)[0] || {}).via || via; } catch (_) {}
    console.log('[aki-smoke] relay latency: ' + (Date.now() - t0) + 'ms');
    console.log('[aki-smoke] via: ' + via);
    console.log('[aki-smoke] text: ' + JSON.stringify(text));
    return /PONG/.test(String(text)) ? 0 : 1;
  } catch (e) {
    console.log('[aki-smoke] relay latency: ' + (Date.now() - t0) + 'ms');
    console.log('[aki-smoke] FAILED: ' + (e && (e.code || e.message)));
    const q = relay.queueStats ? relay.queueStats() : null;
    return q && q.akiLane && q.akiLane.state === 'not-found' ? 2 : 1;
  }
}

(process.argv.includes('--relay') ? viaRelay() : direct())
  .then((code) => process.exit(code))
  .catch((e) => { console.log('[aki-smoke] FAILED: ' + (e && e.message)); process.exit(1); });
