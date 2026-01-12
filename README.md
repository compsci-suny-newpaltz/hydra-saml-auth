# Hydra SAML Auth

A SAML authentication service for Open WebUI, allowing SSO integration with identity providers.

## Table of Contents

- [Overview](#overview)
- [Dashboard](#dashboard)
- [Features](#features)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
	- [Environment Variables](#environment-variables)
- [Documentation](#documentation)
- [Operations](#operations)
	- [Rebuilding](#rebuilding)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Dashboard

The Hydra SAML Auth dashboard is available at [https://hydra.newpaltz.edu/dashboard](https://hydra.newpaltz.edu/dashboard). One of its key features is the ability to create and manage your own Open WebUI account, which can be accessed at [https://gpt.hydra.newpaltz.edu/](https://gpt.hydra.newpaltz.edu/).

## Overview

This service provides SAML-based authentication for Open WebUI (Ollama web interface), operating as a middleware that:

1. Authenticates users via SAML
2. Integrates with Open WebUI's database
3. Handles user session management

## Features

- SAML 2.0 Single Sign-On with Azure AD (metadata-driven)
- Site-wide JWT cookie issuance and JWKS for verification
- Dashboard with:
	- OpenWebUI account management (check/create/change password)
	- n8n account management
	- Student mega container platform with:
		- Single persistent development container per student
		- Built-in services: VS Code (code-server) and Jupyter Notebook
		- Dynamic port routing for custom web applications
		- Docker-in-Docker support for running additional containers
		- Web-based terminal access (WebSocket)
		- Real-time logs streaming (SSE)
- Traefik-based routing for per-user, per-endpoint URLs under /students/<user>/<endpoint>
- Per-student persistent Docker volume and isolated network
- Resource limits: 4GB RAM, 2 CPU cores per container

## Requirements

- Docker and Docker Compose
- Open WebUI container running
- Shared volume with Open WebUI for database access

## Project Structure

High-level layout of important files and folders:

- `index.js` — Express app entrypoint: SAML boot, JWT/JWKS, dashboard pages, route mounting, WebSocket terminal bridge.
- `routes/` — API routers:
	- `containers.js` — Student mega container lifecycle (init, start/stop, service management, port routing, logs, terminal).
	- `webui-api.js` — Proxy for OpenWebUI account management.
	- `n8n-api.js` — n8n account/invite/password flows.
- `views/` — EJS templates for the dashboard and basic pages.
- `student-container/` — Student mega container image:
	- `Dockerfile` — Ubuntu 22.04 with Node.js, Python, Java, Docker, code-server, Jupyter.
	- `supervisord.conf` — Process manager configuration for built-in services.
	- `entrypoint.sh` — Container startup script.
- `chimera_docker/` — Supporting compose assets for related services (if used).
- `Dockerfile` — Build for hydra-saml-auth service.
- `docker-compose.yaml` — Compose stack including Traefik and hydra-saml-auth.
- `docs/containers.md` — In-depth documentation of the student containers system.

## Quick Start

1) Build the student container image
```bash
cd student-container
docker build -t hydra-student-container:latest .
cd ..
```

2) Configure environment
- Create or update `.env` with values for BASE_URL, METADATA_URL, SAML_SP_ENTITY_ID, COOKIE_DOMAIN, etc.

3) Build and run
- Start the stack with Docker Compose.
- The hydra-saml-auth app listens on port 6969 (host networking). Traefik runs alongside and routes student containers.

4) Login and explore
- Visit `/login` → complete SAML flow → get redirected to `/dashboard`.
- Navigate to the Containers tab and click "Initialize Container" to create your development environment.
- Start/stop your container and manage built-in services (VS Code, Jupyter).
- Add custom port routes to expose your web applications at `/students/<username>/<endpoint>`.

## Operations

### Rebuilding the Main Service
```bash
docker compose build hydra-saml-auth
docker compose up -d hydra-saml-auth
```

### Rebuilding the Student Container Image
```bash
cd student-container
docker build -t hydra-student-container:latest .
```

Note: Students with existing containers will need to recreate them to use the updated image.

## Configuration

### Environment Variables

- `PORT`: Service port (default: 6969)
- `DB_PATH`: Path to WebUI database (default: `/app/data/webui.db`)

Commonly used additional variables (see code for full list):
- `BASE_URL` — External base URL for hydra-saml-auth (e.g., https://hydra.newpaltz.edu)
- `METADATA_URL` — Azure AD federation metadata URL
- `SAML_SP_ENTITY_ID` — SP Entity ID (must match Azure Identifier exactly)
- `COOKIE_DOMAIN` — Domain to which the auth cookie is scoped
- `PUBLIC_STUDENTS_BASE` — Base URL used for student container public URLs (defaults to https://hydra.newpaltz.edu/students)
- `JWT_TTL_SECONDS`, `JWT_KEY_ID`, `JWT_PRIVATE_KEY_FILE`, `JWT_PUBLIC_KEY_FILE`


## Student Container Features

### Built-in Tools
Each student container includes:
- **Node.js:** Latest LTS via nvm
- **Python:** 3.11+ with pip and venv
- **Java:** OpenJDK 21
- **Docker:** Full Docker-in-Docker support
- **code-server:** VS Code in the browser
- **Jupyter:** Notebook and JupyterLab
- **Git, curl, wget, build-essential** and other development tools

### Custom Services
Students can add custom services using supervisord:
1. Create a configuration file in `~/supervisor.d/myservice.conf`
2. Restart the container or reload supervisord
3. Example configuration:
```ini
[program:myapp]
command=/home/student/myapp/start.sh
directory=/home/student/myapp
user=student
autostart=true
autorestart=true
```

### Port Routing
Expose your applications through custom endpoints:
- Default routes: `/students/{username}/vscode` and `/students/{username}/jupyter`
- Add custom routes via the dashboard UI
- All routes are protected by ForwardAuth (SAML authentication)

### Resource Limits
- **RAM:** 4GB per container
- **CPU:** 2 cores per container
- **Storage:** Unlimited (limited by host disk space)

## Documentation

- Student containers: see [docs/containers.md](docs/containers.md) for architecture, flows, routing, and troubleshooting.

## Troubleshooting

### Authentication Issues
- **SAML metadata:** Ensure `METADATA_URL` and `SAML_SP_ENTITY_ID` reflect Azure's exact values.
- **Cookie issues:** Check `COOKIE_DOMAIN`, HTTPS, and browser settings.

### Container Issues
- **Container won't initialize:** Ensure the student container image is built (`docker images | grep hydra-student-container`).
- **Container 404:** Verify Traefik is running and the container is on `hydra_students_net`.
- **Service won't start:** Check container logs and ensure the container is running.
- **Port routing not working:** Verify the port is not reserved (8443, 8888) and is not already in use.

### Service-Specific Issues
- **VS Code not loading:** Ensure code-server service is running and ForwardAuth is working.
- **Jupyter notebook issues:** Check that Jupyter service is running and `NotebookApp.base_url` is correctly set.
- **Docker-in-Docker not working:** Ensure the container was created with privileged mode (default in the new system).

### Volume Persistence
- **Files not persisting:** Only files in `/home/student/` persist. Install tools locally or use Docker-in-Docker for system services.
- **Permission issues:** The student user has UID 1000 with sudo access.

## License

Apache-2.0 (or update this section to your chosen license).

Last used: 2025

