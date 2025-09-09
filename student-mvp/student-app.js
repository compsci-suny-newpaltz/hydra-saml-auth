/**
 * Minimal Student App (CommonJS)
 * - Shows a "Login with New Paltz" button
 * - After login, Hydra sets a site-wide HttpOnly JWT cookie: np_access
 * - This app calls Hydra /check to verify the cookie and gate /restricted
 *
 * Security model:
 * - Student app NEVER sees SAML.
 * - Student app just forwards JWT to Hydra /check and trusts the response.
 *
 * Deploy this under hydra.newpaltz.edu/<your-path> so the np_access cookie is sent.
 */

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
const router = express.Router();

// --- Config (tweak via .env if needed) ---------------------------------------
const HYDRA_BASE_URL = process.env.HYDRA_BASE_URL || 'https://hydra.newpaltz.edu'; // where /login, /check live
const APP_NAME = process.env.APP_NAME || 'Student Demo';                            // just for display
// Roles that are allowed into /restricted (default: student, faculty)
const ALLOWED_ROLES = (process.env.ALLOWED_ROLES || 'student,faculty')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Trust proxy so we can build correct absolute URLs behind a reverse proxy
app.set('trust proxy', 1);
router.use(cookieParser());
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

/**
 * Build the current absolute URL (used for returnTo redirects back here).
 * We prefer X-Forwarded-Proto/Host so this works behind a proxy on https.
 */
function fullUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = (req.headers['x-forwarded-host'] || req.headers.host);
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Call Hydra /check with the token. Returns { ok:boolean, data?:object, status:number }.
 * We do NOT pass cookies to Hydra; we read np_access from *our* cookies and forward as Bearer.
 */
async function verifyWithHydra(token) {
  if (!token) return { ok: false, status: 401 };
  const r = await fetch(`${HYDRA_BASE_URL}/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return { ok: false, status: r.status };
  const data = await r.json(); // { active, email, roles, groups, ... }
  return { ok: true, status: 200, data };
}

/**
 * Middleware: require New Paltz identity & allowed role(s)
 * Reads np_access cookie, verifies with Hydra /check, and attaches req.user.
 */
async function requireNP(req, res, next) {
  try {
    const token = req.cookies?.np_access;
    const result = await verifyWithHydra(token);
    if (!result.ok || !result.data?.active) {
      return res.status(401).send('Please log in with your New Paltz account.');
    }
    const roles = (result.data.roles || []).map(s => String(s).toLowerCase());
    const allowed = roles.some(r => ALLOWED_ROLES.includes(r));
    if (!allowed) return res.status(403).send('Not authorized for this area.');

    req.user = result.data; // { email, roles, groups, ... }
    next();
  } catch (e) {
    console.error('requireNP error:', e);
    res.status(500).send('Verification failed.');
  }
}

// --- Routes ------------------------------------------------------------------

// Middleware for faculty only
function requireFaculty(req, res, next) {
  if (!req.user || !Array.isArray(req.user.roles) || !req.user.roles.map(r => r.toLowerCase()).includes('faculty')) {
    return res.status(403).send('Faculty only.');
  }
  next();
}

// Middleware for student only
function requireStudent(req, res, next) {
  if (!req.user || !Array.isArray(req.user.roles) || !req.user.roles.map(r => r.toLowerCase()).includes('student')) {
    return res.status(403).send('Students only.');
  }
  next();
}

// Middleware for compsci group only
function requireCompsci(req, res, next) {
  const groups = (req.user && Array.isArray(req.user.groups)) ? req.user.groups.map(g => g.toLowerCase()) : [];
  if (!groups.includes('compsci-students') && !groups.includes('registered-students')) {
    return res.status(403).send('Compsci students only.');
  }
  next();
}

/**
 * Home:
 * - If logged in, shows email and a link to /restricted.
 * - If not, shows a "Login with New Paltz" button that navigates to Hydra /login
 *   with returnTo set back to THIS page.
 */
router.get('/', async (req, res) => {
  const token = req.cookies?.np_access;
  const me = await verifyWithHydra(token); // lightweight check to show status
  const returnTo = "https://hydra.newpaltz.edu/studentmvp/"; // send users back here after SSO

  const loggedIn = me.ok && me.data?.active;
  const email = loggedIn ? me.data.email : null;
  const roles = loggedIn ? (me.data.roles || []).join(', ') : null;

  // Simple HTML (no templating to keep it MVP)
  res.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${APP_NAME}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
      .btn { display:inline-block; padding: .7rem 1rem; border-radius: .5rem; text-decoration:none; border:1px solid #ccc }
      .btn-primary { background:#111; color:#fff; border-color:#111 }
      .card { border:1px solid #eee; border-radius: .75rem; padding:1rem; margin:1rem 0; }
      code { background:#f6f6f6; padding:.15rem .35rem; border-radius:.25rem; }
      small { color:#666 }
    </style>
  </head>
  <body>
    <h1>${APP_NAME}</h1>

    ${loggedIn ? `
      <div class="card">
        <strong>Signed in as:</strong> ${email}<br/>
        <small>Roles:</small> ${roles || '(none)'}
      </div>

      <p>
  <a class="btn btn-primary" href="/studentmvp/restricted">Go to restricted page</a>
        <a class="btn" href="${HYDRA_BASE_URL}/logout?returnTo=${encodeURIComponent(returnTo)}">Log out</a>
      </p>
    ` : `
      <p>This site is <em>public by default</em>. To access a gated area, sign in with your New Paltz account.</p>
      <p>
        <a class="btn btn-primary" href="${HYDRA_BASE_URL}/login?returnTo=${encodeURIComponent(returnTo)}">
          Login with New Paltz
        </a>
      </p>
      <div class="card">
        <strong>Why this is safe:</strong>
        <ul>
          <li>SAML stays on Hydra — this app never touches it.</li>
          <li>Hydra sets a short-lived, HttpOnly <code>np_access</code> token.</li>
          <li>This app simply asks Hydra “is this user valid?” via <code>/check</code>.</li>
        </ul>
      </div>
    `}

    <div class="card">
      <strong>Debug:</strong>
      <ul>
  <li><a href="/studentmvp/whoami">/whoami</a> – calls Hydra <code>/check</code> and shows what it returns</li>
  <li><a href="/studentmvp/restricted">/restricted</a> – only for roles: <code>${ALLOWED_ROLES.join(', ')}</code></li>
    <li><a href="/studentmvp/faculty">/faculty</a> – faculty only</li>
    <li><a href="/studentmvp/student">/student</a> – students only</li>
    <li><a href="/studentmvp/compsci">/compsci</a> – compsci/registered students only</li>
      </ul>
    </div>
  </body>
</html>`);
});

/**
 * A gated page:
 * - Uses requireNP to ensure np_access is valid and user has an allowed role.
 */
router.get('/restricted', requireNP, (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Restricted</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem;">
    <h1>Restricted Area</h1>
    <p>Welcome, ${req.user.email}.</p>
    <pre style="white-space:pre-wrap; background:#f6f6f6; padding:1rem; border-radius:.75rem;">${JSON.stringify(req.user, null, 2)}</pre>
  <p><a href="/studentmvp/">← Back</a></p>
  </body>
</html>`);
});

// Faculty only page
router.get('/faculty', requireNP, requireFaculty, (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Faculty Only</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem;">
    <h1>Faculty Only Area</h1>
    <p>Welcome, ${req.user.email}.</p>
    <pre style="white-space:pre-wrap; background:#f6f6f6; padding:1rem; border-radius:.75rem;">${JSON.stringify(req.user, null, 2)}</pre>
    <p><a href="/studentmvp/">← Back</a></p>
  </body>
</html>`);
});

// Student only page
router.get('/student', requireNP, requireStudent, (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Student Only</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem;">
    <h1>Student Only Area</h1>
    <p>Welcome, ${req.user.email}.</p>
    <pre style="white-space:pre-wrap; background:#f6f6f6; padding:1rem; border-radius:.75rem;">${JSON.stringify(req.user, null, 2)}</pre>
    <p><a href="/studentmvp/">← Back</a></p>
  </body>
</html>`);
});

// Compsci group only page
router.get('/compsci', requireNP, requireCompsci, (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Compsci Only</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem;">
    <h1>Compsci/Registered Students Only Area</h1>
    <p>Welcome, ${req.user.email}.</p>
    <pre style="white-space:pre-wrap; background:#f6f6f6; padding:1rem; border-radius:.75rem;">${JSON.stringify(req.user, null, 2)}</pre>
    <p><a href="/studentmvp/">← Back</a></p>
  </body>
</html>`);
});

/**
 * whoami – handy for development: show whatever Hydra says about the current cookie.
 * NOT a substitute for auth; it’s just a readout.
 */
router.get('/whoami', async (req, res) => {
  const token = req.cookies?.np_access;
  const me = await verifyWithHydra(token);
  res.status(me.ok ? 200 : (me.status || 500)).json(me.ok ? me.data : { active:false });
});

// Mount the router at /studentmvp
app.use('/', router);

// Start the server
const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`Student app listening on port ${PORT}`);
  console.log(`HYDRA_BASE_URL: ${HYDRA_BASE_URL}`);
  console.log(`Allowed roles for /restricted: ${ALLOWED_ROLES.join(', ')}`);
  console.log('App mounted at /studentmvp/');
});
