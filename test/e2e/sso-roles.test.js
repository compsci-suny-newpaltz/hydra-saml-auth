/**
 * SSO role tests against the dev stack (dev/: make up, then make test-e2e).
 * Logs in through the real SAML flow with the mock IdP as each user and checks
 * the gates: admin-only APIs, infra API, dashboard, forward-auth role headers.
 *   admin@example.com   — in ADMIN_USERS (dev configmap)      -> admin
 *   faculty@example.com — affiliation faculty, not whitelisted -> faculty, NOT admin
 *   student@example.com — affiliation student                  -> student
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { login, as, anon, BASE } = require('./saml-client');

let admin, faculty, student;
test.before(async () => {
  try { admin = as(await login('admin', 'password')); }
  catch (e) { throw new Error(`cannot reach dev stack at ${BASE} — run 'make up' in dev/ first (${e.message})`); }
  faculty = as(await login('faculty', 'password'));
  student = as(await login('student', 'password'));
});

test('anonymous: dashboard redirects to login, admin API is 401', async () => {
  assert.equal((await anon('/dashboard')).status, 302);
  assert.equal((await anon('/dashboard/api/admin/whitelist')).status, 401);
  assert.equal((await anon('/dashboard/api/infra')).status, 401);
  assert.equal((await anon('/auth/verify')).status, 401);
});

test('student: dashboard works, admin and infra APIs are 403', async () => {
  assert.equal((await student('/dashboard')).status, 200);
  assert.equal((await student('/dashboard/api/admin/whitelist')).status, 403);
  assert.equal((await student('/dashboard/api/infra')).status, 403);
  assert.equal((await student('/dashboard/api/infra/deploy/github', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoUrl: 'https://github.com/a/b', branch: 'main; id' }) })).status, 403);
});

test('faculty: NOT admin — admin and infra APIs are 403, roles header says faculty', async () => {
  assert.equal((await faculty('/dashboard')).status, 200);
  assert.equal((await faculty('/dashboard/api/admin/whitelist')).status, 403);
  assert.equal((await faculty('/dashboard/api/infra')).status, 403);
  const v = await faculty('/auth/verify');
  assert.equal(v.status, 200);
  const roles = (v.headers.get('x-hydra-roles') || '').split(',');
  assert.ok(roles.includes('faculty'), `roles=${roles}`);
  assert.ok(!roles.includes('admin'), `faculty must not carry admin: ${roles}`);
});

test('admin: whitelist API allowed, roles header carries admin', async () => {
  const w = await admin('/dashboard/api/admin/whitelist');
  assert.equal(w.status, 200);
  const infra = await admin('/dashboard/api/infra');
  assert.ok(![401, 403].includes(infra.status), `admin blocked from infra API: ${infra.status}`);
  const v = await admin('/auth/verify');
  assert.ok((v.headers.get('x-hydra-roles') || '').split(',').includes('admin'));
});

test('admin: deploy/github rejects shell metacharacters with 400, never executes', async () => {
  for (const body of [{ repoUrl: 'https://github.com/a/b; id', branch: 'main' },
                      { repoUrl: 'https://github.com/a/b', branch: 'main; rm -rf /' },
                      { repoUrl: 'https://github.com/a/b', branch: '--upload-pack=id' }]) {
    const r = await admin('/dashboard/api/infra/deploy/github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('whitelist: adding a ta/faculty entry does not make them admin', async () => {
  const email = 'e2e-ta@newpaltz.edu';
  const add = await admin('/dashboard/api/admin/whitelist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, role: 'ta', reason: 'e2e' }) });
  assert.equal(add.status, 200);
  const list = await (await admin('/dashboard/api/admin/whitelist')).json();
  assert.equal(list.whitelist.find(w => w.email === email)?.role, 'ta');
  assert.equal((await admin(`/dashboard/api/admin/whitelist/${encodeURIComponent(email)}`, { method: 'DELETE' })).status, 200);
});
