const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.N8N_USER_MANAGER_PORT || 3000;

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_POSTGRESDB_HOST || 'postgres',
  port: process.env.DB_POSTGRESDB_PORT || 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

// Middleware to parse JSON
app.use(express.json());

// API Key authentication middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ 
      error: 'Unauthorized', 
      message: 'API key is required in x-api-key header' 
    });
  }
  
  if (apiKey !== process.env.N8N_USER_MANAGER_API_KEY) {
    return res.status(403).json({ 
      error: 'Forbidden', 
      message: 'Invalid API key' 
    });
  }
  
  next();
};

// Health check endpoint (no auth required)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected', error: error.message });
  }
});

// Get all users (auth required, without passwords)
app.get('/api/users', authenticateApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, "firstName", "lastName", role, "roleSlug", disabled, "mfaEnabled", "createdAt", "updatedAt" FROM "user" ORDER BY "createdAt" DESC'
    );
    
    res.json({ 
      success: true, 
      users: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Database error', 
      message: error.message 
    });
  }
});

// Get user by email (auth required)
app.get('/api/users/:email', authenticateApiKey, async (req, res) => {
  try {
    const { email } = req.params;
    
    const result = await pool.query(
      'SELECT id, email, "firstName", "lastName", role, "roleSlug", disabled, "mfaEnabled", "createdAt", "updatedAt" FROM "user" WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Not found', 
        message: 'User not found' 
      });
    }
    
    res.json({ 
      success: true, 
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Database error', 
      message: error.message 
    });
  }
});

// Change user password (auth required)
app.post('/api/users/change-password', authenticateApiKey, async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    
    // Validate input
    if (!email || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bad request', 
        message: 'Email and newPassword are required' 
      });
    }
    
    // Validate password strength (minimum 8 characters)
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bad request', 
        message: 'Password must be at least 8 characters long' 
      });
    }
    
    // Check if user exists
    const userCheck = await pool.query(
      'SELECT id, email FROM "user" WHERE email = $1',
      [email]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Not found', 
        message: 'User not found' 
      });
    }
    
    // Hash the new password (using bcrypt with 10 rounds)
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update the password in the database
    await pool.query(
      'UPDATE "user" SET password = $1, "updatedAt" = NOW() WHERE email = $2',
      [hashedPassword, email]
    );
    
    console.log(`Password changed successfully for user: ${email}`);
    
    res.json({ 
      success: true, 
      message: 'Password changed successfully',
      user: {
        id: userCheck.rows[0].id,
        email: userCheck.rows[0].email
      }
    });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Server error', 
      message: error.message 
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Not found', 
    message: 'Endpoint not found' 
  });
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`N8N User Manager API running on port ${port}`);
  console.log('Available endpoints:');
  console.log('  GET  /health - Health check (no auth)');
  console.log('  GET  /api/users - List all users (auth required)');
  console.log('  GET  /api/users/:email - Get user by email (auth required)');
  console.log('  POST /api/users/change-password - Change user password (auth required)');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await pool.end();
  process.exit(0);
});
