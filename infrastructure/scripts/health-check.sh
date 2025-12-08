#!/bin/bash
# health-check.sh - Check status of all cluster services

echo "Hydra Cluster - Health Check"
echo ""

check_host() {
    local host=$1
    echo "[$host]"
    ssh infra@$host 'sudo docker ps --format "table {{.Names}}\t{{.Status}}"' 2>/dev/null || echo "  Failed to connect"
    echo ""
}

echo "HYDRA (Control):"
check_host hydra

echo "CHIMERA (Inference):"
check_host chimera

echo "Chimera GPU Status:"
ssh infra@chimera 'sudo docker exec ollama nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader' 2>/dev/null || echo "  GPU check failed"
echo ""

echo "CERBERUS (Training):"
check_host cerberus

echo "Health check complete."
