# Hydra Cluster Redeploy Guide

Complete step-by-step guide to redeploy the Hydra cluster from fresh Ubuntu installations.

## Table of Contents

1. [Hardware Overview](#hardware-overview)
2. [Network Configuration](#network-configuration)
3. [Pre-requisites](#pre-requisites)
4. [Phase 1: Base Ubuntu Setup](#phase-1-base-ubuntu-setup)
5. [Phase 2: Ansible Configuration](#phase-2-ansible-configuration)
6. [Phase 3: Deploy Services](#phase-3-deploy-services)
7. [Phase 4: Post-Deploy Verification](#phase-4-post-deploy-verification)
8. [Troubleshooting](#troubleshooting)

---

## Hardware Overview

| Node | Role | CPU | RAM | GPUs | Primary IP |
|------|------|-----|-----|------|------------|
| **Hydra** | Control | Intel Xeon Silver 4310T (20 threads) | 256GB | 1x A2/A16 (not used) | 192.168.1.160 |
| **Chimera** | Inference | AMD Threadripper 3960X (48 threads) | 256GB | 3x RTX 3090 (72GB VRAM) | 192.168.1.150 |
| **Cerberus** | Training | AMD Threadripper PRO 7965WX (48 threads) | 64GB | 2x RTX 5090 | 192.168.1.233 |

---

## Network Configuration

### IP Addresses

```
LAN: 192.168.1.0/24
Gateway: 192.168.1.1 (assumed)

Hydra:    192.168.1.160
Chimera:  192.168.1.150
Cerberus: 192.168.1.233
```

### WireGuard VPN (Internal)

```
VPN Subnet: 10.8.0.0/24
Hydra:    10.8.0.1 (server, port 51820)
Chimera:  10.8.0.2
Cerberus: 10.8.0.3
```

### DNS / Hostnames

Add to `/etc/hosts` on each machine:
```
192.168.1.160  hydra
192.168.1.150  chimera
192.168.1.233  cerberus
```

### Firewall Ports

| Port | Service | Node |
|------|---------|------|
| 22 | SSH | All |
| 80/443 | Traefik (HTTP/HTTPS) | Hydra |
| 51820/udp | WireGuard | Hydra |
| 11434 | Ollama API | Chimera |
| 3000 | OpenWebUI | Chimera |
| 7070 | OpenWebUI Middleman | Chimera |
| 9090 | Prometheus | Hydra |
| 3001 | Grafana | Hydra |

---

## Pre-requisites

### On your local machine (deployment controller)

```bash
# Install Ansible
sudo apt update
sudo apt install -y ansible sshpass

# Clone the repo
git clone https://github.com/compsci-suny-newpaltz/hydra-saml-auth.git
cd hydra-saml-auth
git checkout cleanup
```

### USB/Network Boot

- Ubuntu Server 22.04 LTS or 24.04 LTS ISO
- Bootable USB or PXE setup

---

## Phase 1: Base Ubuntu Setup

### 1.1 Install Ubuntu on each machine

1. Boot from Ubuntu Server ISO
2. Select **Ubuntu Server (minimized)** or standard
3. Network: Configure static IPs as listed above
4. Storage: Use entire disk (or configure RAID if available)
5. User: Create `infra` user with password `Infraiscool_260`
6. Enable OpenSSH server during install
7. Skip additional snaps

### 1.2 Post-install on each machine

SSH into each machine and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Set hostname (run on each respective machine)
sudo hostnamectl set-hostname hydra    # on Hydra
sudo hostnamectl set-hostname chimera  # on Chimera
sudo hostnamectl set-hostname cerberus # on Cerberus

# Add hosts entries
sudo tee -a /etc/hosts << EOF
192.168.1.160  hydra
192.168.1.150  chimera
192.168.1.233  cerberus
EOF

# Allow infra sudo without password
echo 'infra ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/infra
sudo chmod 440 /etc/sudoers.d/infra
```

### 1.3 Verify connectivity

From your local machine:
```bash
ssh infra@hydra "hostname"
ssh infra@chimera "hostname"
ssh infra@cerberus "hostname"
```

---

## Phase 2: Ansible Configuration

### 2.1 Update inventory

Edit `infrastructure/ansible/inventory/hosts.ini`:

```ini
[all:vars]
ansible_user=infra
ansible_become=yes
ansible_become_method=sudo
ansible_python_interpreter=/usr/bin/python3
ansible_ssh_pass=Infraiscool_260

[control]
hydra ansible_host=192.168.1.160

[inference]
chimera ansible_host=192.168.1.150 gpu_count=3 gpu_type=rtx3090

[training]
cerberus ansible_host=192.168.1.233 gpu_count=2 gpu_type=rtx5090

[gpu:children]
inference
training

[all_nodes:children]
control
inference
training
```

### 2.2 Add SSH keys (optional but recommended)

```bash
# Generate key if you don't have one
ssh-keygen -t ed25519 -C "hydra-admin"

# Copy to all nodes
ssh-copy-id infra@hydra
ssh-copy-id infra@chimera
ssh-copy-id infra@cerberus
```

### 2.3 Run playbooks in order

```bash
cd infrastructure/ansible

# 1. Base system prep (packages, SSH keys, timezone)
ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml

# 2. Install Docker
ansible-playbook -i inventory/hosts.ini playbooks/01-install-docker.yaml

# 3. Install NVIDIA drivers (GPU nodes only)
ansible-playbook -i inventory/hosts.ini playbooks/02-install-nvidia.yaml

# 4. Deploy Hydra services
ansible-playbook -i inventory/hosts.ini playbooks/03-deploy-hydra.yaml

# 5. Deploy Chimera services
ansible-playbook -i inventory/hosts.ini playbooks/04-deploy-chimera.yaml

# 6. Deploy Cerberus services
ansible-playbook -i inventory/hosts.ini playbooks/05-deploy-cerberus.yaml

# 7. Deploy monitoring (optional)
ansible-playbook -i inventory/hosts.ini playbooks/06-deploy-monitoring.yaml

# 8. Deploy VPN (optional)
ansible-playbook -i inventory/hosts.ini playbooks/07-deploy-vpn.yaml

# 9. Verify everything
ansible-playbook -i inventory/hosts.ini playbooks/99-verify.yaml
```

---

## Phase 3: Deploy Services

### 3.1 Hydra (Control Node)

```bash
ssh infra@hydra

# Clone repo
cd /home/infra
git clone https://github.com/compsci-suny-newpaltz/hydra-saml-auth.git
cd hydra-saml-auth
git checkout cleanup

# Copy and edit environment file
cp .env.example .env
nano .env  # Configure SAML, secrets, etc.

# Start services
docker compose up -d
```

**Key services on Hydra:**
- Traefik (reverse proxy)
- hydra-saml-auth (main app)
- n8n (automation)
- Student containers

### 3.2 Chimera (Inference Node)

```bash
ssh infra@chimera

# Clone repo
cd /home/infra
git clone https://github.com/compsci-suny-newpaltz/hydra-saml-auth.git
cd hydra-saml-auth
git checkout cleanup

# Copy and edit environment file
cp .env.example .env
nano .env

# Create models directory
sudo mkdir -p /models
sudo chown infra:infra /models

# Create shared volume
docker volume create --name comp_open-webui

# Start services
cd chimera_docker
docker compose up -d
```

**Key services on Chimera:**
- Ollama (LLM inference)
- OpenWebUI (chat interface)
- OpenWebUI Middleman (API bridge)
- Watchtower (auto-updates)

### 3.3 Verify GPU access on Chimera

```bash
# Check GPUs are visible
nvidia-smi

# Check Ollama has GPU access
docker exec ollama nvidia-smi

# If GPU not working, recreate container
docker compose down ollama
docker compose up -d ollama
```

### 3.4 Cerberus (Training Node)

```bash
ssh infra@cerberus

# Clone repo (if needed for future training jobs)
cd /home/infra
git clone https://github.com/compsci-suny-newpaltz/hydra-saml-auth.git

# Verify GPU access
nvidia-smi
```

---

## Phase 4: Post-Deploy Verification

### 4.1 Check all services

```bash
# On Hydra
docker ps
curl -I https://hydra.newpaltz.edu

# On Chimera
docker ps
curl http://localhost:11434/api/tags  # Ollama models
docker exec ollama nvidia-smi         # GPU access

# On Cerberus
nvidia-smi
```

### 4.2 Test Ollama inference

```bash
ssh infra@chimera
docker exec ollama ollama run gemma3:4b "Say hello"
```

### 4.3 Verify WireGuard (if configured)

```bash
# On Hydra
sudo wg show

# Should show peers connected
```

### 4.4 Setup GPU auto-fix cron (Chimera)

```bash
ssh infra@chimera

# Install GPU monitor script
sudo tee /usr/local/bin/gpu-monitor.sh << 'EOF'
#!/bin/bash
LOG_FILE="/var/log/gpu-monitor.log"
COMPOSE_DIR="/home/infra/hydra-saml-auth/chimera_docker"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

if ! docker ps --format '{{.Names}}' | grep -q "^ollama$"; then
    log "WARN: Ollama not running, starting..."
    cd "$COMPOSE_DIR" && docker compose up -d ollama
    sleep 5
fi

GPU_TEST=$(docker exec ollama nvidia-smi 2>&1)

if echo "$GPU_TEST" | grep -q "NVIDIA-SMI"; then
    log "OK: GPU access working"
else
    log "ERROR: GPU access failed, recreating container..."
    docker stop ollama 2>/dev/null
    docker rm ollama 2>/dev/null
    cd "$COMPOSE_DIR" && docker compose up -d ollama
    sleep 10
    if docker exec ollama nvidia-smi 2>&1 | grep -q "NVIDIA-SMI"; then
        log "FIXED: GPU access restored"
    else
        log "CRITICAL: GPU fix failed"
    fi
fi
EOF

sudo chmod +x /usr/local/bin/gpu-monitor.sh
sudo touch /var/log/gpu-monitor.log

# Add cron job (every 5 minutes)
(sudo crontab -l 2>/dev/null | grep -v gpu-monitor; echo "*/5 * * * * /usr/local/bin/gpu-monitor.sh") | sudo crontab -
```

---

## Troubleshooting

### Ollama loses GPU access

```bash
# Quick fix
docker stop ollama && docker rm ollama
cd /home/infra/hydra-saml-auth/chimera_docker
docker compose up -d ollama

# Verify
docker exec ollama nvidia-smi
```

### NVIDIA driver issues

```bash
# Check driver
nvidia-smi

# If not working, reinstall
sudo apt purge nvidia-*
sudo apt autoremove
sudo ubuntu-drivers autoinstall
sudo reboot
```

### Docker permission denied

```bash
# Add user to docker group
sudo usermod -aG docker infra
newgrp docker

# Or run with sudo
sudo docker ps
```

### Container keeps restarting

```bash
# Check logs
docker logs <container-name> --tail 100

# Common issues:
# - Missing .env file
# - Wrong file paths in docker-compose
# - Port already in use
```

### WireGuard not connecting

```bash
# Check status
sudo wg show

# Restart interface
sudo wg-quick down wg0
sudo wg-quick up wg0

# Check config
sudo cat /etc/wireguard/wg0.conf
```

---

## Important Notes

1. **Always run containers under `infra` user** - keeps everything consistent
2. **GPU containers need recreation after driver updates** - not just restart
3. **Backup `.env` files** - they contain secrets not in git
4. **WireGuard keys are unique per install** - regenerate after wipe
5. **Models in `/models` on Chimera** - back these up if needed (large!)

---

## Quick Reference

### SSH Access
```bash
ssh infra@hydra      # 192.168.1.160
ssh infra@chimera    # 192.168.1.150
ssh infra@cerberus   # 192.168.1.233
```

### Service Locations
```
Hydra:
  /home/infra/hydra-saml-auth/          # Main app

Chimera:
  /home/infra/hydra-saml-auth/chimera_docker/  # Docker compose
  /models/                                      # Ollama models
```

### Useful Commands
```bash
# View all containers
docker ps -a

# View logs
docker logs <name> -f

# Restart service
docker compose restart <service>

# GPU status
nvidia-smi

# Disk usage
df -h
```
