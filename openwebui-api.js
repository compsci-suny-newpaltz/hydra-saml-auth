// openwebui-api.js — dedicated OpenWebUI DB API (separate host)
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('./db');

const app = express();

// Config
const PORT = parseInt(
  process.env.OPENWEBUI_API_PORT ||
  process.env.PORT ||
  '7070',
  10
);
const API_KEY = process.env.OPENWEBUI_API_KEY || '';

// Basic hard-fail if no API key configured
if (!API_KEY) {
  console.warn('[OpenWebUI-API] WARNING: OPENWEBUI_API_KEY not set. Refusing to start.');
  process.exit(1);
}

// Middleware
app.use(express.json());

// Simple API key auth for all routes
app.use((req, res, next) => {
  const provided = req.get('x-api-key') || '';
  if (provided && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY))) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

// Base path for API
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
    console.error('[OpenWebUI-API] check-user error:', error);
    return res.status(500).json({ success: false, message: 'Error checking user status' });
  } finally {
    await db.close();
  }
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

    await db.run('COMMIT');
    return res.json({ success: true, message: 'Account created successfully' });
  } catch (error) {
    try { await db.run('ROLLBACK'); } catch {}
    console.error('[OpenWebUI-API] create-account error:', error);
    return res.status(500).json({ success: false, message: 'Error creating account' });
  } finally {
    await db.close();
  }
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
    console.error('[OpenWebUI-API] change-password error:', error);
    return res.status(500).json({ success: false, message: 'Error updating password' });
  } finally {
    await db.close();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OpenWebUI-API] listening on 0.0.0.0:${PORT} (base: ${base})`);
});
