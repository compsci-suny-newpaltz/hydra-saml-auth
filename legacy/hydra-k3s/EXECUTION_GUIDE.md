# Hydra RKE2 Migration - Execution Guide

Complete step-by-step guide to migrate from Docker to RKE2 with tiered storage.

## Pre-Flight Checklist

- [ ] All 3 machines accessible (Hydra, Chimera, Cerberus)
- [ ] Backups of critical data completed
- [ ] Drives verified: `lsblk` on each machine
- [ ] Network connectivity tested between nodes
- [ ] Git repo cloned on Hydra: `/home/infra/hydra-k3s`

## Phase 1: Hydra Storage Setup (Day 1)

**On Hydra as root:**

```bash
cd /home/infra/hydra-k3s
sudo ./scripts/setup-hydra-storage.sh
```

**What it does:**
- Creates ZFS RAID-Z2 pool from 6×7TB drives (35TB usable)
- Sets up datasets: containers, models, backups, archive
- Configures NFS exports
- Enables automated snapshots

**Verification:**
```bash
zpool status tank                    # Should show ONLINE
zfs list                             # Should show all datasets
exportfs -v | grep tank              # Should show NFS exports
```

**Time estimate:** 30-60 minutes

---

## Phase 2: Fast-Tier Cache (Day 2)

### 2A: Chimera Cache Setup

**On Chimera as root:**

```bash
cd /home/infra/hydra-k3s
sudo ./scripts/setup-chimera-cache.sh
```

**Creates:**
- 3TB NVMe cache at `/cache`
- 3.5TB model archive at `/archive`
- 0.93TB metrics storage at `/var/lib/metrics`

**Verification:**
```bash
df -h | grep -E "(cache|archive|metrics)"
nvidia-smi  # Should show 3x RTX 3090
```

### 2B: Cerberus Workspace Setup

**On Cerberus as root:**

```bash
cd /home/infra/hydra-k3s
sudo ./scripts/setup-cerberus-workspace.sh
```

**Creates:**
- 3.1TB training workspace at `/workspace`
- 1.7TB scratch space at `/scratch`
- Automatic scratch cleanup (7 days)

**Verification:**
```bash
df -h | grep -E "(workspace|scratch)"
nvidia-smi  # Should show 2x RTX 5090
```

**Time estimate:** 30 minutes per node

---

## Phase 3: Deploy Controllers (Day 3)

**Prerequisites:**
- RKE2 cluster installed and running
- kubectl configured

**On Hydra:**

```bash
cd /home/infra/hydra-k3s
./scripts/deploy-controllers.sh
```

**Deploys:**
- Storage tiering controller (hourly checks)
- Backup controller (daily at 2 AM)

**Verification:**
```bash
kubectl get pods -n storage-system
kubectl logs -f deployment/storage-tiering-controller -n storage-system
kubectl get cronjobs -n storage-system
```

**Time estimate:** 15 minutes

---

## Phase 4: Data Migration (Days 4-5)

**On Hydra as root:**

```bash
cd /home/infra/hydra-k3s
sudo ./scripts/migrate-data.sh
```

**Migrates:**
- Ollama models → `/tank/models/ollama`
- Docker volumes → `/tank/containers/staging`
- Creates snapshots after each migration

**Verification:**
```bash
# Check migrated data
ls -lah /tank/models/ollama/
zfs list -t snapshot | grep initial-migration

# Test NFS from Chimera
ssh chimera "mount -t nfs hydra:/tank/models/ollama /mnt/test && ls /mnt/test && umount /mnt/test"

# Check compression
zfs get compressratio tank
```

**Time estimate:** Depends on data size (100GB = ~20 minutes)

---

## Post-Migration Verification

### Storage Health
```bash
# On Hydra
zpool status tank
zfs list -o name,used,avail,compressratio
df -h | grep tank
```

### Network Connectivity
```bash
# Test NFS mounts from all nodes
showmount -e hydra  # From Chimera/Cerberus
```

### Controller Status
```bash
kubectl get all -n storage-system
kubectl logs -f deployment/storage-tiering-controller -n storage-system
```

### GPU Verification
```bash
# On Chimera
nvidia-smi  # 3x RTX 3090, 72GB VRAM total

# On Cerberus
nvidia-smi  # 2x RTX 5090, 64GB VRAM total
```

---

## Configuration Updates

After migration, update application configs:

### Ollama on Chimera
```yaml
# docker-compose.yaml or K8s manifest
volumes:
  - type: nfs
    source: hydra:/tank/models/ollama
    target: /root/.ollama
```

### Student Containers
```yaml
volumes:
  - type: nfs
    source: hydra:/tank/containers/active/${USERNAME}
    target: /workspace
```

---

## Rollback Procedures

### Phase 1 Rollback
```bash
zpool destroy tank
for drive in sdc sdd sde sdf sdg sdh; do wipefs -a /dev/$drive; done
```

### Phase 2 Rollback
```bash
# Chimera
umount /cache /archive /var/lib/metrics
vgremove archive-vg
wipefs -a /dev/nvme0n1 /dev/sda /dev/sdb

# Cerberus
umount /workspace /scratch
wipefs -a /dev/nvme0n1 /dev/nvme1n1
```

### Phase 3 Rollback
```bash
kubectl delete namespace storage-system
```

### Phase 4 Rollback
```bash
# Data remains in original locations - just stop using /tank paths
```

---

## Monitoring Commands

### Storage
```bash
watch -n 5 'zpool iostat tank'
watch -n 5 'df -h | grep tank'
zpool scrub tank  # Manual scrub
```

### Snapshots
```bash
zfs list -t snapshot
zfs list -t snapshot -o name,used,creation
```

### Controllers
```bash
kubectl top pods -n storage-system
kubectl logs -f -l app=storage-tiering-controller -n storage-system
kubectl get events -n storage-system --sort-by='.lastTimestamp'
```

---

## Troubleshooting

### ZFS Pool Degraded
```bash
zpool status -v tank
# Replace failed drive:
zpool replace tank /dev/old-drive /dev/new-drive
```

### NFS Mount Fails
```bash
# Check exports
exportfs -v

# Check firewall
ufw status
ufw allow from chimera to any port nfs
ufw allow from cerberus to any port nfs

# Test connectivity
ping chimera
showmount -e hydra
```

### Controller Not Starting
```bash
kubectl describe pod -n storage-system
kubectl logs -n storage-system <pod-name>

# Check node resources
kubectl describe node hydra
```

### Migration Slow
```bash
# Check network
iftop

# Monitor I/O
iostat -x 5

# Adjust rsync bandwidth in migrate-data.sh
# Change: --bwlimit=100000  # 100 MB/s
```

---

## Success Criteria

- [ ] ZFS pool healthy (ONLINE state)
- [ ] All datasets created with correct quotas
- [ ] NFS exports accessible from Chimera and Cerberus
- [ ] Fast-tier caches mounted and accessible
- [ ] Controllers running in Kubernetes
- [ ] Data migrated with snapshots created
- [ ] Compression ratios > 1.2x
- [ ] GPUs detected on both GPU nodes
- [ ] Application configs updated
- [ ] Old data backed up before removal

---

## Timeline Summary

- **Day 1**: Phase 1 (Hydra storage) - 1 hour
- **Day 2**: Phase 2 (Fast-tier cache) - 1 hour
- **Day 3**: Phase 3 (Controllers) - 30 minutes
- **Days 4-5**: Phase 4 (Migration) - Variable (data dependent)

**Total:** 2-3 days for setup, plus data migration time

---

## Support

- **Documentation:** See `docs/phase*-*.md` for detailed phase guides
- **Plan:** See `PLAN.md` for architecture details
- **Issues:** https://github.com/ndg8743/hydra-k3s/issues
