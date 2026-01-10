# Phase 4: Data Migration

## Overview

Migrate existing data from current storage to new tiered ZFS pools.

## Prerequisites

- Phases 1, 2, and 3 complete
- ZFS pool 'tank' healthy
- NFS exports active
- Sufficient space verified

## What Gets Migrated

1. **Ollama Models** → `/tank/models/ollama`
2. **Docker Volumes** → `/tank/containers/staging`
3. **Application Data** → appropriate tier based on access patterns

## Running Phase 4

```bash
cd /home/infra/hydra-k3s
sudo ./scripts/migrate-data.sh
```

**The script will**:
1. Check ZFS pool health
2. Display available space
3. Migrate data with progress bars
4. Create snapshots after each migration
5. Test NFS mounts from remote nodes
6. Keep original data intact (non-destructive)

## Verification

### Check Migrated Data
```bash
# Verify Ollama models
ls -lah /tank/models/ollama/

# Check compression ratio
zfs get compressratio tank/models/ollama

# List snapshots
zfs list -t snapshot | grep initial-migration
```

### Test NFS Access
```bash
# From Chimera
ssh chimera "showmount -e hydra"
ssh chimera "mount -t nfs hydra:/tank/models/ollama /mnt/test && ls /mnt/test && umount /mnt/test"

# From Cerberus  
ssh cerberus "showmount -e hydra"
```

### Update Application Configs
Update Docker Compose or Kubernetes manifests to use new paths:
- Old: `/models`
- New: `hydra:/tank/models/ollama` (NFS mount)

## Rollback

Data remains in original locations until you manually delete it. To revert:
```bash
# Simply unmount or stop using /tank paths
# Original data untouched
```

## Post-Migration

Once verified (recommended: 1 week):
1. Update all application configs
2. Remove data from old locations to free space
3. Monitor performance and compression ratios

## Troubleshooting

**Migration slow?**
- Check network bandwidth: `iftop`
- Adjust rsync bandwidth limit in script

**NFS mount fails?**
- Check firewall: `ufw status`
- Verify exports: `exportfs -v`
- Test network: `ping chimera`
