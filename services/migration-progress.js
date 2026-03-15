// services/migration-progress.js - Track migration progress for dashboard updates
// Provides real-time status tracking for container migrations

const { getDb } = require('../db');

// Migration steps with display names and order
const MIGRATION_STEPS = {
  INITIATED: { order: 0, label: 'Migration initiated', icon: '🚀' },
  STOPPING_POD: { order: 1, label: 'Stopping container', icon: '⏹️' },
  POD_STOPPED: { order: 2, label: 'Container stopped', icon: '✓' },
  CREATING_TARGET_STORAGE: { order: 3, label: 'Creating storage on target', icon: '💾' },
  STORAGE_READY: { order: 4, label: 'Storage ready', icon: '✓' },
  COPYING_DATA: { order: 5, label: 'Copying data', icon: '📦' },
  DATA_COPIED: { order: 6, label: 'Data copied', icon: '✓' },
  CREATING_POD: { order: 7, label: 'Starting container on target', icon: '▶️' },
  POD_READY: { order: 8, label: 'Container ready', icon: '✓' },
  UPDATING_ROUTES: { order: 9, label: 'Updating routing', icon: '🔄' },
  COMPLETED: { order: 10, label: 'Migration complete', icon: '✅' },
  FAILED: { order: -1, label: 'Migration failed', icon: '❌' }
};

// In-memory store for active migrations (faster than DB for real-time updates)
const activeMigrations = new Map();

// Track cancelled migrations
const cancelledMigrations = new Set();

/**
 * Initialize migration tracking table
 */
async function initMigrationTable() {
  const db = await getDb();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS migration_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      current_step TEXT NOT NULL DEFAULT 'INITIATED',
      progress_percent INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'completed', 'failed')),
      error_message TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      steps_log TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_migration_username ON migration_progress(username);
    CREATE INDEX IF NOT EXISTS idx_migration_status ON migration_progress(status);
  `);
}

/**
 * Start tracking a new migration
 */
async function startMigration(username, fromNode, toNode) {
  const db = await getDb();

  // Cancel any existing in-progress migrations for this user
  await db.run(
    `UPDATE migration_progress SET status = 'failed', error_message = 'Superseded by new migration'
     WHERE username = ? AND status = 'in_progress'`,
    [username]
  );

  const result = await db.run(
    `INSERT INTO migration_progress (username, from_node, to_node, current_step, steps_log)
     VALUES (?, ?, ?, 'INITIATED', ?)`,
    [username, fromNode, toNode, JSON.stringify([{
      step: 'INITIATED',
      timestamp: new Date().toISOString(),
      message: `Migration from ${fromNode} to ${toNode} started`
    }])]
  );

  const migrationId = result.lastID;

  // Store in memory for fast access
  activeMigrations.set(username, {
    id: migrationId,
    username,
    fromNode,
    toNode,
    currentStep: 'INITIATED',
    progressPercent: 0,
    status: 'in_progress',
    stepsLog: [{
      step: 'INITIATED',
      timestamp: new Date().toISOString(),
      message: `Migration from ${fromNode} to ${toNode} started`
    }]
  });

  console.log(`[migration-progress] Started tracking migration ${migrationId} for ${username}`);
  return migrationId;
}

/**
 * Update migration progress
 */
async function updateProgress(username, step, message = null) {
  const stepInfo = MIGRATION_STEPS[step];
  if (!stepInfo) {
    console.warn(`[migration-progress] Unknown step: ${step}`);
    return;
  }

  const progressPercent = Math.round((stepInfo.order / 10) * 100);
  const logEntry = {
    step,
    timestamp: new Date().toISOString(),
    message: message || stepInfo.label
  };

  // Update in-memory store
  const migration = activeMigrations.get(username);
  if (migration) {
    migration.currentStep = step;
    migration.progressPercent = progressPercent;
    migration.stepsLog.push(logEntry);

    if (step === 'COMPLETED') {
      migration.status = 'completed';
    } else if (step === 'FAILED') {
      migration.status = 'failed';
    }
  }

  // Update database
  const db = await getDb();
  await db.run(
    `UPDATE migration_progress
     SET current_step = ?, progress_percent = ?,
         steps_log = json_insert(steps_log, '$[#]', json(?))
     WHERE username = ? AND status = 'in_progress'`,
    [step, progressPercent, JSON.stringify(logEntry), username]
  );

  console.log(`[migration-progress] ${username}: ${stepInfo.icon} ${stepInfo.label} (${progressPercent}%)`);
}

/**
 * Mark migration as completed
 */
async function completeMigration(username, success = true, errorMessage = null) {
  const step = success ? 'COMPLETED' : 'FAILED';
  const status = success ? 'completed' : 'failed';

  await updateProgress(username, step, errorMessage);

  const db = await getDb();
  await db.run(
    `UPDATE migration_progress
     SET status = ?, completed_at = datetime('now'), error_message = ?
     WHERE username = ? AND status = 'in_progress'`,
    [status, errorMessage, username]
  );

  // Remove from active migrations after a delay (allow dashboard to show final state)
  setTimeout(() => {
    activeMigrations.delete(username);
  }, 30000); // Keep for 30 seconds after completion
}

/**
 * Get current migration status for a user
 */
async function getMigrationStatus(username) {
  // Check in-memory first (faster)
  const active = activeMigrations.get(username);
  if (active) {
    return {
      ...active,
      stepInfo: MIGRATION_STEPS[active.currentStep]
    };
  }

  // Fall back to database
  const db = await getDb();
  const migration = await db.get(
    `SELECT * FROM migration_progress
     WHERE username = ?
     ORDER BY started_at DESC LIMIT 1`,
    [username]
  );

  if (!migration) {
    return null;
  }

  return {
    id: migration.id,
    username: migration.username,
    fromNode: migration.from_node,
    toNode: migration.to_node,
    currentStep: migration.current_step,
    progressPercent: migration.progress_percent,
    status: migration.status,
    errorMessage: migration.error_message,
    startedAt: migration.started_at,
    completedAt: migration.completed_at,
    stepsLog: JSON.parse(migration.steps_log || '[]'),
    stepInfo: MIGRATION_STEPS[migration.current_step]
  };
}

/**
 * Get all active migrations (for admin dashboard)
 */
async function getActiveMigrations() {
  const migrations = [];

  for (const [username, migration] of activeMigrations) {
    migrations.push({
      ...migration,
      stepInfo: MIGRATION_STEPS[migration.currentStep]
    });
  }

  return migrations;
}

/**
 * Check if user has an active migration
 */
function hasActiveMigration(username) {
  return activeMigrations.has(username);
}

/**
 * Request cancellation of an active migration
 */
async function cancelMigration(username) {
  const migration = activeMigrations.get(username);
  if (!migration || migration.status !== 'in_progress') {
    return { success: false, message: 'No active migration to cancel' };
  }

  cancelledMigrations.add(username);
  console.log(`[migration-progress] Cancellation requested for ${username}`);
  return { success: true, message: 'Cancellation requested' };
}

/**
 * Check if a migration has been cancelled
 */
function isCancelled(username) {
  return cancelledMigrations.has(username);
}

/**
 * Clear cancellation flag (called after migration handles the cancellation)
 */
function clearCancellation(username) {
  cancelledMigrations.delete(username);
}

module.exports = {
  MIGRATION_STEPS,
  initMigrationTable,
  startMigration,
  updateProgress,
  completeMigration,
  getMigrationStatus,
  getActiveMigrations,
  hasActiveMigration,
  cancelMigration,
  isCancelled,
  clearCancellation
};
