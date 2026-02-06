#!/bin/bash
# Hydra Cluster Route Health Check
# Tests all K8s IngressRoutes via the K8s Traefik (hostPort 80/443)
# Usage: hydra-test (alias) or ./scripts/test-routes.sh

HOST="hydra.newpaltz.edu"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} ($1) $2"; }
fail() { echo -e "  ${RED}FAIL${NC} ($1) $2"; }
warn() { echo -e "  ${YELLOW}WARN${NC} ($1) $2"; }
info() { echo -e "  ${CYAN}INFO${NC} ($1) $2"; }

check() {
  local desc="$1"
  local url="$2"
  local expected="$3"
  local host_header="${4:-$HOST}"
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" -H "Host: $host_header" "$url" 2>/dev/null)
  if [[ "$code" == "$expected" ]]; then
    pass "$code" "$desc"
  elif [[ "$code" == "301" || "$code" == "302" ]]; then
    warn "$code" "$desc (redirect)"
  else
    fail "$code" "$desc (expected $expected)"
  fi
}

# Accept any non-502/503/000 as "routed" (app may return 404 on root but route works)
check_routed() {
  local desc="$1"
  local url="$2"
  local host_header="${3:-$HOST}"
  local code
  code=$(curl -sk -o /dev/null -w "%{http_code}" -H "Host: $host_header" "$url" 2>/dev/null)
  if [[ "$code" == "000" || "$code" == "502" || "$code" == "503" ]]; then
    fail "$code" "$desc (service unreachable)"
  else
    pass "$code" "$desc"
  fi
}

echo "============================================"
echo "  Hydra Cluster Route Health Check"
echo "  $(date)"
echo "============================================"
echo ""

echo "[K8s Cluster]"
export KUBECONFIG=/etc/rancher/rke2/rke2.yaml
NODES=$(kubectl get nodes --no-headers 2>/dev/null | wc -l)
READY=$(kubectl get nodes --no-headers 2>/dev/null | grep -c "Ready")
if [[ "$NODES" == "$READY" ]]; then
  pass "$READY/$NODES" "All nodes Ready"
else
  fail "$READY/$NODES" "Not all nodes Ready"
fi
echo ""

echo "[hydra.newpaltz.edu - Core Routes]"
check "CS Lab Frontend (/)"                "https://localhost/"                "200"
check "Dashboard (/dashboard)"             "https://localhost/dashboard"       "302"
check "Login (/login)"                     "https://localhost/login"           "302"
check "Servers Status (/servers)"          "https://localhost/servers"         "200"
check "CS Lab API (/api/courses)"          "https://localhost/api/courses"     "200"
check "JWKS (/.well-known/jwks.json)"      "https://localhost/.well-known/jwks.json" "200"
check "Hackathons (/hackathons/)"          "https://localhost/hackathons/"     "200"
echo ""

echo "[hydra.newpaltz.edu - Service Routes (routed check)]"
check_routed "Auth Token (/token)"         "https://localhost/token"
check_routed "Java Executor (/java)"       "https://localhost/java/"
check_routed "Git Learning (/git)"         "https://localhost/git/"
check_routed "Admin API (/admin-api)"      "https://localhost/admin-api/api/run"
echo ""

echo "[Subdomain Routes]"
check "OpenWebUI (gpt.hydra)"              "https://localhost/"                "200"  "gpt.hydra.newpaltz.edu"
check "n8n (n8n.hydra)"                    "https://localhost/"                "200"  "n8n.hydra.newpaltz.edu"
echo ""

echo "[Student Containers]"
STUDENT_PODS=$(kubectl get pods -n hydra-students --no-headers 2>/dev/null | grep -c "Running")
pass "$STUDENT_PODS" "Student pods running"
echo ""

echo "[GPU Nodes]"
GPU_CHIMERA=$(kubectl get node chimera -o jsonpath='{.status.capacity.nvidia\.com/gpu}' 2>/dev/null)
GPU_CERBERUS=$(kubectl get node cerberus -o jsonpath='{.status.capacity.nvidia\.com/gpu}' 2>/dev/null)
[[ -n "$GPU_CHIMERA" ]] && pass "${GPU_CHIMERA}x" "Chimera GPUs" || fail "0" "Chimera GPUs"
[[ -n "$GPU_CERBERUS" ]] && pass "${GPU_CERBERUS}x" "Cerberus GPUs" || fail "0" "Cerberus GPUs"
echo ""

echo "[Docker Containers]"
DOCKER_COUNT=$(docker ps -q 2>/dev/null | wc -l)
if [[ "$DOCKER_COUNT" == "0" ]]; then
  pass "0" "No Docker containers (fully migrated)"
else
  warn "$DOCKER_COUNT" "Docker containers still running:"
  docker ps --format "    {{.Names}} ({{.Status}})" 2>/dev/null
fi
echo ""

echo "[Storage]"
RAID_STATUS=$(cat /proc/mdstat 2>/dev/null | grep -oP '\[\d+/\d+\]' | head -1)
[[ -n "$RAID_STATUS" ]] && pass "$RAID_STATUS" "RAID10 status" || warn "?" "RAID status unknown"
DISK_USAGE=$(df -h /data 2>/dev/null | awk 'NR==2{print $5}')
[[ -n "$DISK_USAGE" ]] && info "$DISK_USAGE" "Data disk usage (/data)" || true
echo ""

echo "[NFS]"
NFS_ACTIVE=$(systemctl is-active nfs-server 2>/dev/null)
[[ "$NFS_ACTIVE" == "active" ]] && pass "active" "NFS server" || fail "$NFS_ACTIVE" "NFS server"
echo ""

echo "============================================"
