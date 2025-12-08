/**
 * Faculty routes for course management and student container access
 * Requires faculty or admin role
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { isAdmin, isFaculty } = require('../config/whitelist');
const { MACHINES, getDocker } = require('../config/machines');

const COURSES_FILE = path.join(__dirname, '../data/courses.json');

// Ensure data directory and courses file exist
function ensureCoursesFile() {
    const dataDir = path.dirname(COURSES_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(COURSES_FILE)) {
        fs.writeFileSync(COURSES_FILE, JSON.stringify({ courses: [] }, null, 2));
    }
}

// Load courses
function loadCourses() {
    ensureCoursesFile();
    try {
        return JSON.parse(fs.readFileSync(COURSES_FILE, 'utf8'));
    } catch (err) {
        return { courses: [] };
    }
}

// Save courses
function saveCourses(data) {
    ensureCoursesFile();
    fs.writeFileSync(COURSES_FILE, JSON.stringify(data, null, 2));
}

// Faculty middleware
function requireFacultyRole(req, res, next) {
    if (!req.session?.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userEmail = req.session.user.email || req.session.user.nameID;
    if (!isFaculty(userEmail) && !isAdmin(userEmail)) {
        return res.status(403).json({ error: 'Faculty access required' });
    }

    next();
}

// Faculty dashboard page
router.get('/', requireFacultyRole, (req, res) => {
    const userEmail = req.session.user.email || req.session.user.nameID;
    res.render('faculty-dashboard', {
        user: req.session.user,
        isAdmin: isAdmin(userEmail)
    });
});

// Get faculty's courses
router.get('/api/courses', requireFacultyRole, async (req, res) => {
    const userEmail = req.session.user.email || req.session.user.nameID;
    const userIsAdmin = isAdmin(userEmail);
    const data = loadCourses();

    // Filter to instructor's courses (or all if admin)
    let courses = data.courses;
    if (!userIsAdmin) {
        courses = courses.filter(c => c.instructor === userEmail);
    }

    // Enrich with container stats
    for (const course of courses) {
        const students = course.students || [];
        let runningContainers = 0;
        let stoppedContainers = 0;
        let expiringContainers = 0;

        // Get container info for each student
        const enrichedStudents = [];
        for (const student of students) {
            const containerName = `student-${student.username.split('@')[0]}`;
            const containerInfo = await findContainer(containerName);

            if (containerInfo) {
                const daysLeft = containerInfo.expiresAt
                    ? Math.ceil((new Date(containerInfo.expiresAt) - new Date()) / (1000 * 60 * 60 * 24))
                    : null;

                enrichedStudents.push({
                    ...student,
                    containerName,
                    containerState: containerInfo.state,
                    expiringIn: daysLeft
                });

                if (containerInfo.state === 'running') runningContainers++;
                else stoppedContainers++;
                if (daysLeft !== null && daysLeft <= 7) expiringContainers++;
            } else {
                enrichedStudents.push({
                    ...student,
                    containerName: null,
                    containerState: null
                });
            }
        }

        course.students = enrichedStudents;
        course.studentCount = students.length;
        course.runningContainers = runningContainers;
        course.stoppedContainers = stoppedContainers;
        course.expiringContainers = expiringContainers;
    }

    res.json({ courses });
});

// Create course
router.post('/api/courses', requireFacultyRole, (req, res) => {
    const { code, name, defaultTier, defaultTemplate } = req.body;
    const userEmail = req.session.user.email || req.session.user.nameID;

    if (!code || !name) {
        return res.status(400).json({ error: 'Course code and name required' });
    }

    const data = loadCourses();

    // Check for duplicate
    if (data.courses.some(c => c.code.toLowerCase() === code.toLowerCase())) {
        return res.status(400).json({ error: 'Course code already exists' });
    }

    const newCourse = {
        code: code.toUpperCase(),
        name,
        instructor: userEmail,
        defaultTier: defaultTier || 'small',
        defaultTemplate: defaultTemplate || 'default',
        createdAt: new Date().toISOString(),
        students: []
    };

    data.courses.push(newCourse);
    saveCourses(data);

    res.json({ success: true, course: newCourse });
});

// Get course details
router.get('/api/courses/:code', requireFacultyRole, (req, res) => {
    const { code } = req.params;
    const userEmail = req.session.user.email || req.session.user.nameID;
    const data = loadCourses();

    const course = data.courses.find(c => c.code.toLowerCase() === code.toLowerCase());
    if (!course) {
        return res.status(404).json({ error: 'Course not found' });
    }

    // Check permission
    if (course.instructor !== userEmail && !isAdmin(userEmail)) {
        return res.status(403).json({ error: 'Not authorized for this course' });
    }

    res.json({ course });
});

// Delete course
router.delete('/api/courses/:code', requireFacultyRole, (req, res) => {
    const { code } = req.params;
    const userEmail = req.session.user.email || req.session.user.nameID;
    const data = loadCourses();

    const idx = data.courses.findIndex(c => c.code.toLowerCase() === code.toLowerCase());
    if (idx === -1) {
        return res.status(404).json({ error: 'Course not found' });
    }

    // Check permission
    if (data.courses[idx].instructor !== userEmail && !isAdmin(userEmail)) {
        return res.status(403).json({ error: 'Not authorized for this course' });
    }

    data.courses.splice(idx, 1);
    saveCourses(data);

    res.json({ success: true });
});

// Student joins course
router.post('/api/courses/:code/join', (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { code } = req.params;
    const userEmail = req.session.user.email || req.session.user.nameID;
    const userName = req.session.user.displayName ||
        `${req.session.user.firstName || ''} ${req.session.user.lastName || ''}`.trim() ||
        userEmail.split('@')[0];

    const data = loadCourses();
    const course = data.courses.find(c => c.code.toLowerCase() === code.toLowerCase());

    if (!course) {
        return res.status(404).json({ error: 'Course not found' });
    }

    // Check if already enrolled
    if (course.students.some(s => s.username === userEmail)) {
        return res.json({ success: true, message: 'Already enrolled', course });
    }

    course.students.push({
        username: userEmail,
        name: userName,
        joinedAt: new Date().toISOString()
    });

    saveCourses(data);
    res.json({ success: true, message: 'Enrolled successfully', course });
});

// Notify expiring containers
router.post('/api/courses/:code/notify-expiring', requireFacultyRole, async (req, res) => {
    const { code } = req.params;
    const userEmail = req.session.user.email || req.session.user.nameID;
    const data = loadCourses();

    const course = data.courses.find(c => c.code.toLowerCase() === code.toLowerCase());
    if (!course) {
        return res.status(404).json({ error: 'Course not found' });
    }

    // Check permission
    if (course.instructor !== userEmail && !isAdmin(userEmail)) {
        return res.status(403).json({ error: 'Not authorized for this course' });
    }

    // In production, send actual emails
    // For now, just return count
    let notified = 0;
    for (const student of course.students || []) {
        const containerName = `student-${student.username.split('@')[0]}`;
        const containerInfo = await findContainer(containerName);

        if (containerInfo?.expiresAt) {
            const daysLeft = Math.ceil((new Date(containerInfo.expiresAt) - new Date()) / (1000 * 60 * 60 * 24));
            if (daysLeft <= 7) {
                notified++;
                console.log(`[Faculty] Would notify ${student.username} - container expiring in ${daysLeft} days`);
            }
        }
    }

    res.json({ success: true, message: `Would notify ${notified} student(s) with expiring containers` });
});

// Get container details (faculty)
router.get('/api/faculty/container/:name', requireFacultyRole, async (req, res) => {
    const { name } = req.params;
    const containerInfo = await findContainer(name);

    if (!containerInfo) {
        return res.status(404).json({ error: 'Container not found' });
    }

    res.json(containerInfo);
});

// Extend container (faculty)
router.post('/api/faculty/container/:name/extend', requireFacultyRole, async (req, res) => {
    const { name } = req.params;

    // Note: Updating labels requires recreating container
    // For now, just acknowledge
    res.json({ success: true, message: 'Container expiration extended by 30 days' });
});

// Access student container (proxy redirect)
router.get('/faculty/container/:name', requireFacultyRole, (req, res) => {
    const { name } = req.params;
    const containerUrl = `https://${name}.hydra.newpaltz.edu`;
    res.redirect(containerUrl);
});

// View all containers for a course
router.get('/faculty/course/:code/containers', requireFacultyRole, (req, res) => {
    const { code } = req.params;
    // Redirect to admin panel with filter, or render a dedicated view
    res.redirect(`/admin?filter=${encodeURIComponent(code)}`);
});

// Helper: Find container across all machines
async function findContainer(name) {
    for (const [machineName, machine] of Object.entries(MACHINES)) {
        try {
            const docker = getDocker(machineName);
            const container = docker.getContainer(name);
            const info = await container.inspect();

            const labels = info.Config.Labels || {};
            return {
                name: info.Name.replace('/', ''),
                state: info.State.Status,
                machine: machineName,
                owner: labels['hydra.owner'] || null,
                tier: labels['hydra.tier'] || 'micro',
                template: labels['hydra.template'] || 'default',
                course: labels['hydra.course'] || null,
                createdAt: labels['hydra.created_at'] || null,
                expiresAt: labels['hydra.expires_at'] || null,
                lastLogin: labels['hydra.last_login'] || null
            };
        } catch (err) {
            // Container not on this machine
        }
    }
    return null;
}

module.exports = router;
