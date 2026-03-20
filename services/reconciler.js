// services/reconciler.js - Reconcile DB state with K8s state
// Ensures pods and IngressRoutes exist for all containers that should be running
// Periodically detects OOM-killed, evicted, or crashed pods and restarts them

const { getDb } = require('../db');
const runtimeConfig = require('../config/runtime');
const k8sClient = require('./k8s-client');

// Check every 60 seconds for unhealthy pods
const WATCH_INTERVAL = 60 * 1000;
let watchTimer = null;

/**
 * Check if a pod is in an unhealthy state that needs restart
 */
function isUnhealthyPod(pod) {
  if (!pod?.status) return false;

  const phase = pod.status.phase;

  // Evicted pods
  if (phase === 'Failed' && pod.status.reason === 'Evicted') {
    return 'evicted';
  }

  // Check container statuses for OOMKilled or CrashLoopBackOff
  for (const cs of (pod.status.containerStatuses || [])) {
    if (cs.state?.waiting?.reason === 'CrashLoopBackOff') {
      // Only restart if OOMKilled was the last termination reason
      const lastReason = cs.lastState?.terminated?.reason;
      if (lastReason === 'OOMKilled') return 'oom-crashloop';
    }
    if (cs.state?.terminated?.reason === 'OOMKilled') {
      return 'oom-killed';
    }
  }

  return false;
}

/**
 * Reconcile container_configs DB state with actual K8s cluster state.
 *
 * For each container that should be running (sleep_state != 'stopped'):
 *   - If pod is missing: call startContainer to recreate it
 *   - If pod exists but IngressRoute is missing: call startContainer (which replaces routes)
 *   - If pod is OOM-killed/evicted: delete and recreate
 *
 * @returns {Promise<{started: number, routesFixed: number, restarted: number, errors: number}>}
 */
async function reconcileContainers() {
  console.log('[reconciler] Starting container reconciliation...');

  const summary = { started: 0, routesFixed: 0, restarted: 0, errors: 0 };

  const db = await getDb();
  const namespace = runtimeConfig.k8s.namespace;

  // Get all containers that should be running (not stopped)
  const rows = await db.all(
    `SELECT * FROM container_configs WHERE sleep_state != 'stopped' OR sleep_state IS NULL`
  );

  console.log(`[reconciler] Found ${rows.length} containers that should be running`);

  for (const row of rows) {
    const username = row.username;
    const podName = `student-${username}`;
    const email = `${username}@newpaltz.edu`;

    try {
      const pod = await k8sClient.getPod(podName, namespace);

      if (!pod) {
        // Pod is missing — recreate it
        console.log(`[reconciler] Pod ${podName} missing, starting container for ${username}`);
        try {
          const k8sContainers = require('./k8s-containers');
          await k8sContainers.startContainer(username, email, row);
          summary.started++;
          console.log(`[reconciler] Successfully started ${podName}`);
        } catch (startErr) {
          console.error(`[reconciler] Failed to start ${podName}:`, startErr.message);
          summary.errors++;
        }
        continue;
      }

      // Check for unhealthy pod states (OOM, eviction)
      const unhealthyReason = isUnhealthyPod(pod);
      if (unhealthyReason) {
        console.log(`[reconciler] Pod ${podName} is unhealthy (${unhealthyReason}), restarting...`);
        try {
          const k8sContainers = require('./k8s-containers');
          // Delete the broken pod first
          await k8sClient.deletePod(podName, { gracePeriodSeconds: 0 });
          // Wait for deletion
          for (let i = 0; i < 15; i++) {
            const check = await k8sClient.getPod(podName, namespace);
            if (!check) break;
            await new Promise(r => setTimeout(r, 1000));
          }
          // Recreate
          await k8sContainers.startContainer(username, email, row);
          summary.restarted++;
          console.log(`[reconciler] Successfully restarted ${podName} after ${unhealthyReason}`);
        } catch (restartErr) {
          console.error(`[reconciler] Failed to restart ${podName}:`, restartErr.message);
          summary.errors++;
        }
        continue;
      }

      // Pod exists and is healthy — check if IngressRoute exists
      const ingressRoute = await k8sClient.getIngressRoute(podName, namespace);

      if (!ingressRoute) {
        console.log(`[reconciler] IngressRoute ${podName} missing (pod exists), fixing routes for ${username}`);
        try {
          const k8sContainers = require('./k8s-containers');
          await k8sContainers.startContainer(username, email, row);
          summary.routesFixed++;
          console.log(`[reconciler] Successfully fixed routes for ${podName}`);
        } catch (routeErr) {
          console.error(`[reconciler] Failed to fix routes for ${podName}:`, routeErr.message);
          summary.errors++;
        }
        continue;
      }
    } catch (err) {
      console.error(`[reconciler] Error checking ${username}:`, err.message);
      summary.errors++;
    }
  }

  const parts = [];
  if (summary.started) parts.push(`${summary.started} started`);
  if (summary.routesFixed) parts.push(`${summary.routesFixed} routes fixed`);
  if (summary.restarted) parts.push(`${summary.restarted} restarted`);
  if (summary.errors) parts.push(`${summary.errors} errors`);
  if (parts.length > 0) {
    console.log(`[reconciler] Reconciliation complete: ${parts.join(', ')}`);
  }

  return summary;
}

/**
 * Start the periodic pod health watcher
 */
function startPodWatcher() {
  if (watchTimer) return;

  console.log(`[reconciler] Starting pod health watcher (every ${WATCH_INTERVAL / 1000}s)`);

  watchTimer = setInterval(async () => {
    try {
      const namespace = runtimeConfig.k8s.namespace;
      const pods = await k8sClient.listPods('app.kubernetes.io/name=student-container');

      for (const pod of pods) {
        const reason = isUnhealthyPod(pod);
        if (!reason) continue;

        const username = pod.metadata?.labels?.['hydra.owner'];
        if (!username) continue;

        const podName = pod.metadata.name;
        console.log(`[reconciler] Detected unhealthy pod ${podName}: ${reason}`);

        try {
          const db = await getDb();
          const row = await db.get('SELECT * FROM container_configs WHERE username = ?', [username]);
          if (!row || row.sleep_state === 'stopped') continue;

          const k8sContainers = require('./k8s-containers');
          await k8sClient.deletePod(podName, { gracePeriodSeconds: 0 });
          // Wait for deletion
          for (let i = 0; i < 15; i++) {
            const check = await k8sClient.getPod(podName, namespace);
            if (!check) break;
            await new Promise(r => setTimeout(r, 1000));
          }
          await k8sContainers.startContainer(username, `${username}@newpaltz.edu`, row);
          console.log(`[reconciler] Auto-restarted ${podName} after ${reason}`);
        } catch (err) {
          console.error(`[reconciler] Failed to auto-restart ${podName}:`, err.message);
        }
      }
    } catch (err) {
      // Don't log every interval if API is temporarily down
      if (!err.message?.includes('ECONNREFUSED')) {
        console.error('[reconciler] Pod watcher error:', err.message);
      }
    }
  }, WATCH_INTERVAL);
}

/**
 * Stop the periodic pod health watcher
 */
function stopPodWatcher() {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
    console.log('[reconciler] Pod health watcher stopped');
  }
}

module.exports = { reconcileContainers, startPodWatcher, stopPodWatcher };
