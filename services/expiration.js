/**
 * Container expiration service.
 * Checks for expired containers and sends warning emails.
 * Can be run as a cron job or via n8n workflow.
 */

const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Warning thresholds in days
const WARNING_THRESHOLDS = [7, 3, 1];

/**
 * Get all managed student containers
 */
async function getManagedContainers() {
    const containers = await docker.listContainers({
        all: true,
        filters: { label: ['hydra.managed_by=hydra-saml-auth'] }
    });

    return containers;
}

/**
 * Parse container labels to get expiration info
 */
function getExpirationInfo(container) {
    const labels = container.Labels || {};
    const expiresAt = labels['hydra.expires_at'];
    const owner = labels['hydra.owner'];
    const ownerEmail = labels['hydra.ownerEmail'];
    const renewalCount = parseInt(labels['hydra.renewal_count'] || '0', 10);

    if (!expiresAt) {
        return null;
    }

    const expDate = new Date(expiresAt);
    const now = new Date();
    const daysUntilExpiration = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));

    return {
        containerName: container.Names[0].replace(/^\//, ''),
        containerId: container.Id,
        owner,
        ownerEmail,
        expiresAt: expDate,
        daysUntilExpiration,
        isExpired: daysUntilExpiration <= 0,
        renewalCount,
        state: container.State
    };
}

/**
 * Check all containers for expiration
 */
async function checkExpirations() {
    const containers = await getManagedContainers();
    const results = {
        expired: [],
        warning7: [],
        warning3: [],
        warning1: [],
        ok: []
    };

    for (const container of containers) {
        const info = getExpirationInfo(container);
        if (!info) continue;

        if (info.isExpired) {
            results.expired.push(info);
        } else if (info.daysUntilExpiration <= 1) {
            results.warning1.push(info);
        } else if (info.daysUntilExpiration <= 3) {
            results.warning3.push(info);
        } else if (info.daysUntilExpiration <= 7) {
            results.warning7.push(info);
        } else {
            results.ok.push(info);
        }
    }

    return results;
}

/**
 * Stop expired containers (does not delete)
 */
async function stopExpiredContainers() {
    const { expired } = await checkExpirations();
    const stopped = [];

    for (const info of expired) {
        if (info.state === 'running') {
            try {
                const container = docker.getContainer(info.containerId);
                await container.stop({ t: 30 });
                stopped.push(info);
                console.log(`[expiration] Stopped expired container: ${info.containerName}`);
            } catch (err) {
                console.error(`[expiration] Failed to stop ${info.containerName}:`, err.message);
            }
        }
    }

    return stopped;
}

/**
 * Generate warning email content
 */
function generateWarningEmail(info, daysThreshold) {
    const subject = daysThreshold === 1
        ? `[URGENT] Your container expires tomorrow`
        : `Your container expires in ${daysThreshold} days`;

    const body = `
Hello ${info.owner},

Your student container "${info.containerName}" will expire on ${info.expiresAt.toLocaleDateString()}.

${daysThreshold === 1 ? 'IMPORTANT: Your container will be stopped tomorrow if not renewed!' : ''}

To renew your container:
1. Log in to the Student Dashboard at https://hydra.newpaltz.edu/dashboard
2. Click the "Renew" button on your container

If you no longer need this container, no action is needed. The container will be stopped (not deleted) after expiration.

- Hydra Student Containers
`;

    return { subject, body, to: info.ownerEmail };
}

/**
 * Get containers that need warning emails today
 * Only sends one warning per threshold
 */
async function getContainersNeedingWarnings() {
    const results = await checkExpirations();
    const warnings = [];

    // 7-day warning
    for (const info of results.warning7) {
        if (info.daysUntilExpiration === 7) {
            warnings.push({ info, threshold: 7 });
        }
    }

    // 3-day warning
    for (const info of results.warning3) {
        if (info.daysUntilExpiration === 3) {
            warnings.push({ info, threshold: 3 });
        }
    }

    // 1-day warning
    for (const info of results.warning1) {
        if (info.daysUntilExpiration === 1) {
            warnings.push({ info, threshold: 1 });
        }
    }

    return warnings;
}

/**
 * Run the full expiration check routine
 * Returns report for logging/n8n
 */
async function runExpirationCheck() {
    console.log('[expiration] Starting expiration check...');

    const results = await checkExpirations();
    const warnings = await getContainersNeedingWarnings();
    const stopped = await stopExpiredContainers();

    const report = {
        timestamp: new Date().toISOString(),
        summary: {
            total: results.expired.length + results.warning7.length + results.warning3.length + results.warning1.length + results.ok.length,
            expired: results.expired.length,
            expiringWithin7Days: results.warning7.length + results.warning3.length + results.warning1.length,
            healthy: results.ok.length
        },
        stopped: stopped.map(c => c.containerName),
        warningsToSend: warnings.map(w => ({
            container: w.info.containerName,
            owner: w.info.ownerEmail,
            threshold: w.threshold,
            expiresAt: w.info.expiresAt.toISOString()
        })),
        expired: results.expired.map(c => ({
            container: c.containerName,
            owner: c.ownerEmail,
            expiredAt: c.expiresAt.toISOString()
        }))
    };

    console.log('[expiration] Check complete:', JSON.stringify(report.summary));
    return report;
}

// Export for use in routes or n8n webhook
module.exports = {
    checkExpirations,
    stopExpiredContainers,
    getContainersNeedingWarnings,
    generateWarningEmail,
    runExpirationCheck,
    getManagedContainers,
    getExpirationInfo
};

// Run directly if executed as script
if (require.main === module) {
    runExpirationCheck()
        .then(report => {
            console.log(JSON.stringify(report, null, 2));
            process.exit(0);
        })
        .catch(err => {
            console.error('Expiration check failed:', err);
            process.exit(1);
        });
}
