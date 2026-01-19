// services/metrics-collector.js - Background metrics collection from cluster nodes
// This service fetches metrics from Chimera and Cerberus GPU nodes and caches them locally

const COLLECTION_INTERVAL = 30000; // 30 seconds

// Configuration - set via environment variables
const config = {
  hydra: {
    name: 'hydra',
    role: 'control-plane',
    host: 'localhost',
    port: null // Local metrics only
  },
  chimera: {
    name: 'chimera',
    role: 'inference',
    host: process.env.CHIMERA_HOST || '192.168.1.150',
    port: process.env.CHIMERA_METRICS_PORT || 9100
  },
  cerberus: {
    name: 'cerberus',
    role: 'training',
    host: process.env.CERBERUS_HOST || '192.168.1.242',
    port: process.env.CERBERUS_METRICS_PORT || 9100
  }
};

// In-memory cache for metrics
let metricsCache = {
  hydra: null,
  chimera: null,
  cerberus: null,
  lastUpdated: null
};

let collectionTimer = null;
let isRunning = false;

/**
 * Fetch metrics from a remote node's metrics agent
 * @param {string} nodeName - Node identifier
 * @returns {Promise<Object|null>} Metrics data or null on failure
 */
async function fetchRemoteMetrics(nodeName) {
  const nodeConfig = config[nodeName];
  if (!nodeConfig || !nodeConfig.port) {
    return null;
  }

  const url = `http://${nodeConfig.host}:${nodeConfig.port}/metrics`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      ...data,
      status: 'online',
      last_updated: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[metrics-collector] Failed to fetch metrics from ${nodeName}:`, error.message);
    return {
      status: 'offline',
      error: error.message,
      last_updated: new Date().toISOString()
    };
  }
}

/**
 * Collect local Hydra metrics
 * @returns {Object} Hydra system metrics
 */
function collectHydraMetrics() {
  const os = require('os');
  const { execSync } = require('child_process');

  // CPU usage calculation
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Disk usage - try to get from df
  let diskUsedGb = 0;
  let diskTotalGb = 21000;
  try {
    // Get root filesystem usage
    const dfOutput = execSync("df -BG / | tail -1 | awk '{print $2, $3}'", { encoding: 'utf8', timeout: 5000 });
    const [total, used] = dfOutput.trim().split(/\s+/).map(s => parseInt(s.replace('G', '')));
    if (!isNaN(total)) diskTotalGb = total;
    if (!isNaN(used)) diskUsedGb = used;
  } catch (e) {
    // Ignore errors, use defaults
  }

  // Container count - try docker ps
  let containersRunning = 0;
  try {
    const dockerOutput = execSync('docker ps -q 2>/dev/null | wc -l', { encoding: 'utf8', timeout: 5000 });
    containersRunning = parseInt(dockerOutput.trim()) || 0;
  } catch (e) {
    // Ignore errors
  }

  // ZFS status - try zpool status
  let zfsStatus = 'ONLINE';
  try {
    const zpoolOutput = execSync('zpool status -x 2>/dev/null | head -1', { encoding: 'utf8', timeout: 5000 });
    if (zpoolOutput.includes('all pools are healthy')) {
      zfsStatus = 'ONLINE';
    } else if (zpoolOutput.includes('DEGRADED')) {
      zfsStatus = 'DEGRADED';
    } else if (zpoolOutput.includes('FAULTED')) {
      zfsStatus = 'FAULTED';
    }
  } catch (e) {
    zfsStatus = 'N/A';
  }

  // Return in the format expected by formatCollectedMetrics
  return {
    status: 'online',
    role: 'control-plane',
    timestamp: new Date().toISOString(),
    system: {
      cpu_percent: Math.round(cpuUsage),
      ram_used_gb: Math.round(usedMem / (1024 * 1024 * 1024)),
      ram_total_gb: Math.round(totalMem / (1024 * 1024 * 1024)),
      disk_used_gb: diskUsedGb,
      disk_total_gb: diskTotalGb
    },
    containers: {
      running: containersRunning
    },
    zfs_status: zfsStatus
  };
}

/**
 * Collect metrics from all nodes
 */
async function collectAllMetrics() {
  console.log('[metrics-collector] Collecting metrics from all nodes...');

  const [hydraMetrics, chimeraMetrics, cerberusMetrics] = await Promise.all([
    Promise.resolve(collectHydraMetrics()),
    fetchRemoteMetrics('chimera'),
    fetchRemoteMetrics('cerberus')
  ]);

  metricsCache = {
    hydra: hydraMetrics,
    chimera: chimeraMetrics,
    cerberus: cerberusMetrics,
    lastUpdated: new Date().toISOString()
  };

  console.log('[metrics-collector] Metrics collection complete');
}

/**
 * Get cached metrics for all servers
 * @returns {Object} Current metrics cache
 */
function getMetrics() {
  return metricsCache;
}

/**
 * Get metrics for a specific server
 * @param {string} serverName - Server identifier
 * @returns {Object|null} Server metrics or null
 */
function getServerMetrics(serverName) {
  return metricsCache[serverName] || null;
}

/**
 * Start the metrics collection service
 */
function start() {
  if (isRunning) {
    console.log('[metrics-collector] Already running');
    return;
  }

  console.log('[metrics-collector] Starting metrics collection service');
  isRunning = true;

  // Collect immediately
  collectAllMetrics();

  // Then collect periodically
  collectionTimer = setInterval(collectAllMetrics, COLLECTION_INTERVAL);
}

/**
 * Stop the metrics collection service
 */
function stop() {
  if (collectionTimer) {
    clearInterval(collectionTimer);
    collectionTimer = null;
  }
  isRunning = false;
  console.log('[metrics-collector] Stopped');
}

/**
 * Force an immediate metrics collection
 */
async function forceCollect() {
  await collectAllMetrics();
}

module.exports = {
  start,
  stop,
  getMetrics,
  getServerMetrics,
  forceCollect,
  config
};
