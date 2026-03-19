#!/bin/bash
# Phase 0 — Chimera host setup
# Run on Chimera as root or with sudo: ssh chimera "sudo bash ~/phase0-chimera.sh"
set -euo pipefail

echo "=== Phase 0a: Upgrade NVIDIA driver to 570 ==="
apt update
apt install -y nvidia-driver-570

echo ""
echo "=== Phase 0b: Configure 10GbE dedicated interconnect (enp69s0) ==="
# Assign IP and enable jumbo frames
ip addr add 10.0.0.1/30 dev enp69s0 2>/dev/null || echo "IP already assigned"
ip link set enp69s0 mtu 9000 up

# Persist via netplan
cat > /etc/netplan/50-10gbe-interconnect.yaml << 'NETPLAN'
network:
  version: 2
  ethernets:
    enp69s0:
      addresses:
        - 10.0.0.1/30
      mtu: 9000
NETPLAN
echo "Netplan config written to /etc/netplan/50-10gbe-interconnect.yaml"

echo ""
echo "=== Phase 0c: Move Soft-RoCE to 10GbE interface ==="
rdma link delete rxe0 2>/dev/null || true
rdma link add rxe0 type rxe netdev enp69s0

# Persist via systemd oneshot
cat > /etc/systemd/system/rxe-10gbe.service << 'SYSTEMD'
[Unit]
Description=Soft-RoCE on 10GbE interconnect
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'rdma link delete rxe0 2>/dev/null; rdma link add rxe0 type rxe netdev enp69s0'
ExecStop=/bin/bash -c 'rdma link delete rxe0 2>/dev/null'

[Install]
WantedBy=multi-user.target
SYSTEMD
systemctl daemon-reload
systemctl enable rxe-10gbe.service

echo ""
echo "=== Phase 0d: Ensure /models/huggingface exists ==="
mkdir -p /models/huggingface
chown infra:infra /models /models/huggingface

echo ""
echo "=== Phase 0e: Install and configure lsyncd ==="
apt install -y lsyncd
mkdir -p /etc/lsyncd

cat > /etc/lsyncd/lsyncd.conf.lua << 'LSYNCD'
settings {
    logfile = "/var/log/lsyncd.log",
    statusFile = "/var/log/lsyncd-status.log",
    statusInterval = 20,
    maxProcesses = 4,
}

sync {
    default.rsync,
    source = "/models/huggingface/",
    target = "infra@10.0.0.2:/models/huggingface/",
    delay = 15,
    rsync = {
        binary = "/usr/bin/rsync",
        archive = true,
        compress = false,  -- don't compress over 10GbE local link
        _extra = {"--partial", "--inplace"},
    },
}
LSYNCD

systemctl enable lsyncd
# Don't start yet — wait until 10GbE is up on both nodes
echo ""
echo "=== Done! Reboot required for driver upgrade ==="
echo "Run: sudo reboot"
