# ilcc — web LCC assembler/debugger + course downloads + autograder

Prod: **https://hydra.newpaltz.edu/ilcc** · source: `ndg8743/web_ilcc` (`main`) · namespace `hydra-infra` (exists).

First component to check in its IngressRoute/Middleware YAML — apply with `kubectl apply -k .`.

## Files
| file | what |
|---|---|
| `configmap.yaml` | non-secret env |
| `secret.yaml.example` | copy to `secret.yaml` (gitignored) — `HYDRA_PROXY_SECRET`, `SEED_ADMINS` |
| `pvc.yaml` | `ilcc-data` (SQLite + backups), `ilcc-downloads` (course zips + textbook) |
| `deployment.yaml` | single container, probes on `/api/health` `/api/ready` |
| `service.yaml` | ClusterIP 80 → 3000 |
| `middleware.yaml` | `ilcc-strip` (drop `/ilcc`), `ilcc-proxy-secret` (inject the shared secret after forward-auth) |
| `ingressroute.yaml` | two rules: SSO-gated paths (priority 200) and public catch-all (100) |
| `cronjob-backup.yaml` | nightly `sqlite3 .backup`, keep 14 |

## Deploy
```bash
/home/infra/hydra-saml-auth/scripts/deploy-ilcc.sh            # build + import + roll
/home/infra/hydra-saml-auth/scripts/deploy-ilcc.sh --sync-downloads   # also push the 254 MB of course files
```

## Data safety
Both PVCs use `hydra-local` (`reclaimPolicy: Delete`). **Never `kubectl delete pvc`** — that deletes the data. After first bind, pin the PVs:
```bash
for pv in $(kubectl get pv -o json | jq -r '.items[] | select(.spec.claimRef.namespace=="hydra-infra" and (.spec.claimRef.name|startswith("ilcc-"))) | .metadata.name'); do
  kubectl patch pv $pv -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
done
```
Backups land in `/data/backups/` on `ilcc-data`; copy off-node weekly with `kubectl cp`.

## Auth model
Traefik `hydra-forward-auth` (hydra-system) validates the SAML session and returns `X-Hydra-User/Email/Roles`. `ilcc-proxy-secret` then adds `X-Hydra-Proxy-Secret`. The app only trusts identity headers from the pod CIDR **and** with that secret. Faculty (SAML affiliation) are auto-admins; `SEED_ADMINS` adds explicit ones; admins add TAs in the app.
