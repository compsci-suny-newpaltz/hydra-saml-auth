#!/bin/bash
# reset-db.sh - Wipe database and container data for fresh deployment
# Supports both K8s (primary) and Docker (legacy) modes

set -e

echo "=== Hydra Database Reset Script ==="
echo ""

# Database path (adjust if different on server)
DB_PATH="${DB_PATH:-./data/hydra.db}"

# Confirm before wiping
read -p "This will DELETE all database data. Are you sure? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Stop running student pods/containers
echo "Stopping student workloads..."
if command -v kubectl &> /dev/null; then
    kubectl delete pods -n hydra-students -l app.kubernetes.io/name=student-container --grace-period=30 2>/dev/null || true
else
    docker stop $(docker ps -q --filter "name=student-") 2>/dev/null || true
fi

# Remove database
if [ -f "$DB_PATH" ]; then
    echo "Removing database at $DB_PATH..."
    rm -f "$DB_PATH"
    echo "Database removed."
else
    echo "No database found at $DB_PATH"
fi

echo ""
echo "=== Reset Complete ==="
echo "Now rebuild and redeploy:"
echo "  sudo buildah bud -t hydra-student-container:latest student-container/"
echo "  kubectl -n hydra-system rollout restart deploy hydra-auth"
echo ""
