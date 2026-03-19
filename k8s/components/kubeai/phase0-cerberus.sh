#!/bin/bash
# Phase 0 — Cerberus host setup
# Run on Cerberus as root or with sudo: ssh cerberus "sudo bash ~/phase0-cerberus.sh"
set -euo pipefail

echo "=== Phase 0a: Verify NVIDIA driver ==="
nvidia-smi --query-gpu=driver_version,name --format=csv,noheader
echo "Cerberus already on 570.211 — no upgrade needed"

echo ""
echo "=== Phase 0b: Configure 10GbE dedicated interconnect (eno1np0) ==="
# eno1np0 is the Intel X710 10GbE port (currently no IP, 10Gbps confirmed)
ip addr add 10.0.0.2/30 dev eno1np0 2>/dev/null || echo "IP already assigned"
ip link set eno1np0 mtu 9000 up

# Persist via netplan
cat > /etc/netplan/50-10gbe-interconnect.yaml << 'NETPLAN'
network:
  version: 2
  renderer: NetworkManager
  ethernets:
    eno1np0:
      addresses:
        - 10.0.0.2/30
      mtu: 9000
NETPLAN
netplan apply
echo "Netplan applied"

echo ""
echo "=== Phase 0c: Move Soft-RoCE to 10GbE interface ==="
# Currently rxe0 is on eno2np1 (1GbE) — move to eno1np0 (10GbE)
rdma link delete rxe0 2>/dev/null || true
rdma link add rxe0 type rxe netdev eno1np0

# Persist via systemd oneshot
cat > /etc/systemd/system/rxe-10gbe.service << 'SYSTEMD'
[Unit]
Description=Soft-RoCE on 10GbE interconnect
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'rdma link delete rxe0 2>/dev/null; rdma link add rxe0 type rxe netdev eno1np0'
ExecStop=/bin/bash -c 'rdma link delete rxe0 2>/dev/null'

[Install]
WantedBy=multi-user.target
SYSTEMD
systemctl daemon-reload
systemctl enable rxe-10gbe.service

echo ""
echo "=== Phase 0d: Create /models/huggingface directory ==="
mkdir -p /models/huggingface
chown infra:infra /models /models/huggingface

echo ""
echo "=== Done! No reboot required ==="
echo "Test 10GbE connectivity after chimera comes back up:"
echo "  ping -c 3 10.0.0.1"
