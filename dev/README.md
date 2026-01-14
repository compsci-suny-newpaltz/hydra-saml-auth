# Hydra SAML Auth - Local Development Environment

---

## START HERE

This guide walks you through the complete Hydra development and deployment pipeline. Follow these stages in order.

### Deployment Stages Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           HYDRA DEPLOYMENT PIPELINE                                      │
├───────────────────────┬─────────────────────────┬───────────────────────────────────────┤
│       STAGE 1         │        STAGE 2          │            STAGE 3                    │
│     Docker Dev        │       K8s Dev           │          Production                   │
│   (You Are Here)      │     (Local k3d)         │     (RKE2 Multi-Node)                 │
├───────────────────────┼─────────────────────────┼───────────────────────────────────────┤
│                       │                         │                                       │
│  docker-compose.yml   │   k3d cluster           │   RKE2 cluster on bare metal          │
│  Mock SAML IdP        │   Real K8s manifests    │   Azure AD SAML                       │
│  SQLite local         │   ConfigMaps/Secrets    │   Production SSL                      │
│  No GPU               │   No GPU                │   Multi-GPU (Chimera/Cerberus)        │
│                       │                         │                                       │
├───────────────────────┼─────────────────────────┼───────────────────────────────────────┤
│  cd dev/              │  ./k8s-dev-setup.sh     │  cd ../ansible                        │
│  make nuke            │    create               │  ansible-playbook                     │
│    (or)               │                         │    playbooks/site.yml                 │
│  make setup && start  │                         │                                       │
└───────────────────────┴─────────────────────────┴───────────────────────────────────────┘
```

### Quick Start Commands

```bash
# STAGE 1: Docker Development (start here)
cd dev/
make nuke          # Complete reset + rebuild (recommended for first setup)
# OR
make setup         # Generate JWT keys, setup hosts, pull images
make start         # Start all services
make health        # Verify everything is running

# STAGE 2: Kubernetes Development (after Docker works)
./k8s-dev-setup.sh create    # Bootstrap k3d cluster
./k8s-dev-setup.sh status    # Check cluster health
./k8s-dev-setup.sh destroy   # Tear down cluster

# STAGE 3: Production (after K8s validation)
cd ../ansible
ansible-playbook -i inventory.yml playbooks/site.yml
```

---

## Architecture Overview

### Current Docker Development Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Internet / Browser                                  │
│                         http://hydra.local:6969                              │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Traefik Reverse Proxy (v2.11)                            │
│                   Ports: 80 (web), 443 (secure), 8081 (dash)                 │
│             Routes: /students/* → ForwardAuth → Student Containers           │
└────────┬──────────────────────┬──────────────────────┬──────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
┌────────────────┐    ┌────────────────┐    ┌─────────────────────────────────┐
│  Mock SAML IdP │    │  Hydra Auth    │    │     Student Containers          │
│  Port: 8080    │◄───│  Port: 6969    │───►│  (created on-demand)            │
│                │    │                │    │                                 │
│  Test Users:   │    │  - Dashboard   │    │  - VS Code (:8443)              │
│  user1/user1   │    │  - SAML SSO    │    │  - Jupyter (:8888)              │
│  user2/user2   │    │  - JWT/JWKS    │    │  - Terminal access              │
└────────────────┘    │  - Container   │    └─────────────────────────────────┘
                      │    Lifecycle   │
                      └───────┬────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │  OpenWebUI   │ │  Middleman   │ │   n8n Dev    │
      │  Port: 3000  │ │  Port: 7070  │ │  Port: 5678  │
      │  (LLM Chat)  │ │  (DB API)    │ │  (Workflows) │
      └──────────────┘ └──────────────┘ └──────────────┘
```

### Target Production Architecture (RKE2 Multi-Node)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    INTERNET                                              │
│                           https://hydra.newpaltz.edu                                     │
└──────────────────────────────────────┬──────────────────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              AZURE AD (SAML 2.0 IdP)                                     │
│                       Enterprise Application: "Hydra Auth"                               │
└──────────────────────────────────────┬──────────────────────────────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
          ▼                            ▼                            ▼
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────────────┐
│       HYDRA          │    │       CHIMERA        │    │         CERBERUS             │
│    Control Plane     │    │    GPU Inference     │    │       GPU Training           │
│   192.168.1.100      │    │   192.168.1.150      │    │      192.168.1.242           │
├──────────────────────┤    ├──────────────────────┤    ├──────────────────────────────┤
│                      │    │                      │    │                              │
│  RKE2 Server Node    │    │  RKE2 Agent Node     │    │  RKE2 Agent Node             │
│                      │    │                      │    │                              │
│  Services:           │    │  Services:           │    │  Services:                   │
│  - Traefik Ingress   │    │  - Ollama (LLMs)     │    │  - Training Workloads        │
│  - Hydra Auth        │    │  - OpenWebUI         │    │  - Batch Jobs                │
│  - Student Containers│    │  - vLLM              │    │  - Model Fine-tuning         │
│  - n8n Workflows     │    │                      │    │                              │
│  - SQLite/Postgres   │    │  GPUs:               │    │  GPUs:                       │
│                      │    │  - NVIDIA RTX 4090   │    │  - NVIDIA A100/H100          │
│  Storage:            │    │  - CUDA 12.x         │    │  - High VRAM workloads       │
│  - Longhorn (dist)   │    │                      │    │                              │
│  - ZFS local         │    │                      │    │                              │
└──────────────────────┘    └──────────────────────┘    └──────────────────────────────┘
          │                            │                            │
          └────────────────────────────┴────────────────────────────┘
                                       │
                              RKE2 Cluster Network
                           (Flannel CNI / Calico)
```

### Request Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              AUTHENTICATION FLOW                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   User                    Traefik               Hydra Auth          SAML IdP         │
│    │                         │                      │                   │            │
│    │  GET /login             │                      │                   │            │
│    │────────────────────────►│                      │                   │            │
│    │                         │  forward             │                   │            │
│    │                         │─────────────────────►│                   │            │
│    │                         │                      │  SAML AuthnReq    │            │
│    │◄────────────────────────┼──────────────────────┼──────────────────►│            │
│    │         302 Redirect to IdP                    │                   │            │
│    │                         │                      │                   │            │
│    │  User authenticates at IdP                     │                   │            │
│    │────────────────────────────────────────────────────────────────────►│            │
│    │                         │                      │                   │            │
│    │◄────────────────────────┼──────────────────────┼───────────────────│            │
│    │  POST /login/callback (SAML Response)          │                   │            │
│    │────────────────────────►│─────────────────────►│                   │            │
│    │                         │                      │  Validate SAML    │            │
│    │                         │                      │  Create Session   │            │
│    │                         │                      │  Issue JWT        │            │
│    │◄────────────────────────┼──────────────────────│                   │            │
│    │  Set-Cookie: hydra_session=<JWT>               │                   │            │
│    │  302 Redirect to /dashboard                    │                   │            │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────────┐
│                           STUDENT CONTAINER ACCESS FLOW                               │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   User                    Traefik               Hydra Auth        Student Container  │
│    │                         │                      │                   │            │
│    │  GET /students/jdoe/vscode                     │                   │            │
│    │────────────────────────►│                      │                   │            │
│    │                         │  ForwardAuth         │                   │            │
│    │                         │─────────────────────►│                   │            │
│    │                         │                      │  Verify JWT       │            │
│    │                         │                      │  Check ownership  │            │
│    │                         │◄─────────────────────│  200 OK + headers │            │
│    │                         │                      │                   │            │
│    │                         │  Forward to container│                   │            │
│    │                         │─────────────────────────────────────────►│            │
│    │◄────────────────────────┼──────────────────────────────────────────│            │
│    │  VS Code / Jupyter response                    │                   │            │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- OpenSSL (for JWT key generation)
- Make (optional, for convenience commands)
- sudo access (for hosts file modification)

### For Windows Users
Add the following entries to your `C:\Windows\System32\drivers\etc\hosts` file:
```bash
127.0.0.1    hydra.local
127.0.0.1    gpt.hydra.local
127.0.0.1    n8n.hydra.local
127.0.0.1    mock-saml-idp
```

### Setup Steps

1. **Clone and navigate to dev folder:**
```bash
cd hydra-saml-auth/dev
```

2. **Run the setup script:**
```bash
make setup
# OR without make:
chmod +x setup-dev.sh && ./setup-dev.sh
```

3. **Start all services:**
```bash
make start
# OR without make:
docker compose -f docker-compose.dev.yml up -d
```

4. **Access the services:**
- Main App: http://hydra.local:6969
- OpenWebUI: http://localhost:3000
- Mock SAML IdP: http://localhost:8080
- Traefik Dashboard: http://localhost:8081
- n8n: http://localhost:5678

---

## Authentication (Mock SAML)

The development environment uses a mock SAML IdP instead of Azure AD.

### Test Users:
| Username | Password  | Email              | Role     |
|----------|----------|--------------------|----------|
| user1    | user1pass| user1@example.com  | students |
| user2    | user2pass| user2@example.com  | faculty  |

### SAML Flow:
1. Visit http://hydra.local:6969/login
2. Get redirected to mock SAML IdP
3. Login with test credentials
4. Return to dashboard with session

---

## Service Configuration

### Environment Variables
All configuration is in `.env.dev`:
- `BASE_URL`: Set to http://hydra.local:6969
- `METADATA_URL`: Points to mock SAML IdP
- `OPENWEBUI_API_BASE`: Points to middleman container
- `COOKIE_DOMAIN`: Set to .hydra.local
- `STUDENT_IMAGE`: Container image for students (default: jupyter/minimal-notebook:latest)

### Network Configuration
- **hydra-dev-net**: Main network for all services (172.20.0.0/16)
- **hydra_students_net**: Dedicated network for student containers

### Host Aliases
The setup script adds these to `/etc/hosts`:
- hydra.local -> 127.0.0.1
- gpt.hydra.local -> 127.0.0.1
- n8n.hydra.local -> 127.0.0.1
- traefik.hydra.local -> 127.0.0.1

---

## Service Details

### Hydra SAML Auth (Main Service)
- **Port**: 6969
- **Features**: SAML auth, JWT tokens, Dashboard, Container management
- **Hot Reload**: Enabled via nodemon
- **Volumes**: Mounts views/, routes/, public/ for live editing

### OpenWebUI
- **Port**: 3000
- **Database**: SQLite at /app/backend/data/webui.db
- **Integration**: Via middleman API

### OpenWebUI Middleman
- **Port**: 7070
- **Purpose**: Database API for user management
- **Auth**: API key in .env.dev

### Mock SAML IdP
- **Port**: 8080
- **Image**: kristophjunge/test-saml-idp
- **Admin Access**: http://localhost:8080/simplesaml (admin/secret)

### Traefik
- **Ports**: 80 (web), 443 (websecure), 8081 (dashboard)
- **Purpose**: Routes student containers
- **Dashboard**: http://localhost:8081

---

## Development Commands

### Using Make:
```bash
make help          # Show all commands
make setup         # First-time setup (keys, hosts, images)
make start         # Start services
make stop          # Stop services
make logs          # View all logs
make logs-hydra    # View Hydra logs only
make shell-hydra   # Shell into Hydra container
make shell-db      # SQLite console
make clean         # Stop and remove containers
make reset         # Full reset including volumes
make nuke          # COMPLETE destruction and rebuild
make health        # Run health checks
make test-saml     # Test SAML authentication
```

### Nuke Mode (Complete Reset)

When you need a completely fresh start to test reproducibility:

```bash
make nuke
```

This performs a 10-step complete destruction and rebuild:
1. Stop all services
2. Remove student containers
3. Remove Docker volumes
4. Remove built images
5. Remove Docker networks
6. Remove generated files (jwt-keys/, shared/)
7. Prune Docker system
8. Run setup (generate keys, update hosts)
9. Build with --no-cache
10. Start services + health checks

### Manual Docker Commands:
```bash
# Start services
docker compose -f docker-compose.dev.yml up -d

# View logs
docker compose -f docker-compose.dev.yml logs -f hydra-saml-auth

# Rebuild after code changes
docker compose -f docker-compose.dev.yml build hydra-saml-auth
docker compose -f docker-compose.dev.yml up -d hydra-saml-auth

# Shell access
docker compose -f docker-compose.dev.yml exec hydra-saml-auth bash
```

---

## Kubernetes Development (Stage 2)

After validating your changes in Docker, test them in a local Kubernetes cluster:

### Prerequisites
- k3d (https://k3d.io)
- kubectl
- Docker running

### Commands
```bash
# Create k3d cluster with all manifests
./k8s-dev-setup.sh create

# Check cluster status
./k8s-dev-setup.sh status

# View hydra-auth logs
./k8s-dev-setup.sh logs

# Shell into hydra-auth pod
./k8s-dev-setup.sh shell

# Restart hydra-auth deployment
./k8s-dev-setup.sh restart

# Destroy cluster
./k8s-dev-setup.sh destroy
```

### Access Points (k3d)
- Hydra Dashboard: http://localhost:6969
- Traefik Dashboard: http://localhost:8080

### Useful kubectl Commands
```bash
kubectl get pods -n hydra-system
kubectl get pods -n hydra-students
kubectl logs -n hydra-system deploy/hydra-auth
kubectl describe pod -n hydra-system <pod-name>
```

---

## Production Deployment (Stage 3)

For production deployment to the RKE2 cluster:

### Prerequisites
- Ansible installed on control machine
- SSH access to all target nodes (Hydra, Chimera, Cerberus)
- Inventory configured in `../ansible/inventory.yml`

### Commands
```bash
cd ../ansible

# Full cluster deployment
ansible-playbook -i inventory.yml playbooks/site.yml

# Deploy only to specific hosts
ansible-playbook -i inventory.yml playbooks/site.yml --limit hydra

# Check cluster status
ansible -i inventory.yml all -m ping
```

### Node Roles
| Node | IP | Role | Services |
|------|-----|------|----------|
| Hydra | 192.168.1.100 | RKE2 Server | Control plane, Traefik, Hydra Auth |
| Chimera | 192.168.1.150 | RKE2 Agent | GPU inference (Ollama, vLLM) |
| Cerberus | 192.168.1.242 | RKE2 Agent | GPU training workloads |

---

## Troubleshooting

### Common Issues:

1. **"hydra.local not found"**
   - Run: `sudo ./setup-dev.sh` to update hosts file
   - Or manually add to `/etc/hosts`

2. **Port conflicts**
   - Check for services using ports: 6969, 3000, 7070, 8080, 80, 443
   - Stop conflicting services or modify ports in docker-compose.dev.yml

3. **SAML authentication fails**
   - Check mock-saml-idp logs: `docker logs mock-saml-idp`
   - Ensure METADATA_URL is correct in .env.dev
   - Verify SAML_SP_ENTITY_ID matches

4. **Container permission errors**
   - Ensure Docker socket is accessible
   - Check JWT keys permissions in jwt-keys/

5. **Database connection issues (SQLITE_MISUSE)**
   - The middleman uses a singleton DB connection pattern
   - Restart the middleman container: `docker compose restart openwebui-middleman`

6. **Student container init fails**
   - Check STUDENT_IMAGE in .env.dev is set correctly
   - Pull the image: `docker pull jupyter/minimal-notebook:latest`

### Debug Mode:
Enable detailed logging by setting in `.env.dev`:
```
NODE_ENV=development
DEBUG=*
```

---

## Testing

### Test SAML Flow:
```bash
# Automated test
make test-saml

# Manual test
curl -c cookies.txt -L http://hydra.local:6969/login
```

### Test API Endpoints:
```bash
# Check health
curl http://localhost:7070/openwebui/health

# Test auth verify
curl http://localhost:6969/auth/verify

# Get JWKS
curl http://hydra.local:6969/.well-known/jwks.json
```

### Test Container Management:
1. Login to dashboard
2. Go to Containers tab
3. Start a Jupyter notebook
4. Access at http://hydra.local/students/{username}/{project}

---

## Development Workflow

1. **Code Changes:**
   - Main app code: Edit files in parent directory
   - Changes auto-reload via nodemon
   - For major changes: `make rebuild-hydra`

2. **Database Changes:**
   - Access SQLite: `make shell-db`
   - View schema: `.schema`
   - Query users: `SELECT * FROM user;`

3. **Adding New Services:**
   - Edit docker-compose.dev.yml
   - Add to hydra-dev-net network
   - Update .env.dev if needed
   - Restart: `make restart`

---

## Differences from Production

| Aspect | Production | Development |
|--------|-----------|-------------|
| SAML IdP | Azure AD | Mock SAML IdP |
| Domain | hydra.newpaltz.edu | hydra.local |
| SSL | Required | Optional |
| JWT Keys | Persistent files | Generated on setup |
| Database | Remote SQLite | Local SQLite |
| GPU Support | Nvidia GPUs | Disabled |
| n8n | Full instance | Mock/minimal |
| Orchestrator | Kubernetes (RKE2) | Docker (ORCHESTRATOR=docker) |

---

## Additional Resources

- [Main README](../README.md)
- [Container Documentation](../docs/containers.md)
- [Kubernetes Manifests](../k8s/)
- [Ansible Playbooks](../ansible/)
- [Mock SAML IdP Docs](https://github.com/kristophjunge/docker-test-saml-idp)
- [OpenWebUI Docs](https://docs.openwebui.com)

---

## Contributing

When developing:
1. Test changes locally with `make nuke` first
2. Ensure all services start correctly
3. Verify SAML flow works
4. Test container management features
5. Validate in k3d cluster before production
6. Update this README if adding new services

## License

Same as parent project (Apache-2.0 or as specified)
