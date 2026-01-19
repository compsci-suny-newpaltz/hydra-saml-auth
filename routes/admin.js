// routes/admin.js - Admin API endpoints for resource request management
// Handles approval/denial of resource requests and admin dashboard functionality

const express = require('express');
const router = express.Router();
const resourceConfig = require('../config/resources');
const {
    getAllPendingRequests,
    getRequestById,
    updateRequestStatus,
    updateUserQuota,
    updateContainerConfig,
    getAllUserQuotas,
    getNodeStatus,
    updateNodeStatus,
    getSecurityEvents,
    getSecuritySummary,
    acknowledgeSecurityEvent
} = require('../services/db-init');

// Admin users list from environment
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(u => u.trim().toLowerCase());

/**
 * Middleware: Check if user is an admin (faculty OR whitelist)
 */
function requireAdmin(req, res, next) {
    if (!req.isAuthenticated?.() || !req.user?.email) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const email = req.user.email.toLowerCase();
    const isFaculty = (req.user.affiliation || '').toLowerCase() === 'faculty';
    const isWhitelisted = ADMIN_USERS.includes(email);

    if (!isFaculty && !isWhitelisted) {
        console.warn(`[admin] Unauthorized access attempt by ${email}`);
        return res.status(403).json({ error: 'Admin access required' });
    }

    next();
}

// Apply admin check to all routes
router.use(requireAdmin);

/**
 * GET /requests
 * List all pending resource requests
 */
router.get('/requests', async (req, res) => {
    try {
        const requests = await getAllPendingRequests();

        res.json({
            requests: requests.map(r => ({
                id: r.id,
                username: r.username,
                email: r.email,
                target_node: r.target_node,
                requested_memory_gb: r.requested_memory_gb,
                requested_cpus: r.requested_cpus,
                requested_storage_gb: r.requested_storage_gb,
                requested_gpu_count: r.requested_gpu_count,
                preset_id: r.preset_id,
                request_type: r.request_type,
                status: r.status,
                reason: r.reason,
                created_at: r.created_at,
                expires_at: r.expires_at
            })),
            count: requests.length
        });
    } catch (error) {
        console.error('[admin] Failed to get requests:', error);
        res.status(500).json({ error: 'Failed to retrieve requests' });
    }
});

/**
 * POST /requests/:id/approve
 * Approve a resource request
 */
router.post('/requests/:id/approve', async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_notes } = req.body;
        const adminEmail = req.user.email;

        const request = await getRequestById(id);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request is no longer pending' });
        }

        // Update request status
        await updateRequestStatus(id, 'approved', adminEmail, admin_notes);

        // Update user quota based on the request
        const quotaUpdates = {
            approved_by: adminEmail,
            approved_at: new Date().toISOString()
        };

        // Handle Jupyter execution requests
        if (request.request_type === 'jupyter_execution') {
            quotaUpdates.jupyter_execution_approved = true;
            quotaUpdates.gpu_access_approved = true; // Jupyter execution implies GPU access
            await updateUserQuota(request.username, quotaUpdates);

            // Send approval email
            try {
                const emailNotifications = require('../services/email-notifications');
                await emailNotifications.sendApprovalResult(request, true, admin_notes);
            } catch (emailError) {
                console.warn('[admin] Failed to send approval email:', emailError.message);
            }

            console.log(`[admin] Jupyter execution request ${id} approved by ${adminEmail}`);
            return res.json({
                success: true,
                message: 'Jupyter execution request approved successfully'
            });
        }

        // Grant node access if needed
        if (request.target_node === 'chimera') {
            quotaUpdates.chimera_approved = true;
        }
        if (request.target_node === 'cerberus') {
            quotaUpdates.cerberus_approved = true;
        }
        if (request.requested_gpu_count > 0) {
            quotaUpdates.gpu_access_approved = true;
        }

        // Update storage/memory/cpu quotas if they exceed current
        if (request.requested_storage_gb > 40) {
            quotaUpdates.storage_gb = request.requested_storage_gb;
        }
        if (request.requested_memory_gb > 4) {
            quotaUpdates.max_memory_gb = request.requested_memory_gb;
        }
        if (request.requested_cpus > 2) {
            quotaUpdates.max_cpus = request.requested_cpus;
        }

        await updateUserQuota(request.username, quotaUpdates);

        // Update container config
        await updateContainerConfig(request.username, {
            memory_gb: request.requested_memory_gb,
            cpus: request.requested_cpus,
            storage_gb: request.requested_storage_gb,
            gpu_count: request.requested_gpu_count,
            preset_tier: request.preset_id || 'conservative'
        });

        // Send approval email to user
        try {
            const emailNotifications = require('../services/email-notifications');
            await emailNotifications.sendApprovalResult(request, true, admin_notes);
        } catch (emailError) {
            console.warn('[admin] Failed to send approval email:', emailError.message);
        }

        console.log(`[admin] Request ${id} approved by ${adminEmail}`);

        res.json({
            success: true,
            message: 'Request approved successfully'
        });
    } catch (error) {
        console.error('[admin] Failed to approve request:', error);
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

/**
 * POST /requests/:id/deny
 * Deny a resource request
 */
router.post('/requests/:id/deny', async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_notes } = req.body;
        const adminEmail = req.user.email;

        if (!admin_notes) {
            return res.status(400).json({ error: 'Please provide a reason for denial' });
        }

        const request = await getRequestById(id);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Request is no longer pending' });
        }

        // Update request status
        await updateRequestStatus(id, 'denied', adminEmail, admin_notes);

        // Send denial email to user
        try {
            const emailNotifications = require('../services/email-notifications');
            await emailNotifications.sendApprovalResult(request, false, admin_notes);
        } catch (emailError) {
            console.warn('[admin] Failed to send denial email:', emailError.message);
        }

        console.log(`[admin] Request ${id} denied by ${adminEmail}`);

        res.json({
            success: true,
            message: 'Request denied'
        });
    } catch (error) {
        console.error('[admin] Failed to deny request:', error);
        res.status(500).json({ error: 'Failed to deny request' });
    }
});

/**
 * GET /quotas
 * List all user quotas
 */
router.get('/quotas', async (req, res) => {
    try {
        const quotas = await getAllUserQuotas();

        res.json({
            quotas: quotas.map(q => ({
                username: q.username,
                email: q.email,
                storage_gb: q.storage_gb,
                max_memory_gb: q.max_memory_gb,
                max_cpus: q.max_cpus,
                gpu_access_approved: !!q.gpu_access_approved,
                chimera_approved: !!q.chimera_approved,
                cerberus_approved: !!q.cerberus_approved,
                approved_by: q.approved_by,
                approved_at: q.approved_at,
                created_at: q.created_at
            })),
            count: quotas.length
        });
    } catch (error) {
        console.error('[admin] Failed to get quotas:', error);
        res.status(500).json({ error: 'Failed to retrieve quotas' });
    }
});

/**
 * PUT /quotas/:username
 * Update a user's quota directly
 */
router.put('/quotas/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const updates = req.body;
        const adminEmail = req.user.email;

        // Add admin info to updates
        updates.approved_by = adminEmail;
        updates.approved_at = new Date().toISOString();

        await updateUserQuota(username, updates);

        console.log(`[admin] Quota updated for ${username} by ${adminEmail}`);

        res.json({
            success: true,
            message: 'Quota updated successfully'
        });
    } catch (error) {
        console.error('[admin] Failed to update quota:', error);
        res.status(500).json({ error: 'Failed to update quota' });
    }
});

/**
 * GET /nodes
 * Get all node statuses
 */
router.get('/nodes', async (req, res) => {
    try {
        const nodes = {};
        for (const nodeName of ['hydra', 'chimera', 'cerberus']) {
            const status = await getNodeStatus(nodeName);
            const config = resourceConfig.nodes[nodeName];
            nodes[nodeName] = {
                ...config,
                status: status || {
                    is_available: true,
                    current_containers: 0,
                    gpu_slots_used: 0
                }
            };
        }

        res.json({ nodes });
    } catch (error) {
        console.error('[admin] Failed to get nodes:', error);
        res.status(500).json({ error: 'Failed to retrieve nodes' });
    }
});

/**
 * PUT /nodes/:name
 * Update node status (maintenance mode, availability)
 */
router.put('/nodes/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const updates = req.body;

        if (!resourceConfig.nodes[name]) {
            return res.status(404).json({ error: 'Unknown node' });
        }

        await updateNodeStatus(name, updates);

        console.log(`[admin] Node ${name} status updated by ${req.user.email}`);

        res.json({
            success: true,
            message: 'Node status updated'
        });
    } catch (error) {
        console.error('[admin] Failed to update node:', error);
        res.status(500).json({ error: 'Failed to update node' });
    }
});

/**
 * POST /containers/migrate
 * Trigger a container migration between nodes
 */
router.post('/containers/migrate', async (req, res) => {
    try {
        const { username, from_node, to_node } = req.body;

        if (!username || !from_node || !to_node) {
            return res.status(400).json({ error: 'Missing required fields: username, from_node, to_node' });
        }

        if (!resourceConfig.nodes[from_node] || !resourceConfig.nodes[to_node]) {
            return res.status(400).json({ error: 'Invalid node specified' });
        }

        // Import migration service
        let migrationService;
        try {
            migrationService = require('../services/container-migration');
        } catch (e) {
            return res.status(501).json({ error: 'Migration service not available' });
        }

        // Start migration
        const result = await migrationService.migrateContainer(username, from_node, to_node);

        if (result.success) {
            // Update container config
            await updateContainerConfig(username, {
                current_node: to_node,
                last_migration_at: new Date().toISOString()
            });

            console.log(`[admin] Migrated ${username} from ${from_node} to ${to_node}`);
        }

        res.json(result);
    } catch (error) {
        console.error('[admin] Migration failed:', error);
        res.status(500).json({ error: 'Migration failed', details: error.message });
    }
});

/**
 * GET /stats
 * Get overall system statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const pendingRequests = await getAllPendingRequests();
        const quotas = await getAllUserQuotas();

        // Count users per node approval
        const chimeraApproved = quotas.filter(q => q.chimera_approved).length;
        const cerberusApproved = quotas.filter(q => q.cerberus_approved).length;
        const gpuApproved = quotas.filter(q => q.gpu_access_approved).length;

        res.json({
            pending_requests: pendingRequests.length,
            total_users: quotas.length,
            chimera_approved_users: chimeraApproved,
            cerberus_approved_users: cerberusApproved,
            gpu_approved_users: gpuApproved,
            requests_by_type: {
                new_container: pendingRequests.filter(r => r.request_type === 'new_container').length,
                migration: pendingRequests.filter(r => r.request_type === 'migration').length,
                resource_upgrade: pendingRequests.filter(r => r.request_type === 'resource_upgrade').length
            }
        });
    } catch (error) {
        console.error('[admin] Failed to get stats:', error);
        res.status(500).json({ error: 'Failed to retrieve statistics' });
    }
});

// ==================== Security Monitoring Endpoints ====================

/**
 * GET /security
 * Get security events summary and recent critical events
 */
router.get('/security', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const { summary, byType, topUsers } = await getSecuritySummary(hours);

        // Get recent critical events
        const criticalEvents = await getSecurityEvents({
            severity: 'critical',
            hours,
            limit: 20
        });

        res.json({
            summary,
            byType,
            topUsers,
            criticalEvents: criticalEvents.map(e => ({
                id: e.id,
                username: e.username,
                container_name: e.container_name,
                event_type: e.event_type,
                severity: e.severity,
                description: e.description,
                metrics: e.metrics ? JSON.parse(e.metrics) : null,
                action_taken: e.action_taken,
                acknowledged: !!e.acknowledged,
                created_at: e.created_at
            })),
            hours
        });
    } catch (error) {
        console.error('[admin] Failed to get security summary:', error);
        res.status(500).json({ error: 'Failed to retrieve security data' });
    }
});

/**
 * GET /security/events
 * Get security events with filters
 */
router.get('/security/events', async (req, res) => {
    try {
        const {
            severity,
            event_type,
            username,
            hours = 24,
            limit = 100
        } = req.query;

        const events = await getSecurityEvents({
            severity,
            event_type,
            username,
            hours: parseInt(hours),
            limit: parseInt(limit)
        });

        res.json({
            events: events.map(e => ({
                id: e.id,
                username: e.username,
                email: e.email,
                container_name: e.container_name,
                event_type: e.event_type,
                severity: e.severity,
                description: e.description,
                metrics: e.metrics ? JSON.parse(e.metrics) : null,
                process_info: e.process_info ? JSON.parse(e.process_info) : null,
                action_taken: e.action_taken,
                acknowledged: !!e.acknowledged,
                acknowledged_by: e.acknowledged_by,
                acknowledged_at: e.acknowledged_at,
                created_at: e.created_at
            })),
            count: events.length
        });
    } catch (error) {
        console.error('[admin] Failed to get security events:', error);
        res.status(500).json({ error: 'Failed to retrieve security events' });
    }
});

/**
 * POST /security/:id/acknowledge
 * Acknowledge a security event
 */
router.post('/security/:id/acknowledge', async (req, res) => {
    try {
        const { id } = req.params;
        const adminEmail = req.user.email;

        await acknowledgeSecurityEvent(parseInt(id), adminEmail);

        console.log(`[admin] Security event ${id} acknowledged by ${adminEmail}`);

        res.json({
            success: true,
            message: 'Event acknowledged'
        });
    } catch (error) {
        console.error('[admin] Failed to acknowledge event:', error);
        res.status(500).json({ error: 'Failed to acknowledge event' });
    }
});

/**
 * GET /security/status
 * Get security monitor status
 */
router.get('/security/status', async (req, res) => {
    try {
        const securityMonitor = require('../services/security-monitor');
        const status = securityMonitor.getStatus();

        res.json(status);
    } catch (error) {
        console.error('[admin] Failed to get monitor status:', error);
        res.status(500).json({ error: 'Failed to get monitor status' });
    }
});

/**
 * POST /security/scan
 * Force an immediate security scan
 */
router.post('/security/scan', async (req, res) => {
    try {
        const securityMonitor = require('../services/security-monitor');
        await securityMonitor.forceScan();

        console.log(`[admin] Security scan triggered by ${req.user.email}`);

        res.json({
            success: true,
            message: 'Security scan completed'
        });
    } catch (error) {
        console.error('[admin] Failed to run security scan:', error);
        res.status(500).json({ error: 'Failed to run security scan' });
    }
});

module.exports = router;
