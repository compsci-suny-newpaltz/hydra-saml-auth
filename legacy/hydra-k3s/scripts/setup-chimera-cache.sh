#!/bin/bash
# Script: setup-chimera-cache.sh
# Purpose: Configure Chimera NVMe as fast model cache tier
# Run on: Chimera as root

set -euo pipefail

echo "=== Chimera Fast Cache Configuration ==="
echo "This script will partition and configure NVMe for model caching"
echo "WARNING: This will destroy data on nvme0n1 and format sda, sdb!"
echo ""

# Verify we're on Chimera
HOSTNAME=$(hostname)
if [ "$HOSTNAME" != "chimera" ]; then
    echo "ERROR: This script must run on Chimera, not $HOSTNAME"
    exit 1
fi

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    exit 1
fi

# Verify drives exist
echo "Checking for required drives..."
if [ ! -b "/dev/nvme0n1" ]; then
    echo "ERROR: NVMe drive /dev/nvme0n1 not found"
    exit 1
fi
if [ ! -b "/dev/sda" ]; then
    echo "ERROR: Drive /dev/sda not found"
    exit 1
fi
if [ ! -b "/dev/sdb" ]; then
    echo "ERROR: Drive /dev/sdb not found"
    exit 1
fi

echo "  /dev/nvme0n1: $(lsblk -b -n -o SIZE /dev/nvme0n1 | awk '{print int($1/1000000000000)}')TB"
echo "  /dev/sda: $(lsblk -b -n -o SIZE /dev/sda | awk '{print int($1/1000000000000)}')TB"
echo "  /dev/sdb: $(lsblk -b -n -o SIZE /dev/sdb | awk '{print int($1/1000000000)}')GB"
echo ""
read -p "Continue with configuration? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted"
    exit 0
fi

# Partition NVMe
echo ""
echo "Partitioning NVMe drive..."
parted /dev/nvme0n1 --script mklabel gpt
parted /dev/nvme0n1 --script mkpart primary ext4 1MiB 500GiB
parted /dev/nvme0n1 --script mkpart primary ext4 500GiB 100%

# Wait for partitions to appear
sleep 2
partprobe /dev/nvme0n1
sleep 2

# Format partitions
echo "Formatting partitions..."
mkfs.ext4 -F -L chimera-system /dev/nvme0n1p1
mkfs.ext4 -F -L chimera-cache /dev/nvme0n1p2

# Create mount points
mkdir -p /cache/models/active
mkdir -p /cache/models/staging
mkdir -p /cache/inference

# Mount cache partition
echo "Mounting cache partition..."
mount /dev/nvme0n1p2 /cache

# Add to fstab
if ! grep -q "/dev/nvme0n1p2" /etc/fstab; then
    echo "/dev/nvme0n1p2 /cache ext4 defaults,noatime 0 2" >> /etc/fstab
fi

# Create cache directory structure
mkdir -p /cache/models/active
mkdir -p /cache/models/staging
mkdir -p /cache/inference

# Setup model archive on sda
echo ""
echo "Setting up model archive on /dev/sda..."
apt-get update
apt-get install -y lvm2

# Create LVM for archive
pvcreate -f /dev/sda
vgcreate archive-vg /dev/sda
lvcreate -l 100%FREE -n model-archive archive-vg
mkfs.ext4 -F -L model-archive /dev/archive-vg/model-archive

# Mount archive
mkdir -p /archive/models
mkdir -p /archive/checkpoints
mount /dev/archive-vg/model-archive /archive

# Add to fstab
if ! grep -q "archive-vg/model-archive" /etc/fstab; then
    echo "/dev/archive-vg/model-archive /archive ext4 defaults,noatime 0 2" >> /etc/fstab
fi

# Setup metrics/logs on sdb
echo ""
echo "Setting up metrics storage on /dev/sdb..."
mkfs.ext4 -F -L metrics-logs /dev/sdb
mkdir -p /var/lib/metrics
mount /dev/sdb /var/lib/metrics

# Add to fstab
if ! grep -q "/dev/sdb" /etc/fstab; then
    echo "/dev/sdb /var/lib/metrics ext4 defaults,noatime 0 2" >> /etc/fstab
fi

# Set optimal I/O scheduler for NVMe
echo "Configuring I/O scheduler..."
echo "none" > /sys/block/nvme0n1/queue/scheduler

# Increase read-ahead for sequential workloads
blockdev --setra 4096 /dev/nvme0n1

# Make scheduler setting persistent
if ! grep -q "echo none > /sys/block/nvme0n1/queue/scheduler" /etc/rc.local; then
    cat >> /etc/rc.local << 'EOF'
# Set NVMe scheduler to none
echo none > /sys/block/nvme0n1/queue/scheduler
blockdev --setra 4096 /dev/nvme0n1
EOF
    chmod +x /etc/rc.local
fi

# Display status
echo ""
echo "=== Chimera Cache Configuration Complete ==="
echo ""
echo "Mount points:"
df -h | grep -E "(cache|archive|metrics)"
echo ""
echo "Directory structure:"
tree -L 2 /cache /archive /var/lib/metrics 2>/dev/null || find /cache /archive /var/lib/metrics -maxdepth 2 -type d
echo ""
echo "Next steps:"
echo "1. Test NFS mount to Hydra: mount -t nfs hydra:/tank/models/ollama /mnt/test"
echo "2. Configure Ollama to use /cache/models/active for hot models"
echo "3. Set up model caching controller"
