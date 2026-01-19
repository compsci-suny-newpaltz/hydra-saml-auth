// services/container-migration.js - Container migration between cluster nodes
// Handles moving containers between Hydra, Chimera, and Cerberus with data preservation
// Uses Kubernetes APIs when running in RKE2 cluster, falls back to Docker for standalone

const Docker = require('dockerode');
const path = require('path');
const resourceConfig = require('../config/resources');
const runtimeConfig = require('../config/runtime');

// Check if we should use Kubernetes for migrations
function useK8sMigration() {
  return runtimeConfig.k8s?.enabled === true;
}

// Migration staging path for NFS
const NFS_STAGING_PATH = process.env.NFS_STAGING_PATH || '/mnt/hydra-nfs/migrations';
const MIGRATION_TIMEOUT_MS = resourceConfig.migration?.timeoutMs || 300000; // 5 minutes

/**
 * Get Docker client for a specific node
 */
function getDockerClient(nodeName) {
    const nodeConfig = resourceConfig.nodes[nodeName];
    if (!nodeConfig) {
        throw new Error(`Unknown node: ${nodeName}`);
    }

    if (nodeName === 'hydra') {
        return new Docker({ socketPath: '/var/run/docker.sock' });
    }

    // Remote nodes use TCP
    return new Docker({ host: nodeConfig.host, port: 2376 });
}

/**
 * Get container info from a node
 */
async function getContainerInfo(docker, containerName) {
    try {
        const container = docker.getContainer(containerName);
        return await container.inspect();
    } catch (error) {
        if (error.statusCode === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Stop container if running
 */
async function stopContainerSafe(docker, containerName) {
    try {
        const container = docker.getContainer(containerName);
        const info = await container.inspect();
        if (info.State.Running) {
            console.log(`[migration] Stopping container ${containerName}...`);
            await container.stop({ t: 30 });
        }
    } catch (error) {
        if (error.statusCode !== 404) {
            console.warn(`[migration] Warning stopping container: ${error.message}`);
        }
    }
}

/**
 * Remove container from a node
 */
async function removeContainerSafe(docker, containerName) {
    try {
        const container = docker.getContainer(containerName);
        await container.remove({ force: true });
        console.log(`[migration] Removed container ${containerName}`);
    } catch (error) {
        if (error.statusCode !== 404) {
            console.warn(`[migration] Warning removing container: ${error.message}`);
        }
    }
}

/**
 * Export volume data to NFS staging
 */
async function exportVolumeToNFS(docker, volumeName, username) {
    const stagingPath = path.join(NFS_STAGING_PATH, username);

    console.log(`[migration] Exporting volume ${volumeName} to ${stagingPath}...`);

    // Create a temporary container to copy data
    const container = await docker.createContainer({
        Image: 'alpine:latest',
        Cmd: ['sh', '-c', `mkdir -p /staging && cp -a /source/. /staging/`],
        HostConfig: {
            Binds: [
                `${volumeName}:/source:ro`,
                `${stagingPath}:/staging`
            ],
            AutoRemove: true
        }
    });

    await container.start();

    // Wait for completion with timeout
    const startTime = Date.now();
    while (Date.now() - startTime < MIGRATION_TIMEOUT_MS) {
        try {
            const info = await container.inspect();
            if (!info.State.Running) {
                if (info.State.ExitCode !== 0) {
                    throw new Error(`Export failed with exit code ${info.State.ExitCode}`);
                }
                console.log(`[migration] Volume exported successfully`);
                return true;
            }
        } catch (error) {
            if (error.statusCode === 404) {
                // Container auto-removed, assume success
                console.log(`[migration] Volume export completed`);
                return true;
            }
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Volume export timed out');
}

/**
 * Import volume data from NFS staging
 */
async function importVolumeFromNFS(docker, volumeName, username) {
    const stagingPath = path.join(NFS_STAGING_PATH, username);

    console.log(`[migration] Importing volume ${volumeName} from ${stagingPath}...`);

    // Ensure volume exists
    try {
        await docker.createVolume({ Name: volumeName });
    } catch (error) {
        // Volume may already exist
        if (!error.message.includes('already exists')) {
            console.warn(`[migration] Volume creation warning: ${error.message}`);
        }
    }

    // Create a temporary container to copy data
    const container = await docker.createContainer({
        Image: 'alpine:latest',
        Cmd: ['sh', '-c', `cp -a /staging/. /target/`],
        HostConfig: {
            Binds: [
                `${stagingPath}:/staging:ro`,
                `${volumeName}:/target`
            ],
            AutoRemove: true
        }
    });

    await container.start();

    // Wait for completion with timeout
    const startTime = Date.now();
    while (Date.now() - startTime < MIGRATION_TIMEOUT_MS) {
        try {
            const info = await container.inspect();
            if (!info.State.Running) {
                if (info.State.ExitCode !== 0) {
                    throw new Error(`Import failed with exit code ${info.State.ExitCode}`);
                }
                console.log(`[migration] Volume imported successfully`);
                return true;
            }
        } catch (error) {
            if (error.statusCode === 404) {
                // Container auto-removed, assume success
                console.log(`[migration] Volume import completed`);
                return true;
            }
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Volume import timed out');
}

/**
 * Create container on target node
 */
async function createContainerOnNode(docker, containerName, volumeName, nodeConfig, containerConfig) {
    console.log(`[migration] Creating container ${containerName} on ${nodeConfig.label}...`);

    const createOptions = {
        name: containerName,
        Image: nodeConfig.defaultImage,
        Labels: {
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': containerConfig.username,
            'hydra.ownerEmail': containerConfig.email,
            'hydra.node': nodeConfig.role
        },
        HostConfig: {
            Binds: [`${volumeName}:/home/coder`],
            Memory: containerConfig.memory_gb * 1024 * 1024 * 1024,
            NanoCPUs: containerConfig.cpus * 1e9,
            RestartPolicy: { Name: 'unless-stopped' },
            NetworkMode: nodeConfig.network
        }
    };

    // Add GPU runtime if this is a GPU node
    if (nodeConfig.gpuEnabled && containerConfig.gpu_count > 0) {
        createOptions.HostConfig.Runtime = 'nvidia';
        createOptions.HostConfig.DeviceRequests = [{
            Driver: 'nvidia',
            Count: containerConfig.gpu_count,
            Capabilities: [['gpu']]
        }];
    }

    const container = await docker.createContainer(createOptions);
    console.log(`[migration] Container created: ${container.id}`);

    return container;
}

/**
 * Migrate a container from one node to another
 * Uses Kubernetes when running in RKE2 cluster, Docker API for standalone
 */
async function migrateContainer(username, fromNode, toNode, newConfig = {}) {
    // Use Kubernetes migration when in cluster mode (production RKE2)
    if (useK8sMigration()) {
        console.log(`[migration] Using Kubernetes migration (RKE2 mode)`);
        const k8sMigration = require('./k8s-container-migration');
        return await k8sMigration.migrateContainer(username, fromNode, toNode, newConfig);
    }

    // Fallback to Docker API for standalone mode
    console.log(`[migration] Using Docker migration (standalone mode)`);
    console.log(`[migration] Starting migration for ${username}: ${fromNode} -> ${toNode}`);

    const containerName = `student-${username}`;
    const volumeName = `hydra-vol-${username}`;

    const fromNodeConfig = resourceConfig.nodes[fromNode];
    const toNodeConfig = resourceConfig.nodes[toNode];

    if (!fromNodeConfig || !toNodeConfig) {
        throw new Error('Invalid node configuration');
    }

    const fromDocker = getDockerClient(fromNode);
    const toDocker = getDockerClient(toNode);

    try {
        // Step 1: Check source container exists
        const sourceInfo = await getContainerInfo(fromDocker, containerName);
        if (!sourceInfo) {
            throw new Error(`Container ${containerName} not found on ${fromNode}`);
        }

        const containerConfig = {
            username,
            email: sourceInfo.Config.Labels['hydra.ownerEmail'],
            memory_gb: Math.round(sourceInfo.HostConfig.Memory / (1024 * 1024 * 1024)),
            cpus: Math.round(sourceInfo.HostConfig.NanoCPUs / 1e9),
            gpu_count: sourceInfo.HostConfig.DeviceRequests?.[0]?.Count || 0
        };

        // Step 2: Stop source container
        await stopContainerSafe(fromDocker, containerName);

        // Step 3: Export volume to NFS staging
        await exportVolumeToNFS(fromDocker, volumeName, username);

        // Step 4: Import volume on target node
        await importVolumeFromNFS(toDocker, volumeName, username);

        // Step 5: Create container on target node
        const newContainer = await createContainerOnNode(
            toDocker,
            containerName,
            volumeName,
            toNodeConfig,
            containerConfig
        );

        // Step 6: Start new container
        await newContainer.start();
        console.log(`[migration] Container started on ${toNode}`);

        // Step 7: Remove source container (keep volume as backup temporarily)
        await removeContainerSafe(fromDocker, containerName);

        // Send migration complete email
        try {
            const emailNotifications = require('./email-notifications');
            await emailNotifications.sendMigrationComplete(
                username,
                containerConfig.email,
                fromNode,
                toNode,
                true
            );
        } catch (emailError) {
            console.warn(`[migration] Failed to send notification: ${emailError.message}`);
        }

        console.log(`[migration] Migration complete for ${username}`);

        return {
            success: true,
            message: `Container migrated from ${fromNode} to ${toNode}`,
            containerId: newContainer.id
        };
    } catch (error) {
        console.error(`[migration] Migration failed for ${username}:`, error);

        // Try to send failure notification
        try {
            const { getOrCreateContainerConfig } = require('./db-init');
            const config = await getOrCreateContainerConfig(username, containerName);
            const emailNotifications = require('./email-notifications');
            await emailNotifications.sendMigrationComplete(
                username,
                config.email || `${username}@newpaltz.edu`,
                fromNode,
                toNode,
                false
            );
        } catch (emailError) {
            console.warn(`[migration] Failed to send failure notification: ${emailError.message}`);
        }

        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Cleanup old migration staging data
 */
async function cleanupStagingData(username) {
    const stagingPath = path.join(NFS_STAGING_PATH, username);
    console.log(`[migration] Cleaning up staging data at ${stagingPath}`);

    // Use local Docker to run cleanup
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });

    try {
        const container = await docker.createContainer({
            Image: 'alpine:latest',
            Cmd: ['rm', '-rf', '/staging'],
            HostConfig: {
                Binds: [`${stagingPath}:/staging`],
                AutoRemove: true
            }
        });

        await container.start();
        await container.wait();
        console.log(`[migration] Staging data cleaned up`);
        return true;
    } catch (error) {
        console.warn(`[migration] Cleanup warning: ${error.message}`);
        return false;
    }
}

/**
 * Check if a node is reachable
 * Uses Kubernetes when in cluster mode, Docker API for standalone
 */
async function checkNodeHealth(nodeName) {
    // Use Kubernetes health check when in cluster mode
    if (useK8sMigration()) {
        const k8sMigration = require('./k8s-container-migration');
        return await k8sMigration.checkNodeHealth(nodeName);
    }

    // Fallback to Docker API for standalone mode
    try {
        const docker = getDockerClient(nodeName);
        const info = await docker.info();
        return {
            reachable: true,
            containers: info.ContainersRunning,
            images: info.Images
        };
    } catch (error) {
        return {
            reachable: false,
            error: error.message
        };
    }
}

module.exports = {
    migrateContainer,
    cleanupStagingData,
    checkNodeHealth,
    getDockerClient
};
