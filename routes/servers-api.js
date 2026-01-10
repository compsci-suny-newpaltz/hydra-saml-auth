// routes/servers-api.js - Server metrics and GPU queue API
const express = require('express');
const router = express.Router();

// TODO: Import metrics collector when implemented
// const metricsCollector = require('../services/metrics-collector');

/**
 * GET /api/servers/status
 * Returns status and metrics for all cluster servers
 * Public endpoint - no authentication required
 */
router.get('/status', async (req, res) => {
  try {
    // TODO: Replace with real metrics from collector
    // const metrics = await metricsCollector.getLatestMetrics();

    // For now, return mock data that simulates the cluster state
    const mockData = generateMockServerData();

    res.json({
      servers: mockData,
      generated_at: new Date().toISOString()
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
 * Generate realistic mock server data
 * This will be replaced by real metrics collection
 */
function generateMockServerData() {
  // Add some randomization to make it look realistic
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randFloat = (min, max) => (Math.random() * (max - min) + min).toFixed(1);

  return {
    hydra: {
      status: 'online',
      role: 'control-plane',
      cpu_percent: rand(15, 55),
      ram_used_gb: rand(60, 120),
      ram_total_gb: 251,
      disk_used_gb: rand(8000, 12000),
      disk_total_gb: 21000,
      containers_running: rand(35, 55),
      zfs_status: 'ONLINE',
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
      containers_running: rand(1, 4),
      queue_depth: rand(0, 3),
      // Simulate an active training job most of the time
      training_job: Math.random() > 0.3 ? 'fine-tuning-llama3' : null,
      job_progress: rand(20, 85),
      job_eta: `~${rand(1, 4)}h ${rand(0, 59)}m`,
      last_updated: new Date().toISOString()
    }
  };
}

module.exports = router;
