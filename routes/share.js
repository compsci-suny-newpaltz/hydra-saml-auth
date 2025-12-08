/**
 * Shareable container links API.
 * Generate time-limited share tokens for container access.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { requireAuth } = require('../middleware/roles');

const router = express.Router();
const SHARES_FILE = path.join(__dirname, '..', 'data', 'shares.json');

// Ensure data directory exists
async function ensureDataDir() {
    const dataDir = path.dirname(SHARES_FILE);
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (e) {
        // Ignore if already exists
    }
}

// Load shares from file
async function loadShares() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(SHARES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return {};
        }
        throw e;
    }
}

// Save shares to file
async function saveShares(shares) {
    await ensureDataDir();
    await fs.writeFile(SHARES_FILE, JSON.stringify(shares, null, 2));
}

// Generate secure random token
function generateToken() {
    return crypto.randomBytes(24).toString('base64url');
}

// Calculate expiration (default: 7 days)
function calculateExpiration(days = 7) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + days);
    return expDate.toISOString();
}

// Clean expired shares
async function cleanExpiredShares() {
    const shares = await loadShares();
    const now = new Date();
    let cleaned = 0;

    for (const [token, share] of Object.entries(shares)) {
        if (new Date(share.expiresAt) < now) {
            delete shares[token];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        await saveShares(shares);
    }

    return cleaned;
}

// List shares for current user's containers
// GET /dashboard/api/shares
router.get('/', requireAuth, async (req, res) => {
    try {
        await cleanExpiredShares();

        const shares = await loadShares();
        const username = String(req.user.email).split('@')[0];

        const userShares = Object.values(shares)
            .filter(s => s.createdBy === username)
            .map(s => ({
                token: s.token,
                container: s.container,
                endpoint: s.endpoint,
                access: s.access,
                expiresAt: s.expiresAt,
                views: s.views,
                lastAccessed: s.lastAccessed,
                createdAt: s.createdAt,
                url: `https://hydra.newpaltz.edu/share/${s.token}`
            }));

        return res.json({ success: true, shares: userShares });
    } catch (err) {
        console.error('[share] list error:', err);
        return res.status(500).json({ success: false, message: 'Failed to list shares' });
    }
});

// Create a share link
// POST /dashboard/api/shares
// Body: { endpoint, access?, expirationDays? }
router.post('/', requireAuth, async (req, res) => {
    try {
        const { endpoint, access, expirationDays } = req.body;
        const username = String(req.user.email).split('@')[0];
        const containerName = `student-${username}`;

        // Validate endpoint
        const validEndpoint = String(endpoint || 'vscode').toLowerCase();
        if (!validEndpoint || !/^[a-z0-9-]+$/.test(validEndpoint)) {
            return res.status(400).json({ success: false, message: 'Invalid endpoint' });
        }

        // Validate access level
        const accessLevel = access === 'full' ? 'full' : 'readonly';

        // Validate expiration (max 30 days)
        const days = Math.min(Math.max(parseInt(expirationDays, 10) || 7, 1), 30);

        await cleanExpiredShares();

        const token = generateToken();
        const share = {
            token,
            container: containerName,
            endpoint: validEndpoint,
            access: accessLevel,
            createdBy: username,
            createdByEmail: req.user.email,
            createdAt: new Date().toISOString(),
            expiresAt: calculateExpiration(days),
            views: 0,
            lastAccessed: null
        };

        const shares = await loadShares();
        shares[token] = share;
        await saveShares(shares);

        return res.json({
            success: true,
            share: {
                token: share.token,
                endpoint: share.endpoint,
                access: share.access,
                expiresAt: share.expiresAt,
                url: `https://hydra.newpaltz.edu/share/${token}`
            }
        });
    } catch (err) {
        console.error('[share] create error:', err);
        return res.status(500).json({ success: false, message: 'Failed to create share' });
    }
});

// Get share info (for access validation)
// GET /dashboard/api/shares/:token
router.get('/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const shares = await loadShares();
        const share = shares[token];

        if (!share) {
            return res.status(404).json({ success: false, message: 'Share not found' });
        }

        // Check if expired
        if (new Date(share.expiresAt) < new Date()) {
            return res.status(410).json({ success: false, message: 'Share has expired' });
        }

        // Update view count and last accessed
        share.views++;
        share.lastAccessed = new Date().toISOString();
        await saveShares(shares);

        // Return redirect info
        const baseUrl = process.env.PUBLIC_STUDENTS_BASE || 'https://hydra.newpaltz.edu/students';
        const username = share.container.replace('student-', '');
        const targetUrl = `${baseUrl}/${username}/${share.endpoint}/`;

        return res.json({
            success: true,
            redirect: targetUrl,
            endpoint: share.endpoint,
            access: share.access,
            expiresAt: share.expiresAt
        });
    } catch (err) {
        console.error('[share] get error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get share' });
    }
});

// Revoke a share
// DELETE /dashboard/api/shares/:token
router.delete('/:token', requireAuth, async (req, res) => {
    try {
        const token = req.params.token;
        const username = String(req.user.email).split('@')[0];

        const shares = await loadShares();
        const share = shares[token];

        if (!share) {
            return res.status(404).json({ success: false, message: 'Share not found' });
        }

        // Only allow owner to revoke
        if (share.createdBy !== username) {
            return res.status(403).json({ success: false, message: 'Not authorized to revoke this share' });
        }

        delete shares[token];
        await saveShares(shares);

        return res.json({ success: true, message: 'Share revoked' });
    } catch (err) {
        console.error('[share] revoke error:', err);
        return res.status(500).json({ success: false, message: 'Failed to revoke share' });
    }
});

// Validate share token (for Traefik ForwardAuth or middleware)
// GET /dashboard/api/shares/validate/:token
router.get('/validate/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const shares = await loadShares();
        const share = shares[token];

        if (!share) {
            return res.status(401).json({ valid: false, message: 'Invalid share token' });
        }

        if (new Date(share.expiresAt) < new Date()) {
            return res.status(401).json({ valid: false, message: 'Share has expired' });
        }

        return res.json({
            valid: true,
            container: share.container,
            endpoint: share.endpoint,
            access: share.access
        });
    } catch (err) {
        console.error('[share] validate error:', err);
        return res.status(500).json({ valid: false, message: 'Validation failed' });
    }
});

module.exports = router;
