/**
 * Auto-reschedule service — moves expired GPU pods back to Hydra.
 *
 * Runs on a configurable interval (default: every 5 minutes).
 * Checks container_configs for pods on GPU nodes whose resources_expire_at has passed.
 * Automatically migrates them back to Hydra with default preset.
 */

const runtimeConfig = require('../config/runtime');

const CHECK_INTERVAL_MS = parseInt(process.env.AUTO_RESCHEDULE_INTERVAL_MS) || 5 * 60 * 1000;

let k8sContainers = null;
let intervalHandle = null;

async function checkAndReschedule() {
  try {
    const { getExpiredConfigs, resetContainerConfigToDefaults, getOrCreateUserQuota } = require('./db-init');

    const expired = await getExpiredConfigs();
    if (!expired || expired.length === 0) return;

    // Only migrate pods on GPU nodes
    const gpuExpired = expired.filter(c => c.current_node === 'cerberus' || c.current_node === 'chimera');
    if (gpuExpired.length === 0) return;

    if (!k8sContainers && runtimeConfig.isKubernetes()) {
      k8sContainers = require('./k8s-containers');
    }

    for (const config of gpuExpired) {
      console.log(`[auto-reschedule] GPU resources expired for ${config.username} on ${config.current_node} (expired: ${config.resources_expire_at}). Moving to Hydra.`);

      try {
        if (runtimeConfig.isKubernetes() && k8sContainers) {
          const email = `${config.username}@newpaltz.edu`;

          await k8sContainers.migrateContainer(config.username, email, 'hydra', {
            memory_gb: 2,
            memory_mb: 2048,
            cpus: 1,
            gpu_count: 0,
            storage_gb: config.storage_gb,
            preset: 'standard'
          });
        }

        // Reset config to defaults (sets current_node to hydra, clears GPU, clears expiry)
        await resetContainerConfigToDefaults(config.username);

        console.log(`[auto-reschedule] Successfully moved ${config.username} back to Hydra`);
      } catch (err) {
        console.error(`[auto-reschedule] Failed to move ${config.username}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[auto-reschedule] Check failed: ${err.message}`);
  }
}

function start() {
  if (intervalHandle) return;
  console.log(`[auto-reschedule] Starting (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);
  setTimeout(checkAndReschedule, 10000);
  intervalHandle = setInterval(checkAndReschedule, CHECK_INTERVAL_MS);
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[auto-reschedule] Stopped');
  }
}

module.exports = { start, stop, checkAndReschedule };
