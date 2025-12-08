/**
 * Role-based access control middleware.
 * Detects faculty and admin roles from SSO JWT claims.
 */

// Admin usernames (configured via environment or hardcoded)
const ADMIN_USERS = (process.env.ADMIN_USERS || '').split(',').filter(Boolean);

// Faculty group patterns (Azure AD groups)
const FACULTY_GROUPS = [
    'Faculty',
    'Instructors',
    'CS-Faculty',
    'IT-Faculty'
];

// Admin group patterns
const ADMIN_GROUPS = [
    'Administrators',
    'IT-Admins',
    'Hydra-Admins'
];

/**
 * Extract roles from user object (populated by SAML/JWT)
 */
function extractRoles(user) {
    if (!user) return { isStudent: false, isFaculty: false, isAdmin: false };

    const email = user.email || '';
    const username = email.split('@')[0];
    const groups = user.groups || user['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'] || [];
    const roles = user.roles || [];

    // Check if admin by username
    const isAdminByUsername = ADMIN_USERS.includes(username) || ADMIN_USERS.includes(email);

    // Check if admin by group
    const isAdminByGroup = groups.some(g =>
        ADMIN_GROUPS.some(pattern =>
            g.toLowerCase().includes(pattern.toLowerCase())
        )
    );

    // Check if faculty by group
    const isFacultyByGroup = groups.some(g =>
        FACULTY_GROUPS.some(pattern =>
            g.toLowerCase().includes(pattern.toLowerCase())
        )
    );

    // Check by role claim
    const isFacultyByRole = roles.includes('faculty') || roles.includes('instructor');
    const isAdminByRole = roles.includes('admin') || roles.includes('administrator');

    const isAdmin = isAdminByUsername || isAdminByGroup || isAdminByRole;
    const isFaculty = isFacultyByGroup || isFacultyByRole || isAdmin; // Admins are also faculty
    const isStudent = !isFaculty && !isAdmin;

    return {
        isStudent,
        isFaculty,
        isAdmin,
        username,
        email
    };
}

/**
 * Middleware to require authentication
 */
function requireAuth(req, res, next) {
    if (!req.isAuthenticated?.() || !req.user?.email) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    req.userRoles = extractRoles(req.user);
    next();
}

/**
 * Middleware to require faculty role
 */
function requireFaculty(req, res, next) {
    if (!req.isAuthenticated?.() || !req.user?.email) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const roles = extractRoles(req.user);
    req.userRoles = roles;

    if (!roles.isFaculty && !roles.isAdmin) {
        return res.status(403).json({ success: false, message: 'Faculty access required' });
    }

    next();
}

/**
 * Middleware to require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.isAuthenticated?.() || !req.user?.email) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const roles = extractRoles(req.user);
    req.userRoles = roles;

    if (!roles.isAdmin) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    next();
}

/**
 * Get user role info
 */
function getUserRoles(user) {
    return extractRoles(user);
}

module.exports = {
    extractRoles,
    requireAuth,
    requireFaculty,
    requireAdmin,
    getUserRoles,
    ADMIN_USERS,
    FACULTY_GROUPS,
    ADMIN_GROUPS
};
