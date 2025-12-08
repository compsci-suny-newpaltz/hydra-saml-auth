/**
 * Admin and Faculty whitelist configuration.
 * This is the master list for SSO-based access control.
 * Users in this list get elevated privileges across all services.
 */

// Master admin list - full access to everything
const ADMIN_WHITELIST = [
    'gopeen1@newpaltz.edu',
    'manzim1@newpaltz.edu',
];

// Faculty list - can create courses, view student containers
const FACULTY_WHITELIST = [
    // Add faculty usernames or emails here
    // 'professor@newpaltz.edu',
];

// Load from environment if available
const ENV_ADMINS = (process.env.ADMIN_WHITELIST || '').split(',').filter(Boolean);
const ENV_FACULTY = (process.env.FACULTY_WHITELIST || '').split(',').filter(Boolean);

// Combine hardcoded and environment lists
const COMBINED_ADMINS = [...new Set([...ADMIN_WHITELIST, ...ENV_ADMINS])];
const COMBINED_FACULTY = [...new Set([...FACULTY_WHITELIST, ...ENV_FACULTY])];

/**
 * Check if user is in admin whitelist
 */
function isAdmin(userIdentifier) {
    if (!userIdentifier) return false;
    const normalized = userIdentifier.toLowerCase().trim();
    const username = normalized.split('@')[0];
    return COMBINED_ADMINS.some(admin => {
        const adminLower = admin.toLowerCase().trim();
        return adminLower === normalized || adminLower === username;
    });
}

/**
 * Check if user is in faculty whitelist (includes admins)
 */
function isFaculty(userIdentifier) {
    if (!userIdentifier) return false;
    if (isAdmin(userIdentifier)) return true;

    const normalized = userIdentifier.toLowerCase().trim();
    const username = normalized.split('@')[0];
    return COMBINED_FACULTY.some(faculty => {
        const facultyLower = faculty.toLowerCase().trim();
        return facultyLower === normalized || facultyLower === username;
    });
}

/**
 * Get user role from whitelist
 */
function getRole(userIdentifier) {
    if (isAdmin(userIdentifier)) return 'admin';
    if (isFaculty(userIdentifier)) return 'faculty';
    return 'student';
}

/**
 * Get all whitelisted users (for admin panel)
 */
function getAllWhitelisted() {
    return {
        admins: COMBINED_ADMINS,
        faculty: COMBINED_FACULTY
    };
}

module.exports = {
    ADMIN_WHITELIST: COMBINED_ADMINS,
    FACULTY_WHITELIST: COMBINED_FACULTY,
    isAdmin,
    isFaculty,
    getRole,
    getAllWhitelisted
};
