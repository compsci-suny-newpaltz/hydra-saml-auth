#!/bin/bash
# k8s-dev-setup.sh - Bootstrap k3d development cluster for Hydra
# Usage: ./k8s-dev-setup.sh [create|destroy|status]

set -e

CLUSTER_NAME="hydra-dev"
K8S_DIR="$(dirname "$0")/../k8s"
DEV_DIR="$(dirname "$0")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v k3d &> /dev/null; then
        log_error "k3d is not installed. Install it from https://k3d.io"
        exit 1
    fi

    if ! command -v kubectl &> /dev/null; then
        log_error "kubectl is not installed. Install it from https://kubernetes.io/docs/tasks/tools/"
        exit 1
    fi

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed or not running"
        exit 1
    fi

    log_info "All prerequisites met"
}

# Create the k3d cluster
create_cluster() {
    check_prerequisites

    # Check if cluster already exists
    if k3d cluster list | grep -q "$CLUSTER_NAME"; then
        log_warn "Cluster '$CLUSTER_NAME' already exists"
        read -p "Do you want to delete and recreate it? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            destroy_cluster
        else
            log_info "Using existing cluster"
            return 0
        fi
    fi

    log_info "Creating k3d cluster '$CLUSTER_NAME'..."
    k3d cluster create "$CLUSTER_NAME" --config "$K8S_DIR/dev/k3d-config.yaml"

    # Wait for cluster to be ready
    log_info "Waiting for cluster to be ready..."
    kubectl wait --for=condition=Ready nodes --all --timeout=120s

    # Apply base manifests
    log_info "Applying base namespaces..."
    kubectl apply -f "$K8S_DIR/base/namespace.yaml"

    log_info "Applying RBAC..."
    kubectl apply -f "$K8S_DIR/base/rbac/"

    log_info "Applying storage classes..."
    kubectl apply -f "$K8S_DIR/base/storage/storage-classes.yaml" || log_warn "Storage classes may already exist"

    # Apply Traefik CRDs (if not included with k3d)
    log_info "Checking Traefik CRDs..."
    if ! kubectl get crd ingressroutes.traefik.io &> /dev/null; then
        log_info "Installing Traefik CRDs..."
        kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v2.10/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml
    fi

    # Apply components
    log_info "Deploying Traefik..."
    kubectl apply -f "$K8S_DIR/components/traefik/"

    log_info "Deploying mock services..."
    kubectl apply -k "$K8S_DIR/dev/mock-services/"

    log_info "Deploying Hydra Auth..."
    kubectl apply -f "$K8S_DIR/components/hydra-auth/"

    # Wait for deployments
    log_info "Waiting for deployments to be ready..."
    kubectl -n hydra-system wait --for=condition=Available deployment --all --timeout=180s || true

    log_info ""
    log_info "========================================="
    log_info "  k3d cluster '$CLUSTER_NAME' is ready!"
    log_info "========================================="
    log_info ""
    log_info "Access points:"
    log_info "  - Hydra Dashboard: http://localhost:6969"
    log_info "  - Traefik Dashboard: http://localhost:8080"
    log_info ""
    log_info "Useful commands:"
    log_info "  kubectl get pods -n hydra-system"
    log_info "  kubectl get pods -n hydra-students"
    log_info "  kubectl logs -n hydra-system deploy/hydra-auth"
    log_info ""
}

# Destroy the k3d cluster
destroy_cluster() {
    log_info "Destroying k3d cluster '$CLUSTER_NAME'..."
    k3d cluster delete "$CLUSTER_NAME" || log_warn "Cluster may not exist"
    log_info "Cluster destroyed"
}

# Show cluster status
show_status() {
    log_info "Cluster status for '$CLUSTER_NAME':"
    echo ""

    if ! k3d cluster list | grep -q "$CLUSTER_NAME"; then
        log_warn "Cluster '$CLUSTER_NAME' does not exist"
        return 1
    fi

    echo "=== Nodes ==="
    kubectl get nodes -o wide
    echo ""

    echo "=== Namespaces ==="
    kubectl get ns
    echo ""

    echo "=== Pods (hydra-system) ==="
    kubectl get pods -n hydra-system -o wide
    echo ""

    echo "=== Pods (hydra-students) ==="
    kubectl get pods -n hydra-students -o wide 2>/dev/null || echo "No student pods yet"
    echo ""

    echo "=== Services ==="
    kubectl get svc -n hydra-system
    echo ""

    echo "=== PVCs ==="
    kubectl get pvc -n hydra-system
    kubectl get pvc -n hydra-students 2>/dev/null || true
    echo ""
}

# Restart hydra-auth deployment
restart_hydra() {
    log_info "Restarting hydra-auth deployment..."
    kubectl -n hydra-system rollout restart deployment/hydra-auth
    kubectl -n hydra-system rollout status deployment/hydra-auth
    log_info "Restart complete"
}

# View logs
view_logs() {
    local service="${1:-hydra-auth}"
    log_info "Viewing logs for $service..."
    kubectl -n hydra-system logs -f "deploy/$service" --tail=100
}

# Shell into a pod
shell_into() {
    local service="${1:-hydra-auth}"
    log_info "Opening shell into $service..."
    kubectl -n hydra-system exec -it "deploy/$service" -- /bin/sh
}

# Main command handler
case "${1:-create}" in
    create)
        create_cluster
        ;;
    destroy)
        destroy_cluster
        ;;
    status)
        show_status
        ;;
    restart)
        restart_hydra
        ;;
    logs)
        view_logs "$2"
        ;;
    shell)
        shell_into "$2"
        ;;
    *)
        echo "Usage: $0 {create|destroy|status|restart|logs [service]|shell [service]}"
        echo ""
        echo "Commands:"
        echo "  create   - Create and configure the k3d development cluster"
        echo "  destroy  - Delete the k3d cluster"
        echo "  status   - Show cluster status and resources"
        echo "  restart  - Restart the hydra-auth deployment"
        echo "  logs     - View logs (default: hydra-auth)"
        echo "  shell    - Open shell into pod (default: hydra-auth)"
        exit 1
        ;;
esac
