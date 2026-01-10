#!/bin/bash
# Script: setup-cerberus-workspace.sh
# Purpose: Configure Cerberus NVMe for training workspaces
# Run on: Cerberus as root

set -euo pipefail

echo "=== Cerberus Training Workspace Configuration ==="
echo "This script will partition and configure NVMe drives for training"
echo "WARNING: This will destroy data on nvme0n1 and nvme1n1!"
echo ""

# Verify we're on Cerberus
HOSTNAME=$(hostname)
if [ "$HOSTNAME" != "cerberus" ]; then
    echo "ERROR: This script must run on Cerberus, not $HOSTNAME"
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
if [ ! -b "/dev/nvme1n1" ]; then
    echo "ERROR: NVMe drive /dev/nvme1n1 not found"
    exit 1
fi

echo "  /dev/nvme0n1: $(lsblk -b -n -o SIZE /dev/nvme0n1 | awk '{print int($1/1000000000000)}')TB"
echo "  /dev/nvme1n1: $(lsblk -b -n -o SIZE /dev/nvme1n1 | awk '{print int($1/1000000000000)}')TB"
echo ""
read -p "Continue with configuration? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted"
    exit 0
fi

# Partition nvme0n1 (system + workspace)
echo ""
echo "Partitioning nvme0n1..."
parted /dev/nvme0n1 --script mklabel gpt
parted /dev/nvme0n1 --script mkpart primary ext4 1MiB 500GiB
parted /dev/nvme0n1 --script mkpart primary ext4 500GiB 100%

# Wait for partitions
sleep 2
partprobe /dev/nvme0n1
sleep 2

# Format partitions
echo "Formatting nvme0n1 partitions..."
mkfs.ext4 -F -L cerberus-system /dev/nvme0n1p1
mkfs.ext4 -F -L training-workspace /dev/nvme0n1p2

# Format nvme1n1 (full scratch space)
echo "Formatting nvme1n1 as scratch space..."
mkfs.ext4 -F -L training-scratch /dev/nvme1n1

# Create mount points
mkdir -p /workspace/training/active
mkdir -p /workspace/training/checkpoints
mkdir -p /workspace/datasets/cache
mkdir -p /scratch/temp

# Mount workspace partition
echo "Mounting workspace..."
mount /dev/nvme0n1p2 /workspace

# Mount scratch partition
mount /dev/nvme1n1 /scratch

# Add to fstab
if ! grep -q "/dev/nvme0n1p2" /etc/fstab; then
    echo "/dev/nvme0n1p2 /workspace ext4 defaults,noatime 0 2" >> /etc/fstab
fi
if ! grep -q "/dev/nvme1n1" /etc/fstab; then
    echo "/dev/nvme1n1 /scratch ext4 defaults,noatime 0 2" >> /etc/fstab
fi

# Create directory structure
mkdir -p /workspace/training/active
mkdir -p /workspace/training/checkpoints
mkdir -p /workspace/datasets/cache
mkdir -p /scratch/temp

# Set optimal I/O scheduler for NVMe
echo "Configuring I/O schedulers..."
echo "none" > /sys/block/nvme0n1/queue/scheduler
echo "none" > /sys/block/nvme1n1/queue/scheduler

# Increase read-ahead for sequential workloads
blockdev --setra 4096 /dev/nvme0n1
blockdev --setra 4096 /dev/nvme1n1

# Make scheduler settings persistent
if ! grep -q "echo none > /sys/block/nvme0n1/queue/scheduler" /etc/rc.local; then
    cat >> /etc/rc.local << 'EOF'
# Set NVMe schedulers to none
echo none > /sys/block/nvme0n1/queue/scheduler
echo none > /sys/block/nvme1n1/queue/scheduler
blockdev --setra 4096 /dev/nvme0n1
blockdev --setra 4096 /dev/nvme1n1
EOF
    chmod +x /etc/rc.local
fi

# Create cleanup script for scratch space
cat > /usr/local/bin/cleanup-scratch.sh << 'CLEANUPEOF'
#!/bin/bash
# Clean scratch space older than 7 days
find /scratch/temp -type f -mtime +7 -delete
find /scratch/temp -type d -empty -delete
CLEANUPEOF
chmod +x /usr/local/bin/cleanup-scratch.sh

# Add cleanup cron job
if ! grep -q "cleanup-scratch" /etc/cron.daily/cleanup-scratch 2>/dev/null; then
    cat > /etc/cron.daily/cleanup-scratch << 'CRONEOF'
#!/bin/bash
/usr/local/bin/cleanup-scratch.sh 2>&1 | logger -t scratch-cleanup
CRONEOF
    chmod +x /etc/cron.daily/cleanup-scratch
fi

# Display status
echo ""
echo "=== Cerberus Workspace Configuration Complete ==="
echo ""
echo "Mount points:"
df -h | grep -E "(workspace|scratch)"
echo ""
echo "Directory structure:"
tree -L 2 /workspace /scratch 2>/dev/null || find /workspace /scratch -maxdepth 2 -type d
echo ""
echo "GPU Information:"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "NVIDIA driver not installed"
echo ""
echo "Next steps:"
echo "1. Test NFS mount to Hydra: mount -t nfs hydra:/tank/models/ollama /mnt/test"
echo "2. Install CUDA toolkit and training frameworks"
echo "3. Configure training job scheduler"
