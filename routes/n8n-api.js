// routes/n8n-api.js — proxies to n8n API using env credentials
const express = require('express');
const axios = require('axios');

const router = express.Router();

const N8N_HOST = process.env.N8N_HOST;
const N8N_API_KEY = process.env['X-N8N-API-KEY'] || process.env.N8N_API_KEY;

if (!N8N_HOST || !N8N_API_KEY) {
  console.warn('[n8n-api] Missing N8N_HOST or X-N8N-API-KEY — endpoints will error');
}

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ success: false, message: 'Not authenticated' });
}

// POST /status — uses authenticated user's Azure email
router.post('/status', ensureAuthenticated, async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(400).json({ success: false, message: 'Missing authenticated email' });
    const url = `${N8N_HOST}/api/v1/users/${encodeURIComponent(email)}?includeRole=true`;
    const { data } = await axios.get(url, { headers: { 'X-N8N-API-KEY': N8N_API_KEY } });

    const mapped = {
      id: data.id,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      isPending: !!data.isPending,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      role: data.role
    };
    return res.json(mapped);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.json({ exists: false });
    console.error('[n8n-api] status error:', err.message);
    return res.status(status || 500).json({ success: false, message: 'Error retrieving status' });
  }
});

// POST /create-user — uses authenticated user's Azure email
router.post('/create-user', ensureAuthenticated, async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(400).json({ success: false, message: 'Missing authenticated email' });
    const url = `${N8N_HOST}/api/v1/users`;
    const payload = [{ email, role: 'global:member' }];
    const { data } = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': N8N_API_KEY
      }
    });
    // Pass-through response; can be object with inviteAcceptUrl or [] if already invited/completed
    return res.json(data);
  } catch (err) {
    console.error('[n8n-api] create-user error:', err.message);
    const status = err.response?.status || 500;
    const data = err.response?.data || { success: false, message: 'Error creating user' };
    return res.status(status).json(data);
  }
});

module.exports = router;
