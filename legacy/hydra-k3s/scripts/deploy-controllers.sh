#!/bin/bash
# Script: deploy-controllers.sh
# Purpose: Deploy storage tiering and backup controllers to RKE2
# Run on: Hydra (after RKE2 is installed)

set -euo pipefail

echo "=== Deploying Storage Controllers ==="
echo "This script deploys storage management controllers to RKE2"
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "ERROR: kubectl not found. Please install RKE2 first."
    exit 1
fi

# Check if we can connect to cluster
if ! kubectl cluster-info &> /dev/null; then
    echo "ERROR: Cannot connect to Kubernetes cluster"
    echo "Make sure RKE2 is running and KUBECONFIG is set"
    exit 1
fi

echo "Connected to cluster:"
kubectl cluster-info | head -1
echo ""

# Deploy storage system namespace and controllers
echo "Deploying storage-system namespace..."
kubectl apply -f manifests/storage-controller/storage-tiering-controller.yaml

echo ""
echo "Deploying backup controller..."
kubectl apply -f manifests/storage-controller/backup-controller.yaml

# Wait for controllers to be ready
echo ""
echo "Waiting for controllers to start..."
kubectl wait --for=condition=available --timeout=60s \
  deployment/storage-tiering-controller -n storage-system || true

# Show status
echo ""
echo "=== Deployment Status ==="
echo ""
echo "Namespaces:"
kubectl get ns storage-system

echo ""
echo "Deployments:"
kubectl get deployments -n storage-system

echo ""
echo "CronJobs:"
kubectl get cronjobs -n storage-system

echo ""
echo "ConfigMaps:"
kubectl get configmaps -n storage-system

echo ""
echo "Pods:"
kubectl get pods -n storage-system

echo ""
echo "=== Controller Deployment Complete ==="
echo ""
echo "To view controller logs:"
echo "  kubectl logs -f deployment/storage-tiering-controller -n storage-system"
echo ""
echo "To trigger backup manually:"
echo "  kubectl create job --from=cronjob/zfs-backup-controller manual-backup-\$(date +%s) -n storage-system"
echo ""
echo "Next steps:"
echo "1. Verify controllers are running: kubectl get pods -n storage-system"
echo "2. Check logs for any errors"
echo "3. Proceed to Phase 4: Data Migration"
