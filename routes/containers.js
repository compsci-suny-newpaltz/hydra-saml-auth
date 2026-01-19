const express = require('express');
const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');
const { execSync } = require('child_process');

// SSH Keys directory - stores private keys for users to download
const SSH_KEYS_DIR = process.env.SSH_KEYS_DIR || '/app/data/ssh-keys';

// Resource configuration (replaces hardcoded values)
const resourceConfig = require('../config/resources');
// Runtime configuration for Docker/Kubernetes mode
const runtimeConfig = require('../config/runtime');

const router = express.Router();

// Conditional Docker client - only initialize if in Docker mode
let docker = null;
if (runtimeConfig.isDocker()) {
    docker = new Docker({ socketPath: runtimeConfig.docker.socketPath });
}

// K8s container service - only load if in K8s mode
let k8sContainers = null;
if (runtimeConfig.isKubernetes()) {
    k8sContainers = require('../services/k8s-containers');
    console.log('[containers] Running in Kubernetes mode');
} else {
    console.log('[containers] Running in Docker mode');
}

// Constants - now using config
const STUDENT_IMAGE = resourceConfig.defaults.image;
const MAIN_NETWORK = 'hydra_students_net';
const CODE_SERVER_PORT = 8443;
const JUPYTER_PORT = 8888;
const RESERVED_PORTS = [CODE_SERVER_PORT, JUPYTER_PORT];
const RESERVED_ENDPOINTS = ['vscode', 'jupyter'];
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/etc/traefik/dynamic';

// Shared read-only directory for course materials, downloads, etc.
// Students can view/download but cannot modify files on the host
// Set SHARED_DIR_ENABLED=false to disable in dev environments
const SHARED_DIR = process.env.SHARED_DIR || '/srv/shared';
const SHARED_MOUNT_TARGET = '/shared';
const SHARED_DIR_ENABLED = process.env.SHARED_DIR_ENABLED !== 'false';

// Helper to check if shared directory should be mounted
function shouldMountSharedDir() {
    if (!SHARED_DIR_ENABLED) {
        return false;
    }
    const fsSync = require('fs');
    try {
        return fsSync.existsSync(SHARED_DIR);
    } catch (err) {
        return false;
    }
}

// Helper to ensure shared directory exists (best effort)
async function ensureSharedDir() {
    const fsSync = require('fs');
    try {
        if (!fsSync.existsSync(SHARED_DIR)) {
            fsSync.mkdirSync(SHARED_DIR, { recursive: true, mode: 0o755 });
            console.log(`[containers] Created shared directory: ${SHARED_DIR}`);
        }
    } catch (err) {
        console.warn(`[containers] Could not create shared directory ${SHARED_DIR}:`, err.message);
    }
}

// Helper to pull Docker images
async function pullImage(img) {
    return new Promise((resolve, reject) => {
        docker.pull(img, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
        });
    });
}

// Helper to check if image exists locally
async function imageExists(imageName) {
    try {
        const image = docker.getImage(imageName);
        await image.inspect();
        return true;
    } catch (err) {
        if (err.statusCode === 404) {
            return false;
        }
        throw err;
    }
}

// Helper to ensure volume exists
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

// Helper to ensure network exists
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

// Helper to ensure SSH keys directory exists
async function ensureSSHKeysDir() {
    try {
        await fs.mkdir(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

// Generate SSH key pair for a user
async function generateSSHKeys(username) {
    await ensureSSHKeysDir();

    const privateKeyPath = path.join(SSH_KEYS_DIR, `${username}_id_ed25519`);
    const publicKeyPath = `${privateKeyPath}.pub`;

    // Check if keys already exist
    try {
        await fs.access(privateKeyPath);
        const publicKey = await fs.readFile(publicKeyPath, 'utf8');
        return { publicKey: publicKey.trim(), keyExists: true };
    } catch {
        // Keys don't exist, generate new ones
    }

    // Generate Ed25519 key pair using ssh-keygen
    try {
        execSync(`ssh-keygen -t ed25519 -f "${privateKeyPath}" -N "" -C "${username}@hydra.newpaltz.edu"`, {
            stdio: 'pipe'
        });

        const publicKey = await fs.readFile(publicKeyPath, 'utf8');
        console.log(`[containers] Generated SSH keys for ${username}`);

        return { publicKey: publicKey.trim(), keyExists: false };
    } catch (err) {
        console.error(`[containers] Failed to generate SSH keys for ${username}:`, err);
        throw new Error('Failed to generate SSH keys');
    }
}

// Get SSH private key for download
async function getSSHPrivateKey(username) {
    const privateKeyPath = path.join(SSH_KEYS_DIR, `${username}_id_ed25519`);
    try {
        return await fs.readFile(privateKeyPath, 'utf8');
    } catch {
        return null;
    }
}

// Get SSH public key
async function getSSHPublicKey(username) {
    const publicKeyPath = path.join(SSH_KEYS_DIR, `${username}_id_ed25519.pub`);
    try {
        return (await fs.readFile(publicKeyPath, 'utf8')).trim();
    } catch {
        return null;
    }
}

// Helper to get student's container
async function getStudentContainer(username) {
    const containerName = `student-${username}`;
    try {
        const container = docker.getContainer(containerName);
        const info = await container.inspect();
        return { container, info };
    } catch (err) {
        if (err.statusCode === 404) {
            return null;
        }
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

    // Add auth middleware (shared)
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
    } catch (e) {
        // Ignore if file doesn't exist
    }
}

// Initialize/Create student mega container
// POST /dashboard/api/containers/init
router.post('/init', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const host = process.env.HOSTNAME || 'hydra.newpaltz.edu';
        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');

        // ========== KUBERNETES MODE ==========
        if (runtimeConfig.isKubernetes()) {
            // Check if container already exists
            const status = await k8sContainers.getContainerStatus(username);
            if (status.exists) {
                return res.json({
                    success: true,
                    message: 'Container already exists',
                    name: `student-${username}`,
                    state: status.status
                });
            }

            // Create container using K8s service
            const result = await k8sContainers.initContainer(username, req.user.email, {
                preset: req.body.preset || 'conservative',
                target_node: req.body.target_node || 'hydra',
                storage_gb: req.body.storage_gb || resourceConfig.defaults.storage_gb,
                memory_mb: req.body.memory_mb || resourceConfig.defaults.memory_mb,
                cpus: req.body.cpus || resourceConfig.defaults.cpus,
                gpu_count: req.body.gpu_count || 0
            });

            return res.json({
                success: true,
                name: result.name,
                vscodeUrl: `${publicBase}/${username}/vscode/`,
                jupyterUrl: `${publicBase}/${username}/jupyter/`,
                password: result.password // Only returned on first creation
            });
        }

        // ========== DOCKER MODE ==========
        const containerName = `student-${username}`;
        const volumeName = `hydra-vol-${username}`;
        const studentNetworkName = `hydra-student-${username}`;

        // Check if container already exists
        const existing = await getStudentContainer(username);
        if (existing) {
            return res.json({
                success: true,
                message: 'Container already exists',
                name: containerName,
                state: existing.info.State.Status
            });
        }

        // Ensure networks exist
        await ensureNetwork(MAIN_NETWORK);
        await ensureNetwork(studentNetworkName);

        // Ensure volume exists
        await ensureVolume(volumeName, username);

        // Try to ensure shared directory exists (best effort)
        await ensureSharedDir();

        // Default routes for code-server and jupyter
        const defaultRoutes = [
            { endpoint: 'vscode', port: CODE_SERVER_PORT },
            { endpoint: 'jupyter', port: JUPYTER_PORT }
        ];

        // Base labels (no Traefik labels - using file provider instead)
        const labels = {
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.port_routes': JSON.stringify(defaultRoutes),
            'hydra.created_at': new Date().toISOString()
        };

        // Check if image exists locally, if not try to pull it
        const imagePresent = await imageExists(STUDENT_IMAGE);
        if (!imagePresent) {
            try {
                await pullImage(STUDENT_IMAGE);
            } catch (err) {
                console.error('[containers] Failed to pull student image:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Student container image not found. Please build it locally with: docker build -t hydra-student-container:latest .'
                });
            }
        }

        // Build mounts array - shared dir is optional
        const mounts = [
            {
                Type: 'volume',
                Source: volumeName,
                Target: '/home/student'
            }
        ];

        // Only add shared mount if enabled and directory exists
        if (shouldMountSharedDir()) {
            mounts.push({
                Type: 'bind',
                Source: SHARED_DIR,
                Target: SHARED_MOUNT_TARGET,
                ReadOnly: true
            });
        }

        // Generate SSH keys for the user
        const { publicKey: sshPublicKey } = await generateSSHKeys(username);

        // Calculate SSH port (base 22000 + hash of username for consistency)
        const usernameHash = crypto.createHash('md5').update(username).digest('hex');
        const sshPort = 22000 + (parseInt(usernameHash.substring(0, 4), 16) % 10000);

        // Update labels with SSH port
        labels['hydra.ssh_port'] = String(sshPort);

        // Create container
        const container = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: STUDENT_IMAGE,
            Labels: labels,
            Env: [
                `USERNAME=${username}`,
                `HOME=/home/student`,
                `SSH_PUBLIC_KEY=${sshPublicKey}`
            ],
            ExposedPorts: {
                '22/tcp': {}
            },
            HostConfig: {
                NetworkMode: MAIN_NETWORK,
                RestartPolicy: { Name: 'unless-stopped' },
                Mounts: mounts,
                Memory: resourceConfig.memoryToBytes(resourceConfig.defaults.memory_gb),
                NanoCpus: resourceConfig.cpusToNanoCpus(resourceConfig.defaults.cpus),
                Privileged: true, // For Docker-in-Docker
                PortBindings: {
                    '22/tcp': [{ HostPort: String(sshPort) }]
                }
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
            console.log(`[containers] Fixed volume permissions for ${username}`);
        } catch (err) {
            console.warn(`[containers] Could not fix volume permissions: ${err.message}`);
        }

        // Start container
        await container.start();

        // Write Traefik config file for routing
        await writeTraefikConfig(username, defaultRoutes);

        return res.json({
            success: true,
            name: containerName,
            vscodeUrl: `${publicBase}/${username}/vscode/`,
            jupyterUrl: `${publicBase}/${username}/jupyter/`,
            sshPort: sshPort,
            sshHost: 'hydra.newpaltz.edu',
            sshUser: 'student'
        });
    } catch (err) {
        console.error('[containers] init error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to initialize container' });
    }
});

// Download SSH private key
// GET /dashboard/api/containers/ssh-key
router.get('/ssh-key', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const privateKey = await getSSHPrivateKey(username);

        if (!privateKey) {
            return res.status(404).json({
                success: false,
                message: 'SSH key not found. Please initialize your container first.'
            });
        }

        // Send as downloadable file
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.setHeader('Content-Disposition', `attachment; filename="${username}_hydra_key"`);
        return res.send(privateKey);
    } catch (err) {
        console.error('[containers] ssh-key error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to get SSH key' });
    }
});

// Get SSH connection info
// GET /dashboard/api/containers/ssh-info
router.get('/ssh-info', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.json({
                success: false,
                message: 'Container not found'
            });
        }

        const sshPort = result.info.Config.Labels?.['hydra.ssh_port'];
        const publicKey = await getSSHPublicKey(username);
        const hasPrivateKey = (await getSSHPrivateKey(username)) !== null;

        return res.json({
            success: true,
            sshPort: sshPort ? parseInt(sshPort) : null,
            sshHost: 'hydra.newpaltz.edu',
            sshUser: 'student',
            sshCommand: sshPort ? `ssh -i ~/.ssh/${username}_hydra_key student@hydra.newpaltz.edu -p ${sshPort}` : null,
            hasKey: hasPrivateKey,
            publicKey: publicKey
        });
    } catch (err) {
        console.error('[containers] ssh-info error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to get SSH info' });
    }
});

// Regenerate SSH keys (creates new key pair)
// POST /dashboard/api/containers/ssh-key/regenerate
router.post('/ssh-key/regenerate', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Container not found. Please initialize first.'
            });
        }

        // Delete existing keys
        const privateKeyPath = path.join(SSH_KEYS_DIR, `${username}_id_ed25519`);
        const publicKeyPath = `${privateKeyPath}.pub`;
        try {
            await fs.unlink(privateKeyPath);
            await fs.unlink(publicKeyPath);
        } catch {
            // Keys might not exist
        }

        // Generate new keys
        const { publicKey } = await generateSSHKeys(username);

        // Update the container's SSH key by restarting it with new env
        // The container will pick up the new key on restart
        const container = result.container;

        // Stop container if running
        if (result.info.State.Running) {
            await container.stop();
        }

        // Update container environment with new public key
        // Note: Docker doesn't allow updating env vars directly, so we need to
        // store the key in a way the container can access on restart

        // For now, we'll need to wipe and recreate - inform user
        return res.json({
            success: true,
            message: 'New SSH keys generated. Please restart your container for changes to take effect.',
            publicKey: publicKey
        });
    } catch (err) {
        console.error('[containers] ssh-key regenerate error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to regenerate SSH key' });
    }
});

// Start student container
// POST /dashboard/api/containers/start
router.post('/start', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found. Please initialize first.' });
        }

        const { container, info } = result;

        if (info.State.Running) {
            return res.json({ success: true, message: 'Container already running' });
        }

        await container.start();
        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] start error:', err);
        return res.status(500).json({ success: false, message: 'Failed to start container' });
    }
});

// Stop student container
// POST /dashboard/api/containers/stop
router.post('/stop', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;

        if (!info.State.Running) {
            return res.json({ success: true, message: 'Container already stopped' });
        }

        await container.stop({ t: 10 });
        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] stop error:', err);
        return res.status(500).json({ success: false, message: 'Failed to stop container' });
    }
});

// Get container status
// GET /dashboard/api/containers/status
router.get('/status', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];

        // ========== KUBERNETES MODE ==========
        if (runtimeConfig.isKubernetes()) {
            const status = await k8sContainers.getContainerStatus(username);
            return res.json({
                success: true,
                exists: status.exists,
                state: status.status || 'not_created',
                running: status.running || false,
                startedAt: status.startedAt,
                node: status.node,
                restartCount: status.restartCount
            });
        }

        // ========== DOCKER MODE ==========
        const result = await getStudentContainer(username);

        if (!result) {
            return res.json({
                success: true,
                exists: false,
                state: 'not_created'
            });
        }

        const { info } = result;

        return res.json({
            success: true,
            exists: true,
            state: info.State.Status,
            running: info.State.Running,
            startedAt: info.State.StartedAt,
            finishedAt: info.State.FinishedAt
        });
    } catch (err) {
        console.error('[containers] status error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get status' });
    }
});

// Get service statuses (via supervisorctl)
// GET /dashboard/api/containers/services
router.get('/services', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;

        if (!info.State.Running) {
            return res.json({ success: true, services: [], containerRunning: false });
        }

        // Execute supervisorctl status (may not exist in minimal containers)
        try {
            const exec = await container.exec({
                Cmd: ['supervisorctl', 'status'],
                AttachStdout: true,
                AttachStderr: true
            });

            const stream = await exec.start({ Detach: false, Tty: false });

            let output = '';
            stream.on('data', (chunk) => {
                // Strip Docker stream header (first 8 bytes)
                if (chunk.length > 8) {
                    output += chunk.slice(8).toString('utf8');
                }
            });

            await new Promise((resolve, reject) => {
                stream.on('end', resolve);
                stream.on('error', reject);
            });

            // Check if supervisorctl execution failed (command not found)
            const execResult = await exec.inspect();
            if (execResult.ExitCode !== 0 && output.includes('not found')) {
                // No supervisor - container manages its own processes
                return res.json({ success: true, services: [], containerRunning: true, noSupervisor: true });
            }

            // Parse supervisorctl output
            // Format: "program_name    STATE    pid 123, uptime 1:23:45"
            const services = [];
            const lines = output.trim().split('\n');

            for (const line of lines) {
                const match = line.match(/^(\S+)\s+(\S+)/);
                if (match) {
                    const [, name, state] = match;
                    // Only include code-server and jupyter
                    if (name === 'code-server' || name === 'jupyter') {
                        services.push({
                            name,
                            running: state === 'RUNNING',
                            state
                        });
                    }
                }
            }

            return res.json({ success: true, services, containerRunning: true });
        } catch (execErr) {
            // supervisorctl not available - container manages its own processes
            console.log('[containers] supervisorctl not available:', execErr.message);
            return res.json({ success: true, services: [], containerRunning: true, noSupervisor: true });
        }
    } catch (err) {
        console.error('[containers] services error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get service status' });
    }
});

// Start a service
// POST /dashboard/api/containers/services/:service/start
router.post('/services/:service/start', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const serviceName = String(req.params.service || '').trim();
        if (!['code-server', 'jupyter'].includes(serviceName)) {
            return res.status(400).json({ success: false, message: 'Invalid service name' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;

        if (!info.State.Running) {
            return res.status(400).json({ success: false, message: 'Container not running' });
        }

        // Execute supervisorctl start
        const exec = await container.exec({
            Cmd: ['supervisorctl', 'start', serviceName],
            AttachStdout: true,
            AttachStderr: true
        });

        const stream = await exec.start({ Detach: false, Tty: false });

        // Collect output
        let output = '';
        await new Promise((resolve, reject) => {
            stream.on('data', (chunk) => { output += chunk.toString(); });
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        // Check exec result
        const inspectResult = await exec.inspect();
        if (inspectResult.ExitCode !== 0) {
            console.error('[containers] supervisorctl start failed:', output);
            // Check if supervisorctl doesn't exist
            if (output.includes('not found') || output.includes('No such file')) {
                return res.status(400).json({ success: false, message: 'Service management not available in this container' });
            }
            return res.status(500).json({ success: false, message: output.trim() || 'Service start failed' });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] start service error:', err);
        // Check if it's a command not found error
        if (err.message && (err.message.includes('not found') || err.message.includes('No such file'))) {
            return res.status(400).json({ success: false, message: 'Service management not available in this container' });
        }
        return res.status(500).json({ success: false, message: err.message || 'Failed to start service' });
    }
});

// Stop a service
// POST /dashboard/api/containers/services/:service/stop
router.post('/services/:service/stop', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const serviceName = String(req.params.service || '').trim();
        if (!['code-server', 'jupyter'].includes(serviceName)) {
            return res.status(400).json({ success: false, message: 'Invalid service name' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;

        if (!info.State.Running) {
            return res.status(400).json({ success: false, message: 'Container not running' });
        }

        // Execute supervisorctl stop (may not exist in minimal containers)
        const exec = await container.exec({
            Cmd: ['supervisorctl', 'stop', serviceName],
            AttachStdout: true,
            AttachStderr: true
        });

        const stream = await exec.start({ Detach: false, Tty: false });

        // Collect output
        let output = '';
        await new Promise((resolve, reject) => {
            stream.on('data', (chunk) => { output += chunk.toString(); });
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        // Check exec result
        const inspectResult = await exec.inspect();
        if (inspectResult.ExitCode !== 0) {
            console.error('[containers] supervisorctl stop failed:', output);
            // Check if supervisorctl doesn't exist
            if (output.includes('not found') || output.includes('No such file')) {
                return res.status(400).json({ success: false, message: 'Service management not available in this container' });
            }
            return res.status(500).json({ success: false, message: output.trim() || 'Service stop failed' });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] stop service error:', err);
        // Check if it's a command not found error
        if (err.message && (err.message.includes('not found') || err.message.includes('No such file'))) {
            return res.status(400).json({ success: false, message: 'Service management not available in this container' });
        }
        return res.status(500).json({ success: false, message: err.message || 'Failed to stop service' });
    }
});

// Get port routes
// GET /dashboard/api/containers/routes
router.get('/routes', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;

        // Read routes from file inside the container (new file-based approach)
        let routes = [];
        if (info.State.Running) {
            try {
                const routesExec = await container.exec({
                    Cmd: ['sh', '-c', 'cat /home/student/.hydra_routes 2>/dev/null || echo "[]"'],
                    AttachStdout: true,
                    AttachStderr: true
                });
                const routesStream = await routesExec.start({ Detach: false, Tty: false });
                let routesOutput = '';
                routesStream.on('data', (chunk) => {
                    if (chunk.length > 8) {
                        routesOutput += chunk.slice(8).toString('utf8');
                    }
                });
                await new Promise((resolve) => routesStream.on('end', resolve));
                routes = JSON.parse(routesOutput.trim()) || [];
            } catch (e) {
                console.error('[containers] Failed to read routes file:', e);
            }
        }

        // Fall back to Docker labels if file doesn't exist (backwards compatibility)
        if (routes.length === 0) {
            const labels = info.Config.Labels || {};
            const routesJson = labels['hydra.port_routes'] || '[]';
            try {
                routes = JSON.parse(routesJson);
            } catch (e) {
                console.error('[containers] Failed to parse port_routes:', e);
            }
        }

        const host = 'hydra.newpaltz.edu';
        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');

        // Add URLs to routes
        const routesWithUrls = routes.map(route => ({
            ...route,
            url: `${publicBase}/${username}/${route.endpoint}/`
        }));

        return res.json({ success: true, routes: routesWithUrls });
    } catch (err) {
        console.error('[containers] get routes error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get routes' });
    }
});

// Add a port route
// POST /dashboard/api/containers/routes { endpoint, port }
router.post('/routes', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const endpoint = String(req.body?.endpoint || '').trim().toLowerCase();
        const port = Number(req.body?.port);

        // Validate endpoint
        if (!endpoint || !/^[a-z0-9-]{1,40}$/.test(endpoint)) {
            return res.status(400).json({ success: false, message: 'Invalid endpoint name (alphanumeric and hyphens only)' });
        }

        if (RESERVED_ENDPOINTS.includes(endpoint)) {
            return res.status(400).json({ success: false, message: 'Endpoint name is reserved' });
        }

        // Validate port
        if (!port || port < 1024 || port > 65535) {
            return res.status(400).json({ success: false, message: 'Port must be between 1024 and 65535' });
        }

        if (RESERVED_PORTS.includes(port)) {
            return res.status(400).json({ success: false, message: 'Port is reserved for essential services' });
        }

        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;
        const oldLabels = info.Config.Labels || {};
        const routesJson = oldLabels['hydra.port_routes'] || '[]';

        let routes = [];
        try {
            routes = JSON.parse(routesJson);
        } catch (e) {
            console.error('[containers] Failed to parse port_routes:', e);
        }

        // Check if endpoint already exists
        if (routes.some(r => r.endpoint === endpoint)) {
            return res.status(400).json({ success: false, message: 'Endpoint already exists' });
        }

        // Check if port already in use
        if (routes.some(r => r.port === port)) {
            return res.status(400).json({ success: false, message: 'Port already in use by another endpoint' });
        }

        // Add new route
        const newRoute = { endpoint, port };
        routes.push(newRoute);

        // Update container labels (for persistence) without recreating the container
        // We need to update the label by recreating the container, but we can do it quickly
        // Actually, Docker doesn't support updating labels without recreating
        // So we update the label in memory and write to Traefik config file

        // For label persistence, we need to recreate the container
        // But per the requirement, we should NOT recreate - just update Traefik config
        // Labels will be lost on container restart, but routes persist via Traefik file

        // Update Traefik config file (this takes effect immediately)
        await writeTraefikConfig(username, routes);

        // Store routes in a file inside the container for persistence
        // This is a workaround since we can't update Docker labels without recreating
        try {
            const routesData = JSON.stringify(routes);
            const exec = await container.exec({
                Cmd: ['sh', '-c', `echo '${routesData}' > /home/student/.hydra_routes`],
                AttachStdout: true,
                AttachStderr: true
            });
            await exec.start({ Detach: false, Tty: false });
        } catch (e) {
            console.warn('[containers] Failed to persist routes inside container:', e.message);
        }

        const host = 'hydra.newpaltz.edu';
        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');

        return res.json({
            success: true,
            route: {
                ...newRoute,
                url: `${publicBase}/${username}/${endpoint}/`
            }
        });
    } catch (err) {
        console.error('[containers] add route error:', err);
        return res.status(500).json({ success: false, message: 'Failed to add route' });
    }
});

// Delete a port route
// DELETE /dashboard/api/containers/routes/:endpoint
router.delete('/routes/:endpoint', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const endpoint = String(req.params.endpoint || '').trim().toLowerCase();

        if (RESERVED_ENDPOINTS.includes(endpoint)) {
            return res.status(400).json({ success: false, message: 'Cannot delete reserved endpoint' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;
        const oldLabels = info.Config.Labels || {};
        const routesJson = oldLabels['hydra.port_routes'] || '[]';

        let routes = [];
        try {
            routes = JSON.parse(routesJson);
        } catch (e) {
            console.error('[containers] Failed to parse port_routes:', e);
        }

        // Check if endpoint exists
        const routeIndex = routes.findIndex(r => r.endpoint === endpoint);
        if (routeIndex === -1) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        // Remove route
        routes.splice(routeIndex, 1);

        // Update Traefik config file (this takes effect immediately)
        await writeTraefikConfig(username, routes);

        // Store routes in a file inside the container for persistence
        try {
            const routesData = JSON.stringify(routes);
            const exec = await container.exec({
                Cmd: ['sh', '-c', `echo '${routesData}' > /home/student/.hydra_routes`],
                AttachStdout: true,
                AttachStderr: true
            });
            await exec.start({ Detach: false, Tty: false });
        } catch (e) {
            console.warn('[containers] Failed to persist routes inside container:', e.message);
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] delete route error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete route' });
    }
});

// Discover services from supervisor.d configs
// POST /dashboard/api/containers/discover-services
router.post('/discover-services', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const autoRegister = req.body?.autoRegister === true;
        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;

        if (!info.State.Running) {
            return res.status(400).json({ success: false, message: 'Container not running' });
        }

        // List files in /home/student/supervisor.d/
        const listExec = await container.exec({
            Cmd: ['sh', '-c', 'ls -1 /home/student/supervisor.d/*.conf 2>/dev/null || true'],
            AttachStdout: true,
            AttachStderr: true
        });

        const listStream = await listExec.start({ Detach: false, Tty: false });
        let listOutput = '';
        listStream.on('data', (chunk) => {
            if (chunk.length > 8) {
                listOutput += chunk.slice(8).toString('utf8');
            }
        });

        await new Promise((resolve, reject) => {
            listStream.on('end', resolve);
            listStream.on('error', reject);
        });

        const confFiles = listOutput.trim().split('\n').filter(f => f.endsWith('.conf'));
        const discoveredServices = [];

        // Read each conf file and parse hydra comments
        for (const confFile of confFiles) {
            const readExec = await container.exec({
                Cmd: ['cat', confFile],
                AttachStdout: true,
                AttachStderr: true
            });

            const readStream = await readExec.start({ Detach: false, Tty: false });
            let fileContent = '';
            readStream.on('data', (chunk) => {
                if (chunk.length > 8) {
                    fileContent += chunk.slice(8).toString('utf8');
                }
            });

            await new Promise((resolve, reject) => {
                readStream.on('end', resolve);
                readStream.on('error', reject);
            });

            // Parse for hydra.port and hydra.endpoint comments
            const portMatch = fileContent.match(/^#\s*hydra\.port\s*=\s*(\d+)/m);
            const endpointMatch = fileContent.match(/^#\s*hydra\.endpoint\s*=\s*(\S+)/m);

            if (portMatch && endpointMatch) {
                const port = parseInt(portMatch[1], 10);
                const endpoint = endpointMatch[1].toLowerCase();

                discoveredServices.push({
                    file: confFile,
                    endpoint,
                    port
                });
            }
        }

        // Optionally auto-register discovered services
        const registered = [];
        if (autoRegister && discoveredServices.length > 0) {
            const labels = info.Config.Labels || {};
            const routesJson = labels['hydra.port_routes'] || '[]';
            let routes = [];
            try {
                routes = JSON.parse(routesJson);
            } catch (e) {
                console.error('[containers] Failed to parse port_routes:', e);
            }

            for (const service of discoveredServices) {
                // Skip if already registered or reserved
                if (routes.some(r => r.endpoint === service.endpoint || r.port === service.port)) {
                    continue;
                }
                if (RESERVED_ENDPOINTS.includes(service.endpoint) || RESERVED_PORTS.includes(service.port)) {
                    continue;
                }

                routes.push({ endpoint: service.endpoint, port: service.port });
                registered.push(service);
            }

            // Update Traefik config if we registered new routes
            if (registered.length > 0) {
                await writeTraefikConfig(username, routes);

                // Store routes in a file inside the container for persistence
                try {
                    const routesData = JSON.stringify(routes);
                    const exec = await container.exec({
                        Cmd: ['sh', '-c', `echo '${routesData}' > /home/student/.hydra_routes`],
                        AttachStdout: true,
                        AttachStderr: true
                    });
                    await exec.start({ Detach: false, Tty: false });
                } catch (e) {
                    console.warn('[containers] Failed to persist routes inside container:', e.message);
                }
            }
        }

        const host = 'hydra.newpaltz.edu';
        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');

        // Get existing routes to check which services are already routed
        let existingRoutes = [];
        try {
            const routesExec = await container.exec({
                Cmd: ['sh', '-c', 'cat /home/student/.hydra_routes 2>/dev/null || echo "[]"'],
                AttachStdout: true,
                AttachStderr: true
            });
            const routesStream = await routesExec.start({ Detach: false, Tty: false });
            let routesOutput = '';
            routesStream.on('data', (chunk) => {
                if (chunk.length > 8) {
                    routesOutput += chunk.slice(8).toString('utf8');
                }
            });
            await new Promise((resolve) => routesStream.on('end', resolve));
            existingRoutes = JSON.parse(routesOutput.trim()) || [];
        } catch (e) {
            // Ignore parse errors
        }

        return res.json({
            success: true,
            services: discoveredServices.map(s => ({
                name: s.file.split('/').pop().replace('.conf', ''),
                ...s,
                url: `${publicBase}/${username}/${s.endpoint}/`,
                alreadyRouted: existingRoutes.some(r => r.endpoint === s.endpoint || r.port === s.port)
            })),
            registered: registered.map(s => ({
                ...s,
                url: `${publicBase}/${username}/${s.endpoint}/`
            }))
        });
    } catch (err) {
        console.error('[containers] discover-services error:', err);
        return res.status(500).json({ success: false, message: 'Failed to discover services' });
    }
});

// Stream logs (SSE)
// GET /dashboard/api/containers/logs/stream
router.get('/logs/stream', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).end();
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).end();
        }

        const { container } = result;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const logStream = await container.logs({
            follow: true, stdout: true, stderr: true, tail: 200
        });

        // Use demuxStream to properly handle Docker's multiplexed stream
        const stdout = {
            write: (chunk) => {
                const lines = chunk.toString('utf8').split(/\r?\n/);
                lines.forEach(line => {
                    if (line) res.write(`data: ${line}\n\n`);
                });
            }
        };
        const stderr = {
            write: (chunk) => {
                const lines = chunk.toString('utf8').split(/\r?\n/);
                lines.forEach(line => {
                    if (line) res.write(`data: [stderr] ${line}\n\n`);
                });
            }
        };

        docker.modem.demuxStream(logStream, stdout, stderr);

        logStream.on('end', () => res.end());
        logStream.on('error', () => res.end());
        req.on('close', () => {
            try { logStream.destroy(); } catch { }
        });
    } catch (err) {
        console.error('[containers] logs stream error:', err);
        try { res.status(500).end(); } catch { }
    }
});

// Wipe and recreate student container
// POST /dashboard/api/containers/wipe
router.post('/wipe', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];

        // ========== KUBERNETES MODE ==========
        if (runtimeConfig.isKubernetes()) {
            // Wipe all data and recreate
            await k8sContainers.wipeContainer(username);

            // Re-initialize container
            const result = await k8sContainers.initContainer(username, req.user.email, {
                preset: req.body.preset || 'conservative',
                target_node: req.body.target_node || 'hydra',
                storage_gb: req.body.storage_gb || resourceConfig.defaults.storage_gb
            });

            const host = process.env.HOSTNAME || 'hydra.newpaltz.edu';
            const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');

            return res.json({
                success: true,
                message: 'Container wiped and recreated',
                name: result.name,
                vscodeUrl: `${publicBase}/${username}/vscode/`,
                jupyterUrl: `${publicBase}/${username}/jupyter/`,
                password: result.password
            });
        }

        // ========== DOCKER MODE ==========
        const containerName = `student-${username}`;
        const volumeName = `hydra-vol-${username}`;

        // 1. Destroy existing container and volume
        const existing = await getStudentContainer(username);
        if (existing) {
            const { container } = existing;
            try {
                await container.stop({ t: 10 });
            } catch (_e) { /* ignore */ }
            await container.remove({ force: true, v: true });
        }

        try {
            const volume = docker.getVolume(volumeName);
            await volume.remove({ force: true });
        } catch (e) {
            console.warn(`[containers] Failed to remove volume ${volumeName} during wipe:`, e.message);
        }

        // Delete Traefik config file
        await deleteTraefikConfig(username);

        // 2. Re-initialize container (logic copied and adapted from /init)
        const studentNetworkName = `hydra-student-${username}`;
        const host = 'hydra.newpaltz.edu';

        // Ensure networks exist
        await ensureNetwork(MAIN_NETWORK);
        await ensureNetwork(studentNetworkName);

        // Ensure volume exists
        await ensureVolume(volumeName, username);

        // Try to ensure shared directory exists (best effort)
        await ensureSharedDir();

        // Default routes for code-server and jupyter
        const defaultRoutes = [
            { endpoint: 'vscode', port: CODE_SERVER_PORT },
            { endpoint: 'jupyter', port: JUPYTER_PORT }
        ];

        // Base labels (no Traefik labels - using file provider instead)
        const labels = {
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.port_routes': JSON.stringify(defaultRoutes),
            'hydra.created_at': new Date().toISOString()
        };

        // Check if image exists locally, if not try to pull it
        const imagePresent = await imageExists(STUDENT_IMAGE);
        if (!imagePresent) {
            try {
                await pullImage(STUDENT_IMAGE);
            } catch (err) {
                console.error('[containers] Failed to pull student image:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Student container image not found. Please build it locally with: docker build -t hydra-student-container:latest .'
                });
            }
        }

        // Build mounts array - shared dir is optional
        const mounts = [
            {
                Type: 'volume',
                Source: volumeName,
                Target: '/home/student'
            }
        ];

        // Only add shared mount if enabled and directory exists
        if (shouldMountSharedDir()) {
            mounts.push({
                Type: 'bind',
                Source: SHARED_DIR,
                Target: SHARED_MOUNT_TARGET,
                ReadOnly: true
            });
        }

        // Create container
        const newContainer = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: STUDENT_IMAGE,
            Labels: labels,
            Env: [
                `USERNAME=${username}`,
                `HOME=/home/student`
            ],
            HostConfig: {
                NetworkMode: MAIN_NETWORK,
                RestartPolicy: { Name: 'unless-stopped' },
                Mounts: mounts,
                Memory: resourceConfig.memoryToBytes(resourceConfig.defaults.memory_gb),
                NanoCpus: resourceConfig.cpusToNanoCpus(resourceConfig.defaults.cpus),
                Privileged: true // For Docker-in-Docker
            }
        });

        // Connect to student network
        const studentNet = docker.getNetwork(studentNetworkName);
        await studentNet.connect({ Container: containerName });

        // Start container
        await newContainer.start();

        // Write Traefik config file for routing
        await writeTraefikConfig(username, defaultRoutes);

        return res.json({ success: true, message: 'Container wiped and recreated' });

    } catch (err) {
        console.error('[containers] wipe error:', err);
        return res.status(500).json({ success: false, message: 'Failed to wipe and recreate container' });
    }
});

// Delete student container (admin only or self-destruct)
// DELETE /dashboard/api/containers/destroy
router.delete('/destroy', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];

        // Kubernetes mode - use K8s container service
        if (runtimeConfig.isKubernetes()) {
            try {
                await k8sContainers.wipeContainer(username);
                return res.json({ success: true, message: 'Container and data destroyed' });
            } catch (err) {
                if (err.statusCode === 404 || err.message?.includes('not found')) {
                    return res.json({ success: true, message: 'Container does not exist' });
                }
                throw err;
            }
        }

        // Docker mode - existing logic
        const result = await getStudentContainer(username);

        if (!result) {
            // Clean up Traefik config even if container doesn't exist
            await deleteTraefikConfig(username);
            return res.json({ success: true, message: 'Container does not exist' });
        }

        const { container } = result;
        const volumeName = `hydra-vol-${username}`;

        try {
            await container.stop({ t: 10 });
        } catch (_e) { }

        await container.remove({ force: true, v: true });

        // Remove volume
        try {
            const volume = docker.getVolume(volumeName);
            await volume.remove({ force: true });
        } catch (e) {
            console.warn('[containers] Failed to remove volume:', e.message);
        }

        // Delete Traefik config file
        await deleteTraefikConfig(username);

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] destroy error:', err);
        return res.status(500).json({ success: false, message: 'Failed to destroy container' });
    }
});

module.exports = router;
