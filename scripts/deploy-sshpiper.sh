#!/bin/bash
# deploy-sshpiper.sh - Deploy sshpiper SSH proxy

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SSHPIPER_DIR="$PROJECT_DIR/sshpiper"

echo "=== SSHPiper Deployment Script ==="
echo ""

# Step 1: Create directories
echo "[1/5] Creating directories..."
mkdir -p "$SSHPIPER_DIR/config"
mkdir -p "$PROJECT_DIR/data/ssh-keys"

# Step 2: Run migration script for existing containers
echo "[2/5] Migrating existing containers..."
bash "$SCRIPT_DIR/migrate-sshpiper.sh"

# Step 3: Start sshpiper container
echo "[3/5] Starting sshpiper container..."
cd "$SSHPIPER_DIR"
docker compose up -d

# Step 4: Rebuild and restart hydra-saml-auth
echo "[4/5] Rebuilding hydra-saml-auth..."
cd "$PROJECT_DIR"
docker compose up -d --build hydra-saml-auth

# Step 5: Verify
echo "[5/5] Verifying deployment..."
sleep 3

echo ""
echo "Container status:"
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "sshpiper|hydra-saml-auth"

echo ""
echo "Testing sshpiper port..."
if nc -z localhost 2222 2>/dev/null; then
    echo "✓ sshpiper is listening on port 2222"
else
    echo "✗ sshpiper is NOT listening on port 2222"
    echo "  Check logs: docker logs sshpiper"
fi

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "1. Configure your router to forward port 2222 to this server"
echo "2. Test: ssh -i ~/.ssh/[user]_hydra_key [username]@hydra.newpaltz.edu -p 2222"
echo ""
echo "SSH Connection format:"
echo "  Old: ssh -i key student@hydra.newpaltz.edu -p [22000-31999]"
echo "  New: ssh -i key [username]@hydra.newpaltz.edu -p 2222"
