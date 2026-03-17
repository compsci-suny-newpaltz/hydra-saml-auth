// services/reconciler.js - Reconcile DB state with K8s state on startup
// Ensures pods and IngressRoutes exist for all containers that should be running

const { getDb } = require('../db');
const runtimeConfig = require('../config/runtime');
const k8sClient = require('./k8s-client');

/**
 * Reconcile container_configs DB state with actual K8s cluster state.
 *
 * For each container that should be running (sleep_state != 'stopped'):
 *   - If pod is missing: call startContainer to recreate it
 *   - If pod exists but IngressRoute is missing: call startContainer (which replaces routes)
 *   - If IngressRoute exists but pod doesn't: skip (route will be recreated when pod starts)
 *
 * Errors are caught per-student so one failure doesn't stop the loop.
 *
 * @returns {Promise<{started: number, routesFixed: number, errors: number}>}
 */
async function reconcileContainers() {
  console.log('[reconciler] Starting container reconciliation...');

  const summary = { started: 0, routesFixed: 0, errors: 0 };

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
      // Check if the pod exists
      const pod = await k8sClient.getPod(podName, namespace);

      if (!pod) {
        // Pod is missing — recreate it
        console.log(`[reconciler] Pod ${podName} missing, starting container for ${username}`);
        try {
          // Lazy require to avoid circular dependency
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

      // Pod exists — check if IngressRoute exists
      const ingressRoute = await k8sClient.getIngressRoute(podName, namespace);

      if (!ingressRoute) {
        // Pod exists but IngressRoute is missing — recreate via startContainer
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

      // Both pod and IngressRoute exist — nothing to do
    } catch (err) {
      console.error(`[reconciler] Error checking ${username}:`, err.message);
      summary.errors++;
    }
  }

  console.log(`[reconciler] Reconciliation complete: ${summary.started} started, ${summary.routesFixed} routes fixed, ${summary.errors} errors`);
  return summary;
}

module.exports = { reconcileContainers };
