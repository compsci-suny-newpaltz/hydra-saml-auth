// services/docker-containers.js - Docker-based container management
// Provides the same interface as k8s-containers.js for Docker mode

const Docker = require('dockerode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const runtimeConfig = require('../config/runtime');
const resourceConfig = require('../config/resources');

// Initialize Docker client
const docker = new Docker({ socketPath: runtimeConfig.docker.socketPath });

// Constants
const MAIN_NETWORK = runtimeConfig.docker.network || 'hydra_students_net';
const TRAEFIK_DYNAMIC_DIR = runtimeConfig.docker.traefikConfigPath || '/etc/traefik/dynamic';
const CODE_SERVER_PORT = 8443;
const JUPYTER_PORT = 8888;
const SHARED_DIR = process.env.SHARED_DIR || '/srv/shared';
const SHARED_MOUNT_TARGET = '/shared';
const SHARED_DIR_ENABLED = process.env.SHARED_DIR_ENABLED !== 'false';

// ==================== HELPER FUNCTIONS ====================

// Generate a random password
function generatePassword(length = 16) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

// Check if shared directory should be mounted
function shouldMountSharedDir() {
  if (!SHARED_DIR_ENABLED) return false;
  try {
    return fsSync.existsSync(SHARED_DIR);
  } catch {
    return false;
  }
}

// Ensure shared directory exists (best effort)
async function ensureSharedDir() {
  try {
    if (!fsSync.existsSync(SHARED_DIR)) {
      fsSync.mkdirSync(SHARED_DIR, { recursive: true, mode: 0o755 });
      console.log(`[Docker] Created shared directory: ${SHARED_DIR}`);
    }
  } catch (err) {
    console.warn(`[Docker] Could not create shared directory ${SHARED_DIR}:`, err.message);
  }
}

// Pull Docker image
async function pullImage(img) {
  return new Promise((resolve, reject) => {
    docker.pull(img, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// Check if image exists locally
async function imageExists(imageName) {
  try {
    const image = docker.getImage(imageName);
    await image.inspect();
    return true;
  } catch (err) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}

// Ensure volume exists
async function ensureVolume(volumeName, username) {
  try {
    const vol = docker.getVolume(volumeName);
    await vol.inspect();
  } catch {
    await docker.createVolume({
      Name: volumeName,
      Labels: {
        'hydra.managed_by': 'hydra-saml-auth',
        'hydra.owner': username
      }
    });
  }
}

// Ensure network exists
async function ensureNetwork(networkName) {
  try {
    const net = docker.getNetwork(networkName);
    await net.inspect();
  } catch {
    await docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Attachable: true
    });
  }
}

// Get student's container
async function getStudentContainer(username) {
  const containerName = `student-${username}`;
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    return { container, info };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

// Write routes to Traefik dynamic config file
async function writeTraefikConfig(username, routes) {
  const filePath = path.join(TRAEFIK_DYNAMIC_DIR, `student-${username}.yaml`);

  const config = {
    http: {
      routers: {},
      services: {},
      middlewares: {}
    }
  };

  // Add auth middleware
  const authMiddlewareName = `student-${username}-auth`;
  config.http.middlewares[authMiddlewareName] = {
    forwardAuth: {
      address: 'http://host.docker.internal:6969/auth/verify',
      trustForwardHeader: true
    }
  };

  for (const route of routes) {
    const routerName = `student-${username}-${route.endpoint}`;
    const basePath = `/students/${username}/${route.endpoint}`;

    // Router
    config.http.routers[routerName] = {
      entryPoints: ['web'],
      rule: `PathPrefix(\`${basePath}\`)`,
      service: routerName,
      middlewares: route.endpoint === 'jupyter'
        ? [authMiddlewareName]
        : [authMiddlewareName, `${routerName}-strip`]
    };

    // Service - point to student container
    config.http.services[routerName] = {
      loadBalancer: {
        servers: [{ url: `http://student-${username}:${route.port}` }]
      }
    };

    // Strip prefix middleware (not for jupyter)
    if (route.endpoint !== 'jupyter') {
      config.http.middlewares[`${routerName}-strip`] = {
        stripPrefix: {
          prefixes: [basePath]
        }
      };
    }
  }

  await fs.writeFile(filePath, yaml.dump(config), 'utf8');
}

// Delete Traefik config file
async function deleteTraefikConfig(username) {
  const filePath = path.join(TRAEFIK_DYNAMIC_DIR, `student-${username}.yaml`);
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

// ==================== PUBLIC API ====================

/**
 * Initialize a new student container
 */
async function initContainer(username, email, config = {}) {
  const containerName = `student-${username}`;
  const volumeName = `hydra-vol-${username}`;
  const studentNetworkName = `hydra-student-${username}`;
  const studentImage = config.image || resourceConfig.defaults.image;
  const password = generatePassword();

  // Check if container already exists
  const existing = await getStudentContainer(username);
  if (existing) {
    return {
      success: true,
      name: containerName,
      password: null, // Don't return password for existing container
      message: 'Container already exists',
      urls: {
        vscode: `/students/${username}/vscode/`,
        jupyter: `/students/${username}/jupyter/`
      }
    };
  }

  // Ensure networks exist
  await ensureNetwork(MAIN_NETWORK);
  await ensureNetwork(studentNetworkName);

  // Ensure volume exists
  await ensureVolume(volumeName, username);

  // Try to ensure shared directory exists
  await ensureSharedDir();

  // Default routes
  const defaultRoutes = [
    { endpoint: 'vscode', port: CODE_SERVER_PORT },
    { endpoint: 'jupyter', port: JUPYTER_PORT }
  ];

  // Labels
  const labels = {
    'hydra.managed_by': 'hydra-saml-auth',
    'hydra.owner': username,
    'hydra.ownerEmail': email,
    'hydra.port_routes': JSON.stringify(defaultRoutes),
    'hydra.created_at': new Date().toISOString(),
    'hydra.preset': config.preset || 'conservative'
  };

  // Check if image exists, if not try to pull it
  const imagePresent = await imageExists(studentImage);
  if (!imagePresent) {
    try {
      console.log(`[Docker] Pulling image: ${studentImage}`);
      await pullImage(studentImage);
    } catch (err) {
      console.error('[Docker] Failed to pull student image:', err);
      throw new Error('Student container image not found. Please build it locally.');
    }
  }

  // Build mounts array
  const mounts = [
    {
      Type: 'volume',
      Source: volumeName,
      Target: '/home/student'
    }
  ];

  // Add shared mount if enabled
  if (shouldMountSharedDir()) {
    mounts.push({
      Type: 'bind',
      Source: SHARED_DIR,
      Target: SHARED_MOUNT_TARGET,
      ReadOnly: true
    });
  }

  // Get resource limits from config
  const memoryBytes = resourceConfig.memoryToBytes(config.memory_mb / 1024 || resourceConfig.defaults.memory_gb);
  const nanoCpus = resourceConfig.cpusToNanoCpus(config.cpus || resourceConfig.defaults.cpus);

  // Create container
  const container = await docker.createContainer({
    name: containerName,
    Hostname: containerName,
    Image: studentImage,
    Labels: labels,
    Env: [
      `USERNAME=${username}`,
      `USER_EMAIL=${email}`,
      `HOME=/home/student`,
      `PASSWORD=${password}`
    ],
    HostConfig: {
      NetworkMode: MAIN_NETWORK,
      RestartPolicy: { Name: 'unless-stopped' },
      Mounts: mounts,
      Memory: memoryBytes,
      NanoCpus: nanoCpus,
      // SECURITY WARNING: Privileged mode allows container escape!
      // This is a CRITICAL SECURITY VULNERABILITY - see docs/SECURITY_VULNERABILITIES.md
      // TODO: Replace with Sysbox, gVisor, or rootless Docker for safe nested containers
      // For now, only enable if DOCKER_IN_DOCKER_ENABLED=true
      Privileged: process.env.DOCKER_IN_DOCKER_ENABLED === 'true',
      // Add PID limit to prevent fork bombs
      PidsLimit: 512
    }
  });

  // Connect to student network
  const studentNet = docker.getNetwork(studentNetworkName);
  await studentNet.connect({ Container: containerName });

  // Fix volume permissions before starting (Jupyter runs as UID 1000)
  // Run a temporary container to chown the volume
  try {
    const fixPermsContainer = await docker.createContainer({
      Image: 'alpine',
      Cmd: ['sh', '-c', 'chown -R 1000:1000 /data && chmod 755 /data'],
      HostConfig: {
        AutoRemove: true,
        Mounts: [{
          Type: 'volume',
          Source: volumeName,
          Target: '/data'
        }]
      }
    });
    await fixPermsContainer.start();
    await fixPermsContainer.wait();
    console.log(`[Docker] Fixed volume permissions for ${username}`);
  } catch (err) {
    console.warn(`[Docker] Could not fix volume permissions: ${err.message}`);
  }

  // Start container
  await container.start();

  // Write Traefik config for routing
  await writeTraefikConfig(username, defaultRoutes);

  console.log(`[Docker] Created container for ${username}`);

  return {
    success: true,
    name: containerName,
    password: password,
    urls: {
      vscode: `/students/${username}/vscode/`,
      jupyter: `/students/${username}/jupyter/`
    }
  };
}

/**
 * Get container status
 */
async function getContainerStatus(username) {
  const result = await getStudentContainer(username);

  if (!result) {
    return { exists: false, status: 'not_found' };
  }

  const { info } = result;

  return {
    exists: true,
    status: info.State.Status,
    running: info.State.Running,
    ready: info.State.Running,
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
    node: 'docker-host',
    restartCount: info.RestartCount || 0
  };
}

/**
 * Start a container
 */
async function startContainer(username) {
  const result = await getStudentContainer(username);

  if (!result) {
    throw new Error(`Container for ${username} does not exist`);
  }

  const { container, info } = result;

  if (info.State.Running) {
    return { success: true, message: 'Container already running' };
  }

  await container.start();
  return { success: true, message: 'Container started' };
}

/**
 * Stop a container
 */
async function stopContainer(username) {
  const result = await getStudentContainer(username);

  if (!result) {
    throw new Error(`Container for ${username} does not exist`);
  }

  const { container, info } = result;

  if (!info.State.Running) {
    return { success: true, message: 'Container already stopped' };
  }

  await container.stop({ t: 10 });
  return { success: true, message: 'Container stopped' };
}

/**
 * Destroy a container (but keep volume/data)
 */
async function destroyContainer(username) {
  const result = await getStudentContainer(username);

  if (!result) {
    await deleteTraefikConfig(username);
    return { success: true, message: 'Container does not exist' };
  }

  const { container } = result;

  try {
    await container.stop({ t: 10 });
  } catch { /* ignore */ }

  await container.remove({ force: true });
  await deleteTraefikConfig(username);

  console.log(`[Docker] Destroyed container for ${username}`);
  return { success: true, message: 'Container destroyed' };
}

/**
 * Wipe container data (delete volume too)
 */
async function wipeContainer(username) {
  const volumeName = `hydra-vol-${username}`;
  const studentNetworkName = `hydra-student-${username}`;

  // First destroy the container
  await destroyContainer(username);

  // Delete the volume
  try {
    const volume = docker.getVolume(volumeName);
    await volume.remove({ force: true });
    console.log(`[Docker] Removed volume ${volumeName}`);
  } catch (err) {
    console.warn(`[Docker] Could not remove volume ${volumeName}:`, err.message);
  }

  // Optionally clean up student network
  try {
    const net = docker.getNetwork(studentNetworkName);
    await net.remove();
    console.log(`[Docker] Removed network ${studentNetworkName}`);
  } catch {
    // Network might not exist or be in use
  }

  return { success: true, message: 'Container and data wiped' };
}

/**
 * Get container logs
 */
async function getContainerLogs(username, tailLines = 100) {
  const result = await getStudentContainer(username);

  if (!result) {
    return 'Container not found';
  }

  const { container } = result;

  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail: tailLines,
    timestamps: true
  });

  // Convert buffer to string
  return logs.toString('utf8');
}

/**
 * Get all student containers
 */
async function listContainers() {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: ['hydra.managed_by=hydra-saml-auth']
    }
  });

  return containers.map(c => ({
    name: c.Names[0]?.replace(/^\//, ''),
    username: c.Labels['hydra.owner'],
    status: c.State,
    state: c.Status,
    createdAt: new Date(c.Created * 1000).toISOString(),
    node: 'docker-host'
  }));
}

/**
 * Get routes for a student
 */
function getRoutes(username) {
  return {
    vscode: `/students/${username}/vscode/`,
    jupyter: `/students/${username}/jupyter/`,
    supervisor: `/students/${username}/supervisor/`
  };
}

/**
 * Add a custom port route
 */
async function addRoute(username, endpoint, port) {
  const result = await getStudentContainer(username);

  if (!result) {
    throw new Error(`Container for ${username} does not exist`);
  }

  const { info } = result;

  // Get existing routes from labels
  let routes = [];
  try {
    routes = JSON.parse(info.Config.Labels['hydra.port_routes'] || '[]');
  } catch {
    routes = [
      { endpoint: 'vscode', port: CODE_SERVER_PORT },
      { endpoint: 'jupyter', port: JUPYTER_PORT }
    ];
  }

  // Check for conflicts
  if (routes.some(r => r.endpoint === endpoint)) {
    throw new Error(`Endpoint ${endpoint} already exists`);
  }

  // Add new route
  routes.push({ endpoint, port });

  // Update Traefik config
  await writeTraefikConfig(username, routes);

  return { success: true, routes };
}

/**
 * Remove a custom port route
 */
async function removeRoute(username, endpoint) {
  const result = await getStudentContainer(username);

  if (!result) {
    throw new Error(`Container for ${username} does not exist`);
  }

  const { info } = result;

  // Get existing routes from labels
  let routes = [];
  try {
    routes = JSON.parse(info.Config.Labels['hydra.port_routes'] || '[]');
  } catch {
    routes = [
      { endpoint: 'vscode', port: CODE_SERVER_PORT },
      { endpoint: 'jupyter', port: JUPYTER_PORT }
    ];
  }

  // Filter out the route
  routes = routes.filter(r => r.endpoint !== endpoint);

  // Update Traefik config
  await writeTraefikConfig(username, routes);

  return { success: true, routes };
}

module.exports = {
  initContainer,
  getContainerStatus,
  startContainer,
  stopContainer,
  destroyContainer,
  wipeContainer,
  getContainerLogs,
  listContainers,
  getRoutes,
  addRoute,
  removeRoute,
  // Expose helpers for routes/containers.js compatibility
  getStudentContainer,
  writeTraefikConfig,
  deleteTraefikConfig,
  ensureNetwork,
  ensureVolume,
  imageExists,
  pullImage
};
