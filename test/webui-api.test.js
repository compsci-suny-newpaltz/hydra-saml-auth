// /dashboard/api/webui/* proxies account operations to the OpenWebUI DB API.
// The target account must be the logged-in user's — a client-supplied `email`
// let any student change any gpt.hydra.newpaltz.edu password (audit 2026-10-01).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const axios = require('axios');
const seen = [];
axios.post = async (url, body) => { seen.push({ url, body }); return { data: { ok: true } }; };
process.env.OPENWEBUI_API_KEY = 'test';
const router = require('../routes/webui-api');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.isAuthenticated = () => true; req.user = { email: 'me@newpaltz.edu' }; next(); });
app.use('/webui', router);

test('every webui route uses the session email, never the body email', async () => {
  const server = app.listen(0); const port = server.address().port;
  try {
    for (const route of ['check-user', 'create-account', 'change-password', 'generate-api-key', 'get-api-key']) {
      seen.length = 0;
      const r = await fetch(`http://127.0.0.1:${port}/webui/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'victim@newpaltz.edu', password: 'x' }) });
      assert.equal(r.status, 200, route);
      assert.equal(seen.length, 1, route);
      assert.equal(seen[0].body.email, 'me@newpaltz.edu', `${route} forwarded ${seen[0].body.email}`);
    }
  } finally { server.close(); }
});
