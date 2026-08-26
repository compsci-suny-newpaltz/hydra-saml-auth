#!/bin/bash
# Build + deploy ilcc (ndg8743/web_ilcc) to hydra-infra.
#
#   scripts/deploy-ilcc.sh                 # pull main, build, import, roll
#   scripts/deploy-ilcc.sh --ref <branch|sha>
#   scripts/deploy-ilcc.sh --sync-downloads   # also push course files to the PVC
#   scripts/deploy-ilcc.sh --rollback      # kubectl rollout undo
#   scripts/deploy-ilcc.sh --no-cache
set -euo pipefail

REPO="https://github.com/ndg8743/web_ilcc.git"
SRC="/home/infra/web_ilcc"
REGISTRY="docker.io/ndg8743"
IMAGE="ilcc"
TAG="v$(date +%Y%m%d-%H%M%S)"
NS="hydra-infra"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS="${HERE}/../k8s/components/ilcc"
CTR="/var/lib/rancher/rke2/bin/ctr --address /run/k3s/containerd/containerd.sock --namespace k8s.io"
KUBECTL="/var/lib/rancher/rke2/bin/kubectl"
export KUBECONFIG="/etc/rancher/rke2/rke2.yaml"
PUBLIC="https://hydra.newpaltz.edu/ilcc"

REF="main"; CACHE_FLAG=""; SYNC=0; PULL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --no-cache) CACHE_FLAG="--no-cache"; shift ;;
    --sync-downloads) SYNC=1; shift ;;
    --no-pull) PULL=0; shift ;;
    --rollback)
      ${KUBECTL} -n ${NS} rollout undo deploy/ilcc
      ${KUBECTL} -n ${NS} rollout status deploy/ilcc --timeout=120s
      exit 0 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

# ---- 0. secret + middleware must agree on the proxy secret ----------------
if ! ${KUBECTL} -n ${NS} get secret ilcc-secret >/dev/null 2>&1; then
  echo "!! ilcc-secret missing. cp ${MANIFESTS}/secret.yaml.example ${MANIFESTS}/secret.yaml, edit, kubectl apply -f it."
  exit 1
fi
SECRET_VAL=$(${KUBECTL} -n ${NS} get secret ilcc-secret -o jsonpath='{.data.HYDRA_PROXY_SECRET}' | base64 -d)
if [[ -z "$SECRET_VAL" || "$SECRET_VAL" == "CHANGE-ME" ]]; then
  echo "!! ilcc-secret HYDRA_PROXY_SECRET is unset/placeholder. Set it (openssl rand -hex 32)."; exit 1
fi

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
sudo buildah bud ${CACHE_FLAG} --build-arg VITE_BASE=/ilcc/ \
  --label org.opencontainers.image.revision="$SHA" \
  -t ${IMAGE}:latest -t ${IMAGE}:${TAG} "$SRC"

# ---- 3. import into RKE2 containerd (no registry) ------------------------
echo "==> Importing into containerd"
sudo rm -f /tmp/ilcc-deploy.tar
sudo buildah push ${IMAGE}:${TAG} docker-archive:/tmp/ilcc-deploy.tar
sudo ${CTR} images import /tmp/ilcc-deploy.tar
sudo ${CTR} images tag localhost/${IMAGE}:${TAG} ${REGISTRY}/${IMAGE}:${TAG}
sudo ${CTR} images tag --force localhost/${IMAGE}:${TAG} ${REGISTRY}/${IMAGE}:latest   # cronjob uses :latest
sudo ${CTR} images label ${REGISTRY}/${IMAGE}:${TAG} io.cri-containerd.image=managed
sudo ${CTR} images label ${REGISTRY}/${IMAGE}:latest io.cri-containerd.image=managed
sudo rm -f /tmp/ilcc-deploy.tar

# ---- 4. manifests (idempotent) + secret sync into the Traefik middleware --
echo "==> Applying manifests"
${KUBECTL} apply -k "$MANIFESTS"
${KUBECTL} -n ${NS} patch middleware.traefik.io ilcc-proxy-secret --type=merge \
  -p "{\"spec\":{\"headers\":{\"customRequestHeaders\":{\"X-Hydra-Proxy-Secret\":\"${SECRET_VAL}\"}}}}" >/dev/null

# ---- 5. roll -------------------------------------------------------------
echo "==> Rolling deploy/ilcc → ${REGISTRY}/${IMAGE}:${TAG}"
${KUBECTL} -n ${NS} set image deploy/ilcc ilcc=${REGISTRY}/${IMAGE}:${TAG}
${KUBECTL} -n ${NS} rollout status deploy/ilcc --timeout=180s

# ---- 6. downloads --------------------------------------------------------
COUNT=$(${KUBECTL} -n ${NS} exec deploy/ilcc -- sh -c 'ls /data/downloads 2>/dev/null | wc -l' || echo 0)
if [[ $SYNC -eq 1 || "$COUNT" -eq 0 ]]; then
  echo "==> Syncing course downloads (have $COUNT files on the PVC)"
  "${HERE}/sync-ilcc-downloads.sh"
fi

# ---- 7. smoke ------------------------------------------------------------
echo "==> Waiting for the new pod to answer through Traefik"
for i in $(seq 1 40); do
  curl -sf --max-time 5 "${PUBLIC}/api/ready" >/dev/null 2>&1 && break
  sleep 3
done
echo "==> Smoke"
fail=0
chk() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
chk "health 200"            "curl -sf ${PUBLIC}/api/health | grep -q '\"status\":\"ok\"'"
chk "spa has /ilcc/assets"  "curl -s ${PUBLIC}/ | grep -q '/ilcc/assets/'"
chk "setup page 200"        "[ \"\$(curl -s -o /dev/null -w '%{http_code}' ${PUBLIC}/setup)\" = 200 ]"
chk "manifest public"       "curl -sf ${PUBLIC}/api/downloads/manifest | grep -q '\"files\"'"
# forward-auth answers 401 (not a redirect); the app renders a Sign-in link. The
# tell that the gate is at Traefik (not the app) is the absence of helmet headers.
chk "download gated at proxy"   "curl -sI ${PUBLIC}/api/downloads/cuh63Linux.zip | grep -q '^HTTP/[0-9.]* 401' && ! curl -sI ${PUBLIC}/api/downloads/cuh63Linux.zip | grep -qi x-content-type-options"
chk "autograder gated at proxy" "curl -sI ${PUBLIC}/autograder | grep -q '^HTTP/[0-9.]* 401' && ! curl -sI ${PUBLIC}/autograder | grep -qi x-content-type-options"
chk "ws /api/run handshake" "timeout 10 node -e \"const w=new WebSocket('wss://hydra.newpaltz.edu/ilcc/api/run');w.onopen=()=>{w.close();process.exit(0)};w.onerror=()=>process.exit(1)\""
[[ $fail -eq 0 ]] && echo "==> Deployed ${REGISTRY}/${IMAGE}:${TAG} ($SHA) → ${PUBLIC}" || { echo "==> Deployed but smoke FAILED — check: kubectl -n ${NS} logs deploy/ilcc"; exit 1; }
