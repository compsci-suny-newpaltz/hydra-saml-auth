#!/bin/bash
# Build + deploy the Git Learning Journey (GG-git-learning) to hydra-infra.
#
#   scripts/deploy-git-learning.sh              # pull main, build, import, roll
#   scripts/deploy-git-learning.sh --ref <sha>  # build a specific ref
#   scripts/deploy-git-learning.sh --no-pull    # build the working tree as is
#   scripts/deploy-git-learning.sh --no-cache
#   scripts/deploy-git-learning.sh --rollback   # kubectl rollout undo
set -euo pipefail

REPO="https://github.com/compsci-suny-newpaltz/GG-git-learning.git"
SRC="/home/infra/GG-git-learning"
IMAGE="docker.io/library/gg-git-learning-app"
TAG="v$(date +%Y%m%d-%H%M%S)"
NS="hydra-infra"
DEPLOY="git-learning"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS="${HERE}/../k8s/components/git-learning"
CTR="/var/lib/rancher/rke2/bin/ctr --address /run/k3s/containerd/containerd.sock --namespace k8s.io"
KUBECTL="/var/lib/rancher/rke2/bin/kubectl"
export KUBECONFIG="/etc/rancher/rke2/rke2.yaml"
PUBLIC="https://hydra.newpaltz.edu/git"

REF="main"; CACHE_FLAG=""; PULL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-cache) CACHE_FLAG="--no-cache"; shift ;;
    --no-pull) PULL=0; shift ;;
    --rollback)
      ${KUBECTL} -n ${NS} rollout undo deploy/${DEPLOY}
      ${KUBECTL} -n ${NS} rollout status deploy/${DEPLOY} --timeout=120s
      exit 0 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

# ---- 1. source -----------------------------------------------------------
if [[ ! -d "$SRC/.git" ]]; then git clone "$REPO" "$SRC"; fi
if [[ $PULL -eq 1 ]]; then
  git -C "$SRC" fetch --quiet origin
  git -C "$SRC" checkout --quiet "$REF" 2>/dev/null || git -C "$SRC" checkout --quiet -B "$REF" "origin/$REF"
  git -C "$SRC" pull --ff-only --quiet origin "$REF" 2>/dev/null || true
fi
SHA=$(git -C "$SRC" rev-parse --short HEAD)
echo "==> Source: $REF @ $SHA"

# ---- 2. build ------------------------------------------------------------
echo "==> Building ${IMAGE}:${TAG} ${CACHE_FLAG}"
sudo buildah bud ${CACHE_FLAG} \
  --label org.opencontainers.image.revision="$SHA" \
  -t ${IMAGE}:${TAG} "$SRC"

# ---- 3. import into RKE2 containerd (no registry; imagePullPolicy Never) --
echo "==> Importing into containerd"
TARBALL="/tmp/git-learning-deploy.tar"
sudo rm -f "$TARBALL"
sudo buildah push ${IMAGE}:${TAG} docker-archive:"$TARBALL"
sudo ${CTR} images import "$TARBALL"
sudo ${CTR} images tag --force ${IMAGE}:${TAG} ${IMAGE}:latest
sudo ${CTR} images label ${IMAGE}:${TAG} io.cri-containerd.image=managed
sudo ${CTR} images label ${IMAGE}:latest io.cri-containerd.image=managed
sudo rm -f "$TARBALL"

# ---- 4. manifests + roll -------------------------------------------------
echo "==> Applying manifests"
${KUBECTL} apply -f "$MANIFESTS"
echo "==> Rolling deploy/${DEPLOY} → ${IMAGE}:${TAG}"
${KUBECTL} -n ${NS} set image deploy/${DEPLOY} ${DEPLOY}=${IMAGE}:${TAG}
${KUBECTL} -n ${NS} rollout status deploy/${DEPLOY} --timeout=180s

# ---- 5. smoke ------------------------------------------------------------
# Traefik may still hand requests to the draining pod for a few seconds.
echo "==> Waiting for the new pod to answer through Traefik"
for i in $(seq 1 30); do
  curl -sf --max-time 5 "${PUBLIC}/healthz" >/dev/null 2>&1 && \
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${PUBLIC}/module/git-intro")" = 200 ] && break
  sleep 2
done
echo "==> Smoke"
fail=0
chk() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
chk "healthz"            "curl -sf --max-time 10 ${PUBLIC}/healthz | grep -q '\"ok\":true'"
chk "home 200"           "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${PUBLIC}/)\" = 200 ]"
chk "deep link 200"      "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${PUBLIC}/module/git-intro)\" = 200 ]"
chk "api modules"        "curl -sf ${PUBLIC}/api/modules | grep -q '\"modules\"'"
chk "bundle served"      "curl -s ${PUBLIC}/ | grep -o '/git/static/js/main[^\"]*' | head -1 | xargs -I{} sh -c 'curl -sf -o /dev/null https://hydra.newpaltz.edu{}'"
[[ $fail -eq 0 ]] && echo "==> Deployed ${IMAGE}:${TAG} ($SHA) → ${PUBLIC}" || { echo "==> Deployed but smoke FAILED — check: kubectl -n ${NS} logs deploy/${DEPLOY}"; exit 1; }
