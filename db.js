const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

// Get database path from environment variable or use default
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'webui.db');

// Create a database connection factory
async function getDb() {
  try {
    // Open database with promise wrapper
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READWRITE  // Open in read-write mode
    });
    
    // Enable foreign keys
    await db.run('PRAGMA foreign_keys = ON;');
    
    // Add timeout to avoid locking issues
    await db.run('PRAGMA busy_timeout = 5000;');
    
    console.log(`Connected to SQLite database at ${dbPath}`);
    return db;
  } catch (error) {
    console.error(`Failed to connect to database at ${dbPath}:`, error);
    throw error;
  }
}

module.exports = { getDb };