#!/bin/bash
# Deploy hydra-saml-auth to K8s
# Usage: ./deploy.sh [--no-cache]
set -euo pipefail

REGISTRY="docker.io/ndg8743"
IMAGE="hydra-saml-auth"
TAG="v$(date +%Y%m%d-%H%M%S)"
CTR="/var/lib/rancher/rke2/bin/ctr --address /run/k3s/containerd/containerd.sock --namespace k8s.io"
KUBECTL="/var/lib/rancher/rke2/bin/kubectl"
KUBECONFIG="/etc/rancher/rke2/rke2.yaml"
export KUBECONFIG

CACHE_FLAG=""
if [[ "${1:-}" == "--no-cache" ]]; then
  CACHE_FLAG="--no-cache"
fi

echo "==> Building ${IMAGE}:${TAG} ${CACHE_FLAG}"
sudo buildah bud ${CACHE_FLAG} -t ${IMAGE}:latest -t ${IMAGE}:${TAG} .

echo "==> Exporting to tar"
sudo rm -f /tmp/hydra-deploy.tar
sudo buildah push ${IMAGE}:${TAG} docker-archive:/tmp/hydra-deploy.tar

echo "==> Importing into containerd"
sudo ${CTR} images import /tmp/hydra-deploy.tar

echo "==> Tagging as ${REGISTRY}/${IMAGE}:${TAG}"
sudo ${CTR} images tag localhost/${IMAGE}:${TAG} ${REGISTRY}/${IMAGE}:${TAG}
sudo ${CTR} images label ${REGISTRY}/${IMAGE}:${TAG} io.cri-containerd.image=managed

echo "==> Updating deployment"
${KUBECTL} set image deployment/hydra-auth -n hydra-system hydra-auth=${REGISTRY}/${IMAGE}:${TAG}
${KUBECTL} rollout status deployment/hydra-auth -n hydra-system --timeout=120s

echo "==> Cleaning up"
sudo rm -f /tmp/hydra-deploy.tar

echo "==> Deployed ${REGISTRY}/${IMAGE}:${TAG}"
