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
├── terraform/
│   ├── main.tf                 # Proxmox VM provisioning
│   ├── variables.tf            # Configuration variables
│   ├── modules/proxmox-vm/     # VM module
│   └── templates/              # Generated Ansible inventory
├── scripts/
│   ├── deploy-all.sh           # Full cluster deployment
│   ├── deploy-node.sh          # Single node deployment
│   ├── fix-gpu.sh              # Quick GPU fix
│   └── health-check.sh         # Verify all services
└── docs/
    ├── NETWORK_ARCHITECTURE.md # Network and routing details
    └── SERVICE_LOCATIONS.md    # Service paths and configs
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

## Terraform (VM Provisioning)

Provision VMs on Proxmox from scratch:

```bash
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your Proxmox credentials and network settings
terraform init
terraform plan
terraform apply
```

This creates:
- Hydra (8 cores, 32GB RAM, 100GB disk)
- Chimera (16 cores, 64GB RAM, 500GB disk, GPU passthrough)
- Cerberus (16 cores, 64GB RAM, 1TB disk, GPU passthrough)

After VM creation, use Ansible to configure them:
```bash
cd ../ansible
ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml
# ... continue with other playbooks
```

## Student Container Features

### Resource Tiers

| Tier | RAM | CPU | Use Case |
|------|-----|-----|----------|
| Micro | 512MB | 0.25 | Basic tasks (default) |
| Tiny | 1GB | 0.5 | Light scripting |
| Small | 2GB | 1 | Single project |
| Medium | 4GB | 2 | Multi-project, databases |
| Large | 8GB | 4 | Heavy compilation, ML |

### Workspace Templates

| Template | Tools | Extensions |
|----------|-------|------------|
| Java | OpenJDK 21, Maven, Gradle | Java Pack, Spring Boot |
| Python | Python 3.11, Jupyter, Poetry | Python, Pylance, Jupyter |
| Web Dev | Node.js, Vue, React, PHP | ESLint, Prettier, Volar |
| DevOps | Docker, kubectl, Terraform | Docker, Kubernetes, YAML |
| Data Science | pandas, numpy, scikit-learn | Jupyter, Data Wrangler |

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| /api/containers/init | POST | Create container |
| /api/containers/tiers | GET | List resource tiers |
| /api/containers/templates | GET | List workspace templates |
| /api/containers/renew | POST | Extend expiration (30 days) |
| /api/containers/tier | POST | Change resource tier |
| /api/machines/stats | GET | Live resource stats for all machines |
| /api/courses | GET/POST | Course management (faculty) |
| /api/courses/:code/join | POST | Join course (students) |
| /api/shares | GET/POST | Create shareable links |

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

### Container Expiration
Containers expire after 30 days. Run the expiration check:
```bash
node services/expiration.js
```

This stops expired containers and identifies those needing warning emails.
