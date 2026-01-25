# RDMA, SR-IOV & GPUDirect Setup Guide

## Overview

This guide documents the setup of RDMA networking for the Hydra cluster, including:
- **SoftRoCE (RXE)**: Software RDMA over Converged Ethernet for testing/non-HCA hosts
- **SR-IOV**: Single Root I/O Virtualization for Mellanox/NVIDIA NICs
- **DOCA**: NVIDIA data center infrastructure toolkit
- **GPUDirect RDMA**: Direct GPU-to-NIC communication bypassing CPU

## Table of Contents
1. [Installation Order (Critical)](#installation-order-critical)
2. [SoftRoCE Setup](#softroce-setup)
3. [SR-IOV Configuration](#sr-iov-configuration)
4. [DOCA Installation](#doca-installation)
5. [GPUDirect RDMA](#gpudirect-rdma)
6. [KVM/QEMU Passthrough](#kvmqemu-passthrough)
7. [Verification & Testing](#verification--testing)
8. [Troubleshooting](#troubleshooting)

---

## Installation Order (Critical)

**The order of installation is crucial for GPUDirect RDMA to work properly.**

### Correct Order:

```
1. MLNX_OFED / DOCA (network drivers)
        ↓
2. NVIDIA GPU Drivers (includes nvidia-peermem)
        ↓
3. CUDA Toolkit
        ↓
4. Load nvidia-peermem module
```

### Why This Order Matters:

> "If the NVIDIA GPU driver is installed before MLNX_OFED, the GPU driver must be uninstalled and installed again to make sure nvidia-peermem is compiled with the RDMA APIs that are provided by MLNX_OFED."

The `nvidia-peermem` module needs to compile against MLNX_OFED's RDMA peer memory APIs. If MLNX_OFED is installed after the GPU driver, the peermem module won't have access to these APIs.

---

## SoftRoCE Setup

SoftRoCE (RXE) provides a software implementation of RDMA over Ethernet, available in Linux kernels 4.8+.

> **Note**: SoftRoCE is deprecated in RHEL 10 and is considered Technology Preview. For production, use hardware RoCE adapters (ConnectX-3 or newer).

### Prerequisites

```bash
# Install required packages
sudo apt install rdma-core ibverbs-utils perftest

# Or on RHEL/CentOS
sudo dnf install rdma-core libibverbs-utils perftest
```

### Kernel Module Check

```bash
# Verify kernel has RXE support
modprobe rdma_rxe
lsmod | grep rdma_rxe
```

If missing, rebuild kernel with:
- `CONFIG_INFINIBAND=m`
- `CONFIG_INFINIBAND_RDMAVT=m`
- `CONFIG_RDMA_RXE=m`

### Create SoftRoCE Device

```bash
# Modern method (rdma command - replaces deprecated rxe_cfg)
sudo rdma link add rxe0 type rxe netdev eth0

# Verify creation
rdma link
ibv_devices
```

### Make Persistent Across Reboots

```bash
# Create systemd service
cat <<EOF | sudo tee /etc/systemd/system/softroce.service
[Unit]
Description=SoftRoCE RDMA Device
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/rdma link add rxe0 type rxe netdev eth0
ExecStop=/usr/sbin/rdma link delete rxe0

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now softroce
```

### SoftRoCE Parameters (Optional Tuning)

```bash
# View parameters
ls /sys/module/rdma_rxe/parameters/

# Key parameters:
# max_ucontext - limit on user contexts
# max_qp       - limit on queue pairs
# max_qp_wr    - limit on work requests per QP
# max_mr       - limit on memory regions
# crc_disable  - disable ICRC computation (set to 1 for testing)
```

---

## SR-IOV Configuration

SR-IOV allows a single physical NIC to present multiple virtual functions (VFs) to VMs.

### Prerequisites

1. **BIOS Settings**:
   - Enable "SR-IOV"
   - Enable "Intel Virtualization Technology" (VT-d)
   - Enable "IOMMU"

2. **Kernel Parameters** (`/etc/default/grub`):
   ```bash
   GRUB_CMDLINE_LINUX="intel_iommu=on iommu=pt"
   ```
   Then: `sudo update-grub && sudo reboot`

3. **MLNX_OFED installed**

### Enable SR-IOV on Mellanox Adapter

```bash
# Start MST
sudo mst start

# Check current configuration
sudo mlxconfig -d /dev/mst/mt4115_pciconf0 q | grep -i sriov

# Enable SR-IOV with 2 VFs (for 2 VMs)
sudo mlxconfig -d /dev/mst/mt4115_pciconf0 set SRIOV_EN=1 NUM_OF_VFS=2

# Reboot required
sudo reboot
```

### Create Virtual Functions

```bash
# After reboot, create VFs
# For ConnectX-5 and newer:
echo 2 > /sys/class/infiniband/mlx5_0/device/sriov_numvfs

# For older kernels:
echo 2 > /sys/class/infiniband/mlx5_0/device/mlx5_num_vfs

# Verify VFs created
lspci | grep Mellanox
# Should show PF + 2 VFs
```

### Configure VF GUIDs (InfiniBand only)

```bash
# Set node GUID for VF 0
echo 00:11:22:33:44:55:01:00 > /sys/class/infiniband/mlx5_0/device/sriov/0/node

# Set port GUID for VF 0
echo 00:11:22:33:44:55:02:00 > /sys/class/infiniband/mlx5_0/device/sriov/0/port

# Set policy (Up, Down, or Follow)
echo Follow > /sys/class/infiniband/mlx5_0/device/sriov/0/policy
```

### Configure VF for Ethernet (RoCE)

```bash
# Set MAC address
ip link set dev ens785f0 vf 0 mac 00:11:22:33:44:55

# Set VLAN (optional)
ip link set dev ens785f0 vf 0 vlan 100

# Enable spoofcheck (security)
ip link set dev ens785f0 vf 0 spoofchk on

# Set trust mode (required for promiscuous mode)
ip link set dev ens785f0 vf 0 trust on
```

### Unbind VFs for VM Assignment

```bash
# Find VF PCI address
lspci | grep -i mellanox | grep "Virtual"
# Example: 09:00.2 ... Virtual Function

# Unbind from host driver before assigning to VM
echo 0000:09:00.2 > /sys/bus/pci/drivers/mlx5_core/unbind
```

### SR-IOV Limitations

1. **OpenSM must run on PF, not VFs** - Add to `/etc/opensm/opensm.conf`:
   ```
   virt_enabled 2
   ```

2. **Don't stop driver with VMs using VFs** - Will hang the machine

3. **VF count limited by firmware** - Check with `mlxconfig`

---

## DOCA Installation

NVIDIA DOCA provides drivers and tools for data center infrastructure.

### Prerequisites

```bash
# Verify kernel headers match running kernel
ls /lib/modules/$(uname -r)/build

# Check GCC version matches kernel build
gcc --version
```

### Installation (Ubuntu/Debian)

```bash
# Download DOCA repo package from NVIDIA DOCA Downloads
# https://developer.nvidia.com/networking/doca

# Install repo
sudo dpkg -i doca-repo-*.deb
sudo apt-get update

# Install DOCA (full profile)
sudo apt install -y doca-all

# Install firmware updater
sudo apt install -y mlnx-fw-updater

# Restart drivers
sudo /etc/init.d/openibd restart

# Initialize MST
sudo mst restart
```

### Installation (RHEL/CentOS)

```bash
# Install repo
sudo rpm -Uvh doca-repo-*.rpm
sudo yum makecache

# Install DOCA
sudo yum install -y doca-all

# Restart services
sudo /etc/init.d/openibd restart
sudo mst restart
```

### Secure Boot (DKMS Key Import)

```bash
# If using Secure Boot, import DKMS key
sudo mokutil --import /var/lib/dkms/mok.pub
# Set enrollment password, then reboot
# Complete MOK enrollment in UEFI
```

### Verify Installation

```bash
# Check DOCA info
doca-info

# Check OFED version
ofed_info -s

# List Mellanox devices
mst status
ibstat
```

---

## GPUDirect RDMA

GPUDirect RDMA enables direct data transfer between GPU memory and network adapters.

### Prerequisites

- NVIDIA GPU (Kepler-class or newer)
- NVIDIA ConnectX-3 or newer adapter
- Both devices on same PCI Express root complex
- MLNX_OFED installed BEFORE GPU drivers

### Install nvidia-peermem

```bash
# Remove old nv_peer_mem if present
sudo service nv_peer_mem stop 2>/dev/null
sudo rmmod nv_peer_mem 2>/dev/null

# For DEB systems
sudo dpkg -P nvidia-peer-memory nvidia-peer-memory-dkms 2>/dev/null

# For RPM systems
sudo rpm -e nvidia_peer_memory 2>/dev/null

# Load nvidia-peermem (included in modern NVIDIA drivers)
sudo modprobe nvidia-peermem

# Verify
lsmod | grep nvidia_peermem
```

### Make nvidia-peermem Persistent

```bash
# Auto-load on boot
echo "nvidia-peermem" | sudo tee /etc/modules-load.d/nvidia-peermem.conf
```

### Verify GPUDirect RDMA

```bash
# Check BAR space allocation
nvidia-smi -q | grep -A3 "BAR1"

# Check nvidia-peermem is loaded
lsmod | grep nvidia_peermem

# Test with perftest (requires two nodes)
# Server:
ib_write_bw -d mlx5_0 --use_cuda=0

# Client:
ib_write_bw -d mlx5_0 --use_cuda=0 <server_ip>
```

### DMA-BUF vs nvidia-peermem

NVIDIA recommends using DMA-BUF (Linux kernel feature) over nvidia-peermem for new deployments:

- **DMA-BUF**: Native kernel support, better integration
- **nvidia-peermem**: Legacy method, still required for some workloads

---

## KVM/QEMU Passthrough

Passing SR-IOV VFs to VMs using libvirt.

### Get VF PCI Address

```bash
# List all Mellanox VFs
lspci -nn | grep -i mellanox | grep "Virtual"
# Example output:
# 09:00.2 Ethernet controller [0200]: Mellanox Technologies MT27800 Family [ConnectX-5 Virtual Function]
# 09:00.3 Ethernet controller [0200]: Mellanox Technologies MT27800 Family [ConnectX-5 Virtual Function]
```

### Detach VF from Host

```bash
# Using virsh
virsh nodedev-detach pci_0000_09_00_2
```

### Add VF to VM (libvirt XML)

```xml
<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x09' slot='0x00' function='0x2'/>
  </source>
  <address type='pci' domain='0x0000' bus='0x00' slot='0x05' function='0x0'/>
</hostdev>
```

### Add via virsh

```bash
# Create hostdev XML file
cat <<EOF > /tmp/vf-passthrough.xml
<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x09' slot='0x00' function='0x2'/>
  </source>
</hostdev>
EOF

# Attach to running VM
virsh attach-device <vm-name> /tmp/vf-passthrough.xml --persistent

# Or edit VM config directly
virsh edit <vm-name>
```

### VM Guest Configuration

Inside the VM:

```bash
# Install MLNX_OFED or DOCA
# (Same steps as host installation)

# Verify VF is visible
lspci | grep Mellanox
ibstat

# Assign IP address
ip addr add 192.168.100.10/24 dev eth0
ip link set eth0 up
```

---

## Verification & Testing

### Test RDMA Connectivity (ibping)

```bash
# Server (Node A)
ibping -S

# Client (Node B)
ibping -G <server_guid>
# or
ibping <server_lid>
```

### Test RDMA Bandwidth (ib_write_bw)

```bash
# Server
ib_write_bw -d mlx5_0

# Client
ib_write_bw -d mlx5_0 <server_ip>
```

### Test RDMA Latency (ib_write_lat)

```bash
# Server
ib_write_lat -d mlx5_0

# Client
ib_write_lat -d mlx5_0 <server_ip>
```

### Test SoftRoCE (rping)

```bash
# Server
rping -s -v

# Client
rping -c -v -a <server_ip>
```

### Verify GPUDirect RDMA

```bash
# With CUDA-aware perftest
ib_write_bw -d mlx5_0 --use_cuda=0

# Check nvidia-peermem is active
cat /sys/kernel/debug/nvidia-peermem/version
```

---

## Troubleshooting

### SR-IOV VFs Not Created

```bash
# Check BIOS settings
dmesg | grep -i iommu

# Verify kernel parameter
cat /proc/cmdline | grep iommu

# Check firmware supports SR-IOV
mlxconfig -d /dev/mst/mt4115_pciconf0 q | grep -i sriov
```

### nvidia-peermem Won't Load

```bash
# Check MLNX_OFED is installed first
ofed_info -s

# Reinstall GPU driver after MLNX_OFED
# (Driver must be compiled with MLNX_OFED APIs)

# Check for errors
dmesg | grep -i peermem
```

### RDMA Connection Fails

```bash
# Check port state
ibstat

# Check subnet manager is running (InfiniBand)
sminfo

# Check RoCE GID table
show_gids

# Verify connectivity
ibping -S  # server
ibping -G <guid>  # client
```

### SoftRoCE Not Working

```bash
# Check module is loaded
lsmod | grep rdma_rxe

# Check device exists
rdma link
ibv_devices

# Recreate if needed
rdma link delete rxe0
rdma link add rxe0 type rxe netdev eth0
```

### VM Can't See VF

```bash
# On host, verify VF is unbound
ls /sys/bus/pci/drivers/mlx5_core/ | grep <vf_address>

# Check VF is passed to VM
virsh dumpxml <vm-name> | grep hostdev -A5

# In VM, check PCI devices
lspci | grep -i mellanox
```

---

## Hydra Cluster Specifics

### Node Configuration

| Node | Role | NIC | GPUs | RDMA |
|------|------|-----|------|------|
| Hydra | Control Plane | onboard | None | SoftRoCE (testing) |
| Chimera | Inference | ConnectX-? | 3x RTX 3090 | Hardware RoCE |
| Cerberus | Training | ConnectX-? | 2x RTX 5090 | Hardware RoCE + GPUDirect |

### VM RDMA Setup (Cerberus)

1. Create 2 SR-IOV VFs on ConnectX adapter
2. Assign one VF to each training VM
3. Configure IP addresses on VF interfaces
4. Test with ibping/rping

### Recommended IP Scheme (RDMA Network)

```
Hydra:    192.168.100.1/24  (SoftRoCE on bond0/eth0)
Chimera:  192.168.100.2/24  (VF or PF)
Cerberus: 192.168.100.3/24  (PF for host)
  VM1:    192.168.100.10/24 (VF passthrough)
  VM2:    192.168.100.11/24 (VF passthrough)
```

---

## References

- [NVIDIA MLNX_OFED SR-IOV Documentation](https://docs.nvidia.com/networking/display/mlnxofedv581011/single+root+io+virtualization+(sr-iov))
- [NVIDIA DOCA Host Installation](https://docs.nvidia.com/doca/sdk/doca-host-installation-and-upgrade/index.html)
- [GPUDirect RDMA Documentation](https://docs.nvidia.com/cuda/gpudirect-rdma/)
- [Red Hat RoCE Configuration Guide](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/configuring_infiniband_and_rdma_networks/configuring-roce_configuring-infiniband-and-rdma-networks)
- [Red Hat KVM Device Passthrough](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/configuring_and_managing_linux_virtual_machines/attaching-host-devices-to-virtual-machines)
- [Linux NFS SoftRoCE Setup](https://linux-nfs.org/wiki/index.php/NFS_over_SoftRoCE_setup)
- [rxe(7) man page](https://man7.org/linux/man-pages/man7/rxe.7.html)
