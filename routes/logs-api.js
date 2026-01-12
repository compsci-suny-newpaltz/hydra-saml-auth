// routes/logs-api.js - Activity logs API endpoints
const express = require('express');
const router = express.Router();
const {
    getRecentLogs,
    getAllRecentLogs,
    getLogsByCategory,
    getArchivedLogs,
    getUserLogStats,
    subscribeToLogs,
} = require('../services/activity-logger');

// Ensure authenticated
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated && req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// Get recent logs for the current user
router.get('/recent', ensureAuthenticated, async (req, res) => {
    try {
        const username = req.user.email.split('@')[0];
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;

        const logs = await getRecentLogs(username, limit, offset);
        res.json({ success: true, logs });
    } catch (error) {
        console.error('[logs-api] Failed to get recent logs:', error);
        res.status(500).json({ error: 'Failed to get logs' });
    }
});

// Get logs by category
router.get('/category/:category', ensureAuthenticated, async (req, res) => {
    try {
        const username = req.user.email.split('@')[0];
        const { category } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);

        const validCategories = ['container', 'service', 'route', 'auth', 'resource', 'account', 'system', 'error'];
        if (!validCategories.includes(category)) {
            return res.status(400).json({ error: 'Invalid category' });
        }

        const logs = await getLogsByCategory(username, category, limit);
        res.json({ success: true, logs });
    } catch (error) {
        console.error('[logs-api] Failed to get logs by category:', error);
        res.status(500).json({ error: 'Failed to get logs' });
    }
});

// Get user's log stats (usage info)
router.get('/stats', ensureAuthenticated, async (req, res) => {
    try {
        const username = req.user.email.split('@')[0];
        const stats = await getUserLogStats(username);

        const limit = 100 * 1024 * 1024; // 100MB
        res.json({
            success: true,
            stats: stats || { total_entries: 0, total_size_bytes: 0 },
            limit_bytes: limit,
            usage_percent: stats ? Math.round((stats.total_size_bytes / limit) * 100) : 0,
        });
    } catch (error) {
        console.error('[logs-api] Failed to get log stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Get archived logs
router.get('/archive/:year', ensureAuthenticated, async (req, res) => {
    try {
        const username = req.user.email.split('@')[0];
        const year = parseInt(req.params.year);
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;

        if (isNaN(year) || year < 2020 || year > new Date().getFullYear()) {
            return res.status(400).json({ error: 'Invalid year' });
        }

        const logs = await getArchivedLogs(username, year, limit, offset);
        res.json({ success: true, logs });
    } catch (error) {
        console.error('[logs-api] Failed to get archived logs:', error);
        res.status(500).json({ error: 'Failed to get archived logs' });
    }
});

// Server-Sent Events stream for real-time logs
router.get('/stream', ensureAuthenticated, (req, res) => {
    const username = req.user.email.split('@')[0];

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', username })}\n\n`);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 30000);

    // Subscribe to log events for this user
    const unsubscribe = subscribeToLogs((logEntry) => {
        res.write(`data: ${JSON.stringify({ type: 'log', ...logEntry })}\n\n`);
    }, username);

    // Clean up on close
    req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
});

// Admin endpoint: Get all recent logs
router.get('/admin/all', ensureAuthenticated, async (req, res) => {
    try {
        // Check if user is admin (you'll need to implement admin check based on your auth system)
        const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : [];
        if (!adminEmails.includes(req.user.email)) {
            return res.status(403).json({ error: 'Forbidden - Admin access required' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const offset = parseInt(req.query.offset) || 0;

        const logs = await getAllRecentLogs(limit, offset);
        res.json({ success: true, logs });
    } catch (error) {
        console.error('[logs-api] Failed to get admin logs:', error);
        res.status(500).json({ error: 'Failed to get logs' });
    }
});

// Admin endpoint: SSE stream for all logs
router.get('/admin/stream', ensureAuthenticated, (req, res) => {
    // Check if user is admin
    const adminEmails = process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',') : [];
    if (!adminEmails.includes(req.user.email)) {
        return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', admin: true })}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 30000);

    // Subscribe to all log events
    const unsubscribe = subscribeToLogs((logEntry) => {
        res.write(`data: ${JSON.stringify({ type: 'log', ...logEntry })}\n\n`);
    });

    req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
});

module.exports = router;
