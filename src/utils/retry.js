'use strict';
/**
 * src/utils/retry.js — Exponential-backoff retry wrapper
 *
 * withRetry(fn, opts) — wraps an async function with up to N attempts,
 * exponential backoff between failures, and structured logging.
 *
 * Stage 5 H-1: applied to relay.js scrapeUnitPage and sharepoint_push.js
 * ensureSpAuth / getDigest — the two highest-value retry points in the app.
 *
 * opts:
 *   attempts  {number}  Total attempts including the first (default: 2)
 *   backoffMs {number}  Delay after first failure in ms (default: 2000)
 *                       Doubles on each subsequent failure (exponential).
 *   label     {string}  Human-readable label for log lines (default: 'op')
 *
 * Returns:    The resolved value of fn() on the first successful attempt.
 * Throws:     A RetryExhaustedError (extends Error) after all attempts fail.
 *             err.attempts  — number of attempts made
 *             err.lastError — the last underlying Error thrown by fn
 */

const logger = require('./logger')('retry');

class RetryExhaustedError extends Error {
  constructor(label, attempts, lastError) {
    super(`[${label}] failed after ${attempts} attempt(s): ${lastError.message}`);
    this.name       = 'RetryExhaustedError';
    this.label      = label;
    this.attempts   = attempts;
    this.lastError  = lastError;
  }
}

/**
 * @param {() => Promise<any>} fn        Async function to retry
 * @param {object}             [opts]
 * @param {number}             [opts.attempts=2]
 * @param {number}             [opts.backoffMs=2000]
 * @param {string}             [opts.label='op']
 * @returns {Promise<any>}
 */
async function withRetry(fn, opts = {}) {
  const attempts  = (typeof opts.attempts  === 'number' && opts.attempts  >= 1) ? opts.attempts  : 2;
  const backoffMs = (typeof opts.backoffMs === 'number' && opts.backoffMs >= 0) ? opts.backoffMs : 2000;
  const label     = opts.label || 'op';

  let lastError;
  let delay = backoffMs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        logger.warn(`[${label}] attempt ${attempt}/${attempts} failed: ${err.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        delay = delay * 2;   // exponential: 2s, 4s, 8s, ...
      } else {
        logger.warn(`[${label}] attempt ${attempt}/${attempts} failed: ${err.message} — exhausted`);
      }
    }
  }

  throw new RetryExhaustedError(label, attempts, lastError);
}

module.exports = { withRetry, RetryExhaustedError };
