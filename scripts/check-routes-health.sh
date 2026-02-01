#!/bin/bash
# check-routes-health.sh - Quick health check for Hydra routes
# Returns exit code 0 if healthy, 1 if issues detected
# Usage: ./check-routes-health.sh [--fix]
#
# Add to cron: */5 * * * * /home/infra/hydra-saml-auth/scripts/check-routes-health.sh --fix >> /var/log/hydra-routes.log 2>&1

set -e

AUTO_FIX=false
if [[ "$1" == "--fix" ]]; then
    AUTO_FIX=true
fi

SCRIPT_DIR="$(dirname "$0")"
FAILED=0

check_route() {
    local path=$1
    local expected=$2
    local code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://hydra.newpaltz.edu${path}" 2>/dev/null || echo "000")
    if [[ "$code" != "$expected" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAIL: ${path} returned ${code}, expected ${expected}"
        FAILED=1
    fi
}

# Check critical routes
check_route "/health" "200"
check_route "/servers" "200"
check_route "/api/servers/status" "200"

# Check a student route (should return 401 without auth)
FIRST_STUDENT=$(curl -sk https://hydra.newpaltz.edu/api/servers/status 2>/dev/null | grep -o '"pod_status"' | head -1)
if [[ -n "$FIRST_STUDENT" ]]; then
    # Get first student from K8s
    export KUBECONFIG=/etc/rancher/rke2/rke2.yaml
    STUDENT=$(kubectl get svc -n hydra-students -o name 2>/dev/null | head -1 | sed 's|service/student-||')
    if [[ -n "$STUDENT" ]]; then
        check_route "/students/${STUDENT}/vscode/" "401"
    fi
fi

if [[ "$FAILED" -eq 1 ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Route health check FAILED"

    if [[ "$AUTO_FIX" == "true" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running auto-fix..."
        "$SCRIPT_DIR/fix-k8s-routes.sh"
    fi

    exit 1
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Route health check PASSED"
    exit 0
fi
