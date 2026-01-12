// Mock metrics server for dev environment
// Simulates GPU node metrics for Chimera and Cerberus

const http = require('http');

const NODE_NAME = process.env.NODE_NAME || 'unknown';
const NODE_ROLE = process.env.NODE_ROLE || 'worker';
const GPU_COUNT = parseInt(process.env.GPU_COUNT || '0');
const GPU_MODEL = process.env.GPU_MODEL || 'Unknown GPU';
const GPU_VRAM = parseInt(process.env.GPU_VRAM || '24');
const RAM_TOTAL = parseInt(process.env.RAM_TOTAL || '64');
const DISK_TOTAL = parseInt(process.env.DISK_TOTAL || '1000');
const PORT = parseInt(process.env.PORT || '9100');

// Simulate varying metrics
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateGpuMetrics() {
  const gpus = [];
  for (let i = 0; i < GPU_COUNT; i++) {
    // Simulate realistic GPU usage patterns
    const isTraining = NODE_ROLE === 'training';
    const baseUtil = isTraining ? 85 : 40;
    const utilVariance = isTraining ? 15 : 35;

    const util = Math.min(100, randomBetween(baseUtil - utilVariance, baseUtil + utilVariance));
    const vramUsed = Math.round((util / 100) * GPU_VRAM * (0.7 + Math.random() * 0.3));
    const temp = randomBetween(55, 82);

    gpus.push({
      index: i,
      name: GPU_MODEL,
      utilization_percent: util,
      memory_used_gb: vramUsed,
      memory_total_gb: GPU_VRAM,
      temperature_c: temp,
      power_draw_w: Math.round(util * 3.5),
      fan_speed_percent: Math.round(temp * 0.8)
    });
  }
  return gpus;
}

function generateSystemMetrics() {
  const cpuPercent = randomBetween(15, 65);
  const ramUsed = Math.round(RAM_TOTAL * (0.3 + Math.random() * 0.4));
  const diskUsed = Math.round(DISK_TOTAL * (0.4 + Math.random() * 0.3));

  return {
    cpu_percent: cpuPercent,
    ram_used_gb: ramUsed,
    ram_total_gb: RAM_TOTAL,
    disk_used_gb: diskUsed,
    disk_total_gb: DISK_TOTAL,
    load_average: [cpuPercent / 25, cpuPercent / 30, cpuPercent / 35].map(x => Math.round(x * 100) / 100),
    uptime_hours: randomBetween(100, 2000)
  };
}

function generateContainerMetrics() {
  const runningCount = randomBetween(2, 12);
  return {
    running: runningCount,
    paused: 0,
    stopped: randomBetween(0, 5)
  };
}

function generateTrainingJob() {
  if (NODE_ROLE !== 'training') return null;

  // Simulate an active training job 70% of the time
  if (Math.random() > 0.7) return null;

  const jobs = [
    { name: 'fine-tuning-llama3', model: 'llama3.1:70b' },
    { name: 'codellama-finetune', model: 'codellama:34b' },
    { name: 'custom-embedding-train', model: 'nomic-embed-text' },
    { name: 'rag-model-training', model: 'mistral:7b' }
  ];

  const job = jobs[Math.floor(Math.random() * jobs.length)];
  const progress = randomBetween(10, 95);
  const etaMinutes = Math.round((100 - progress) * 2.5);

  return {
    name: job.name,
    model: job.model,
    progress_percent: progress,
    eta_minutes: etaMinutes,
    started_at: new Date(Date.now() - randomBetween(60, 300) * 60 * 1000).toISOString()
  };
}

function generateQueueMetrics() {
  return {
    pending: randomBetween(0, 5),
    estimated_wait_minutes: randomBetween(10, 90)
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/metrics' && req.method === 'GET') {
    const metrics = {
      hostname: NODE_NAME,
      role: NODE_ROLE,
      timestamp: new Date().toISOString(),
      gpus: generateGpuMetrics(),
      system: generateSystemMetrics(),
      containers: generateContainerMetrics(),
      queue: generateQueueMetrics(),
      active_training_job: generateTrainingJob()
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
  console.log(`[${NODE_NAME}] Mock metrics server running on port ${PORT}`);
  console.log(`[${NODE_NAME}] Role: ${NODE_ROLE}, GPUs: ${GPU_COUNT}x ${GPU_MODEL}`);
});
