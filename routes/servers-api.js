// routes/servers-api.js - Server metrics and GPU queue API
const express = require('express');
const router = express.Router();

// Import metrics collector
let metricsCollector;
try {
  metricsCollector = require('../services/metrics-collector');
} catch (e) {
  console.warn('[servers-api] Metrics collector not available');
}

// Import K8s client for pod status
let k8sClient;
try {
  k8sClient = require('../services/k8s-client');
} catch (e) {
  console.warn('[servers-api] K8s client not available');
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

    // Check admin whitelist (ADMIN_USERS env var from configmap)
    const adminWhitelist = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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

    // If no real metrics available, return empty state
    if (!serverData) {
      serverData = {};
    }

    // Inject admin-only node details (IPs, hardware)
    if (showPodDetails && serverData) {
      const nodeDetails = {
        hydra: { ip: '192.168.1.160', cores: 64, hardware: '256GB RAM, 64 cores, 21TB ZFS RAID-10' },
        chimera: { ip: '192.168.1.150', cores: 48, hardware: '251GB RAM, 48 cores, 3x RTX 3090 (72GB VRAM)', ip_10g: '10.0.0.1' },
        cerberus: { ip: '192.168.1.242', cores: 48, hardware: '64GB RAM, 48 cores, 2x RTX 5090 (64GB VRAM)', ip_10g: '10.0.0.2' }
      };
      for (const [name, details] of Object.entries(nodeDetails)) {
        if (serverData[name]) serverData[name].admin_details = details;
      }
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
 * Returns real GPU node workload: pods on Chimera/Cerberus, resource usage, pending pods
 */
router.get('/gpu-queue', async (req, res) => {
  const token = req.cookies?.np_access;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    if (!k8sClient) {
      return res.status(503).json({ error: 'K8s client unavailable' });
    }

    const isAdmin = await isAdminRequest(req);

    // GPU node definitions
    const gpuNodes = {
      chimera: { total_gpus: 3, gpu_model: 'RTX 3090', vram_per_gpu: 24 },
      cerberus: { total_gpus: 2, gpu_model: 'RTX 5090', vram_per_gpu: 32 }
    };

    const queue_summary = {};

    for (const [nodeName, nodeInfo] of Object.entries(gpuNodes)) {
      // Get pods on this specific node (field selector is efficient — server-side filter)
      const allNodePods = await k8sClient.listPodsAllNamespaces(`spec.nodeName=${nodeName}`);
      const nodePods = allNodePods.filter(p =>
        p.metadata?.namespace !== 'kube-system' &&
        p.metadata?.namespace !== 'gpu-operator' &&
        p.status?.phase !== 'Succeeded'
      );

      // Categorize pods
      const workloads = [];
      let gpusAllocated = 0;

      for (const pod of nodePods) {
        const ns = pod.metadata?.namespace || '';
        const name = pod.metadata?.name || '';
        const phase = pod.status?.phase || 'Unknown';
        const ready = pod.status?.containerStatuses?.some(c => c.ready) || false;

        // Count GPU requests across all containers
        let podGpus = 0;
        for (const container of (pod.spec?.containers || [])) {
          const gpuReq = container.resources?.requests?.['nvidia.com/gpu'] ||
                         container.resources?.limits?.['nvidia.com/gpu'] || '0';
          podGpus += parseInt(gpuReq) || 0;
        }
        gpusAllocated += podGpus;

        // Determine workload type
        let type = 'other';
        if (name.startsWith('student-')) type = 'student';
        else if (name.startsWith('model-') || ns === 'kubeai') type = 'model';
        else if (name.includes('ollama')) type = 'ollama';
        else if (name.includes('ray-')) type = 'ray';
        else if (name.includes('open-webui')) type = 'webui';

        const entry = {
          type,
          namespace: ns,
          status: ready ? 'running' : phase.toLowerCase(),
          gpus: podGpus
        };

        // Show pod name/details only for admins
        if (isAdmin) {
          entry.name = name;
          entry.pod_ip = pod.status?.podIP || null;
        }

        workloads.push(entry);
      }

      // Count pending pods on this node (already in nodePods from field selector,
      // plus pods that want this node but haven't been scheduled yet)
      const pendingOnNode = nodePods.filter(p => p.status?.phase === 'Pending');
      const pendingPods = pendingOnNode;

      queue_summary[nodeName] = {
        gpu_model: nodeInfo.gpu_model,
        total_gpus: nodeInfo.total_gpus,
        gpus_allocated: gpusAllocated,
        gpus_available: nodeInfo.total_gpus - gpusAllocated,
        workloads,
        pending_count: pendingPods.length,
        total_pods: nodePods.length
      };
    }

    res.json({ queue_summary, checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('[servers-api] Failed to get GPU queue:', error);
    res.status(500).json({ error: 'Failed to retrieve GPU queue data' });
  }
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
    let serverData = null;
    if (metricsCollector) {
      const metrics = metricsCollector.getMetrics();
      if (metrics && metrics[name]) {
        const formatted = await formatCollectedMetrics(metrics, false);
        serverData = formatted[name];
      }
    }

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
 * Generate storage cluster data from K8s pods and PVCs
 * Shows student pods with their status (running, stopped, etc.)
 *
 * Cluster-wide capacity calculation:
 * - Hydra: 20 CPU cores, 251 GB RAM, 110 pod limit
 * - Chimera: 48 CPU cores, 251 GB RAM, 110 pod limit
 * - Cerberus: 48 CPU cores, 62 GB RAM, 110 pod limit
 * - Total: 116 cores, 564 GB RAM, 330 pod limit
 *
 * Idle pods use sleep preset (0.05 CPU, 64Mi RAM) so capacity is
 * calculated dynamically from actual resource requests, not worst-case.
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

  // Resource requests per pod state
  const ACTIVE_CPU_REQUEST = 0.5;  // cores (conservative preset)
  const SLEEP_CPU_REQUEST = 0.05;  // cores (sleep preset)
  const BASE_MEMORY_GB = 1.5;     // GB
  const BASE_STORAGE_GB = 10;     // GB

  try {
    if (!k8sClient) {
      console.warn('[servers-api] K8s client not available');
      return { students: [], total_pods: 0, running_count: 0, max_capacity: 0, empty_slots: 0 };
    }

    // Get all student pods and PVCs from K8s
    const [pods, pvcs] = await Promise.all([
      k8sClient.listPods('app.kubernetes.io/name=student-container', 'hydra-students'),
      k8sClient.listPVCs(undefined, 'hydra-students').catch(() => [])
    ]);

    // Build a map of pod data by username
    const podMap = {};
    let totalCpuRequested = 0;
    let runningCount = 0;

    for (const pod of pods) {
      const podName = pod.metadata?.name || '';
      const username = podName.replace('student-', '');
      const phase = pod.status?.phase || 'Unknown';
      const containerReady = pod.status?.containerStatuses?.[0]?.ready || false;
      const node = pod.spec?.nodeName || '-';

      let pod_status = 'stopped';
      if (phase === 'Running' && containerReady) {
        pod_status = 'running';
        runningCount++;
      } else if (phase === 'Pending') {
        pod_status = 'pending';
      } else if (phase === 'Failed' || phase === 'Unknown') {
        pod_status = 'error';
      }

      const resources = pod.spec?.containers?.[0]?.resources || {};
      const memoryRequest = resources.requests?.memory || '512Mi';
      const cpuRequest = resources.requests?.cpu || '500m';

      let cpuCores = ACTIVE_CPU_REQUEST;
      if (cpuRequest.endsWith('m')) {
        cpuCores = parseInt(cpuRequest) / 1000;
      } else {
        cpuCores = parseFloat(cpuRequest) || ACTIVE_CPU_REQUEST;
      }
      totalCpuRequested += cpuCores;

      let memoryGb = 0.5;
      if (memoryRequest.includes('Gi')) {
        memoryGb = parseFloat(memoryRequest);
      } else if (memoryRequest.includes('Mi')) {
        memoryGb = parseFloat(memoryRequest) / 1024;
      }

      podMap[username] = { pod_status, node, memoryGb, cpuRequest, phase, podIP: pod.status?.podIP || null };
    }

    // Build student list from PVCs (all users with storage) merged with pod status
    const students = [];
    const pvcUsers = new Set();

    for (const pvc of pvcs) {
      const pvcName = pvc.metadata?.name || '';
      if (!pvcName.startsWith('hydra-vol-')) continue;
      const username = pvcName.replace('hydra-vol-', '');
      pvcUsers.add(username);

      const podData = podMap[username];
      const pod_status = podData?.pod_status || 'offline';
      if (pod_status === 'running') { /* already counted */ }

      if (showPodDetails) {
        students.push({
          username,
          pod_status,
          node: podData?.node || '-',
          used_gb: podData?.memoryGb || 0,
          quota_gb: BASE_STORAGE_GB,
          phase: podData?.phase || 'Offline',
          pod_ip: podData?.podIP || null,
          cpu_request: podData?.cpuRequest || '-'
        });
      } else {
        students.push({ pod_status });
      }
    }

    // Include any pods that don't have a matching PVC (shouldn't happen, but just in case)
    for (const [username, podData] of Object.entries(podMap)) {
      if (pvcUsers.has(username)) continue;
      if (showPodDetails) {
        students.push({
          username,
          pod_status: podData.pod_status,
          node: podData.node,
          used_gb: podData.memoryGb,
          quota_gb: BASE_STORAGE_GB,
          phase: podData.phase,
          pod_ip: podData.podIP,
          cpu_request: podData.cpuRequest
        });
      } else {
        students.push({ pod_status: podData.pod_status });
      }
    }

    // Dynamic capacity: how many new pods can fit given actual CPU usage
    // Idle pods on sleep preset use 0.05 CPU, active pods use 0.5 CPU
    // New pods start active (0.5 CPU) but will sleep after idle timeout
    const remainingCpu = TOTAL_CPU_CORES - totalCpuRequested;
    const additionalPodsByCpu = Math.floor(remainingCpu / SLEEP_CPU_REQUEST);
    const additionalPodsByMemory = Math.floor(TOTAL_MEMORY_GB / BASE_MEMORY_GB) - students.length;
    const additionalPodsByLimit = TOTAL_POD_LIMIT - students.length;
    const additionalPods = Math.max(0, Math.min(additionalPodsByCpu, additionalPodsByMemory, additionalPodsByLimit));
    const MAX_PODS = students.length + additionalPods;

    // Sort by status: running first, then pending, then stopped/error, then offline
    students.sort((a, b) => {
      const order = { running: 0, pending: 1, stopped: 2, error: 3, offline: 4 };
      return (order[a.pod_status] ?? 5) - (order[b.pod_status] ?? 5);
    });

    return {
      students,
      total_pods: students.length,
      running_count: runningCount,
      max_capacity: MAX_PODS,
      empty_slots: MAX_PODS - students.length,
      capacity_info: {
        total_cpu_cores: TOTAL_CPU_CORES,
        cpu_requested: Math.round(totalCpuRequested * 100) / 100,
        cpu_available: Math.round(remainingCpu * 100) / 100,
        k8s_limit: TOTAL_POD_LIMIT,
        nodes: CLUSTER_NODES
      },
      total_used_gb: students.reduce((sum, s) => sum + (s.used_gb || 0), 0),
      available_tb: TOTAL_STORAGE_TB - (students.length * BASE_STORAGE_GB / 1024)
    };
  } catch (err) {
    console.error('[servers-api] Failed to get K8s pod data:', err.message);
    return { students: [], total_pods: 0, running_count: 0, max_capacity: 0, empty_slots: 0 };
  }
}

/**
 * Service definitions for hosted applications
 * Each service is checked via its K8s service endpoint
 */
const HOSTED_SERVICES = [
  {
    id: 'cs-lab',
    name: 'CS Lab Website',
    path: '/',
    healthPath: '/api/courses',
    namespace: 'hydra-system',
    selector: 'app.kubernetes.io/name=cs-lab',
    port: 5001,
    description: 'Department homepage, courses, faculty, events'
  },
  {
    id: 'jflap',
    name: 'FLAPJS',
    path: '/jflap',
    healthPath: '/jflap',
    namespace: 'hydra-infra',
    selector: 'app=flapjs',
    port: 8080,
    description: 'Formal languages and automata simulator'
  },
  {
    id: 'git-learning',
    name: 'Git Learning',
    path: '/git/',
    healthPath: '/git/',
    namespace: 'hydra-infra',
    selector: 'app=git-learning',
    port: 38765,
    description: 'Interactive Git tutorial and playground'
  },
  {
    id: 'java-executor',
    name: 'Java Executor',
    path: '/java',
    healthPath: '/java/health',
    namespace: 'hydra-infra',
    selector: 'app=java-executor',
    port: 3000,
    description: 'Online Java code execution sandbox'
  },
  {
    id: 'hackathons',
    name: 'Hackathon Voting',
    path: '/hackathons/',
    healthPath: '/hackathons/',
    namespace: 'hydra-infra',
    selector: 'app=hackathons',
    port: 45821,
    description: 'Hackathon project submission and judging'
  },
  {
    id: 'open-webui',
    name: 'OpenWebUI (GPT)',
    path: null,
    externalUrl: 'https://gpt.hydra.newpaltz.edu',
    healthPath: null,
    namespace: 'hydra-infra',
    selector: 'app=open-webui',
    port: 3000,
    description: 'AI chat interface powered by local LLMs'
  },
  {
    id: 'n8n',
    name: 'n8n Workflows',
    path: null,
    externalUrl: 'https://n8n.hydra.newpaltz.edu',
    healthPath: null,
    namespace: 'hydra-infra',
    selector: 'app=n8n',
    port: 5678,
    description: 'Workflow automation platform'
  }
];

/**
 * GET /api/servers/services
 * Returns status of all hosted services by checking K8s pod status
 */
router.get('/services', async (req, res) => {
  try {
    const services = await Promise.all(
      HOSTED_SERVICES.map(async (svc) => {
        const result = {
          id: svc.id,
          name: svc.name,
          path: svc.path,
          externalUrl: svc.externalUrl || null,
          description: svc.description,
          status: 'unknown',
          pods: { running: 0, total: 0 }
        };

        // Check pod status via K8s
        try {
          if (k8sClient) {
            const pods = await k8sClient.listPods(svc.selector, svc.namespace);
            result.pods.total = pods.length;
            result.pods.running = pods.filter(p =>
              p.status?.phase === 'Running' &&
              p.status?.containerStatuses?.[0]?.ready
            ).length;

            if (result.pods.running > 0) {
              result.status = 'online';
            } else if (result.pods.total > 0) {
              result.status = 'degraded';
            } else {
              result.status = 'offline';
            }
          }
        } catch (err) {
          // If K8s check fails, try HTTP health check as fallback
          result.status = 'unknown';
        }

        // HTTP health check fallback (only for services with healthPath)
        if (result.status === 'unknown' && svc.healthPath) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const resp = await fetch(`http://localhost:6969${svc.healthPath}`, {
              signal: controller.signal,
              redirect: 'manual'
            });
            clearTimeout(timeout);
            result.status = (resp.status >= 200 && resp.status < 400) ? 'online' : 'degraded';
          } catch {
            result.status = 'offline';
          }
        }

        return result;
      })
    );

    res.json({ services, checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('[servers-api] Failed to check services:', error);
    res.status(500).json({ error: 'Failed to check service status' });
  }
});

module.exports = router;
