// index.js - SAML + metadata discovery + RelayState + sitewide JWT cookie + /check + JWKS (CommonJS)
require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const session = require('express-session');
const passport = require('passport');
const { Strategy: SamlStrategy } = require('passport-saml');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
expressWs(app); // Enable WebSocket support
const PORT = process.env.PORT || 6969;

// ---------- REQUIRED CONFIG ----------
const BASE_URL = process.env.BASE_URL || 'https://hydra.newpaltz.edu';
const METADATA_URL = process.env.METADATA_URL; // Azure federation metadata URL
const CALLBACK_PATH = process.env.SAML_CALLBACK_PATH || '/login/callback';
const CALLBACK_URL = process.env.CALLBACK_URL || `${BASE_URL}${CALLBACK_PATH}`;

// *** MUST MATCH Azure "Identifier (Entity ID)" EXACTLY (yours was "hydra.newpaltz.edu") ***
const SAML_SP_ENTITY_ID = process.env.SAML_SP_ENTITY_ID;

// JWT / cookie config
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || 'hydra.newpaltz.edu';
const JWT_TTL_SECONDS = parseInt(process.env.JWT_TTL_SECONDS || '900', 10); // 15m
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'npsites';
const JWT_KEY_ID = process.env.JWT_KEY_ID || 'hydra-key-1';

// Optional static RSA keys (PEM). If not provided, we generate an ephemeral pair on boot.
const JWT_PRIVATE_KEY_PEM = process.env.JWT_PRIVATE_KEY_FILE ? fs.readFileSync(process.env.JWT_PRIVATE_KEY_FILE, 'utf8') : null;
const JWT_PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY_FILE ? fs.readFileSync(process.env.JWT_PUBLIC_KEY_FILE, 'utf8') : null;

if (!METADATA_URL) {
  console.error('Missing METADATA_URL (Azure federation metadata URL).');
  process.exit(1);
}
if (!SAML_SP_ENTITY_ID) {
  console.error('Missing SAML_SP_ENTITY_ID. Set it to the exact Azure "Identifier (Entity ID)".');
  process.exit(1);
}

// ---------- Helpers ----------
function sanitizeReturnTo(input) {
  try {
    const u = new URL(input || '/', BASE_URL);
    const base = new URL(BASE_URL);
    if (u.origin === base.origin) return (u.pathname || '/') + (u.search || '') + (u.hash || '');
  } catch (_e) { }
  return '/';
}

/**
 * Loads Identity Provider (IdP) SAML metadata from a given URL and extracts key information.
 *
 * @async
 * @param {string} url - The URL to fetch the IdP metadata XML from.
 * @returns {Promise<{ entryPoint: string, certificate: string, logoutUrl: string | null }>} 
 *   Resolves with an object containing:
 *   - entryPoint: The SSO endpoint URL (preferably HTTP-Redirect binding).
 *   - certificate: The IdP's signing X.509 certificate (base64, no whitespace).
 *   - logoutUrl: The SLO endpoint URL, or null if not present.
 * @throws {Error} If the metadata cannot be fetched, parsed, or required fields are missing.
 */
async function loadIdPFromMetadata(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Metadata fetch failed: ${resp.status}`);
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const md = parser.parse(xml);

  const ed = md['EntityDescriptor'] || md['md:EntityDescriptor'];
  const idp = ed?.['IDPSSODescriptor'] || ed?.['md:IDPSSODescriptor'];
  if (!idp) throw new Error('Metadata missing IDPSSODescriptor');

  // SSO endpoint (prefer HTTP-Redirect)
  let sso = idp['SingleSignOnService'] || idp['md:SingleSignOnService'];
  sso = Array.isArray(sso) ? sso : [sso];
  const redirect = sso.find(s => (s['@_Binding'] || '').includes('HTTP-Redirect'));
  const entryPoint = (redirect || sso[0])?.['@_Location'];
  if (!entryPoint) throw new Error('Metadata missing SSO Location');

  // Signing certificate
  let kd = idp['KeyDescriptor'] || idp['md:KeyDescriptor'];
  kd = Array.isArray(kd) ? kd : [kd];
  const signing = kd.find(k => !k?.['@_use'] || k['@_use'] === 'signing') || kd[0];
  const ki = signing?.['KeyInfo'] || signing?.['ds:KeyInfo'];
  const x = ki?.['X509Data'] || ki?.['ds:X509Data'];
  const certRaw = x?.['X509Certificate'] || x?.['ds:X509Certificate'];
  const cert = (Array.isArray(certRaw) ? certRaw[0] : certRaw || '').replace(/\s+/g, '');
  if (!cert) throw new Error('Metadata missing IdP X509Certificate');

  // Optional SLO
  const slo = idp['SingleLogoutService'] || idp['md:SingleLogoutService'];
  const logoutUrl = (Array.isArray(slo) ? slo[0] : slo)?.['@_Location'] || null;

  return { entryPoint, certificate: cert, logoutUrl };
}

// SAML claim URIs
const URI = {
  groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  given: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  family: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  upn: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  affiliation: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/eduPersonPrimaryAffiliation',
  displayName: 'http://schemas.microsoft.com/identity/claims/displayname',
  tenantId: 'http://schemas.microsoft.com/identity/claims/tenantid',
  objectId: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
  idp: 'http://schemas.microsoft.com/identity/claims/identityprovider',
  roles: 'http://schemas.microsoft.com/identity/claims/role',
  amr: 'http://schemas.microsoft.com/claims/authnmethodsreferences'
};

const toArray = v => (!v ? [] : Array.isArray(v) ? v : [v]);
const getClaim = (p, k, fb) => p[k] ?? (fb ? p[fb] : undefined);

/**
 * Extracts and normalizes user information from a SAML profile object.
 *
 * @param {Object} profile - The SAML profile object containing user claims.
 * @returns {Object} An object containing normalized user attributes:
 *   @property {string} sub - Subject identifier (nameID, oid, email, or name).
 *   @property {string} email - User's email address.
 *   @property {string} name - User's name (UPN or email).
 *   @property {string} given_name - User's given name.
 *   @property {string} family_name - User's family name.
 *   @property {string} display_name - User's display name.
 *   @property {string} tenant_id - Tenant identifier.
 *   @property {string} oid - Object identifier.
 *   @property {string} idp - Identity provider identifier.
 *   @property {Array<string>} groups - Array of group names.
 *   @property {string} affiliation - User's affiliation (e.g., 'student', 'faculty').
 *   @property {Array<string>} roles - Array of user roles, including affiliation and domain-specific roles.
 *   @property {Array<string>} amr - Array of authentication methods.
 */
function collectUserFromSaml(profile) {
  const email = getClaim(profile, URI.email) || profile.email || getClaim(profile, 'mail') || getClaim(profile, URI.upn);
  const given_name = getClaim(profile, URI.given) || profile.givenName || '';
  const family_name = getClaim(profile, URI.family) || profile.surname || '';
  const name = getClaim(profile, URI.upn) || email || '';
  const display_name = getClaim(profile, URI.displayName) || name || '';
  const tenant_id = getClaim(profile, URI.tenantId) || '';
  const oid = getClaim(profile, URI.objectId) || '';
  const idp = getClaim(profile, URI.idp) || '';
  const affiliation = (getClaim(profile, URI.affiliation) || '').toString().toLowerCase();
  const groups = toArray(getClaim(profile, URI.groups)).map(String);
  const rolesSet = new Set([...toArray(getClaim(profile, URI.roles)).map(r => String(r).toLowerCase())]);
  if (affiliation) rolesSet.add(affiliation); // 'student', 'faculty', etc.
  if (email?.endsWith('@newpaltz.edu')) rolesSet.add('np');
  const amr = toArray(getClaim(profile, URI.amr)).map(String);
  const sub = profile.nameID || oid || email || name || 'unknown-sub';

  return {
    sub, email, name, given_name, family_name, display_name,
    tenant_id, oid, idp,
    groups, affiliation,
    roles: Array.from(rolesSet),
    amr
  };
}

// ---------- JWT keys (PEM) & JWKS ----------
let privateKeyPem = JWT_PRIVATE_KEY_PEM;
let publicKeyPem = JWT_PUBLIC_KEY_PEM;
let jwk = null;

/**
 * Ensures that RSA key pairs and their corresponding JWK are available.
 * If PEM-encoded private and public keys are provided, builds a JWK from the public key.
 * Otherwise, generates an ephemeral RSA key pair and exports them in PEM and JWK formats.
 * Sets the global variables `privateKeyPem`, `publicKeyPem`, and `jwk`.
 * Warns if ephemeral keys are used (not suitable for production).
 *
 * @throws {Error} If key generation or export fails.
 */
function ensureKeys() {
  if (privateKeyPem && publicKeyPem) {
    // build JWK from provided public key
    const pubObj = crypto.createPublicKey(publicKeyPem);
    try {
      const jwkExport = pubObj.export({ format: 'jwk' }); // Node 16+ supports this
      jwk = { ...jwkExport, use: 'sig', kid: JWT_KEY_ID, alg: 'RS256' };
    } catch {
      // Fallback: no JWKS if export unsupported
      jwk = null;
    }
    return;
  }

  // Generate ephemeral RSA key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  try {
    const jwkExport = publicKey.export({ format: 'jwk' });
    jwk = { ...jwkExport, use: 'sig', kid: JWT_KEY_ID, alg: 'RS256' };
  } catch {
    jwk = null;
  }
  console.warn('[JWT] Using ephemeral RSA key pair — set JWT_PRIVATE_KEY_PEM/JWT_PUBLIC_KEY_PEM for prod.');
}
ensureKeys();

/**
 * Signs and generates a JWT access token using the provided user claims.
 *
 * @param {Object} claims - The user claims to include in the JWT payload.
 * @param {string} claims.email - The user's email address.
 * @param {string} claims.name - The user's principal name (UPN), typically same as email.
 * @param {string} claims.given_name - The user's given (first) name.
 * @param {string} claims.family_name - The user's family (last) name.
 * @param {string} claims.display_name - The user's full display name.
 * @param {string} claims.tenant_id - The Azure AD tenant ID (school identifier).
 * @param {string} claims.oid - The user's unique object ID in Azure AD.
 * @param {string} claims.idp - The identity provider URL.
 * @param {Array<string>} claims.groups - The groups the user belongs to.
 * @param {string|Array<string>} claims.affiliation - The user's affiliation(s).
 * @param {Array<string>} claims.roles - The user's roles.
 * @param {Array<string>} claims.amr - The authentication methods references.
 * @param {string} claims.sub - The subject identifier for the JWT.
 * @returns {string} The signed JWT access token.
 */
function signAccessToken(claims) {
  // Payload kept reasonably small; students can also call /check for details
  const payload = {
    email: claims.email,
    name: claims.name, // the UPN (User Principal Name), This is the same as email for us. Ignoring.
    given_name: claims.given_name,
    family_name: claims.family_name,
    display_name: claims.display_name, // Full name
    school_id: claims.tenant_id, // This is the Azure AD tenant ID which means "New Paltz"
    id: claims.oid, // This is the user's unique object ID in Azure AD (unlikely to be phished/spoofed)
    idp: claims.idp, // Identity Provider (e.g. "https://sts.windows.net/..."). 
    groups: claims.groups,
    affiliation: claims.affiliation,
    roles: claims.roles,
    amr: claims.amr
  };

  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    keyid: JWT_KEY_ID,
    subject: claims.sub,
    issuer: BASE_URL,
    audience: JWT_AUDIENCE,
    expiresIn: JWT_TTL_SECONDS
  });
}

/**
 * Verifies a JWT access token using the provided public key and validation options.
 *
 * @param {string} token - The JWT access token to verify.
 * @returns {object} The decoded token payload if verification is successful.
 * @throws {Error} If the token is invalid or verification fails.
 */
function verifyAccessToken(token) {
  return jwt.verify(token, publicKeyPem, {
    algorithms: ['RS256'],
    issuer: BASE_URL,
    audience: JWT_AUDIENCE
  });
}

/**
 * Sets the 'np_access' cookie on the response with the provided token and options.
 *
 * @param {import('express').Response} res - The Express response object.
 * @param {string} token - The JWT token to set as the cookie value.
 */
function setNpCookie(res, token) {
  res.cookie('np_access', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: COOKIE_DOMAIN,       // remove or change if developing on localhost
    path: '/',
    maxAge: JWT_TTL_SECONDS * 1000
  });
}

// ---------- App + middleware ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true, // Extend session on each request
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

const ensureAuthenticated = (req, res, next) =>
  req.isAuthenticated() ? next() : res.redirect('/login');

// ---------- Boot ----------
(async function start() {
  try {
    const { entryPoint, certificate, logoutUrl } = await loadIdPFromMetadata(METADATA_URL);

    console.log('[SAML] Using:');
    console.log('  SP Entity ID (issuer):', SAML_SP_ENTITY_ID);
    console.log('  ACS (Reply URL):       ', CALLBACK_URL);
    console.log('  IdP SSO entryPoint:    ', entryPoint);
    console.log('  IdP SLO (optional):    ', logoutUrl || '(none)');

    const saml = new SamlStrategy(
      {
        issuer: SAML_SP_ENTITY_ID,       // *** must match Azure Identifier (Entity ID) ***
        callbackUrl: CALLBACK_URL,       // must match Azure Reply URL (ACS)
        entryPoint,
        cert: certificate,               // base64, no PEM headers
        logoutUrl,

        // Security / compat
        identifierFormat: null,
        validateInResponseTo: true,
        disableRequestedAuthnContext: true,
        acceptedClockSkewMs: 2 * 60 * 1000,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: true,
        passReqToCallback: true
      },
      (req, profile, done) => {
        try {
          if (process.env.NODE_ENV !== 'production') {
            console.log('Authentication successful. Profile:', JSON.stringify(profile, null, 2));
          }
          const user = collectUserFromSaml(profile);
          if (process.env.NODE_ENV !== 'production') {
            console.log('Extracted user data:', user);
          }
          done(null, user);
        } catch (e) {
          done(e);
        }
      }
    );

    passport.use(saml);

    // ----- Routes -----

    // Publish SP metadata (minimal)
    app.get('/saml/metadata', (_req, res) => {
      res.type('application/xml').send(saml.generateServiceProviderMetadata());
    });

    // Start login, capture return (RelayState)
    app.get('/login', (req, res, next) => {
      const returnTo = sanitizeReturnTo(req.query.returnTo || req.get('referer') || '/dashboard');
      console.log('Login requested. ReturnTo:', returnTo);
      req.session.returnTo = returnTo;
      passport.authenticate('saml', {
        failureRedirect: '/login-failed',
        additionalParams: { RelayState: returnTo }
      })(req, res, next);
    });

    function captureRelayState(req, _res, next) {
      req._relayState = req.body?.RelayState;
      next();
    }

    // ACS (SAML callback) — mint JWT + cookie, then bounce back
    app.post(
      CALLBACK_PATH,
      captureRelayState,
      passport.authenticate('saml', { failureRedirect: '/login-failed' }),
      (req, res) => {
        const token = signAccessToken(req.user);
        setNpCookie(res, token);

        const returnTo = sanitizeReturnTo(req._relayState || req.session.returnTo || '/dashboard');
        console.log('SAML callback. Redirecting to:', returnTo);
        delete req.session.returnTo;
        res.redirect(returnTo);
      }
    );

    // Optional: exchange session -> fresh token (for XHR use-cases)
    app.post('/token', (req, res) => {
      if (!req.isAuthenticated?.() || !req.user) return res.status(401).json({ error: 'not_authenticated' });
      try {
        const access_token = signAccessToken(req.user);
        res.json({
          access_token,
          expires_in: JWT_TTL_SECONDS,
          sub: req.user.sub,
          email: req.user.email,
          roles: req.user.roles,
          groups: req.user.groups,
          affiliation: req.user.affiliation
        });
      } catch {
        res.status(500).json({ error: 'token_issue' });
      }
    });

    // Verify endpoint for student backends (or they can verify locally with JWKS)
    app.post('/check', (req, res) => {
      const hdr = req.headers.authorization || '';
      const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
      const token = bearer || req.cookies?.np_access;
      if (!token) return res.status(401).json({ active: false, reason: 'missing_token' });

      try {
        const payload = verifyAccessToken(token);
        return res.json({
          active: true,
          sub: payload.sub,
          email: payload.email,
          roles: payload.roles || [],
          groups: payload.groups || [],
          affiliation: payload.affiliation || '',
          name: payload.name || '',
          given_name: payload.given_name || '',
          family_name: payload.family_name || '',
          display_name: payload.display_name || '',
          tid: payload.tid || '',
          oid: payload.oid || '',
          idp: payload.idp || '',
          amr: payload.amr || [],
          exp: payload.exp,
          kid: JWT_KEY_ID
        });
      } catch (e) {
        const msg = String(e).toLowerCase();
        const code = msg.includes('expired') ? 401 : 403;
        return res.status(code).json({ active: false, reason: 'invalid_or_expired' });
      }
    });

    app.get('/auth/verify', (req, res) => {
      const token = req.cookies?.np_access;

      if (!token) {
        return res.status(401).send('Unauthorized: Missing token');
      }

      try {
        const payload = verifyAccessToken(token);

        // Set headers for Traefik to forward to backend
        res.set('X-Forwarded-User', payload.email || payload.sub);
        res.set('X-Forwarded-Email', payload.email);
        res.set('X-Forwarded-Roles', (payload.roles || []).join(','));

        // Return 200 to allow request
        return res.status(200).send('OK');
      } catch (e) {
        const msg = String(e).toLowerCase();
        const code = msg.includes('expired') ? 401 : 403;
        return res.status(code).send('Unauthorized: Invalid or expired token');
      }
    });

    // JWKS for local verification by student backends
    app.get('/.well-known/jwks.json', (_req, res) => {
      if (!jwk) return res.status(501).json({ error: 'jwks_unavailable' });
      res.json({ keys: [jwk] });
    });

    // Mount API routes for OpenWebUI account management
    try {
      const webuiApiRouter = require('./routes/webui-api');
      app.use('/dashboard/api/webui', webuiApiRouter);
    } catch (e) {
      console.warn('[Init] webui-api routes not mounted:', e?.message || e);
    }

    // Mount API routes for n8n management
    try {
      const n8nApiRouter = require('./routes/n8n-api');
      app.use('/dashboard/api/n8n', n8nApiRouter);
    } catch (e) {
      console.warn('[Init] n8n-api routes not mounted:', e?.message || e);
    }

    // Mount API routes for student containers (behind auth)
    try {
      const containersRouter = require('./routes/containers');
      app.use('/dashboard/api/containers', ensureAuthenticated, containersRouter);
    } catch (e) {
      console.warn('[Init] containers routes not mounted:', e?.message || e);
    }

    // Mount API routes for resource requests (behind auth)
    try {
      const resourceRequestsRouter = require('./routes/resource-requests');
      app.use('/dashboard/api/resource-requests', ensureAuthenticated, resourceRequestsRouter);
    } catch (e) {
      console.warn('[Init] resource-requests routes not mounted:', e?.message || e);
    }

    // Mount admin API routes (behind auth, admin check in router)
    try {
      const adminRouter = require('./routes/admin');
      app.use('/dashboard/api/admin', ensureAuthenticated, adminRouter);
    } catch (e) {
      console.warn('[Init] admin routes not mounted:', e?.message || e);
    }

    // Mount API routes for server status and metrics (public)
    try {
      const serversApiRouter = require('./routes/servers-api');
      app.use('/api/servers', serversApiRouter);
    } catch (e) {
      console.warn('[Init] servers-api routes not mounted:', e?.message || e);
    }

    // WebSocket terminal for containers (behind auth)
    app.ws('/dashboard/ws/containers/:name/exec', async (ws, req) => {
      try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
          ws.close();
          return;
        }
        const Docker = require('dockerode');
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        const username = String(req.user.email).split('@')[0];
        const nameParam = String(req.params.name || '').trim();
        if (!nameParam) {
          ws.close();
          return;
        }

        const container = docker.getContainer(nameParam);
        const info = await container.inspect();
        const labels = info?.Config?.Labels || {};
        if (labels['hydra.owner'] !== username || labels['hydra.managed_by'] !== 'hydra-saml-auth') {
          ws.close();
          return;
        }

        // Create exec instance - use login shell to source .bashrc for nvm, etc.
        const exec = await container.exec({
          Cmd: ['/bin/bash', '-l'],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true
        });

        const stream = await exec.start({ hijack: true, Tty: true, stdin: true });

        // Pipe data between WebSocket and Docker stream
        stream.on('data', (chunk) => {
          try {
            if (ws.readyState === ws.OPEN) {
              ws.send(chunk);
            }
          } catch { }
        });

        stream.on('end', () => {
          try { ws.close(); } catch { }
        });

        ws.on('message', (msg) => {
          try {
            stream.write(msg);
          } catch { }
        });

        ws.on('close', () => {
          try { stream.end(); } catch { }
        });

        ws.on('error', () => {
          try { stream.end(); } catch { }
        });
      } catch (e) {
        console.error('[ws] exec error:', e);
        try { ws.close(); } catch { }
      }
    });

    // Basic pages
    app.get('/', (req, res) => {
      res.redirect(req.isAuthenticated() ? '/dashboard' : '/login');
    });

    // Admin users list for approval panel
    const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);

    app.get('/dashboard', (req, res) => {
      if (!req.isAuthenticated()) return res.redirect('/login');
      const viewUser = {
        firstName: req.user.given_name || '',
        lastName: req.user.family_name || '',
        email: req.user.email || '',
        displayName: req.user.display_name || req.user.name || req.user.email || '',
        oid: req.user.oid || req.user.id || ''
      };
      const isAdmin = ADMIN_USERS.includes((req.user.email || '').toLowerCase());
      res.render('dashboard', { user: viewUser, baseUrl: BASE_URL, isAdmin });
    });

    // Cluster status page (public, Bloomberg terminal style)
    app.get('/servers', (_req, res) => {
      res.render('servers');
    });

    app.get('/logout', (req, res, next) => {
      const returnTo = sanitizeReturnTo(req.query.returnTo || req.get('referer') || '/dashboard');
      console.log('Logout requested. ReturnTo:', returnTo);

      res.clearCookie('np_access', { domain: COOKIE_DOMAIN, path: '/' });
      req.logout(err => (err ? next(err) : res.redirect(returnTo)));
    });

    app.get('/login-failed', (_req, res) => res.status(401).send('Authentication failed.'));

    // Health check endpoint for k8s probes
    app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

    // Start background services
    try {
      const containerReminder = require('./services/container-reminder');
      containerReminder.start();

      // Admin endpoint to manually trigger reminders (requires admin role)
      app.post('/api/admin/send-reminders', ensureAuthenticated, async (req, res) => {
        if (!req.user?.roles?.includes('admin')) {
          return res.status(403).json({ error: 'Admin access required' });
        }
        try {
          const result = await containerReminder.triggerReminders();
          res.json({ success: true, ...result });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
    } catch (e) {
      console.warn('[Init] container-reminder service not started:', e?.message || e);
    }

    // Initialize database schema for resource management
    try {
      const { initializeSchema, expireOldRequests } = require('./services/db-init');
      await initializeSchema();
      await expireOldRequests();
      console.log('[Init] Database schema initialized');
    } catch (e) {
      console.warn('[Init] Database schema initialization failed:', e?.message || e);
    }

    // Start metrics collection service
    try {
      const metricsCollector = require('./services/metrics-collector');
      metricsCollector.start();
      console.log('[Init] Metrics collector started');
    } catch (e) {
      console.warn('[Init] metrics-collector service not started:', e?.message || e);
    }

    // Start security monitoring service
    try {
      const securityMonitor = require('./services/security-monitor');
      securityMonitor.start();
      console.log('[Init] Security monitor started');
    } catch (e) {
      console.warn('[Init] security-monitor service not started:', e?.message || e);
    }

    // Start
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on ${PORT}`);
      console.log(`Callback URL: ${CALLBACK_URL}`);
      console.log(`SP metadata: ${BASE_URL}/saml/metadata`);
      console.log(`JWT kid: ${JWT_KEY_ID}  TTL(s): ${JWT_TTL_SECONDS}`);
    });
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
})();
