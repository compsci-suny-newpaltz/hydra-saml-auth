// Hydra Cluster Status Monitor - Client-side JavaScript

const REFRESH_INTERVAL = 30000; // 30 seconds
let refreshTimer = null;
let isUpdating = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  updateTimestamp();
  fetchServerStatus();

  // Set up auto-refresh
  refreshTimer = setInterval(() => {
    fetchServerStatus();
  }, REFRESH_INTERVAL);

  // Update timestamp every second
  setInterval(updateTimestamp, 1000);
});

function updateTimestamp() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  document.getElementById('header-timestamp').textContent = timeStr;
}

async function fetchServerStatus() {
  if (isUpdating) return;
  isUpdating = true;

  setRefreshIndicator('updating', 'Updating...');

  try {
    const response = await fetch('/api/servers/status');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderAllServers(data);
    setRefreshIndicator('connected', 'Connected');
  } catch (error) {
    console.error('Failed to fetch server status:', error);
    setRefreshIndicator('error', 'Connection Error');
  } finally {
    isUpdating = false;
  }
}

function setRefreshIndicator(state, text) {
  const dot = document.getElementById('connection-dot');
  const textEl = document.getElementById('refresh-text');
  const indicator = document.getElementById('refresh-indicator');

  dot.className = 'connection-indicator';
  indicator.className = 'refresh-indicator';

  switch (state) {
    case 'connected':
      dot.classList.add('connected');
      break;
    case 'updating':
      indicator.classList.add('updating');
      break;
    case 'error':
      dot.classList.add('disconnected');
      break;
  }

  textEl.textContent = text;
}

function renderAllServers(data) {
  if (!data.servers) return;

  renderHydra(data.servers.hydra);
  renderChimera(data.servers.chimera);
  renderCerberus(data.servers.cerberus);
}

// Hydra (Control Plane)
function renderHydra(server) {
  if (!server) return;

  updateServerStatus('hydra', server.status);

  // CPU
  const cpuPercent = server.cpu_percent || 0;
  setMetricBar('hydra-cpu-bar', cpuPercent);
  document.getElementById('hydra-cpu').textContent = `${cpuPercent.toFixed(0)}%`;

  // RAM
  const ramUsed = server.ram_used_gb || 0;
  const ramTotal = server.ram_total_gb || 251;
  const ramPercent = (ramUsed / ramTotal) * 100;
  setMetricBar('hydra-ram-bar', ramPercent);
  document.getElementById('hydra-ram').textContent = `${ramUsed.toFixed(0)}/${ramTotal} GB`;

  // Disk (boot SSD + RAID array)
  const diskUsed = server.disk_used_gb || 0;
  const diskTotal = server.disk_total_gb || 1000;
  const raidUsed = server.raid_used_gb || 0;
  const raidTotal = server.raid_total_gb || 21000;
  const diskPercent = (diskUsed / diskTotal) * 100;
  setMetricBar('hydra-disk-bar', diskPercent);
  document.getElementById('hydra-disk').textContent = `SSD: ${diskUsed}/${diskTotal} GB | RAID: ${(raidUsed/1000).toFixed(1)}/${(raidTotal/1000).toFixed(0)} TB`;

  // Containers
  document.getElementById('hydra-containers').textContent = `${server.containers_running || 0} running`;

  // ZFS
  document.getElementById('hydra-zfs').textContent = server.zfs_status || 'ONLINE';

  // Storage Cluster
  renderStorageCluster(server.storage_cluster);
}

// Chimera (Inference Node)
function renderChimera(server) {
  if (!server) return;

  updateServerStatus('chimera', server.status);

  // GPUs
  renderGpuCards('chimera-gpus', server.gpus);

  // CPU
  const cpuPercent = server.cpu_percent || 0;
  setMetricBar('chimera-cpu-bar', cpuPercent);
  document.getElementById('chimera-cpu').textContent = `${cpuPercent.toFixed(0)}%`;

  // RAM
  const ramUsed = server.ram_used_gb || 0;
  const ramTotal = server.ram_total_gb || 251;
  const ramPercent = (ramUsed / ramTotal) * 100;
  setMetricBar('chimera-ram-bar', ramPercent);
  document.getElementById('chimera-ram').textContent = `${ramUsed.toFixed(0)}/${ramTotal} GB`;

  // Queue stats
  document.getElementById('chimera-queue').textContent = server.queue_depth || 0;
  document.getElementById('chimera-wait').textContent = server.avg_wait_minutes ? `~${server.avg_wait_minutes}m` : '--';
  document.getElementById('chimera-containers').textContent = server.containers_running || 0;
}

// Cerberus (Training Node)
function renderCerberus(server) {
  if (!server) return;

  // Determine status based on training job
  let status = server.status || 'online';
  if (server.training_job) {
    status = 'busy';
  }
  updateServerStatus('cerberus', status);

  // GPUs
  renderGpuCards('cerberus-gpus', server.gpus);

  // CPU
  const cpuPercent = server.cpu_percent || 0;
  setMetricBar('cerberus-cpu-bar', cpuPercent);
  document.getElementById('cerberus-cpu').textContent = `${cpuPercent.toFixed(0)}%`;

  // RAM
  const ramUsed = server.ram_used_gb || 0;
  const ramTotal = server.ram_total_gb || 64;
  const ramPercent = (ramUsed / ramTotal) * 100;
  setMetricBar('cerberus-ram-bar', ramPercent);
  document.getElementById('cerberus-ram').textContent = `${ramUsed.toFixed(0)}/${ramTotal} GB`;

  // Training job
  const jobDiv = document.getElementById('cerberus-job');
  if (server.training_job) {
    jobDiv.style.display = 'block';
    document.getElementById('cerberus-job-name').textContent = server.training_job;
    const progress = server.job_progress || 0;
    document.getElementById('cerberus-job-progress').style.width = `${progress}%`;
    document.getElementById('cerberus-job-percent').textContent = `${progress}%`;
    document.getElementById('cerberus-job-eta').textContent = server.job_eta || '--';
  } else {
    jobDiv.style.display = 'none';
  }

  // Queue stats
  document.getElementById('cerberus-queue').textContent = server.queue_depth || 0;
  document.getElementById('cerberus-containers').textContent = server.containers_running || 0;
}

function renderGpuCards(containerId, gpus) {
  const container = document.getElementById(containerId);
  if (!gpus || gpus.length === 0) {
    container.innerHTML = '<div class="error-message">No GPU data available</div>';
    return;
  }

  container.innerHTML = gpus.map((gpu, i) => `
    <div class="gpu-card">
      <div class="gpu-header">
        <span class="gpu-name">${gpu.name || 'GPU'} #${gpu.index ?? i}</span>
        <span class="gpu-temp ${gpu.temp > 80 ? 'hot' : ''}">${gpu.temp || '--'}°C</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">UTIL:</span>
        <div class="metric-bar-container">
          <div class="metric-bar">
            <div class="metric-bar-fill ${getUtilClass(gpu.util)}" style="width: ${gpu.util || 0}%"></div>
          </div>
        </div>
        <span class="metric-value">${gpu.util || 0}%</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">VRAM:</span>
        <div class="metric-bar-container">
          <div class="metric-bar">
            <div class="metric-bar-fill ${getUtilClass((gpu.vram_used / gpu.vram_total) * 100)}" style="width: ${((gpu.vram_used || 0) / (gpu.vram_total || 1)) * 100}%"></div>
          </div>
        </div>
        <span class="metric-value">${gpu.vram_used || 0}/${gpu.vram_total || 0} GB</span>
      </div>
    </div>
  `).join('');
}

function setMetricBar(barId, percent) {
  const bar = document.getElementById(barId);
  if (!bar) return;

  bar.style.width = `${percent}%`;
  bar.className = 'metric-bar-fill ' + getUtilClass(percent);
}

function getUtilClass(percent) {
  if (percent >= 90) return 'high';
  if (percent >= 70) return 'medium';
  return '';
}

function updateServerStatus(server, status) {
  const panel = document.getElementById(`panel-${server}`);
  const statusEl = document.getElementById(`status-${server}`);

  // Reset classes
  panel.className = 'server-panel';
  statusEl.className = 'panel-status';

  switch (status) {
    case 'online':
      panel.classList.add('online');
      statusEl.classList.add('online');
      statusEl.textContent = 'ONLINE';
      break;
    case 'busy':
      panel.classList.add('busy');
      statusEl.classList.add('busy');
      statusEl.textContent = 'BUSY';
      break;
    case 'warning':
      panel.classList.add('warning');
      statusEl.classList.add('warning');
      statusEl.textContent = 'WARNING';
      break;
    case 'offline':
      panel.classList.add('offline');
      statusEl.classList.add('offline');
      statusEl.textContent = 'OFFLINE';
      break;
    default:
      panel.classList.add('online');
      statusEl.classList.add('online');
      statusEl.textContent = 'ONLINE';
  }
}

// Render storage cluster visualization - only show active pods
function renderStorageCluster(data) {
  const grid = document.getElementById('hydra-storage-grid');
  const totalEl = document.getElementById('hydra-storage-total');
  const usedEl = document.getElementById('hydra-storage-used');
  const availEl = document.getElementById('hydra-storage-available');

  if (!data || !data.students) {
    grid.innerHTML = '<div class="loading">No pod data</div>';
    return;
  }

  // Clear grid
  grid.innerHTML = '';

  const maxCapacity = data.max_capacity || 232;

  // Only show actual pods (no empty slots)
  data.students.forEach(student => {
    const cube = document.createElement('div');
    cube.className = 'cube';

    // Simple colors based on pod status
    if (student.pod_status === 'running') {
      cube.style.backgroundColor = '#10b981'; // green
    } else if (student.pod_status === 'pending') {
      cube.style.backgroundColor = '#f59e0b'; // yellow
    } else {
      cube.style.backgroundColor = '#ef4444'; // red
    }

    // Tooltip with student info
    cube.title = `${student.username} | ${student.pod_status} | ${student.node} | ${student.pod_ip || '-'}`;
    grid.appendChild(cube);
  });

  // Update summary
  const runningCount = data.running_count || 0;
  const totalPods = data.total_pods || data.students.length;
  const emptySlots = maxCapacity - totalPods;

  totalEl.textContent = `${totalPods} / ${maxCapacity} pods`;
  usedEl.textContent = `${runningCount} running`;
  availEl.textContent = `${emptySlots} available`;
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
