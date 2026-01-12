// services/activity-logger.js - Activity logging service with size limits and yearly archival
// Logs all user activities to SQLite with 100MB per user limit

const { getDb } = require('../db');
const { v4: uuidv4 } = require('uuid');

// 100MB per user limit
const MAX_LOG_SIZE_BYTES = 100 * 1024 * 1024;
const ARCHIVE_THRESHOLD_PERCENT = 0.8; // Archive when at 80%
const CLEANUP_BATCH_SIZE = 1000;

// Event emitter for real-time streaming
const EventEmitter = require('events');
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100); // Support many concurrent SSE connections

/**
 * Log an activity entry
 * @param {Object} entry - Log entry data
 * @param {string} entry.username - User's username
 * @param {string} entry.email - User's email
 * @param {string} entry.category - Log category (container, service, route, auth, resource, account, system, error)
 * @param {string} entry.action - Action performed
 * @param {string} [entry.target] - Target of the action
 * @param {Object} [entry.details] - Additional JSON details
 * @param {string} [entry.ip_address] - Client IP
 * @param {string} [entry.user_agent] - Client user agent
 * @param {boolean} [entry.success=true] - Whether action succeeded
 * @param {string} [entry.error_message] - Error message if failed
 * @param {number} [entry.duration_ms] - Duration in milliseconds
 * @param {string} [entry.session_id] - Session ID
 */
async function logActivity(entry) {
    const db = await getDb();
    const requestId = uuidv4();

    try {
        // Check if user is approaching size limit
        const stats = await getUserLogStats(entry.username);
        if (stats && stats.total_size_bytes >= MAX_LOG_SIZE_BYTES * ARCHIVE_THRESHOLD_PERCENT) {
            // Archive oldest 20% of logs
            await archiveOldLogs(entry.username, 0.2);
        }

        // Estimate entry size (rough estimate)
        const detailsStr = entry.details ? JSON.stringify(entry.details) : null;
        const entrySize = estimateLogSize(entry, detailsStr);

        // Insert log entry
        await db.run(
            `INSERT INTO activity_logs
             (username, email, category, action, target, details, ip_address, user_agent,
              success, error_message, duration_ms, session_id, request_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                entry.username,
                entry.email,
                entry.category,
                entry.action,
                entry.target || null,
                detailsStr,
                entry.ip_address || null,
                entry.user_agent || null,
                entry.success !== false ? 1 : 0,
                entry.error_message || null,
                entry.duration_ms || null,
                entry.session_id || null,
                requestId
            ]
        );

        // Update user stats
        await updateUserLogStats(entry.username, entrySize);

        // Emit for real-time streaming
        const logEntry = {
            id: requestId,
            username: entry.username,
            timestamp: new Date().toISOString(),
            category: entry.category,
            action: entry.action,
            target: entry.target,
            success: entry.success !== false,
        };

        logEmitter.emit('log', logEntry);
        logEmitter.emit(`log:${entry.username}`, logEntry);

        return requestId;
    } catch (error) {
        console.error('[activity-logger] Failed to log activity:', error);
        throw error;
    }
}

/**
 * Estimate log entry size in bytes
 */
function estimateLogSize(entry, detailsStr) {
    let size = 0;
    size += (entry.username || '').length;
    size += (entry.email || '').length;
    size += (entry.category || '').length;
    size += (entry.action || '').length;
    size += (entry.target || '').length;
    size += (detailsStr || '').length;
    size += (entry.ip_address || '').length;
    size += (entry.user_agent || '').length;
    size += (entry.error_message || '').length;
    size += 100; // overhead for other fields
    return size;
}

/**
 * Get user log stats
 */
async function getUserLogStats(username) {
    const db = await getDb();
    return db.get('SELECT * FROM user_log_stats WHERE username = ?', [username]);
}

/**
 * Update user log stats after adding an entry
 */
async function updateUserLogStats(username, entrySize) {
    const db = await getDb();

    const existing = await getUserLogStats(username);
    const now = new Date().toISOString();

    if (existing) {
        await db.run(
            `UPDATE user_log_stats SET
             total_entries = total_entries + 1,
             total_size_bytes = total_size_bytes + ?,
             newest_entry_at = ?
             WHERE username = ?`,
            [entrySize, now, username]
        );
    } else {
        await db.run(
            `INSERT INTO user_log_stats (username, total_entries, total_size_bytes, oldest_entry_at, newest_entry_at)
             VALUES (?, 1, ?, ?, ?)`,
            [username, entrySize, now, now]
        );
    }
}

/**
 * Archive oldest logs for a user (move to archive table and delete)
 * @param {string} username - Username to archive logs for
 * @param {number} percent - Percentage of logs to archive (0.0-1.0)
 */
async function archiveOldLogs(username, percent = 0.2) {
    const db = await getDb();

    try {
        // Get count of logs to archive
        const countResult = await db.get(
            'SELECT COUNT(*) as count FROM activity_logs WHERE username = ?',
            [username]
        );

        const toArchive = Math.floor(countResult.count * percent);
        if (toArchive === 0) return 0;

        const year = new Date().getFullYear();

        // Archive oldest entries
        await db.run(
            `INSERT INTO activity_logs_archive
             (original_id, username, email, archive_year, timestamp, category, action,
              target, details, ip_address, user_agent, success, error_message, duration_ms, session_id, request_id)
             SELECT id, username, email, ?, timestamp, category, action, target, details,
                    ip_address, user_agent, success, error_message, duration_ms, session_id, request_id
             FROM activity_logs
             WHERE username = ?
             ORDER BY timestamp ASC
             LIMIT ?`,
            [year, username, toArchive]
        );

        // Delete archived entries
        await db.run(
            `DELETE FROM activity_logs
             WHERE username = ? AND id IN (
                 SELECT id FROM activity_logs WHERE username = ? ORDER BY timestamp ASC LIMIT ?
             )`,
            [username, username, toArchive]
        );

        // Update stats
        const newStats = await db.get(
            `SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(details) + 100), 0) as size
             FROM activity_logs WHERE username = ?`,
            [username]
        );

        await db.run(
            `UPDATE user_log_stats SET
             total_entries = ?,
             total_size_bytes = ?,
             last_archived_at = datetime('now')
             WHERE username = ?`,
            [newStats.count, newStats.size, username]
        );

        console.log(`[activity-logger] Archived ${toArchive} logs for user: ${username}`);
        return toArchive;
    } catch (error) {
        console.error('[activity-logger] Archive failed:', error);
        throw error;
    }
}

/**
 * Yearly archive job - archive all logs from previous year
 * Should be run on Jan 1 via cron/scheduler
 */
async function yearlyArchive() {
    const db = await getDb();
    const lastYear = new Date().getFullYear() - 1;
    const cutoffDate = `${lastYear + 1}-01-01`;

    try {
        console.log(`[activity-logger] Starting yearly archive for year ${lastYear}...`);

        // Archive all logs from last year
        const result = await db.run(
            `INSERT INTO activity_logs_archive
             (original_id, username, email, archive_year, timestamp, category, action,
              target, details, ip_address, user_agent, success, error_message, duration_ms, session_id, request_id)
             SELECT id, username, email, ?, timestamp, category, action, target, details,
                    ip_address, user_agent, success, error_message, duration_ms, session_id, request_id
             FROM activity_logs
             WHERE timestamp < ?`,
            [lastYear, cutoffDate]
        );

        // Delete archived entries
        await db.run('DELETE FROM activity_logs WHERE timestamp < ?', [cutoffDate]);

        console.log(`[activity-logger] Yearly archive complete. Archived ${result.changes} entries.`);
        return result.changes;
    } catch (error) {
        console.error('[activity-logger] Yearly archive failed:', error);
        throw error;
    }
}

/**
 * Get recent logs for a user
 */
async function getRecentLogs(username, limit = 100, offset = 0) {
    const db = await getDb();
    return db.all(
        `SELECT * FROM activity_logs
         WHERE username = ?
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
        [username, limit, offset]
    );
}

/**
 * Get all recent logs (for admin)
 */
async function getAllRecentLogs(limit = 100, offset = 0) {
    const db = await getDb();
    return db.all(
        `SELECT * FROM activity_logs
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
        [limit, offset]
    );
}

/**
 * Get logs by category
 */
async function getLogsByCategory(username, category, limit = 50) {
    const db = await getDb();
    return db.all(
        `SELECT * FROM activity_logs
         WHERE username = ? AND category = ?
         ORDER BY timestamp DESC
         LIMIT ?`,
        [username, category, limit]
    );
}

/**
 * Get user's archived logs
 */
async function getArchivedLogs(username, year, limit = 100, offset = 0) {
    const db = await getDb();
    return db.all(
        `SELECT * FROM activity_logs_archive
         WHERE username = ? AND archive_year = ?
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`,
        [username, year, limit, offset]
    );
}

/**
 * Logging middleware for Express routes
 */
function logApiAccess(category, action) {
    return async (req, res, next) => {
        const startTime = Date.now();
        const originalEnd = res.end;

        res.end = async function (...args) {
            const duration = Date.now() - startTime;
            const success = res.statusCode < 400;

            // Only log if user is authenticated
            if (req.user && req.user.email) {
                const username = req.user.email.split('@')[0];

                try {
                    await logActivity({
                        username,
                        email: req.user.email,
                        category,
                        action,
                        target: req.originalUrl,
                        details: {
                            method: req.method,
                            statusCode: res.statusCode,
                            params: req.params,
                        },
                        ip_address: req.ip || req.connection.remoteAddress,
                        user_agent: req.headers['user-agent'],
                        success,
                        error_message: !success ? `HTTP ${res.statusCode}` : null,
                        duration_ms: duration,
                        session_id: req.sessionID,
                    });
                } catch (error) {
                    console.error('[activity-logger] Middleware logging failed:', error);
                }
            }

            return originalEnd.apply(this, args);
        };

        next();
    };
}

/**
 * Subscribe to log events for real-time streaming
 */
function subscribeToLogs(callback, username = null) {
    const event = username ? `log:${username}` : 'log';
    logEmitter.on(event, callback);
    return () => logEmitter.off(event, callback);
}

module.exports = {
    logActivity,
    getRecentLogs,
    getAllRecentLogs,
    getLogsByCategory,
    getArchivedLogs,
    getUserLogStats,
    archiveOldLogs,
    yearlyArchive,
    logApiAccess,
    subscribeToLogs,
    logEmitter,
};
