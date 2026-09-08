
## Auto-deploy (since 2026-09-08)

Pushing to `main` redeploys https://hydra.newpaltz.edu/ilcc automatically:
GitHub webhook → `https://hydra.newpaltz.edu/hooks/ilcc-deploy` (HMAC-verified,
served by `ilcc-webhook.service` on the Hydra host) → `deploy-ilcc.sh`
(build, import, roll, smoke). Concurrent pushes coalesce into one follow-up deploy.

- Status: `https://hydra.newpaltz.edu/hooks/ilcc-deploy/status` (JSON: running / last result)
- Logs: `journalctl -u ilcc-webhook` and `/var/log/ilcc-webhook/deploy.log` on Hydra
- Secret: `/etc/ilcc-webhook.env` on Hydra + the webhook config on the GitHub repo
- CI (`.github/workflows/ci.yml`) runs in parallel on the same push; the deploy
  does not wait for it — revert or push a fix if CI catches something.
