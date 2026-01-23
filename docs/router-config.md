# Router & Network Configuration for SSHPiper

## Overview

This document describes how to configure your router and network to support the SSHPiper SSH proxy for Hydra student containers.

## Port Forwarding Rules

Add these port forwarding rules to your router:

| External Port | Internal IP | Internal Port | Protocol | Description |
|---------------|-------------|---------------|----------|-------------|
| 22 | 192.168.1.150 | 22 | TCP | Admin SSH access to Hydra server |
| 2222 | 192.168.1.150 | 2222 | TCP | Student SSH via sshpiper |
| 80 | 192.168.1.150 | 80 | TCP | HTTP (redirects to HTTPS) |
| 443 | 192.168.1.150 | 443 | TCP | HTTPS (dashboard, n8n, gpt) |

## Router Configuration (Common Routers)

### pfSense / OPNsense

1. Navigate to **Firewall > NAT > Port Forward**
2. Click **Add** and configure:
   - Interface: WAN
   - Protocol: TCP
   - Destination port range: 2222
   - Redirect target IP: 192.168.1.150
   - Redirect target port: 2222
   - Description: Hydra Student SSH
3. Save and apply changes

### Ubiquiti EdgeRouter / UniFi

```bash
# SSH into router and run:
configure
set port-forward rule 10 description "Hydra Student SSH"
set port-forward rule 10 forward-to address 192.168.1.150
set port-forward rule 10 forward-to port 2222
set port-forward rule 10 original-port 2222
set port-forward rule 10 protocol tcp
commit
save
```

### MikroTik RouterOS

```bash
/ip firewall nat add chain=dstnat protocol=tcp dst-port=2222 \
    action=dst-nat to-addresses=192.168.1.150 to-ports=2222 \
    comment="Hydra Student SSH"
```

### Generic Home Router (TP-Link, Netgear, etc.)

1. Log into router admin panel (usually 192.168.1.1)
2. Find **Port Forwarding** or **Virtual Server** settings
3. Add new rule:
   - Service Name: Hydra SSH
   - External Port: 2222
   - Internal IP: 192.168.1.150
   - Internal Port: 2222
   - Protocol: TCP
4. Save and reboot if required

## Firewall Configuration (on Hydra Server)

If UFW is enabled on the Hydra server:

```bash
# Allow sshpiper port
sudo ufw allow 2222/tcp comment "SSHPiper student SSH"

# Verify
sudo ufw status
```

Expected output:
```
22/tcp                     ALLOW       Anywhere       # Admin SSH
2222/tcp                   ALLOW       Anywhere       # SSHPiper student SSH
80/tcp                     ALLOW       Anywhere       # HTTP
443/tcp                    ALLOW       Anywhere       # HTTPS
```

## Traefik Configuration (Optional)

If you want to route SSH through Traefik (not recommended for SSH), you would need TCP routing:

### traefik.yaml (static config)
```yaml
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  ssh:
    address: ":2222"

providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
```

### dynamic/ssh.yaml
```yaml
tcp:
  routers:
    ssh-router:
      entryPoints:
        - ssh
      rule: "HostSNI(`*`)"
      service: sshpiper-service

  services:
    sshpiper-service:
      loadBalancer:
        servers:
          - address: "sshpiper:2222"
```

**Note:** Direct port exposure (recommended) is simpler and more reliable for SSH than routing through Traefik.

## DNS Configuration

Ensure `hydra.newpaltz.edu` resolves to your external IP. No changes needed if already configured.

## Testing

### From External Network

```bash
# Test SSH connectivity
ssh -i ~/.ssh/testuser_hydra_key testuser@hydra.newpaltz.edu -p 2222

# Test with verbose output
ssh -v -i ~/.ssh/testuser_hydra_key testuser@hydra.newpaltz.edu -p 2222
```

### From Internal Network

```bash
# Direct to server
ssh -i ~/.ssh/testuser_hydra_key testuser@192.168.1.150 -p 2222

# Test port is open
nc -zv 192.168.1.150 2222
```

## Troubleshooting

### Port not reachable externally

1. Check router port forwarding is saved/applied
2. Check ISP doesn't block port 2222
3. Try alternative port (e.g., 2200) if blocked

### Connection refused

```bash
# Check sshpiper is running
docker ps | grep sshpiper

# Check sshpiper logs
docker logs sshpiper

# Verify port binding
netstat -tlnp | grep 2222
```

### Authentication failed

1. Verify user has sshpiper config: `ls /home/infra/hydra-saml-auth/sshpiper/config/[username]/`
2. Check authorized_keys exists and has correct key
3. Regenerate keys from dashboard if needed

### Wrong container

1. Check `sshpiper_upstream` file points to correct container
2. Verify container is running: `docker ps | grep student-[username]`
