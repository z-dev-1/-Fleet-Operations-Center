'use strict';
/**
 * cluster/standby.js — headless standby entry point (Stage 5).
 *
 * This is the process the Amazon DevSpace (or any headless host) RUNS to be the
 * always-on standby. It is NOT Electron — pure Node — so it needs no display.
 * It boots the cluster coordination layer, joins as a STANDBY (or ACTIVE if
 * explicitly told), runs the heartbeat/lease loop + the periodic sync pull, and
 * stays alive until signalled.
 *
 * WHAT IT DOES
 *   - init() the cluster (flag forced ON here — this process exists only to run
 *     the standby), auto-detecting capabilities (browser:false on a headless
 *     box → browser/AEA/SP production tasks fail closed, by design).
 *   - start() the lease loop: as a STANDBY it never acquires leadership while a
 *     live leader exists; if the leader's lease EXPIRES (laptop asleep/off/
 *     crashed), it atomically takes over (CAS + fencing) and begins doing the
 *     headless-safe production work the mode gate permits.
 *   - run a periodic sync pull so it always holds the latest committed state
 *     synced from the leader (and catches up after any disconnect).
 *   - print a periodic status line so `logs`/stdout shows it's alive + its role.
 *   - on SIGINT/SIGTERM: gracefully stop (releases the lease so leadership can
 *     hand back fast) and exit.
 *
 * RUN:
 *   node src/cluster/standby.js
 *   # env knobs:
 *   FLEET_CLUSTER_MODE=STANDBY|ACTIVE   (default STANDBY)
 *   FLEET_CLUSTER_LEASE_MS, FLEET_CLUSTER_HB_MS, FLEET_CLUSTER_POLL_MS,
 *   FLEET_CLUSTER_SYNC_MS, FLEET_CLUSTER_STATUS_MS
 *
 * NOTE: This entry point only runs the COORDINATION + SYNC + headless-safe
 * standby duties. It does NOT boot the Electron app, open windows, or attempt
 * browser automation — those are physically impossible on a headless host and
 * correctly fail closed via the mode gate.
 */

const cluster = require('./index');
let logger; try { logger = require('../utils/logger')('cluster-standby'); } catch (_) { logger = { info: console.log, warn: console.warn, error: console.error }; }

function _envInt(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

async function main() {
  const mode = (process.env.FLEET_CLUSTER_MODE && cluster.MODES.includes(process.env.FLEET_CLUSTER_MODE))
    ? process.env.FLEET_CLUSTER_MODE : 'STANDBY';
  const leaseMs = _envInt('FLEET_CLUSTER_LEASE_MS', 30000);
  const heartbeatMs = _envInt('FLEET_CLUSTER_HB_MS', 10000);
  const pollMs = _envInt('FLEET_CLUSTER_POLL_MS', 5000);
  const syncMs = _envInt('FLEET_CLUSTER_SYNC_MS', 15000);
  const statusMs = _envInt('FLEET_CLUSTER_STATUS_MS', 30000);

  // Force the cluster ON for this process (it exists solely to run the standby).
  const st = cluster.init({ enabled: true, mode, force: true });
  logger.info('[standby] starting — instance=' + st.instanceId + ' mode=' + mode +
    ' browser=' + (st.capabilities && st.capabilities.browser) +
    ' lease=' + leaseMs + 'ms hb=' + heartbeatMs + 'ms sync=' + syncMs + 'ms');

  cluster.start({ leaseMs, heartbeatMs, pollMs, syncMs });

  // Periodic status heartbeat to stdout/log so the host shows it's alive + role.
  const statusTimer = setInterval(() => {
    const s = cluster.getStatus();
    const ls = cluster.getLeaseState();
    const sy = cluster.getSyncState();
    logger.info('[standby] status role=' + (ls ? ls.role : s.role) +
      ' leader=' + s.isLeader +
      ' token=' + (s.fencingToken == null ? '-' : s.fencingToken) +
      ' syncCursor=' + (sy ? sy.lastSyncSeq : 0) +
      ' lastHeartbeat=' + (s.lastHeartbeatAt ? new Date(s.lastHeartbeatAt).toISOString() : '-'));
  }, statusMs);
  if (statusTimer.unref) statusTimer.unref();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return; shuttingDown = true;
    logger.info('[standby] ' + sig + ' received — releasing lease and shutting down');
    clearInterval(statusTimer);
    try { await cluster.stop(); } catch (_) {}
    // Give logs a tick to flush, then exit.
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => { logger.error('[standby] uncaughtException: ' + (e && e.stack || e)); });
  process.on('unhandledRejection', (e) => { logger.error('[standby] unhandledRejection: ' + (e && e.stack || e)); });

  logger.info('[standby] running. Ctrl-C to stop.');
}

// Only run when invoked directly (node src/cluster/standby.js), not when required.
if (require.main === module) {
  main().catch((e) => { logger.error('[standby] FATAL: ' + (e && e.stack || e)); process.exit(1); });
}

module.exports = { main };
