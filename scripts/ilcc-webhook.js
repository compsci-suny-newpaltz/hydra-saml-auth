#!/usr/bin/env node
/*
 * ilcc-webhook.js — GitHub push → redeploy https://hydra.newpaltz.edu/ilcc
 *
 * Runs on the Hydra HOST (systemd: ilcc-webhook.service, User=infra) because
 * deploying needs buildah/ctr/kubectl — none of which exist in-cluster.
 * Traefik reaches it through the ExternalName service `ilcc-webhook`
 * (same pattern as hydra-backend): hydra.newpaltz.edu/hooks/ilcc-deploy → :9310.
 *
 * Security: every request must carry a valid X-Hub-Signature-256 (HMAC of the
 * raw body with WEBHOOK_SECRET from /etc/ilcc-webhook.env — the same secret
 * registered on the GitHub webhook). Bad/missing signature → 401, nothing runs.
 * Only `push` events to refs/heads/main (or master) deploy, and the payload is
 * never interpolated into the command — the script always runs the same
 * deploy-ilcc.sh, which pulls from the repo itself.
 *
 * Concurrency: one deploy at a time; a push landing mid-deploy sets `pending`
 * and one more deploy runs after (coalescing any number of pushes).
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = Number(process.env.PORT || 9310);
const SECRET = process.env.WEBHOOK_SECRET || '';
const DEPLOY = process.env.DEPLOY_SCRIPT || '/home/infra/hydra-saml-auth/scripts/deploy-ilcc.sh';
const LOG = process.env.DEPLOY_LOG || '/var/log/ilcc-webhook/deploy.log';
if (!SECRET) { console.error('WEBHOOK_SECRET is required'); process.exit(1); }

let running = false, pending = null;
const last = { startedAt: null, finishedAt: null, ok: null, sha: null, trigger: null };

function verify(sig, body) {
  if (!sig || !sig.startsWith('sha256=')) return false;
  const mac = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac)); } catch { return false; }
}

function runDeploy(sha, trigger) {
  if (running) { pending = { sha, trigger }; console.log(`deploy queued (${sha})`); return; }
  running = true;
  Object.assign(last, { startedAt: new Date().toISOString(), finishedAt: null, ok: null, sha, trigger });
  console.log(`deploy start sha=${sha} trigger=${trigger}`);
  const out = fs.createWriteStream(LOG, { flags: 'a' });
  out.write(`\n===== ${last.startedAt} sha=${sha} trigger=${trigger} =====\n`);
  const p = spawn(DEPLOY, [], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: '/home/infra' } });
  p.stdout.pipe(out, { end: false }); p.stderr.pipe(out, { end: false });
  p.on('close', (code) => {
    last.finishedAt = new Date().toISOString(); last.ok = code === 0;
    out.write(`===== exit ${code} =====\n`); out.end();
    console.log(`deploy done exit=${code}`);
    running = false;
    if (pending) { const n = pending; pending = null; runDeploy(n.sha, n.trigger); }
  });
}

const server = http.createServer((req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url.startsWith('/hooks/ilcc-deploy/status')) {
    return reply(200, { running, queued: !!pending, last });
  }
  if (req.method !== 'POST' || !req.url.startsWith('/hooks/ilcc-deploy')) return reply(404, { error: 'not_found' });

  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (!verify(req.headers['x-hub-signature-256'], body)) return reply(401, { error: 'bad_signature' });
    const event = req.headers['x-github-event'];
    if (event === 'ping') return reply(200, { pong: true });
    if (event !== 'push') return reply(200, { ignored: event });
    let payload; try { payload = JSON.parse(body.toString('utf8')); } catch { return reply(400, { error: 'bad_json' }); }
    if (payload.ref !== 'refs/heads/main' && payload.ref !== 'refs/heads/master') return reply(200, { ignored: payload.ref });
    const sha = String(payload.after || '').slice(0, 7);
    runDeploy(sha, `push by ${payload.pusher?.name || '?'}`);
    return reply(202, { deploying: sha, queued: running });
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`ilcc-webhook listening on :${PORT}`));
