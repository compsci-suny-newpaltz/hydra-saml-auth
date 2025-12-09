# Services Deployment Checklist

Use this checklist after fresh Ubuntu install.

## Pre-Deploy

- [ ] Ubuntu Server 22.04/24.04 installed on all machines
- [ ] Static IPs configured
  - [ ] Hydra: 192.168.1.160
  - [ ] Chimera: 192.168.1.150
  - [ ] Cerberus: 192.168.1.233
- [ ] SSH access working (`ssh infra@<hostname>`)
- [ ] `/etc/hosts` updated on all machines
- [ ] `infra` user has passwordless sudo

## Phase 1: Base Setup (All Nodes)

```bash
ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml
ansible-playbook -i inventory/hosts.ini playbooks/01-install-docker.yaml
```

- [ ] Docker installed and running
- [ ] `infra` user in docker group
- [ ] Docker Compose v2 working

## Phase 2: GPU Nodes (Chimera & Cerberus)

```bash
ansible-playbook -i inventory/hosts.ini playbooks/02-install-nvidia.yaml
```

- [ ] NVIDIA driver installed (`nvidia-smi` works)
- [ ] nvidia-container-toolkit installed
- [ ] Docker can access GPU (`docker run --gpus all nvidia/cuda:12.0-base nvidia-smi`)

## Phase 3: Hydra Services

```bash
ssh infra@hydra
cd /home/infra
git clone https://github.com/compsci-suny-newpaltz/hydra-saml-auth.git
cd hydra-saml-auth && git checkout cleanup
cp .env.example .env && nano .env
docker compose up -d
```

- [ ] Repo cloned to `/home/infra/hydra-saml-auth`
- [ ] `.env` configured with SAML credentials
- [ ] Traefik running (ports 80, 443)
- [ ] hydra-saml-auth running
- [ ] SSL certificates obtained (Let's Encrypt)
- [ ] SAML login working

### Hydra Services Status

| Service | Port | Check |
|---------|------|-------|
| Traefik | 80, 443 | `curl -I https://hydra.newpaltz.edu` |
| hydra-saml-auth | 3000 | `docker logs hydra-saml-auth` |
| n8n | 5678 | `curl http://localhost:5678` |

## Phase 4: Chimera Services

```bash
ssh infra@chimera
cd /home/infra
git clone https://github.com/compsci-suny-newpaltz/hydra-saml-auth.git
cd hydra-saml-auth && git checkout cleanup
cp .env.example .env && nano .env

# Create models directory
sudo mkdir -p /models && sudo chown infra:infra /models

# Create volume
docker volume create --name comp_open-webui

# Start services
cd chimera_docker
docker compose up -d
```

- [ ] Repo cloned
- [ ] `/models` directory exists
- [ ] `comp_open-webui` volume created
- [ ] Ollama running with GPU access
- [ ] OpenWebUI running
- [ ] openwebui_middleman running

### Chimera Services Status

| Service | Port | Check |
|---------|------|-------|
| Ollama | 11434 | `curl http://localhost:11434/api/tags` |
| OpenWebUI | 3000 | `curl http://localhost:3000` |
| Middleman | 7070 | `curl http://localhost:7070/health` |

### GPU Verification

```bash
# Host GPU
nvidia-smi

# Ollama GPU (CRITICAL)
docker exec ollama nvidia-smi

# If fails, recreate:
docker stop ollama && docker rm ollama
docker compose up -d ollama
```

- [ ] `nvidia-smi` shows 3x RTX 3090
- [ ] `docker exec ollama nvidia-smi` works
- [ ] GPU auto-fix cron installed

## Phase 5: Cerberus (Optional)

```bash
ssh infra@cerberus
# Just verify GPU access for now
nvidia-smi
```

- [ ] NVIDIA driver working
- [ ] 2x RTX 5090 visible

## Phase 6: Monitoring (Optional)

```bash
ansible-playbook -i inventory/hosts.ini playbooks/06-deploy-monitoring.yaml
```

- [ ] Prometheus running (http://hydra:9090)
- [ ] Grafana running (http://hydra:3001)
- [ ] Node exporters on all machines
- [ ] cAdvisor on all machines
- [ ] DCGM exporter on GPU nodes

## Phase 7: VPN (Optional)

### WireGuard (Quick)

- [ ] Keys generated on all nodes
- [ ] `/etc/wireguard/wg0.conf` configured
- [ ] `wg-quick@wg0` enabled
- [ ] Nodes can ping each other on 10.8.0.x

### Headscale (SSO)

```bash
ansible-playbook -i inventory/hosts.ini playbooks/07-deploy-vpn.yaml
```

- [ ] Headscale container running
- [ ] Tailscale installed on all nodes
- [ ] Nodes registered with Headscale

## Post-Deploy Verification

### Quick Health Check

```bash
# From local machine
ssh infra@hydra "docker ps --format 'table {{.Names}}\t{{.Status}}'"
ssh infra@chimera "docker ps --format 'table {{.Names}}\t{{.Status}}'"
ssh infra@chimera "docker exec ollama nvidia-smi | head -10"
```

### Test Ollama

```bash
ssh infra@chimera
docker exec ollama ollama run gemma3:4b "Hello, are you using GPU?"
```

### Test SAML Login

1. Open https://hydra.newpaltz.edu
2. Click Login
3. Authenticate with SUNY credentials
4. Verify dashboard loads

## Rollback

If something breaks:

```bash
# Stop all containers
docker compose down

# Check logs
docker logs <container> --tail 100

# Reset and retry
docker compose up -d
```

## Backup Reminder

After successful deploy, backup:

1. `/home/infra/hydra-saml-auth/.env` (all machines)
2. `/etc/wireguard/` (if using WireGuard)
3. Grafana dashboards (export JSON)
4. `/models` on Chimera (if you have custom models)
