# N8N User Manager API

This is a secure middleware API server for managing n8n user passwords.

## Endpoints

### GET /health
Health check endpoint (no authentication required)

**Response:**
```json
{
  "status": "healthy",
  "database": "connected"
}
```

### GET /api/users
List all users (requires API key)

**Headers:**
- `x-api-key`: Your API key

**Response:**
```json
{
  "success": true,
  "users": [...],
  "count": 5
}
```

### GET /api/users/:email
Get user by email (requires API key)

**Headers:**
- `x-api-key`: Your API key

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    ...
  }
}
```

### POST /api/users/change-password
Change a user's password (requires API key)

**Headers:**
- `x-api-key`: Your API key
- `Content-Type`: application/json

**Body:**
```json
{
  "email": "user@example.com",
  "newPassword": "NewSecurePassword123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password changed successfully",
  "user": {
    "id": "uuid",
    "email": "user@example.com"
  }
}
```

## Usage Example

```bash
# Check health
curl http://localhost:8080/n8n-user-manager/health

# Change password
curl -X POST http://localhost:8080/n8n-user-manager/api/users/change-password \
  -H "x-api-key: your-secret-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "newPassword": "NewPassword123"
  }'
```

## Security

- All write operations require API key authentication
- Passwords are hashed using bcrypt with 10 rounds
- Minimum password length: 8 characters
- API runs on internal Docker network by default
