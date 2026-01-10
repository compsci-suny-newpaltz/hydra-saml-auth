# Phase 3: Deploy Storage Controllers

## Overview

Deploy Kubernetes controllers for storage tiering and automated backups.

## Prerequisites

- RKE2 cluster running on Hydra
- kubectl configured
- Phases 1 and 2 complete

## What Gets Deployed

1. **Storage Tiering Controller**
   - Monitors container access times
   - Migrates inactive containers to warm/cold storage
   - Runs hourly checks

2. **Backup Controller**
   - Creates daily ZFS snapshots
   - Manages snapshot retention
   - Runs at 2 AM daily

## Running Phase 3

```bash
cd /home/infra/hydra-k3s
./scripts/deploy-controllers.sh
```

## Verification

```bash
# Check controller pods
kubectl get pods -n storage-system

# View tiering controller logs
kubectl logs -f deployment/storage-tiering-controller -n storage-system

# Check backup schedule
kubectl get cronjobs -n storage-system

# Manual backup trigger
kubectl create job --from=cronjob/zfs-backup-controller manual-backup-$(date +%s) -n storage-system
```

## Configuration

Edit policies in:
- `manifests/storage-controller/storage-tiering-controller.yaml` - Tiering rules
- `manifests/storage-controller/backup-controller.yaml` - Backup retention

Apply changes:
```bash
kubectl apply -f manifests/storage-controller/
```

## Next Steps

Proceed to Phase 4: Data Migration
