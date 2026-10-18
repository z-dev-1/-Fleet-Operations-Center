'use strict';
/**
 * src/ai/budget.js — Request budget manager for the AI Core agent loop (spec §1).
 *
 * Bounds a single AI Core request so no agent loop can run unbounded:
 *   - maxToolCalls   (default 6)
 *   - maxModelTurns  (default 4)
 *   - maxElapsedMs   (task-specific; default 45s)
 *   - maxEvidenceBytes (configurable cap on accumulated evidence)
 *
 * A Budget instance is created per request. It tracks consumption and answers
 * can-I-continue questions; it never throws — callers check its booleans and
 * stop cleanly, returning partial verified evidence (spec: stop cleanly, never
 * execute an unverified action when a budget is exceeded).
 */

const DEFAULTS = {
  maxToolCalls: 6,
  maxModelTurns: 4,
  maxElapsedMs: 45000,
  maxEvidenceBytes: 48000,
};

class Budget {
  constructor(opts) {
    opts = opts || {};
    this.limits = {
      maxToolCalls: _posInt(opts.maxToolCalls, DEFAULTS.maxToolCalls),
      maxModelTurns: _posInt(opts.maxModelTurns, DEFAULTS.maxModelTurns),
      maxElapsedMs: _posInt(opts.maxElapsedMs, DEFAULTS.maxElapsedMs),
      maxEvidenceBytes: _posInt(opts.maxEvidenceBytes, DEFAULTS.maxEvidenceBytes),
    };
    this.startedAt = Date.now();
    this.toolCalls = 0;
    this.modelTurns = 0;
    this.evidenceBytes = 0;
    this.stops = []; // reasons a limit was hit (for the trace)
  }

  elapsedMs() { return Date.now() - this.startedAt; }
  remainingMs() { return Math.max(0, this.limits.maxElapsedMs - this.elapsedMs()); }

  // Can another TOOL call be made? (budget + time)
  canCallTool() {
    if (this.toolCalls >= this.limits.maxToolCalls) return this._no('maxToolCalls');
    if (this.elapsedMs() >= this.limits.maxElapsedMs) return this._no('maxElapsedMs');
    if (this.evidenceBytes >= this.limits.maxEvidenceBytes) return this._no('maxEvidenceBytes');
    return true;
  }
  // How many tool calls remain (for bounding a parallel batch).
  toolCallsRemaining() { return Math.max(0, this.limits.maxToolCalls - this.toolCalls); }

  // Can another MODEL turn be made? (budget + time)
  canModelTurn() {
    if (this.modelTurns >= this.limits.maxModelTurns) return this._no('maxModelTurns');
    if (this.elapsedMs() >= this.limits.maxElapsedMs) return this._no('maxElapsedMs');
    return true;
  }

  countToolCall(n) { this.toolCalls += (n || 1); }
  countModelTurn() { this.modelTurns += 1; }
  // Add evidence bytes; returns true if still within the cap AFTER adding.
  addEvidenceBytes(n) {
    this.evidenceBytes += Math.max(0, n || 0);
    return this.evidenceBytes <= this.limits.maxEvidenceBytes;
  }

  _no(reason) { if (!this.stops.includes(reason)) this.stops.push(reason); return false; }

  // A compact summary for the AI trace.
  summary() {
    return {
      toolCalls: this.toolCalls,
      modelTurns: this.modelTurns,
      evidenceBytes: this.evidenceBytes,
      elapsedMs: this.elapsedMs(),
      limits: { ...this.limits },
      stops: this.stops.slice(),
    };
  }
}

function _posInt(v, dflt) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt; }

module.exports = { Budget, DEFAULTS };
