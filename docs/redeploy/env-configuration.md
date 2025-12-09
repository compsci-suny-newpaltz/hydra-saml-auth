# Environment Configuration

All secrets and configuration are stored in `.env` files (not in git).

## Main App (.env)

Location: `/home/infra/hydra-saml-auth/.env`

```bash
# Copy template
cp .env.example .env
nano .env
```

### Required Variables

```bash
# SAML Configuration (Azure AD)
SAML_ENTRYPOINT=https://login.microsoftonline.com/<TENANT_ID>/saml2
SAML_ISSUER=https://hydra.newpaltz.edu
SAML_CALLBACK_URL=https://hydra.newpaltz.edu/login/callback
SAML_CERT=<BASE64_ENCODED_CERT>

# Session Secret (generate new one)
SESSION_SECRET=<RANDOM_STRING_64_CHARS>

# Database
DATABASE_URL=sqlite:./data/hydra.db

# OpenWebUI API (from Chimera)
OPENWEBUI_API_KEY=<GET_FROM_OPENWEBUI>
OPENWEBUI_URL=http://chimera:3000

# Admin Whitelist
ADMIN_WHITELIST=gopeen1@newpaltz.edu,manzim1@newpaltz.edu
FACULTY_WHITELIST=

# JWT Keys (generate or leave empty for ephemeral)
JWT_PRIVATE_KEY_PEM=
JWT_PUBLIC_KEY_PEM=
```

### Generate Session Secret

```bash
openssl rand -hex 32
```

### Get SAML Certificate

1. Go to Azure AD > Enterprise Applications > Your App > SAML Config
2. Download Certificate (Base64)
3. Convert to single line:
```bash
cat certificate.cer | base64 -w 0
```

## Chimera OpenWebUI (.env)

Location: `/home/infra/hydra-saml-auth/chimera_docker/.env`

```bash
# OpenWebUI Port
OPEN_WEBUI_PORT=3000

# OpenWebUI API Key (generate in OpenWebUI admin)
OPENWEBUI_API_KEY=<YOUR_API_KEY>
```

### Get OpenWebUI API Key

1. Open https://chimera:3000 (or via Hydra proxy)
2. Login as admin
3. Settings > Account > API Keys
4. Generate new key

## Monitoring (.env)

Location: `/home/infra/monitoring/.env`

```bash
# Domain
DOMAIN=newpaltz.edu

# Grafana
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<SECURE_PASSWORD>

# SSO (optional)
GRAFANA_OAUTH_CLIENT_ID=
GRAFANA_OAUTH_CLIENT_SECRET=

# Alertmanager SMTP
SMTP_USERNAME=
SMTP_PASSWORD=
```

## Headscale VPN (.env)

Location: `/home/infra/vpn/.env`

```bash
DOMAIN=newpaltz.edu
```

Plus edit `config/config.yaml` for OIDC settings.

---

## Secrets to Backup

Before wiping machines, backup these:

1. **SAML Certificate** - From Azure AD
2. **Session secrets** - Or regenerate
3. **OpenWebUI API keys** - Or regenerate
4. **WireGuard keys** - Or regenerate
5. **Ollama models** - `/models` on Chimera (large!)

## Quick Setup Script

After fresh install, create `.env` quickly:

```bash
#!/bin/bash
# setup-env.sh

# Generate secrets
SESSION_SECRET=$(openssl rand -hex 32)

cat > .env << EOF
# Auto-generated $(date)
SESSION_SECRET=$SESSION_SECRET
ADMIN_WHITELIST=gopeen1@newpaltz.edu,manzim1@newpaltz.edu

# TODO: Fill these in manually
SAML_ENTRYPOINT=
SAML_ISSUER=https://hydra.newpaltz.edu
SAML_CALLBACK_URL=https://hydra.newpaltz.edu/login/callback
SAML_CERT=

OPENWEBUI_API_KEY=
OPENWEBUI_URL=http://chimera:3000
EOF

echo "Created .env - edit to add SAML and API keys"
```
