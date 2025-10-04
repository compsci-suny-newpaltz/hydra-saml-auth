# Hydra SAML Auth

A SAML authentication service for Open WebUI, allowing SSO integration with identity providers.

## Dashboard

The Hydra SAML Auth dashboard is available at [https://hydra.newpaltz.edu/dashboard](https://hydra.newpaltz.edu/dashboard). One of its key features is the ability to create and manage your own Open WebUI account, which can be accessed at [https://gpt.hydra.newpaltz.edu/](https://gpt.hydra.newpaltz.edu/).

## Overview

This service provides SAML-based authentication for Open WebUI (Ollama web interface), operating as a middleware that:

1. Authenticates users via SAML
2. Integrates with Open WebUI's database
3. Handles user session management

## Requirements

- Docker and Docker Compose
- Open WebUI container running
- Shared volume with Open WebUI for database access

## Management
Rebuilding:
```
sudo docker compose build hydra-saml-auth
sudo docker compose up -d hydra-saml-auth
```

### Environment Variables

- `PORT`: Service port (default: 6969)
- `DB_PATH`: Path to WebUI database (default: `/app/data/webui.db`)


## Documentation

- Student containers: see [docs/containers.md](docs/containers.md) for architecture, flows, routing, and troubleshooting.

