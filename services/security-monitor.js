// services/security-monitor.js - Event-driven security monitoring for student containers
// Uses Docker events stream instead of polling - much more efficient
// Logs events but only takes action on critical issues
// Emits events for real-time dashboard notifications

const Docker = require('dockerode');
const EventEmitter = require('events');
const runtimeConfig = require('../config/runtime');
const { logSecurityEvent } = require('./db-init');

// Event emitter for broadcasting container events to dashboard
const eventBus = new EventEmitter();
eventBus.setMaxListeners(100); // Allow many SSE connections

// Optional periodic stats check interval (5 minutes) - for mining detection
// Set to 0 to disable periodic checks entirely
const STATS_CHECK_INTERVAL = process.env.SECURITY_STATS_INTERVAL
  ? parseInt(process.env.SECURITY_STATS_INTERVAL)
  : 300000; // 5 minutes default, 0 to disable

// Thresholds for periodic stats checks
const THRESHOLDS = {
  cpu: {
    warning: 80,
    critical: 95
  },
  memory: {
    warning: 85,
    critical: 95
  }
};

// Mining process detection - blocklist of known mining software
// These process names will trigger automatic container pause and alert
const MINING_PROCESS_BLOCKLIST = [
  'xmrig',
  'xmr-stak',
  'ethminer',
  'minerd',
  'cgminer',
  'bfgminer',
  'cpuminer',
  'ccminer',
  'phoenixminer',
  'nbminer',
  't-rex',
  'gminer',
  'lolminer',
  'teamredminer',
  'nanominer',
  'srbminer',
  'claymore',
  'nicehash',
  'minergate'
];

// Environment variable to enable/disable mining enforcement (default: enabled)
const MINING_ENFORCEMENT_ENABLED = process.env.MINING_ENFORCEMENT_ENABLED !== 'false';

// Track container stats for trend detection (only used if periodic checks enabled)
const containerHistory = new Map();
const HISTORY_SIZE = 5;

let docker = null;
let eventStream = null;
let statsTimer = null;
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
 * Handle Docker events
 */
async function handleDockerEvent(event) {
  // Only process container events
  if (event.Type !== 'container') return;

  // Only process student containers
  const containerName = event.Actor?.Attributes?.name || '';
  if (!containerName.startsWith('student-')) return;

  const username = containerName.replace('student-', '');
  const action = event.Action;

  try {
    // Build event payload for dashboard notifications
    const eventPayload = {
      timestamp: Date.now(),
      username,
      containerName,
      action,
      type: 'info'
    };

    switch (action) {
      case 'oom':
        // Container ran out of memory
        await logSecurityEvent({
          username,
          container_name: containerName,
          event_type: 'container_oom',
          severity: 'critical',
          description: `Container killed by OOM (Out of Memory)`,
          metrics: { event: 'oom' },
          action_taken: 'logged'
        });
        eventPayload.type = 'error';
        eventPayload.message = `OOM: ${username}'s container killed`;
        console.log(`[security-monitor] OOM event for ${containerName}`);
        break;

      case 'die':
        // Container died - check exit code
        const exitCode = event.Actor?.Attributes?.exitCode;
        if (exitCode && exitCode !== '0') {
          const severity = exitCode === '137' || exitCode === '143' ? 'info' : 'warning';
          await logSecurityEvent({
            username,
            container_name: containerName,
            event_type: 'process_killed',
            severity,
            description: `Container exited with code ${exitCode}`,
            metrics: { exitCode, signal: event.Actor?.Attributes?.signal },
            action_taken: 'logged'
          });
          eventPayload.type = severity === 'warning' ? 'warning' : 'info';
          eventPayload.message = `Container ${username} exited (code ${exitCode})`;
        } else {
          eventPayload.message = `Container ${username} stopped`;
        }
        break;

      case 'kill':
        // Container was killed (SIGKILL, SIGTERM, etc.)
        const signal = event.Actor?.Attributes?.signal;
        if (signal === 'SIGKILL') {
          await logSecurityEvent({
            username,
            container_name: containerName,
            event_type: 'process_killed',
            severity: 'warning',
            description: `Container received SIGKILL`,
            metrics: { signal },
            action_taken: 'logged'
          });
          eventPayload.type = 'warning';
        }
        eventPayload.message = `Container ${username} killed (${signal || 'unknown'})`;
        break;

      case 'start':
        // Container started - clear history for fresh stats
        containerHistory.delete(containerName);
        eventPayload.type = 'success';
        eventPayload.message = `Container ${username} started`;
        console.log(`[security-monitor] Container started: ${containerName}`);
        break;

      case 'stop':
        // Container stopped - clean up history
        containerHistory.delete(containerName);
        eventPayload.message = `Container ${username} stopped`;
        break;

      default:
        eventPayload.message = `Container ${username}: ${action}`;
    }

    // Emit event for SSE clients (dashboard toast notifications)
    eventBus.emit('container-event', eventPayload);
  } catch (err) {
    console.error(`[security-monitor] Error handling event for ${containerName}:`, err.message);
  }
}

/**
 * Start listening to Docker events
 */
async function startEventListener() {
  const dockerClient = initDocker();

  try {
    // Get event stream with filters for container events only
    eventStream = await dockerClient.getEvents({
      filters: {
        type: ['container'],
        event: ['oom', 'die', 'kill', 'start', 'stop']
      }
    });

    eventStream.on('data', (chunk) => {
      try {
        const event = JSON.parse(chunk.toString());
        // Properly handle async function with error catching
        handleDockerEvent(event).catch(err => {
          console.error('[security-monitor] Unhandled error in event handler:', err.message);
        });
      } catch (e) {
        // Ignore parse errors (incomplete chunks)
      }
    });

    eventStream.on('error', (err) => {
      console.error('[security-monitor] Event stream error:', err.message);
      // Try to reconnect after 5 seconds
      if (isRunning) {
        setTimeout(() => {
          console.log('[security-monitor] Attempting to reconnect event stream...');
          startEventListener();
        }, 5000);
      }
    });

    eventStream.on('end', () => {
      console.log('[security-monitor] Event stream ended');
      if (isRunning) {
        setTimeout(() => {
          console.log('[security-monitor] Reconnecting event stream...');
          startEventListener();
        }, 1000);
      }
    });

    console.log('[security-monitor] Listening to Docker events');
  } catch (err) {
    console.error('[security-monitor] Failed to start event listener:', err.message);
    throw err;
  }
}

/**
 * Get container stats (used for periodic mining detection)
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
 * Check for mining processes inside a container
 * Executes 'ps aux' and checks for blocklisted process names
 * Returns array of detected mining process names
 */
async function checkForMiningProcesses(container) {
  try {
    const exec = await container.exec({
      Cmd: ['ps', 'aux'],
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    
    return new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', (chunk) => {
        output += chunk.toString();
      });
      stream.on('end', () => {
        const detectedMining = [];
        const lowerOutput = output.toLowerCase();
        for (const miner of MINING_PROCESS_BLOCKLIST) {
          if (lowerOutput.includes(miner)) {
            detectedMining.push(miner);
          }
        }
        resolve(detectedMining);
      });
      stream.on('error', reject);
      
      // Timeout after 5 seconds
      setTimeout(() => resolve([]), 5000);
    });
  } catch (err) {
    console.warn(`[security-monitor] Failed to check processes: ${err.message}`);
    return [];
  }
}

/**
 * Pause a container (for mining enforcement)
 */
async function pauseContainer(container, containerName, reason) {
  try {
    await container.pause();
    console.log(`[security-monitor] PAUSED container ${containerName}: ${reason}`);
    return true;
  } catch (err) {
    console.error(`[security-monitor] Failed to pause ${containerName}:`, err.message);
    return false;
  }
}

/**
 * Periodic stats check for sustained high usage / mining detection
 * This runs less frequently (every 5 min) and is optional
 */
async function runPeriodicStatsCheck() {
  if (!isRunning) return;

  try {
    const dockerClient = initDocker();
    const containers = await dockerClient.listContainers({ all: false });

    for (const containerInfo of containers) {
      const containerName = containerInfo.Names[0]?.replace('/', '') || '';
      if (!containerName.startsWith('student-')) continue;

      const username = containerName.replace('student-', '');

      try {
        const container = dockerClient.getContainer(containerInfo.Id);
        const stats = await getContainerStats(container);

        const cpuPercent = calculateCpuPercent(stats);
        const memPercent = calculateMemoryPercent(stats);

        // Update history
        let history = containerHistory.get(containerName) || [];
        history.push({ timestamp: Date.now(), cpu: cpuPercent, memory: memPercent });
        if (history.length > HISTORY_SIZE) {
          history = history.slice(-HISTORY_SIZE);
        }
        containerHistory.set(containerName, history);

        // Check for blocklisted mining processes
        const detectedMining = await checkForMiningProcesses(container);
        if (detectedMining.length > 0) {
          let actionTaken = 'alerted';
          
          // If enforcement is enabled, pause the container
          if (MINING_ENFORCEMENT_ENABLED) {
            const paused = await pauseContainer(
              container, 
              containerName, 
              `Mining software detected: ${detectedMining.join(', ')}`
            );
            actionTaken = paused ? 'container_paused' : 'pause_failed';
          }

          await logSecurityEvent({
            username,
            container_name: containerName,
            event_type: 'mining_detected',
            severity: 'critical',
            description: `Mining software detected: ${detectedMining.join(', ')}`,
            metrics: { 
              detectedProcesses: detectedMining,
              cpuPercent: Math.round(cpuPercent)
            },
            process_info: JSON.stringify({ detected: detectedMining }),
            action_taken: actionTaken
          });

          // Emit event for dashboard notification
          eventBus.emit('container-event', {
            timestamp: Date.now(),
            username,
            containerName,
            action: 'mining_detected',
            type: 'error',
            message: `MINING DETECTED: ${detectedMining.join(', ')} - Container ${actionTaken === 'container_paused' ? 'PAUSED' : 'ALERTED'}`
          });

          // Skip further checks for this container if mining was detected
          continue;
        }

        // Check for sustained high CPU (potential mining)
        if (history.length >= 3) {
          const avgCpu = history.reduce((a, h) => a + h.cpu, 0) / history.length;
          if (avgCpu >= THRESHOLDS.cpu.critical) {
            await logSecurityEvent({
              username,
              container_name: containerName,
              event_type: 'sustained_high_cpu',
              severity: 'critical',
              description: `Sustained high CPU: ${avgCpu.toFixed(1)}% average over ${history.length} checks - possible mining`,
              metrics: { avgCpu: Math.round(avgCpu), currentCpu: Math.round(cpuPercent) },
              action_taken: 'alerted'
            });
          } else if (avgCpu >= THRESHOLDS.cpu.warning) {
            await logSecurityEvent({
              username,
              container_name: containerName,
              event_type: 'high_cpu',
              severity: 'warning',
              description: `High CPU usage: ${avgCpu.toFixed(1)}% average`,
              metrics: { avgCpu: Math.round(avgCpu), currentCpu: Math.round(cpuPercent) },
              action_taken: 'logged'
            });
          }
        }

        // Check high memory (close to limit) - check both thresholds with appropriate severities
        if (memPercent >= THRESHOLDS.memory.critical) {
          await logSecurityEvent({
            username,
            container_name: containerName,
            event_type: 'high_memory',
            severity: 'critical',
            description: `Critical memory usage: ${memPercent.toFixed(1)}% of limit`,
            metrics: { memoryPercent: Math.round(memPercent) },
            action_taken: 'alerted'
          });
        } else if (memPercent >= THRESHOLDS.memory.warning) {
          await logSecurityEvent({
            username,
            container_name: containerName,
            event_type: 'high_memory',
            severity: 'warning',
            description: `High memory usage: ${memPercent.toFixed(1)}% of limit`,
            metrics: { memoryPercent: Math.round(memPercent) },
            action_taken: 'logged'
          });
        }

      } catch (err) {
        // Container might have stopped
        if (!err.message?.includes('is not running')) {
          console.error(`[security-monitor] Stats error for ${containerName}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[security-monitor] Periodic check error:', err.message);
  }
}

/**
 * Start the security monitoring service
 */
async function start() {
  if (isRunning) {
    console.log('[security-monitor] Already running');
    return;
  }

  console.log('[security-monitor] Starting event-driven security monitor');
  isRunning = true;

  try {
    // Start Docker event listener
    await startEventListener();

    // Start periodic stats check if enabled
    if (STATS_CHECK_INTERVAL > 0) {
      console.log(`[security-monitor] Periodic stats check every ${STATS_CHECK_INTERVAL / 1000}s`);
      statsTimer = setInterval(runPeriodicStatsCheck, STATS_CHECK_INTERVAL);
      // Run first check after 30 seconds
      setTimeout(runPeriodicStatsCheck, 30000);
    } else {
      console.log('[security-monitor] Periodic stats check disabled');
    }

    console.log('[security-monitor] Started successfully');
  } catch (err) {
    console.error('[security-monitor] Failed to start:', err.message);
    isRunning = false;
    throw err;
  }
}

/**
 * Stop the security monitoring service
 */
function stop() {
  isRunning = false;

  if (eventStream) {
    eventStream.destroy();
    eventStream = null;
  }

  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }

  containerHistory.clear();
  console.log('[security-monitor] Stopped');
}

/**
 * Force an immediate stats check
 */
async function forceScan() {
  await runPeriodicStatsCheck();
}

/**
 * Get current monitoring status
 */
function getStatus() {
  return {
    running: isRunning,
    mode: 'event-driven',
    eventStreamConnected: eventStream !== null,
    periodicStatsEnabled: STATS_CHECK_INTERVAL > 0,
    periodicStatsInterval: STATS_CHECK_INTERVAL,
    containersTracked: containerHistory.size,
    thresholds: THRESHOLDS,
    miningEnforcementEnabled: MINING_ENFORCEMENT_ENABLED,
    miningBlocklist: MINING_PROCESS_BLOCKLIST
  };
}

module.exports = {
  start,
  stop,
  forceScan,
  getStatus,
  THRESHOLDS,
  MINING_PROCESS_BLOCKLIST,
  MINING_ENFORCEMENT_ENABLED,
  eventBus // For SSE dashboard notifications
};
