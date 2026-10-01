// Role model for hydra-saml-auth: admin > faculty > ta > student.
//   admin   = ADMIN_USERS env OR user_whitelist.role = 'admin'
//   faculty = SAML affiliation 'faculty' OR user_whitelist.role = 'faculty'
//   ta      = user_whitelist.role = 'ta'
// Faculty is NOT admin: infra deploys, whitelist management, pod terminals and
// the admin dashboard are admin-only. (Reported 2026-10-01: any faculty login
// passed every admin gate.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoles, requireAdmin, requireStaff } = require('../middleware/roles');

const db = { 'dbadmin@newpaltz.edu': { role: 'admin' }, 'dbfac@newpaltz.edu': { role: 'faculty' }, 'ta1@newpaltz.edu': { role: 'ta' } };
const opts = { adminUsers: ['envadmin@newpaltz.edu'], lookup: async (e) => db[e] || null };
const r = (user) => resolveRoles(user, opts);

test('env ADMIN_USERS is admin (case-insensitive)', async () => {
  const x = await r({ email: 'EnvAdmin@newpaltz.edu', affiliation: 'staff' });
  assert.equal(x.isAdmin, true); assert.equal(x.role, 'admin');
});
test('SAML faculty is faculty, not admin', async () => {
  const x = await r({ email: 'prof@newpaltz.edu', affiliation: 'faculty' });
  assert.equal(x.isFaculty, true); assert.equal(x.isAdmin, false); assert.equal(x.isStaff, true); assert.equal(x.role, 'faculty');
});
test('whitelist role admin is admin', async () => {
  const x = await r({ email: 'dbadmin@newpaltz.edu', affiliation: 'student' });
  assert.equal(x.isAdmin, true);
});
test('whitelist role faculty is faculty only', async () => {
  const x = await r({ email: 'dbfac@newpaltz.edu', affiliation: 'student' });
  assert.equal(x.isAdmin, false); assert.equal(x.isFaculty, true);
});
test('whitelist role ta is staff but neither admin nor faculty', async () => {
  const x = await r({ email: 'ta1@newpaltz.edu', affiliation: 'student' });
  assert.deepEqual([x.isAdmin, x.isFaculty, x.isTA, x.isStaff, x.role], [false, false, true, true, 'ta']);
});
test('plain student has no privileges', async () => {
  const x = await r({ email: 'stu@newpaltz.edu', affiliation: 'student' });
  assert.deepEqual([x.isAdmin, x.isFaculty, x.isTA, x.isStaff, x.role], [false, false, false, false, 'student']);
});
test('lookup failure degrades to no DB privileges, not a crash', async () => {
  const x = await resolveRoles({ email: 'dbadmin@newpaltz.edu' }, { adminUsers: [], lookup: async () => { throw new Error('db down'); } });
  assert.equal(x.isAdmin, false);
});

function mockReq(user) { return { user, isAuthenticated: () => !!user }; }
function mockRes() { const res = { code: null, body: null }; res.status = (c) => { res.code = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; }

test('requireAdmin: 401 unauthenticated, 403 faculty, next() admin', async () => {
  const mw = requireAdmin(opts);
  let res = mockRes(); let called = false;
  await mw(mockReq(null), res, () => { called = true; });
  assert.equal(res.code, 401); assert.equal(called, false);
  res = mockRes(); called = false;
  await mw(mockReq({ email: 'prof@newpaltz.edu', affiliation: 'faculty' }), res, () => { called = true; });
  assert.equal(res.code, 403); assert.equal(called, false);
  res = mockRes(); called = false;
  const req = mockReq({ email: 'envadmin@newpaltz.edu' });
  await mw(req, res, () => { called = true; });
  assert.equal(called, true); assert.equal(req.roles.isAdmin, true);
});
test('requireStaff lets faculty and ta through, blocks students', async () => {
  const mw = requireStaff(opts);
  let called = false;
  await mw(mockReq({ email: 'prof@newpaltz.edu', affiliation: 'faculty' }), mockRes(), () => { called = true; });
  assert.equal(called, true);
  called = false; const res = mockRes();
  await mw(mockReq({ email: 'stu@newpaltz.edu', affiliation: 'student' }), res, () => { called = true; });
  assert.equal(called, false); assert.equal(res.code, 403);
});
