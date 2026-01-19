// services/resource-expiry.js - Checks for expired resource allocations and resets them
// Runs periodically to enforce time-limited resource grants

const {
    getExpiredConfigs,
    resetContainerConfigToDefaults
} = require('./db-init');

let Docker;
try {
    Docker = require('dockerode');
} catch (e) {
    console.warn('[resource-expiry] Dockerode not available, container restart disabled');
}

let checkInterval = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

/**
 * Restart a user's container to apply new resource limits
 */
async function restartUserContainer(username) {
    if (!Docker) return { restarted: false, reason: 'Docker not available' };

    try {
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        const containerName = `student-${username}`;
        const container = docker.getContainer(containerName);

        // Check if container exists and is running
        const info = await container.inspect().catch(() => null);
        if (!info) {
            return { restarted: false, reason: 'Container not found' };
        }

        if (info.State.Running) {
            console.log(`[resource-expiry] Restarting container ${containerName} to apply changes...`);
            await container.restart({ t: 10 }); // 10 second timeout
            return { restarted: true };
        } else {
            return { restarted: false, reason: 'Container not running' };
        }
    } catch (error) {
        console.error(`[resource-expiry] Failed to restart container for ${username}:`, error.message);
        return { restarted: false, reason: error.message };
    }
}

/**
 * Check for expired resource configurations and reset them to defaults
 */
async function checkExpiredResources() {
    try {
        const expiredConfigs = await getExpiredConfigs();

        if (expiredConfigs.length === 0) {
            return { checked: true, expired: 0 };
        }

        console.log(`[resource-expiry] Found ${expiredConfigs.length} expired resource configuration(s)`);

        const results = [];
        for (const config of expiredConfigs) {
            try {
                // Reset config to defaults (moves back to Hydra)
                await resetContainerConfigToDefaults(config.username);

                console.log(`[resource-expiry] Reset resources for ${config.username} (was ${config.preset_tier} on ${config.current_node}, expired ${config.resources_expire_at})`);

                // Restart the container to apply changes
                const restartResult = await restartUserContainer(config.username);

                results.push({
                    username: config.username,
                    previous_preset: config.preset_tier,
                    previous_node: config.current_node,
                    expired_at: config.resources_expire_at,
                    status: 'reset',
                    container_restarted: restartResult.restarted,
                    restart_reason: restartResult.reason
                });

                if (restartResult.restarted) {
                    console.log(`[resource-expiry] Container restarted for ${config.username}`);
                }

                // TODO: Send notification email to user about resource expiry
                // try {
                //     const emailNotifications = require('./email-notifications');
                //     await emailNotifications.sendResourceExpiryNotification(config);
                // } catch (emailError) {
                //     console.warn(`[resource-expiry] Failed to send expiry notification to ${config.username}:`, emailError.message);
                // }
            } catch (error) {
                console.error(`[resource-expiry] Failed to reset ${config.username}:`, error.message);
                results.push({
                    username: config.username,
                    status: 'error',
                    error: error.message
                });
            }
        }

        return {
            checked: true,
            expired: expiredConfigs.length,
            results
        };
    } catch (error) {
        console.error('[resource-expiry] Check failed:', error);
        return { checked: false, error: error.message };
    }
}

/**
 * Start the periodic expiry checker
 */
function start() {
    if (checkInterval) {
        console.warn('[resource-expiry] Already running');
        return;
    }

    console.log('[resource-expiry] Starting resource expiry checker (interval: 1 hour)');

    // Run immediately on startup
    checkExpiredResources().then(result => {
        if (result.expired > 0) {
            console.log(`[resource-expiry] Initial check: reset ${result.expired} expired configuration(s)`);
        }
    });

    // Then run periodically
    checkInterval = setInterval(checkExpiredResources, CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic expiry checker
 */
function stop() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
        console.log('[resource-expiry] Stopped');
    }
}

/**
 * Manually trigger an expiry check (for admin use)
 */
async function triggerCheck() {
    return checkExpiredResources();
}

module.exports = {
    start,
    stop,
    triggerCheck,
    checkExpiredResources
};
