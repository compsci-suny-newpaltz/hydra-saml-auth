# Phase 1: Hydra Storage Setup

## Overview

Configure Hydra's 6x7TB drives as a ZFS RAID-Z2 pool with 35TB usable capacity.

## Running the Script

```bash
# On Hydra as root
cd /home/infra/hydra-k3s
sudo ./scripts/setup-hydra-storage.sh
```

## What This Creates

- ZFS RAID-Z2 pool (35TB usable from 42TB raw)
- Automated hourly snapshots for containers  
- NFS exports for network access
- Compression and deduplication

See PLAN.md for full architecture details.
