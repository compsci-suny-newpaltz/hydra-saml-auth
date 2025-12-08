const express = require('express');
const Docker = require('dockerode');
const { getTier, isValidTier, DEFAULT_TIER, getAllTiers, getTierRequiredMachines } = require('../config/resources');
const { getMachine, isValidMachine, DEFAULT_MACHINE } = require('../config/machines');
const { getTemplate, isValidTemplate, getAllTemplates } = require('../config/templates');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Constants
const STUDENT_IMAGE = 'hydra-student-container:latest';
const MAIN_NETWORK = 'hydra_students_net';
const CODE_SERVER_PORT = 8443;
const JUPYTER_PORT = 8888;
const RESERVED_PORTS = [CODE_SERVER_PORT, JUPYTER_PORT];
const RESERVED_ENDPOINTS = ['vscode', 'jupyter'];

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

// Helper to generate Traefik labels for a route
function generateTraefikLabels(username, route) {
    const routerName = `student-${username}-${route.endpoint}`;
    const basePath = `/students/${username}/${route.endpoint}`;

    // Jupyter needs base_url and should NOT use stripprefix
    // Other services like code-server use relative paths and work with stripprefix
    const middlewares = route.endpoint === 'jupyter'
        ? `${routerName}-auth`
        : `${routerName}-auth,${routerName}-strip`;

    return {
        [`traefik.http.routers.${routerName}.entrypoints`]: 'web',
        [`traefik.http.routers.${routerName}.rule`]: `PathPrefix(\`${basePath}\`)`,
        [`traefik.http.routers.${routerName}.service`]: routerName,
        [`traefik.http.services.${routerName}.loadbalancer.server.port`]: String(route.port),
        [`traefik.http.middlewares.${routerName}-strip.stripprefix.prefixes`]: basePath,
        [`traefik.http.middlewares.${routerName}-auth.forwardauth.address`]: 'http://host.docker.internal:6969/auth/verify',
        [`traefik.http.middlewares.${routerName}-auth.forwardauth.trustForwardHeader`]: 'true',
        [`traefik.http.routers.${routerName}.middlewares`]: middlewares
    };
}

// Get available resource tiers
// GET /dashboard/api/containers/tiers
router.get('/tiers', (req, res) => {
    return res.json({ success: true, tiers: getAllTiers() });
});

// Get available workspace templates
// GET /dashboard/api/containers/templates
router.get('/templates', (req, res) => {
    return res.json({ success: true, templates: getAllTemplates() });
});

// Calculate expiration date (30 days from last login)
// This gets called on container init, which happens after SSO login
function calculateExpiration() {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + 30);
    return expDate.toISOString();
}

// Update expiration on login (called when user accesses dashboard)
function refreshExpirationOnLogin() {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + 30);
    return expDate.toISOString();
}

// Initialize/Create student mega container
// POST /dashboard/api/containers/init
// Body: { tier?: string, template?: string, course?: string, machine?: string }
router.post('/init', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;
        const volumeName = `hydra-vol-${username}`;
        const studentNetworkName = `hydra-student-${username}`;
        const host = 'hydra.newpaltz.edu';

        // Get tier from request or use default
        const tierId = req.body?.tier || DEFAULT_TIER;
        if (!isValidTier(tierId)) {
            return res.status(400).json({ success: false, message: `Invalid tier: ${tierId}` });
        }
        const tier = getTier(tierId);

        // Get machine from request or use default
        let machineId = req.body?.machine || DEFAULT_MACHINE;

        // Check if tier requires specific machine (GPU tiers)
        const requiredMachines = getTierRequiredMachines(tierId);
        if (requiredMachines) {
            if (!requiredMachines.includes(machineId)) {
                // Auto-select first available GPU machine if not specified correctly
                machineId = requiredMachines[0];
            }
        }

        if (!isValidMachine(machineId)) {
            return res.status(400).json({ success: false, message: `Invalid machine: ${machineId}` });
        }
        const machine = getMachine(machineId);

        // Optional: template and course
        const template = req.body?.template || 'default';
        const course = req.body?.course || null;

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

        // Default routes for code-server and jupyter
        const defaultRoutes = [
            { endpoint: 'vscode', port: CODE_SERVER_PORT },
            { endpoint: 'jupyter', port: JUPYTER_PORT }
        ];

        const now = new Date().toISOString();
        const expiresAt = calculateExpiration();

        // Base labels
        const labels = {
            'traefik.enable': 'true',
            'traefik.docker.network': 'hydra_students_net',
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.port_routes': JSON.stringify(defaultRoutes),
            'hydra.created_at': now,
            'hydra.tier': tierId,
            'hydra.template': template,
            'hydra.expires_at': expiresAt,
            'hydra.renewal_count': '0',
            'hydra.machine': machineId,
            'hydra.gpu': tier.gpu ? 'true' : 'false'
        };

        // Add course if specified
        if (course) {
            labels['hydra.course'] = course;
        }

        // Add Traefik labels for each default route
        defaultRoutes.forEach(route => {
            Object.assign(labels, generateTraefikLabels(username, route));
        });

        // GPU configuration for container
        const gpuConfig = tier.gpu ? {
            DeviceRequests: [{
                Driver: 'nvidia',
                Count: tier.gpuCount || 1,
                Capabilities: [['gpu']]
            }]
        } : {};

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

        // Create container with tier-based resource limits
        const container = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: STUDENT_IMAGE,
            Labels: labels,
            Env: [
                `USERNAME=${username}`,
                `HOME=/home/student`,
                `NVIDIA_VISIBLE_DEVICES=${tier.gpu ? 'all' : ''}`
            ],
            HostConfig: {
                NetworkMode: MAIN_NETWORK,
                RestartPolicy: { Name: 'unless-stopped' },
                Mounts: [{
                    Type: 'volume',
                    Source: volumeName,
                    Target: '/home/student'
                }],
                Memory: tier.memory,
                NanoCpus: tier.nanoCpus,
                Privileged: true, // For Docker-in-Docker
                ...gpuConfig
            }
        });

        // Connect to student network
        const studentNet = docker.getNetwork(studentNetworkName);
        await studentNet.connect({ Container: containerName });

        // Start container
        await container.start();

        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');

        return res.json({
            success: true,
            name: containerName,
            machine: machineId,
            gpu: tier.gpu || false,
            tier: tierId,
            expiresAt,
            vscodeUrl: `${publicBase}/${username}/vscode/`,
            jupyterUrl: `${publicBase}/${username}/jupyter/`
        });
    } catch (err) {
        console.error('[containers] init error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to initialize container' });
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
        const result = await getStudentContainer(username);

        if (!result) {
            return res.json({
                success: true,
                exists: false,
                state: 'not_created'
            });
        }

        const { info } = result;
        const labels = info.Config.Labels || {};

        // Get tier info
        const tierId = labels['hydra.tier'] || DEFAULT_TIER;
        const tier = getTier(tierId);

        // Calculate days until expiration
        const expiresAt = labels['hydra.expires_at'];
        let daysUntilExpiration = null;
        let expirationWarning = false;
        if (expiresAt) {
            const expDate = new Date(expiresAt);
            const now = new Date();
            daysUntilExpiration = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
            expirationWarning = daysUntilExpiration <= 7;
        }

        return res.json({
            success: true,
            exists: true,
            state: info.State.Status,
            running: info.State.Running,
            startedAt: info.State.StartedAt,
            finishedAt: info.State.FinishedAt,
            tier: {
                id: tierId,
                label: tier.label,
                memory: tier.memoryLabel,
                cpus: tier.cpus
            },
            template: labels['hydra.template'] || 'default',
            course: labels['hydra.course'] || null,
            machine: labels['hydra.machine'] || 'hydra',
            createdAt: labels['hydra.created_at'],
            expiresAt,
            daysUntilExpiration,
            expirationWarning,
            renewalCount: parseInt(labels['hydra.renewal_count'] || '0', 10)
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

        // Execute supervisorctl status
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

        await exec.start({ Detach: false, Tty: false });

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] start service error:', err);
        return res.status(500).json({ success: false, message: 'Failed to start service' });
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

        // Execute supervisorctl stop
        const exec = await container.exec({
            Cmd: ['supervisorctl', 'stop', serviceName],
            AttachStdout: true,
            AttachStderr: true
        });

        await exec.start({ Detach: false, Tty: false });

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] stop service error:', err);
        return res.status(500).json({ success: false, message: 'Failed to stop service' });
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

        const { info } = result;
        const labels = info.Config.Labels || {};
        const routesJson = labels['hydra.port_routes'] || '[]';

        let routes = [];
        try {
            routes = JSON.parse(routesJson);
        } catch (e) {
            console.error('[containers] Failed to parse port_routes:', e);
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

        // Prepare new labels
        const newLabels = { ...oldLabels };
        newLabels['hydra.port_routes'] = JSON.stringify(routes);

        // Add Traefik labels for new route
        Object.assign(newLabels, generateTraefikLabels(username, newRoute));

        // Recreate container with new labels
        const wasRunning = info.State.Running;

        if (wasRunning) {
            await container.stop({ t: 10 });
        }
        await container.remove({ force: true });

        const newContainer = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: info.Config.Image,
            Labels: newLabels,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            HostConfig: info.HostConfig
        });

        if (wasRunning) {
            await newContainer.start();

            // Reconnect to student network
            const studentNetworkName = `hydra-student-${username}`;
            try {
                const studentNet = docker.getNetwork(studentNetworkName);
                await studentNet.connect({ Container: containerName });
            } catch (e) {
                console.error('[containers] Failed to reconnect to student network:', e);
            }
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

        // Check if endpoint exists
        const routeIndex = routes.findIndex(r => r.endpoint === endpoint);
        if (routeIndex === -1) {
            return res.status(404).json({ success: false, message: 'Endpoint not found' });
        }

        // Remove route
        routes.splice(routeIndex, 1);

        // Prepare new labels - remove all Traefik labels for this endpoint
        const newLabels = {};
        const routerName = `student-${username}-${endpoint}`;

        for (const [key, value] of Object.entries(oldLabels)) {
            // Skip labels related to the deleted endpoint
            if (key.includes(routerName)) {
                continue;
            }
            newLabels[key] = value;
        }

        newLabels['hydra.port_routes'] = JSON.stringify(routes);

        // Recreate container with new labels
        const wasRunning = info.State.Running;

        if (wasRunning) {
            await container.stop({ t: 10 });
        }
        await container.remove({ force: true });

        const newContainer = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: info.Config.Image,
            Labels: newLabels,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            HostConfig: info.HostConfig
        });

        if (wasRunning) {
            await newContainer.start();

            // Reconnect to student network
            const studentNetworkName = `hydra-student-${username}`;
            try {
                const studentNet = docker.getNetwork(studentNetworkName);
                await studentNet.connect({ Container: containerName });
            } catch (e) {
                console.error('[containers] Failed to reconnect to student network:', e);
            }
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] delete route error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete route' });
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

// Renew container expiration (extends by 30 days)
// POST /dashboard/api/containers/renew
router.post('/renew', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;
        const oldLabels = info.Config.Labels || {};

        // Calculate new expiration (30 days from now)
        const newExpiresAt = calculateExpiration();
        const renewalCount = parseInt(oldLabels['hydra.renewal_count'] || '0', 10) + 1;

        // Update labels
        const newLabels = { ...oldLabels };
        newLabels['hydra.expires_at'] = newExpiresAt;
        newLabels['hydra.renewal_count'] = String(renewalCount);

        // Recreate container with new labels
        const wasRunning = info.State.Running;

        if (wasRunning) {
            await container.stop({ t: 10 });
        }
        await container.remove({ force: true });

        const newContainer = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: info.Config.Image,
            Labels: newLabels,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            HostConfig: info.HostConfig
        });

        if (wasRunning) {
            await newContainer.start();

            // Reconnect to student network
            const studentNetworkName = `hydra-student-${username}`;
            try {
                const studentNet = docker.getNetwork(studentNetworkName);
                await studentNet.connect({ Container: containerName });
            } catch (e) {
                console.error('[containers] Failed to reconnect to student network:', e);
            }
        }

        return res.json({
            success: true,
            expiresAt: newExpiresAt,
            renewalCount,
            message: 'Container renewed for 30 days'
        });
    } catch (err) {
        console.error('[containers] renew error:', err);
        return res.status(500).json({ success: false, message: 'Failed to renew container' });
    }
});

// Refresh expiration on login (auto-extend 30 days from last SSO login)
// POST /dashboard/api/containers/refresh-expiration
router.post('/refresh-expiration', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;
        const result = await getStudentContainer(username);

        if (!result) {
            // No container yet, nothing to refresh
            return res.json({ success: true, message: 'No container to refresh' });
        }

        const { container, info } = result;
        const oldLabels = info.Config.Labels || {};

        // Calculate new expiration (30 days from now/login)
        const newExpiresAt = refreshExpirationOnLogin();
        const lastLogin = new Date().toISOString();

        // Update labels without recreating container (just update expiration)
        const newLabels = { ...oldLabels };
        newLabels['hydra.expires_at'] = newExpiresAt;
        newLabels['hydra.last_login'] = lastLogin;

        // Recreate container with updated expiration
        const wasRunning = info.State.Running;

        if (wasRunning) {
            await container.stop({ t: 10 });
        }
        await container.remove({ force: true });

        const newContainer = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: info.Config.Image,
            Labels: newLabels,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            HostConfig: info.HostConfig
        });

        if (wasRunning) {
            await newContainer.start();

            const studentNetworkName = `hydra-student-${username}`;
            try {
                const studentNet = docker.getNetwork(studentNetworkName);
                await studentNet.connect({ Container: containerName });
            } catch (e) {
                console.error('[containers] Failed to reconnect to student network:', e);
            }
        }

        return res.json({
            success: true,
            expiresAt: newExpiresAt,
            lastLogin,
            message: 'Expiration refreshed (30 days from login)'
        });
    } catch (err) {
        console.error('[containers] refresh-expiration error:', err);
        return res.status(500).json({ success: false, message: 'Failed to refresh expiration' });
    }
});

// Change container resource tier
// POST /dashboard/api/containers/tier { tier: string }
router.post('/tier', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const newTierId = req.body?.tier;
        if (!newTierId || !isValidTier(newTierId)) {
            return res.status(400).json({ success: false, message: 'Invalid tier' });
        }

        const newTier = getTier(newTierId);
        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;
        const oldLabels = info.Config.Labels || {};

        // Update tier label
        const newLabels = { ...oldLabels };
        newLabels['hydra.tier'] = newTierId;

        // Update HostConfig with new resource limits
        const newHostConfig = { ...info.HostConfig };
        newHostConfig.Memory = newTier.memory;
        newHostConfig.NanoCpus = newTier.nanoCpus;

        // Recreate container with new resources (requires restart)
        const wasRunning = info.State.Running;

        if (wasRunning) {
            await container.stop({ t: 10 });
        }
        await container.remove({ force: true });

        const newContainer = await docker.createContainer({
            name: containerName,
            Hostname: containerName,
            Image: info.Config.Image,
            Labels: newLabels,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            HostConfig: newHostConfig
        });

        if (wasRunning) {
            await newContainer.start();

            // Reconnect to student network
            const studentNetworkName = `hydra-student-${username}`;
            try {
                const studentNet = docker.getNetwork(studentNetworkName);
                await studentNet.connect({ Container: containerName });
            } catch (e) {
                console.error('[containers] Failed to reconnect to student network:', e);
            }
        }

        return res.json({
            success: true,
            tier: newTierId,
            message: `Container resources changed to ${newTier.label}`
        });
    } catch (err) {
        console.error('[containers] tier change error:', err);
        return res.status(500).json({ success: false, message: 'Failed to change tier' });
    }
});

// Wipe and recreate student container
// POST /dashboard/api/containers/wipe
// Body: { tier?: string, template?: string }
router.post('/wipe', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;
        const volumeName = `hydra-vol-${username}`;

        // Get tier from request or use default
        const tierId = req.body?.tier || DEFAULT_TIER;
        if (!isValidTier(tierId)) {
            return res.status(400).json({ success: false, message: `Invalid tier: ${tierId}` });
        }
        const tier = getTier(tierId);

        const template = req.body?.template || 'default';

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

        // 2. Re-initialize container
        const studentNetworkName = `hydra-student-${username}`;

        // Ensure networks exist
        await ensureNetwork(MAIN_NETWORK);
        await ensureNetwork(studentNetworkName);

        // Ensure volume exists
        await ensureVolume(volumeName, username);

        // Default routes for code-server and jupyter
        const defaultRoutes = [
            { endpoint: 'vscode', port: CODE_SERVER_PORT },
            { endpoint: 'jupyter', port: JUPYTER_PORT }
        ];

        const now = new Date().toISOString();
        const expiresAt = calculateExpiration();

        // Base labels
        const labels = {
            'traefik.enable': 'true',
            'traefik.docker.network': 'hydra_students_net',
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.port_routes': JSON.stringify(defaultRoutes),
            'hydra.created_at': now,
            'hydra.tier': tierId,
            'hydra.template': template,
            'hydra.expires_at': expiresAt,
            'hydra.renewal_count': '0',
            'hydra.machine': 'hydra'
        };

        // Add Traefik labels for each default route
        defaultRoutes.forEach(route => {
            Object.assign(labels, generateTraefikLabels(username, route));
        });

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

        // Create container with tier-based resource limits
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
                Mounts: [{
                    Type: 'volume',
                    Source: volumeName,
                    Target: '/home/student'
                }],
                Memory: tier.memory,
                NanoCpus: tier.nanoCpus,
                Privileged: true // For Docker-in-Docker
            }
        });

        // Connect to student network
        const studentNet = docker.getNetwork(studentNetworkName);
        await studentNet.connect({ Container: containerName });

        // Start container
        await newContainer.start();

        return res.json({
            success: true,
            tier: tierId,
            expiresAt,
            message: 'Container wiped and recreated'
        });

    } catch (err) {
        console.error('[containers] wipe error:', err);
        return res.status(500).json({ success: false, message: 'Failed to wipe and recreate container' });
    }
});

// Migrate container to a different machine
// POST /dashboard/api/containers/migrate { targetMachine: string }
// Note: This is a placeholder - actual migration requires Docker API access to remote hosts
router.post('/migrate', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const targetMachine = req.body?.targetMachine;
        if (!targetMachine) {
            return res.status(400).json({ success: false, message: 'Target machine required' });
        }

        // Valid machines
        const validMachines = ['hydra', 'chimera', 'cerberus'];
        if (!validMachines.includes(targetMachine)) {
            return res.status(400).json({ success: false, message: 'Invalid target machine' });
        }

        const username = String(req.user.email).split('@')[0];
        const result = await getStudentContainer(username);

        if (!result) {
            return res.status(404).json({ success: false, message: 'Container not found' });
        }

        const { container, info } = result;
        const currentMachine = info.Config.Labels?.['hydra.machine'] || 'hydra';

        if (currentMachine === targetMachine) {
            return res.json({ success: true, message: 'Container already on target machine' });
        }

        // Migration steps (simplified - actual implementation needs remote Docker access):
        // 1. Export volume data
        // 2. Stop container on source
        // 3. Create container on target
        // 4. Import volume data
        // 5. Start container on target
        // 6. Update routing

        // For now, just update the machine label (actual migration not implemented)
        const oldLabels = info.Config.Labels || {};
        const newLabels = { ...oldLabels };
        newLabels['hydra.machine'] = targetMachine;

        // Note: In a real implementation, you would:
        // - Connect to the target machine's Docker daemon
        // - Create the container there
        // - Transfer volume data
        // - Delete from source
        // - Update Traefik routing to point to new machine

        return res.status(501).json({
            success: false,
            message: 'Migration feature requires remote Docker API setup. Currently only marking target machine.',
            currentMachine,
            targetMachine,
            note: 'Enable Docker API on remote machines (port 2375) and configure DOCKER_HOST environment variables.'
        });
    } catch (err) {
        console.error('[containers] migrate error:', err);
        return res.status(500).json({ success: false, message: 'Failed to migrate container' });
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
        const result = await getStudentContainer(username);

        if (!result) {
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

        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] destroy error:', err);
        return res.status(500).json({ success: false, message: 'Failed to destroy container' });
    }
});

module.exports = router;
