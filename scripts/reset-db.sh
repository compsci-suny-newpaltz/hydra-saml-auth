#!/bin/bash
# reset-db.sh - Wipe database and container data for fresh deployment
# Run this on the server before redeploying with new container image

set -e

echo "=== Hydra Database Reset Script ==="
echo ""

# Database path (adjust if different on server)
DB_PATH="${DB_PATH:-./data/webui.db}"

# Confirm before wiping
read -p "This will DELETE all database data. Are you sure? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Stop running containers
echo "Stopping student containers..."
docker stop $(docker ps -q --filter "name=student-") 2>/dev/null || true

# Remove database
if [ -f "$DB_PATH" ]; then
    echo "Removing database at $DB_PATH..."
    rm -f "$DB_PATH"
    echo "Database removed."
else
    echo "No database found at $DB_PATH"
fi

# Remove all student container volumes (optional, uncomment if needed)
# echo "Removing student volumes..."
# docker volume rm $(docker volume ls -q --filter "name=student-") 2>/dev/null || true

echo ""
echo "=== Reset Complete ==="
echo "Now rebuild and redeploy the student container image:"
echo "  cd student-container && docker build -t hydra-student-container:latest ."
echo ""
