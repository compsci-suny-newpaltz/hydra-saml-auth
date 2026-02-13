#!/bin/bash
# build-deploy.sh — Build and deploy hydra-saml-auth to the RKE2 cluster
# Always runs from the hydra-saml-auth source directory to avoid wrong-context builds.
#
# Usage:
#   ./scripts/build-deploy.sh              # build + deploy hydra-auth
#   ./scripts/build-deploy.sh student      # build + deploy student-container
#   ./scripts/build-deploy.sh both         # build + deploy both

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CTR="sudo /var/lib/rancher/rke2/bin/ctr --address /run/k3s/containerd/containerd.sock -n k8s.io"
KUBECONFIG="/etc/rancher/rke2/rke2.yaml"
export KUBECONFIG

TAG="v$(date +%Y%m%d-%H%M%S)"
TARGET="${1:-auth}"

build_auth() {
    echo "=== Building hydra-auth (tag: $TAG) ==="
    local IMAGE="docker.io/ndg8743/hydra-saml-auth:$TAG"
    local TAR="/tmp/hydra-auth-${TAG}.tar"

    sudo buildah bud -t "ndg8743/hydra-saml-auth:$TAG" "$PROJECT_DIR"
    sudo rm -f "$TAR"
    sudo buildah push "ndg8743/hydra-saml-auth:$TAG" "docker-archive:${TAR}:${IMAGE}"
    $CTR images import "$TAR"
    sudo rm -f "$TAR"

    echo "=== Deploying hydra-auth ==="
    kubectl -n hydra-system set image deploy/hydra-auth "hydra-auth=${IMAGE}"
    kubectl -n hydra-system rollout status deploy/hydra-auth --timeout=120s

    echo "=== Verifying ==="
    sleep 5
    local LINES
    LINES=$(kubectl exec -n hydra-system deploy/hydra-auth -- wc -l /app/routes/containers.js 2>/dev/null | awk '{print $1}')
    local SRC_LINES
    SRC_LINES=$(wc -l < "$PROJECT_DIR/routes/containers.js")
    if [ "$LINES" = "$SRC_LINES" ]; then
        echo "OK: containers.js line count matches ($LINES lines)"
    else
        echo "WARNING: containers.js mismatch! deployed=$LINES source=$SRC_LINES"
        exit 1
    fi
    echo "=== hydra-auth deployed successfully ==="
}

build_student() {
    echo "=== Building student-container (tag: $TAG) ==="
    local IMAGE="docker.io/ndg8743/hydra-student-container:$TAG"
    local TAR="/tmp/student-container-${TAG}.tar"

    sudo buildah bud -t "ndg8743/hydra-student-container:$TAG" "$PROJECT_DIR/student-container"
    sudo rm -f "$TAR"
    sudo buildah push "ndg8743/hydra-student-container:$TAG" "docker-archive:${TAR}:${IMAGE}"
    $CTR images import "$TAR"
    sudo rm -f "$TAR"

    echo "=== student-container image imported ($TAG) ==="
    echo "NOTE: Existing student pods need restart to use the new image."
    echo "  Update STUDENT_IMAGE in .env or K8s configmap to: $IMAGE"
}

case "$TARGET" in
    auth)    build_auth ;;
    student) build_student ;;
    both)    build_auth; build_student ;;
    *)       echo "Usage: $0 {auth|student|both}"; exit 1 ;;
esac
