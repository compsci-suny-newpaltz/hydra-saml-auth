# Hydra Cluster Infrastructure

This directory contains automation for deploying and managing the Hydra cluster (Hydra, Chimera, Cerberus).

## Architecture

| Node | Role | GPUs | Services |
|------|------|------|----------|
| Hydra | Control | None | Traefik, SAML Auth, n8n, Student Containers |
| Chimera | Inference | 3x RTX 3090 | Ollama, OpenWebUI, Watchtower |
| Cerberus | Training | 2x RTX 5090 | (Future training jobs) |

## Quick Start

### Prerequisites
- Ansible installed on your local machine
- SSH access to all nodes as `infra` user
- Sudo privileges on all nodes

### Deploy Everything
```bash
cd infrastructure/scripts
./deploy-all.sh
```

### Deploy Single Node
```bash
./deploy-node.sh chimera
```

### Fix GPU Access (if Ollama loses GPU)
```bash
./fix-gpu.sh
```

## Directory Structure

```
infrastructure/
├── ansible/
│   ├── inventory/hosts.ini     # Node IPs and groups
│   ├── playbooks/              # Deployment playbooks
│   └── roles/                  # Reusable Ansible roles
├── scripts/
│   ├── deploy-all.sh           # Full cluster deployment
│   ├── deploy-node.sh          # Single node deployment
│   ├── fix-gpu.sh              # Quick GPU fix
│   └── health-check.sh         # Verify all services
└── docker-compose/             # All compose files (reference)
```

## Playbooks

| Playbook | Purpose |
|----------|---------|
| 00-prepare-nodes.yaml | Base packages, SSH keys |
| 01-install-docker.yaml | Docker CE + Compose |
| 02-install-nvidia.yaml | NVIDIA drivers + container toolkit |
| 03-deploy-hydra.yaml | Deploy Hydra services |
| 04-deploy-chimera.yaml | Deploy Chimera services |
| 05-deploy-cerberus.yaml | Deploy Cerberus services |
| 99-verify.yaml | Health checks |

## Troubleshooting

### Ollama Lost GPU Access
```bash
# Quick fix
./scripts/fix-gpu.sh

# Or manually
ssh infra@chimera
cd /home/infra/hydra-saml-auth/chimera_docker
sudo docker stop ollama && sudo docker rm ollama
sudo docker compose up -d ollama
sudo docker exec ollama nvidia-smi
```

### Check Service Status
```bash
./scripts/health-check.sh
```
