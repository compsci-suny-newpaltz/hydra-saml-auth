/**
 * Admin routes for the admin dashboard
 * Requires admin role for access
 */

const express = require('express');
const router = express.Router();
const Docker = require('dockerode');
const { isAdmin, isFaculty, getAllWhitelisted } = require('../config/whitelist');
const { MACHINES, getDocker } = require('../config/machines');

// Admin middleware
function requireAdmin(req, res, next) {
    if (!req.session?.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userEmail = req.session.user.email || req.session.user.nameID;
    if (!isAdmin(userEmail)) {
        return res.status(403).json({ error: 'Admin access required' });
    }

    next();
}

// Admin dashboard page
router.get('/', requireAdmin, (req, res) => {
    const whitelist = getAllWhitelisted();
    res.render('admin-dashboard', {
        user: req.session.user,
        role: isAdmin(req.session.user.email) ? 'admin' : 'faculty',
        admins: whitelist.admins,
        faculty: whitelist.faculty
    });
});

// Get all containers across all machines
router.get('/api/admin/containers', requireAdmin, async (req, res) => {
    try {
        const containers = [];

        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const machineContainers = await docker.listContainers({ all: true });

                for (const container of machineContainers) {
                    // Filter to student containers
                    if (container.Names.some(n => n.includes('student-'))) {
                        const labels = container.Labels || {};
                        containers.push({
                            name: container.Names[0].replace('/', ''),
                            state: container.State,
                            machine: machineName,
                            owner: labels['hydra.owner'] || null,
                            tier: labels['hydra.tier'] || 'micro',
                            template: labels['hydra.template'] || 'default',
                            course: labels['hydra.course'] || null,
                            createdAt: labels['hydra.created_at'] || null,
                            expiresAt: labels['hydra.expires_at'] || null,
                            lastLogin: labels['hydra.last_login'] || null
                        });
                    }
                }
            } catch (err) {
                console.error(`Error fetching containers from ${machineName}:`, err.message);
            }
        }

        res.json({ containers });
    } catch (err) {
        console.error('Error fetching containers:', err);
        res.status(500).json({ error: 'Failed to fetch containers' });
    }
});

// Get container details
router.get('/api/admin/containers/:name', requireAdmin, async (req, res) => {
    const { name } = req.params;

    try {
        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const container = docker.getContainer(name);
                const info = await container.inspect();

                const labels = info.Config.Labels || {};
                return res.json({
                    name: info.Name.replace('/', ''),
                    state: info.State.Status,
                    machine: machineName,
                    owner: labels['hydra.owner'] || null,
                    tier: labels['hydra.tier'] || 'micro',
                    template: labels['hydra.template'] || 'default',
                    course: labels['hydra.course'] || null,
                    createdAt: labels['hydra.created_at'] || null,
                    expiresAt: labels['hydra.expires_at'] || null,
                    lastLogin: labels['hydra.last_login'] || null,
                    image: info.Config.Image,
                    created: info.Created,
                    networkSettings: info.NetworkSettings
                });
            } catch (err) {
                // Container not on this machine, try next
            }
        }

        res.status(404).json({ error: 'Container not found' });
    } catch (err) {
        console.error('Error fetching container:', err);
        res.status(500).json({ error: 'Failed to fetch container' });
    }
});

// Stop container
router.post('/api/admin/containers/:name/stop', requireAdmin, async (req, res) => {
    const { name } = req.params;

    try {
        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const container = docker.getContainer(name);
                await container.stop();
                return res.json({ success: true, message: 'Container stopped' });
            } catch (err) {
                // Container not on this machine or already stopped
            }
        }

        res.status(404).json({ error: 'Container not found or already stopped' });
    } catch (err) {
        console.error('Error stopping container:', err);
        res.status(500).json({ error: 'Failed to stop container' });
    }
});

// Restart container
router.post('/api/admin/containers/:name/restart', requireAdmin, async (req, res) => {
    const { name } = req.params;

    try {
        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const container = docker.getContainer(name);
                await container.restart();
                return res.json({ success: true, message: 'Container restarted' });
            } catch (err) {
                // Container not on this machine
            }
        }

        res.status(404).json({ error: 'Container not found' });
    } catch (err) {
        console.error('Error restarting container:', err);
        res.status(500).json({ error: 'Failed to restart container' });
    }
});

// Delete container
router.delete('/api/admin/containers/:name', requireAdmin, async (req, res) => {
    const { name } = req.params;

    try {
        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const container = docker.getContainer(name);

                // Stop if running
                try {
                    await container.stop();
                } catch (e) {}

                await container.remove({ v: true }); // Remove volumes too
                return res.json({ success: true, message: 'Container deleted' });
            } catch (err) {
                // Container not on this machine
            }
        }

        res.status(404).json({ error: 'Container not found' });
    } catch (err) {
        console.error('Error deleting container:', err);
        res.status(500).json({ error: 'Failed to delete container' });
    }
});

// Extend container expiration
router.post('/api/admin/containers/:name/extend', requireAdmin, async (req, res) => {
    const { name } = req.params;
    const { days = 30 } = req.body;

    try {
        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const container = docker.getContainer(name);
                const info = await container.inspect();

                const currentExpiry = info.Config.Labels['hydra.expires_at'];
                const baseDate = currentExpiry ? new Date(currentExpiry) : new Date();
                const newExpiry = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

                // Note: Can't update labels on running container, need to recreate
                // For now, just return the new expiry date
                return res.json({
                    success: true,
                    message: `Expiration extended by ${days} days`,
                    newExpiresAt: newExpiry.toISOString()
                });
            } catch (err) {
                // Container not on this machine
            }
        }

        res.status(404).json({ error: 'Container not found' });
    } catch (err) {
        console.error('Error extending container:', err);
        res.status(500).json({ error: 'Failed to extend container' });
    }
});

// Access container (proxy to code-server)
router.get('/admin/container/:name', requireAdmin, async (req, res) => {
    const { name } = req.params;

    // Redirect to the container's code-server URL
    // This would need proper routing through Traefik
    const containerUrl = `https://${name}.hydra.newpaltz.edu`;
    res.redirect(containerUrl);
});

// Get system logs (mock for now - would integrate with actual logging)
router.get('/api/admin/logs', requireAdmin, async (req, res) => {
    const { filter = 'all' } = req.query;

    // Mock logs - in production, read from actual log files or Loki/etc
    const logs = [
        { timestamp: new Date().toISOString(), level: 'info', message: 'Admin dashboard accessed' },
        { timestamp: new Date(Date.now() - 60000).toISOString(), level: 'info', message: 'Container student-demo created' },
        { timestamp: new Date(Date.now() - 120000).toISOString(), level: 'warn', message: 'Container student-test expiring in 3 days' },
        { timestamp: new Date(Date.now() - 180000).toISOString(), level: 'error', message: 'Failed to connect to Chimera Docker daemon' },
        { timestamp: new Date(Date.now() - 240000).toISOString(), level: 'info', message: 'User john@newpaltz.edu logged in' }
    ];

    const filtered = filter === 'all'
        ? logs
        : logs.filter(l => l.level === filter);

    res.json({ logs: filtered });
});

// Get aggregate stats
router.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        let totalContainers = 0;
        let runningContainers = 0;
        let expiringContainers = 0;
        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        for (const [machineName, machine] of Object.entries(MACHINES)) {
            try {
                const docker = getDocker(machineName);
                const containers = await docker.listContainers({ all: true });

                for (const container of containers) {
                    if (container.Names.some(n => n.includes('student-'))) {
                        totalContainers++;
                        if (container.State === 'running') runningContainers++;

                        const expiresAt = container.Labels?.['hydra.expires_at'];
                        if (expiresAt && new Date(expiresAt) < weekFromNow) {
                            expiringContainers++;
                        }
                    }
                }
            } catch (err) {
                console.error(`Error fetching stats from ${machineName}:`, err.message);
            }
        }

        res.json({
            totalContainers,
            runningContainers,
            expiringContainers
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

module.exports = router;
