// Hydra Cluster Status Monitor - Client-side JavaScript

const REFRESH_INTERVAL = 30000; // 30 seconds
let refreshTimer = null;
let isUpdating = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  updateTimestamp();
  fetchServerStatus();
  fetchServiceStatus();

  // Set up auto-refresh
  refreshTimer = setInterval(() => {
    fetchServerStatus();
    fetchServiceStatus();
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

  renderHydra(data.servers.hydra, data.showPodDetails);
  renderChimera(data.servers.chimera);
  renderCerberus(data.servers.cerberus);
}

// Hydra (Control Plane)
function renderHydra(server, showPodDetails = false) {
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

  // RAID (pod storage) - primary storage bar
  const raidUsed = server.raid_used_gb || 0;
  const raidTotal = server.raid_total_gb || 21000;
  const raidPercent = (raidUsed / raidTotal) * 100;
  setMetricBar('hydra-raid-bar', raidPercent);
  document.getElementById('hydra-raid').textContent = `${raidUsed} GB / ${(raidTotal/1000).toFixed(0)} TB`;

  // OS drive (boot SSD)
  const diskUsed = server.disk_used_gb || 0;
  const diskTotal = server.disk_total_gb || 1000;
  const diskPercent = (diskUsed / diskTotal) * 100;
  setMetricBar('hydra-os-bar', diskPercent);
  document.getElementById('hydra-os').textContent = `${diskUsed}/${diskTotal} GB`;

  // Containers
  document.getElementById('hydra-containers').textContent = `${server.containers_running || 0} running`;

  // ZFS
  document.getElementById('hydra-zfs').textContent = server.zfs_status || 'ONLINE';

  // Storage Cluster
  renderStorageCluster(server.storage_cluster, showPodDetails);
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
function renderStorageCluster(data, showPodDetails = false) {
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

    // Colors based on pod status
    if (student.pod_status === 'running') {
      cube.style.backgroundColor = '#10b981'; // green
    } else if (student.pod_status === 'pending') {
      cube.style.backgroundColor = '#f59e0b'; // yellow
    } else if (student.pod_status === 'offline') {
      cube.style.backgroundColor = '#555'; // grey — has storage but no pod
    } else {
      cube.style.backgroundColor = '#ef4444'; // red — error/stopped
    }

    // Admin: hover + click cubes with detail popover
    if (showPodDetails && student.username) {
      cube.classList.add('admin-hoverable');
      cube.addEventListener('mouseenter', () => showPodPopover(cube, student, false));
      cube.addEventListener('mouseleave', schedulePodPopoverClose);
      cube.addEventListener('click', (e) => { e.stopPropagation(); showPodPopover(cube, student, true); });
    } else {
      cube.title = student.pod_status;
    }
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

// Pod detail popover for admin hover/click
let popoverCloseTimer = null;
let popoverPinned = false;

function showPodPopover(cubeEl, student, pinned = false) {
  // Cancel any pending close
  if (popoverCloseTimer) { clearTimeout(popoverCloseTimer); popoverCloseTimer = null; }

  // If pinned popover is already showing for same student, close it (toggle)
  const existing = document.getElementById('pod-popover');
  if (pinned && existing && existing.dataset.user === student.username) {
    closePodPopover(); return;
  }

  // Remove any existing popover
  closePodPopover();
  popoverPinned = pinned;

  const popover = document.createElement('div');
  popover.className = 'pod-popover';
  popover.id = 'pod-popover';

  const statusColor = student.pod_status === 'running' ? '#10b981' :
                       student.pod_status === 'pending' ? '#f59e0b' : '#ef4444';

  popover.innerHTML = `
    <div class="pod-popover-header">
      <span class="pod-popover-user">${student.username}</span>
      <span class="pod-popover-status" style="color:${statusColor}">${(student.pod_status || '').toUpperCase()}</span>
    </div>
    <div class="pod-popover-rows">
      <div class="pod-popover-row"><span class="pop-label">IP:</span><span class="pop-value">${student.pod_ip || 'none'}</span></div>
      <div class="pod-popover-row"><span class="pop-label">NODE:</span><span class="pop-value">${student.node || '-'}</span></div>
      <div class="pod-popover-row"><span class="pop-label">CPU:</span><span class="pop-value">${student.cpu_request || '-'}</span></div>
      <div class="pod-popover-row"><span class="pop-label">MEM:</span><span class="pop-value">${student.used_gb ? student.used_gb.toFixed(1) + ' GB' : '-'}</span></div>
      <div class="pod-popover-row"><span class="pop-label">PHASE:</span><span class="pop-value">${student.phase || '-'}</span></div>
    </div>
  `;

  // Keep popover open when hovering over it
  popover.addEventListener('mouseenter', () => {
    if (popoverCloseTimer) { clearTimeout(popoverCloseTimer); popoverCloseTimer = null; }
  });
  popover.addEventListener('mouseleave', schedulePodPopoverClose);

  popover.dataset.user = student.username;

  // Close pinned popover on outside click
  if (pinned) {
    popover.classList.add('pinned');
    setTimeout(() => {
      document.addEventListener('click', closePodPopover, { once: true });
    }, 0);
  }

  document.body.appendChild(popover);

  // Position relative to the cube
  const rect = cubeEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();

  let top = rect.bottom + 6;
  let left = rect.left + rect.width / 2 - popRect.width / 2;

  // Keep within viewport
  if (left < 8) left = 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) {
    top = rect.top - popRect.height - 6; // flip above
  }

  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
  popover.style.opacity = '1';
}

function schedulePodPopoverClose() {
  // Don't auto-close if pinned (clicked)
  if (popoverPinned) return;
  if (popoverCloseTimer) clearTimeout(popoverCloseTimer);
  popoverCloseTimer = setTimeout(closePodPopover, 200);
}

function closePodPopover() {
  const existing = document.getElementById('pod-popover');
  if (existing) existing.remove();
  popoverCloseTimer = null;
  popoverPinned = false;
}

// Hosted Services
async function fetchServiceStatus() {
  try {
    const response = await fetch('/api/servers/services');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderServices(data.services);
  } catch (error) {
    console.error('Failed to fetch service status:', error);
  }
}

function renderServices(services) {
  const grid = document.getElementById('services-grid');
  if (!services || services.length === 0) {
    grid.innerHTML = '<div class="loading">No services found</div>';
    return;
  }

  grid.innerHTML = services.map(svc => {
    const statusClass = svc.status === 'online' ? 'online' :
                        svc.status === 'degraded' ? 'warning' : 'offline';
    const statusText = svc.status.toUpperCase();
    const url = svc.externalUrl || (svc.path ? svc.path : '#');
    const isClickable = svc.status === 'online' && url !== '#';
    const tag = isClickable ? 'a' : 'div';
    const href = isClickable ? ` href="${url}" target="_blank" rel="noopener noreferrer"` : '';
    const pods = svc.pods ? `${svc.pods.running}/${svc.pods.total}` : '--';

    return `
      <${tag} class="service-card ${statusClass}"${href}>
        <div class="service-card-header">
          <span class="service-name">${svc.name}</span>
          <span class="service-status ${statusClass}">${statusText}</span>
        </div>
        <div class="service-desc">${svc.description}</div>
        <div class="service-meta">
          <span class="service-pods">PODS: ${pods}</span>
          <span class="service-path">${svc.externalUrl || svc.path || '--'}</span>
        </div>
      </${tag}>
    `;
  }).join('');
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
