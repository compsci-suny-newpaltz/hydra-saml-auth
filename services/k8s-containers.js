// services/k8s-containers.js - Kubernetes-based container management
// Replaces Docker API calls with Kubernetes API calls

const k8sClient = require('./k8s-client');
const runtimeConfig = require('../config/runtime');
const resourceConfig = require('../config/resources');
const crypto = require('crypto');
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
      serviceAccountName: 'student-workload',
      automountServiceAccountToken: false,
      // Security context - allow container to run entrypoint as root then drop to user 1000
      securityContext: {
        fsGroup: 1000,
        seccompProfile: {
          type: 'RuntimeDefault'
        }
      },
      // Node selection
      nodeSelector: nodeConfig?.k8s?.nodeSelector || { 'hydra.node-role': 'control-plane' },
      // GPU tolerations
      tolerations: nodeConfig?.k8s?.tolerations || [],
      containers: [{
        name: 'student',
        image: gpuCount > 0 ? runtimeConfig.k8s.gpuStudentImage : runtimeConfig.k8s.studentImage,
        // Use IfNotPresent - images must be imported to RKE2's containerd correctly
        imagePullPolicy: 'IfNotPresent',
        env: [
          { name: 'USERNAME', value: username },
          { name: 'USER_EMAIL', value: email },
          { name: 'HOME', value: '/home/student' },
          {
            name: 'PASSWORD',
            valueFrom: {
              secretKeyRef: {
                name: `student-${username}-creds`,
                key: 'password'
              }
            }
          }
        ],
        ports: [
          { name: 'vscode', containerPort: 8443, protocol: 'TCP' },
          { name: 'jupyter', containerPort: 8888, protocol: 'TCP' },
          { name: 'supervisor', containerPort: 9001, protocol: 'TCP' }
        ],
        resources: {
          requests: {
            memory: `${Math.round(memoryMb * 0.5)}Mi`,
            cpu: `${Math.round(cpus * 500)}m`
          },
          limits: {
            memory: `${memoryMb}Mi`,
            cpu: `${cpus}`
          }
        },
        volumeMounts: [
          { name: 'home', mountPath: '/home/student' }
        ],
        // Container runs as root initially, then drops to user 1000 via entrypoint
        securityContext: {
          readOnlyRootFilesystem: false
        },
        // Disable password auth on startup for security
        lifecycle: {
          postStart: {
            exec: {
              command: ['/bin/sh', '-c', 'sed -i "s/^PasswordAuthentication yes/PasswordAuthentication no/" /etc/ssh/sshd_config && sed -i "s/^#*AllowUsers/#AllowUsers/" /etc/ssh/sshd_config || true']
            }
          }
        }
      }],
      volumes: [
        {
          name: 'home',
          persistentVolumeClaim: {
            claimName: `hydra-vol-${username}`
          }
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
        { name: 'vscode', port: 8443, targetPort: 'vscode' },
        { name: 'jupyter', port: 8888, targetPort: 'jupyter' },
        { name: 'supervisor', port: 9001, targetPort: 'supervisor' }
      ],
      selector: {
        'app.kubernetes.io/name': 'student-container',
        'app.kubernetes.io/instance': username
      }
    }
  };
}

// Build Secret specification for credentials
function buildSecretSpec(username, password) {
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
    stringData: {
      password: password
    }
  };
}

// Build IngressRoute specification
function buildIngressRouteSpec(username) {
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
          services: [{ name: `student-${username}`, port: 8443 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
            { name: `strip-prefix-${username}` }
          ]
        },
        {
          match: `Host(\`hydra.newpaltz.edu\`) && PathPrefix(\`/students/${username}/jupyter\`)`,
          kind: 'Rule',
          services: [{ name: `student-${username}`, port: 8888 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace }
            // No strip-prefix: Jupyter is configured with base_url and handles the prefix itself
          ]
        }
      ]
    }
  };
}

// Build Middleware specification for strip-prefix
function buildMiddlewareSpec(username) {
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
          `/students/${username}/supervisor`
        ]
      }
    }
  };
}

// ==================== DOCKER TRAEFIK CONFIG ====================

/**
 * Write Docker Traefik config file that routes to K8s Traefik
 * This is needed because Apache proxies to Docker Traefik (8082),
 * which then needs to forward K8s student routes to K8s Traefik (30080)
 * Note: This is only needed in hybrid Docker+K8s setups; skipped in pure K8s
 */
async function writeDockerTraefikConfig(username) {
  // Skip if Traefik dynamic dir doesn't exist (pure K8s mode without Docker Traefik)
  try {
    await fs.access(TRAEFIK_DYNAMIC_DIR);
  } catch {
    // Directory doesn't exist - we're in pure K8s mode, skip Docker Traefik config
    return;
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
        }
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

// ==================== SSH PIPER CONFIG ====================

const SSHPIPER_CONFIG_DIR = runtimeConfig.sshpiper?.configPath || '/app/sshpiper/config';

/**
 * Update SSH piper config to point to K8s pod IP
 * This is needed because sshpiper runs in Docker and can't resolve K8s service names
 */
async function updateSshPiperConfig(username, podIP) {
  const userDir = path.join(SSHPIPER_CONFIG_DIR, username);
  const upstreamFile = path.join(userDir, 'sshpiper_upstream');

  try {
    // Ensure directory exists
    await fs.mkdir(userDir, { recursive: true });

    // Write upstream config pointing to pod IP
    await fs.writeFile(upstreamFile, `${podIP}:22\n`, 'utf8');
    console.log(`[K8s] Updated SSH piper config for ${username}: ${podIP}:22`);
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
  const storageClass = nodeConfig?.k8s?.storageClass || runtimeConfig.k8s.defaultStorageClass;

  // Merge config with email for PVC storage
  const fullConfig = { ...config, email };

  try {
    // 1. Create PVC if not exists
    const existingPVC = await k8sClient.getPVC(`hydra-vol-${username}`);
    if (!existingPVC) {
      console.log(`[K8s] Creating PVC for ${username} (${storageGb}GB)`);
      await k8sClient.createPVC(buildPVCSpec(username, storageGb, storageClass, fullConfig));
    }

    // 2. Create credentials secret
    const existingSecret = await k8sClient.getSecret(`student-${username}-creds`);
    if (!existingSecret) {
      console.log(`[K8s] Creating credentials secret for ${username}`);
      await k8sClient.createSecret(buildSecretSpec(username, password));
    }

    // 3. Create pod
    console.log(`[K8s] Creating pod for ${username}`);
    await k8sClient.createPod(buildPodSpec(username, email, config));

    // 4. Create service
    const existingService = await k8sClient.getService(`student-${username}`);
    if (!existingService) {
      console.log(`[K8s] Creating service for ${username}`);
      await k8sClient.createService(buildServiceSpec(username));
    }

    // 5. Create IngressRoute and Middleware
    const existingRoute = await k8sClient.getIngressRoute(`student-${username}`);
    if (!existingRoute) {
      console.log(`[K8s] Creating IngressRoute for ${username}`);
      await k8sClient.createMiddleware(buildMiddlewareSpec(username));
      await k8sClient.createIngressRoute(buildIngressRouteSpec(username));
    }

    // 6. Create Docker Traefik config (for Apache -> Docker Traefik -> K8s routing)
    await writeDockerTraefikConfig(username);

    // 7. Wait for pod to be ready (up to 60 seconds)
    console.log(`[K8s] Waiting for pod student-${username} to be ready...`);
    const readyStatus = await waitForPodReady(username, 60000);
    if (!readyStatus.ready) {
      console.warn(`[K8s] Pod student-${username} not ready after timeout: ${readyStatus.status}`);
    }

    // 8. Update SSH piper config with pod IP (for SSH access through sshpiper)
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
        jupyter: `/students/${username}/jupyter/`
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
 * Get routes for a student
 */
function getRoutes(username) {
  return {
    vscode: `/students/${username}/vscode/`,
    jupyter: `/students/${username}/jupyter/`,
    supervisor: `/students/${username}/supervisor/`
  };
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

  try {
    const xmlResponse = await supervisorRequest('supervisor.getAllProcessInfo');

    // Parse XML response to extract process status
    // Response format: <array><data><value><struct>...name, state, statename...</struct></value>...</data></array>
    const services = [];

    // Simple regex parsing for the XML response
    const processRegex = /<member><name>name<\/name><value><string>([^<]+)<\/string><\/value><\/member>.*?<member><name>statename<\/name><value><string>([^<]+)<\/string><\/value><\/member>/gs;
    let match;

    while ((match = processRegex.exec(xmlResponse)) !== null) {
      const [, name, statename] = match;
      if (name === 'code-server' || name === 'jupyter') {
        services.push({
          name,
          running: statename === 'RUNNING',
          state: statename
        });
      }
    }

    // If we didn't parse any services, try a simpler pattern
    if (services.length === 0) {
      // Fallback: check if code-server and jupyter are mentioned with RUNNING
      const hasCodeServer = xmlResponse.includes('code-server') && xmlResponse.includes('RUNNING');
      const hasJupyter = xmlResponse.includes('jupyter') && xmlResponse.includes('RUNNING');

      // Check for STOPPED state
      const codeServerStopped = xmlResponse.includes('code-server') && xmlResponse.includes('STOPPED');
      const jupyterStopped = xmlResponse.includes('jupyter') && xmlResponse.includes('STOPPED');

      if (xmlResponse.includes('code-server')) {
        services.push({
          name: 'code-server',
          running: hasCodeServer && !codeServerStopped,
          state: codeServerStopped ? 'STOPPED' : (hasCodeServer ? 'RUNNING' : 'UNKNOWN')
        });
      }
      if (xmlResponse.includes('jupyter')) {
        services.push({
          name: 'jupyter',
          running: hasJupyter && !jupyterStopped,
          state: jupyterStopped ? 'STOPPED' : (hasJupyter ? 'RUNNING' : 'UNKNOWN')
        });
      }
    }

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
        { name: 'jupyter', running: false, state: 'UNKNOWN' }
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
  // Expose for testing
  buildPodSpec,
  buildPVCSpec,
  buildServiceSpec
};
