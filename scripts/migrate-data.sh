#!/bin/bash
# Script: migrate-data.sh
# Purpose: Migrate existing data to new tiered storage
# Run on: Hydra as root (after Phases 1-3 complete)

set -euo pipefail

echo "=== Data Migration to Tiered Storage ==="
echo "This script migrates existing data to the new ZFS storage pools"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    exit 1
fi

# Verify ZFS pool exists
if ! zpool list tank &> /dev/null; then
    echo "ERROR: ZFS pool 'tank' not found. Run Phase 1 first."
    exit 1
fi

# Check available space
echo "Current storage status:"
zpool list tank
echo ""
df -h | grep tank
echo ""

read -p "Continue with data migration? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted"
    exit 0
fi

# Function to migrate directory with progress
migrate_directory() {
    local SOURCE=$1
    local DEST=$2
    local DESC=$3
    
    if [ ! -d "$SOURCE" ]; then
        echo "Source $SOURCE does not exist, skipping"
        return 0
    fi
    
    echo ""
    echo "Migrating: $DESC"
    echo "  From: $SOURCE"
    echo "  To: $DEST"
    
    # Calculate size
    SIZE=$(du -sh "$SOURCE" | awk '{print $1}')
    echo "  Size: $SIZE"
    
    # Create destination if needed
    mkdir -p "$DEST"
    
    # Rsync with progress and bandwidth limit
    rsync -av --progress --bwlimit=100000 \
      "$SOURCE/" "$DEST/" || {
        echo "ERROR: Migration failed for $DESC"
        return 1
      }
    
    echo "  Migration complete: $DESC"
}

# Migrate Ollama models if they exist
if [ -d "/models" ]; then
    echo "=== Migrating Ollama Models ==="
    migrate_directory "/models" "/tank/models/ollama" "Ollama Models"
    
    # Create snapshot after migration
    zfs snapshot tank/models/ollama@initial-migration
    echo "Created snapshot: tank/models/ollama@initial-migration"
fi

# Migrate existing containers if they exist
if [ -d "/var/lib/docker/volumes" ]; then
    echo ""
    echo "=== Migrating Docker Volumes ==="
    migrate_directory "/var/lib/docker/volumes" "/tank/containers/staging" "Docker Volumes"
    
    # Create snapshot
    zfs snapshot tank/containers/staging@initial-migration
    echo "Created snapshot: tank/containers/staging@initial-migration"
fi

# Test NFS exports
echo ""
echo "=== Testing NFS Exports ==="
exportfs -v | grep tank
echo ""
echo "NFS exports are active"

# Verify from Chimera
echo ""
echo "Testing NFS mount from Chimera..."
if ssh chimera "mount -t nfs hydra:/tank/models/ollama /mnt/test && ls /mnt/test && umount /mnt/test"; then
    echo "  ✓ Chimera can mount NFS from Hydra"
else
    echo "  ✗ Chimera cannot mount NFS - check network/firewall"
fi

# Display migration summary
echo ""
echo "=== Migration Summary ==="
echo ""
echo "Storage usage after migration:"
zfs list -o name,used,avail,refer,compressratio
echo ""
echo "Snapshots created:"
zfs list -t snapshot | grep initial-migration
echo ""
echo "=== Data Migration Complete ==="
echo ""
echo "Next steps:"
echo "1. Verify data integrity in /tank"
echo "2. Update application configs to use new paths"
echo "3. Test container/model access"
echo "4. Once verified, you can remove old data from original locations"
echo ""
echo "Rollback: If needed, data is still in original locations"
