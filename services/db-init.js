// services/db-init.js - Database schema initialization for resource management
// Creates tables for user quotas, resource requests, and container configs

const { getDb } = require('../db');
const resourceConfig = require('../config/resources');

// SQL schema definitions
const SCHEMA = `
-- User quotas table - tracks per-user resource limits
-- Quotas persist even when containers are moved between nodes
CREATE TABLE IF NOT EXISTS user_quotas (
    username TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    storage_gb INTEGER DEFAULT 40,
    max_memory_gb INTEGER DEFAULT 4,
    max_cpus INTEGER DEFAULT 2,
    gpu_access_approved INTEGER DEFAULT 0,
    jupyter_execution_approved INTEGER DEFAULT 0,
    jenkins_execution_approved INTEGER DEFAULT 0,
    chimera_approved INTEGER DEFAULT 0,
    cerberus_approved INTEGER DEFAULT 0,
    approved_by TEXT,
    approved_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Resource requests table - tracks pending and historical requests
CREATE TABLE IF NOT EXISTS resource_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    target_node TEXT NOT NULL CHECK(target_node IN ('hydra', 'chimera', 'cerberus')),
    requested_memory_gb INTEGER NOT NULL,
    requested_cpus INTEGER NOT NULL,
    requested_storage_gb INTEGER NOT NULL,
    requested_gpu_count INTEGER DEFAULT 0,
    requested_duration_days INTEGER DEFAULT NULL,
    preset_id TEXT,
    request_type TEXT NOT NULL CHECK(request_type IN ('new_container', 'migration', 'resource_upgrade', 'jupyter_execution', 'jenkins_execution')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    auto_approved INTEGER DEFAULT 0,
    reason TEXT,
    admin_notes TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
);

-- Container configurations table - stores current container config per user
CREATE TABLE IF NOT EXISTS container_configs (
    username TEXT PRIMARY KEY,
    container_name TEXT NOT NULL,
    current_node TEXT NOT NULL DEFAULT 'hydra',
    memory_gb INTEGER NOT NULL DEFAULT 4,
    cpus INTEGER NOT NULL DEFAULT 2,
    storage_gb INTEGER NOT NULL DEFAULT 40,
    gpu_count INTEGER DEFAULT 0,
    preset_tier TEXT DEFAULT 'conservative',
    image_name TEXT NOT NULL DEFAULT 'hydra-student-container:latest',
    duration_days INTEGER DEFAULT NULL,
    resources_expire_at TEXT DEFAULT NULL,
    last_migration_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Node status tracking for availability and capacity
CREATE TABLE IF NOT EXISTS node_status (
    node_name TEXT PRIMARY KEY,
    is_available INTEGER DEFAULT 1,
    current_containers INTEGER DEFAULT 0,
    max_containers INTEGER,
    gpu_slots_used INTEGER DEFAULT 0,
    gpu_slots_total INTEGER,
    maintenance_mode INTEGER DEFAULT 0,
    last_health_check TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Security monitoring events - logs suspicious activity
CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT,
    container_name TEXT,
    event_type TEXT NOT NULL CHECK(event_type IN (
        'high_cpu', 'high_memory', 'high_network',
        'long_running_process', 'mining_detected',
        'port_scan', 'unusual_traffic', 'resource_spike',
        'process_killed', 'container_oom'
    )),
    severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
    description TEXT NOT NULL,
    metrics TEXT,
    process_info TEXT,
    action_taken TEXT CHECK(action_taken IN ('logged', 'throttled', 'terminated', 'alerted')),
    acknowledged INTEGER DEFAULT 0,
    acknowledged_by TEXT,
    acknowledged_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Migration progress tracking - real-time migration status updates
CREATE TABLE IF NOT EXISTS migration_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    current_step TEXT NOT NULL DEFAULT 'INITIATED',
    progress_percent INTEGER DEFAULT 0,
    status TEXT DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'failed')),
    error_message TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    steps_log TEXT DEFAULT '[]'
);

-- User whitelist - dynamic admin access list (supplements ADMIN_USERS env var)
CREATE TABLE IF NOT EXISTS user_whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    role TEXT DEFAULT 'admin' CHECK(role IN ('admin', 'faculty', 'ta')),
    added_by TEXT NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_requests_username ON resource_requests(username);
CREATE INDEX IF NOT EXISTS idx_requests_status ON resource_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_target_node ON resource_requests(target_node);
CREATE INDEX IF NOT EXISTS idx_requests_created ON resource_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_configs_current_node ON container_configs(current_node);
CREATE INDEX IF NOT EXISTS idx_security_username ON security_events(username);
CREATE INDEX IF NOT EXISTS idx_security_type ON security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_security_severity ON security_events(severity);
CREATE INDEX IF NOT EXISTS idx_security_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_migration_username ON migration_progress(username);
CREATE INDEX IF NOT EXISTS idx_migration_status ON migration_progress(status);
CREATE INDEX IF NOT EXISTS idx_whitelist_email ON user_whitelist(email);
`;

// Initial node data from config
const NODE_SEED_DATA = `
INSERT OR REPLACE INTO node_status (node_name, max_containers, gpu_slots_total, is_available)
VALUES
    ('hydra', 100, 0, 1),
    ('chimera', 20, 3, 1),
    ('cerberus', 10, 2, 1);
`;

/**
 * Run database migrations for existing tables
 */
async function runMigrations(db) {
    try {
        // Check if jupyter_execution_approved column exists in user_quotas
        const quotaColumns = await db.all("PRAGMA table_info(user_quotas)");
        const hasJupyterColumn = quotaColumns.some(c => c.name === 'jupyter_execution_approved');

        if (!hasJupyterColumn) {
            console.log('[db-init] Adding jupyter_execution_approved column...');
            await db.run('ALTER TABLE user_quotas ADD COLUMN jupyter_execution_approved INTEGER DEFAULT 0');
            console.log('[db-init] Migration complete: jupyter_execution_approved added');
        }

        const hasJenkinsColumn = quotaColumns.some(c => c.name === 'jenkins_execution_approved');
        if (!hasJenkinsColumn) {
            console.log('[db-init] Adding jenkins_execution_approved column...');
            await db.run('ALTER TABLE user_quotas ADD COLUMN jenkins_execution_approved INTEGER DEFAULT 0');
            console.log('[db-init] Migration complete: jenkins_execution_approved added');
        }

        // Check if duration_days and resources_expire_at columns exist in container_configs
        const configColumns = await db.all("PRAGMA table_info(container_configs)");
        const hasDurationColumn = configColumns.some(c => c.name === 'duration_days');
        const hasExpireColumn = configColumns.some(c => c.name === 'resources_expire_at');

        if (!hasDurationColumn) {
            console.log('[db-init] Adding duration_days column to container_configs...');
            await db.run('ALTER TABLE container_configs ADD COLUMN duration_days INTEGER DEFAULT NULL');
            console.log('[db-init] Migration complete: duration_days added');
        }

        if (!hasExpireColumn) {
            console.log('[db-init] Adding resources_expire_at column to container_configs...');
            await db.run('ALTER TABLE container_configs ADD COLUMN resources_expire_at TEXT DEFAULT NULL');
            console.log('[db-init] Migration complete: resources_expire_at added');
        }

        // Check if requested_duration_days column exists in resource_requests
        const requestColumns = await db.all("PRAGMA table_info(resource_requests)");
        const hasRequestDurationColumn = requestColumns.some(c => c.name === 'requested_duration_days');

        if (!hasRequestDurationColumn) {
            console.log('[db-init] Adding requested_duration_days column to resource_requests...');
            await db.run('ALTER TABLE resource_requests ADD COLUMN requested_duration_days INTEGER DEFAULT NULL');
            console.log('[db-init] Migration complete: requested_duration_days added');
        }
    } catch (error) {
        console.warn('[db-init] Migration warning:', error.message);
    }
}

/**
 * Initialize database schema
 * Creates all required tables if they don't exist
 */
async function initializeSchema() {
    const db = await getDb();

    try {
        console.log('[db-init] Initializing database schema...');

        // Execute schema creation
        await db.exec(SCHEMA);
        console.log('[db-init] Schema tables created');

        // Run migrations for existing tables
        await runMigrations(db);

        // Seed node status data
        await db.exec(NODE_SEED_DATA);
        console.log('[db-init] Node status data seeded');

        console.log('[db-init] Database initialization complete');
        return true;
    } catch (error) {
        console.error('[db-init] Failed to initialize schema:', error);
        throw error;
    }
}

/**
 * Get or create user quota
 * Creates default quota if user doesn't exist
 */
async function getOrCreateUserQuota(username, email) {
    const db = await getDb();

    // Try to get existing quota
    let quota = await db.get(
        'SELECT * FROM user_quotas WHERE username = ?',
        [username]
    );

    if (!quota) {
        // Create default quota
        const defaults = resourceConfig.defaults;
        await db.run(
            `INSERT INTO user_quotas (username, email, storage_gb, max_memory_gb, max_cpus)
             VALUES (?, ?, ?, ?, ?)`,
            [username, email, defaults.storage_gb, defaults.memory_gb, defaults.cpus]
        );

        quota = await db.get(
            'SELECT * FROM user_quotas WHERE username = ?',
            [username]
        );
        console.log(`[db-init] Created default quota for user: ${username}`);
    }

    return quota;
}

/**
 * Update user quota
 */
async function updateUserQuota(username, updates) {
    const db = await getDb();

    const fields = [];
    const values = [];

    if (updates.storage_gb !== undefined) {
        fields.push('storage_gb = ?');
        values.push(updates.storage_gb);
    }
    if (updates.max_memory_gb !== undefined) {
        fields.push('max_memory_gb = ?');
        values.push(updates.max_memory_gb);
    }
    if (updates.max_cpus !== undefined) {
        fields.push('max_cpus = ?');
        values.push(updates.max_cpus);
    }
    if (updates.gpu_access_approved !== undefined) {
        fields.push('gpu_access_approved = ?');
        values.push(updates.gpu_access_approved ? 1 : 0);
    }
    if (updates.jupyter_execution_approved !== undefined) {
        fields.push('jupyter_execution_approved = ?');
        values.push(updates.jupyter_execution_approved ? 1 : 0);
    }
    if (updates.jenkins_execution_approved !== undefined) {
        fields.push('jenkins_execution_approved = ?');
        values.push(updates.jenkins_execution_approved ? 1 : 0);
    }
    if (updates.chimera_approved !== undefined) {
        fields.push('chimera_approved = ?');
        values.push(updates.chimera_approved ? 1 : 0);
    }
    if (updates.cerberus_approved !== undefined) {
        fields.push('cerberus_approved = ?');
        values.push(updates.cerberus_approved ? 1 : 0);
    }
    if (updates.approved_by !== undefined) {
        fields.push('approved_by = ?');
        values.push(updates.approved_by);
    }
    if (updates.approved_at !== undefined) {
        fields.push('approved_at = ?');
        values.push(updates.approved_at);
    }

    fields.push("updated_at = datetime('now')");
    values.push(username);

    await db.run(
        `UPDATE user_quotas SET ${fields.join(', ')} WHERE username = ?`,
        values
    );
}

/**
 * Create a resource request
 */
async function createResourceRequest(request) {
    const db = await getDb();

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + resourceConfig.approval.requestExpiryDays);

    const result = await db.run(
        `INSERT INTO resource_requests
         (username, email, target_node, requested_memory_gb, requested_cpus,
          requested_storage_gb, requested_gpu_count, requested_duration_days,
          preset_id, request_type, auto_approved, reason, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            request.username,
            request.email,
            request.target_node,
            request.memory_gb,
            request.cpus,
            request.storage_gb,
            request.gpu_count || 0,
            request.duration_days || null,
            request.preset_id || null,
            request.request_type,
            request.auto_approved ? 1 : 0,
            request.reason || null,
            expiresAt.toISOString()
        ]
    );

    return result.lastID;
}

/**
 * Get pending requests for a user
 */
async function getUserPendingRequests(username) {
    const db = await getDb();
    return db.all(
        `SELECT * FROM resource_requests
         WHERE username = ? AND status = 'pending'
         ORDER BY created_at DESC`,
        [username]
    );
}

/**
 * Get all pending requests (for admin)
 */
async function getAllPendingRequests() {
    const db = await getDb();
    return db.all(
        `SELECT * FROM resource_requests
         WHERE status = 'pending'
         ORDER BY created_at ASC`
    );
}

/**
 * Update request status (approve/deny)
 */
async function updateRequestStatus(requestId, status, reviewedBy, adminNotes = null) {
    const db = await getDb();
    await db.run(
        `UPDATE resource_requests
         SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), admin_notes = ?
         WHERE id = ?`,
        [status, reviewedBy, adminNotes, requestId]
    );
}

/**
 * Get request by ID
 */
async function getRequestById(requestId) {
    const db = await getDb();
    return db.get('SELECT * FROM resource_requests WHERE id = ?', [requestId]);
}

/**
 * Get or create container config
 */
async function getOrCreateContainerConfig(username, containerName) {
    const db = await getDb();

    let config = await db.get(
        'SELECT * FROM container_configs WHERE username = ?',
        [username]
    );

    if (!config) {
        const defaults = resourceConfig.defaults;
        await db.run(
            `INSERT INTO container_configs
             (username, container_name, current_node, memory_gb, cpus, storage_gb, preset_tier, image_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, containerName, defaults.node, defaults.memory_gb, defaults.cpus,
             defaults.storage_gb, defaults.preset, defaults.image]
        );

        config = await db.get(
            'SELECT * FROM container_configs WHERE username = ?',
            [username]
        );
    }

    return config;
}

/**
 * Update container config
 */
async function updateContainerConfig(username, updates) {
    const db = await getDb();

    const fields = [];
    const values = [];

    if (updates.current_node !== undefined) {
        fields.push('current_node = ?');
        values.push(updates.current_node);
    }
    if (updates.memory_gb !== undefined) {
        fields.push('memory_gb = ?');
        values.push(updates.memory_gb);
    }
    if (updates.cpus !== undefined) {
        fields.push('cpus = ?');
        values.push(updates.cpus);
    }
    if (updates.storage_gb !== undefined) {
        fields.push('storage_gb = ?');
        values.push(updates.storage_gb);
    }
    if (updates.gpu_count !== undefined) {
        fields.push('gpu_count = ?');
        values.push(updates.gpu_count);
    }
    if (updates.preset_tier !== undefined) {
        fields.push('preset_tier = ?');
        values.push(updates.preset_tier);
    }
    if (updates.image_name !== undefined) {
        fields.push('image_name = ?');
        values.push(updates.image_name);
    }
    if (updates.last_migration_at !== undefined) {
        fields.push('last_migration_at = ?');
        values.push(updates.last_migration_at);
    }
    if (updates.duration_days !== undefined) {
        fields.push('duration_days = ?');
        values.push(updates.duration_days);
    }
    if (updates.resources_expire_at !== undefined) {
        fields.push('resources_expire_at = ?');
        values.push(updates.resources_expire_at);
    }

    fields.push("updated_at = datetime('now')");
    values.push(username);

    await db.run(
        `UPDATE container_configs SET ${fields.join(', ')} WHERE username = ?`,
        values
    );
}

/**
 * Get expired resource configurations
 */
async function getExpiredConfigs() {
    const db = await getDb();
    return db.all(
        `SELECT * FROM container_configs
         WHERE resources_expire_at IS NOT NULL
         AND resources_expire_at < datetime('now')
         AND preset_tier != 'minimal'`
    );
}

/**
 * Reset container config to defaults (when resources expire)
 */
async function resetContainerConfigToDefaults(username) {
    const db = await getDb();
    const defaults = resourceConfig.defaults;

    await db.run(
        `UPDATE container_configs
         SET memory_gb = ?, cpus = ?, storage_gb = ?, gpu_count = 0,
             preset_tier = ?, duration_days = NULL, resources_expire_at = NULL,
             current_node = 'hydra', updated_at = datetime('now')
         WHERE username = ?`,
        [defaults.memory_gb, defaults.cpus, defaults.storage_gb, defaults.preset, username]
    );

    console.log(`[db-init] Reset container config to defaults for user: ${username}`);
}

/**
 * Get node status
 */
async function getNodeStatus(nodeName) {
    const db = await getDb();
    return db.get('SELECT * FROM node_status WHERE node_name = ?', [nodeName]);
}

/**
 * Update node status
 */
async function updateNodeStatus(nodeName, updates) {
    const db = await getDb();

    const fields = [];
    const values = [];

    if (updates.is_available !== undefined) {
        fields.push('is_available = ?');
        values.push(updates.is_available ? 1 : 0);
    }
    if (updates.current_containers !== undefined) {
        fields.push('current_containers = ?');
        values.push(updates.current_containers);
    }
    if (updates.gpu_slots_used !== undefined) {
        fields.push('gpu_slots_used = ?');
        values.push(updates.gpu_slots_used);
    }
    if (updates.maintenance_mode !== undefined) {
        fields.push('maintenance_mode = ?');
        values.push(updates.maintenance_mode ? 1 : 0);
    }
    if (updates.last_health_check !== undefined) {
        fields.push('last_health_check = ?');
        values.push(updates.last_health_check);
    }

    fields.push("updated_at = datetime('now')");
    values.push(nodeName);

    await db.run(
        `UPDATE node_status SET ${fields.join(', ')} WHERE node_name = ?`,
        values
    );
}

/**
 * Get all user quotas (for admin)
 */
async function getAllUserQuotas() {
    const db = await getDb();
    return db.all('SELECT * FROM user_quotas ORDER BY username');
}

/**
 * Expire old pending requests
 */
async function expireOldRequests() {
    const db = await getDb();
    const result = await db.run(
        `UPDATE resource_requests
         SET status = 'expired'
         WHERE status = 'pending' AND expires_at < datetime('now')`
    );

    if (result.changes > 0) {
        console.log(`[db-init] Expired ${result.changes} old resource requests`);
    }

    return result.changes;
}

// ==================== Security Events ====================

/**
 * Log a security event
 */
async function logSecurityEvent(event) {
    const db = await getDb();

    const result = await db.run(
        `INSERT INTO security_events
         (username, email, container_name, event_type, severity, description, metrics, process_info, action_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            event.username,
            event.email || null,
            event.container_name || null,
            event.event_type,
            event.severity,
            event.description,
            event.metrics ? JSON.stringify(event.metrics) : null,
            event.process_info ? JSON.stringify(event.process_info) : null,
            event.action_taken || 'logged'
        ]
    );

    console.log(`[security] ${event.severity.toUpperCase()}: ${event.event_type} for ${event.username} - ${event.description}`);
    return result.lastID;
}

/**
 * Get recent security events (for admin dashboard)
 */
async function getSecurityEvents(options = {}) {
    const db = await getDb();
    const { limit = 100, severity, event_type, username, hours = 24 } = options;

    let query = `SELECT * FROM security_events WHERE created_at > datetime('now', '-${hours} hours')`;
    const params = [];

    if (severity) {
        query += ' AND severity = ?';
        params.push(severity);
    }
    if (event_type) {
        query += ' AND event_type = ?';
        params.push(event_type);
    }
    if (username) {
        query += ' AND username = ?';
        params.push(username);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return db.all(query, params);
}

/**
 * Get security events summary (for admin dashboard)
 */
async function getSecuritySummary(hours = 24) {
    const db = await getDb();

    const summary = await db.get(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
            SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warnings,
            SUM(CASE WHEN severity = 'info' THEN 1 ELSE 0 END) as info,
            SUM(CASE WHEN acknowledged = 0 THEN 1 ELSE 0 END) as unacknowledged
        FROM security_events
        WHERE created_at > datetime('now', '-${hours} hours')
    `);

    const byType = await db.all(`
        SELECT event_type, COUNT(*) as count
        FROM security_events
        WHERE created_at > datetime('now', '-${hours} hours')
        GROUP BY event_type
        ORDER BY count DESC
    `);

    const topUsers = await db.all(`
        SELECT username, COUNT(*) as event_count
        FROM security_events
        WHERE created_at > datetime('now', '-${hours} hours')
        GROUP BY username
        ORDER BY event_count DESC
        LIMIT 10
    `);

    return { summary, byType, topUsers };
}

/**
 * Acknowledge a security event
 */
async function acknowledgeSecurityEvent(eventId, acknowledgedBy) {
    const db = await getDb();
    await db.run(
        `UPDATE security_events
         SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime('now')
         WHERE id = ?`,
        [acknowledgedBy, eventId]
    );
}

// ==================== User Whitelist ====================

/**
 * Get all whitelisted users
 */
async function getWhitelist() {
    const db = await getDb();
    return db.all('SELECT * FROM user_whitelist ORDER BY created_at DESC');
}

/**
 * Check if email is whitelisted
 */
async function isWhitelisted(email) {
    const db = await getDb();
    const row = await db.get('SELECT * FROM user_whitelist WHERE email = ?', [email.toLowerCase()]);
    return !!row;
}

/**
 * Add user to whitelist
 */
async function addToWhitelist(email, addedBy, role = 'admin', reason = null) {
    const db = await getDb();
    const username = email.split('@')[0];
    await db.run(
        `INSERT OR REPLACE INTO user_whitelist (email, username, role, added_by, reason, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [email.toLowerCase(), username, role, addedBy, reason]
    );
    console.log(`[whitelist] Added ${email} as ${role} by ${addedBy}`);
}

/**
 * Remove user from whitelist
 */
async function removeFromWhitelist(email) {
    const db = await getDb();
    const result = await db.run('DELETE FROM user_whitelist WHERE email = ?', [email.toLowerCase()]);
    if (result.changes > 0) {
        console.log(`[whitelist] Removed ${email} from whitelist`);
    }
    return result.changes > 0;
}

/**
 * Update whitelist entry
 */
async function updateWhitelistEntry(email, updates) {
    const db = await getDb();
    const fields = [];
    const values = [];

    if (updates.role !== undefined) {
        fields.push('role = ?');
        values.push(updates.role);
    }
    if (updates.reason !== undefined) {
        fields.push('reason = ?');
        values.push(updates.reason);
    }

    if (fields.length === 0) return false;

    values.push(email.toLowerCase());
    await db.run(
        `UPDATE user_whitelist SET ${fields.join(', ')} WHERE email = ?`,
        values
    );
    return true;
}

module.exports = {
    initializeSchema,
    getOrCreateUserQuota,
    updateUserQuota,
    createResourceRequest,
    getUserPendingRequests,
    getAllPendingRequests,
    updateRequestStatus,
    getRequestById,
    getOrCreateContainerConfig,
    updateContainerConfig,
    getExpiredConfigs,
    resetContainerConfigToDefaults,
    getNodeStatus,
    updateNodeStatus,
    getAllUserQuotas,
    expireOldRequests,
    // Security monitoring
    logSecurityEvent,
    getSecurityEvents,
    getSecuritySummary,
    acknowledgeSecurityEvent,
    // Whitelist management
    getWhitelist,
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    updateWhitelistEntry
};
