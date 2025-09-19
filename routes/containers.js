const express = require('express');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Start a hello-world-like container for the user
// POST /dashboard/api/containers/start { project: string }
router.post('/start', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const project = String(req.body?.project || '').trim().toLowerCase();
        if (!project || !/^[a-z0-9-]{1,40}$/.test(project)) {
            return res.status(400).json({ success: false, message: 'Invalid project name' });
        }

        const username = String(req.user.email).split('@')[0];
        const host = 'hydra.newpaltz.edu';
        const basePath = `/students/${username}/${project}`;

        // Use a tiny static site image for demo
        let image = 'nginx:stable-perl';
        const containerName = `student-${username}-${project}`;

        // Create or reuse network to let Traefik discover containers
        const networkName = 'hydra_students_net';

        // Ensure network exists
        const networks = await docker.listNetworks({ filters: { name: [networkName] } });
        if (!networks.length) {
            await docker.createNetwork({ Name: networkName, Driver: 'bridge' });
        }

        // Pull image if needed (wait for completion)
        async function pullImage(img) {
            return new Promise((resolve, reject) => {
                docker.pull(img, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
                });
            });
        }
        try {
            await pullImage(image);
        } catch (_e) {
            image = 'busybox';
            await pullImage(image);
        }

        // Create container with Traefik labels for path routing
        // Route: http://hydra.newpaltz.edu/students/{username}/{project}/ -> container:80
        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');
        const publicUrl = `${publicBase}/${username}/${project}/`;

        const labels = {
            'traefik.enable': 'true',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.project': project,
            'hydra.basePath': basePath,
            'hydra.public_url': publicUrl,
            'hydra.managed_by': 'hydra-saml-auth'
        };
        labels[`traefik.http.routers.${containerName}.entrypoints`] = 'web';
        labels[`traefik.http.routers.${containerName}.rule`] = `PathPrefix(\"${basePath}\")`;
        labels[`traefik.http.services.${containerName}.loadbalancer.server.port`] = '80';
        labels[`traefik.http.middlewares.${containerName}-stripprefix.stripprefix.prefixes`] = basePath;
        labels[`traefik.http.routers.${containerName}.middlewares`] = `${containerName}-stripprefix`;

        // If container exists, start it, else create+start
        let container;
        try {
            container = docker.getContainer(containerName);
            await container.inspect();
        } catch {
            const isBusybox = image === 'busybox';
            container = await docker.createContainer({
                name: containerName,
                Image: image,
                Labels: labels,
                Cmd: isBusybox ? ['sh', '-c', 'echo Hello from ${HOSTNAME} > index.html && httpd -f -p 80 -h /'] : undefined,
                HostConfig: {
                    NetworkMode: networkName,
                    RestartPolicy: { Name: 'unless-stopped' }
                }
            });
        }

        // Connect to network if not connected
        try {
            const info = await container.inspect();
            const attached = info.NetworkSettings.Networks && info.NetworkSettings.Networks[networkName];
            if (!attached) {
                const net = docker.getNetwork(networkName);
                await net.connect({ Container: info.Id });
            }
        } catch (_e) { }

        await container.start();

        return res.json({ success: true, url: publicUrl, name: containerName });
    } catch (err) {
        console.error('[containers] start error:', err);
        return res.status(500).json({ success: false, message: 'Failed to start container' });
    }
});

// List current user's containers
router.get('/mine', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const username = String(req.user.email).split('@')[0];

        const containers = await docker.listContainers({
            all: true,
            filters: { label: [
                `hydra.owner=${username}`,
                'hydra.managed_by=hydra-saml-auth'
            ] }
        });

        const items = containers.map(c => ({
            id: c.Id,
            name: (c.Names && c.Names[0]) ? c.Names[0].replace(/^\//, '') : '',
            image: c.Image,
            state: c.State,
            status: c.Status,
            created: c.Created,
            project: c.Labels?.['hydra.project'] || '',
            url: c.Labels?.['hydra.public_url'] || ''
        }));
        return res.json({ success: true, containers: items });
    } catch (err) {
        console.error('[containers] list mine error:', err);
        return res.status(500).json({ success: false, message: 'Failed to list containers' });
    }
});

// Delete a user's container with cleanup
router.delete('/:name', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const username = String(req.user.email).split('@')[0];
        const nameParam = String(req.params.name || '').trim();
        if (!nameParam) return res.status(400).json({ success: false, message: 'Missing container name' });

        const container = docker.getContainer(nameParam);
        const info = await container.inspect();
        const labels = info?.Config?.Labels || {};
        if (labels['hydra.owner'] !== username || labels['hydra.managed_by'] !== 'hydra-saml-auth') {
            return res.status(403).json({ success: false, message: 'Not allowed' });
        }

        try { await container.stop({ t: 5 }); } catch (_e) {}
        await container.remove({ force: true, v: true });
        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] delete error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete container' });
    }
});

module.exports = router;
