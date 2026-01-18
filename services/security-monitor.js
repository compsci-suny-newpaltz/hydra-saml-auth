// services/security-monitor.js - Background security monitoring for student containers
// Monitors CPU, memory, network usage and detects suspicious activity
// Logs events but only takes action on critical issues

const Docker = require('dockerode');
const runtimeConfig = require('../config/runtime');
const { logSecurityEvent } = require('./db-init');

// Monitoring interval (60 seconds)
const MONITOR_INTERVAL = 60000;

// Thresholds for different severity levels
const THRESHOLDS = {
  cpu: {
    warning: 80,      // 80% CPU sustained
    critical: 95      // 95% CPU - potential runaway process
  },
  memory: {
    warning: 85,      // 85% of limit
    critical: 95      // 95% - risk of OOM
  },
  network: {
    warning: 50,      // 50 MB/min outbound
    critical: 200     // 200 MB/min - potential mining/exfiltration
  }
};

// Known mining pool indicators
const MINING_INDICATORS = [
  /stratum\+tcp/i,
  /pool\./i,
  /\.mining\./i,
  /xmr\./i,
  /monero/i,
  /nicehash/i,
  /nanopool/i
];

// Common mining ports
const MINING_PORTS = [3333, 4444, 5555, 7777, 8333, 9999, 14444, 45700];

// Track container stats over time for trend detection
const containerHistory = new Map();
const HISTORY_SIZE = 5; // Keep last 5 readings

let docker = null;
let monitorTimer = null;
let isRunning = false;

/**
 * Initialize Docker connection
 */
function initDocker() {
  if (docker) return docker;

  const socketPath = runtimeConfig.docker?.socketPath || '/var/run/docker.sock';
  docker = new Docker({ socketPath });
  return docker;
}

/**
 * Get container stats
 */
async function getContainerStats(container) {
  return new Promise((resolve, reject) => {
    container.stats({ stream: false }, (err, stats) => {
      if (err) return reject(err);
      resolve(stats);
    });
  });
}

/**
 * Calculate CPU percentage from Docker stats
 */
function calculateCpuPercent(stats) {
  if (!stats.cpu_stats || !stats.precpu_stats) return 0;

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || 1;

  if (systemDelta > 0 && cpuDelta > 0) {
    return (cpuDelta / systemDelta) * cpuCount * 100;
  }
  return 0;
}

/**
 * Calculate memory percentage from Docker stats
 */
function calculateMemoryPercent(stats) {
  if (!stats.memory_stats) return 0;

  const usage = stats.memory_stats.usage || 0;
  const limit = stats.memory_stats.limit || 1;

  return (usage / limit) * 100;
}

/**
 * Calculate network bytes from Docker stats
 */
function calculateNetworkBytes(stats) {
  if (!stats.networks) return { rx: 0, tx: 0 };

  let rx = 0, tx = 0;
  for (const [, net] of Object.entries(stats.networks)) {
    rx += net.rx_bytes || 0;
    tx += net.tx_bytes || 0;
  }

  return { rx, tx };
}

/**
 * Detect potential mining behavior
 */
function detectMiningBehavior(containerName, stats, history) {
  const cpuPercent = calculateCpuPercent(stats);
  const network = calculateNetworkBytes(stats);

  // High sustained CPU + network = likely mining
  if (cpuPercent > 90 && history.length >= 3) {
    const avgCpu = history.reduce((a, h) => a + h.cpu, 0) / history.length;
    if (avgCpu > 85) {
      // Calculate network rate
      const oldestNetwork = history[0].network;
      const timeDiff = (Date.now() - history[0].timestamp) / 1000; // seconds
      const txRate = (network.tx - oldestNetwork.tx) / timeDiff; // bytes/sec
      const txMBPerMin = (txRate * 60) / (1024 * 1024);

      if (txMBPerMin > 10) { // 10 MB/min sustained with high CPU
        return {
          detected: true,
          confidence: 'high',
          avgCpu,
          txMBPerMin: Math.round(txMBPerMin * 10) / 10
        };
      }
    }
  }

  return { detected: false };
}

/**
 * Check a single container for security issues
 */
async function checkContainer(container, containerInfo) {
  const containerName = containerInfo.Names[0]?.replace('/', '') || containerInfo.Id.slice(0, 12);

  // Only monitor student containers
  if (!containerName.startsWith('student-')) {
    return [];
  }

  const username = containerName.replace('student-', '');
  const events = [];

  try {
    const stats = await getContainerStats(container);

    const cpuPercent = calculateCpuPercent(stats);
    const memPercent = calculateMemoryPercent(stats);
    const network = calculateNetworkBytes(stats);

    // Update history
    let history = containerHistory.get(containerName) || [];
    history.push({
      timestamp: Date.now(),
      cpu: cpuPercent,
      memory: memPercent,
      network
    });
    if (history.length > HISTORY_SIZE) {
      history = history.slice(-HISTORY_SIZE);
    }
    containerHistory.set(containerName, history);

    const metrics = {
      cpu_percent: Math.round(cpuPercent * 10) / 10,
      memory_percent: Math.round(memPercent * 10) / 10,
      memory_usage_mb: Math.round((stats.memory_stats?.usage || 0) / (1024 * 1024)),
      memory_limit_mb: Math.round((stats.memory_stats?.limit || 0) / (1024 * 1024)),
      network_rx_mb: Math.round(network.rx / (1024 * 1024)),
      network_tx_mb: Math.round(network.tx / (1024 * 1024))
    };

    // CPU checks
    if (cpuPercent >= THRESHOLDS.cpu.critical) {
      events.push({
        username,
        container_name: containerName,
        event_type: 'high_cpu',
        severity: 'critical',
        description: `CPU at ${metrics.cpu_percent}% (critical threshold: ${THRESHOLDS.cpu.critical}%)`,
        metrics,
        action_taken: 'logged'
      });
    } else if (cpuPercent >= THRESHOLDS.cpu.warning) {
      events.push({
        username,
        container_name: containerName,
        event_type: 'high_cpu',
        severity: 'warning',
        description: `CPU at ${metrics.cpu_percent}% (warning threshold: ${THRESHOLDS.cpu.warning}%)`,
        metrics,
        action_taken: 'logged'
      });
    }

    // Memory checks
    if (memPercent >= THRESHOLDS.memory.critical) {
      events.push({
        username,
        container_name: containerName,
        event_type: 'high_memory',
        severity: 'critical',
        description: `Memory at ${metrics.memory_percent}% of limit (${metrics.memory_usage_mb}MB / ${metrics.memory_limit_mb}MB)`,
        metrics,
        action_taken: 'logged'
      });
    } else if (memPercent >= THRESHOLDS.memory.warning) {
      events.push({
        username,
        container_name: containerName,
        event_type: 'high_memory',
        severity: 'warning',
        description: `Memory at ${metrics.memory_percent}% of limit (${metrics.memory_usage_mb}MB / ${metrics.memory_limit_mb}MB)`,
        metrics,
        action_taken: 'logged'
      });
    }

    // Mining detection
    const miningCheck = detectMiningBehavior(containerName, stats, history);
    if (miningCheck.detected) {
      events.push({
        username,
        container_name: containerName,
        event_type: 'mining_detected',
        severity: 'critical',
        description: `Potential cryptocurrency mining detected: ${miningCheck.avgCpu.toFixed(1)}% avg CPU with ${miningCheck.txMBPerMin}MB/min network`,
        metrics: { ...metrics, detection: miningCheck },
        action_taken: 'alerted'
      });
    }

  } catch (err) {
    // Container might have stopped, that's OK
    if (!err.message?.includes('is not running')) {
      console.error(`[security-monitor] Error checking ${containerName}:`, err.message);
    }
  }

  return events;
}

/**
 * Run a full security scan of all containers
 */
async function runSecurityScan() {
  if (!isRunning) return;

  try {
    const dockerClient = initDocker();
    const containers = await dockerClient.listContainers({ all: false }); // Only running

    let totalEvents = 0;

    for (const containerInfo of containers) {
      const container = dockerClient.getContainer(containerInfo.Id);
      const events = await checkContainer(container, containerInfo);

      for (const event of events) {
        await logSecurityEvent(event);
        totalEvents++;
      }
    }

    if (totalEvents > 0) {
      console.log(`[security-monitor] Scan complete: ${totalEvents} security events logged`);
    }

  } catch (err) {
    console.error('[security-monitor] Scan error:', err.message);
  }
}

/**
 * Start the security monitoring service
 */
function start() {
  if (isRunning) {
    console.log('[security-monitor] Already running');
    return;
  }

  console.log('[security-monitor] Starting security monitoring service');
  console.log('[security-monitor] Thresholds:', JSON.stringify(THRESHOLDS, null, 2));
  isRunning = true;

  // Run first scan after a short delay
  setTimeout(runSecurityScan, 5000);

  // Then run periodically
  monitorTimer = setInterval(runSecurityScan, MONITOR_INTERVAL);
}

/**
 * Stop the security monitoring service
 */
function stop() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  isRunning = false;
  console.log('[security-monitor] Stopped');
}

/**
 * Force an immediate security scan
 */
async function forceScan() {
  await runSecurityScan();
}

/**
 * Get current monitoring status
 */
function getStatus() {
  return {
    running: isRunning,
    containersMonitored: containerHistory.size,
    thresholds: THRESHOLDS
  };
}

module.exports = {
  start,
  stop,
  forceScan,
  getStatus,
  THRESHOLDS
};
