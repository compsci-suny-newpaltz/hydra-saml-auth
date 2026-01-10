#!/bin/bash
# Script: setup-hydra-storage.sh
# Purpose: Configure Hydra RAID-Z2 storage pool with ZFS
# Run on: Hydra as root

set -euo pipefail

echo "=== Hydra Storage Pool Configuration ==="
echo "This script will create a RAID-Z2 pool using drives sdc-sdh"
echo "WARNING: This will destroy all data on these drives!"
echo ""

# Verify we're on Hydra
HOSTNAME=$(hostname)
if [ "$HOSTNAME" != "hydra" ]; then
    echo "ERROR: This script must run on Hydra, not $HOSTNAME"
    exit 1
fi

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    exit 1
fi

# Verify drives exist
echo "Checking for required drives..."
for drive in sdc sdd sde sdf sdg sdh; do
    if [ ! -b "/dev/$drive" ]; then
        echo "ERROR: Drive /dev/$drive not found"
        exit 1
    fi
    SIZE=$(lsblk -b -n -o SIZE /dev/$drive)
    SIZE_TB=$((SIZE / 1000000000000))
    echo "  /dev/$drive: ${SIZE_TB}TB"
done

echo ""
read -p "Continue with RAID-Z2 creation? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted"
    exit 0
fi

# Install ZFS if not present
echo ""
echo "Installing ZFS utilities..."
apt-get update
apt-get install -y zfsutils-linux

# Create RAID-Z2 pool
echo ""
echo "Creating RAID-Z2 pool 'tank'..."
zpool create -f tank raidz2   /dev/sdc   /dev/sdd   /dev/sde   /dev/sdf   /dev/sdg   /dev/sdh

# Set optimal ZFS properties for container storage
echo "Configuring ZFS properties..."
zfs set atime=off tank
zfs set compression=lz4 tank
zfs set xattr=sa tank
zfs set recordsize=128k tank

# Create datasets with quotas
echo ""
echo "Creating ZFS datasets..."

# Container storage (15TB total)
zfs create -o quota=15T tank/containers
zfs create -o quota=8T tank/containers/active
zfs create -o quota=5T tank/containers/inactive
zfs create -o quota=2T tank/containers/staging

# Model storage (8TB total)
zfs create -o quota=8T tank/models
zfs create -o quota=5T tank/models/ollama
zfs create -o quota=3T tank/models/huggingface

# Backup storage (8TB total, higher compression)
zfs create -o quota=8T tank/backups
zfs create -o quota=3T tank/backups/hydra
zfs create -o quota=2.5T tank/backups/chimera
zfs create -o quota=2.5T tank/backups/cerberus
zfs set compression=zstd-9 tank/backups

# Archive storage (4TB total, maximum compression + dedup)
zfs create -o quota=4T tank/archive
zfs create -o quota=2T tank/archive/students
zfs create -o quota=2T tank/archive/projects
zfs set compression=zstd-15 tank/archive
zfs set dedup=on tank/archive

# Configure NFS exports
echo ""
echo "Configuring NFS exports..."
apt-get install -y nfs-kernel-server

cat > /etc/exports << EOF
# Container storage - high performance, async
/tank/containers/active *(rw,async,no_subtree_check,no_root_squash,no_all_squash)
/tank/containers/inactive *(rw,sync,no_subtree_check,root_squash)
/tank/containers/staging *(rw,async,no_subtree_check,no_root_squash)

# Model storage - read-heavy optimization
/tank/models *(ro,async,no_subtree_check,all_squash)
/tank/models/ollama *(rw,async,no_subtree_check,no_root_squash)
/tank/models/huggingface *(rw,async,no_subtree_check,no_root_squash)

# Backup storage - write-optimized with sync
/tank/backups *(rw,sync,subtree_check,root_squash)

# Archive storage - read-only for most
/tank/archive *(ro,sync,subtree_check,root_squash)
EOF

exportfs -ra
systemctl enable nfs-kernel-server
systemctl restart nfs-kernel-server

# Setup automatic snapshots via cron
echo ""
echo "Configuring snapshot schedules..."
cat > /etc/cron.d/zfs-snapshots << 'CRONEOF'
# Hourly snapshots for active containers (keep 24)
0 * * * * root zfs snapshot tank/containers/active@$(date +\%Y\%m\%d-\%H\%M\%S) 2>&1 | logger -t zfs-snapshot
5 * * * * root zfs list -t snapshot -o name,creation | grep 'tank/containers/active@' | head -n -24 | awk '{print $1}' | xargs -r -n1 zfs destroy 2>&1 | logger -t zfs-snapshot

# Daily snapshots for all other datasets (keep 7)
0 2 * * * root zfs snapshot -r tank@daily-$(date +\%Y\%m\%d) 2>&1 | logger -t zfs-snapshot
0 3 * * * root zfs list -t snapshot -o name,creation | grep '@daily-' | head -n -7 | awk '{print $1}' | xargs -r -n1 zfs destroy 2>&1 | logger -t zfs-snapshot

# Weekly scrub on Sundays at 1 AM
0 1 * * 0 root zpool scrub tank 2>&1 | logger -t zfs-scrub
CRONEOF

# Enable ZFS mount service
systemctl enable zfs-mount
systemctl enable zfs.target

# Display status
echo ""
echo "=== Storage Configuration Complete ==="
echo ""
echo "Pool Status:"
zpool status tank
echo ""
echo "Dataset List:"
zfs list -o name,used,avail,quota,compressratio
echo ""
echo "NFS Exports:"
exportfs -v | grep tank
echo ""
echo "Next steps:"
echo "1. Verify NFS mounts from Chimera and Cerberus"
echo "2. Run Phase 2: Configure fast tier caching"
echo "3. Test snapshot creation: zfs snapshot tank/containers/active@test"
