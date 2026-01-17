# Hydra SAML Auth - Development Makefile

.PHONY: help setup start stop restart logs clean reset nuke nuke-execute nuke-force shell test rm-students \
	k8s-setup k8s-start k8s-stop k8s-logs k8s-clean k8s-shell k8s-status \
	debug-saml test-api normalize-eol normalize-eol-windows

# Default target
help:
	@echo "Hydra SAML Auth - Development Commands"
	@echo "======================================"
	@echo "make setup     - Initial setup (hosts, keys, etc)"
	@echo "make normalize-eol - Normalize all repo text files to LF using git renormalize"
	@echo "make start     - Start all services"
	@echo "make stop      - Stop all services"
	@echo "make restart   - Restart all services"
	@echo "make logs      - View logs (all services)"
	@echo "make logs-hydra - View Hydra service logs"
	@echo "make shell-hydra - Shell into Hydra container"
	@echo "make shell-db  - SQLite shell for OpenWebUI DB"
	@echo "make clean     - Stop and remove containers"
	@echo "make reset     - Full reset (removes volumes too)"
	@echo "make nuke      - ☢️  COMPLETE DESTRUCTION: remove everything, rebuild fresh"
	@echo "make test-saml - Test SAML authentication flow"
	@echo "make test-api  - Run API endpoint tests"
	@echo "make debug-saml - Interactive SAML debugging tool"
	@echo "make rm-students - Force remove all student-* containers"
	@echo ""
	@echo "Kubernetes (RKE2/k3d) Commands:"
	@echo "======================================"
	@echo "make k8s-setup   - Create k3d development cluster"
	@echo "make k8s-start   - Deploy manifests to k3d cluster"
	@echo "make k8s-stop    - Scale down deployments"
	@echo "make k8s-logs    - View hydra-auth pod logs"
	@echo "make k8s-shell   - Shell into hydra-auth pod"
	@echo "make k8s-status  - Show cluster status"
	@echo "make k8s-clean   - Delete k3d cluster"

# Cross-platform sleep command: use Windows timeout when running on Windows
ifeq ($(OS),Windows_NT)
SLEEP_CMD=timeout /t 5 >nul
else
SLEEP_CMD=sleep 5
endif

# Initial setup
setup:
	@chmod +x setup-dev.sh
	@./setup-dev.sh

normalize-eol:
	@bash ./normalize-eol.sh

normalize-eol-windows:
	@powershell -NoProfile -ExecutionPolicy Bypass -File ./normalize-eol.ps1

# Start services
start:
	docker compose -f docker-compose.dev.yml up -d
	@echo "Services starting..."
	@echo "Waiting for services to be ready..."
	@$(SLEEP_CMD)
	@echo "✓ Services should be available at:"
	@echo "  - Main app:  http://hydra.local/dashboard"
	@echo "  - OpenWebUI: http://gpt.hydra.local"
	@echo "  - Mock SAML: http://mock-saml-idp"
	@echo "  - Traefik:   http://traefik.hydra.local"

# Start with logs
start-logs:
	docker compose -f docker-compose.dev.yml up

# Stop services
stop:
	docker compose -f docker-compose.dev.yml stop

# Restart services
restart:
	docker compose -f docker-compose.dev.yml restart

# View logs
logs:
	docker compose -f docker-compose.dev.yml logs -f

logs-hydra:
	docker compose -f docker-compose.dev.yml logs -f hydra-saml-auth

logs-webui:
	docker compose -f docker-compose.dev.yml logs -f open-webui

logs-middleman:
	docker compose -f docker-compose.dev.yml logs -f openwebui-middleman

# Shell access
shell-hydra:
	docker compose -f docker-compose.dev.yml exec hydra-saml-auth /bin/bash

shell-webui:
	docker compose -f docker-compose.dev.yml exec open-webui /bin/bash

shell-db:
	docker compose -f docker-compose.dev.yml exec openwebui-middleman sqlite3 /app/data/webui.db

keys-windows:
	docker compose -f docker-compose.windows.yml run --rm hydra-saml-auth sh -lc "mkdir -p /app/jwt-keys && openssl genrsa -out /app/jwt-keys/private.pem 2048 && openssl rsa -in /app/jwt-keys/private.pem -pubout -out /app/jwt-keys/public.pem"

# Clean up
clean:
	docker compose -f docker-compose.dev.yml down

reset:
	docker compose -f docker-compose.dev.yml down -v
	rm -rf jwt-keys/
	@echo "Full reset complete. Run 'make setup' to reinitialize."

# =============================================================================
# NUKE MODE - Complete destruction and rebuild for reproducibility testing
# =============================================================================
# This simulates a fresh production deployment by:
# 1. Stopping and removing ALL containers (including student containers)
# 2. Removing ALL volumes (including student data volumes)
# 3. Removing ALL built images
# 4. Removing generated files (jwt-keys, traefik configs, mock-users.md)
# 5. Removing Docker networks
# 6. Pruning Docker system
# 7. Running setup from scratch
# 8. Rebuilding all images with --no-cache
# 9. Starting all services
# 10. Running health checks

nuke:
	@echo ""
	@echo "╔══════════════════════════════════════════════════════════════════════╗"
	@echo "║  ☢️   NUKE MODE - COMPLETE DESTRUCTION AND REBUILD                    ║"
	@echo "╠══════════════════════════════════════════════════════════════════════╣"
	@echo "║                                                                      ║"
	@echo "║  This will DESTROY:                                                  ║"
	@echo "║  • All running containers (including student-* containers)           ║"
	@echo "║  • All Docker volumes (including student data)                       ║"
	@echo "║  • All built images (dev-hydra-saml-auth, dev-openwebui-middleman)   ║"
	@echo "║  • JWT keys, traefik configs, generated files                        ║"
	@echo "║  • Docker networks for this project                                  ║"
	@echo "║                                                                      ║"
	@echo "║  Then REBUILD everything from scratch with --no-cache                ║"
	@echo "║                                                                      ║"
	@echo "╚══════════════════════════════════════════════════════════════════════╝"
	@echo ""
	@read -p "Type 'NUKE' to confirm destruction: " confirm && [ "$$confirm" = "NUKE" ] || (echo "Aborted." && exit 1)
	@$(MAKE) nuke-execute

nuke-execute:
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [1/10] Stopping all compose services..."
	@echo "══════════════════════════════════════════════════════════════════════"
	-docker compose -f docker-compose.dev.yml down --remove-orphans 2>/dev/null || true
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [2/10] Removing student containers..."
	@echo "══════════════════════════════════════════════════════════════════════"
	-docker ps -a --format '{{.ID}} {{.Names}}' | awk '$$2 ~ /^student-/' | awk '{print $$1}' | xargs -r docker rm -f 2>/dev/null || true
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [3/10] Removing Docker volumes..."
	@echo "══════════════════════════════════════════════════════════════════════"
	-docker compose -f docker-compose.dev.yml down -v 2>/dev/null || true
	-docker volume ls -q | grep -E "^dev_|^hydra-vol-|student-" | xargs -r docker volume rm -f 2>/dev/null || true
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [4/10] Removing built images..."
	@echo "══════════════════════════════════════════════════════════════════════"
	-docker rmi -f dev-hydra-saml-auth:latest 2>/dev/null || true
	-docker rmi -f dev-openwebui-middleman:latest 2>/dev/null || true
	-docker rmi -f dev-mock-chimera:latest 2>/dev/null || true
	-docker rmi -f dev-mock-cerberus:latest 2>/dev/null || true
	-docker rmi -f hydra-saml-auth:dev 2>/dev/null || true
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [5/10] Removing Docker networks..."
	@echo "══════════════════════════════════════════════════════════════════════"
	-docker network rm dev_hydra-dev-net 2>/dev/null || true
	-docker network rm hydra_students_net 2>/dev/null || true
	-docker network rm hydra-dev-net 2>/dev/null || true
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [6/10] Removing generated files..."
	@echo "══════════════════════════════════════════════════════════════════════"
	rm -rf jwt-keys/
	rm -rf traefik-dynamic/*.yaml traefik-dynamic/*.yml 2>/dev/null || true
	rm -f mock-users.md 2>/dev/null || true
	rm -rf shared/* 2>/dev/null || true
	@echo "  Removed: jwt-keys/, traefik-dynamic configs, mock-users.md"
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [7/10] Pruning Docker system (dangling images, build cache)..."
	@echo "══════════════════════════════════════════════════════════════════════"
	-docker system prune -f 2>/dev/null || true
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [8/10] Running setup (hosts, JWT keys, directories)..."
	@echo "══════════════════════════════════════════════════════════════════════"
	@chmod +x setup-dev.sh
	@./setup-dev.sh --skip-hosts || (echo "Setup failed - you may need to run with sudo for hosts file" && exit 1)
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [9/10] Building all images with --no-cache..."
	@echo "══════════════════════════════════════════════════════════════════════"
	docker compose -f docker-compose.dev.yml build --no-cache
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  [10/10] Starting all services..."
	@echo "══════════════════════════════════════════════════════════════════════"
	docker compose -f docker-compose.dev.yml up -d
	@echo ""
	@echo "Waiting for services to initialize..."
	@sleep 10
	@echo ""
	@echo "══════════════════════════════════════════════════════════════════════"
	@echo "  Running health checks..."
	@echo "══════════════════════════════════════════════════════════════════════"
	@$(MAKE) health
	@$(MAKE) ps
	@echo ""
	@echo "╔══════════════════════════════════════════════════════════════════════╗"
	@echo "║  ✅  NUKE COMPLETE - Fresh environment ready                         ║"
	@echo "╠══════════════════════════════════════════════════════════════════════╣"
	@echo "║                                                                      ║"
	@echo "║  Services:                                                           ║"
	@echo "║  • Dashboard:  http://hydra.local/dashboard                          ║"
	@echo "║  • OpenWebUI:  http://gpt.hydra.local                                 ║"
	@echo "║  • Mock SAML:  http://localhost:8080                                  ║"
	@echo "║  • Traefik:    http://localhost:8081                                  ║"
	@echo "║                                                                      ║"
	@echo "║  Test credentials: user1 / user1pass                                 ║"
	@echo "║                                                                      ║"
	@echo "╚══════════════════════════════════════════════════════════════════════╝"

# Nuke without confirmation (for CI/scripts)
nuke-force:
	@$(MAKE) nuke-execute

# Remove all student containers (names start with student-)
rm-students:
	@echo "Removing student-* containers (if any)..."
	@docker ps -a --format '{{.ID}} {{.Names}}' | awk '$$2 ~ /^student-/' | awk '{print $$1}' | xargs -r docker rm -f
	@echo "Done."

# Rebuild specific services
rebuild-hydra:
	docker compose -f docker-compose.dev.yml build hydra-saml-auth
	docker compose -f docker-compose.dev.yml up -d hydra-saml-auth

rebuild-middleman:
	docker compose -f docker-compose.dev.yml build openwebui-middleman
	docker compose -f docker-compose.dev.yml up -d openwebui-middleman

# Test SAML flow
test-saml:
	@echo "Testing SAML authentication..."
	@echo "1. Visit: http://hydra.local:6969/login"
	@echo "2. You'll be redirected to mock SAML IdP"
	@echo "3. Login with: user1 / user1pass"
	@echo "4. You should be redirected back to dashboard"
	@curl -I http://hydra.local:6969/login

# Run API endpoint tests
test-api:
	@chmod +x test-api.sh
	@./test-api.sh

# Interactive SAML debugging tool
debug-saml:
	@chmod +x debug-saml.sh
	@./debug-saml.sh

# Pull latest images
pull:
	docker compose -f docker-compose.dev.yml pull

# Show running containers
ps:
	docker compose -f docker-compose.dev.yml ps

# Check service health
health:
	@echo "Checking service health..."
	@curl -s -o /dev/null -w "Hydra: %{http_code}\n" http://localhost:6969/health || echo "Hydra: DOWN"
	@curl -s -o /dev/null -w "OpenWebUI: %{http_code}\n" http://localhost:3000 || echo "OpenWebUI: DOWN"
	@curl -s -o /dev/null -w "Mock SAML: %{http_code}\n" http://localhost:8080 || echo "Mock SAML: DOWN"
	@curl -s -o /dev/null -w "Middleman: %{http_code}\n" http://localhost:7070/openwebui/health || echo "Middleman: DOWN"

# =============================================================================
# Kubernetes (RKE2/k3d) Development Targets
# =============================================================================

K3D_CLUSTER_NAME := hydra-dev
K8S_NAMESPACE := hydra-system
K8S_STUDENTS_NS := hydra-students

# Create k3d cluster for local development
k8s-setup:
	@echo "Creating k3d cluster '$(K3D_CLUSTER_NAME)'..."
	@k3d cluster create $(K3D_CLUSTER_NAME) \
		--config ../k8s/dev/k3d-config.yaml \
		|| echo "Cluster may already exist, trying to start..."
	@k3d cluster start $(K3D_CLUSTER_NAME) 2>/dev/null || true
	@echo "Installing Traefik CRDs..."
	@kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v2.11/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml
	@echo "Applying base manifests..."
	@kubectl apply -f ../k8s/base/namespace.yaml
	@kubectl apply -f ../k8s/base/rbac/
	@kubectl apply -f ../k8s/base/storage/
	@echo "Setting namespace security policy..."
	@kubectl label namespace hydra-system pod-security.kubernetes.io/enforce=privileged --overwrite
	@echo "Creating secrets..."
	@kubectl create secret generic hydra-jwt-keys \
		--from-file=private.pem=jwt-keys/private.pem \
		--from-file=public.pem=jwt-keys/public.pem \
		-n hydra-system 2>/dev/null || echo "JWT keys secret exists"
	@kubectl create secret generic hydra-auth-secrets \
		--from-literal=SESSION_SECRET=dev-session-secret \
		--from-literal=OPENWEBUI_API_KEY=dev-api-key \
		--from-literal=N8N_API_KEY=dev-n8n-key \
		-n hydra-system 2>/dev/null || echo "Auth secrets exist"
	@echo ""
	@echo "k3d cluster '$(K3D_CLUSTER_NAME)' is ready!"
	@echo "Run 'make k8s-start' to deploy services."

# Deploy/update manifests to k3d cluster
k8s-start:
	@echo "Building hydra-saml-auth image..."
	@docker build -t hydra-saml-auth:dev -f Dockerfile.hydra ..
	@echo "Importing image to k3d..."
	@k3d image import hydra-saml-auth:dev -c $(K3D_CLUSTER_NAME)
	@echo "Ensuring namespaces exist..."
	@kubectl apply -f ../k8s/base/namespace.yaml
	@kubectl label namespace hydra-system pod-security.kubernetes.io/enforce=privileged --overwrite 2>/dev/null || true
	@echo "Applying Traefik components..."
	@kubectl apply -f ../k8s/components/traefik/deployment.yaml
	@kubectl apply -f ../k8s/components/traefik/service.yaml 2>/dev/null || true
	@kubectl apply -f ../k8s/components/traefik/ingressroute-hydra.yaml
	@echo "Applying mock services..."
	@kubectl apply -k ../k8s/dev/mock-services/
	@echo "Applying hydra-auth components..."
	@kubectl apply -f ../k8s/components/hydra-auth/configmap.yaml
	@kubectl apply -f ../k8s/components/hydra-auth/pvc.yaml
	@kubectl apply -f ../k8s/components/hydra-auth/service.yaml
	@echo "Patching configmap for mock SAML IdP..."
	@kubectl patch configmap hydra-auth-config -n $(K8S_NAMESPACE) --type merge \
		-p '{"data":{"METADATA_URL":"http://mock-saml-idp:8080/simplesaml/saml2/idp/metadata.php","CALLBACK_URL":"http://localhost:6969/login/callback"}}'
	@echo "Deploying hydra-auth with dev image..."
	@cat ../k8s/components/hydra-auth/deployment.yaml | sed 's/hydra-saml-auth:latest/hydra-saml-auth:dev/' | kubectl apply -f -
	@echo ""
	@echo "Waiting for pods to be ready..."
	@kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=hydra -n $(K8S_NAMESPACE) --timeout=120s || true
	@kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=traefik -n $(K8S_NAMESPACE) --timeout=60s || true
	@echo ""
	@echo "Services deployed! Access at:"
	@echo "  - Hydra:   http://hydra.local:6969 (or curl -H 'Host: hydra.local' localhost:6969)"
	@echo "  - Health:  curl -H 'Host: hydra.local' localhost:6969/health"
	@echo "  - Traefik: http://localhost:8081 (dashboard)"

# Stop services (scale to 0)
k8s-stop:
	@echo "Scaling down deployments..."
	@kubectl scale deployment --all --replicas=0 -n $(K8S_NAMESPACE) || true
	@kubectl scale deployment --all --replicas=0 -n $(K8S_STUDENTS_NS) || true

# View logs
k8s-logs:
	@kubectl logs -f -l app.kubernetes.io/name=hydra -n $(K8S_NAMESPACE)

k8s-logs-traefik:
	@kubectl logs -f -l app.kubernetes.io/name=traefik -n $(K8S_NAMESPACE)

# Shell into hydra pod
k8s-shell:
	@kubectl exec -it $$(kubectl get pod -l app.kubernetes.io/name=hydra -n $(K8S_NAMESPACE) -o jsonpath='{.items[0].metadata.name}') -n $(K8S_NAMESPACE) -- /bin/bash

# Show cluster status
k8s-status:
	@echo "=== Cluster Info ==="
	@kubectl cluster-info
	@echo ""
	@echo "=== Nodes ==="
	@kubectl get nodes
	@echo ""
	@echo "=== Namespaces ==="
	@kubectl get ns
	@echo ""
	@echo "=== Pods (hydra-system) ==="
	@kubectl get pods -n $(K8S_NAMESPACE)
	@echo ""
	@echo "=== Pods (hydra-students) ==="
	@kubectl get pods -n $(K8S_STUDENTS_NS) 2>/dev/null || echo "No student pods"
	@echo ""
	@echo "=== Services ==="
	@kubectl get svc -A | grep -E "hydra|traefik"

# Delete k3d cluster
k8s-clean:
	@echo "Deleting k3d cluster '$(K3D_CLUSTER_NAME)'..."
	@k3d cluster delete $(K3D_CLUSTER_NAME)
	@echo "Cluster deleted."

# Full k8s reset
k8s-reset: k8s-clean k8s-setup k8s-start

# Apply only base manifests (for testing)
k8s-apply-base:
	@kubectl apply -f ../k8s/base/

# Apply GPU manifests (for production nodes)
k8s-apply-gpu:
	@kubectl apply -f ../k8s/gpu/
