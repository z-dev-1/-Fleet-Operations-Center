'use strict';
/**
 * cluster/coord-server.js — shared coordination SERVICE (Stage 8).
 *
 * The always-on coordinator both instances point at. It owns the ONE
 * authoritative leadership record + event log, so the laptop and the DevSpace
 * genuinely contend for a single lease and sync through a single log — real
 * cross-machine failover. It is intentionally tiny: a plain Node HTTP server
 * wrapping a LocalCoordStore (its own SQLite in its own data dir). No Electron.
 *
 * Hosted on the DevSpace (always-on, confirmed), reachable by the laptop via
 * the DevSpace port-proxy (e.g. https://ds-...--7801.<...>.devspaces.amazon.dev).
 *
 * ENDPOINTS (all JSON):
 *   GET  /health
 *   GET  /leadership
 *   POST /leadership/acquire    { instanceId, mode, leaseMs, opts }
 *   POST /leadership/renew      { instanceId, token, leaseMs }
 *   POST /leadership/heartbeat  { instanceId, token }
 *   POST /leadership/release    { instanceId, token }
 *   POST /events/append         { key, version, doc, instanceId, token, ts }
 *   GET  /events?since=N&limit=M
 *
 * AUTH: if FLEET_COORD_TOKEN is set, every request must carry
 * `Authorization: Bearer <token>` (same token the HttpCoordStore sends).
 * Without it the server runs open (fine for a private port-proxy, but set a
 * token for anything exposed).
 *
 * RUN:  node src/cluster/coord-server.js
 *   env: FLEET_COORD_PORT (default 7801), FLEET_COORD_TOKEN, FLEET_COORD_DATA
 *        (data dir for the coordinator's own SQLite; default a dedicated dir)
 */

const http = require('http');
let logger; try { logger = require('../utils/logger')('coord-server'); } catch (_) { logger = { info: console.log, warn: console.warn, error: console.error }; }

function _envInt(name, def) { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v > 0 ? v : def; }

// Build the backing LocalCoordStore against a DEDICATED data dir so the
// coordinator's record never collides with a local app/standby store on the
// same host. Uses setDataDir before requiring the store path getters.
function _makeBackingStore() {
  const path = require('path');
  const os = require('os');
  const paths = require('../config/paths');
  const dir = process.env.FLEET_COORD_DATA || path.join(os.homedir(), '.fleet-coord');
  paths.setDataDir(dir);
  const store = require('../store');
  const { LocalCoordStore } = require('./coord-store');
  logger.info('[coord-server] data dir ' + dir);
  return new LocalCoordStore({ store });
}

function _readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { if (data.length < 5 * 1024 * 1024) data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Stamp the coordinator's authoritative clock onto a leadership response.
function _withNow(coord, obj) {
  if (obj && typeof obj === 'object') { try { obj.now = coord.now(); } catch (_) {} }
  return obj;
}

// Current event-log head sequence (best-effort).
async function _headSeq(coord) {
  try { const r = await coord.readEventsSince(Number.MAX_SAFE_INTEGER - 1, 1); return r && typeof r.lastSeq === 'number' ? r.lastSeq : 0; }
  catch (_) { return 0; }
}

// Item 3 — coordinator-side fencing of event appends. The coordinator reads its
// OWN authoritative leadership record and only accepts the append if the writer
// is the CURRENT leader holding the CURRENT fencing token AND the lease has not
// expired by coordinator time. Otherwise returns a typed STALE_LEADER conflict.
async function _fenceWrite(coord, body) {
  const rec = await coord.getLeadership();
  const now = coord.now();
  const curLeader = rec && rec.leader;
  const curToken = rec && rec.fencingToken;
  const leaseLive = rec && rec.expiresAt && rec.expiresAt > now;
  if (!rec || !curLeader || !leaseLive) {
    return { ok: false, error: 'NO_LIVE_LEADER', currentLeader: curLeader || null, currentToken: curToken != null ? curToken : null, now };
  }
  if (body.instanceId !== curLeader || body.token !== curToken) {
    return { ok: false, error: 'STALE_LEADER', currentLeader: curLeader, currentToken: curToken, now };
  }
  return { ok: true };
}

function createServer(opts) {
  opts = opts || {};
  const coord = opts.coord || _makeBackingStore();
  const token = opts.token || process.env.FLEET_COORD_TOKEN || '';

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj || {});
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      // Auth gate (if a token is configured).
      if (token) {
        const auth = req.headers['authorization'] || '';
        if (auth !== 'Bearer ' + token) return send(401, { error: 'unauthorized' });
      }
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;

      // Item 4: coordinator time is AUTHORITATIVE — every response that affects
      // lease decisions carries the server's `now` so clients can detect skew
      // and never let a local clock decide another machine's lease expired.
      if (req.method === 'GET' && p === '/health') return send(200, { ok: true, now: coord.now(), headSeq: await _headSeq(coord), ts: new Date().toISOString() });
      if (req.method === 'GET' && p === '/leadership') { const record = await coord.getLeadership(); return send(200, { record, now: coord.now(), headSeq: await _headSeq(coord) }); }
      if (req.method === 'GET' && p === '/events') {
        const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
        const limit = parseInt(u.searchParams.get('limit') || '1000', 10) || 1000;
        const out = await coord.readEventsSince(since, limit);
        // Item 6: expose the OLDEST retained seq so a client can detect a
        // sync gap (its cursor fell behind the capped window).
        if (typeof coord.oldestSeq === 'function') { try { out.oldestSeq = await coord.oldestSeq(); } catch (_) {} }
        out.now = coord.now();
        return send(200, out);
      }
      if (req.method === 'POST') {
        const body = await _readBody(req);
        if (p === '/leadership/acquire') return send(200, _withNow(coord, await coord.tryAcquireLeadership(body.instanceId, body.mode, body.leaseMs, body.opts)));
        if (p === '/leadership/renew') return send(200, _withNow(coord, await coord.renewLeadership(body.instanceId, body.token, body.leaseMs)));
        if (p === '/leadership/heartbeat') return send(200, _withNow(coord, await coord.heartbeat(body.instanceId, body.token)));
        if (p === '/leadership/release') return send(200, _withNow(coord, await coord.releaseLeadership(body.instanceId, body.token)));
        if (p === '/events/append') {
          // Item 3: the COORDINATOR independently fences event writes — a write
          // from a non-leader or a stale token is rejected with 409 STALE_LEADER,
          // regardless of client-side checks. A paused laptop (token 42) can
          // never append after the DevSpace takes over (token 43).
          const fence = await _fenceWrite(coord, body);
          if (!fence.ok) return send(409, fence);
          return send(200, await coord.appendEvent(body));
        }
      }
      send(404, { error: 'not found' });
    } catch (e) {
      logger.warn('[coord-server] request error: ' + (e && e.message));
      send(500, { error: e && e.message });
    }
  });

  return { server, coord };
}

function main() {
  const port = _envInt('FLEET_COORD_PORT', 7801);
  const { server } = createServer();
  server.listen(port, () => logger.info('[coord-server] listening on :' + port + (process.env.FLEET_COORD_TOKEN ? ' (auth on)' : ' (no auth)')));
  const shutdown = (sig) => { logger.info('[coord-server] ' + sig + ' — closing'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createServer, main };
