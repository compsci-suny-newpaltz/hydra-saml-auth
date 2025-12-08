# Service Locations

## Current Deployment Paths

### Hydra Server

| Service | Path | Docker Compose Project |
|---------|------|------------------------|
| hydra-saml-auth | `/home/infra/hydra-saml-auth/` | hydra-saml-auth |
| Traefik (students) | `/home/infra/hydra-saml-auth/` | hydra-saml-auth |
| n8n Stack | `/srv/dockerstuff/traefik-n8n/` | traefik-n8n |
| Student Containers | Dynamic (via API) | N/A |

### Chimera Server

| Service | Path | Docker Compose Project |
|---------|------|------------------------|
| Ollama | `/home/infra/hydra-saml-auth/chimera_docker/` | chimera_docker |
| OpenWebUI | `/home/infra/hydra-saml-auth/chimera_docker/` | chimera_docker |
| OpenWebUI Middleman | `/home/infra/hydra-saml-auth/chimera_docker/` | chimera_docker |
| Watchtower | `/home/infra/hydra-saml-auth/chimera_docker/` | chimera_docker |

### Cerberus Server

Currently no production services deployed.

## Environment Files

### Hydra

**SAML Auth** (`/home/infra/hydra-saml-auth/.env`):
```bash
BASE_URL=https://hydra.newpaltz.edu
METADATA_URL=https://login.microsoftonline.com/.../federationmetadata.xml
SAML_SP_ENTITY_ID=hydra.newpaltz.edu
SESSION_SECRET=<secret>
COOKIE_DOMAIN=hydra.newpaltz.edu
JWT_TTL_SECONDS=2592000
JWT_AUDIENCE=npsites
JWT_KEY_ID=hydra-key-1
OPENWEBUI_API_PORT=7070
OPENWEBUI_API_KEY=<key>
N8N_HOST=https://n8n.hydra.newpaltz.edu
X-N8N-API-KEY=<jwt>
N8N_USER_MANAGER_API_KEY=<key>
```

**n8n Stack** (`/srv/dockerstuff/traefik-n8n/.env`):
```bash
DATA_FOLDER=/srv/dockerstuff/traefik-n8n/data
DOMAIN_NAME=n8n.hydra.newpaltz.edu
WEBHOOK_URL=https://n8n.hydra.newpaltz.edu/
N8N_EDITOR_BASE_URL=https://n8n.hydra.newpaltz.edu/
N8N_PATH=/
N8N_ENCRYPTION_KEY=<key>
POSTGRES_USER=n8n
POSTGRES_PASSWORD=<password>
POSTGRES_DB=n8n
N8N_USER_MANAGER_API_KEY=<key>
```

### Chimera

**AI Services** (`/home/infra/hydra-saml-auth/.env`):
```bash
OPENWEBUI_API_KEY=<key>
OPENWEBUI_API_PORT=7070
```

## Service Management Commands

### Hydra

```bash
# SAML Auth + Student Traefik
cd /home/infra/hydra-saml-auth
sudo docker compose up -d
sudo docker compose logs -f hydra-saml-auth

# n8n Stack
cd /srv/dockerstuff/traefik-n8n
sudo docker compose up -d
sudo docker compose logs -f n8n
```

### Chimera

```bash
# All services (Ollama, OpenWebUI, Watchtower)
cd /home/infra/hydra-saml-auth/chimera_docker
sudo docker compose up -d
sudo docker compose logs -f ollama

# Quick GPU fix
sudo docker stop ollama && sudo docker rm ollama
sudo docker compose up -d ollama
sudo docker exec ollama nvidia-smi
```

## Data Volumes

### Hydra

| Volume | Service | Path in Container |
|--------|---------|-------------------|
| `pg_data` | PostgreSQL (n8n) | /var/lib/postgresql/data |
| `n8n_data` | n8n | /home/node/.n8n |
| `hydra-vol-{username}` | Student containers | /home/student |

### Chimera

| Volume | Service | Path in Container |
|--------|---------|-------------------|
| `comp_open-webui` | OpenWebUI | /app/backend/data |
| `/models` | Ollama | /root/.ollama |

## Git Repositories

| Repository | Purpose |
|------------|---------|
| `hydra-saml-auth` | SAML auth, student containers, chimera services, infrastructure |
| `traefik-n8n` | n8n deployment with Traefik |

## Migration Notes

1. n8n is still running from `/srv/dockerstuff/traefik-n8n/` (not migrated to `/home/infra/`)
2. Consider consolidating n8n into the hydra-saml-auth repo for single-source deployment
3. All new deployments should use `/home/infra/` as the base path
