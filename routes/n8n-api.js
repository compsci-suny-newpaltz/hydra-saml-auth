// routes/n8n-api.js — proxies to n8n API using env credentials
const express = require('express');
const axios = require('axios');

const router = express.Router();

const N8N_HOST = process.env.N8N_HOST;
const N8N_API_KEY = process.env.N8N_API_KEY;
const N8N_USER_MANAGER_API_KEY = process.env.N8N_USER_MANAGER_API_KEY;
// User manager is accessed via traefik on port 8080, not via n8n on 5678
const N8N_USER_MANAGER_HOST = process.env.N8N_USER_MANAGER_HOST || 'http://127.0.0.1:8080';

if (!N8N_HOST || !N8N_API_KEY) {
  console.warn('[n8n-api] Missing N8N_HOST or N8N_API_KEY — endpoints will error');
}

if (!N8N_USER_MANAGER_API_KEY) {
  console.warn('[n8n-api] Missing N8N_USER_MANAGER_API_KEY — password change will not work');
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

    // First check if user exists and is pending
    try {
      const checkUrl = `${N8N_HOST}/api/v1/users/${encodeURIComponent(email)}?includeRole=true`;
      const { data: existingUser } = await axios.get(checkUrl, {
        headers: { 'X-N8N-API-KEY': N8N_API_KEY }
      });

      if (existingUser && existingUser.id && existingUser.isPending) {
        // User exists but is pending - delete and recreate
        const deleteUrl = `${N8N_HOST}/api/v1/users/${existingUser.id}`;
        await axios.delete(deleteUrl, {
          headers: { 'X-N8N-API-KEY': N8N_API_KEY }
        });
      } else if (existingUser && existingUser.id && !existingUser.isPending) {
        // User already active
        return res.json([]);
      }
    } catch (checkErr) {
      // If 404, user doesn't exist - continue to create
      if (checkErr.response?.status !== 404) {
        throw checkErr;
      }
    }

    // Create new user/invite
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

// POST /change-password — uses authenticated user's Azure email
router.post('/change-password', ensureAuthenticated, async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(400).json({ success: false, message: 'Missing authenticated email' });

    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    if (!N8N_USER_MANAGER_API_KEY) {
      return res.status(500).json({ success: false, message: 'Password change not configured on server' });
    }

    const url = `${N8N_USER_MANAGER_HOST}/n8n-user-manager/api/users/change-password`;
    const { data } = await axios.post(url,
      { email, newPassword },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': N8N_USER_MANAGER_API_KEY
        }
      }
    );

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('[n8n-api] change-password error:', err.message);
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || 'Error changing password';
    return res.status(status).json({ success: false, message });
  }
});

module.exports = router;
