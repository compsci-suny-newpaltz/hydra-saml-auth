# SSHPiper Migration Plan

## Overview

Migrate from per-user SSH ports (22000-31999) to a single SSH proxy port (2222) using sshpiper for username-based routing.

## Current State
- Each student container gets a unique port: `22000 + hash(username) % 10000`
- Students connect: `ssh -i key student@hydra.newpaltz.edu -p [PORT]`
- Requires opening 10,000 ports on router (not feasible)

## Target State
- Single port 2222 for all student SSH connections
- sshpiper routes based on username to correct container
- Students connect: `ssh -i key [username]@hydra.newpaltz.edu -p 2222`
- Port 22 remains for server admin access

## Architecture

```
                                    ┌─────────────────────────────┐
                                    │      Hydra Server           │
                                    │                             │
Internet ──► Router ──► Port 22 ───►│ OpenSSH (admin access)      │
                  │                 │   └─► infra, kaitlin, etc.  │
                  │                 │                             │
                  └──► Port 2222 ──►│ sshpiper (Docker)           │
                                    │   └─► Routes by username:   │
                                    │       gopeen1 ──► student-gopeen1:22
                                    │       manzim1 ──► student-manzim1:22
                                    │       easwarac ─► student-easwarac:22
                                    └─────────────────────────────┘
```

## Port Summary

| Port | Service | Purpose | Router Config |
|------|---------|---------|---------------|
| 22 | OpenSSH | Admin access to Hydra server | Forward TCP 22 → 192.168.1.150:22 |
| 2222 | sshpiper | Student container SSH proxy | Forward TCP 2222 → 192.168.1.150:2222 |
| 443 | Apache | HTTPS (dashboard, n8n, gpt) | Forward TCP 443 → 192.168.1.150:443 |
| 80 | Apache | HTTP redirect | Forward TCP 80 → 192.168.1.150:80 |

## Implementation Steps

### Step 1: Deploy sshpiper Container

Create `/home/infra/hydra-saml-auth/sshpiper/docker-compose.yaml`:

```yaml
services:
  sshpiper:
    image: farmer1992/sshpiper:latest
    container_name: sshpiper
    ports:
      - "2222:2222"
    volumes:
      - ./config:/var/sshpiper
      - /home/infra/hydra-saml-auth/data/ssh-keys:/ssh-keys:ro
    networks:
      - hydra_students_net
    restart: unless-stopped
    environment:
      - SSHPIPERD_LOG_LEVEL=info

networks:
  hydra_students_net:
    external: true
```

### Step 2: Configure sshpiper Upstream Plugin

sshpiper uses "workingdir" plugin by default. Create directory structure:

```
/home/infra/hydra-saml-auth/sshpiper/config/
└── {username}/
    └── sshpiper_upstream
```

The `sshpiper_upstream` file contains:
```
student-{username}:22
```

### Step 3: Auto-generate sshpiper Config on Container Creation

Modify `routes/containers.js`:
- On container create: generate sshpiper upstream config
- On container delete: remove sshpiper config

### Step 4: Update Dashboard UI

Modify `views/dashboard.ejs`:
- Change SSH command from: `ssh -i key student@hydra -p [PORT]`
- To: `ssh -i key [username]@hydra.newpaltz.edu -p 2222`

### Step 5: Update SSH Info API

Modify `/dashboard/api/containers/ssh-info` endpoint:
- Return port 2222 (fixed)
- Return username as SSH user (not "student")

### Step 6: Router Configuration

On your router, add port forwarding:

| External Port | Internal IP | Internal Port | Protocol |
|---------------|-------------|---------------|----------|
| 22 | 192.168.1.150 | 22 | TCP |
| 2222 | 192.168.1.150 | 2222 | TCP |

### Step 7: Traefik Configuration (if using for TCP)

If you want Traefik to handle SSH (optional), add to `traefik.yaml`:

```yaml
entryPoints:
  ssh:
    address: ":2222"

tcp:
  routers:
    ssh-router:
      entryPoints:
        - ssh
      rule: "HostSNI(`*`)"
      service: sshpiper

  services:
    sshpiper:
      loadBalancer:
        servers:
          - address: "sshpiper:2222"
```

**Note:** Direct port exposure (Step 1) is simpler and recommended.

## File Changes Summary

| File | Change |
|------|--------|
| `sshpiper/docker-compose.yaml` | NEW - sshpiper service |
| `routes/containers.js` | Update SSH port logic, add sshpiper config generation |
| `views/dashboard.ejs` | Update SSH connection instructions |
| `/etc/ssh/sshd_config` | No change (keep port 22 for admin) |

## Migration Steps (Production)

1. **Deploy sshpiper** (no downtime)
   ```bash
   cd /home/infra/hydra-saml-auth/sshpiper
   docker compose up -d
   ```

2. **Generate configs for existing containers**
   ```bash
   # Script will create sshpiper_upstream for all existing student-* containers
   ./scripts/migrate-sshpiper.sh
   ```

3. **Update application code** (requires restart)
   ```bash
   cd /home/infra/hydra-saml-auth
   docker compose up -d --build hydra-saml-auth
   ```

4. **Update router** (if not already done)
   - Forward port 2222 to Hydra server

5. **Test**
   ```bash
   ssh -i ~/.ssh/testuser_hydra_key testuser@hydra.newpaltz.edu -p 2222
   ```

## Rollback Plan

If issues occur:
1. Keep old port bindings in containers (they still work)
2. Revert `routes/containers.js` changes
3. Stop sshpiper: `docker stop sshpiper`
4. Students can use old per-user ports temporarily

## Security Considerations

- sshpiper only accepts key-based auth (keys generated by Hydra)
- Container SSH only accessible via sshpiper (internal network)
- Port 22 remains admin-only
- No password authentication

## Testing Checklist

- [ ] sshpiper container starts successfully
- [ ] Can SSH as existing user via port 2222
- [ ] New container creates sshpiper config automatically
- [ ] Dashboard shows correct SSH command
- [ ] Port 22 still works for admin access
- [ ] Container deletion removes sshpiper config
