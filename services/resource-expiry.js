// services/resource-expiry.js - Checks for expired resource allocations and resets them
// Runs periodically to enforce time-limited resource grants

const {
    getExpiredConfigs,
    resetContainerConfigToDefaults
} = require('./db-init');

let checkInterval = null;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

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
                await resetContainerConfigToDefaults(config.username);
                results.push({
                    username: config.username,
                    previous_preset: config.preset_tier,
                    expired_at: config.resources_expire_at,
                    status: 'reset'
                });
                console.log(`[resource-expiry] Reset resources for ${config.username} (was ${config.preset_tier}, expired ${config.resources_expire_at})`);

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
