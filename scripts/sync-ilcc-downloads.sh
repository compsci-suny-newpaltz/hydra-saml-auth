#!/bin/bash
# Push the course software package + textbook onto the ilcc-downloads PVC and
# verify checksums. Idempotent. Run by deploy-ilcc.sh on first deploy or with
# --sync-downloads; run directly after updating a file in /home/infra.
set -euo pipefail
NS="hydra-infra"
KUBECTL="/var/lib/rancher/rke2/bin/kubectl"
export KUBECONFIG="/etc/rancher/rke2/rke2.yaml"
SRCDIR="/home/infra"
DEST="/data/downloads"

# local name → name on the PVC (what the app's DESCRIPTORS table expects)
declare -A FILES=(
  ["cuh63Linux.zip"]="cuh63Linux.zip"
  ["cuh63MacIntel.zip"]="cuh63MacIntel.zip"
  ["cuh63MacArm.zip"]="cuh63MacArm.zip"
  ["cuh63Windows.zip"]="cuh63Windows.zip"
  ["executables.zip"]="executables.zip"
  ["C and C++ Under the Hood 2nd Edition (1).pdf"]="cuh-2e.pdf"
  ["cuh63.zip"]="cuh63.zip"            # unified package, if built (scripts/build-unified-cuh63.sh)
)

POD=$(${KUBECTL} -n ${NS} get pod -l app=ilcc -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')
[[ -n "$POD" ]] || { echo "no running ilcc pod"; exit 1; }

for local in "${!FILES[@]}"; do
  remote="${FILES[$local]}"
  src="${SRCDIR}/${local}"
  [[ -f "$src" ]] || { echo "  skip (absent): $local"; continue; }
  lsum=$(sha256sum "$src" | cut -d' ' -f1)
  rsum=$(${KUBECTL} -n ${NS} exec "$POD" -- sh -c "sha256sum '${DEST}/${remote}' 2>/dev/null | cut -d' ' -f1" || true)
  if [[ "$lsum" == "$rsum" ]]; then echo "  up-to-date: $remote"; continue; fi
  echo "  copying: $local → $remote ($(du -h "$src" | cut -f1))"
  ${KUBECTL} -n ${NS} cp "$src" "${POD}:${DEST}/${remote}"
  rsum=$(${KUBECTL} -n ${NS} exec "$POD" -- sh -c "sha256sum '${DEST}/${remote}' | cut -d' ' -f1")
  [[ "$lsum" == "$rsum" ]] || { echo "  !! checksum mismatch for $remote"; exit 1; }
  echo "  verified: $remote"
done

# Tell the app to rebuild its manifest + materials index (admin-only endpoints;
# call from inside the pod where identity headers aren't needed... they are.
# Simplest: restart is cheap, but a rescan is cheaper. Use exec + curl with a
# loopback secret-free path isn't allowed, so bounce the pod.)
echo "  restarting pod so manifest + materials index pick up the files"
${KUBECTL} -n ${NS} rollout restart deploy/ilcc >/dev/null
${KUBECTL} -n ${NS} rollout status deploy/ilcc --timeout=120s
echo "  done"
