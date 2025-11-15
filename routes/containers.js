const express = require('express');
const Docker = require('dockerode');

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

// Initialize/Create student mega container
// POST /dashboard/api/containers/init
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

        // Base labels
        const labels = {
            'traefik.enable': 'true',
            'traefik.docker.network': 'hydra_students_net',
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.port_routes': JSON.stringify(defaultRoutes),
            'hydra.created_at': new Date().toISOString()
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

        // Create container
        const container = await docker.createContainer({
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
                Memory: 4 * 1024 * 1024 * 1024, // 4GB
                NanoCpus: 2e9, // 2 CPUs
                Privileged: true // For Docker-in-Docker
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

// Wipe and recreate student container
// POST /dashboard/api/containers/wipe
router.post('/wipe', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const username = String(req.user.email).split('@')[0];
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

        // 2. Re-initialize container (logic copied and adapted from /init)
        const studentNetworkName = `hydra-student-${username}`;
        const host = 'hydra.newpaltz.edu';

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

        // Base labels
        const labels = {
            'traefik.enable': 'true',
            'traefik.docker.network': 'hydra_students_net',
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.port_routes': JSON.stringify(defaultRoutes),
            'hydra.created_at': new Date().toISOString()
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
                Mounts: [{
                    Type: 'volume',
                    Source: volumeName,
                    Target: '/home/student'
                }],
                Memory: 4 * 1024 * 1024 * 1024, // 4GB
                NanoCpus: 2e9, // 2 CPUs
                Privileged: true // For Docker-in-Docker
            }
        });

        // Connect to student network
        const studentNet = docker.getNetwork(studentNetworkName);
        await studentNet.connect({ Container: containerName });

        // Start container
        await newContainer.start();

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
