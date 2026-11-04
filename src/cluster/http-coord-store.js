'use strict';
/**
 * cluster/http-coord-store.js — HTTP coordination-store client (Stage 8).
 *
 * Implements the SAME contract as LocalCoordStore (getLeadership /
 * tryAcquireLeadership / renewLeadership / heartbeat / releaseLeadership /
 * appendEvent / readEventsSince / now), but instead of a local SQLite doc it
 * talks to a SHARED coordinator service over HTTP. That shared service (see
 * coord-server.js, hosted on the always-on DevSpace) is what lets the laptop
 * and the DevSpace actually contend for ONE lease and sync through ONE event
 * log — i.e. REAL cross-machine failover, not two isolated local records.
 *
 * Because it implements the identical interface, the lease manager + sync
 * engine use it UNCHANGED — only the backend swaps (LocalCoordStore ↔
 * HttpCoordStore), per the pluggable design from Stage 1.
 *
 * ROBUSTNESS: the coordinator may be briefly unreachable (network blip, the
 * DevSpace restarting). Every call has a short timeout and, on failure, returns
 * a SAFE result that makes the caller FAIL CLOSED rather than wrongly assume
 * leadership:
 *   - getLeadership() on error → returns the last-known record (so a leader
 *     keeps its own view) or null.
 *   - tryAcquireLeadership()/renewLeadership() on error → { ok:false } so we do
 *     NOT believe we hold/took the lease we couldn't confirm. A leader that
 *     can't reach the coordinator will fail its renew → demote → stop
 *     production writes (fail closed). This upholds the spec's "if leadership
 *     cannot be safely established, fail closed for production writes."
 *
 * AUTH: an optional shared token (opts.token / FLEET_COORD_TOKEN) is sent as a
 * Bearer header so only authorized instances can mutate coordination state.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
let logger; try { logger = require('../utils/logger')('cluster-http'); } catch (_) { logger = { info() {}, warn() {} }; }

class HttpCoordStore {
  /**
   * @param {object} opts
   *   baseUrl  — e.g. 'http://127.0.0.1:7801' or the DevSpace proxy URL
   *   token    — optional shared bearer token (else FLEET_COORD_TOKEN)
   *   timeoutMs — per-request timeout (default 8000)
   *   now()    — clock (defaults to Date.now; the AUTHORITATIVE clock for lease
   *              expiry is the SERVER's, returned in responses, but local now()
   *              is used where a client-side timestamp is acceptable)
   */
  constructor(opts) {
    opts = opts || {};
    this.baseUrl = (opts.baseUrl || process.env.FLEET_COORD_URL || '').replace(/\/+$/, '');
    this.token = opts.token || process.env.FLEET_COORD_TOKEN || '';
    this.timeoutMs = opts.timeoutMs || 8000;
    this._now = opts.now || (() => Date.now());
    this._lastLeadership = null;   // cached for degrade-safe getLeadership()
    if (!this.baseUrl) throw new Error('HttpCoordStore requires a baseUrl (FLEET_COORD_URL)');
  }

  now() { return this._now(); }

  _request(method, pathName, body) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(this.baseUrl + pathName); } catch (e) { return resolve({ ok: false, error: 'bad url: ' + e.message }); }
      const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method,
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          payload ? { 'Content-Length': payload.length } : {},
          this.token ? { 'Authorization': 'Bearer ' + this.token } : {}
        ),
      }, (res) => {
        let data = '';
        res.on('data', (c) => { if (data.length < 5 * 1024 * 1024) data += c; });
        res.on('end', () => {
          // Parse the body even on non-2xx so typed conflicts (409 STALE_LEADER)
          // surface to the caller instead of a generic 'http 409'.
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = null; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, status: res.statusCode, error: 'http ' + res.statusCode, body: parsed });
          }
          if (parsed === null) return resolve({ ok: false, error: 'bad json' });
          resolve({ ok: true, body: parsed });
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.setTimeout(this.timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async getLeadership() {
    const r = await this._request('GET', '/leadership');
    if (!r.ok) { logger.warn('[cluster-http] getLeadership degraded: ' + r.error); return this._lastLeadership; }
    this._lastLeadership = r.body && r.body.record ? r.body.record : null;
    return this._lastLeadership;
  }

  async tryAcquireLeadership(instanceId, mode, leaseMs, opts) {
    const r = await this._request('POST', '/leadership/acquire', { instanceId, mode, leaseMs, opts: opts || {} });
    if (!r.ok) { logger.warn('[cluster-http] acquire failed (fail-closed): ' + r.error); return { ok: false, record: this._lastLeadership, reason: 'coordinator-unreachable' }; }
    if (r.body && r.body.record) this._lastLeadership = r.body.record;
    return r.body;
  }

  async renewLeadership(instanceId, token, leaseMs) {
    const r = await this._request('POST', '/leadership/renew', { instanceId, token, leaseMs });
    if (!r.ok) { logger.warn('[cluster-http] renew failed (fail-closed): ' + r.error); return { ok: false, record: this._lastLeadership, reason: 'coordinator-unreachable' }; }
    if (r.body && r.body.record) this._lastLeadership = r.body.record;
    return r.body;
  }

  async heartbeat(instanceId, token) {
    const r = await this._request('POST', '/leadership/heartbeat', { instanceId, token });
    if (!r.ok) return { ok: false };
    if (r.body && r.body.record) this._lastLeadership = r.body.record;
    return r.body;
  }

  async releaseLeadership(instanceId, token) {
    const r = await this._request('POST', '/leadership/release', { instanceId, token });
    if (!r.ok) return { ok: false };
    return r.body;
  }

  async appendEvent(evt) {
    const r = await this._request('POST', '/events/append', evt);
    if (!r.ok) {
      // Item 3: a 409 STALE_LEADER means the coordinator fenced us out — we are
      // no longer the valid leader (someone else holds a higher token). Surface
      // it typed so the lease loop can demote/fail closed, NOT retry.
      if (r.status === 409 && r.body && r.body.error) {
        logger.warn('[cluster-http] appendEvent fenced: ' + r.body.error + ' currentToken=' + r.body.currentToken);
        return { ok: false, fenced: true, error: r.body.error, currentLeader: r.body.currentLeader, currentToken: r.body.currentToken };
      }
      logger.warn('[cluster-http] appendEvent failed: ' + r.error);
      return { ok: false, seq: 0 };
    }
    return r.body;
  }

  async readEventsSince(seq, limit) {
    const r = await this._request('GET', '/events?since=' + (seq || 0) + '&limit=' + (limit || 1000));
    if (!r.ok) { logger.warn('[cluster-http] readEventsSince failed: ' + r.error); return { events: [], lastSeq: seq || 0, _degraded: true }; }
    return r.body;   // includes oldestSeq + now from the coordinator (items 4/6)
  }

  // Liveness probe for the dashboard / startup check. Returns the coordinator's
  // authoritative `now` + head seq when reachable, { ok:false } otherwise.
  async ping() { const r = await this._request('GET', '/health'); return r.ok ? (r.body || { ok: true }) : { ok: false, error: r.error }; }
}

module.exports = { HttpCoordStore };
