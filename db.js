const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

// Get database path from environment variable or use default
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'webui.db');

// Singleton connection for reuse
let dbInstance = null;

// Create a database connection factory
async function getDb() {
  // Return existing connection if available
  if (dbInstance) {
    return dbInstance;
  }

  try {
    // Ensure data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Open database with promise wrapper (create if doesn't exist)
    dbInstance = await open({
      filename: dbPath,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
    });

    // Enable foreign keys
    await dbInstance.run('PRAGMA foreign_keys = ON;');

    // Add timeout to avoid locking issues
    await dbInstance.run('PRAGMA busy_timeout = 5000;');

    console.log(`Connected to SQLite database at ${dbPath}`);
    return dbInstance;
  } catch (error) {
    console.error(`Failed to connect to database at ${dbPath}:`, error);
    throw error;
  }
}

module.exports = { getDb };