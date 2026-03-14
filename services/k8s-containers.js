// services/k8s-containers.js - Kubernetes-based container management
// Replaces Docker API calls with Kubernetes API calls

const k8sClient = require('./k8s-client');
const runtimeConfig = require('../config/runtime');
const resourceConfig = require('../config/resources');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

// Docker Traefik dynamic config directory (for Apache -> Docker Traefik -> K8s routing)
const TRAEFIK_DYNAMIC_DIR = runtimeConfig.docker?.traefikConfigPath || '/etc/traefik/dynamic';

// Generate a random password for student container
function generatePassword(length = 16) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

// Build pod specification from config
function buildPodSpec(username, email, config) {
  const targetNode = config.target_node || 'hydra';
  const nodeConfig = resourceConfig.getNodeConfig(targetNode);

  if (!nodeConfig) {
    throw new Error(`Unknown target node: ${targetNode}. Valid nodes are: hydra, chimera, cerberus`);
  }

  const preset = resourceConfig.presets[config.preset] || resourceConfig.presets.conservative;

  // Determine resource limits - prioritize config values over preset
  const memoryMb = config.memory_mb || preset.memory_mb || 512;
  const cpus = config.cpus || preset.cpus || 1;
  const gpuCount = config.gpu_count !== undefined ? config.gpu_count : (preset.gpu_count || 0);

  console.log(`[K8s] Building pod spec for ${username}: node=${targetNode}, memory=${memoryMb}Mi, cpus=${cpus}, gpu=${gpuCount}`);

  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `student-${username}`,
      namespace: runtimeConfig.k8s.namespace,
      labels: {
        'app.kubernetes.io/name': 'student-container',
        'app.kubernetes.io/instance': username,
        'app.kubernetes.io/managed-by': 'hydra-auth',
        'hydra.owner': username
      },
      annotations: {
        'hydra.created-at': new Date().toISOString(),
        'hydra.owner-email': email,
        'hydra.preset': config.preset || 'conservative',
        'hydra.target-node': config.target_node || 'hydra'
      }
    },
    spec: {
      // Use NVIDIA runtime for GPU pods - required for GPU device access
      ...(gpuCount > 0 && { runtimeClassName: 'nvidia' }),
      // Student pods preempt model-serving pods when GPU resources are needed
      priorityClassName: 'student-pods',
      serviceAccountName: 'student-workload',
      automountServiceAccountToken: false,
      // Security context - hardened for student containers
      // NOTE: runAsNonRoot is false because entrypoint needs root for SSH key setup,
      // but drops to user 1000 (student) via supervisor after initialization
      securityContext: {
        runAsUser: 0,  // Start as root for entrypoint (drops to 1000 after init)
        runAsGroup: 0,
        fsGroup: 1000,
        seccompProfile: {
          type: 'RuntimeDefault'
        }
      },
      // Node selection — GPU nodes use hard requirement, Hydra uses soft preference
      // This ensures approved GPU migrations land on the correct node
      nodeSelector: { 'hydra.student-schedulable': 'true' },
      affinity: {
        nodeAffinity: targetNode !== 'hydra' ? {
          // GPU nodes: HARD requirement — pod MUST land on the approved node
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [{
              matchExpressions: Object.entries(
                nodeConfig?.k8s?.nodeSelector || {}
              ).map(([key, value]) => ({ key, operator: 'In', values: [value] }))
            }]
          }
        } : {
          // Hydra: soft preference — allow scheduling on any schedulable node
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 80,
            preference: {
              matchExpressions: [{ key: 'hydra.node-role', operator: 'In', values: ['control-plane'] }]
            }
          }]
        }
      },
      // GPU tolerations — always include so pods can land on GPU nodes when needed
      tolerations: [
        ...(nodeConfig?.k8s?.tolerations || []),
        { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }
      ],
      containers: [{
        name: 'student',
        image: gpuCount > 0 ? runtimeConfig.k8s.gpuStudentImage : runtimeConfig.k8s.studentImage,
        // Use IfNotPresent - images must be imported to RKE2's containerd correctly
        imagePullPolicy: 'IfNotPresent',
        env: [
          { name: 'USERNAME', value: username },
          { name: 'USER_EMAIL', value: email },
          { name: 'HOME', value: '/home/student' },
          { name: 'JUPYTER_APPROVED', value: config.jupyter_approved ? 'true' : 'false' },
          { name: 'JENKINS_APPROVED', value: config.jenkins_approved ? 'true' : 'false' },
          { name: 'DOCKER_HOST', value: 'unix:///var/run/docker/docker.sock' },
          {
            name: 'PASSWORD',
            valueFrom: {
              secretKeyRef: {
                name: `student-${username}-creds`,
                key: 'password'
              }
            }
          },
          {
            name: 'SSH_PUBLIC_KEY',
            valueFrom: {
              secretKeyRef: {
                name: `student-${username}-creds`,
                key: 'ssh_public_key',
                optional: true
              }
            }
          }
        ],
        ports: [
          { name: 'ssh', containerPort: 22, protocol: 'TCP' },
          { name: 'vscode', containerPort: 8443, protocol: 'TCP' },
          { name: 'jupyter', containerPort: 8888, protocol: 'TCP' },
          { name: 'supervisor', containerPort: 9001, protocol: 'TCP' },
          { name: 'jenkins', containerPort: 8080, protocol: 'TCP' }
        ],
        resources: {
          requests: {
            memory: `${Math.round(memoryMb * 0.5)}Mi`,
            cpu: `${Math.round(cpus * 250)}m`
          },
          limits: {
            memory: `${memoryMb}Mi`,
            cpu: `${Math.max(0.5, cpus * 0.5)}`
          }
        },
        volumeMounts: [
          { name: 'home', mountPath: '/home/student' },
          { name: 'docker-socket', mountPath: '/var/run/docker', readOnly: false }
        ],
        // Container runs as root initially, then drops to user 1000 via entrypoint
        securityContext: {
          allowPrivilegeEscalation: true,
          readOnlyRootFilesystem: false,
          capabilities: {
            drop: ['ALL'],
            add: [
              'CHOWN',           // Volume permission setup
              'DAC_OVERRIDE',    // Entrypoint system file modifications
              'SETUID', 'SETGID', // Supervisor user switching + sudo
              'NET_BIND_SERVICE', // Ports < 1024 (SSH on 22)
              'SYS_CHROOT',      // sshd privilege separation
              'KILL',            // Supervisor process management
              'FOWNER'           // apt/dpkg file ownership operations
            ]
          }
        },
        // Disable password auth on startup for security
        lifecycle: {
          postStart: {
            exec: {
              command: ['/bin/sh', '-c', 'sed -i \'s|port=127.0.0.1:9001|port=0.0.0.0:9001|\' /etc/supervisor/conf.d/supervisord.conf; sed -i \'/^username=student/d\' /etc/supervisor/conf.d/supervisord.conf; sed -i \'/^password=%(ENV_PASSWORD)s/d\' /etc/supervisor/conf.d/supervisord.conf; sed -i "s/^PasswordAuthentication yes/PasswordAuthentication no/" /etc/ssh/sshd_config; sed -i "s/^#*AllowUsers/#AllowUsers/" /etc/ssh/sshd_config; echo "StrictModes no" >> /etc/ssh/sshd_config; true']
            }
          }
        }
      },
      // Docker-in-Docker sidecar — isolated Docker daemon per student
      {
        name: 'dind',
        image: 'docker:27-dind',
        imagePullPolicy: 'IfNotPresent',
        securityContext: {
          privileged: true
        },
        args: ['--host', 'unix:///var/run/docker/docker.sock'],
        env: [
          { name: 'DOCKER_TLS_CERTDIR', value: '' }
        ],
        volumeMounts: [
          { name: 'docker-socket', mountPath: '/var/run/docker' },
          { name: 'dind-storage', mountPath: '/var/lib/docker' }
        ],
        resources: {
          requests: {
            memory: '256Mi',
            cpu: '100m'
          },
          limits: {
            memory: '1Gi',
            cpu: '1'
          }
        }
      }],
      volumes: [
        {
          name: 'home',
          persistentVolumeClaim: {
            claimName: `hydra-vol-${username}`
          }
        },
        {
          name: 'docker-socket',
          emptyDir: {}
        },
        {
          name: 'dind-storage',
          emptyDir: {}
        }
      ],
      restartPolicy: 'Always',
      terminationGracePeriodSeconds: 30
    }
  };

  // Add GPU resources if requested
  if (gpuCount > 0) {
    pod.spec.containers[0].resources.limits['nvidia.com/gpu'] = String(gpuCount);
    pod.spec.containers[0].resources.requests['nvidia.com/gpu'] = String(gpuCount);
  }

  return pod;
}

// Build PVC specification
function buildPVCSpec(username, storageGb, storageClass, config = {}) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: `hydra-vol-${username}`,
      namespace: runtimeConfig.k8s.namespace,
      labels: {
        'app.kubernetes.io/name': 'student-volume',
        'app.kubernetes.io/instance': username,
        'app.kubernetes.io/managed-by': 'hydra-auth',
        'hydra.owner': username
      },
      annotations: {
        'hydra.owner-email': config.email || '',
        'hydra.preset': config.preset || resourceConfig.defaults.preset,
        'hydra.target-node': config.target_node || 'hydra',
        'hydra.created-at': new Date().toISOString()
      }
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: storageClass || runtimeConfig.k8s.defaultStorageClass,
      resources: {
        requests: {
          storage: `${storageGb}Gi`
        }
      }
    }
  };
}

// Build Service specification
function buildServiceSpec(username) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `student-${username}`,
      namespace: runtimeConfig.k8s.namespace,
      labels: {
        'app.kubernetes.io/name': 'student-service',
        'app.kubernetes.io/instance': username,
        'hydra.owner': username
      }
    },
    spec: {
      type: 'ClusterIP',
      ports: [
        { name: 'ssh', port: 22, targetPort: 22 },
        { name: 'vscode', port: 8443, targetPort: 'vscode' },
        { name: 'jupyter', port: 8888, targetPort: 'jupyter' },
        { name: 'supervisor', port: 9001, targetPort: 'supervisor' },
        { name: 'jenkins', port: 8080, targetPort: 'jenkins' }
      ],
      selector: {
        'app.kubernetes.io/name': 'student-container',
        'app.kubernetes.io/instance': username
      }
    }
  };
}

// Build Secret specification for credentials
function buildSecretSpec(username, password, sshPublicKey = null) {
  const stringData = { password };
  if (sshPublicKey) {
    stringData.ssh_public_key = sshPublicKey;
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `student-${username}-creds`,
      namespace: runtimeConfig.k8s.namespace,
      labels: {
        'hydra.owner': username
      }
    },
    type: 'Opaque',
    stringData
  };
}

// Build IngressRoute specification
function buildIngressRouteSpec(username, customRoutes = []) {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: `student-${username}`,
      namespace: runtimeConfig.k8s.namespace,
      labels: {
        'app.kubernetes.io/name': 'student-route',
        'app.kubernetes.io/instance': username,
        'hydra.owner': username
      }
    },
    spec: {
      entryPoints: ['web', 'websecure'],
      routes: [
        {
          match: `Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/vscode\`)`,
          kind: 'Rule',
          priority: 100,
          services: [{ name: `student-${username}`, port: 8443 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
            { name: `strip-prefix-${username}` },
            { name: 'strip-session-cookie', namespace: runtimeConfig.k8s.systemNamespace }
          ]
        },
        {
          match: `Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/jupyter\`)`,
          kind: 'Rule',
          priority: 100,
          services: [{ name: `student-${username}`, port: 8888 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
            { name: 'strip-session-cookie', namespace: runtimeConfig.k8s.systemNamespace }
          ]
        },
        {
          match: `Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/jenkins\`)`,
          kind: 'Rule',
          priority: 100,
          services: [{ name: `student-${username}`, port: 8080 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
            { name: 'strip-session-cookie', namespace: runtimeConfig.k8s.systemNamespace }
          ]
        },
        ...customRoutes.map(route => ({
          match: `Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/${route.endpoint}\`)`,
          kind: 'Rule',
          priority: 100,
          services: [{ name: `student-${username}`, port: route.port }],
          middlewares: route.public === false
            ? [
                { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
                { name: `strip-prefix-${username}` },
                { name: 'strip-session-cookie', namespace: runtimeConfig.k8s.systemNamespace }
              ]
            : [
                // Public route — no SSO, strip prefix + cookies
                { name: `strip-prefix-${username}` },
                { name: 'strip-session-cookie', namespace: runtimeConfig.k8s.systemNamespace }
              ]
        }))
      ],
      tls: {
        secretName: 'hydra-tls'
      }
    }
  };
}

// Build Middleware specification for strip-prefix
function buildMiddlewareSpec(username, customRoutes = []) {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: {
      name: `strip-prefix-${username}`,
      namespace: runtimeConfig.k8s.namespace,
      labels: {
        'hydra.owner': username
      }
    },
    spec: {
      stripPrefix: {
        prefixes: [
          `/students/${username}/vscode`,
          `/students/${username}/jupyter`,
          `/students/${username}/supervisor`,
          `/students/${username}/jenkins`,
          ...customRoutes.map(r => `/students/${username}/${r.endpoint}`)
        ]
      }
    }
  };
}

// ==================== CUSTOM ROUTE HELPERS ====================

/**
 * Get custom routes from IngressRoute (non-default routes)
 * Default routes are vscode, jupyter, jenkins
 */
async function getCustomRoutes(username) {
  const ingressRoute = await k8sClient.getIngressRoute(`student-${username}`);
  if (!ingressRoute?.spec?.routes) return [];

  const defaultEndpoints = ['vscode', 'jupyter', 'jenkins'];
  const customRoutes = [];

  for (const route of ingressRoute.spec.routes) {
    const match = route.match?.match(/PathPrefix\(`\/students\/[^/]+\/([^`]+)`\)/);
    if (match && !defaultEndpoints.includes(match[1])) {
      const port = route.services?.[0]?.port;
      if (port) {
        // Detect if route has forward-auth middleware (SSO enabled)
        const hasAuth = route.middlewares?.some(m => m.name === 'hydra-forward-auth');
        customRoutes.push({ endpoint: match[1], port, public: !hasAuth });
      }
    }
  }

  return customRoutes;
}

// ==================== DOCKER TRAEFIK CONFIG ====================

/**
 * Write Docker Traefik config file that routes to K8s Traefik
 * This is needed because Apache proxies to Docker Traefik (8082),
 * which then needs to forward K8s student routes to K8s Traefik (30080)
 * Note: This is only needed in hybrid Docker+K8s setups; skipped in pure K8s
 * @param {string} username
 * @param {Array|null} customRoutes - Custom routes array, or null to auto-discover from IngressRoute
 */
async function writeDockerTraefikConfig(username, customRoutes = null) {
  // Skip if Traefik dynamic dir doesn't exist (pure K8s mode without Docker Traefik)
  try {
    await fs.access(TRAEFIK_DYNAMIC_DIR);
  } catch {
    // Directory doesn't exist - we're in pure K8s mode, skip Docker Traefik config
    return;
  }

  // Auto-discover custom routes from IngressRoute if not explicitly provided
  if (customRoutes === null) {
    try {
      customRoutes = await getCustomRoutes(username);
    } catch (e) {
      customRoutes = [];
    }
  }

  const filePath = path.join(TRAEFIK_DYNAMIC_DIR, `student-${username}.yaml`);

  const config = {
    http: {
      routers: {
        [`student-${username}-vscode`]: {
          entryPoints: ['web'],
          rule: `PathPrefix(\`/students/${username}/vscode\`)`,
          service: `k8s-traefik-${username}`,
          middlewares: [`student-${username}-auth`]
        },
        [`student-${username}-jupyter`]: {
          entryPoints: ['web'],
          rule: `PathPrefix(\`/students/${username}/jupyter\`)`,
          service: `k8s-traefik-${username}`,
          middlewares: [`student-${username}-auth`]
        },
        [`student-${username}-jenkins`]: {
          entryPoints: ['web'],
          rule: `PathPrefix(\`/students/${username}/jenkins\`)`,
          service: `k8s-traefik-${username}`,
          middlewares: [`student-${username}-auth`]
        },
        ...Object.fromEntries(customRoutes.map(route => [
          `student-${username}-${route.endpoint}`,
          {
            entryPoints: ['web'],
            rule: `PathPrefix(\`/students/${username}/${route.endpoint}\`)`,
            service: `k8s-traefik-${username}`
            // No auth middleware — student sites are public
          }
        ]))
      },
      services: {
        [`k8s-traefik-${username}`]: {
          loadBalancer: {
            servers: [
              { url: 'http://host.docker.internal:30080' }
            ]
          }
        }
      },
      middlewares: {
        [`student-${username}-auth`]: {
          forwardAuth: {
            address: 'http://host.docker.internal:6969/auth/verify',
            trustForwardHeader: true
          }
        }
      }
    }
  };

  await fs.writeFile(filePath, yaml.dump(config), 'utf8');
  console.log(`[K8s] Created Docker Traefik config for ${username}: ${filePath}`);
}

/**
 * Delete Docker Traefik config file
 */
async function deleteDockerTraefikConfig(username) {
  const filePath = path.join(TRAEFIK_DYNAMIC_DIR, `student-${username}.yaml`);
  try {
    await fs.unlink(filePath);
    console.log(`[K8s] Deleted Docker Traefik config for ${username}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[K8s] Failed to delete Traefik config for ${username}:`, err.message);
    }
    return false;
  }
}

// ==================== SSH KEY GENERATION ====================

const SSH_KEYS_DIR = process.env.SSH_KEYS_DIR || '/app/data/ssh-keys';

async function ensureSSHKeysDir() {
  try {
    await fs.mkdir(SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function generateSSHKeys(username) {
  await ensureSSHKeysDir();

  const privateKeyPath = path.join(SSH_KEYS_DIR, `${username}_id_ed25519`);
  const publicKeyPath = `${privateKeyPath}.pub`;

  // Check if keys already exist
  try {
    await fs.access(privateKeyPath);
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    return { publicKey: publicKey.trim(), keyExists: true };
  } catch {
    // Keys don't exist, generate new ones
  }

  try {
    execSync(`ssh-keygen -t ed25519 -f "${privateKeyPath}" -N "" -C "${username}@hydra.newpaltz.edu"`, {
      stdio: 'pipe'
    });
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    console.log(`[K8s] Generated SSH keys for ${username}`);
    return { publicKey: publicKey.trim(), keyExists: false };
  } catch (err) {
    console.error(`[K8s] Failed to generate SSH keys for ${username}:`, err);
    throw new Error('Failed to generate SSH keys');
  }
}

// ==================== SSH PIPER CONFIG ====================

const SSHPIPER_CONFIG_DIR = runtimeConfig.sshpiper?.configPath || '/app/sshpiper/config';

/**
 * Update SSH piper config to point to K8s pod IP
 * This is needed because sshpiper runs in Docker and can't resolve K8s service names
 */
async function updateSshPiperConfig(username, podIP) {
  const userDir = path.join(SSHPIPER_CONFIG_DIR, username);
  const upstreamFile = path.join(userDir, 'sshpiper_upstream');
  // Use student@ prefix — container SSH user is always 'student'
  // Use K8s service FQDN — survives pod restarts/migrations
  const upstream = `student@student-${username}.hydra-students.svc.cluster.local:22`;

  const SSH_KEYS_DIR = runtimeConfig.sshpiper?.keysPath || '/app/data/ssh-keys';

  try {
    // Ensure directory exists
    await fs.mkdir(userDir, { recursive: true });

    // Write upstream config pointing to stable service DNS
    await fs.writeFile(upstreamFile, `${upstream}\n`, 'utf8');

    // Copy private key as id_rsa — sshpiper workingdir plugin hardcodes this filename
    const privateKeyPath = path.join(SSH_KEYS_DIR, `${username}_id_ed25519`);
    try {
      const privateKey = await fs.readFile(privateKeyPath, 'utf8');
      await fs.writeFile(path.join(userDir, 'id_rsa'), privateKey, { mode: 0o644 });
    } catch (err) {
      console.warn(`[K8s] Could not copy private key for ${username}:`, err.message);
    }

    // Copy public key as authorized_keys (for user auth to sshpiper)
    const publicKeyPath = `${privateKeyPath}.pub`;
    try {
      const publicKey = await fs.readFile(publicKeyPath, 'utf8');
      await fs.writeFile(path.join(userDir, 'authorized_keys'), publicKey, { mode: 0o644 });
    } catch (err) {
      console.warn(`[K8s] Could not copy public key for ${username}:`, err.message);
    }

    console.log(`[K8s] Updated SSH piper config for ${username}: ${upstream}`);
    return true;
  } catch (err) {
    console.warn(`[K8s] Failed to update SSH piper config for ${username}:`, err.message);
    return false;
  }
}

/**
 * Delete SSH piper config for a user
 */
async function deleteSshPiperConfig(username) {
  const userDir = path.join(SSHPIPER_CONFIG_DIR, username);
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    console.log(`[K8s] Deleted SSH piper config for ${username}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[K8s] Failed to delete SSH piper config for ${username}:`, err.message);
    }
    return false;
  }
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Wait for a pod to be ready
 * @param {string} username - The student username
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<{ready: boolean, status: string}>}
 */
async function waitForPodReady(username, timeoutMs = 60000) {
  const startTime = Date.now();
  const podName = `student-${username}`;

  while (Date.now() - startTime < timeoutMs) {
    const pod = await k8sClient.getPod(podName);
    if (!pod) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    const phase = pod.status?.phase;
    const containerStatus = pod.status?.containerStatuses?.[0];

    // Pod is running and container is ready
    if (phase === 'Running' && containerStatus?.ready) {
      return { ready: true, status: 'running' };
    }

    // Pod failed
    if (phase === 'Failed') {
      return { ready: false, status: 'failed' };
    }

    // Check for container errors
    if (containerStatus?.state?.waiting?.reason) {
      const reason = containerStatus.state.waiting.reason;
      if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull' || reason === 'CrashLoopBackOff') {
        return { ready: false, status: reason.toLowerCase() };
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Timeout - return current status
  const pod = await k8sClient.getPod(podName);
  return {
    ready: false,
    status: pod?.status?.phase?.toLowerCase() || 'timeout'
  };
}

// ==================== PUBLIC API ====================

/**
 * Initialize a new student container
 */
async function initContainer(username, email, config = {}) {
  const password = generatePassword();
  const storageGb = config.storage_gb || resourceConfig.defaults.storage_gb;
  const nodeConfig = resourceConfig.getNodeConfig(config.target_node || 'hydra');
  // Use NFS storage so pods can be scheduled on any node
  const storageClass = 'hydra-nfs';

  // Merge config with email for PVC storage
  const fullConfig = { ...config, email };

  try {
    // 1. Generate SSH keys (must happen before creating secret and pod)
    let sshPublicKey = null;
    try {
      const { publicKey } = await generateSSHKeys(username);
      sshPublicKey = publicKey;
      console.log(`[K8s] SSH keys ready for ${username}`);
    } catch (err) {
      console.warn(`[K8s] Could not generate SSH keys for ${username}:`, err.message);
    }

    // 2. Create PVC if not exists
    const existingPVC = await k8sClient.getPVC(`hydra-vol-${username}`);
    if (!existingPVC) {
      console.log(`[K8s] Creating PVC for ${username} (${storageGb}GB)`);
      await k8sClient.createPVC(buildPVCSpec(username, storageGb, storageClass, fullConfig));
    }

    // 3. Create credentials secret (includes SSH public key)
    const existingSecret = await k8sClient.getSecret(`student-${username}-creds`);
    if (!existingSecret) {
      console.log(`[K8s] Creating credentials secret for ${username}`);
      await k8sClient.createSecret(buildSecretSpec(username, password, sshPublicKey));
    } else if (sshPublicKey) {
      // Secret exists but may not have SSH key — patch it in
      try {
        await k8sClient.patchSecret(`student-${username}-creds`, runtimeConfig.k8s.namespace, {
          stringData: { ssh_public_key: sshPublicKey }
        });
        console.log(`[K8s] Patched SSH public key into existing secret for ${username}`);
      } catch (err) {
        console.warn(`[K8s] Could not patch SSH key into secret for ${username}:`, err.message);
      }
    }

    // 4. Create pod
    console.log(`[K8s] Creating pod for ${username}`);
    await k8sClient.createPod(buildPodSpec(username, email, config));

    // 5. Create service
    const existingService = await k8sClient.getService(`student-${username}`);
    if (!existingService) {
      console.log(`[K8s] Creating service for ${username}`);
      await k8sClient.createService(buildServiceSpec(username));
    }

    // 6. Create IngressRoute and Middleware
    const existingRoute = await k8sClient.getIngressRoute(`student-${username}`);
    if (!existingRoute) {
      console.log(`[K8s] Creating IngressRoute for ${username}`);
      await k8sClient.createMiddleware(buildMiddlewareSpec(username));
      await k8sClient.createIngressRoute(buildIngressRouteSpec(username));
    }

    // 7. Create Docker Traefik config (for Apache -> Docker Traefik -> K8s routing)
    await writeDockerTraefikConfig(username);

    // 8. Wait for pod to be ready (up to 60 seconds)
    console.log(`[K8s] Waiting for pod student-${username} to be ready...`);
    const readyStatus = await waitForPodReady(username, 60000);
    if (!readyStatus.ready) {
      console.warn(`[K8s] Pod student-${username} not ready after timeout: ${readyStatus.status}`);
    }

    // 9. Update SSH piper config with keys (for SSH access through sshpiper)
    const pod = await k8sClient.getPod(`student-${username}`);
    if (pod?.status?.podIP) {
      await updateSshPiperConfig(username, pod.status.podIP);
    }

    return {
      success: true,
      name: `student-${username}`,
      password: existingSecret ? null : password, // Only return password on first creation
      ready: readyStatus.ready,
      status: readyStatus.status,
      urls: {
        vscode: `/students/${username}/vscode/`,
        jupyter: `/students/${username}/jupyter/`,
        jenkins: `/students/${username}/jenkins/`
      }
    };
  } catch (err) {
    console.error(`[K8s] Error creating container for ${username}:`, err.message);
    throw err;
  }
}

/**
 * Get container status
 */
async function getContainerStatus(username) {
  const pod = await k8sClient.getPod(`student-${username}`);
  if (!pod) {
    return { exists: false, status: 'not_found' };
  }

  const phase = pod.status?.phase || 'Unknown';
  const containerStatus = pod.status?.containerStatuses?.[0];

  return {
    exists: true,
    status: phase.toLowerCase(),
    running: phase === 'Running' && containerStatus?.ready,
    ready: containerStatus?.ready || false,
    restartCount: containerStatus?.restartCount || 0,
    startedAt: containerStatus?.state?.running?.startedAt,
    node: pod.spec?.nodeName,
    ip: pod.status?.podIP
  };
}

/**
 * Start a container - recreate pod if stopped (PVC preserved)
 * @param {string} username - The student username
 * @param {string} email - The student email
 * @param {object} containerConfig - Optional container config from database (for correct node/resources after migration)
 */
async function startContainer(username, email = '', containerConfig = null) {
  // Check if pod already exists and running
  const status = await getContainerStatus(username);
  if (status.exists && status.running) {
    return { success: true, message: 'Container already running' };
  }

  // Check if PVC exists (means container was initialized before)
  const pvc = await k8sClient.getPVC(`hydra-vol-${username}`);
  if (!pvc) {
    throw new Error(`Container for ${username} not initialized. Use init first.`);
  }

  // Get config - prioritize passed containerConfig (from database), then PVC annotations, then defaults
  // This is important after migration when the database has the updated node but PVC annotations may be stale
  const ownerEmail = email || pvc.metadata?.annotations?.['hydra.owner-email'] || `${username}@newpaltz.edu`;

  // Build config with proper priority: containerConfig (database) > PVC annotations > defaults
  const config = {
    preset: containerConfig?.preset_tier || pvc.metadata?.annotations?.['hydra.preset'] || resourceConfig.defaults.preset,
    target_node: containerConfig?.current_node || pvc.metadata?.annotations?.['hydra.target-node'] || 'hydra',
    storage_gb: containerConfig?.storage_gb || parseInt(pvc.spec?.resources?.requests?.storage) || resourceConfig.defaults.storage_gb,
    memory_gb: containerConfig?.memory_gb || resourceConfig.defaults.memory_gb,
    memory_mb: containerConfig?.memory_gb ? containerConfig.memory_gb * 1024 : (resourceConfig.defaults.memory_mb || resourceConfig.defaults.memory_gb * 1024),
    cpus: containerConfig?.cpus || resourceConfig.defaults.cpus,
    gpu_count: containerConfig?.gpu_count || 0
  };

  console.log(`[K8s] Starting container for ${username} with config:`, {
    target_node: config.target_node,
    memory_mb: config.memory_mb,
    cpus: config.cpus,
    gpu_count: config.gpu_count,
    preset: config.preset
  });

  try {
    // Check if pod exists - delete it first (handle "being deleted" state)
    const podName = `student-${username}`;
    let existingPod = await k8sClient.getPod(podName);

    if (existingPod) {
      console.log(`[K8s] Pod ${podName} exists, deleting before restart`);

      // Force delete with grace period 0 to avoid stuck "Terminating" pods
      try {
        await k8sClient.deletePod(podName, { gracePeriodSeconds: 0 });
      } catch (delErr) {
        // Ignore 404 - pod already deleted
        if (delErr.statusCode !== 404) {
          console.warn(`[K8s] Delete warning for ${podName}:`, delErr.message);
        }
      }

      // Wait for pod deletion to complete (up to 30 seconds)
      console.log(`[K8s] Waiting for pod ${podName} to be fully deleted...`);
      for (let i = 0; i < 60; i++) {
        const podCheck = await k8sClient.getPod(podName);
        if (!podCheck) {
          console.log(`[K8s] Pod ${podName} deleted successfully`);
          break;
        }
        // Check if pod is stuck in Terminating with deletionTimestamp
        if (podCheck.metadata?.deletionTimestamp) {
          console.log(`[K8s] Pod ${podName} is terminating, waiting...`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));

        // After 15 seconds, try force delete again
        if (i === 30) {
          console.log(`[K8s] Pod ${podName} still exists after 15s, force deleting...`);
          try {
            await k8sClient.deletePod(podName, { gracePeriodSeconds: 0 });
          } catch (e) { /* ignore */ }
        }
      }

      // Final check - if pod still exists, throw an error
      const finalCheck = await k8sClient.getPod(podName);
      if (finalCheck) {
        throw new Error(`Pod ${podName} is stuck in terminating state. Please try again in a moment.`);
      }
    }

    // Build and create pod with proper config
    const podSpec = buildPodSpec(username, ownerEmail, config);
    console.log(`[K8s] Creating pod for ${username} on node with selector:`, podSpec.spec.nodeSelector);

    await k8sClient.createPod(podSpec);

    // Ensure Service exists
    const existingService = await k8sClient.getService(`student-${username}`);
    if (!existingService) {
      console.log(`[K8s] Creating missing service for ${username}`);
      await k8sClient.createService(buildServiceSpec(username));
    }

    // Ensure IngressRoute and Middleware exist (may be missing for older containers)
    const existingRoute = await k8sClient.getIngressRoute(`student-${username}`);
    if (!existingRoute) {
      console.log(`[K8s] Creating missing IngressRoute for ${username}`);
      const customRoutes = await getCustomRoutes(username).catch(() => []);
      await k8sClient.createMiddleware(buildMiddlewareSpec(username, customRoutes)).catch(() => {});
      await k8sClient.createIngressRoute(buildIngressRouteSpec(username, customRoutes));
    }

    // Ensure Docker Traefik config exists for routing
    await writeDockerTraefikConfig(username);

    // Wait for pod to be ready (up to 60 seconds)
    console.log(`[K8s] Waiting for pod student-${username} to be ready...`);
    const readyStatus = await waitForPodReady(username, 60000);
    if (!readyStatus.ready) {
      console.warn(`[K8s] Pod student-${username} not ready after timeout: ${readyStatus.status}`);
    }

    // Update SSH piper config with pod IP (for SSH access through sshpiper)
    const pod = await k8sClient.getPod(`student-${username}`);
    if (pod?.status?.podIP) {
      await updateSshPiperConfig(username, pod.status.podIP);
    }

    // Reset sleep state when manually started (user clicked Start on dashboard)
    try {
      const { updateContainerConfig } = require('./db-init');
      await updateContainerConfig(username, {
        sleep_state: 'awake',
        last_active_at: new Date().toISOString()
      });
    } catch (e) {
      // Non-fatal — sleep state reset is best-effort
      console.warn(`[K8s] Failed to reset sleep state for ${username}:`, e.message);
    }

    return {
      success: true,
      message: 'Container started',
      ready: readyStatus.ready,
      status: readyStatus.status
    };
  } catch (err) {
    console.error(`[K8s] Error starting container for ${username}:`, err.message);
    // Add more context to the error
    if (err.body?.message) {
      console.error(`[K8s] K8s API error details:`, err.body.message);
    }
    throw err;
  }
}

/**
 * Stop a container - delete pod but preserve PVC data
 */
async function stopContainer(username) {
  const status = await getContainerStatus(username);
  if (!status.exists) {
    return { success: true, message: 'Container already stopped' };
  }

  try {
    // Delete pod - PVC and data are preserved
    console.log(`[K8s] Stopping container for ${username} (deleting pod, keeping PVC)`);
    await k8sClient.deletePod(`student-${username}`);

    return { success: true, message: 'Container stopped (data preserved in volume)' };
  } catch (err) {
    if (err.statusCode === 404) {
      return { success: true, message: 'Container already stopped' };
    }
    console.error(`[K8s] Error stopping container for ${username}:`, err.message);
    throw err;
  }
}

/**
 * Destroy a container and all associated resources
 */
async function destroyContainer(username) {
  const results = {
    pod: false,
    service: false,
    ingressRoute: false,
    middleware: false,
    traefikConfig: false,
    sshPiperConfig: false
  };

  try {
    results.ingressRoute = await k8sClient.deleteIngressRoute(`student-${username}`);
    results.middleware = await k8sClient.deleteMiddleware(`strip-prefix-${username}`);
    results.service = await k8sClient.deleteService(`student-${username}`);
    results.pod = await k8sClient.deletePod(`student-${username}`);
    results.traefikConfig = await deleteDockerTraefikConfig(username);
    results.sshPiperConfig = await deleteSshPiperConfig(username);

    console.log(`[K8s] Destroyed container resources for ${username}:`, results);
    return { success: true, results };
  } catch (err) {
    console.error(`[K8s] Error destroying container for ${username}:`, err.message);
    throw err;
  }
}

/**
 * Wipe container data (delete PVC)
 */
async function wipeContainer(username) {
  try {
    // First destroy the container
    await destroyContainer(username);

    // Wait for pod to be fully deleted (up to 30 seconds)
    const podName = `student-${username}`;
    for (let i = 0; i < 30; i++) {
      const pod = await k8sClient.getPod(podName);
      if (!pod) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Then delete the PVC
    await k8sClient.deletePVC(`hydra-vol-${username}`);

    // Wait for PVC to be deleted
    const pvcName = `hydra-vol-${username}`;
    for (let i = 0; i < 30; i++) {
      const pvc = await k8sClient.getPVC(pvcName);
      if (!pvc) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Delete the credentials secret
    await k8sClient.deleteSecret(`student-${username}-creds`);

    console.log(`[K8s] Wiped all data for ${username}`);
    return { success: true };
  } catch (err) {
    console.error(`[K8s] Error wiping container for ${username}:`, err.message);
    throw err;
  }
}

/**
 * Get container logs
 */
async function getContainerLogs(username, tailLines = 100) {
  try {
    return await k8sClient.getPodLogs(`student-${username}`, undefined, undefined, tailLines);
  } catch (err) {
    if (err.statusCode === 404) {
      return 'Container not found';
    }
    throw err;
  }
}

/**
 * Get all student containers
 */
async function listContainers() {
  const pods = await k8sClient.listPods('app.kubernetes.io/name=student-container');
  return pods.map(pod => ({
    name: pod.metadata.name,
    username: pod.metadata.labels['hydra.owner'],
    status: pod.status?.phase?.toLowerCase(),
    node: pod.spec?.nodeName,
    createdAt: pod.metadata.creationTimestamp
  }));
}

/**
 * Get all routes for a student (default + custom)
 */
async function getRoutes(username) {
  const defaultRoutes = [
    { endpoint: 'vscode', port: 8443, default: true, public: false },
    { endpoint: 'jupyter', port: 8888, default: true, public: false },
    { endpoint: 'jenkins', port: 8080, default: true, public: false }
  ];

  let customRoutes = [];
  try {
    customRoutes = await getCustomRoutes(username);
  } catch (e) {
    // IngressRoute may not exist yet
  }

  return [
    ...defaultRoutes,
    ...customRoutes.map(r => ({ endpoint: r.endpoint, port: r.port, default: false }))
  ];
}

/**
 * Add a custom route for a student
 * Updates IngressRoute, Middleware, Service, and Docker Traefik config
 */
async function addRoute(username, endpoint, port, isPublic = true) {
  const namespace = runtimeConfig.k8s.namespace;

  // 1. Get current custom routes and check for duplicates
  const customRoutes = await getCustomRoutes(username);
  if (customRoutes.some(r => r.endpoint === endpoint)) {
    throw new Error(`Endpoint '${endpoint}' already exists`);
  }
  if (customRoutes.some(r => r.port === port)) {
    throw new Error(`Port ${port} already in use`);
  }
  customRoutes.push({ endpoint, port, public: isPublic });

  // 2. Patch Service to add the new port (strategic merge adds by port key)
  await k8sClient.patchService(`student-${username}`, namespace, {
    spec: {
      ports: [
        { name: `custom-${endpoint}`, port: port, targetPort: port, protocol: 'TCP' }
      ]
    }
  });

  // 3. Replace Middleware with updated strip-prefix paths
  await k8sClient.replaceMiddleware(
    `strip-prefix-${username}`,
    namespace,
    buildMiddlewareSpec(username, customRoutes)
  );

  // 4. Replace IngressRoute with new route added
  await k8sClient.replaceIngressRoute(
    `student-${username}`,
    namespace,
    buildIngressRouteSpec(username, customRoutes)
  );

  // 5. Update Docker Traefik config
  await writeDockerTraefikConfig(username, customRoutes);

  console.log(`[K8s] Added route for ${username}: ${endpoint} -> port ${port} (public: ${isPublic})`);
  return { endpoint, port, public: isPublic };
}

/**
 * Update a custom route's public/SSO setting
 */
async function updateRoute(username, endpoint, isPublic) {
  const namespace = runtimeConfig.k8s.namespace;

  const customRoutes = await getCustomRoutes(username);
  const route = customRoutes.find(r => r.endpoint === endpoint);
  if (!route) {
    throw new Error(`Route '${endpoint}' not found`);
  }
  route.public = isPublic;

  // Replace IngressRoute with updated auth settings
  await k8sClient.replaceIngressRoute(
    `student-${username}`,
    namespace,
    buildIngressRouteSpec(username, customRoutes)
  );

  // Update Docker Traefik config
  await writeDockerTraefikConfig(username, customRoutes);

  console.log(`[K8s] Updated route ${endpoint} for ${username}: public=${isPublic}`);
  return { endpoint, port: route.port, public: isPublic };
}

/**
 * Remove a custom route for a student
 */
async function removeRoute(username, endpoint) {
  const namespace = runtimeConfig.k8s.namespace;

  // 1. Get current custom routes and find the one to remove
  const customRoutes = await getCustomRoutes(username);
  const index = customRoutes.findIndex(r => r.endpoint === endpoint);
  if (index === -1) {
    throw new Error(`Route '${endpoint}' not found`);
  }
  const removed = customRoutes[index];
  customRoutes.splice(index, 1);

  // 2. Replace Middleware with updated strip-prefix paths
  await k8sClient.replaceMiddleware(
    `strip-prefix-${username}`,
    namespace,
    buildMiddlewareSpec(username, customRoutes)
  );

  // 3. Replace IngressRoute with route removed
  await k8sClient.replaceIngressRoute(
    `student-${username}`,
    namespace,
    buildIngressRouteSpec(username, customRoutes)
  );

  // 4. Remove port from Service (read-modify-write)
  try {
    const svc = await k8sClient.getService(`student-${username}`, namespace);
    if (svc) {
      const updatedPorts = svc.spec.ports.filter(p => p.name !== `custom-${endpoint}`);
      if (updatedPorts.length !== svc.spec.ports.length) {
        // Use strategic merge with all desired ports — rebuild from scratch
        await k8sClient.patchService(`student-${username}`, namespace, {
          spec: { ports: updatedPorts }
        });
      }
    }
  } catch (e) {
    console.warn(`[K8s] Failed to remove port from service for ${username}:`, e.message);
  }

  // 5. Update Docker Traefik config
  await writeDockerTraefikConfig(username, customRoutes);

  console.log(`[K8s] Removed route for ${username}: ${endpoint}`);
  return { endpoint, port: removed.port };
}

/**
 * Migrate container to a different node (for GPU access)
 * Deletes current pod/PVC and recreates on target node with NFS storage
 */
async function migrateContainer(username, email, targetNode, config = {}) {
  const podName = `student-${username}`;
  const pvcName = `hydra-vol-${username}`;

  console.log(`[k8s-containers] Migrating ${username} to ${targetNode}`);

  // Step 1: Delete current pod if it exists
  try {
    const existingPod = await k8sClient.getPod(podName);
    if (existingPod) {
      console.log(`[k8s-containers] Deleting existing pod on current node`);
      await k8sClient.deletePod(podName);

      // Wait for pod to be fully deleted
      for (let i = 0; i < 30; i++) {
        const pod = await k8sClient.getPod(podName);
        if (!pod) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (err) {
    if (err.statusCode !== 404) {
      console.error(`[k8s-containers] Error deleting pod:`, err.message);
      throw err;
    }
  }

  // Step 2: Get node configuration for target node
  const nodeConfig = resourceConfig.getNodeConfig(targetNode);
  if (!nodeConfig) {
    throw new Error(`Unknown target node: ${targetNode}`);
  }

  // Step 3: If migrating to GPU node, need to recreate PVC with NFS storage
  const targetStorageClass = nodeConfig.k8s?.storageClass || 'hydra-local';
  const currentPVC = await k8sClient.getPVC(pvcName);

  if (currentPVC && targetStorageClass === 'hydra-nfs' &&
      currentPVC.spec.storageClassName !== 'hydra-nfs') {
    console.log(`[k8s-containers] Migrating PVC from ${currentPVC.spec.storageClassName} to ${targetStorageClass}`);

    // Delete old PVC (data will be lost - TODO: implement data migration via NFS staging)
    console.log(`[k8s-containers] Deleting old PVC with local storage`);
    await k8sClient.deletePVC(pvcName);

    // Wait for PVC to be fully deleted
    for (let i = 0; i < 30; i++) {
      const pvc = await k8sClient.getPVC(pvcName);
      if (!pvc) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Create new PVC with NFS storage
    const storageGb = config.storage_gb || 100;  // Default 100GB for GPU workloads
    const pvcSpec = buildPVCSpec(username, storageGb, targetStorageClass, {
      email,
      preset: config.preset || 'gpu_training',
      target_node: targetNode
    });

    console.log(`[k8s-containers] Creating new PVC with NFS storage (${storageGb}GB)`);
    await k8sClient.createPVC(pvcSpec);

    // Wait for PVC to be bound
    for (let i = 0; i < 30; i++) {
      const pvc = await k8sClient.getPVC(pvcName);
      if (pvc && pvc.status.phase === 'Bound') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Step 4: Build new pod spec with target node's nodeSelector
  const newConfig = {
    ...config,
    target_node: targetNode,
    preset: config.preset || 'gpu_training',
    memory_mb: config.memory_mb || (config.memory_gb ? config.memory_gb * 1024 : 8192),
    cpus: config.cpus || 4,
    gpu_count: config.gpu_count || nodeConfig.gpuCount || 1
  };

  // Build pod spec
  const podSpec = buildPodSpec(username, email, newConfig);

  // Step 5: Create the new pod on target node
  console.log(`[k8s-containers] Creating pod on ${targetNode} with ${newConfig.gpu_count} GPUs`);
  await k8sClient.createPod(podSpec);

  // Step 6: Wait for pod to be ready
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const pod = await k8sClient.getPod(podName);
    if (pod && pod.status.phase === 'Running') {
      const containerStatus = pod.status.containerStatuses?.[0];
      if (containerStatus?.ready) {
        ready = true;
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (!ready) {
    console.warn(`[k8s-containers] Pod not ready after migration, but continuing`);
  }

  // Step 7: Update Docker Traefik and SSH piper configs after migration
  await writeDockerTraefikConfig(username);
  const finalPod = await k8sClient.getPod(podName);
  if (finalPod?.status?.podIP) {
    await updateSshPiperConfig(username, finalPod.status.podIP);
  }

  return {
    success: true,
    message: `Migrated to ${targetNode}`,
    target_node: targetNode,
    gpu_count: newConfig.gpu_count,
    node_label: nodeConfig.label
  };
}

/**
 * Get actual service status from supervisor via HTTP
 * Queries the supervisor XML-RPC API to get real process state
 * @param {string} username - The student username
 * @returns {Promise<{services: Array, containerRunning: boolean}>}
 */
async function getServiceStatus(username) {
  const status = await getContainerStatus(username);

  if (!status.exists || !status.running || !status.ip) {
    return {
      services: [],
      containerRunning: status.running || false,
      error: !status.exists ? 'Container not found' : (!status.running ? 'Container not running' : 'No pod IP')
    };
  }

  const podIP = status.ip;
  const http = require('http');

  // Query supervisor XML-RPC API for process status
  const supervisorRequest = (method) => {
    return new Promise((resolve, reject) => {
      const xmlBody = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName></methodCall>`;

      const req = http.request({
        hostname: podIP,
        port: 9001,
        path: '/RPC2',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'Content-Length': Buffer.byteLength(xmlBody)
        },
        timeout: 3000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(xmlBody);
      req.end();
    });
  };

  // Quick HTTP probe to check if a service port is actually responding
  const probePort = (port) => {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: podIP,
        port,
        path: '/',
        method: 'HEAD',
        timeout: 1500
      }, () => resolve(true));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  };

  const servicePorts = { 'code-server': 8443, 'jupyter': 8888, 'jenkins': 8080 };

  try {
    const xmlResponse = await supervisorRequest('supervisor.getAllProcessInfo');

    // Parse XML response to extract process status
    // Each process is in a <struct>...</struct> block with name and statename members
    // The XML has newlines between tags, so we split by struct blocks first
    const services = [];
    const knownServices = ['code-server', 'jupyter', 'jenkins'];

    // Split response into per-process struct blocks
    const structBlocks = xmlResponse.split('<value><struct>').slice(1);

    for (const block of structBlocks) {
      // Extract the process name from this block
      const nameMatch = block.match(/<name>name<\/name>\s*<value><string>([^<]+)<\/string>/);
      const stateMatch = block.match(/<name>statename<\/name>\s*<value><string>([^<]+)<\/string>/);

      if (nameMatch && stateMatch && knownServices.includes(nameMatch[1])) {
        services.push({
          name: nameMatch[1],
          supervisorState: stateMatch[1],
          running: stateMatch[1] === 'RUNNING',
          state: stateMatch[1]
        });
      }
    }

    // For services supervisor says are RUNNING, verify HTTP is actually responding
    const probePromises = services.map(async (svc) => {
      if (svc.running && servicePorts[svc.name]) {
        const ready = await probePort(servicePorts[svc.name]);
        if (!ready) {
          svc.running = false;
          svc.state = 'STARTING';
        }
      }
    });
    await Promise.all(probePromises);

    return {
      services,
      containerRunning: true
    };
  } catch (err) {
    console.error(`[K8s] Failed to query supervisor for ${username}:`, err.message);
    // Return unknown status on error rather than assuming running
    return {
      services: [
        { name: 'code-server', running: false, state: 'UNKNOWN' },
        { name: 'jupyter', running: false, state: 'UNKNOWN' },
        { name: 'jenkins', running: false, state: 'UNKNOWN' }
      ],
      containerRunning: true,
      error: err.message
    };
  }
}

/**
 * Control a supervisor process (start/stop) via XML-RPC
 * @param {string} username - The student username
 * @param {string} processName - e.g. 'code-server' or 'jupyter'
 * @param {string} action - 'start' or 'stop'
 */
async function controlService(username, processName, action) {
  const status = await getContainerStatus(username);

  if (!status.exists || !status.running || !status.ip) {
    throw new Error('Container not running');
  }

  const http = require('http');
  const method = action === 'start' ? 'supervisor.startProcess' : 'supervisor.stopProcess';
  const xmlBody = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params><param><value><string>${processName}</string></value></param></params></methodCall>`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: status.ip,
      port: 9001,
      path: '/RPC2',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(xmlBody)
      },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (data.includes('<fault>')) {
          const faultMatch = data.match(/<string>([^<]+)<\/string>/);
          const errMsg = faultMatch ? faultMatch[1] : 'Supervisor error';
          // ALREADY_STARTED / NOT_RUNNING are not real errors
          if (errMsg.includes('ALREADY_STARTED') || errMsg.includes('NOT_RUNNING')) {
            resolve({ success: true, alreadyInState: true });
          } else {
            reject(new Error(errMsg));
          }
        } else {
          resolve({ success: true });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(xmlBody);
    req.end();
  });
}

module.exports = {
  initContainer,
  getContainerStatus,
  getServiceStatus,
  controlService,
  startContainer,
  stopContainer,
  destroyContainer,
  wipeContainer,
  migrateContainer,
  getContainerLogs,
  listContainers,
  getRoutes,
  addRoute,
  updateRoute,
  removeRoute,
  generateSSHKeys,
  updateSshPiperConfig,
  // Expose for testing
  buildPodSpec,
  buildPVCSpec,
  buildServiceSpec
};
