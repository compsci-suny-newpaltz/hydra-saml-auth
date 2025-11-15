# Hydra SAML Auth - Development Makefile

.PHONY: help setup start stop restart logs clean reset shell test rm-students

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
	@echo "make test-saml - Test SAML authentication flow"
	@echo "make rm-students - Force remove all student-* containers"

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
	@bash ./dev/normalize-eol.sh

normalize-eol-windows:
	@powershell -NoProfile -ExecutionPolicy Bypass -File ./dev/normalize-eol.ps1

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
