# Hydra RKE2 Cluster

Migration from Docker to Rancher-managed RKE2 cluster with tiered storage and GPU optimization.

## Architecture

**3-Node Cluster:**
- **Hydra**: Control plane + 35TB RAID-Z2 storage
- **Chimera**: 3x GPU + 3TB NVMe model cache
- **Cerberus**: 3x GPU + 5TB NVMe training workspace

**Total Resources:**
- RAM: 566GB (251GB + 251GB + 64GB)
- Storage: 58TB (35TB RAID-Z2 + 8.8TB NVMe + 14.2TB backup/archive)
- GPUs: 5x NVIDIA (3x RTX 3090 on Chimera, 2x RTX 5090 on Cerberus)

## Quick Start

```bash
# Phase 1: Setup storage (Day 1)
./scripts/setup-hydra-storage.sh

# Phase 2: Configure fast tier (Day 2)
kubectl apply -f manifests/cache-config/

# Phase 3: Deploy controllers (Day 3)
kubectl apply -f manifests/storage-controller/
kubectl apply -f manifests/monitoring/

# Phase 4: Migrate data (Days 4-5)
./scripts/migrate-containers.sh
```

## Documentation

- [Full Technical Specification](SPECIFICATION.md)
- [Storage Architecture](docs/storage.md)
- [Backup Strategy](docs/backups.md)
- [Migration Guide](docs/migration.md)

## Project Structure

```
hydra-k3s/
├── README.md
├── SPECIFICATION.md
├── scripts/
│   ├── setup-hydra-storage.sh
│   ├── backup-controller.sh
│   ├── container-optimization.sh
│   └── network-aware-migration.py
├── manifests/
│   ├── cache-config/
│   ├── storage-controller/
│   ├── model-cache/
│   └── monitoring/
└── docs/
    ├── storage.md
    ├── backups.md
    └── migration.md
```

## Current Status

- [x] Repository initialized
- [ ] Storage pool created
- [ ] Fast tier configured
- [ ] Controllers deployed
- [ ] Migration complete
