# Phase 2: Fast-Tier Cache Configuration

## Overview

Configure NVMe drives on Chimera and Cerberus for high-speed model caching and training workspaces.

## Scripts

1. **setup-chimera-cache.sh** - Chimera model cache (3TB NVMe + 3.5TB HDD archive)
2. **setup-cerberus-workspace.sh** - Cerberus training workspace (3.1TB + 1.7TB NVMe)

## Running Phase 2

### On Chimera
```bash
cd /home/infra/hydra-k3s
sudo ./scripts/setup-chimera-cache.sh
```

**Creates**:
- `/cache` (3TB NVMe) - Hot model cache
- `/archive` (3.5TB HDD) - Model archive via LVM
- `/var/lib/metrics` (0.93TB) - Prometheus data

### On Cerberus
```bash
cd /home/infra/hydra-k3s
sudo ./scripts/setup-cerberus-workspace.sh
```

**Creates**:
- `/workspace` (3.1TB NVMe) - Active training jobs
- `/scratch` (1.7TB NVMe) - Temporary data
- Automatic cleanup of scratch older than 7 days

## Verification

### Chimera
```bash
df -h | grep -E "(cache|archive|metrics)"
ls -la /cache/models/
nvidia-smi  # Verify 3x RTX 3090
```

### Cerberus
```bash
df -h | grep -E "(workspace|scratch)"
ls -la /workspace/training/
nvidia-smi  # Verify 2x RTX 5090
```

## Next Steps

After Phase 2, you can:
1. Test NFS mounts between all nodes
2. Proceed to Phase 3: Deploy storage tiering controllers
3. Configure Ollama to use fast cache
