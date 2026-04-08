// openwebui_middleman/index.js — OpenWebUI DB API on chimera (same endpoints)
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('../db');

const app = express();
app.use(express.json());

// Config
const PORT = parseInt(process.env.OPENWEBUI_API_PORT || process.env.PORT || '7070', 10);
const API_KEY = process.env.OPENWEBUI_API_KEY || process.env.WEBUI_API_KEY || process.env.API_KEY || '';

if (!API_KEY) {
  console.warn('[openwebui_middleman] WARNING: OPENWEBUI_API_KEY not set. Refusing to start.');
  // Hard exit to avoid exposing unauthenticated DB mutators
  process.exit(1);
}

// Simple API key auth for all routes
app.use((req, res, next) => {
  const provided = req.get('x-api-key') || '';
  const providedBuf = Buffer.from(provided);
  const apiKeyBuf = Buffer.from(API_KEY);
  if (provided && providedBuf.length === apiKeyBuf.length && crypto.timingSafeEqual(providedBuf, apiKeyBuf)) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

// Health check
app.get('/openwebui/health', (_req, res) => res.json({ ok: true }));

const base = '/openwebui/api';

// POST /openwebui/api/check-user { email }
app.post(`${base}/check-user`, async (req, res) => {
  const db = await getDb();
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email' });

    const user = await db.get('SELECT id, name, email, role FROM user WHERE email = ?', [email]);
    if (user) {
      return res.json({
        exists: true,
        id: user.id,
        username: user.name,
        email: user.email,
        role: user.role
      });
    }
    return res.json({ exists: false });
  } catch (error) {
    console.error('[openwebui_middleman] check-user error:', error);
    return res.status(500).json({ success: false, message: 'Error checking user status' });
  }
  // Note: Don't close db - singleton pattern in db.js keeps connection open
});

// POST /openwebui/api/create-account { email, name, password }
app.post(`${base}/create-account`, async (req, res) => {
  const db = await getDb();
  try {
    const { email, name, password } = req.body || {};
    if (!email || !name || !password) {
      return res.status(400).json({ success: false, message: 'Missing email, name, or password' });
    }

    await db.run('BEGIN TRANSACTION');

    const existing = await db.get('SELECT id FROM user WHERE email = ?', [email]);
    if (existing) {
      await db.run('ROLLBACK');
      return res.status(400).json({ success: false, message: 'User with this email already exists' });
    }

    const userId = crypto.randomUUID();
    const hashedPassword = await hashPassword(password);
    const ts = Math.floor(Date.now() / 1000);

    await db.run(
      `INSERT INTO user (
        id, name, email, role, profile_image_url, created_at, updated_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, name, email, 'user', 'https://hydra.newpaltz.edu/SUNYCAT.png', ts, ts, ts]
    );

    await db.run(
      `INSERT INTO auth (id, email, password, active) VALUES (?, ?, ?, ?)`,
      [userId, email, hashedPassword, 1]
    );

    // Auto-generate an API key for the new user
    const apiKey = 'sk-' + crypto.randomBytes(24).toString('hex');
    const keyId = `key_${userId}`;
    await db.run(
      'INSERT INTO api_key (id, user_id, key, data, expires_at, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [keyId, userId, apiKey, null, null, null, ts, ts]
    );

    await db.run('COMMIT');
    return res.json({ success: true, message: 'Account created successfully', api_key: apiKey });
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch { }
    console.error('[openwebui_middleman] create-account error:', error);
    return res.status(500).json({ success: false, message: 'Error creating account' });
  }
  // Note: Don't close db - singleton pattern in db.js keeps connection open
});

// POST /openwebui/api/change-password { email, password }
app.post(`${base}/change-password`, async (req, res) => {
  const db = await getDb();
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Missing email or password' });
    }

    const exists = await db.get('SELECT id FROM user WHERE email = ?', [email]);
    if (!exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const hashedPassword = await hashPassword(password);
    await db.run('UPDATE auth SET password = ? WHERE email = ?', [hashedPassword, email]);
    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('[openwebui_middleman] change-password error:', error);
    return res.status(500).json({ success: false, message: 'Error updating password' });
  }
  // Note: Don't close db - singleton pattern in db.js keeps connection open
});

// POST /openwebui/api/generate-api-key { email }
app.post(`${base}/generate-api-key`, async (req, res) => {
  const db = await getDb();
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email' });

    const user = await db.get('SELECT id FROM user WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found in OpenWebUI' });
    }

    // Delete any existing API key for this user
    await db.run('DELETE FROM api_key WHERE user_id = ?', [user.id]);

    // Generate a new API key
    const apiKey = 'sk-' + crypto.randomBytes(24).toString('hex');
    const keyId = `key_${user.id}`;
    const ts = Math.floor(Date.now() / 1000);

    await db.run(
      'INSERT INTO api_key (id, user_id, key, data, expires_at, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [keyId, user.id, apiKey, null, null, null, ts, ts]
    );

    return res.json({ success: true, api_key: apiKey });
  } catch (error) {
    console.error('[openwebui_middleman] generate-api-key error:', error);
    return res.status(500).json({ success: false, message: 'Error generating API key' });
  }
});

// GET /openwebui/api/get-api-key { email }
app.post(`${base}/get-api-key`, async (req, res) => {
  const db = await getDb();
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Missing email' });

    const user = await db.get('SELECT id FROM user WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const key = await db.get('SELECT key, created_at FROM api_key WHERE user_id = ?', [user.id]);
    if (!key) {
      return res.json({ success: true, has_key: false });
    }

    // Only show first 8 + last 4 chars
    const masked = key.key.substring(0, 8) + '...' + key.key.substring(key.key.length - 4);
    return res.json({ success: true, has_key: true, api_key_masked: masked, created_at: key.created_at });
  } catch (error) {
    console.error('[openwebui_middleman] get-api-key error:', error);
    return res.status(500).json({ success: false, message: 'Error checking API key' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[openwebui_middleman] listening on 0.0.0.0:${PORT} (base: ${base})`);
});
