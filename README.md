# Hydra SAML Auth

A containerized development platform providing persistent development environments for Computer Science students and faculty, with SAML 2.0 SSO integration via Azure AD.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Table of Contents

- [Overview](#overview)
- [Live Instance](#live-instance)
- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Student Container Features](#student-container-features)
- [Project Structure](#project-structure)
- [Operations](#operations)
- [Documentation](#documentation)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

Hydra provides a web-based platform where students can:

1. **Authenticate** via institutional SSO (Azure AD SAML 2.0)
2. **Create** persistent development containers with pre-installed tools
3. **Access** VS Code and Jupyter Notebook directly in the browser
4. **Run** Docker containers inside their environment (Docker-in-Docker)
5. **Expose** custom web applications through dynamic routing

The system handles authentication, container lifecycle management, and routing through Traefik reverse proxy.

## Live Instance

**SUNY New Paltz Production:**

| Service | URL |
|---------|-----|
| Dashboard | [https://hydra.newpaltz.edu/dashboard](https://hydra.newpaltz.edu/dashboard) |
| OpenWebUI (GPT) | [https://gpt.hydra.newpaltz.edu/](https://gpt.hydra.newpaltz.edu/) |
| VS Code | `https://hydra.newpaltz.edu/students/{username}/vscode` |
| Jupyter | `https://hydra.newpaltz.edu/students/{username}/jupyter` |

## Features

### Authentication
- **SAML 2.0 SSO** with Azure AD (metadata-driven configuration)
- **JWT Cookies** for cross-service authentication
- **JWKS Endpoint** for JWT verification by downstream services

### Dashboard
- OpenWebUI account management (create/check/change password)
- n8n workflow automation account management
- Container initialization, start/stop, and status monitoring
- Custom port routing configuration
- Real-time logs streaming (Server-Sent Events)
- Web-based terminal access (WebSocket)

### Student Containers
- Single persistent development container per student
- Pre-installed: Node.js, Python 3.11+, Java 21, Docker
- Built-in services: VS Code (code-server) and Jupyter Notebook
- Docker-in-Docker support for running additional containers
- Persistent storage in `/home/student/`

### Routing
- Traefik-based dynamic routing
- Per-user endpoints: `/students/{username}/{endpoint}`
- ForwardAuth protection on all student routes
- Custom port routing via dashboard UI

### Resource Management
- **RAM:** 4GB per container
- **CPU:** 2 cores per container
- **Storage:** Persistent Docker volumes

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Internet                                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Traefik Reverse Proxy                        │
│                      (Ports 80, 443)                            │
│  • TLS Termination   • ForwardAuth   • Dynamic Routing          │
└────────┬──────────────────┬──────────────────┬──────────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────┐
│ hydra-saml-auth │ │    OpenWebUI    │ │   Student Containers    │
│     :6969       │ │      :3000      │ │  student-{user}         │
│                 │ │                 │ │  • VS Code :8443        │
│ • SAML Auth     │ │ • AI Chat UI    │ │  • Jupyter :8888        │
│ • Dashboard     │ │ • Ollama        │ │  • Custom ports         │
│ • Container Mgmt│ │                 │ │                         │
└────────┬────────┘ └─────────────────┘ └─────────────────────────┘
         │
         ▼
┌─────────────────┐
│     SQLite      │
│   Database      │
└─────────────────┘
```

### Network

All services communicate on an isolated Docker network (`hydra_students_net`). Student containers have no direct internet access - all external traffic is mediated through Traefik.

## Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/your-org/hydra-saml-auth.git
cd hydra-saml-auth
```

### 2. Build Student Container Image

```bash
cd student-container
docker build -t hydra-student-container:latest .
cd ..
```

### 3. Configure Environment

Create `.env` file:

```bash
# Core Settings
PORT=6969
BASE_URL=https://hydra.yourdomain.edu
COOKIE_DOMAIN=.yourdomain.edu

# SAML Configuration
METADATA_URL=https://login.microsoftonline.com/YOUR_TENANT/federationmetadata/2007-06/federationmetadata.xml
SAML_SP_ENTITY_ID=hydra-auth
SAML_CALLBACK_URL=https://hydra.yourdomain.edu/auth/callback

# Database
DB_PATH=/app/data/webui.db

# JWT Settings
JWT_TTL_SECONDS=86400
JWT_KEY_ID=hydra-key-1
JWT_PRIVATE_KEY_FILE=/app/certs/jwt-private.pem
JWT_PUBLIC_KEY_FILE=/app/certs/jwt-public.pem

# Student Containers
PUBLIC_STUDENTS_BASE=https://hydra.yourdomain.edu/students
```

### 4. Generate JWT Keys

```bash
mkdir -p certs
openssl genrsa -out certs/jwt-private.pem 2048
openssl rsa -in certs/jwt-private.pem -pubout -out certs/jwt-public.pem
```

### 5. Build and Run

```bash
docker compose build
docker compose up -d
```

### 6. Verify

```bash
# Check services
docker compose ps

# Test authentication redirect
curl -I https://hydra.yourdomain.edu/
# Should return 302 to login.microsoftonline.com
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Service port | `6969` |
| `BASE_URL` | External URL | Required |
| `COOKIE_DOMAIN` | Cookie scope | Required |
| `METADATA_URL` | Azure AD federation metadata URL | Required |
| `SAML_SP_ENTITY_ID` | SP Entity ID (must match Azure) | Required |
| `SAML_CALLBACK_URL` | SAML callback URL | Required |
| `DB_PATH` | SQLite database path | `/app/data/webui.db` |
| `JWT_TTL_SECONDS` | JWT token lifetime | `86400` |
| `JWT_KEY_ID` | JWT key identifier | `hydra-key-1` |
| `JWT_PRIVATE_KEY_FILE` | JWT signing key path | Required |
| `JWT_PUBLIC_KEY_FILE` | JWT verification key path | Required |
| `PUBLIC_STUDENTS_BASE` | Student URL base | `${BASE_URL}/students` |

### Azure AD Setup

1. Go to **Azure Portal** > **Azure Active Directory** > **Enterprise Applications**
2. Click **New application** > **Create your own application**
3. Name: "Hydra Auth", select "Non-gallery application"
4. Go to **Single sign-on** > **SAML**
5. Set **Identifier (Entity ID)**: `hydra-auth` (must match `SAML_SP_ENTITY_ID`)
6. Set **Reply URL**: `https://hydra.yourdomain.edu/auth/callback`
7. Download **Federation Metadata XML** and note the URL
8. Assign users/groups who should have access

## Student Container Features

### Pre-installed Tools

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | Latest LTS | Via nvm |
| Python | 3.11+ | With pip, venv |
| Java | OpenJDK 21 | - |
| Docker | Latest | Full Docker-in-Docker |
| code-server | Latest | VS Code in browser |
| Jupyter | Latest | Notebook + JupyterLab |
| Git, curl, wget | Latest | Standard tools |

### Default Routes

- **VS Code:** `/students/{username}/vscode`
- **Jupyter:** `/students/{username}/jupyter`

### Custom Services

Students can add custom services via supervisord:

```ini
# ~/supervisor.d/myapp.conf
[program:myapp]
command=/home/student/myapp/start.sh
directory=/home/student/myapp
user=student
autostart=true
autorestart=true
```

### Custom Port Routing

Expose applications through the dashboard:
1. Go to Container tab
2. Click "Add Port Route"
3. Enter endpoint name and internal port
4. Access at `/students/{username}/{endpoint}`

**Reserved ports:** 8443 (VS Code), 8888 (Jupyter)

## Project Structure

```
hydra-saml-auth/
├── index.js                 # Express app: SAML, JWT/JWKS, routes, WebSocket
├── db.js                    # SQLite database initialization
├── routes/
│   ├── containers.js        # Container lifecycle, services, ports, logs
│   ├── webui-api.js         # OpenWebUI account proxy
│   ├── n8n-api.js           # n8n account management
│   ├── servers-api.js       # Cluster status endpoints
│   ├── admin.js             # Admin panel routes
│   ├── resource-requests.js # Resource request handling
│   └── logs-api.js          # Activity logging API
├── services/
│   ├── activity-logger.js   # Activity tracking
│   └── email-notifications.js # Email alerts
├── views/                   # EJS templates
├── student-container/
│   ├── Dockerfile           # Ubuntu 22.04 + dev tools
│   ├── supervisord.conf     # Process manager config
│   └── entrypoint.sh        # Container startup
├── config/
│   ├── runtime.js           # Runtime configuration
│   └── resources.js         # Resource presets
├── docker-compose.yaml      # Production stack
├── docs/
│   ├── containers.md        # Container system documentation
│   ├── hydra_infrastructure_guide.tex  # Admin management guide
│   └── hydra_installation_guide.tex    # Installation guide
└── README.md
```

## Operations

### Rebuild Main Service

```bash
docker compose build hydra-saml-auth
docker compose up -d hydra-saml-auth
```

### Rebuild Student Container Image

```bash
cd student-container
docker build -t hydra-student-container:latest .
```

> **Note:** Students with existing containers must recreate them to use the updated image.

### View Logs

```bash
# Main service
docker compose logs -f hydra-saml-auth

# Student container
docker logs -f student-{username}

# All services
docker compose logs -f
```

### Backup Database

```bash
sqlite3 /app/data/webui.db ".backup '/backups/hydra-$(date +%Y%m%d).db'"
```

## Documentation

- **[Container System](docs/containers.md)** - Architecture, flows, routing details
- **[Infrastructure Guide](docs/hydra_infrastructure_guide.pdf)** - Day-to-day management
- **[Installation Guide](docs/hydra_installation_guide.pdf)** - Full setup instructions

### Building Documentation

```bash
cd docs
pdflatex hydra_infrastructure_guide.tex
pdflatex hydra_infrastructure_guide.tex  # Run twice for TOC
pdflatex hydra_installation_guide.tex
pdflatex hydra_installation_guide.tex
```

## Troubleshooting

### Authentication Issues

| Symptom | Solution |
|---------|----------|
| SAML assertion invalid | Verify `METADATA_URL` and `SAML_SP_ENTITY_ID` match Azure config exactly |
| Cookie not set | Check `COOKIE_DOMAIN`, ensure HTTPS, check browser settings |
| JWT verification fails | Verify JWKS endpoint accessible, check key files |

### Container Issues

| Symptom | Solution |
|---------|----------|
| Container won't initialize | Verify `hydra-student-container:latest` image exists |
| Container 404 | Check container is on `hydra_students_net`, Traefik running |
| Service won't start | Check supervisord logs inside container |
| Port routing fails | Verify port not reserved (8443, 8888) and not in use |

### Service-Specific Issues

- **VS Code not loading:** Check code-server service, ForwardAuth working
- **Jupyter issues:** Verify `NotebookApp.base_url` setting
- **Docker-in-Docker fails:** Container must have privileged mode
- **Files not persisting:** Only `/home/student/` is persisted

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Apache-2.0 - see [LICENSE](LICENSE) for details.

---

**SUNY New Paltz Computer Science Department**
