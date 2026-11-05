'use strict';
// src/justme-context/extract-worker.js — extraction worker entry (design §8.1).
// Runs in an Electron utilityProcess in production (process.parentPort) and in a
// plain Node child_process.fork in tests (process.send). It is the ONLY place that
// loads the parser libraries. One job at a time. It never logs and replies with
// fixed REASONS keys plus an errCode (a code/name, never e.message); the host
// starts it with stdio 'ignore' as well.
//
// job:   { id, name, mimetype, buffer:Uint8Array, limits? }
// reply: { id, ok, kind, text, truncated, reason?, errCode?, meta?, needsVision?, image? }

const { LIMITS, REASONS } = require('./constants');
const { errTag } = require('./log-safe');

const MAX_JOB_BYTES = 25 * 1024 * 1024;

function _validJob(job) {
  return job && typeof job === 'object' && typeof job.id === 'number' && typeof job.name === 'string' && job.name.length <= 255 &&
    typeof job.mimetype === 'string' && job.mimetype.length <= 100 && job.buffer instanceof Uint8Array && job.buffer.byteLength <= MAX_JOB_BYTES;
}

async function runJob(job) {
  const id = job && typeof job.id === 'number' ? job.id : -1;
  if (!_validJob(job)) return { id, ok: false, text: '', truncated: false, reason: 'INVALID_JOB' };
  try {
    const { extractBuffer } = require('./extract');
    const maxChars = job.limits && Number.isFinite(job.limits.maxChars) ? Math.min(job.limits.maxChars, LIMITS.RAW_TEXT_MAX_CHARS) : LIMITS.RAW_TEXT_MAX_CHARS;
    const buf = Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength);
    const r = await extractBuffer({ buffer: buf, name: job.name, mimetype: job.mimetype }, { maxChars }, {});
    const reply = { id, ok: !!r.ok, kind: r.kind, text: r.text || '', truncated: !!r.truncated };
    if (r.reason && Object.prototype.hasOwnProperty.call(REASONS, r.reason)) reply.reason = r.reason;
    else if (!r.ok) reply.reason = 'PARSE_FAILED';
    if (r.errCode) reply.errCode = String(r.errCode).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    if (r.meta) reply.meta = r.meta;
    if (r.needsVision) reply.needsVision = true;
    if (r.image) reply.image = { name: String(r.image.name || '').slice(0, 255), mimetype: r.image.mimetype, buffer: new Uint8Array(r.image.buffer) };   // copy: a Buffer view would clone its whole pooled ArrayBuffer
    return reply;
  } catch (e) {
    return { id, ok: false, text: '', truncated: false, reason: 'PARSE_FAILED', errCode: errTag(e) };
  }
}

function start() {
  const port = process.parentPort;                  // Electron utilityProcess
  const send = port ? (m) => port.postMessage(m) : (m) => process.send(m);
  const onMessage = port ? (fn) => port.on('message', (e) => fn(e.data)) : (fn) => process.on('message', fn);
  let busy = Promise.resolve();
  // One job at a time: later messages wait for the earlier one.
  onMessage((job) => { busy = busy.then(async () => { send(await runJob(job)); }); });
  process.on('uncaughtException', () => process.exit(1));
  process.on('unhandledRejection', () => process.exit(1));
}

if (process.parentPort || (require.main === module && typeof process.send === 'function')) start();

module.exports = { runJob };
