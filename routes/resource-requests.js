// routes/resource-requests.js - Resource request API endpoints
// Handles resource configuration, quota management, and request submission

const express = require('express');
const router = express.Router();
const resourceConfig = require('../config/resources');
const {
    getOrCreateUserQuota,
    createResourceRequest,
    getUserPendingRequests,
    getOrCreateContainerConfig,
    updateContainerConfig,
    getNodeStatus
} = require('../services/db-init');

// Import metrics collector for real-time node status
let metricsCollector;
try {
    metricsCollector = require('../services/metrics-collector');
} catch (e) {
    console.warn('[resource-requests] Metrics collector not available');
}

/**
 * Helper: Extract username from authenticated request
 */
function getUsername(req) {
    if (!req.isAuthenticated?.() || !req.user?.email) {
        return null;
    }
    return String(req.user.email).split('@')[0];
}

/**
 * Helper: Check if user has admin privileges
 */
function isAdmin(req) {
    const adminList = (process.env.ADMIN_USERS || '').split(',').map(u => u.trim().toLowerCase());
    const email = req.user?.email?.toLowerCase();
    return adminList.includes(email);
}

/**
 * Helper: Get real-time node metrics
 * Returns current load, capacity, and availability for all nodes
 */
async function getNodeMetrics() {
    const metrics = {};

    // Try to get real metrics from collector
    let collectorMetrics = null;
    if (metricsCollector) {
        try {
            collectorMetrics = metricsCollector.getMetrics();
        } catch (e) {
            console.warn('[resource-requests] Failed to get collector metrics:', e.message);
        }
    }

    for (const [nodeName, nodeConfig] of Object.entries(resourceConfig.nodes)) {
        const dbStatus = await getNodeStatus(nodeName);

        // Get real metrics if available
        const realMetrics = collectorMetrics?.[nodeName];

        // Calculate available capacity
        const maxContainers = nodeConfig.maxContainers;
        const currentContainers = realMetrics?.containers?.running || dbStatus?.current_containers || 0;
        const availableSlots = Math.max(0, maxContainers - currentContainers);

        // GPU availability for GPU nodes
        let gpuMetrics = null;
        if (nodeConfig.gpuEnabled) {
            const gpus = realMetrics?.gpus || [];
            const totalGpus = nodeConfig.gpuCount;
            const gpuSlotsUsed = dbStatus?.gpu_slots_used || 0;
            const avgUtil = gpus.length > 0
                ? Math.round(gpus.reduce((sum, g) => sum + (g.utilization_percent || g.util || 0), 0) / gpus.length)
                : 0;
            const avgVramUsed = gpus.length > 0
                ? Math.round(gpus.reduce((sum, g) => sum + (g.memory_used_gb || g.vram_used || 0), 0) / gpus.length)
                : 0;

            gpuMetrics = {
                total: totalGpus,
                available: Math.max(0, totalGpus - gpuSlotsUsed),
                avgUtilization: avgUtil,
                avgVramUsedGb: avgVramUsed,
                vramPerCardGb: nodeConfig.gpuVramPerCard,
                model: nodeConfig.gpuModel,
                cards: gpus.map((g, i) => ({
                    index: i,
                    name: g.name || nodeConfig.gpuModel,
                    utilization: g.utilization_percent || g.util || 0,
                    vramUsed: g.memory_used_gb || g.vram_used || 0,
                    vramTotal: g.memory_total_gb || g.vram_total || nodeConfig.gpuVramPerCard,
                    temp: g.temperature_c || g.temp || 0
                }))
            };
        }

        // System metrics
        const systemMetrics = realMetrics?.system || {};

        metrics[nodeName] = {
            label: nodeConfig.label,
            role: nodeConfig.role,
            online: dbStatus?.is_available !== 0 && !dbStatus?.maintenance_mode,
            maintenance: !!dbStatus?.maintenance_mode,
            capacity: {
                maxContainers,
                currentContainers,
                availableSlots,
                utilizationPercent: Math.round((currentContainers / maxContainers) * 100)
            },
            system: {
                cpuPercent: systemMetrics.cpu_percent || 0,
                ramUsedGb: systemMetrics.ram_used_gb || 0,
                ramTotalGb: systemMetrics.ram_total_gb || nodeConfig.ramTotal || 64,
                ramPercent: systemMetrics.ram_total_gb
                    ? Math.round((systemMetrics.ram_used_gb / systemMetrics.ram_total_gb) * 100)
                    : 0
            },
            gpu: gpuMetrics,
            queueDepth: realMetrics?.queue?.pending || 0,
            lastUpdated: realMetrics?.timestamp || new Date().toISOString()
        };
    }

    return metrics;
}

/**
 * Helper: Auto-schedule - recommend the best node based on current load
 * Returns the recommended node name and reason
 */
function recommendNode(nodeMetrics, requestedResources) {
    const { memory_gb, cpus, gpu_count } = requestedResources;

    // If GPU is needed, only consider GPU nodes
    if (gpu_count > 0) {
        const gpuNodes = ['chimera', 'cerberus'].filter(name => {
            const node = nodeMetrics[name];
            return node.online && !node.maintenance &&
                   node.gpu && node.gpu.available >= gpu_count;
        });

        if (gpuNodes.length === 0) {
            return {
                recommended: null,
                reason: 'No GPU nodes available with requested GPU count',
                alternatives: []
            };
        }

        // Prefer node with lower GPU utilization and more available slots
        gpuNodes.sort((a, b) => {
            const nodeA = nodeMetrics[a];
            const nodeB = nodeMetrics[b];
            // Score based on: available GPUs, utilization, queue depth
            const scoreA = (nodeA.gpu.available * 10) - nodeA.gpu.avgUtilization - (nodeA.queueDepth * 5);
            const scoreB = (nodeB.gpu.available * 10) - nodeB.gpu.avgUtilization - (nodeB.queueDepth * 5);
            return scoreB - scoreA;
        });

        const recommended = gpuNodes[0];
        const node = nodeMetrics[recommended];
        return {
            recommended,
            reason: `${node.label} has ${node.gpu.available} GPU(s) available at ${node.gpu.avgUtilization}% avg utilization`,
            alternatives: gpuNodes.slice(1),
            estimatedWait: node.queueDepth > 0 ? `~${node.queueDepth * 15} min queue` : 'No queue'
        };
    }

    // For non-GPU requests, prefer Hydra, then other nodes based on load
    const availableNodes = Object.entries(nodeMetrics)
        .filter(([name, node]) => node.online && !node.maintenance && node.capacity.availableSlots > 0)
        .sort((a, b) => {
            const [nameA, nodeA] = a;
            const [nameB, nodeB] = b;
            // Prefer Hydra for non-GPU workloads
            if (nameA === 'hydra') return -1;
            if (nameB === 'hydra') return 1;
            // Otherwise prefer lower utilization
            return nodeA.capacity.utilizationPercent - nodeB.capacity.utilizationPercent;
        });

    if (availableNodes.length === 0) {
        return {
            recommended: null,
            reason: 'No nodes available with capacity',
            alternatives: []
        };
    }

    const [recommendedName, recommendedNode] = availableNodes[0];
    return {
        recommended: recommendedName,
        reason: recommendedName === 'hydra'
            ? `Hydra is the default node with ${recommendedNode.capacity.availableSlots} slots available`
            : `${recommendedNode.label} has ${recommendedNode.capacity.utilizationPercent}% utilization`,
        alternatives: availableNodes.slice(1, 3).map(([name]) => name),
        estimatedWait: 'Immediate'
    };
}

/**
 * GET /presets
 * Returns available resource presets and configuration options
 * Includes real-time node metrics and auto-scheduling recommendations
 */
router.get('/presets', async (req, res) => {
    try {
        const username = getUsername(req);
        if (!username) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Get user's current quota to show what they're approved for
        const quota = await getOrCreateUserQuota(username, req.user.email);
        const containerConfig = await getOrCreateContainerConfig(username, `student-${username}`);

        // Get real-time node metrics
        const nodeMetrics = await getNodeMetrics();

        // Get available presets based on user's approvals
        const availablePresets = {};
        for (const [id, preset] of Object.entries(resourceConfig.presets)) {
            // Check if preset is available for the user
            const nodeRestrictions = preset.allowedNodes;
            let available = true;
            let requiresApproval = !preset.autoApproveOnHydra;

            // GPU presets require specific node approval
            if (preset.gpu_count > 0) {
                if (nodeRestrictions.includes('chimera') && !quota.chimera_approved) {
                    requiresApproval = true;
                }
                if (nodeRestrictions.includes('cerberus') && !quota.cerberus_approved) {
                    requiresApproval = true;
                }
            }

            // Check if any allowed node has capacity
            const hasCapacity = nodeRestrictions.some(nodeName => {
                const metrics = nodeMetrics[nodeName];
                if (!metrics || !metrics.online || metrics.maintenance) return false;
                if (preset.gpu_count > 0 && metrics.gpu) {
                    return metrics.gpu.available >= preset.gpu_count;
                }
                return metrics.capacity.availableSlots > 0;
            });

            availablePresets[id] = {
                ...preset,
                requiresApproval,
                available,
                hasCapacity
            };
        }

        // Get node availability with real-time metrics
        const nodes = {};
        for (const [nodeName, nodeConfig] of Object.entries(resourceConfig.nodes)) {
            const metrics = nodeMetrics[nodeName];
            nodes[nodeName] = {
                label: nodeConfig.label,
                role: nodeConfig.role,
                gpuEnabled: nodeConfig.gpuEnabled,
                gpuModel: nodeConfig.gpuModel || null,
                gpuCount: nodeConfig.gpuCount || 0,
                maxContainers: nodeConfig.maxContainers,
                requiresApproval: nodeConfig.requiresApproval || false,
                userApproved: nodeName === 'hydra' ||
                    (nodeName === 'chimera' && quota.chimera_approved) ||
                    (nodeName === 'cerberus' && quota.cerberus_approved),
                // Real-time metrics
                online: metrics.online,
                maintenance: metrics.maintenance,
                capacity: metrics.capacity,
                system: metrics.system,
                gpu: metrics.gpu,
                queueDepth: metrics.queueDepth,
                lastUpdated: metrics.lastUpdated
            };
        }

        // Get auto-scheduling recommendation based on current config
        const currentPreset = resourceConfig.presets[containerConfig.preset_tier] || resourceConfig.presets.conservative;
        const recommendation = recommendNode(nodeMetrics, {
            memory_gb: currentPreset.memory_gb,
            cpus: currentPreset.cpus,
            gpu_count: currentPreset.gpu_count || 0
        });

        res.json({
            presets: availablePresets,
            nodes,
            storageTiers: resourceConfig.storageTiers,
            memoryTiers: resourceConfig.memoryTiers,
            cpuTiers: resourceConfig.cpuTiers,
            currentConfig: containerConfig,
            quota: {
                storage_gb: quota.storage_gb,
                max_memory_gb: quota.max_memory_gb,
                max_cpus: quota.max_cpus,
                gpu_access_approved: !!quota.gpu_access_approved,
                chimera_approved: !!quota.chimera_approved,
                cerberus_approved: !!quota.cerberus_approved
            },
            limits: resourceConfig.limits,
            recommendation
        });
    } catch (error) {
        console.error('[resource-requests] Failed to get presets:', error);
        res.status(500).json({ error: 'Failed to retrieve configuration options' });
    }
});

/**
 * GET /quota
 * Returns the user's current quota and container configuration
 */
router.get('/quota', async (req, res) => {
    try {
        const username = getUsername(req);
        if (!username) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const quota = await getOrCreateUserQuota(username, req.user.email);
        const containerConfig = await getOrCreateContainerConfig(username, `student-${username}`);

        res.json({
            quota: {
                username: quota.username,
                email: quota.email,
                storage_gb: quota.storage_gb,
                max_memory_gb: quota.max_memory_gb,
                max_cpus: quota.max_cpus,
                gpu_access_approved: !!quota.gpu_access_approved,
                chimera_approved: !!quota.chimera_approved,
                cerberus_approved: !!quota.cerberus_approved,
                approved_by: quota.approved_by,
                approved_at: quota.approved_at
            },
            container: {
                name: containerConfig.container_name,
                current_node: containerConfig.current_node,
                memory_gb: containerConfig.memory_gb,
                cpus: containerConfig.cpus,
                storage_gb: containerConfig.storage_gb,
                gpu_count: containerConfig.gpu_count,
                preset_tier: containerConfig.preset_tier,
                last_migration_at: containerConfig.last_migration_at
            }
        });
    } catch (error) {
        console.error('[resource-requests] Failed to get quota:', error);
        res.status(500).json({ error: 'Failed to retrieve quota' });
    }
});

/**
 * GET /my
 * Returns the user's pending and recent requests
 */
router.get('/my', async (req, res) => {
    try {
        const username = getUsername(req);
        if (!username) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const pendingRequests = await getUserPendingRequests(username);

        res.json({
            pending: pendingRequests.map(r => ({
                id: r.id,
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
            hasPendingRequest: pendingRequests.length > 0
        });
    } catch (error) {
        console.error('[resource-requests] Failed to get user requests:', error);
        res.status(500).json({ error: 'Failed to retrieve requests' });
    }
});

/**
 * POST /
 * Submit a new resource request
 */
router.post('/', async (req, res) => {
    try {
        const username = getUsername(req);
        if (!username) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const {
            target_node,
            preset_id,
            memory_gb,
            cpus,
            storage_gb,
            gpu_count = 0,
            reason
        } = req.body;

        // Validate target node
        if (!target_node || !resourceConfig.nodes[target_node]) {
            return res.status(400).json({ error: 'Invalid target node' });
        }

        // Validate preset if provided
        if (preset_id && !resourceConfig.presets[preset_id]) {
            return res.status(400).json({ error: 'Invalid preset' });
        }

        // Get preset values or use custom values
        const preset = preset_id ? resourceConfig.presets[preset_id] : null;
        const requestedMemory = memory_gb || preset?.memory_gb || resourceConfig.defaults.memory_gb;
        const requestedCpus = cpus || preset?.cpus || resourceConfig.defaults.cpus;
        const requestedStorage = storage_gb || preset?.storage_gb || resourceConfig.defaults.storage_gb;
        const requestedGpus = gpu_count || preset?.gpu_count || 0;

        // Validate against limits
        const limits = resourceConfig.limits;
        if (requestedMemory > limits.maxMemoryPerContainer) {
            return res.status(400).json({ error: `Memory cannot exceed ${limits.maxMemoryPerContainer}GB` });
        }
        if (requestedCpus > limits.maxCpusPerContainer) {
            return res.status(400).json({ error: `CPUs cannot exceed ${limits.maxCpusPerContainer}` });
        }
        if (requestedStorage > limits.maxStoragePerUser) {
            return res.status(400).json({ error: `Storage cannot exceed ${limits.maxStoragePerUser}GB` });
        }
        if (requestedGpus > limits.maxGpusPerContainer) {
            return res.status(400).json({ error: `GPUs cannot exceed ${limits.maxGpusPerContainer}` });
        }

        // Check if GPU is requested but node doesn't support it
        const nodeConfig = resourceConfig.nodes[target_node];
        if (requestedGpus > 0 && !nodeConfig.gpuEnabled) {
            return res.status(400).json({ error: `${target_node} does not support GPU allocation` });
        }

        // Check if user already has a pending request
        const existingRequests = await getUserPendingRequests(username);
        if (existingRequests.length > 0) {
            return res.status(400).json({
                error: 'You already have a pending request. Please wait for it to be reviewed or cancel it.',
                pending_request_id: existingRequests[0].id
            });
        }

        // Get current config to determine request type
        const containerConfig = await getOrCreateContainerConfig(username, `student-${username}`);
        let requestType = 'new_container';
        if (containerConfig.current_node !== target_node) {
            requestType = 'migration';
        } else if (requestedMemory !== containerConfig.memory_gb ||
                   requestedCpus !== containerConfig.cpus ||
                   requestedStorage !== containerConfig.storage_gb) {
            requestType = 'resource_upgrade';
        }

        // Check if auto-approval applies
        const requiresApproval = resourceConfig.requiresApproval(
            target_node,
            preset_id || 'conservative',
            requestedMemory,
            requestedCpus,
            requestedStorage
        );

        // Create the request
        const requestId = await createResourceRequest({
            username,
            email: req.user.email,
            target_node,
            memory_gb: requestedMemory,
            cpus: requestedCpus,
            storage_gb: requestedStorage,
            gpu_count: requestedGpus,
            preset_id,
            request_type: requestType,
            auto_approved: !requiresApproval,
            reason
        });

        // If auto-approved, update container config immediately
        if (!requiresApproval) {
            await updateContainerConfig(username, {
                memory_gb: requestedMemory,
                cpus: requestedCpus,
                storage_gb: requestedStorage,
                preset_tier: preset_id || 'conservative'
            });

            console.log(`[resource-requests] Auto-approved request ${requestId} for ${username}`);

            return res.json({
                success: true,
                request_id: requestId,
                auto_approved: true,
                message: 'Request auto-approved. Your container will use the new configuration on next restart.'
            });
        }

        // Send email notification for approval-required requests
        try {
            const emailNotifications = require('../services/email-notifications');
            await emailNotifications.sendApprovalNotification({
                id: requestId,
                username,
                email: req.user.email,
                target_node,
                requested_memory_gb: requestedMemory,
                requested_cpus: requestedCpus,
                requested_storage_gb: requestedStorage,
                requested_gpu_count: requestedGpus,
                preset_id,
                request_type: requestType,
                reason
            });
        } catch (emailError) {
            console.warn('[resource-requests] Failed to send email notification:', emailError.message);
            // Don't fail the request if email fails
        }

        console.log(`[resource-requests] Created request ${requestId} for ${username} (requires approval)`);

        res.json({
            success: true,
            request_id: requestId,
            auto_approved: false,
            message: 'Request submitted. An admin will review your request and you will be notified by email.'
        });
    } catch (error) {
        console.error('[resource-requests] Failed to create request:', error);
        res.status(500).json({ error: 'Failed to submit request' });
    }
});

/**
 * DELETE /:id
 * Cancel a pending request
 */
router.delete('/:id', async (req, res) => {
    try {
        const username = getUsername(req);
        if (!username) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { id } = req.params;
        const { getRequestById, updateRequestStatus } = require('../services/db-init');

        const request = await getRequestById(id);
        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Users can only cancel their own requests (admins can cancel any)
        if (request.username !== username && !isAdmin(req)) {
            return res.status(403).json({ error: 'Not authorized to cancel this request' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ error: 'Can only cancel pending requests' });
        }

        await updateRequestStatus(id, 'cancelled', username, 'Cancelled by user');

        res.json({
            success: true,
            message: 'Request cancelled successfully'
        });
    } catch (error) {
        console.error('[resource-requests] Failed to cancel request:', error);
        res.status(500).json({ error: 'Failed to cancel request' });
    }
});

/**
 * GET /nodes/:name/availability
 * Check if a node has capacity for a new container
 */
router.get('/nodes/:name/availability', async (req, res) => {
    try {
        const { name } = req.params;

        if (!resourceConfig.nodes[name]) {
            return res.status(404).json({ error: 'Unknown node' });
        }

        const nodeConfig = resourceConfig.nodes[name];
        const nodeStatus = await getNodeStatus(name);

        const slotsAvailable = nodeStatus
            ? nodeStatus.max_containers - nodeStatus.current_containers
            : nodeConfig.maxContainers;

        const gpuSlotsAvailable = nodeConfig.gpuEnabled && nodeStatus
            ? nodeStatus.gpu_slots_total - nodeStatus.gpu_slots_used
            : 0;

        res.json({
            node: name,
            available: nodeStatus?.is_available !== 0 && !nodeStatus?.maintenance_mode,
            maintenance_mode: !!nodeStatus?.maintenance_mode,
            container_slots: {
                available: slotsAvailable,
                total: nodeConfig.maxContainers,
                used: nodeStatus?.current_containers || 0
            },
            gpu_slots: nodeConfig.gpuEnabled ? {
                available: gpuSlotsAvailable,
                total: nodeConfig.gpuCount,
                used: nodeStatus?.gpu_slots_used || 0
            } : null,
            gpu_info: nodeConfig.gpuEnabled ? {
                model: nodeConfig.gpuModel,
                vram_per_card_gb: nodeConfig.gpuVramPerCard,
                vram_total_gb: nodeConfig.gpuVramTotal
            } : null
        });
    } catch (error) {
        console.error('[resource-requests] Failed to check node availability:', error);
        res.status(500).json({ error: 'Failed to check availability' });
    }
});

/**
 * GET /nodes/status
 * Returns real-time status and metrics for all nodes
 * Used by the resource modal for live updates
 */
router.get('/nodes/status', async (req, res) => {
    try {
        const nodeMetrics = await getNodeMetrics();
        res.json({
            nodes: nodeMetrics,
            generated_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('[resource-requests] Failed to get node status:', error);
        res.status(500).json({ error: 'Failed to retrieve node status' });
    }
});

/**
 * POST /recommend
 * Get auto-scheduling recommendation for a specific resource request
 */
router.post('/recommend', async (req, res) => {
    try {
        const username = getUsername(req);
        if (!username) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { preset_id, memory_gb, cpus, gpu_count = 0 } = req.body;

        // Get preset values if preset_id provided
        let requestedResources;
        if (preset_id && resourceConfig.presets[preset_id]) {
            const preset = resourceConfig.presets[preset_id];
            requestedResources = {
                memory_gb: memory_gb || preset.memory_gb,
                cpus: cpus || preset.cpus,
                gpu_count: gpu_count || preset.gpu_count || 0
            };
        } else {
            requestedResources = {
                memory_gb: memory_gb || resourceConfig.defaults.memory_gb,
                cpus: cpus || resourceConfig.defaults.cpus,
                gpu_count: gpu_count || 0
            };
        }

        // Get current node metrics and recommendation
        const nodeMetrics = await getNodeMetrics();
        const recommendation = recommendNode(nodeMetrics, requestedResources);

        // Get user quota to check approvals
        const quota = await getOrCreateUserQuota(username, req.user.email);

        // Add approval status to recommendation
        if (recommendation.recommended) {
            const needsApproval = recommendation.recommended !== 'hydra' ||
                requestedResources.gpu_count > 0 ||
                requestedResources.memory_gb > resourceConfig.approval.autoApproveThresholds.maxMemory_gb ||
                requestedResources.cpus > resourceConfig.approval.autoApproveThresholds.maxCpus;

            recommendation.requiresApproval = needsApproval;
            recommendation.userApproved = recommendation.recommended === 'hydra' ||
                (recommendation.recommended === 'chimera' && quota.chimera_approved) ||
                (recommendation.recommended === 'cerberus' && quota.cerberus_approved);
        }

        res.json({
            recommendation,
            requestedResources,
            nodeMetrics: {
                [recommendation.recommended]: nodeMetrics[recommendation.recommended]
            }
        });
    } catch (error) {
        console.error('[resource-requests] Failed to get recommendation:', error);
        res.status(500).json({ error: 'Failed to get recommendation' });
    }
});

module.exports = router;
