/**
 * middleware/roles.js — the ONE place that decides who is admin / faculty / ta.
 *
 *   admin   = email in ADMIN_USERS env OR user_whitelist.role = 'admin'
 *   faculty = SAML affiliation 'faculty' OR user_whitelist.role = 'faculty'
 *   ta      = user_whitelist.role = 'ta'
 *   staff   = admin | faculty | ta
 *
 * Faculty is NOT admin. Infra deploys, whitelist management, pod terminals and
 * the admin dashboard are admin-only; faculty/ta get the staff gate where a
 * route genuinely needs instructor access. Before 2026-10-01 five copies of
 * this check treated any faculty login as a full admin.
 */
const db = require('../services/db-init');

const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);

/**
 * @param {object|null} user  req.user (email, affiliation) or a JWT payload
 * @param {object} [opts]     { adminUsers: string[], lookup: async email => {role}|null } (tests)
 */
async function resolveRoles(user, opts = {}) {
  const adminUsers = (opts.adminUsers || ADMIN_USERS).map(e => e.toLowerCase());
  const lookup = opts.lookup || db.getWhitelistEntry;
  const email = String(user?.email || '').toLowerCase();
  const affiliation = String(user?.affiliation || '').toLowerCase();

  let dbRole = null;
  if (email) {
    try { dbRole = (await lookup(email))?.role || null; }
    catch (e) { console.warn('[roles] whitelist lookup failed:', e.message); }
  }

  const isAdmin   = !!email && (adminUsers.includes(email) || dbRole === 'admin');
  const isFaculty = !isAdmin && (affiliation === 'faculty' || dbRole === 'faculty');
  const isTA      = !isAdmin && !isFaculty && dbRole === 'ta';
  const role = isAdmin ? 'admin' : isFaculty ? 'faculty' : isTA ? 'ta' : 'student';
  return { email, role, isAdmin, isFaculty, isTA, isStaff: isAdmin || isFaculty || isTA };
}

function gate(check, deniedMsg, opts) {
  return async function (req, res, next) {
    if (!req.isAuthenticated?.() || !req.user?.email) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      req.roles = await resolveRoles(req.user, opts);
    } catch (e) {
      console.error('[roles] resolve failed:', e.message);
      return res.status(500).json({ error: 'Authorization check failed' });
    }
    if (!check(req.roles)) {
      console.warn(`[roles] ${deniedMsg}: ${req.roles.email} (${req.roles.role}) ${req.method} ${req.originalUrl || ''}`);
      return res.status(403).json({ error: deniedMsg });
    }
    next();
  };
}

/** Express middleware factories. Call with no args in routes: router.use(requireAdmin()). */
const requireAdmin = (opts) => gate(r => r.isAdmin, 'Admin access required', opts);
const requireStaff = (opts) => gate(r => r.isStaff, 'Faculty, TA or admin access required', opts);

module.exports = { resolveRoles, requireAdmin, requireStaff, ADMIN_USERS };
