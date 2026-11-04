'use strict';
/**
 * cluster/run-standby.js — headless standby launcher for the DevSpace.
 *
 * The long-running process you start on the DevSpace to make it behave like the
 * app's background worker: it boots the cluster (lease/failover + sync + AEA
 * keep-alive) and the standby-daemon (Slack polls + fleet refresh), then stays
 * alive. All production work is leader-gated, so while the laptop is up this
 * process sits as a warm standby doing nothing but syncing + staying authed;
 * when the laptop goes down it takes over.
 *
 * RUN (on the DevSpace, from ~/fleet):
 *   FLEET_CLUSTER=1 FLEET_CLUSTER_MODE=STANDBY \
 *   FLEET_HEADLESS_BROWSER=1 FLEET_AEA_KEEPALIVE=1 FLEET_STANDBY_DAEMON=1 \
 *   FLEET_COORD_URL=http://127.0.0.1:7811 \
 *   node src/cluster/run-standby.js
 *
 *   (FLEET_COORD_URL points at the shared coordinator so the laptop and the box
 *   coordinate leadership through ONE record. Without it the box runs its own
 *   local coordinator and will consider ITSELF the only instance — fine for a
 *   solo test, but then it's always leader, so set it for real failover.)
 *
 * Background it so closing the terminal doesn't kill it:
 *   nohup FLEET_...=... node src/cluster/run-standby.js > ~/standby.log 2>&1 &
 */

const logger = (() => { try { return require('../utils/logger')('run-standby'); } catch (_) { return console; } })();

async function main() {
  const cluster = require('./index');
  const daemon = require('./standby-daemon');

  // Boot the cluster. Mode/flag come from env (FLEET_CLUSTER / FLEET_CLUSTER_MODE
  // / FLEET_COORD_URL), resolved inside init(). force:true so a re-run re-inits.
  cluster.init({ force: true });
  const status = cluster.getStatus();
  logger.info('[run-standby] cluster: enabled=' + status.enabled + ' role=' + status.role +
    ' coord=' + status.coordKind + ' caps=' + JSON.stringify(status.capabilities));

  if (!status.enabled) {
    logger.warn('[run-standby] cluster is DISABLED (set FLEET_CLUSTER=1) — nothing to run. Exiting.');
    process.exit(1);
  }

  // Start the lease/failover + sync + AEA keep-alive loops.
  cluster.start();
  // Start the background work loops (Slack polls + fleet refresh), leader-gated.
  const d = daemon.start({ force: true });
  logger.info('[run-standby] standby-daemon: ' + JSON.stringify(d));

  // Heartbeat log so `tail -f ~/standby.log` shows it's alive + who's leader.
  const beat = setInterval(async () => {
    try {
      const dash = await cluster.getDashboard();
      const leader = dash.leader ? (dash.leader.isSelf ? 'SELF' : dash.leader.instanceId) : '(none)';
      logger.info('[run-standby] alive — role=' + dash.self.role + ' isLeader=' + dash.self.isLeader +
        ' leader=' + leader + ' mayProduce=' + cluster.mayRunProduction() +
        ' daemon=' + JSON.stringify(daemon.getState().lastTick));
    } catch (e) { logger.warn('[run-standby] heartbeat error: ' + e.message); }
  }, 60000);
  if (beat.unref) { /* keep process alive via the loops, not this */ }

  // Clean shutdown.
  const shutdown = async (sig) => {
    logger.info('[run-standby] ' + sig + ' — shutting down');
    clearInterval(beat);
    try { daemon.stop(); } catch (_) {}
    try { await cluster.stop(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('[run-standby] running — leader-gated. Ctrl-C to stop.');
}

main().catch((e) => { logger.error('[run-standby] fatal: ' + (e && e.message)); process.exit(1); });
