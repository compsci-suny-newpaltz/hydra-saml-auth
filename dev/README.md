# Hydra SAML Auth - Local Development Environment

This development setup provides a complete local environment that emulates the production Hydra SAML Auth system, including all dependencies and services.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Local Machine                        │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │ Mock SAML IdP│◄───│ Hydra Auth   │───►│ OpenWebUI  │ │
│  │  Port: 8080  │    │  Port: 6969  │    │ Port: 3000 │ │
│  └──────────────┘    └──────▲───────┘    └─────▲──────┘ │
│                             │                   │        │
│                    ┌────────▼────────┐   ┌─────▼──────┐ │
│                    │   Traefik       │   │ Middleman  │ │
│                    │   Port: 80/443  │   │ Port: 7070 │ │
│                    └─────────────────┘   └────────────┘ │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │    Ollama    │    │     n8n      │    │  Student   │ │
│  │  Port: 11434 │    │  Port: 5678  │    │ Containers │ │
│  └──────────────┘    └──────────────┘    └────────────┘ │
└───────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose
- OpenSSL (for JWT key generation)
- Make (optional, for convenience commands)
- sudo access (for hosts file modification)

### Setup Steps

1. **Clone and navigate to dev folder:**
```bash
cd hydra-saml-auth/dev
```

2. **Run the setup script:**
```bash
make setup
# OR without make:
chmod +x setup-dev.sh && ./setup-dev.sh
```

3. **Start all services:**
```bash
make start
# OR without make:
docker compose -f docker-compose.dev.yml up -d
```

4. **Access the services:**
- Main App: http://hydra.local:6969
- OpenWebUI: http://localhost:3000
- Mock SAML IdP: http://localhost:8080
- Traefik Dashboard: http://localhost:8081
- n8n: http://localhost:5678

## 🔐 Authentication (Mock SAML)

The development environment uses a mock SAML IdP instead of Azure AD.

### Test Users:
| Username | Password  | Email              | Role     |
|----------|----------|--------------------|----------|
| user1    | user1pass| user1@example.com  | students |
| user2    | user2pass| user2@example.com  | faculty  |

### SAML Flow:
1. Visit http://hydra.local:6969/login
2. Get redirected to mock SAML IdP
3. Login with test credentials
4. Return to dashboard with session

## 🏗️ Service Configuration

### Environment Variables
All configuration is in `.env.dev`:
- `BASE_URL`: Set to http://hydra.local:6969
- `METADATA_URL`: Points to mock SAML IdP
- `OPENWEBUI_API_BASE`: Points to middleman container
- `COOKIE_DOMAIN`: Set to .hydra.local

### Network Configuration
- **hydra-dev-net**: Main network for all services (172.20.0.0/16)
- **hydra_students_net**: Dedicated network for student containers

### Host Aliases
The setup script adds these to `/etc/hosts`:
- hydra.local → 127.0.0.1
- gpt.hydra.local → 127.0.0.1
- n8n.hydra.local → 127.0.0.1
- traefik.hydra.local → 127.0.0.1

## 📦 Service Details

### Hydra SAML Auth (Main Service)
- **Port**: 6969
- **Features**: SAML auth, JWT tokens, Dashboard, Container management
- **Hot Reload**: Enabled via nodemon
- **Volumes**: Mounts views/, routes/, public/ for live editing

### OpenWebUI
- **Port**: 3000
- **Database**: SQLite at /app/backend/data/webui.db
- **Integration**: Via middleman API

### OpenWebUI Middleman
- **Port**: 7070
- **Purpose**: Database API for user management
- **Auth**: API key in .env.dev

### Mock SAML IdP
- **Port**: 8080
- **Image**: kristophjunge/test-saml-idp
- **Admin Access**: http://localhost:8080/simplesaml (admin/secret)

### Traefik
- **Ports**: 80 (web), 443 (websecure), 8081 (dashboard)
- **Purpose**: Routes student containers
- **Dashboard**: http://localhost:8081

## 🛠️ Development Commands

### Using Make:
```bash
make help          # Show all commands
make start         # Start services
make stop          # Stop services
make logs          # View all logs
make logs-hydra    # View Hydra logs only
make shell-hydra   # Shell into Hydra container
make shell-db      # SQLite console
make clean         # Stop and remove containers
make reset         # Full reset including volumes
make test-saml     # Test SAML authentication
```

### Manual Docker Commands:
```bash
# Start services
docker compose -f docker-compose.dev.yml up -d

# View logs
docker compose -f docker-compose.dev.yml logs -f hydra-saml-auth

# Rebuild after code changes
docker compose -f docker-compose.dev.yml build hydra-saml-auth
docker compose -f docker-compose.dev.yml up -d hydra-saml-auth

# Shell access
docker compose -f docker-compose.dev.yml exec hydra-saml-auth bash
```

## 🔧 Troubleshooting

### Common Issues:

1. **"hydra.local not found"**
   - Run: `sudo ./setup-dev.sh` to update hosts file
   - Or manually add to `/etc/hosts`

2. **Port conflicts**
   - Check for services using ports: 6969, 3000, 7070, 8080, 80, 443
   - Stop conflicting services or modify ports in docker-compose.dev.yml

3. **SAML authentication fails**
   - Check mock-saml-idp logs: `docker logs mock-saml-idp`
   - Ensure METADATA_URL is correct in .env.dev
   - Verify SAML_SP_ENTITY_ID matches

4. **Container permission errors**
   - Ensure Docker socket is accessible
   - Check JWT keys permissions in jwt-keys/

5. **Database connection issues**
   - Verify OpenWebUI is running: `docker logs open-webui-dev`
   - Check middleman logs: `docker logs openwebui-middleman-dev`

### Debug Mode:
Enable detailed logging by setting in `.env.dev`:
```
NODE_ENV=development
DEBUG=*
```

## 🧪 Testing

### Test SAML Flow:
```bash
# Automated test
make test-saml

# Manual test
curl -c cookies.txt -L http://hydra.local:6969/login
```

### Test API Endpoints:
```bash
# Check health
curl http://localhost:7070/openwebui/health

# Test auth verify
curl http://localhost:6969/auth/verify

# Get JWKS
curl http://hydra.local:6969/.well-known/jwks.json
```

### Test Container Management:
1. Login to dashboard
2. Go to Containers tab
3. Start a Jupyter notebook
4. Access at http://hydra.local/students/{username}/{project}

## 📝 Development Workflow

1. **Code Changes:**
   - Main app code: Edit files in parent directory
   - Changes auto-reload via nodemon
   - For major changes: `make rebuild-hydra`

2. **Database Changes:**
   - Access SQLite: `make shell-db`
   - View schema: `.schema`
   - Query users: `SELECT * FROM user;`

3. **Adding New Services:**
   - Edit docker-compose.dev.yml
   - Add to hydra-dev-net network
   - Update .env.dev if needed
   - Restart: `make restart`

## 🔄 Differences from Production

| Aspect | Production | Development |
|--------|-----------|-------------|
| SAML IdP | Azure AD | Mock SAML IdP |
| Domain | hydra.newpaltz.edu | hydra.local |
| SSL | Required | Optional |
| JWT Keys | Persistent files | Generated on setup |
| Database | Remote SQLite | Local SQLite |
| GPU Support | Nvidia GPUs | Disabled |
| n8n | Full instance | Mock/minimal |

## 📚 Additional Resources

- [Main README](../README.md)
- [Container Documentation](../docs/containers.md)
- [Mock SAML IdP Docs](https://github.com/kristophjunge/docker-test-saml-idp)
- [OpenWebUI Docs](https://docs.openwebui.com)

## 🤝 Contributing

When developing:
1. Test changes locally first
2. Ensure all services start correctly
3. Verify SAML flow works
4. Test container management features
5. Update this README if adding new services

## 📄 License

Same as parent project (Apache-2.0 or as specified)
