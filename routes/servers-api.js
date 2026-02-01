// routes/servers-api.js - Server metrics and GPU queue API
const express = require('express');
const router = express.Router();

// Import metrics collector
let metricsCollector;
try {
  metricsCollector = require('../services/metrics-collector');
} catch (e) {
  console.warn('[servers-api] Metrics collector not available, using mock data');
}

// Import K8s client for pod status
let k8sClient;
try {
  k8sClient = require('../services/k8s-client');
} catch (e) {
  console.warn('[servers-api] K8s client not available, using mock data for pods');
}

// For disk stats
const { execSync } = require('child_process');
const fs = require('fs');

// Polyfill global crypto for jose library (Node.js 18+)
const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// For JWT verification - jose is ESM, need dynamic import
let joseModule = null;
let publicKey = null;

(async () => {
  try {
    joseModule = await import('jose');
    const publicKeyPem = fs.readFileSync(process.env.JWT_PUBLIC_KEY_PATH || './jwt-public.pem', 'utf8');
    publicKey = await joseModule.importSPKI(publicKeyPem, 'RS256');
  } catch (e) {
    console.warn('[servers-api] Could not load JWT public key for admin check:', e.message);
  }
})();

/**
 * Check if request is from admin/faculty user
 */
async function isAdminRequest(req) {
  try {
    const token = req.cookies?.np_access;
    if (!token || !publicKey || !joseModule) return false;

    const { payload } = await joseModule.jwtVerify(token, publicKey, { algorithms: ['RS256'] });
    const affiliation = (payload.affiliation || '').toLowerCase();
    const isFaculty = affiliation === 'faculty';

    // Check admin whitelist
    const adminWhitelist = (process.env.ADMIN_WHITELIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const email = (payload.email || '').toLowerCase();
    const isWhitelisted = adminWhitelist.includes(email);

    return isFaculty || isWhitelisted;
  } catch (e) {
    return false;
  }
}

/**
 * Get RAID storage usage from /data mount
 * Returns { used_gb, total_gb }
 */
async function getRaidUsage() {
  try {
    // df -BG outputs in GB, e.g.: "/dev/md0  21373G  43G  20254G  1% /data"
    const output = execSync('df -BG /data 2>/dev/null | tail -1', { encoding: 'utf8', timeout: 5000 });
    const parts = output.trim().split(/\s+/);
    // parts: [device, total, used, avail, use%, mount]
    if (parts.length >= 4) {
      const total_gb = parseInt(parts[1]) || 21000;
      const used_gb = parseInt(parts[2]) || 0;
      return { used_gb, total_gb };
    }
  } catch (err) {
    console.warn('[servers-api] Failed to get RAID usage:', err.message);
  }
  // Fallback
  return { used_gb: 0, total_gb: 21000 };
}

/**
 * GET /api/servers/status
 * Returns status and metrics for all cluster servers
 * Public endpoint - no authentication required
 */
router.get('/status', async (req, res) => {
  try {
    // Check if user is admin/faculty for sensitive pod info
    const showPodDetails = await isAdminRequest(req);

    let serverData;

    // Try to get real metrics from collector
    if (metricsCollector) {
      const metrics = metricsCollector.getMetrics();
      if (metrics && metrics.lastUpdated) {
        serverData = await formatCollectedMetrics(metrics, showPodDetails);
      }
    }

    // Fallback to mock data if no real metrics
    if (!serverData) {
      serverData = await generateMockServerData(showPodDetails);
    }

    res.json({
      servers: serverData,
      generated_at: new Date().toISOString(),
      showPodDetails
    });
  } catch (error) {
    console.error('[servers-api] Failed to get server status:', error);
    res.status(500).json({ error: 'Failed to retrieve server metrics' });
  }
});

/**
 * GET /api/servers/gpu-queue
 * Returns GPU queue information for authenticated user
 * Shows their queue position and estimated wait times
 */
router.get('/gpu-queue', (req, res) => {
  // Check authentication via np_access cookie
  const token = req.cookies?.np_access;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // TODO: Get user from token and lookup their queue position
  // For now, return mock queue data
  const mockQueueData = {
    user_requests: [
      // Example: user has one pending request
      // {
      //   id: 42,
      //   queue_position: 3,
      //   target_node: 'chimera',
      //   job_type: 'inference',
      //   status: 'pending',
      //   estimated_wait_minutes: 45,
      //   created_at: new Date().toISOString()
      // }
    ],
    queue_summary: {
      chimera: {
        queue_length: 3,
        avg_wait_minutes: 30,
        current_utilization: 72
      },
      cerberus: {
        queue_length: 1,
        current_job: 'fine-tuning-llama3',
        job_progress: 62,
        busy_until: null
      }
    }
  };

  res.json(mockQueueData);
});

/**
 * GET /api/servers/:name/metrics
 * Returns detailed metrics for a specific server
 */
router.get('/:name/metrics', async (req, res) => {
  const { name } = req.params;

  if (!['hydra', 'chimera', 'cerberus'].includes(name)) {
    return res.status(404).json({ error: 'Unknown server' });
  }

  try {
    // TODO: Get real metrics from collector
    const mockData = generateMockServerData();
    const serverData = mockData[name];

    if (!serverData) {
      return res.status(404).json({ error: 'Server metrics not available' });
    }

    res.json({
      server: name,
      metrics: serverData,
      collected_at: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[servers-api] Failed to get metrics for ${name}:`, error);
    res.status(500).json({ error: 'Failed to retrieve server metrics' });
  }
});

/**
 * Format metrics from the collector into API response format
 */
async function formatCollectedMetrics(metrics, showPodDetails = false) {
  const result = {};

  // Format Hydra (control plane - no GPUs)
  if (metrics.hydra) {
    const h = metrics.hydra;
    // Get real RAID usage
    const raidStats = await getRaidUsage();
    result.hydra = {
      status: h.status || 'online',
      role: 'control-plane',
      cpu_percent: h.system?.cpu_percent || 0,
      ram_used_gb: h.system?.ram_used_gb || 0,
      ram_total_gb: h.system?.ram_total_gb || 251,
      disk_used_gb: h.system?.disk_used_gb || 254,
      disk_total_gb: h.system?.disk_total_gb || 1000,
      raid_used_gb: raidStats.used_gb,
      raid_total_gb: raidStats.total_gb,
      containers_running: h.containers?.running || 0,
      zfs_status: h.zfs_status || 'ONLINE',
      storage_cluster: h.storage_cluster || await generateStorageClusterData(showPodDetails),
      last_updated: h.timestamp || new Date().toISOString()
    };
  }

  // Format Chimera (inference node with GPUs)
  if (metrics.chimera) {
    const c = metrics.chimera;
    result.chimera = {
      status: c.status || 'online',
      role: 'inference',
      gpus: (c.gpus || []).map(gpu => ({
        index: gpu.index,
        name: gpu.name,
        util: gpu.utilization_percent,
        vram_used: gpu.memory_used_gb,
        vram_total: gpu.memory_total_gb,
        temp: gpu.temperature_c
      })),
      cpu_percent: c.system?.cpu_percent || 0,
      ram_used_gb: c.system?.ram_used_gb || 0,
      ram_total_gb: c.system?.ram_total_gb || 251,
      disk_used_gb: c.system?.disk_used_gb || 0,
      disk_total_gb: c.system?.disk_total_gb || 2000,
      containers_running: c.containers?.running || 0,
      queue_depth: c.queue?.pending || 0,
      avg_wait_minutes: c.queue?.estimated_wait_minutes || 0,
      last_updated: c.timestamp || new Date().toISOString()
    };
  }

  // Format Cerberus (training node with GPUs)
  if (metrics.cerberus) {
    const cb = metrics.cerberus;
    result.cerberus = {
      status: cb.status || 'online',
      role: 'training',
      gpus: (cb.gpus || []).map(gpu => ({
        index: gpu.index,
        name: gpu.name,
        util: gpu.utilization_percent,
        vram_used: gpu.memory_used_gb,
        vram_total: gpu.memory_total_gb,
        temp: gpu.temperature_c
      })),
      cpu_percent: cb.system?.cpu_percent || 0,
      ram_used_gb: cb.system?.ram_used_gb || 0,
      ram_total_gb: cb.system?.ram_total_gb || 64,
      disk_used_gb: cb.system?.disk_used_gb || 0,
      disk_total_gb: cb.system?.disk_total_gb || 1000,
      containers_running: cb.containers?.running || 0,
      queue_depth: cb.queue?.pending || 0,
      training_job: cb.active_training_job?.name || null,
      job_progress: cb.active_training_job?.progress_percent || 0,
      job_eta: cb.active_training_job ? `~${Math.floor(cb.active_training_job.eta_minutes / 60)}h ${cb.active_training_job.eta_minutes % 60}m` : null,
      last_updated: cb.timestamp || new Date().toISOString()
    };
  }

  return result;
}

/**
 * Generate realistic mock server data
 * This will be replaced by real metrics collection
 */
async function generateMockServerData(showPodDetails = false) {
  // Add some randomization to make it look realistic
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randFloat = (min, max) => (Math.random() * (max - min) + min).toFixed(1);

  // Get real RAID usage
  const raidStats = await getRaidUsage();

  return {
    hydra: {
      status: 'online',
      role: 'control-plane',
      cpu_percent: rand(15, 55),
      ram_used_gb: rand(60, 120),
      ram_total_gb: 251,
      disk_used_gb: 254,
      disk_total_gb: 1000,
      raid_used_gb: raidStats.used_gb,
      raid_total_gb: raidStats.total_gb,
      containers_running: rand(35, 55),
      zfs_status: 'ONLINE',
      storage_cluster: await generateStorageClusterData(showPodDetails),
      last_updated: new Date().toISOString()
    },
    chimera: {
      status: 'online',
      role: 'inference',
      gpus: [
        {
          index: 0,
          name: 'RTX 3090',
          util: rand(40, 95),
          vram_used: rand(12, 23),
          vram_total: 24,
          temp: rand(62, 78)
        },
        {
          index: 1,
          name: 'RTX 3090',
          util: rand(20, 70),
          vram_used: rand(8, 18),
          vram_total: 24,
          temp: rand(58, 72)
        },
        {
          index: 2,
          name: 'RTX 3090',
          util: rand(60, 98),
          vram_used: rand(18, 24),
          vram_total: 24,
          temp: rand(68, 82)
        }
      ],
      cpu_percent: rand(20, 60),
      ram_used_gb: rand(80, 180),
      ram_total_gb: 251,
      disk_used_gb: rand(400, 800),
      disk_total_gb: 2000,
      containers_running: rand(5, 12),
      queue_depth: rand(1, 6),
      avg_wait_minutes: rand(15, 60),
      last_updated: new Date().toISOString()
    },
    cerberus: {
      status: 'online',
      role: 'training',
      gpus: [
        {
          index: 0,
          name: 'RTX 5090',
          util: rand(85, 100),
          vram_used: rand(28, 32),
          vram_total: 32,
          temp: rand(70, 82)
        },
        {
          index: 1,
          name: 'RTX 5090',
          util: rand(85, 100),
          vram_used: rand(26, 32),
          vram_total: 32,
          temp: rand(68, 80)
        }
      ],
      cpu_percent: rand(40, 80),
      ram_used_gb: rand(40, 58),
      ram_total_gb: 64,
      disk_used_gb: rand(200, 400),
      disk_total_gb: 1000,
      containers_running: rand(1, 4),
      queue_depth: rand(0, 3),
      training_job: Math.random() > 0.3 ? 'fine-tuning-llama3' : null,
      job_progress: rand(20, 85),
      job_eta: `~${rand(1, 4)}h ${rand(0, 59)}m`,
      last_updated: new Date().toISOString()
    }
  };
}

/**
 * Generate storage cluster data from K8s pods
 * Shows student pods with their status (running, stopped, etc.)
 *
 * Cluster-wide capacity calculation:
 * - Hydra: 20 CPU cores, 251 GB RAM, 110 pod limit
 * - Chimera: 48 CPU cores, 251 GB RAM, 110 pod limit
 * - Cerberus: 48 CPU cores, 62 GB RAM, 110 pod limit
 * - Total: 116 cores, 564 GB RAM, 330 pod limit
 *
 * With base pod (0.5 CPU, 1.5 GB RAM):
 * - By CPU: 116 / 0.5 = 232 pods
 * - By Memory: 564 / 1.5 = 376 pods
 * - By Pod limit: 330 pods
 * - Effective max: 232 pods (CPU bottleneck)
 */
async function generateStorageClusterData(showPodDetails = false) {
  // Cluster-wide capacity (all 3 nodes combined)
  const CLUSTER_NODES = {
    hydra: { cpu: 20, memory_gb: 251, pod_limit: 110 },
    chimera: { cpu: 48, memory_gb: 251, pod_limit: 110 },
    cerberus: { cpu: 48, memory_gb: 62, pod_limit: 110 }
  };

  const TOTAL_CPU_CORES = 20 + 48 + 48;  // 116
  const TOTAL_MEMORY_GB = 251 + 251 + 62; // 564
  const TOTAL_POD_LIMIT = 110 + 110 + 110; // 330
  const TOTAL_STORAGE_TB = 21;

  // Base pod resource allocation (conservative preset)
  const BASE_CPU_REQUEST = 0.5;  // cores
  const BASE_MEMORY_GB = 1.5;    // GB
  const BASE_STORAGE_GB = 10;    // GB

  // Calculate max capacity by each resource (cluster-wide)
  const maxByCpu = Math.floor(TOTAL_CPU_CORES / BASE_CPU_REQUEST);      // 232
  const maxByMemory = Math.floor(TOTAL_MEMORY_GB / BASE_MEMORY_GB);     // 376
  const maxByStorage = Math.floor((TOTAL_STORAGE_TB * 1024) / BASE_STORAGE_GB); // 2150

  // Effective max is minimum of all constraints
  const MAX_PODS = Math.min(maxByCpu, maxByMemory, TOTAL_POD_LIMIT); // 232

  try {
    if (!k8sClient) {
      console.warn('[servers-api] K8s client not available, using mock data');
      return generateMockStorageCluster();
    }

    // Get all student pods from K8s
    const pods = await k8sClient.listPods('app.kubernetes.io/name=student-container', 'hydra-students');

    const students = [];
    let runningCount = 0;

    for (const pod of pods) {
      const podName = pod.metadata?.name || '';
      const username = podName.replace('student-', '');
      const phase = pod.status?.phase || 'Unknown';
      const containerReady = pod.status?.containerStatuses?.[0]?.ready || false;
      const node = pod.spec?.nodeName || '-';

      // Determine pod status
      let pod_status = 'stopped'; // red
      if (phase === 'Running' && containerReady) {
        pod_status = 'running'; // green
        runningCount++;
      } else if (phase === 'Pending') {
        pod_status = 'pending'; // yellow
      } else if (phase === 'Failed' || phase === 'Unknown') {
        pod_status = 'error'; // red
      }

      // Get resource usage from pod spec
      const resources = pod.spec?.containers?.[0]?.resources || {};
      const memoryRequest = resources.requests?.memory || '512Mi';
      const cpuRequest = resources.requests?.cpu || '500m';

      // Parse memory to GB (rough estimate)
      let memoryGb = 0.5;
      if (memoryRequest.includes('Gi')) {
        memoryGb = parseFloat(memoryRequest);
      } else if (memoryRequest.includes('Mi')) {
        memoryGb = parseFloat(memoryRequest) / 1024;
      }

      // Only include sensitive info (username, IP, node) for admins
      if (showPodDetails) {
        students.push({
          username,
          pod_status,
          node,
          used_gb: memoryGb,
          quota_gb: BASE_STORAGE_GB,
          phase,
          pod_ip: pod.status?.podIP || null
        });
      } else {
        // Redacted info for non-admins - just show status
        students.push({
          pod_status
        });
      }
    }

    // Sort by status: running first, then pending, then stopped
    students.sort((a, b) => {
      const order = { running: 0, pending: 1, stopped: 2, error: 3 };
      return (order[a.pod_status] || 4) - (order[b.pod_status] || 4);
    });

    return {
      students,
      total_pods: students.length,
      running_count: runningCount,
      max_capacity: MAX_PODS,
      empty_slots: MAX_PODS - students.length,
      capacity_info: {
        max_by_cpu: maxByCpu,
        max_by_memory: maxByMemory,
        max_by_storage: maxByStorage,
        k8s_limit: TOTAL_POD_LIMIT,
        bottleneck: 'cpu',
        nodes: CLUSTER_NODES
      },
      total_used_gb: students.reduce((sum, s) => sum + s.used_gb, 0),
      available_tb: TOTAL_STORAGE_TB - (students.length * BASE_STORAGE_GB / 1024)
    };
  } catch (err) {
    console.error('[servers-api] Failed to get K8s pod data:', err.message);
    // Return mock data on error
    return generateMockStorageCluster(showPodDetails);
  }
}

/**
 * Generate mock storage cluster data for testing
 * Includes pod_status for UI compatibility
 */
function generateMockStorageCluster(showPodDetails = false) {
  const MAX_PODS = 232; // Cluster-wide: 116 cores / 0.5 = 232
  const rand = (min, max) => Math.random() * (max - min) + min;
  const students = [];
  const usernames = [
    'gopeen1', 'patelv22', 'easwarac', 'currym6', 'manzim1', 'namc3',
    'defreitm1', 'fennerj1', 'polij1', 'shusterj1', 'dankwahd1', 'arenellc1',
    'riordanj2', 'smithj3', 'jonesm4', 'brownk5', 'davisl6', 'wilsonp7'
  ];

  let totalUsedGb = 0;
  let runningCount = 0;
  usernames.forEach((username, i) => {
    const usedGb = rand(0.1, 9.5);
    // First 3 are running, rest are stopped (mock)
    const pod_status = i < 3 ? 'running' : 'stopped';
    if (pod_status === 'running') runningCount++;

    if (showPodDetails) {
      students.push({
        username,
        pod_status,
        node: 'hydra',
        used_gb: usedGb,
        quota_gb: 10,
        phase: pod_status === 'running' ? 'Running' : 'Stopped',
        pod_ip: pod_status === 'running' ? `10.42.0.${100 + i}` : null
      });
    } else {
      students.push({ pod_status });
    }
    totalUsedGb += usedGb;
  });

  return {
    students,
    total_pods: students.length,
    running_count: runningCount,
    max_capacity: MAX_PODS,
    empty_slots: MAX_PODS - students.length,
    capacity_info: {
      max_by_cpu: 232,
      max_by_memory: 376,
      max_by_storage: 2150,
      k8s_limit: 330,
      bottleneck: 'cpu',
      nodes: {
        hydra: { cpu: 20, memory_gb: 251, pod_limit: 110 },
        chimera: { cpu: 48, memory_gb: 251, pod_limit: 110 },
        cerberus: { cpu: 48, memory_gb: 62, pod_limit: 110 }
      }
    },
    total_used_gb: totalUsedGb,
    available_tb: 21 - (totalUsedGb / 1000)
  };
}

module.exports = router;
