#!/bin/bash
# fix-k8s-routes.sh - Fix K8s IngressRoutes and Middlewares for Hydra
# Run this script when routes are broken or returning 404s
#
# Usage: ./fix-k8s-routes.sh [--dry-run]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
    DRY_RUN=true
    echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
fi

# Ensure KUBECONFIG is set
export KUBECONFIG=${KUBECONFIG:-/etc/rancher/rke2/rke2.yaml}

echo "=========================================="
echo "Hydra K8s Routes Fix Script"
echo "=========================================="
echo ""

# Check kubectl access
if ! kubectl get nodes &>/dev/null; then
    echo -e "${RED}ERROR: Cannot connect to Kubernetes cluster${NC}"
    echo "Make sure KUBECONFIG is set correctly: export KUBECONFIG=/etc/rancher/rke2/rke2.yaml"
    exit 1
fi

echo -e "${GREEN}Connected to Kubernetes cluster${NC}"
echo ""

# ==================== FIX 1: Main Hydra IngressRoute ====================
echo "1. Checking/Creating main hydra-main IngressRoute..."

HYDRA_MAIN_YAML=$(cat << 'EOF'
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: hydra-main
  namespace: hydra-system
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/dashboard`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/api`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/login`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/callback`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/auth`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/logout`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/servers`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/static`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/health`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/saml`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/token`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`) && PathPrefix(`/check`)
      priority: 100
      services:
        - name: hydra-auth
          port: 6969
    - kind: Rule
      match: Host(`hydra.newpaltz.edu`)
      priority: 1
      services:
        - name: hydra-auth
          port: 6969
  tls:
    secretName: hydra-tls
EOF
)

if [[ "$DRY_RUN" == "true" ]]; then
    echo "  Would apply hydra-main IngressRoute"
else
    echo "$HYDRA_MAIN_YAML" | kubectl apply -f -
    echo -e "  ${GREEN}hydra-main IngressRoute applied${NC}"
fi

# ==================== FIX 2: Student Middlewares ====================
echo ""
echo "2. Creating/Updating student stripPrefix middlewares..."

STUDENT_SERVICES=$(kubectl get svc -n hydra-students -o name 2>/dev/null | sed 's|service/student-||')

for username in $STUDENT_SERVICES; do
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  Would create middleware: strip-prefix-${username}"
    else
        cat << EOF | kubectl apply -f - 2>/dev/null
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: strip-prefix-${username}
  namespace: hydra-students
spec:
  stripPrefix:
    prefixes:
      - /students/${username}/vscode
      - /students/${username}/jupyter
      - /students/${username}/supervisor
EOF
        echo -e "  ${GREEN}strip-prefix-${username} middleware applied${NC}"
    fi
done

# ==================== FIX 3: Student IngressRoutes ====================
echo ""
echo "3. Creating/Updating student IngressRoutes with TLS and middlewares..."

for username in $STUDENT_SERVICES; do
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "  Would update IngressRoute: student-${username}"
    else
        cat << EOF | kubectl apply -f - 2>/dev/null
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: student-${username}
  namespace: hydra-students
  labels:
    app.kubernetes.io/name: student-route
    app.kubernetes.io/instance: ${username}
    hydra.owner: ${username}
spec:
  entryPoints:
    - web
    - websecure
  routes:
    - kind: Rule
      match: Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/vscode\`)
      priority: 100
      services:
        - name: student-${username}
          port: 8443
      middlewares:
        - name: hydra-forward-auth
          namespace: hydra-system
        - name: strip-prefix-${username}
    - kind: Rule
      match: Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/jupyter\`)
      priority: 100
      services:
        - name: student-${username}
          port: 8888
      middlewares:
        - name: hydra-forward-auth
          namespace: hydra-system
  tls:
    secretName: hydra-tls
EOF
        echo -e "  ${GREEN}student-${username} IngressRoute applied${NC}"
    fi
done

# ==================== FIX 4: Ensure hydra-forward-auth middleware exists ====================
echo ""
echo "4. Ensuring hydra-forward-auth middleware exists..."

FORWARD_AUTH_YAML=$(cat << 'EOF'
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: hydra-forward-auth
  namespace: hydra-system
spec:
  forwardAuth:
    address: http://hydra-auth.hydra-system.svc.cluster.local:6969/auth/verify
    trustForwardHeader: true
    authResponseHeaders:
      - X-Hydra-User
      - X-Hydra-Email
EOF
)

if [[ "$DRY_RUN" == "true" ]]; then
    echo "  Would apply hydra-forward-auth middleware"
else
    echo "$FORWARD_AUTH_YAML" | kubectl apply -f -
    echo -e "  ${GREEN}hydra-forward-auth middleware applied${NC}"
fi

# ==================== VERIFICATION ====================
echo ""
echo "=========================================="
echo "Verification"
echo "=========================================="

echo ""
echo "IngressRoutes (traefik.io API):"
kubectl get ingressroutes.traefik.io -A --no-headers 2>/dev/null | wc -l | xargs echo "  Total:"

echo ""
echo "Middlewares (traefik.io API):"
kubectl get middleware.traefik.io -A --no-headers 2>/dev/null | wc -l | xargs echo "  Total:"

echo ""
echo "Student pods:"
kubectl get pods -n hydra-students --no-headers 2>/dev/null | wc -l | xargs echo "  Total:"

# ==================== ROUTE TESTING ====================
echo ""
echo "=========================================="
echo "Route Testing"
echo "=========================================="

test_route() {
    local path=$1
    local expected=$2
    local code=$(curl -sk -o /dev/null -w '%{http_code}' "https://hydra.newpaltz.edu${path}" 2>/dev/null)
    if [[ "$code" == "$expected" ]]; then
        echo -e "  ${GREEN}[OK]${NC} ${path} -> ${code}"
    else
        echo -e "  ${RED}[FAIL]${NC} ${path} -> ${code} (expected ${expected})"
    fi
}

echo ""
echo "Main routes:"
test_route "/health" "200"
test_route "/servers" "200"
test_route "/api/servers/status" "200"
test_route "/dashboard" "302"
test_route "/login" "302"

echo ""
echo "Student routes (expect 401 without auth):"
# Test first student found
FIRST_STUDENT=$(echo "$STUDENT_SERVICES" | head -1)
if [[ -n "$FIRST_STUDENT" ]]; then
    test_route "/students/${FIRST_STUDENT}/vscode/" "401"
    test_route "/students/${FIRST_STUDENT}/jupyter/" "401"
fi

echo ""
echo -e "${GREEN}Fix script completed!${NC}"
echo ""
echo "If routes are still not working:"
echo "  1. Check Traefik pod: kubectl get pods -n hydra-system"
echo "  2. Check Traefik logs: kubectl logs -n hydra-system -l app=traefik --tail=50"
echo "  3. Restart Traefik: kubectl rollout restart deployment/traefik -n hydra-system"
