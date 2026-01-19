#!/usr/bin/env node
// Hydra Cluster Metrics Agent
// Collects real system and GPU metrics for cluster monitoring
// Deploy on Chimera, Cerberus, or any GPU node

const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

const NODE_NAME = process.env.NODE_NAME || os.hostname();
const NODE_ROLE = process.env.NODE_ROLE || 'worker';
const PORT = parseInt(process.env.PORT || '9100');

// Cache for GPU metrics (nvidia-smi can be slow)
let gpuCache = { data: [], timestamp: 0 };
const GPU_CACHE_TTL = 5000; // 5 seconds

function getGpuMetrics() {
  const now = Date.now();
  if (now - gpuCache.timestamp < GPU_CACHE_TTL) {
    return gpuCache.data;
  }

  const gpus = [];
  try {
    // Query nvidia-smi for GPU info
    const output = execSync(
      'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 10000 }
    );

    const lines = output.trim().split('\n');
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 6) {
        gpus.push({
          index: parseInt(parts[0]) || 0,
          name: parts[1] || 'Unknown GPU',
          utilization_percent: parseInt(parts[2]) || 0,
          memory_used_gb: Math.round((parseInt(parts[3]) || 0) / 1024 * 10) / 10,
          memory_total_gb: Math.round((parseInt(parts[4]) || 0) / 1024 * 10) / 10,
          temperature_c: parseInt(parts[5]) || 0,
          power_draw_w: Math.round(parseFloat(parts[6]) || 0)
        });
      }
    }
  } catch (e) {
    console.error('[metrics-agent] nvidia-smi failed:', e.message);
  }

  gpuCache = { data: gpus, timestamp: now };
  return gpus;
}

function getSystemMetrics() {
  // CPU usage from /proc/stat
  let cpuPercent = 0;
  try {
    const output = execSync(
      "top -bn1 | grep 'Cpu(s)' | awk '{print $2}'",
      { encoding: 'utf8', timeout: 5000 }
    );
    cpuPercent = Math.round(parseFloat(output.trim()) || 0);
  } catch (e) {
    // Fallback to node.js calculation
    const cpus = os.cpus();
    cpuPercent = Math.round(cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length);
  }

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Disk usage
  let diskUsedGb = 0;
  let diskTotalGb = 1000;
  try {
    const dfOutput = execSync("df -BG / | tail -1 | awk '{print $2, $3}'", { encoding: 'utf8', timeout: 5000 });
    const [total, used] = dfOutput.trim().split(/\s+/).map(s => parseInt(s.replace('G', '')));
    if (!isNaN(total)) diskTotalGb = total;
    if (!isNaN(used)) diskUsedGb = used;
  } catch (e) {
    // Use defaults
  }

  // Load average
  const loadAvg = os.loadavg();

  // Uptime
  const uptimeHours = Math.round(os.uptime() / 3600);

  return {
    cpu_percent: cpuPercent,
    ram_used_gb: Math.round(usedMem / (1024 * 1024 * 1024)),
    ram_total_gb: Math.round(totalMem / (1024 * 1024 * 1024)),
    disk_used_gb: diskUsedGb,
    disk_total_gb: diskTotalGb,
    load_average: loadAvg.map(x => Math.round(x * 100) / 100),
    uptime_hours: uptimeHours
  };
}

function getContainerMetrics() {
  let running = 0;
  let paused = 0;
  let stopped = 0;

  try {
    const output = execSync('docker ps -a --format "{{.State}}" 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const states = output.trim().split('\n').filter(Boolean);
    for (const state of states) {
      if (state === 'running') running++;
      else if (state === 'paused') paused++;
      else stopped++;
    }
  } catch (e) {
    // Docker not available or permission denied
  }

  return { running, paused, stopped };
}

function getQueueMetrics() {
  // Placeholder - could be integrated with a job queue system
  return {
    pending: 0,
    estimated_wait_minutes: 0
  };
}

function getActiveTrainingJob() {
  // Check for common training processes
  try {
    // Look for python processes with common training framework indicators
    const output = execSync(
      "ps aux | grep -E 'python.*train|python.*fine|torchrun|deepspeed' | grep -v grep | head -1",
      { encoding: 'utf8', timeout: 5000 }
    );
    if (output.trim()) {
      // Extract process name from command line
      const cmd = output.split(/\s+/).slice(10).join(' ').substring(0, 50);
      return {
        name: cmd || 'training-job',
        progress_percent: null, // Can't determine without integration
        eta_minutes: null
      };
    }
  } catch (e) {
    // No training job found
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    const metrics = {
      hostname: NODE_NAME,
      role: NODE_ROLE,
      timestamp: new Date().toISOString(),
      gpus: getGpuMetrics(),
      system: getSystemMetrics(),
      containers: getContainerMetrics(),
      queue: getQueueMetrics(),
      active_training_job: getActiveTrainingJob()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics, null, 2));
  } else if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', node: NODE_NAME }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${NODE_NAME}] Metrics agent running on port ${PORT}`);
  console.log(`[${NODE_NAME}] Role: ${NODE_ROLE}`);
  console.log(`[${NODE_NAME}] Endpoints: GET /metrics, GET /health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[metrics-agent] Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[metrics-agent] Interrupted, shutting down...');
  server.close(() => process.exit(0));
});
