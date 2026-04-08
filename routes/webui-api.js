// routes/webui-api.js now proxies to remote OpenWebUI DB API server
const express = require('express');
const router = express.Router();
const axios = require('axios');

// Config: target backend and API key loaded from env
const OPENWEBUI_API_BASE = process.env.OPENWEBUI_API_BASE || 'http://open-webui.hydra-infra.svc.cluster.local:7070/openwebui/api';
const OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY || process.env.WEBUI_API_KEY || process.env.API_KEY;

// Middleware to ensure user is authenticated
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ success: false, message: 'Not authenticated' });
}

// Validate config at load time
if (!OPENWEBUI_API_KEY) {
  console.warn('[webui-api] Missing OPENWEBUI_API_KEY. Requests will fail with 500.');
}

// Check if user exists in OpenWebUI
router.post('/check-user', ensureAuthenticated, async (req, res) => {
  try {
    const { data } = await axios.post(`${OPENWEBUI_API_BASE}/check-user`, req.body, {
      headers: { 'x-api-key': OPENWEBUI_API_KEY }
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || { success: false, message: 'Error checking user status' };
    console.error('[webui-api] check-user proxy error:', error.message);
    res.status(status).json(data);
  }
});

// Create a new OpenWebUI account
router.post('/create-account', ensureAuthenticated, async (req, res) => {
  try {
    const { data } = await axios.post(`${OPENWEBUI_API_BASE}/create-account`, req.body, {
      headers: { 'x-api-key': OPENWEBUI_API_KEY }
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || { success: false, message: 'Error creating account' };
    console.error('[webui-api] create-account proxy error:', error.message);
    res.status(status).json(data);
  }
});

// Change password for an existing account
router.post('/change-password', ensureAuthenticated, async (req, res) => {
  try {
    const { data } = await axios.post(`${OPENWEBUI_API_BASE}/change-password`, req.body, {
      headers: { 'x-api-key': OPENWEBUI_API_KEY }
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || { success: false, message: 'Error updating password' };
    console.error('[webui-api] change-password proxy error:', error.message);
    res.status(status).json(data);
  }
});

// Generate an OpenWebUI API key for the logged-in user
router.post('/generate-api-key', ensureAuthenticated, async (req, res) => {
  try {
    const { data } = await axios.post(`${OPENWEBUI_API_BASE}/generate-api-key`, req.body, {
      headers: { 'x-api-key': OPENWEBUI_API_KEY }
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || { success: false, message: 'Error generating API key' };
    console.error('[webui-api] generate-api-key proxy error:', error.message);
    res.status(status).json(data);
  }
});

// Check if user has an OpenWebUI API key
router.post('/get-api-key', ensureAuthenticated, async (req, res) => {
  try {
    const { data } = await axios.post(`${OPENWEBUI_API_BASE}/get-api-key`, req.body, {
      headers: { 'x-api-key': OPENWEBUI_API_KEY }
    });
    res.json(data);
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || { success: false, message: 'Error checking API key' };
    console.error('[webui-api] get-api-key proxy error:', error.message);
    res.status(status).json(data);
  }
});

module.exports = router;