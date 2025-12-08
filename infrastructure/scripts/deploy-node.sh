#!/bin/bash
# deploy-node.sh - Deploy a single node
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(dirname "$SCRIPT_DIR")"
ANSIBLE_DIR="$INFRA_DIR/ansible"

if [ -z "$1" ]; then
    echo "Usage: $0 <node>"
    echo "  Nodes: hydra, chimera, cerberus"
    exit 1
fi

NODE=$1

cd "$ANSIBLE_DIR"

case $NODE in
    hydra)
        echo "Deploying Hydra..."
        ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml --limit control
        ansible-playbook -i inventory/hosts.ini playbooks/01-install-docker.yaml --limit control
        ansible-playbook -i inventory/hosts.ini playbooks/03-deploy-hydra.yaml
        ;;
    chimera)
        echo "Deploying Chimera..."
        ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml --limit inference
        ansible-playbook -i inventory/hosts.ini playbooks/01-install-docker.yaml --limit inference
        ansible-playbook -i inventory/hosts.ini playbooks/02-install-nvidia.yaml --limit inference
        ansible-playbook -i inventory/hosts.ini playbooks/04-deploy-chimera.yaml
        ;;
    cerberus)
        echo "Deploying Cerberus..."
        ansible-playbook -i inventory/hosts.ini playbooks/00-prepare-nodes.yaml --limit training
        ansible-playbook -i inventory/hosts.ini playbooks/01-install-docker.yaml --limit training
        ansible-playbook -i inventory/hosts.ini playbooks/02-install-nvidia.yaml --limit training
        ansible-playbook -i inventory/hosts.ini playbooks/05-deploy-cerberus.yaml
        ;;
    *)
        echo "Unknown node: $NODE"
        echo "Valid nodes: hydra, chimera, cerberus"
        exit 1
        ;;
esac

echo "Deployment of $NODE complete!"
