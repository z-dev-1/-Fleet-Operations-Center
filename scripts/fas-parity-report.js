'use strict';
/**
 * scripts/fas-parity-report.js — Digital FAS SHADOW parity report.
 *
 * Summarizes the shadow-mode audit log (fasAuditLog) so you can judge whether
 * the Digital FAS agent has reached PARITY with the legacy engines before
 * retiring them (Phase 8). In shadow mode, every inbound message produces a FAS
 * draft + the legacy actualReply + a divergence score (0 = identical wording,
 * 1 = completely different); nothing is sent or mutated.
 *
 * Usage (from the repo root):
 *   node scripts/fas-parity-report.js            # summary over the whole log
 *   node scripts/fas-parity-report.js --n 20     # also print the 20 most-diverged samples
 *   node scripts/fas-parity-report.js --since 2026-10-19   # only entries on/after a date
 *
 * Read-only. Points at the Electron userData store the running app writes.
 */
const path = require('path');
const dataDir = process.env.FAS_DATA_DIR || path.join(process.env.APPDATA || '', 'fleet-ops-app');
require('../src/config/paths').setDataDir(dataDir);
const store = require('../src/store');

function arg(name, def) { const i = process.argv.indexOf(name); return i > -1 ? (process.argv[i + 1] || def) : def; }

const sampleN = parseInt(arg('--n', '0'), 10) || 0;
const since = arg('--since', '');
const sinceMs = since ? Date.parse(since) : 0;

const log = store.load('fasAuditLog', []);
let entries = Array.isArray(log) ? log : [];
if (sinceMs) entries = entries.filter(e => Date.parse(e.at || e.ts || 0) >= sinceMs);

if (!entries.length) {
  console.log('No fasAuditLog entries' + (since ? (' since ' + since) : '') + '. (Is FAS enabled in shadow mode, and has any Slack traffic arrived?)');
  process.exit(0);
}

const shadow = entries.filter(e => e.mode === 'shadow');
const n = shadow.length;
const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

// Divergence distribution (lower = closer to the legacy reply).
const divs = shadow.map(e => typeof e.divergence === 'number' ? e.divergence : null).filter(v => v != null);
const buckets = { 'identical (<=0.1)': 0, 'close (0.1-0.3)': 0, 'moderate (0.3-0.6)': 0, 'divergent (>0.6)': 0 };
for (const d of divs) {
  if (d <= 0.1) buckets['identical (<=0.1)']++;
  else if (d <= 0.3) buckets['close (0.1-0.3)']++;
  else if (d <= 0.6) buckets['moderate (0.3-0.6)']++;
  else buckets['divergent (>0.6)']++;
}

// Outcome + decision + reasonCode tallies.
const tally = (key) => shadow.reduce((m, e) => { const k = e[key] || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
const aiFailures = shadow.filter(e => e.outcome === 'ai-failed-shadow').length;
const emptyDrafts = shadow.filter(e => !e.fasReply || !String(e.fasReply).trim()).length;
const avgConf = avg(shadow.map(e => typeof e.fasConfidence === 'number' ? e.fasConfidence : 0).filter(Boolean));

console.log('='.repeat(64));
console.log('DIGITAL FAS — SHADOW PARITY REPORT');
console.log('dataDir: ' + dataDir);
console.log('='.repeat(64));
console.log('shadow entries: ' + n + (since ? ('  (since ' + since + ')') : ''));
console.log('AI failures (ai-failed-shadow): ' + aiFailures + '   empty drafts: ' + emptyDrafts);
console.log('avg FAS confidence: ' + avgConf.toFixed(2));
console.log('avg divergence vs legacy: ' + (divs.length ? avg(divs).toFixed(3) : 'n/a') + '  (0=identical, 1=different)');
console.log('\nDivergence distribution:');
for (const [k, v] of Object.entries(buckets)) console.log('  ' + k.padEnd(22) + v + '  (' + (n ? Math.round(v / divs.length * 100) : 0) + '%)');
console.log('\nBy surface (engine):'); for (const [k, v] of Object.entries(tally('engine'))) console.log('  ' + String(k).padEnd(14) + v);
console.log('\nFAS decision types:'); for (const [k, v] of Object.entries(tally('fasDecision'))) console.log('  ' + String(k).padEnd(14) + v);
console.log('\nCommunication reasonCodes:'); for (const [k, v] of Object.entries(tally('reasonCode'))) console.log('  ' + String(k).padEnd(28) + v);
console.log('\nReply placement:'); for (const [k, v] of Object.entries(tally('replyPlacement'))) console.log('  ' + String(k).padEnd(14) + v);
console.log('\nAudience sensitivity:'); for (const [k, v] of Object.entries(tally('audienceSensitivity'))) console.log('  ' + String(k).padEnd(26) + v);

// PARITY READINESS heuristic (advisory only — the operator decides).
const closeShare = divs.length ? (buckets['identical (<=0.1)'] + buckets['close (0.1-0.3)']) / divs.length : 0;
const failRate = n ? (aiFailures + emptyDrafts) / n : 1;
console.log('\n' + '-'.repeat(64));
console.log('PARITY READINESS (advisory):');
console.log('  close-or-identical share: ' + Math.round(closeShare * 100) + '%   failure rate: ' + Math.round(failRate * 100) + '%');
const ready = n >= 30 && failRate <= 0.05 && closeShare >= 0.6;
console.log('  -> ' + (ready
  ? 'LOOKS READY for Phase 8 (>=30 samples, <=5% failures, >=60% close). Review the diverged samples below first.'
  : 'NOT YET — gather more shadow traffic / investigate failures or high divergence before retiring legacy.'));

if (sampleN > 0) {
  const sorted = shadow.filter(e => typeof e.divergence === 'number').sort((a, b) => b.divergence - a.divergence).slice(0, sampleN);
  console.log('\n' + '='.repeat(64));
  console.log('TOP ' + sampleN + ' MOST-DIVERGED SAMPLES (review these for parity gaps):');
  console.log('='.repeat(64));
  for (const e of sorted) {
    console.log('\n[' + (e.at || '?') + '] ' + (e.engine || '?') + '  divergence=' + (e.divergence != null ? e.divergence.toFixed(3) : '?') + '  conf=' + (e.fasConfidence != null ? e.fasConfidence : '?'));
    console.log('  MSG:    ' + String(e.message || '').slice(0, 160));
    console.log('  LEGACY: ' + String(e.actualReply || '').slice(0, 220));
    console.log('  FAS:    ' + String(e.fasReply || '').slice(0, 220));
    if (e.reasonCode) console.log('  reason: ' + e.reasonCode + '  placement=' + (e.replyPlacement || '?') + '  audience=' + (e.audienceSensitivity || '?'));
  }
}
console.log('');
