/**
 * Course management API.
 * Faculty and admins can create courses, students can join via course codes.
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { requireAuth, requireFaculty, requireAdmin, getUserRoles } = require('../middleware/roles');

const router = express.Router();
const COURSES_FILE = path.join(__dirname, '..', 'data', 'courses.json');

// Ensure data directory exists
async function ensureDataDir() {
    const dataDir = path.dirname(COURSES_FILE);
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (e) {
        // Ignore if already exists
    }
}

// Load courses from file
async function loadCourses() {
    try {
        await ensureDataDir();
        const data = await fs.readFile(COURSES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return {};
        }
        throw e;
    }
}

// Save courses to file
async function saveCourses(courses) {
    await ensureDataDir();
    await fs.writeFile(COURSES_FILE, JSON.stringify(courses, null, 2));
}

// Generate course code
function generateCourseCode(prefix) {
    const semester = getSemesterCode();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${semester}-${random}`;
}

// Get current semester code (F24, S25, etc.)
function getSemesterCode() {
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = now.getMonth() + 1;
    const semester = month >= 8 ? 'F' : month >= 1 && month <= 5 ? 'S' : 'U';
    return `${semester}${year}`;
}

// List courses (faculty sees their own, admin sees all)
// GET /dashboard/api/courses
router.get('/', requireAuth, async (req, res) => {
    try {
        const courses = await loadCourses();
        const roles = getUserRoles(req.user);
        const username = roles.username;

        let filteredCourses;
        if (roles.isAdmin) {
            // Admin sees all courses
            filteredCourses = Object.values(courses);
        } else if (roles.isFaculty) {
            // Faculty sees courses they created
            filteredCourses = Object.values(courses).filter(c => c.instructor === username || c.instructorEmail === req.user.email);
        } else {
            // Student sees courses they're enrolled in
            filteredCourses = Object.values(courses).filter(c => c.students && c.students.includes(username));
        }

        return res.json({
            success: true,
            courses: filteredCourses.map(c => ({
                code: c.code,
                name: c.name,
                instructor: c.instructor,
                createdAt: c.createdAt,
                expiresAt: c.expiresAt,
                studentCount: c.students ? c.students.length : 0,
                defaultTier: c.defaultTier,
                defaultTemplate: c.defaultTemplate,
                isOwner: c.instructor === username || c.instructorEmail === req.user.email
            }))
        });
    } catch (err) {
        console.error('[courses] list error:', err);
        return res.status(500).json({ success: false, message: 'Failed to list courses' });
    }
});

// Create a new course (faculty/admin only)
// POST /dashboard/api/courses
// Body: { name, prefix?, expiresAt?, defaultTier?, defaultTemplate?, maxContainers? }
router.post('/', requireFaculty, async (req, res) => {
    try {
        const { name, prefix, expiresAt, defaultTier, defaultTemplate, maxContainers } = req.body;

        if (!name || name.trim().length < 3) {
            return res.status(400).json({ success: false, message: 'Course name must be at least 3 characters' });
        }

        const roles = getUserRoles(req.user);
        const coursePrefix = prefix || name.replace(/[^A-Z0-9]/gi, '').substring(0, 6).toUpperCase();
        const code = generateCourseCode(coursePrefix);

        const courses = await loadCourses();

        // Calculate expiration (default: end of semester)
        let expiration = expiresAt;
        if (!expiration) {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            if (month >= 8) {
                // Fall semester - expires Jan 15
                expiration = new Date(year + 1, 0, 15).toISOString();
            } else if (month >= 1 && month <= 5) {
                // Spring semester - expires Jun 15
                expiration = new Date(year, 5, 15).toISOString();
            } else {
                // Summer - expires Aug 15
                expiration = new Date(year, 7, 15).toISOString();
            }
        }

        const course = {
            code,
            name: name.trim(),
            instructor: roles.username,
            instructorEmail: req.user.email,
            createdAt: new Date().toISOString(),
            expiresAt: expiration,
            students: [],
            defaultTier: defaultTier || 'small',
            defaultTemplate: defaultTemplate || 'default',
            maxContainersPerStudent: maxContainers || 2
        };

        courses[code] = course;
        await saveCourses(courses);

        return res.json({
            success: true,
            course: {
                code: course.code,
                name: course.name,
                expiresAt: course.expiresAt,
                defaultTier: course.defaultTier,
                defaultTemplate: course.defaultTemplate
            }
        });
    } catch (err) {
        console.error('[courses] create error:', err);
        return res.status(500).json({ success: false, message: 'Failed to create course' });
    }
});

// Get course details
// GET /dashboard/api/courses/:code
router.get('/:code', requireAuth, async (req, res) => {
    try {
        const courses = await loadCourses();
        const code = req.params.code.toUpperCase();
        const course = courses[code];

        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const roles = getUserRoles(req.user);
        const isOwner = course.instructor === roles.username || course.instructorEmail === req.user.email;
        const isEnrolled = course.students && course.students.includes(roles.username);

        if (!isOwner && !roles.isAdmin && !isEnrolled) {
            return res.status(403).json({ success: false, message: 'Not authorized to view this course' });
        }

        return res.json({
            success: true,
            course: {
                code: course.code,
                name: course.name,
                instructor: course.instructor,
                createdAt: course.createdAt,
                expiresAt: course.expiresAt,
                students: isOwner || roles.isAdmin ? course.students : undefined,
                studentCount: course.students ? course.students.length : 0,
                defaultTier: course.defaultTier,
                defaultTemplate: course.defaultTemplate,
                maxContainersPerStudent: course.maxContainersPerStudent,
                isOwner
            }
        });
    } catch (err) {
        console.error('[courses] get error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get course' });
    }
});

// Join a course (student)
// POST /dashboard/api/courses/:code/join
router.post('/:code/join', requireAuth, async (req, res) => {
    try {
        const courses = await loadCourses();
        const code = req.params.code.toUpperCase();
        const course = courses[code];

        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        // Check if course has expired
        if (new Date(course.expiresAt) < new Date()) {
            return res.status(400).json({ success: false, message: 'Course has expired' });
        }

        const roles = getUserRoles(req.user);
        const username = roles.username;

        if (!course.students) {
            course.students = [];
        }

        if (course.students.includes(username)) {
            return res.json({ success: true, message: 'Already enrolled in this course' });
        }

        course.students.push(username);
        await saveCourses(courses);

        return res.json({
            success: true,
            message: 'Successfully joined course',
            course: {
                code: course.code,
                name: course.name,
                defaultTier: course.defaultTier,
                defaultTemplate: course.defaultTemplate
            }
        });
    } catch (err) {
        console.error('[courses] join error:', err);
        return res.status(500).json({ success: false, message: 'Failed to join course' });
    }
});

// Leave a course (student)
// POST /dashboard/api/courses/:code/leave
router.post('/:code/leave', requireAuth, async (req, res) => {
    try {
        const courses = await loadCourses();
        const code = req.params.code.toUpperCase();
        const course = courses[code];

        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const roles = getUserRoles(req.user);
        const username = roles.username;

        if (!course.students || !course.students.includes(username)) {
            return res.json({ success: true, message: 'Not enrolled in this course' });
        }

        course.students = course.students.filter(s => s !== username);
        await saveCourses(courses);

        return res.json({ success: true, message: 'Left course successfully' });
    } catch (err) {
        console.error('[courses] leave error:', err);
        return res.status(500).json({ success: false, message: 'Failed to leave course' });
    }
});

// Delete a course (owner/admin only)
// DELETE /dashboard/api/courses/:code
router.delete('/:code', requireFaculty, async (req, res) => {
    try {
        const courses = await loadCourses();
        const code = req.params.code.toUpperCase();
        const course = courses[code];

        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const roles = getUserRoles(req.user);
        const isOwner = course.instructor === roles.username || course.instructorEmail === req.user.email;

        if (!isOwner && !roles.isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized to delete this course' });
        }

        delete courses[code];
        await saveCourses(courses);

        return res.json({ success: true, message: 'Course deleted' });
    } catch (err) {
        console.error('[courses] delete error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete course' });
    }
});

// Update course settings (owner/admin only)
// PATCH /dashboard/api/courses/:code
router.patch('/:code', requireFaculty, async (req, res) => {
    try {
        const courses = await loadCourses();
        const code = req.params.code.toUpperCase();
        const course = courses[code];

        if (!course) {
            return res.status(404).json({ success: false, message: 'Course not found' });
        }

        const roles = getUserRoles(req.user);
        const isOwner = course.instructor === roles.username || course.instructorEmail === req.user.email;

        if (!isOwner && !roles.isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized to update this course' });
        }

        const { name, expiresAt, defaultTier, defaultTemplate, maxContainers } = req.body;

        if (name) course.name = name.trim();
        if (expiresAt) course.expiresAt = expiresAt;
        if (defaultTier) course.defaultTier = defaultTier;
        if (defaultTemplate) course.defaultTemplate = defaultTemplate;
        if (maxContainers) course.maxContainersPerStudent = maxContainers;

        await saveCourses(courses);

        return res.json({
            success: true,
            course: {
                code: course.code,
                name: course.name,
                expiresAt: course.expiresAt,
                defaultTier: course.defaultTier,
                defaultTemplate: course.defaultTemplate,
                maxContainersPerStudent: course.maxContainersPerStudent
            }
        });
    } catch (err) {
        console.error('[courses] update error:', err);
        return res.status(500).json({ success: false, message: 'Failed to update course' });
    }
});

module.exports = router;
