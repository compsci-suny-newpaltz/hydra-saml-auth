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
	- Student container platform: presets (Jupyter/Static), GitHub-backed containers, restart/delete, logs (SSE), terminal (WebSocket), and VS Code in the browser
- Traefik-based routing for per-user, per-project container URLs under /students/<user>/<project>
- Per-project persistent Docker volumes and resource limits

## Requirements

- Docker and Docker Compose
- Open WebUI container running
- Shared volume with Open WebUI for database access

## Project Structure

High-level layout of important files and folders:

- `index.js` — Express app entrypoint: SAML boot, JWT/JWKS, dashboard pages, route mounting, WebSocket terminal bridge.
- `routes/` — API routers:
	- `containers.js` — Student containers lifecycle (presets, GitHub clone/pull, VS Code, logs, restart, delete).
	- `webui-api.js` — Proxy for OpenWebUI account management.
	- `n8n-api.js` — n8n account/invite/password flows.
- `views/` — EJS templates for the dashboard and basic pages.
- `student-mvp/` — Example student client app (if present) for token usage.
- `chimera_docker/` — Supporting compose assets for related services (if used).
- `Dockerfile` — Build for hydra-saml-auth service.
- `docker-compose.yaml` — Compose stack including Traefik and hydra-saml-auth.
- `docs/containers.md` — In-depth documentation of the student containers system, with diagrams.

## Quick Start

1) Configure environment
- Create or update `.env` with values for BASE_URL, METADATA_URL, SAML_SP_ENTITY_ID, COOKIE_DOMAIN, etc.

2) Build and run
- Start the stack with Docker Compose.
- The hydra-saml-auth app listens on port 6969 (host networking). Traefik runs alongside and routes student containers.

3) Login and explore
- Visit `/login` → complete SAML flow → get redirected to `/dashboard`.
- Use the Containers tab to launch Jupyter, Static, or GitHub-backed projects.
- Optionally start the in-browser VS Code for a project volume.

## Operations

### Rebuilding
```
sudo docker compose build hydra-saml-auth
sudo docker compose up -d hydra-saml-auth
```

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
- `JUPYTER_IMAGE` — Override the Jupyter image used by the preset
- `JWT_TTL_SECONDS`, `JWT_KEY_ID`, `JWT_PRIVATE_KEY_FILE`, `JWT_PUBLIC_KEY_FILE`


## Documentation

- Student containers: see [docs/containers.md](docs/containers.md) for architecture, flows, routing, and troubleshooting.

## Troubleshooting

- SAML metadata: ensure `METADATA_URL` and `SAML_SP_ENTITY_ID` reflect Azure’s exact values.
- Cookie issues: check `COOKIE_DOMAIN`, HTTPS, and browser settings.
- Container 404: verify Traefik is running, container is on `hydra_students_net`, and labels are present.
- Jupyter pathing: do not StripPrefix; rely on `NotebookApp.base_url`.
- Git "dubious ownership": fixed by marking `/w/src` as a safe directory in helper containers (see docs/containers.md).

## License

Apache-2.0 (or update this section to your chosen license).

