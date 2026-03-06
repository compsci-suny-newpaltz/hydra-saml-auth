# Hydra Dev Environment

Local development environment that mirrors the production 3-node RKE2 cluster using k3d.

## What's in it

| Component | Dev | Production |
|-----------|-----|------------|
| Cluster | k3d (k3s v1.28) | RKE2 v1.28 |
| Nodes | 3 containers (hydra, chimera, cerberus) | 3 bare-metal servers |
| Auth | Mock SAML IdP (SimpleSAMLphp) | Azure AD SSO |
| GPU metrics | Mock metrics servers | Real nvidia-smi / DCGM |
| Student pods | K8s pods (same code path) | K8s pods |
| Routing | Traefik v2 (CRD provider) | Traefik v3 (CRD provider) |
| Storage | local-path provisioner | ZFS + NFS |

Node labels, RBAC, namespaces, priority classes, and scheduling all match production.

## Quick start

```bash
# Prerequisites: k3d, kubectl, docker or podman
cd dev/
make up
```

That's it. Open http://localhost:6969/dashboard

## Test credentials

| User | Password | Role |
|------|----------|------|
| admin | password | faculty |
| student | password | student |

## Make targets

```
make up             Full setup (cluster + build + deploy)
make down           Stop cluster (preserves state)
make rebuild        Rebuild image and redeploy (after code changes)
make reset          Destroy and recreate everything
make nuke           Delete cluster and generated files

make status         Show nodes, pods, services
make logs           Follow hydra-auth logs
make shell          Shell into hydra-auth pod
make health         Curl health endpoints

make test-student   Create a test student pod
make rm-students    Remove all student pods
make test-api       Run API endpoint tests
```

## Architecture

```
k3d cluster "hydra-dev"
├── k3d-hydra-dev-server-0     (hydra — control-plane)
│   ├── hydra-auth             (this app, K8s orchestrator mode)
│   ├── traefik                (ingress controller)
│   ├── mock-saml-idp          (SimpleSAMLphp)
│   ├── mock-chimera           (fake GPU metrics)
│   └── mock-cerberus          (fake GPU metrics)
├── k3d-hydra-dev-agent-0      (chimera — inference node)
│   └── student pods land here when requesting GPU (inference)
└── k3d-hydra-dev-agent-1      (cerberus — training node)
    └── student pods land here when requesting GPU (training)
```

## How it maps to production

- `ORCHESTRATOR=kubernetes` — same code path as production
- `K8S_IN_CLUSTER=true` — uses in-cluster service account
- Node labels (`hydra.node-role`, `hydra.student-schedulable`) match production
- Priority classes: `student-pods` (100k) preempts `model-serving` (10k)
- Student pods get the same RBAC, security context, and scheduling rules

## Endpoints

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:6969/dashboard |
| Health | http://localhost:6969/health |
| JWKS | http://localhost:6969/.well-known/jwks.json |
| SAML IdP | http://localhost:8080/simplesaml (admin: admin/secret) |

## Files

```
dev/
├── Makefile           — All dev commands
├── Dockerfile.hydra   — Dev image (nodemon hot-reload)
├── .gitignore         — Ignores generated keys, logs, etc.
├── test-api.sh        — API endpoint tests
├── docs/              — Deploy guide (LaTeX PDF)
├── examples/          — SSO integration example app
└── traefik-dynamic/   — Runtime-generated route configs
```

## Troubleshooting

**Pods stuck in Pending**: Check `kubectl describe pod <name> -n hydra-system` for scheduling errors. The k3d agents simulate GPU nodes but don't have real GPUs — student pods requesting `nvidia.com/gpu` will pend.

**SAML login fails**: The mock IdP callback URL must match `http://localhost:6969/login/callback`. Check with `make logs`.

**Image not found**: After `make rebuild`, if the pod shows `ErrImageNeverPull`, the k3d image import may have failed. Try `k3d image import hydra-saml-auth:dev -c hydra-dev`.

**Reset everything**: `make nuke && make up`
