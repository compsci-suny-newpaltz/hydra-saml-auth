// routes/infra-api.js - Infrastructure services API for admin/faculty
// Manages deployments in the hydra-infra namespace

const express = require('express');
const router = express.Router();
const infraService = require('../services/k8s-infra');
const { isWhitelisted } = require('../services/db-init');

const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);

// ==================== AUTH MIDDLEWARE ====================

async function requireAdmin(req, res, next) {
  if (!req.isAuthenticated?.() || !req.user?.email) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const email = req.user.email.toLowerCase();
  const isFaculty = (req.user.affiliation || '').toLowerCase() === 'faculty';
  const isEnvWhitelisted = ADMIN_USERS.includes(email);

  let isDbWhitelisted = false;
  try {
    isDbWhitelisted = await isWhitelisted(email);
  } catch (e) {
    console.warn('[infra-api] Error checking whitelist:', e.message);
  }

  if (!isFaculty && !isEnvWhitelisted && !isDbWhitelisted) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

router.use(requireAdmin);

// ==================== LIST / GET ====================

// GET / — list all infra services
router.get('/', async (req, res) => {
  try {
    const services = await infraService.listInfraServices();
    res.json(services);
  } catch (err) {
    console.error('[infra-api] Error listing services:', err.message);
    res.status(500).json({ error: 'Failed to list infra services' });
  }
});

// GET /:name — service detail
router.get('/:name', async (req, res) => {
  try {
    const detail = await infraService.getServiceDetail(req.params.name);
    if (!detail) return res.status(404).json({ error: 'Service not found' });
    res.json(detail);
  } catch (err) {
    console.error('[infra-api] Error getting service:', err.message);
    res.status(500).json({ error: 'Failed to get service detail' });
  }
});

// ==================== LIFECYCLE ====================

// POST /:name/start — scale to 1
router.post('/:name/start', async (req, res) => {
  try {
    await infraService.scaleService(req.params.name, 1);
    res.json({ success: true, message: `${req.params.name} started` });
  } catch (err) {
    console.error('[infra-api] Error starting service:', err.message);
    res.status(500).json({ error: 'Failed to start service' });
  }
});

// POST /:name/stop — scale to 0
router.post('/:name/stop', async (req, res) => {
  try {
    await infraService.scaleService(req.params.name, 0);
    res.json({ success: true, message: `${req.params.name} stopped` });
  } catch (err) {
    console.error('[infra-api] Error stopping service:', err.message);
    res.status(500).json({ error: 'Failed to stop service' });
  }
});

// POST /:name/restart — rollout restart
router.post('/:name/restart', async (req, res) => {
  try {
    await infraService.restartService(req.params.name);
    res.json({ success: true, message: `${req.params.name} restarting` });
  } catch (err) {
    console.error('[infra-api] Error restarting service:', err.message);
    res.status(500).json({ error: 'Failed to restart service' });
  }
});

// POST /:name/scale — scale to N replicas
router.post('/:name/scale', async (req, res) => {
  try {
    const replicas = parseInt(req.body.replicas, 10);
    if (isNaN(replicas) || replicas < 0 || replicas > 10) {
      return res.status(400).json({ error: 'Replicas must be 0-10' });
    }
    await infraService.scaleService(req.params.name, replicas);
    res.json({ success: true, message: `${req.params.name} scaled to ${replicas}` });
  } catch (err) {
    console.error('[infra-api] Error scaling service:', err.message);
    res.status(500).json({ error: 'Failed to scale service' });
  }
});

// DELETE /:name — delete service
router.delete('/:name', async (req, res) => {
  try {
    const deletePVC = req.body.deletePVC === true;
    const results = await infraService.deleteService(req.params.name, deletePVC);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[infra-api] Error deleting service:', err.message);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

// ==================== LOGS ====================

// GET /:name/logs — get pod logs (SSE stream or JSON)
router.get('/:name/logs', async (req, res) => {
  try {
    const tail = parseInt(req.query.tail, 10) || 200;
    const logs = await infraService.getServiceLogs(req.params.name, tail);
    res.json({ name: req.params.name, logs });
  } catch (err) {
    console.error('[infra-api] Error getting logs:', err.message);
    res.status(500).json({ error: err.message || 'Failed to get logs' });
  }
});

// ==================== DEPLOY ====================

// POST /deploy/compose — deploy from Docker Compose YAML
router.post('/deploy/compose', async (req, res) => {
  try {
    const { name, compose } = req.body;
    if (!name || !compose) {
      return res.status(400).json({ error: 'Missing required fields: name, compose' });
    }

    // Validate service name
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
      return res.status(400).json({ error: 'Invalid service name. Use lowercase letters, numbers, and hyphens.' });
    }

    const createdBy = req.user.email.split('@')[0];
    const results = await infraService.deployFromCompose(compose, name, createdBy);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[infra-api] Error deploying from compose:', err.message);
    res.status(400).json({ error: err.message || 'Failed to deploy from compose' });
  }
});

// POST /deploy/manifest — deploy raw K8s YAML manifests
router.post('/deploy/manifest', async (req, res) => {
  try {
    const { manifests } = req.body;
    if (!manifests) {
      return res.status(400).json({ error: 'Missing required field: manifests' });
    }

    const createdBy = req.user.email.split('@')[0];
    const results = await infraService.deployFromManifests(manifests, createdBy);
    res.json({ success: true, results });
  } catch (err) {
    console.error('[infra-api] Error deploying manifests:', err.message);
    res.status(400).json({ error: err.message || 'Failed to deploy manifests' });
  }
});

// POST /deploy/github — deploy from GitHub repo (clone + look for compose/manifests)
router.post('/deploy/github', async (req, res) => {
  try {
    const { repoUrl, branch, name } = req.body;
    if (!repoUrl) {
      return res.status(400).json({ error: 'Missing required field: repoUrl' });
    }

    // Validate GitHub URL
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(repoUrl)) {
      return res.status(400).json({ error: 'Invalid GitHub URL' });
    }

    const serviceName = name || repoUrl.split('/').pop().replace(/\.git$/, '').toLowerCase();
    const createdBy = req.user.email.split('@')[0];

    // Clone repo to temp dir, look for docker-compose.yml or k8s manifests
    const { execSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-deploy-'));
    try {
      const branchArg = branch ? `--branch ${branch}` : '';
      execSync(`git clone --depth 1 ${branchArg} ${repoUrl} ${tmpDir}`, {
        timeout: 30000,
        stdio: 'pipe'
      });

      // Look for docker-compose.yml first
      const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
      let composeFile = null;
      for (const f of composeFiles) {
        const p = path.join(tmpDir, f);
        if (fs.existsSync(p)) {
          composeFile = p;
          break;
        }
      }

      if (composeFile) {
        const composeYaml = fs.readFileSync(composeFile, 'utf8');
        const results = await infraService.deployFromCompose(composeYaml, serviceName, createdBy);
        return res.json({ success: true, source: 'compose', results });
      }

      // Look for k8s manifests directory
      const k8sDirs = ['k8s', 'kubernetes', 'manifests', 'deploy'];
      for (const d of k8sDirs) {
        const dirPath = path.join(tmpDir, d);
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
          const yamlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
          if (yamlFiles.length) {
            const allYaml = yamlFiles.map(f => fs.readFileSync(path.join(dirPath, f), 'utf8')).join('\n---\n');
            const results = await infraService.deployFromManifests(allYaml, createdBy);
            return res.json({ success: true, source: 'manifests', results });
          }
        }
      }

      res.status(400).json({ error: 'No docker-compose.yml or k8s manifests found in repo' });
    } finally {
      execSync(`rm -rf ${tmpDir}`, { stdio: 'pipe' });
    }
  } catch (err) {
    console.error('[infra-api] Error deploying from GitHub:', err.message);
    res.status(400).json({ error: err.message || 'Failed to deploy from GitHub' });
  }
});

module.exports = router;
