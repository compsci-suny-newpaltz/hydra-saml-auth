#!/bin/bash
# fix-gpu.sh - Quick fix for Ollama GPU access loss
set -e

echo "Fixing Ollama GPU access on Chimera..."

ssh infra@chimera << 'EOF'
cd /home/infra/hydra-saml-auth/chimera_docker
echo "Stopping Ollama..."
sudo docker stop ollama 2>/dev/null || true
echo "Removing container..."
sudo docker rm ollama 2>/dev/null || true
echo "Recreating with GPU access..."
sudo docker compose up -d ollama
echo "Waiting for startup..."
sleep 5
echo "Verifying GPU access..."
sudo docker exec ollama nvidia-smi
EOF

echo ""
echo "Done! Check output above for GPU access."
