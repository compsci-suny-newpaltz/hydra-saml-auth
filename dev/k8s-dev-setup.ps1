# k8s-dev-setup.ps1 - Bootstrap k3d development cluster for Hydra (Windows)
# Usage: .\k8s-dev-setup.ps1 [create|destroy|status]

param(
    [Parameter(Position=0)]
    [ValidateSet('create', 'destroy', 'status', 'restart', 'logs', 'shell')]
    [string]$Command = 'create',

    [Parameter(Position=1)]
    [string]$Service = 'hydra-auth'
)

$ErrorActionPreference = "Stop"

$ClusterName = "hydra-dev"
$K8sDir = Join-Path (Split-Path $PSScriptRoot -Parent) "k8s"
$DevDir = $PSScriptRoot

function Write-Info { param($msg) Write-Host "[INFO] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Test-Prerequisites {
    Write-Info "Checking prerequisites..."

    if (-not (Get-Command k3d -ErrorAction SilentlyContinue)) {
        Write-Err "k3d is not installed. Install from https://k3d.io"
        exit 1
    }

    if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
        Write-Err "kubectl is not installed. Install from https://kubernetes.io/docs/tasks/tools/"
        exit 1
    }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Err "Docker is not installed or not running"
        exit 1
    }

    Write-Info "All prerequisites met"
}

function New-Cluster {
    Test-Prerequisites

    $existing = k3d cluster list 2>$null | Select-String $ClusterName
    if ($existing) {
        Write-Warn "Cluster '$ClusterName' already exists"
        $response = Read-Host "Do you want to delete and recreate it? (y/N)"
        if ($response -eq 'y' -or $response -eq 'Y') {
            Remove-Cluster
        } else {
            Write-Info "Using existing cluster"
            return
        }
    }

    Write-Info "Creating k3d cluster '$ClusterName'..."
    k3d cluster create $ClusterName --config "$K8sDir\dev\k3d-config.yaml"

    Write-Info "Waiting for cluster to be ready..."
    kubectl wait --for=condition=Ready nodes --all --timeout=120s

    Write-Info "Applying base namespaces..."
    kubectl apply -f "$K8sDir\base\namespace.yaml"

    Write-Info "Applying RBAC..."
    kubectl apply -f "$K8sDir\base\rbac\"

    Write-Info "Applying storage classes..."
    kubectl apply -f "$K8sDir\base\storage\storage-classes.yaml" 2>$null

    Write-Info "Checking Traefik CRDs..."
    $crd = kubectl get crd ingressroutes.traefik.io 2>$null
    if (-not $crd) {
        Write-Info "Installing Traefik CRDs..."
        kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v2.10/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml
    }

    Write-Info "Deploying Traefik..."
    kubectl apply -f "$K8sDir\components\traefik\"

    Write-Info "Deploying mock services..."
    kubectl apply -k "$K8sDir\dev\mock-services\"

    Write-Info "Deploying Hydra Auth..."
    kubectl apply -f "$K8sDir\components\hydra-auth\"

    Write-Info "Waiting for deployments..."
    kubectl -n hydra-system wait --for=condition=Available deployment --all --timeout=180s 2>$null

    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Cyan
    Write-Host "  k3d cluster '$ClusterName' is ready!" -ForegroundColor Cyan
    Write-Host "=========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Info "Access points:"
    Write-Info "  - Hydra Dashboard: http://localhost:6969"
    Write-Info "  - Traefik Dashboard: http://localhost:8080"
    Write-Host ""
}

function Remove-Cluster {
    Write-Info "Destroying k3d cluster '$ClusterName'..."
    k3d cluster delete $ClusterName 2>$null
    Write-Info "Cluster destroyed"
}

function Get-ClusterStatus {
    Write-Info "Cluster status for '$ClusterName':"
    Write-Host ""

    $existing = k3d cluster list 2>$null | Select-String $ClusterName
    if (-not $existing) {
        Write-Warn "Cluster '$ClusterName' does not exist"
        return
    }

    Write-Host "=== Nodes ===" -ForegroundColor Cyan
    kubectl get nodes -o wide
    Write-Host ""

    Write-Host "=== Pods (hydra-system) ===" -ForegroundColor Cyan
    kubectl get pods -n hydra-system -o wide
    Write-Host ""

    Write-Host "=== Pods (hydra-students) ===" -ForegroundColor Cyan
    kubectl get pods -n hydra-students -o wide 2>$null
    Write-Host ""

    Write-Host "=== Services ===" -ForegroundColor Cyan
    kubectl get svc -n hydra-system
    Write-Host ""
}

function Restart-HydraAuth {
    Write-Info "Restarting hydra-auth deployment..."
    kubectl -n hydra-system rollout restart deployment/hydra-auth
    kubectl -n hydra-system rollout status deployment/hydra-auth
    Write-Info "Restart complete"
}

function Get-HydraLogs {
    param([string]$svc = 'hydra-auth')
    Write-Info "Viewing logs for $svc..."
    kubectl -n hydra-system logs -f "deploy/$svc" --tail=100
}

function Enter-HydraShell {
    param([string]$svc = 'hydra-auth')
    Write-Info "Opening shell into $svc..."
    kubectl -n hydra-system exec -it "deploy/$svc" -- /bin/sh
}

# Main command handler
switch ($Command) {
    'create' { New-Cluster }
    'destroy' { Remove-Cluster }
    'status' { Get-ClusterStatus }
    'restart' { Restart-HydraAuth }
    'logs' { Get-HydraLogs -svc $Service }
    'shell' { Enter-HydraShell -svc $Service }
    default {
        Write-Host "Usage: .\k8s-dev-setup.ps1 [create|destroy|status|restart|logs|shell] [service]"
        Write-Host ""
        Write-Host "Commands:"
        Write-Host "  create   - Create and configure the k3d development cluster"
        Write-Host "  destroy  - Delete the k3d cluster"
        Write-Host "  status   - Show cluster status and resources"
        Write-Host "  restart  - Restart the hydra-auth deployment"
        Write-Host "  logs     - View logs (default: hydra-auth)"
        Write-Host "  shell    - Open shell into pod (default: hydra-auth)"
    }
}
