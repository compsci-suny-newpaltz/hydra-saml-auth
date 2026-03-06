// services/idle-manager.js - Student pod sleep mode
// Two-tier idle management:
//   1 day idle  → Recreate pod with minimal resources (sleep preset)
//   1 month idle → Scale to zero (delete pod, keep PVC)
// Auto-wakes pods when activity is detected on reduced containers

const k8sClient = require('./k8s-client');
const runtimeConfig = require('../config/runtime');
const resourceConfig = require('../config/resources');
const { getDb } = require('../db');
const {
  updateContainerConfig,
  getOrCreateContainerConfig
} = require('./db-init');

let k8sContainers;
try {
  k8sContainers = require('./k8s-containers');
} catch (e) {
  console.warn('[idle-manager] k8s-containers not available');
}

let checkInterval = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Idle thresholds
const CPU_IDLE_THRESHOLD_MILLICORES = 5;  // ≤5m CPU = idle
const SHORT_IDLE_MS = 24 * 60 * 60 * 1000; // 1 day → reduce resources
const LONG_IDLE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days → stop pod

/**
 * Parse CPU metric string (e.g. "1m", "500n", "2") to millicores
 */
function parseCpuMillicores(cpuStr) {
  if (!cpuStr) return 0;
  const str = String(cpuStr);
  if (str.endsWith('n')) return Math.round(parseInt(str) / 1e6);
  if (str.endsWith('m')) return parseInt(str);
  return Math.round(parseFloat(str) * 1000);
}

/**
 * Get CPU usage per pod from metrics-server
 * Returns Map<podName, cpuMillicores>
 */
async function getPodCpuUsage() {
  const namespace = runtimeConfig.k8s.namespace;
  const metrics = await k8sClient.getPodMetrics(namespace);
  const usage = new Map();

  for (const pod of metrics) {
    const podName = pod.metadata?.name;
    if (!podName?.startsWith('student-')) continue;

    const containers = pod.containers || [];
    let totalCpu = 0;
    for (const c of containers) {
      totalCpu += parseCpuMillicores(c.usage?.cpu);
    }
    usage.set(podName, totalCpu);
  }

  return usage;
}

/**
 * Reduce a pod to sleep preset (minimal resources)
 * If pod overflowed to a non-Hydra node (non-GPU preset), migrate it back to Hydra
 */
async function reducePod(username, email, config, actualNode) {
  if (!k8sContainers) {
    return { success: false, reason: 'k8s-containers not available' };
  }

  // Check if this is an overflow pod that should return to Hydra
  // Overflow = on Chimera/Cerberus but with a non-GPU preset (target was Hydra)
  const isOverflow = actualNode && actualNode !== 'hydra' &&
    !['gpu_inference', 'gpu_training'].includes(config.preset_tier || config.preset);
  const targetNode = isOverflow ? 'hydra' : (config.target_node || config.current_node || 'hydra');

  if (isOverflow) {
    console.log(`[idle-manager] Migrating ${username} back to Hydra (was overflow on ${actualNode})`);
  }

  const sleepConfig = {
    ...config,
    preset_tier: 'sleep',
    memory_gb: resourceConfig.presets.sleep.memory_gb,
    cpus: resourceConfig.presets.sleep.cpus,
    gpu_count: 0,
    target_node: targetNode
  };

  try {
    const result = await k8sContainers.startContainer(username, email, sleepConfig);
    if (result.success && isOverflow) {
      await updateContainerConfig(username, { current_node: 'hydra' });
    }
    return { success: result.success, migratedToHydra: isOverflow };
  } catch (err) {
    console.error(`[idle-manager] Failed to reduce pod for ${username}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Wake a pod back to its normal preset
 */
async function wakePod(username, email, config) {
  if (!k8sContainers) {
    return { success: false, reason: 'k8s-containers not available' };
  }

  try {
    const result = await k8sContainers.startContainer(username, email, config);
    return { success: result.success };
  } catch (err) {
    console.error(`[idle-manager] Failed to wake pod for ${username}:`, err.message);
    return { success: false, reason: err.message };
  }
}

/**
 * Main idle check cycle
 */
async function checkIdlePods() {
  if (!runtimeConfig.isKubernetes()) {
    return { checked: false, reason: 'Not in K8s mode' };
  }

  try {
    // Get all running student pods
    const namespace = runtimeConfig.k8s.namespace;
    const pods = await k8sClient.listPods('app.kubernetes.io/name=student-container', namespace);
    const runningPods = pods.filter(p => p.status?.phase === 'Running');

    if (runningPods.length === 0) {
      return { checked: true, running: 0, actions: [] };
    }

    // Get CPU metrics for all pods
    const cpuUsage = await getPodCpuUsage();
    const now = new Date();
    const actions = [];

    for (const pod of runningPods) {
      const podName = pod.metadata.name;
      const username = pod.metadata.labels?.['hydra.owner'];
      if (!username) continue;

      // Skip GPU pods — handled by resource-expiry.js
      const nodeName = pod.spec?.nodeName;
      if (nodeName && nodeName !== 'hydra') {
        const nodeConfig = resourceConfig.getNodeConfig(nodeName);
        if (nodeConfig?.gpuEnabled) continue;
      }

      try {
        const cpuMilli = cpuUsage.get(podName) ?? null;
        if (cpuMilli === null) continue; // No metrics available yet

        const db = await getDb();
        const config = await db.get(
          'SELECT * FROM container_configs WHERE username = ?',
          [username]
        );
        if (!config) continue;

        const sleepState = config.sleep_state || 'awake';
        const lastActive = config.last_active_at ? new Date(config.last_active_at) : now;
        const idleMs = now - lastActive;
        const isIdle = cpuMilli <= CPU_IDLE_THRESHOLD_MILLICORES;
        const email = pod.metadata.annotations?.['hydra.owner-email'] || `${username}@newpaltz.edu`;

        if (!isIdle) {
          // Pod is active — update last_active_at
          const updates = { last_active_at: now.toISOString() };

          if (sleepState === 'reduced') {
            // Auto-wake: pod is active but on sleep resources — restore normal preset
            console.log(`[idle-manager] Waking ${username} (CPU: ${cpuMilli}m, was reduced)`);
            const result = await wakePod(username, email, config);
            if (result.success) {
              updates.sleep_state = 'awake';
              actions.push({ username, action: 'woke', cpu: cpuMilli });
            } else {
              actions.push({ username, action: 'wake_failed', reason: result.reason });
            }
          }

          await updateContainerConfig(username, updates);
          continue;
        }

        // Pod is idle
        if (sleepState === 'awake' && idleMs >= SHORT_IDLE_MS) {
          // Idle 1+ day, still on normal resources → reduce
          // Pass actual node name so overflow pods can migrate back to Hydra
          console.log(`[idle-manager] Reducing ${username} (idle ${Math.round(idleMs / 3600000)}h, CPU: ${cpuMilli}m, node: ${nodeName})`);
          const result = await reducePod(username, email, config, nodeName);
          if (result.success) {
            await updateContainerConfig(username, { sleep_state: 'reduced' });
            if (result.migratedToHydra) {
              actions.push({ username, action: 'reduced+migrated', from: nodeName, idleHours: Math.round(idleMs / 3600000) });
            } else {
              actions.push({ username, action: 'reduced', idleHours: Math.round(idleMs / 3600000) });
            }
          } else {
            actions.push({ username, action: 'reduce_failed', reason: result.reason });
          }
        } else if (sleepState === 'reduced' && idleMs >= LONG_IDLE_MS) {
          // Idle 30+ days on reduced resources → stop entirely
          console.log(`[idle-manager] Stopping ${username} (idle ${Math.round(idleMs / 86400000)}d)`);
          try {
            await k8sContainers.stopContainer(username);
            await updateContainerConfig(username, { sleep_state: 'stopped' });
            actions.push({ username, action: 'stopped', idleDays: Math.round(idleMs / 86400000) });
          } catch (err) {
            actions.push({ username, action: 'stop_failed', reason: err.message });
          }
        }
        // else: idle but not long enough, or already in correct state — do nothing
      } catch (err) {
        console.error(`[idle-manager] Error processing ${podName}:`, err.message);
        actions.push({ username: username || podName, action: 'error', reason: err.message });
      }
    }

    if (actions.length > 0) {
      console.log(`[idle-manager] Cycle complete: ${actions.length} action(s)`, JSON.stringify(actions));
    }

    return { checked: true, running: runningPods.length, actions };
  } catch (error) {
    console.error('[idle-manager] Check failed:', error.message);
    return { checked: false, error: error.message };
  }
}

/**
 * Start the periodic idle checker
 */
function start() {
  if (checkInterval) {
    console.warn('[idle-manager] Already running');
    return;
  }

  console.log('[idle-manager] Starting sleep mode manager (interval: 1 hour)');
  console.log(`[idle-manager] Thresholds: reduce after ${SHORT_IDLE_MS / 3600000}h, stop after ${LONG_IDLE_MS / 86400000}d`);

  // Run initial check after a short delay (let other services initialize first)
  setTimeout(() => {
    checkIdlePods().then(result => {
      if (result.actions?.length > 0) {
        console.log(`[idle-manager] Initial check: ${result.actions.length} action(s)`);
      } else {
        console.log(`[idle-manager] Initial check: ${result.running || 0} running pods, no actions needed`);
      }
    });
  }, 30000); // 30 second delay on startup

  checkInterval = setInterval(checkIdlePods, CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic idle checker
 */
function stop() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('[idle-manager] Stopped');
  }
}

/**
 * Manually trigger an idle check (for admin use)
 */
async function triggerCheck() {
  return checkIdlePods();
}

module.exports = {
  start,
  stop,
  triggerCheck,
  checkIdlePods
};
