// services/k8s-containers.js - Kubernetes-based container management
// Replaces Docker API calls with Kubernetes API calls

const k8sClient = require('./k8s-client');
const runtimeConfig = require('../config/runtime');
const resourceConfig = require('../config/resources');
const crypto = require('crypto');

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
      serviceAccountName: 'student-workload',
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
          match: `PathPrefix(\`/students/${username}/vscode\`)`,
          kind: 'Rule',
          services: [{ name: `student-${username}`, port: 8443 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
            { name: `strip-prefix-${username}` }
          ]
        },
        {
          match: `PathPrefix(\`/students/${username}/jupyter\`)`,
          kind: 'Rule',
          services: [{ name: `student-${username}`, port: 8888 }],
          middlewares: [
            { name: 'hydra-forward-auth', namespace: runtimeConfig.k8s.systemNamespace },
            { name: `strip-prefix-${username}` }
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

    return {
      success: true,
      name: `student-${username}`,
      password: existingSecret ? null : password, // Only return password on first creation
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
    // Check if pod exists but not running - delete it first
    if (status.exists) {
      console.log(`[K8s] Deleting existing pod for ${username} before restart`);
      await k8sClient.deletePod(`student-${username}`);
      // Wait for pod deletion to complete
      for (let i = 0; i < 10; i++) {
        const podCheck = await k8sClient.getPod(`student-${username}`);
        if (!podCheck) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Build and create pod with proper config
    const podSpec = buildPodSpec(username, ownerEmail, config);
    console.log(`[K8s] Creating pod for ${username} on node with selector:`, podSpec.spec.nodeSelector);

    await k8sClient.createPod(podSpec);

    return { success: true, message: 'Container started (pod recreated)' };
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
    middleware: false
  };

  try {
    results.ingressRoute = await k8sClient.deleteIngressRoute(`student-${username}`);
    results.middleware = await k8sClient.deleteMiddleware(`strip-prefix-${username}`);
    results.service = await k8sClient.deleteService(`student-${username}`);
    results.pod = await k8sClient.deletePod(`student-${username}`);

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
  const namespace = runtimeConfig.k8s.namespace;

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

  return {
    success: true,
    message: `Migrated to ${targetNode}`,
    target_node: targetNode,
    gpu_count: newConfig.gpu_count,
    node_label: nodeConfig.label
  };
}

module.exports = {
  initContainer,
  getContainerStatus,
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
