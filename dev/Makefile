# Hydra SAML Auth — Development Environment
# One command: make
# Prereqs: k3d, kubectl, docker (or podman)

.PHONY: help up down status logs shell rebuild test-student rm-students \
	reset nuke health setup-cluster deploy clean

# ─── Config ──────────────────────────────────────────────────────────────────
K3D_CLUSTER     := hydra-dev
K8S_NS          := hydra-system
K8S_STUDENTS_NS := hydra-students
DEV_IMAGE       := hydra-saml-auth:dev

# Container engine: prefer podman, fall back to docker
ENGINE := $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)

# ─── Default target: full setup ──────────────────────────────────────────────
help:
	@echo "Hydra Dev Environment"
	@echo "====================="
	@echo ""
	@echo "  make up             Full setup (cluster + deploy) — run this first"
	@echo "  make down           Stop cluster (preserves state)"
	@echo "  make reset          Destroy and recreate everything"
	@echo "  make rebuild        Rebuild hydra-auth image and redeploy"
	@echo ""
	@echo "  make status         Show nodes, pods, services"
	@echo "  make logs           Follow hydra-auth logs"
	@echo "  make shell          Shell into hydra-auth pod"
	@echo "  make health         Curl health endpoints"
	@echo ""
	@echo "  make test-student   Create a test student pod"
	@echo "  make rm-students    Remove all student pods"
	@echo "  make nuke           Delete everything and start fresh"
	@echo ""
	@echo "Endpoints (after 'make up'):"
	@echo "  Dashboard:  http://localhost:6969/dashboard"
	@echo "  Health:     http://localhost:6969/health"
	@echo "  JWKS:       http://localhost:6969/.well-known/jwks.json"
	@echo ""
	@echo "Test credentials:  admin / password  (faculty)"
	@echo "                   student / password (student)"

# ─── Full setup: prereqs + cluster + deploy ──────────────────────────────────
up: check-prereqs setup-cluster deploy
	@echo ""
	@echo "================================================"
	@echo "  Dev environment ready!"
	@echo "================================================"
	@echo ""
	@echo "  Dashboard:   http://localhost:6969/dashboard"
	@echo "  Health:      http://localhost:6969/health"
	@echo "  SAML IdP:    http://localhost:8080/simplesaml"
	@echo ""
	@echo "  Login:  admin / password  OR  student / password"
	@echo ""
	@echo "  make status     — check pods"
	@echo "  make logs       — follow logs"
	@echo "  make rebuild    — after code changes"
	@echo ""

# ─── Prereq checks ──────────────────────────────────────────────────────────
check-prereqs:
	@command -v k3d >/dev/null 2>&1 || { echo "ERROR: k3d not found. Install: https://k3d.io"; exit 1; }
	@command -v kubectl >/dev/null 2>&1 || { echo "ERROR: kubectl not found."; exit 1; }
	@test -n "$(ENGINE)" || { echo "ERROR: docker or podman not found."; exit 1; }
	@echo "[ok] prereqs: k3d, kubectl, $(notdir $(ENGINE))"

# ─── Create k3d cluster ─────────────────────────────────────────────────────
setup-cluster:
	@if k3d cluster list 2>/dev/null | grep -q $(K3D_CLUSTER); then \
		echo "[ok] cluster '$(K3D_CLUSTER)' exists"; \
		k3d cluster start $(K3D_CLUSTER) 2>/dev/null || true; \
	else \
		echo "[..] creating k3d cluster '$(K3D_CLUSTER)'..."; \
		k3d cluster create --config ../k8s/dev/k3d-config.yaml; \
	fi
	@echo "[..] generating JWT keys..."
	@mkdir -p jwt-keys
	@test -f jwt-keys/private.pem || openssl genrsa -out jwt-keys/private.pem 2048 2>/dev/null
	@test -f jwt-keys/public.pem || openssl rsa -in jwt-keys/private.pem -pubout -out jwt-keys/public.pem 2>/dev/null
	@echo "[ok] JWT keys ready"
	@echo "[..] installing Traefik CRDs..."
	@kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v2.11/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml >/dev/null 2>&1 || true
	@echo "[ok] cluster ready"

# ─── Build and deploy everything ─────────────────────────────────────────────
deploy:
	@echo "[..] building hydra-saml-auth image..."
	@$(ENGINE) build -t $(DEV_IMAGE) -f Dockerfile.hydra .. -q
	@echo "[..] importing image to k3d..."
	@k3d image import $(DEV_IMAGE) -c $(K3D_CLUSTER) 2>/dev/null
	@echo "[..] applying base manifests..."
	@kubectl apply -f ../k8s/base/namespace.yaml >/dev/null
	@kubectl apply -f ../k8s/base/priority-classes.yaml >/dev/null 2>&1 || true
	@kubectl label namespace $(K8S_NS) pod-security.kubernetes.io/enforce=privileged --overwrite >/dev/null 2>&1
	@kubectl label namespace $(K8S_STUDENTS_NS) pod-security.kubernetes.io/enforce=baseline --overwrite >/dev/null 2>&1
	@kubectl apply -f ../k8s/base/rbac/ >/dev/null 2>&1 || true
	@kubectl apply -f ../k8s/base/storage/ >/dev/null 2>&1 || true
	@echo "[..] creating secrets..."
	@kubectl create secret generic hydra-jwt-keys \
		--from-file=private.pem=jwt-keys/private.pem \
		--from-file=public.pem=jwt-keys/public.pem \
		-n $(K8S_NS) 2>/dev/null || true
	@kubectl create secret generic hydra-auth-secrets \
		--from-literal=SESSION_SECRET=dev-session-secret \
		--from-literal=OPENWEBUI_API_KEY=dev-api-key \
		--from-literal=N8N_API_KEY=dev-n8n-key \
		-n $(K8S_NS) 2>/dev/null || true
	@echo "[..] deploying Traefik (dev config)..."
	@kubectl apply -f ../k8s/dev/traefik-dev.yaml >/dev/null 2>&1 || true
	@kubectl apply -f ../k8s/components/traefik/ingressroute-hydra.yaml >/dev/null 2>&1 || true
	@echo "[..] deploying mock services (SAML IdP, metrics)..."
	@kubectl apply -k ../k8s/dev/mock-services/ >/dev/null
	@echo "[..] exposing services for local access..."
	@kubectl apply -f ../k8s/dev/hydra-auth-nodeport.yaml >/dev/null
	@kubectl apply -f ../k8s/dev/mock-saml-nodeport.yaml >/dev/null
	@echo "[..] deploying hydra-auth..."
	@kubectl apply -f ../k8s/components/hydra-auth/configmap.yaml >/dev/null
	@kubectl apply -f ../k8s/dev/hydra-auth-pvc-dev.yaml >/dev/null
	@kubectl apply -f ../k8s/components/hydra-auth/service.yaml >/dev/null
	@kubectl patch configmap hydra-auth-config -n $(K8S_NS) --type merge \
		-p '{"data":{ \
			"BASE_URL":"http://localhost:6969", \
			"METADATA_URL":"http://mock-saml-idp:8080/simplesaml/saml2/idp/metadata.php", \
			"CALLBACK_URL":"http://localhost:6969/login/callback", \
			"SAML_SP_ENTITY_ID":"hydra.local", \
			"CHIMERA_HOST":"mock-chimera.hydra-system.svc", \
			"CHIMERA_METRICS_PORT":"9100", \
			"CERBERUS_HOST":"mock-cerberus.hydra-system.svc", \
			"CERBERUS_METRICS_PORT":"9100", \
			"COOKIE_DOMAIN":"localhost", \
			"PUBLIC_STUDENTS_BASE":"http://localhost:6969/students", \
			"ADMIN_USERS":"admin@example.com" \
		}}' >/dev/null
	@kubectl apply -f ../k8s/dev/hydra-auth-dev.yaml >/dev/null
	@echo "[..] waiting for pods..."
	@kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=hydra -n $(K8S_NS) --timeout=120s 2>/dev/null || true
	@echo "[ok] deployed"

# ─── Rebuild and redeploy (after code changes) ──────────────────────────────
rebuild:
	@echo "[..] rebuilding..."
	@$(ENGINE) build -t $(DEV_IMAGE) -f Dockerfile.hydra .. -q
	@k3d image import $(DEV_IMAGE) -c $(K3D_CLUSTER) 2>/dev/null
	@kubectl delete pod -l app.kubernetes.io/name=hydra -n $(K8S_NS) --force 2>/dev/null || true
	@echo "[..] waiting for pod..."
	@sleep 3
	@kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=hydra -n $(K8S_NS) --timeout=120s 2>/dev/null || true
	@echo "[ok] redeployed"

# ─── Stop cluster (preserves state) ─────────────────────────────────────────
down:
	@k3d cluster stop $(K3D_CLUSTER) 2>/dev/null || true
	@echo "[ok] cluster stopped (run 'make up' to resume)"

# ─── Status ──────────────────────────────────────────────────────────────────
status:
	@echo "=== Nodes (hydra=server, chimera=agent-0, cerberus=agent-1) ==="
	@kubectl get nodes -L hydra.node-role,hydra.student-schedulable 2>/dev/null || echo "  cluster not running"
	@echo ""
	@echo "=== System Pods ==="
	@kubectl get pods -n $(K8S_NS) -o wide 2>/dev/null || echo "  none"
	@echo ""
	@echo "=== Student Pods ==="
	@kubectl get pods -n $(K8S_STUDENTS_NS) -o wide 2>/dev/null || echo "  none"
	@echo ""
	@echo "=== Services ==="
	@kubectl get svc -n $(K8S_NS) 2>/dev/null | grep -E "NAME|hydra|traefik|saml|mock|chimera|cerberus" || true

# ─── Logs ────────────────────────────────────────────────────────────────────
logs:
	@kubectl logs -f -l app.kubernetes.io/name=hydra -n $(K8S_NS)

logs-traefik:
	@kubectl logs -f -l app.kubernetes.io/name=traefik -n $(K8S_NS)

# ─── Shell ───────────────────────────────────────────────────────────────────
shell:
	@kubectl exec -it $$(kubectl get pod -l app.kubernetes.io/name=hydra -n $(K8S_NS) -o jsonpath='{.items[0].metadata.name}') -n $(K8S_NS) -- /bin/bash

# ─── Health ──────────────────────────────────────────────────────────────────
health:
	@echo "Hydra:"
	@curl -sf http://localhost:6969/health 2>/dev/null && echo "" || echo "  DOWN"
	@echo "JWKS:"
	@curl -sf http://localhost:6969/.well-known/jwks.json 2>/dev/null | head -c 80 && echo "..." || echo "  DOWN"

# ─── Test student pod ────────────────────────────────────────────────────────
STUDENT_IMAGE ?= docker.io/ndg8743/hydra-student-container:latest
test-student:
	@echo "[..] creating test student pod..."
	@kubectl create namespace $(K8S_STUDENTS_NS) 2>/dev/null || true
	@$(ENGINE) pull $(STUDENT_IMAGE) 2>/dev/null || true
	@k3d image import $(STUDENT_IMAGE) -c $(K3D_CLUSTER) 2>/dev/null || true
	@echo '{"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":"hydra-vol-testuser","namespace":"$(K8S_STUDENTS_NS)","labels":{"app.kubernetes.io/name":"student-container","hydra.owner":"testuser"}},"spec":{"accessModes":["ReadWriteOnce"],"storageClassName":"local-path","resources":{"requests":{"storage":"1Gi"}}}}' \
		| kubectl apply -f - 2>/dev/null || true
	@kubectl run student-testuser \
		--image=$(STUDENT_IMAGE) \
		--namespace=$(K8S_STUDENTS_NS) \
		--labels="app.kubernetes.io/name=student-container,hydra.owner=testuser" \
		--env="USERNAME=testuser" \
		--restart=Always \
		--overrides='{"spec":{"priorityClassName":"student-pods","nodeSelector":{"hydra.student-schedulable":"true"}}}' \
		2>/dev/null || echo "pod may already exist"
	@echo "[..] waiting for pod..."
	@kubectl wait --for=condition=Ready pod/student-testuser -n $(K8S_STUDENTS_NS) --timeout=120s 2>/dev/null || true
	@echo "[ok] student-testuser ready"
	@echo "  Shell:  kubectl exec -it student-testuser -n $(K8S_STUDENTS_NS) -- /bin/bash"

# ─── Remove student pods ────────────────────────────────────────────────────
rm-students:
	@kubectl delete pods -l app.kubernetes.io/name=student-container -n $(K8S_STUDENTS_NS) 2>/dev/null || true
	@kubectl delete pvc -l app.kubernetes.io/name=student-container -n $(K8S_STUDENTS_NS) 2>/dev/null || true
	@echo "[ok] student pods removed"

# ─── Reset (destroy + recreate) ─────────────────────────────────────────────
reset: nuke up

# ─── Nuke (destroy everything) ──────────────────────────────────────────────
nuke:
	@echo "[..] destroying cluster '$(K3D_CLUSTER)'..."
	@k3d cluster delete $(K3D_CLUSTER) 2>/dev/null || true
	@rm -rf jwt-keys/
	@echo "[ok] nuked"

# ─── Clean (alias for nuke) ─────────────────────────────────────────────────
clean: nuke

# ─── Test API endpoints ─────────────────────────────────────────────────────
test-api:
	@chmod +x test-api.sh 2>/dev/null || true
	@./test-api.sh
