# Hydra RKE2 Ansible Deployment

⚠️ **PRODUCTION DEPLOYMENT** - Read this entire document before running any playbooks.

Ansible playbooks for deploying the Hydra infrastructure on RKE2 Kubernetes across 3 nodes.

## Cluster Architecture

| Node | Role | IP | Hardware |
|------|------|-----|----------|
| Hydra | Control Plane | 192.168.1.160 | 251GB RAM, 21TB ZFS RAID-10 |
| Chimera | GPU Inference | 192.168.1.150 | 3x RTX 3090 (72GB VRAM) |
| Cerberus | GPU Training | 192.168.1.242 | 2x RTX 5090 (64GB VRAM) |

## ⚠️ Important Warnings

### Data Preservation
These playbooks are designed to **NOT lose data**:
- ✅ Existing ZFS pools are preserved (never created/destroyed automatically)
- ✅ Student volumes in `/srv/student-volumes` are untouched
- ✅ Docker containers continue running alongside RKE2
- ✅ NFS mounts are verified, not blindly overwritten
- ✅ Cluster tokens are preserved across runs (idempotent)

### What These Playbooks DO Change
- Install RKE2 binaries and services
- Configure kernel modules and sysctl parameters
- Disable swap (required for Kubernetes)
- Add entries to /etc/hosts
- Install NVIDIA container toolkit on GPU nodes

### What These Playbooks DO NOT Do
- ❌ Create or destroy ZFS pools
- ❌ Delete Docker or existing containers
- ❌ Modify firewall rules (disabled by default)
- ❌ Touch student data directories

## Prerequisites

1. **Control Machine** (where you run Ansible):
   ```bash
   pip install ansible
   ```

2. **Target Nodes**:
   - Ubuntu 22.04 LTS
   - SSH access with key-based auth
   - sudo/root access
   - NVIDIA drivers pre-installed on GPU nodes

3. **Network Requirements**:
   - All nodes can reach each other on internal network
   - NFS server running on Hydra with export at `/srv/hydra-nfs`
   - ZFS pool already created on Hydra

4. **Pre-Deployment Verification**:
   ```bash
   # On Hydra - verify ZFS
   zpool status

   # On Hydra - verify NFS export
   cat /etc/exports
   showmount -e localhost

   # On Chimera/Cerberus - verify NVIDIA drivers
   nvidia-smi
   ```

## Deployment Steps

### Step 0: Update Inventory (REQUIRED)

Edit `inventory.yml` with your actual IPs (already configured for the current cluster):

```yaml
control_plane:
  hosts:
    hydra:
      ansible_host: 192.168.1.160  # Hydra control plane

gpu_nodes:
  hosts:
    chimera:
      ansible_host: 192.168.1.150  # GPU inference node
    cerberus:
      ansible_host: 192.168.1.242  # GPU training node
```

### Step 1: Test Connectivity

```bash
cd ansible
ansible -i inventory.yml all -m ping
```

Expected output: All hosts should return "pong".

### Step 2: Run Pre-flight Backup (CRITICAL!)

```bash
ansible-playbook -i inventory.yml playbooks/00-preflight-backup.yml
```

This will:
- Create ZFS snapshot of student data
- Backup RKE2 config if exists
- Backup SQLite databases
- Record current system state
- **ABORT if student containers are running**

Verify backup location:
```bash
ssh hydra "ls -la /var/backups/hydra-migration-*"
```

### Step 3: Schedule Maintenance Window

Notify students:
```
Subject: Hydra Maintenance - [DATE] [TIME]

Hydra will undergo maintenance for Kubernetes migration.
Expected downtime: 1-2 hours

Please save your work and log out before the maintenance window.
```

### Step 4: Run Deployment

**Option A: Full deployment (all steps)**
```bash
ansible-playbook -i inventory.yml playbooks/site.yml
```

**Option B: Step-by-step (recommended for first deployment)**
```bash
# Prepare nodes (packages, kernel settings)
ansible-playbook -i inventory.yml playbooks/01-prepare-nodes.yml

# Install RKE2 on control plane
ansible-playbook -i inventory.yml playbooks/02-rke2-server.yml

# Join GPU nodes to cluster
ansible-playbook -i inventory.yml playbooks/03-rke2-agents.yml

# Configure NVIDIA GPU support
ansible-playbook -i inventory.yml playbooks/04-gpu-setup.yml

# Deploy Hydra K8s manifests
ansible-playbook -i inventory.yml playbooks/05-deploy-hydra.yml
```

### Step 5: Verify Deployment

```bash
export KUBECONFIG=$(pwd)/kubeconfig-hydra.yaml

# Check nodes
kubectl get nodes -o wide

# Expected output:
# NAME       STATUS   ROLES                       AGE   VERSION
# hydra      Ready    control-plane,etcd,master   5m    v1.28.4+rke2r1
# chimera    Ready    <none>                      3m    v1.28.4+rke2r1
# cerberus   Ready    <none>                      3m    v1.28.4+rke2r1

# Check GPU resources
kubectl describe node chimera | grep nvidia
kubectl describe node cerberus | grep nvidia

# Check pods
kubectl get pods -A
```

## Playbook Reference

| Playbook | Purpose | Safe to Re-run? |
|----------|---------|-----------------|
| `00-preflight-backup.yml` | Backup critical data | ✅ Yes |
| `01-prepare-nodes.yml` | Install packages, kernel config | ✅ Yes |
| `02-rke2-server.yml` | Install RKE2 control plane | ✅ Yes (preserves token) |
| `03-rke2-agents.yml` | Join worker nodes | ✅ Yes |
| `04-gpu-setup.yml` | Configure NVIDIA support | ✅ Yes |
| `05-deploy-hydra.yml` | Deploy K8s manifests | ✅ Yes |

## Rollback Procedures

### If RKE2 fails to start
```bash
# Check logs
journalctl -u rke2-server -f  # On Hydra
journalctl -u rke2-agent -f   # On GPU nodes

# Restore previous config
cp /etc/rancher/rke2/config.yaml.bak.* /etc/rancher/rke2/config.yaml
systemctl restart rke2-server
```

### If student data was affected
```bash
# List ZFS snapshots
zfs list -t snapshot

# Rollback to pre-migration snapshot
zfs rollback hydra-pool@pre-k8s-migration
```

### If cluster is completely broken
```bash
# On all nodes - remove RKE2 completely
/usr/local/bin/rke2-uninstall.sh  # or rke2-agent-uninstall.sh

# Restore from backup
# Then re-run playbooks
```

## Troubleshooting

### "Node token not available" error
The control plane must be deployed first:
```bash
ansible-playbook -i inventory.yml playbooks/02-rke2-server.yml
```

### GPU not detected in Kubernetes
```bash
# Verify NVIDIA driver on node
ssh chimera "nvidia-smi"

# Check device plugin pods
kubectl -n kube-system get pods | grep nvidia

# Check node resources
kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, gpu: .status.capacity["nvidia.com/gpu"]}'
```

### NFS mount fails on GPU nodes
```bash
# On Hydra - check NFS server
systemctl status nfs-server
cat /etc/exports
exportfs -ra

# On GPU node - test manually
showmount -e 192.168.1.160
mount -t nfs 192.168.1.160:/srv/hydra-nfs /mnt/hydra-nfs
```

### Connection refused to API server
```bash
# Check RKE2 server status
systemctl status rke2-server

# Check port is listening
netstat -tlnp | grep 6443

# Check firewall
ufw status
```

## File Locations

| File | Purpose |
|------|---------|
| `inventory.yml` | Node definitions and variables |
| `.cluster-token` | Saved cluster token (DO NOT DELETE) |
| `kubeconfig-hydra.yaml` | Kubectl config for cluster access |
| `/var/backups/hydra-migration-*` | Pre-deployment backups |

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review Ansible output for specific errors
3. Check system logs: `journalctl -u rke2-server -n 100`
4. Verify network connectivity between nodes
