#!/bin/bash
# deploy-all.sh - Full cluster deployment
# Deploys all services to Hydra, Chimera, and Cerberus nodes
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
ANSIBLE_DIR="$INFRA_DIR/ansible"

echo "Hydra Cluster - Full Deployment"
echo "Target nodes: Hydra, Chimera, Cerberus"

# Verify ansible is installed
if ! command -v ansible-playbook &> /dev/null; then
    echo "Error: ansible-playbook not found. Install Ansible first."
    exit 1
fi

cd "$ANSIBLE_DIR"

echo "[1/7] Preparing nodes..."
ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml

echo "[2/7] Installing Docker..."
ansible-playbook -i inventory/hosts.ini playbooks/01-install-docker.yaml

echo "[3/7] Installing NVIDIA drivers (GPU nodes)..."
ansible-playbook -i inventory/hosts.ini playbooks/02-install-nvidia.yaml

echo "[4/7] Deploying Hydra services..."
ansible-playbook -i inventory/hosts.ini playbooks/03-deploy-hydra.yaml

echo "[5/7] Deploying Chimera services..."
ansible-playbook -i inventory/hosts.ini playbooks/04-deploy-chimera.yaml

echo "[6/7] Deploying Cerberus services..."
ansible-playbook -i inventory/hosts.ini playbooks/05-deploy-cerberus.yaml

echo "[7/7] Verifying deployment..."
ansible-playbook -i inventory/hosts.ini playbooks/99-verify.yaml

echo ""
echo "Deployment complete."
echo "Access: OpenWebUI http://chimera:3000 | Ollama http://chimera:11434 | n8n http://hydra:5678"
