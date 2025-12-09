# VPN Setup Guide

Two VPN options: existing WireGuard (simple) or Headscale (SSO-integrated).

## Option 1: WireGuard (Current Setup)

Simple point-to-point VPN between the three machines. Already running.

### Current Configuration

```
VPN Subnet: 10.8.0.0/24
Hydra:    10.8.0.1 (server, port 51820)
Chimera:  10.8.0.2
Cerberus: 10.8.0.3
```

### After Fresh Install - Regenerate Keys

On each machine:
```bash
sudo apt install -y wireguard

# Generate new keys
wg genkey | sudo tee /etc/wireguard/private.key
sudo chmod 600 /etc/wireguard/private.key
sudo cat /etc/wireguard/private.key | wg pubkey | sudo tee /etc/wireguard/public.key

# Note down the public key
cat /etc/wireguard/public.key
```

### Hydra Config (Server)

```bash
sudo nano /etc/wireguard/wg0.conf
```

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <HYDRA_PRIVATE_KEY>

[Peer]
PublicKey = <CHIMERA_PUBLIC_KEY>
AllowedIPs = 10.8.0.2/32

[Peer]
PublicKey = <CERBERUS_PUBLIC_KEY>
AllowedIPs = 10.8.0.3/32
```

### Chimera Config (Client)

```ini
[Interface]
Address = 10.8.0.2/32
PrivateKey = <CHIMERA_PRIVATE_KEY>

[Peer]
PublicKey = <HYDRA_PUBLIC_KEY>
Endpoint = 192.168.1.160:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

### Cerberus Config (Client)

```ini
[Interface]
Address = 10.8.0.3/32
PrivateKey = <CERBERUS_PRIVATE_KEY>

[Peer]
PublicKey = <HYDRA_PUBLIC_KEY>
Endpoint = 192.168.1.160:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

### Start WireGuard

```bash
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0
```

---

## Option 2: Headscale (Recommended for Future)

Self-hosted Tailscale control server with SSO integration.

### Benefits over WireGuard
- SSO authentication (Azure AD)
- ACL-based access control
- Automatic key rotation
- Web UI for management
- Easy client setup (just install Tailscale)

### Deploy Headscale on Hydra

```bash
cd /home/infra/hydra-saml-auth/infrastructure/docker-compose/vpn

# Edit config
nano config/config.yaml
# Update: server_url, OIDC settings

# Start
docker compose up -d
```

### Configure ACLs

Edit `config/acl.json`:
```json
{
  "groups": {
    "group:admins": ["gopeen1", "manzim1"],
    "group:faculty": [],
    "group:students": []
  },
  "hosts": {
    "hydra": "100.64.0.1",
    "chimera": "100.64.0.2",
    "cerberus": "100.64.0.3"
  },
  "acls": [
    {
      "action": "accept",
      "src": ["group:admins"],
      "dst": ["*:*"]
    },
    {
      "action": "accept",
      "src": ["group:faculty"],
      "dst": ["hydra:80,443", "chimera:80,443,11434"]
    }
  ]
}
```

### Create Auth Key

```bash
docker exec headscale headscale preauthkeys create --user default --expiration 24h
```

### Connect Nodes

On each machine:
```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Connect to Headscale
sudo tailscale up --login-server=https://vpn.newpaltz.edu --authkey=<AUTH_KEY>
```

### Verify

```bash
# Check status
tailscale status

# Should show all connected nodes
```

---

## Which to Use?

| Feature | WireGuard | Headscale |
|---------|-----------|-----------|
| Setup complexity | Simple | Moderate |
| SSO integration | No | Yes |
| ACLs | Manual | Built-in |
| Client install | Config file | One command |
| Key management | Manual | Automatic |
| Web UI | No | Yes |

**Recommendation:**
- Use WireGuard for quick internal machine-to-machine VPN
- Use Headscale when you need user access control and SSO

You can run both - WireGuard for server interconnect, Headscale for user access.
