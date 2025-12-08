# Network Architecture

## Overview

The Hydra cluster uses a multi-network Docker architecture with Traefik for dynamic routing.

## Network Topology

```
                                    INTERNET
                                        |
                                        v
                              [Apache / Nginx]
                              (SSL Termination)
                                        |
                    +-------------------+-------------------+
                    |                   |                   |
                    v                   v                   v
               HYDRA:8082          HYDRA:5678          CHIMERA:3000
               (Traefik)              (n8n)            (OpenWebUI)
                    |                                       |
                    v                                       v
            hydra_students_net                      chimera_docker_default
                    |                                       |
    +---------------+---------------+               +-------+-------+
    |               |               |               |       |       |
    v               v               v               v       v       v
student-user1  student-user2  student-userN     ollama  webui  middleman
    |               |               |
    v               v               v
hydra-student-  hydra-student-  hydra-student-
    user1           user2           userN
(isolated nets) (isolated nets) (isolated nets)
```

## Networks

### Hydra Server

| Network | Purpose | Services |
|---------|---------|----------|
| `hydra_students_net` | Main student routing network | Traefik, all student containers |
| `hydra-student-{username}` | Per-student isolated network | Individual student container |
| `traefik-n8n_default` | n8n stack network | n8n, postgres, n8n-user-manager |
| `hydra-saml-auth_default` | SAML auth service | hydra-saml-auth (uses host networking) |

### Chimera Server

| Network | Purpose | Services |
|---------|---------|----------|
| `chimera_docker_default` | AI services network | ollama, open-webui, middleman, watchtower |

## Routing Architecture

### Student Container Routing (Traefik)

Path: `https://hydra.newpaltz.edu/students/{username}/{endpoint}/`

```
Request → Apache (SSL) → Traefik:8082 → ForwardAuth → Student Container
                              |
                              v
                    PathPrefix matching:
                    /students/{user}/vscode → port 8443
                    /students/{user}/jupyter → port 8888
                    /students/{user}/{custom} → custom port
```

**Traefik Labels (per container):**
```yaml
traefik.enable: true
traefik.docker.network: hydra_students_net
traefik.http.routers.student-{user}-vscode.rule: PathPrefix(`/students/{user}/vscode`)
traefik.http.routers.student-{user}-vscode.middlewares: auth,stripprefix
traefik.http.middlewares.student-{user}-vscode-auth.forwardauth.address: http://host.docker.internal:6969/auth/verify
traefik.http.middlewares.student-{user}-vscode-strip.stripprefix.prefixes: /students/{user}/vscode
```

### n8n Routing

Path: `https://n8n.hydra.newpaltz.edu/`

```
Request → Apache (SSL) → Traefik:8080 → n8n:5678
                              |
                              v
                    Host(`n8n.hydra.newpaltz.edu`)
```

### OpenWebUI / Ollama Routing

Path: `https://chimera.newpaltz.edu:3000/` (or proxied)

```
Request → OpenWebUI:3000 → Ollama:11434
              |
              v
         chimera_docker_default network
```

## Authentication Flow

### SAML Authentication (Azure AD)

```
1. User visits /login
2. Redirect to Azure AD SAML IdP
3. Azure returns SAML assertion
4. hydra-saml-auth validates and extracts claims
5. JWT issued, np_access cookie set
6. User redirected to /dashboard
```

### Route Protection (ForwardAuth)

```
1. Request to /students/{user}/{endpoint}
2. Traefik calls ForwardAuth: GET http://host.docker.internal:6969/auth/verify
3. hydra-saml-auth validates JWT from cookie
4. Returns 200 (allow) or 401 (deny)
5. If allowed, request forwarded to student container
```

## Environment Variables

### Hydra (.env)

```bash
# SAML Configuration
BASE_URL=https://hydra.newpaltz.edu
METADATA_URL=https://login.microsoftonline.com/.../federationmetadata.xml
SAML_SP_ENTITY_ID=hydra.newpaltz.edu
SESSION_SECRET=...

# JWT Configuration
JWT_TTL_SECONDS=2592000  # 30 days
JWT_AUDIENCE=npsites
JWT_KEY_ID=hydra-key-1

# API Keys
OPENWEBUI_API_KEY=...
N8N_USER_MANAGER_API_KEY=...
X-N8N-API-KEY=...
```

### Chimera (.env)

```bash
OPENWEBUI_API_KEY=...
OPENWEBUI_API_PORT=7070
```

## Port Mappings

### Hydra

| Port | Service | Access |
|------|---------|--------|
| 6969 | hydra-saml-auth | Host network (internal) |
| 8081 | Traefik Dashboard | Internal only |
| 8082 | Traefik HTTP | Via Apache proxy |
| 5678 | n8n | Via Traefik |

### Chimera

| Port | Service | Access |
|------|---------|--------|
| 3000 | OpenWebUI | External (or proxied) |
| 7070 | OpenWebUI Middleman | Internal API |
| 11434 | Ollama API | Internal / External |

## Student Container Resources

Each student container gets:
- 4GB RAM limit
- 2 CPU cores
- Persistent volume: `hydra-vol-{username}`
- Privileged mode (for Docker-in-Docker)
- Services: code-server (8443), Jupyter (8888)

## Network Security

1. **Per-student isolation**: Each student has their own bridge network
2. **ForwardAuth**: All student routes require valid JWT
3. **Reserved ports**: 8443 (code-server), 8888 (Jupyter) cannot be overridden
4. **Reserved endpoints**: vscode, jupyter cannot be deleted
