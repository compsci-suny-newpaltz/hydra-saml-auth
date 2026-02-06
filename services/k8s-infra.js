// services/k8s-infra.js - Infrastructure service management for Hydra
// Manages deployments in the hydra-infra namespace

const k8sClient = require('./k8s-client');
const runtimeConfig = require('../config/runtime');
const yaml = require('js-yaml');

const INFRA_NS = runtimeConfig.k8s?.infraNamespace || 'hydra-infra';
const MANAGED_LABEL = 'app.kubernetes.io/managed-by=hydra-infra';
const STORAGE_CLASS = 'hydra-local';

// ==================== LIST / GET ====================

async function listInfraServices() {
  const deployments = await k8sClient.listDeployments(undefined, INFRA_NS);
  const pods = await k8sClient.listPods(undefined, INFRA_NS);

  return deployments.map(dep => {
    const depPods = pods.filter(p =>
      p.metadata?.labels?.app === dep.metadata?.labels?.app
    );
    const container = dep.spec?.template?.spec?.containers?.[0] || {};
    const resources = container.resources || {};

    return {
      name: dep.metadata.name,
      image: container.image || 'unknown',
      replicas: dep.spec?.replicas || 0,
      readyReplicas: dep.status?.readyReplicas || 0,
      availableReplicas: dep.status?.availableReplicas || 0,
      status: getDeploymentStatus(dep),
      pods: depPods.map(p => ({
        name: p.metadata.name,
        status: p.status?.phase,
        ready: p.status?.containerStatuses?.every(c => c.ready) || false,
        restarts: p.status?.containerStatuses?.reduce((sum, c) => sum + (c.restartCount || 0), 0) || 0,
        node: p.spec?.nodeName
      })),
      resources: {
        cpuRequest: resources.requests?.cpu || 'none',
        cpuLimit: resources.limits?.cpu || 'none',
        memRequest: resources.requests?.memory || 'none',
        memLimit: resources.limits?.memory || 'none',
        gpu: resources.limits?.['nvidia.com/gpu'] || '0'
      },
      ports: extractPorts(dep),
      createdAt: dep.metadata.creationTimestamp,
      labels: dep.metadata.labels || {}
    };
  });
}

async function getServiceDetail(name) {
  const deployment = await k8sClient.getDeployment(name, INFRA_NS);
  if (!deployment) return null;

  const appLabel = deployment.metadata?.labels?.app || name;
  const pods = await k8sClient.listPods(`app=${appLabel}`, INFRA_NS);
  const services = await k8sClient.listServices(`app=${appLabel}`, INFRA_NS);
  const pvcs = await k8sClient.listPVCs(undefined, INFRA_NS);

  return { deployment, pods, services, pvcs };
}

// ==================== LIFECYCLE ====================

async function scaleService(name, replicas) {
  const patch = { spec: { replicas } };
  return await k8sClient.patchDeployment(name, INFRA_NS, patch);
}

async function restartService(name) {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
          }
        }
      }
    }
  };
  return await k8sClient.patchDeployment(name, INFRA_NS, patch);
}

async function getServiceLogs(name, tailLines = 200) {
  const deployment = await k8sClient.getDeployment(name, INFRA_NS);
  if (!deployment) throw new Error(`Service ${name} not found`);

  const appLabel = deployment.metadata?.labels?.app || name;
  const pods = await k8sClient.listPods(`app=${appLabel}`, INFRA_NS);
  if (!pods.length) throw new Error(`No pods found for ${name}`);

  const podName = pods[0].metadata.name;
  return await k8sClient.getPodLogs(podName, INFRA_NS, undefined, tailLines);
}

async function deleteService(name, deletePVC = false) {
  const results = { deployment: false, service: false, pvcs: [] };

  results.deployment = await k8sClient.deleteDeployment(name, INFRA_NS);
  results.service = await k8sClient.deleteService(name, INFRA_NS);

  if (deletePVC) {
    const pvcs = await k8sClient.listPVCs(undefined, INFRA_NS);
    for (const pvc of pvcs) {
      if (pvc.metadata.name.includes(name)) {
        await k8sClient.deletePVC(pvc.metadata.name, INFRA_NS);
        results.pvcs.push(pvc.metadata.name);
      }
    }
  }

  return results;
}

// ==================== DEPLOY FROM COMPOSE ====================

async function deployFromCompose(composeYaml, serviceName, createdBy) {
  const manifests = composeToK8s(composeYaml, serviceName, createdBy);
  const results = [];

  // Apply PVCs first
  for (const pvc of manifests.pvcs) {
    try {
      await k8sClient.createPVC(pvc);
      results.push({ kind: 'PVC', name: pvc.metadata.name, status: 'created' });
    } catch (err) {
      if (err.statusCode === 409) {
        results.push({ kind: 'PVC', name: pvc.metadata.name, status: 'exists' });
      } else throw err;
    }
  }

  // Apply secrets
  for (const secret of manifests.secrets) {
    try {
      await k8sClient.createSecret(secret);
      results.push({ kind: 'Secret', name: secret.metadata.name, status: 'created' });
    } catch (err) {
      if (err.statusCode === 409) {
        results.push({ kind: 'Secret', name: secret.metadata.name, status: 'exists' });
      } else throw err;
    }
  }

  // Apply services
  for (const svc of manifests.services) {
    try {
      await k8sClient.createService(svc);
      results.push({ kind: 'Service', name: svc.metadata.name, status: 'created' });
    } catch (err) {
      if (err.statusCode === 409) {
        results.push({ kind: 'Service', name: svc.metadata.name, status: 'exists' });
      } else throw err;
    }
  }

  // Apply deployments
  for (const dep of manifests.deployments) {
    try {
      await k8sClient.createDeployment(dep);
      results.push({ kind: 'Deployment', name: dep.metadata.name, status: 'created' });
    } catch (err) {
      if (err.statusCode === 409) {
        results.push({ kind: 'Deployment', name: dep.metadata.name, status: 'exists' });
      } else throw err;
    }
  }

  return results;
}

async function deployFromManifests(manifestsYaml, createdBy) {
  const docs = yaml.loadAll(manifestsYaml).filter(Boolean);
  const results = [];

  for (const doc of docs) {
    // Force namespace to hydra-infra
    if (doc.metadata) doc.metadata.namespace = INFRA_NS;

    // Add managed-by label
    if (!doc.metadata.labels) doc.metadata.labels = {};
    doc.metadata.labels['app.kubernetes.io/managed-by'] = 'hydra-infra';
    if (createdBy) doc.metadata.labels['hydra.infra/created-by'] = createdBy;

    const kind = doc.kind;
    const name = doc.metadata.name;

    try {
      switch (kind) {
        case 'Deployment':
          await k8sClient.createDeployment(doc);
          break;
        case 'Service':
          await k8sClient.createService(doc);
          break;
        case 'PersistentVolumeClaim':
          await k8sClient.createPVC(doc);
          break;
        case 'Secret':
          await k8sClient.createSecret(doc);
          break;
        default:
          results.push({ kind, name, status: 'skipped', reason: `Unsupported kind: ${kind}` });
          continue;
      }
      results.push({ kind, name, status: 'created' });
    } catch (err) {
      if (err.statusCode === 409) {
        results.push({ kind, name, status: 'exists' });
      } else {
        results.push({ kind, name, status: 'error', error: err.message });
      }
    }
  }

  return results;
}

// ==================== COMPOSE-TO-K8S CONVERTER ====================

function composeToK8s(composeYaml, serviceName, createdBy) {
  const compose = yaml.load(composeYaml);
  if (!compose || !compose.services) {
    throw new Error('Invalid docker-compose: missing services block');
  }

  const deployments = [];
  const services = [];
  const pvcs = [];
  const secrets = [];

  const baseLabels = {
    'app.kubernetes.io/managed-by': 'hydra-infra',
    'hydra.infra/service-name': serviceName,
    'hydra.infra/created-by': createdBy || 'unknown',
    'hydra.infra/created-at': new Date().toISOString()
  };

  for (const [svcName, svcDef] of Object.entries(compose.services)) {
    if (!svcDef.image && svcDef.build) {
      throw new Error(`Service "${svcName}" uses 'build' — push image to a registry first and use 'image' instead`);
    }
    if (!svcDef.image) {
      throw new Error(`Service "${svcName}" has no image specified`);
    }

    const fullName = serviceName === svcName ? svcName : `${serviceName}-${svcName}`;
    const appLabel = { app: fullName, ...baseLabels };

    // Parse environment
    const env = [];
    if (Array.isArray(svcDef.environment)) {
      for (const e of svcDef.environment) {
        const idx = e.indexOf('=');
        if (idx > 0) {
          env.push({ name: e.substring(0, idx), value: e.substring(idx + 1) });
        }
      }
    } else if (svcDef.environment && typeof svcDef.environment === 'object') {
      for (const [k, v] of Object.entries(svcDef.environment)) {
        env.push({ name: k, value: String(v ?? '') });
      }
    }

    // Parse ports
    const containerPorts = [];
    const servicePorts = [];
    if (svcDef.ports) {
      for (const p of svcDef.ports) {
        const portStr = String(p);
        const parts = portStr.replace(/.*:/, '').split('/');
        const containerPort = parseInt(parts[0], 10);
        const hostParts = portStr.split(':');
        const hostPort = hostParts.length > 1 ? parseInt(hostParts[hostParts.length - 2], 10) : containerPort;
        if (!isNaN(containerPort)) {
          containerPorts.push({ containerPort, name: `port-${containerPort}` });
          servicePorts.push({ port: hostPort, targetPort: containerPort, name: `port-${containerPort}` });
        }
      }
    }

    // Parse volumes
    const volumeMounts = [];
    const volumes = [];
    if (svcDef.volumes) {
      for (let i = 0; i < svcDef.volumes.length; i++) {
        const vol = svcDef.volumes[i];
        const volStr = typeof vol === 'string' ? vol : vol.source ? `${vol.source}:${vol.target}` : '';
        const mountParts = volStr.split(':');
        if (mountParts.length >= 2) {
          const src = mountParts[0];
          const dst = mountParts[1];
          const volName = `vol-${i}`;

          // Named volume -> PVC
          if (!src.startsWith('/') && !src.startsWith('.')) {
            const pvcName = `${fullName}-${src}`.substring(0, 63);
            pvcs.push({
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              metadata: { name: pvcName, namespace: INFRA_NS, labels: appLabel },
              spec: {
                accessModes: ['ReadWriteOnce'],
                storageClassName: STORAGE_CLASS,
                resources: { requests: { storage: '5Gi' } }
              }
            });
            volumeMounts.push({ name: volName, mountPath: dst });
            volumes.push({ name: volName, persistentVolumeClaim: { claimName: pvcName } });
          }
          // Bind mount /data/* allowed on RAID
          else if (src.startsWith('/data')) {
            volumeMounts.push({ name: volName, mountPath: dst, readOnly: mountParts[2] === 'ro' });
            volumes.push({ name: volName, hostPath: { path: src, type: 'DirectoryOrCreate' } });
          }
          // Other bind mounts rejected for security
          else if (src.startsWith('/') || src.startsWith('.')) {
            console.warn(`[Infra] Skipping bind mount ${src}:${dst} — only /data/* allowed`);
          }
        }
      }
    }

    // Parse resources
    const resources = { requests: { memory: '128Mi', cpu: '100m' }, limits: { memory: '512Mi', cpu: '500m' } };
    if (svcDef.deploy?.resources?.limits) {
      const lim = svcDef.deploy.resources.limits;
      if (lim.memory) resources.limits.memory = lim.memory;
      if (lim.cpus) resources.limits.cpu = String(lim.cpus);
    }
    if (svcDef.deploy?.resources?.reservations) {
      const res = svcDef.deploy.resources.reservations;
      if (res.memory) resources.requests.memory = res.memory;
      if (res.cpus) resources.requests.cpu = String(res.cpus);
    }

    // Parse command
    const command = svcDef.entrypoint
      ? (Array.isArray(svcDef.entrypoint) ? svcDef.entrypoint : [svcDef.entrypoint])
      : undefined;
    const args = svcDef.command
      ? (Array.isArray(svcDef.command) ? svcDef.command : svcDef.command.split(' '))
      : undefined;

    // Build Deployment
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: fullName, namespace: INFRA_NS, labels: appLabel },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: fullName } },
        template: {
          metadata: { labels: { app: fullName, ...baseLabels } },
          spec: {
            nodeSelector: { 'kubernetes.io/hostname': 'hydra' },
            containers: [{
              name: svcName,
              image: svcDef.image,
              imagePullPolicy: 'IfNotPresent',
              ...(containerPorts.length && { ports: containerPorts }),
              ...(env.length && { env }),
              ...(volumeMounts.length && { volumeMounts }),
              ...(command && { command }),
              ...(args && { args }),
              resources
            }],
            ...(volumes.length && { volumes })
          }
        }
      }
    };

    deployments.push(deployment);

    // Build Service (only if ports are exposed)
    if (servicePorts.length) {
      services.push({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: fullName, namespace: INFRA_NS, labels: appLabel },
        spec: { selector: { app: fullName }, ports: servicePorts }
      });
    }
  }

  return { deployments, services, pvcs, secrets };
}

// ==================== HELPERS ====================

function getDeploymentStatus(dep) {
  const replicas = dep.spec?.replicas || 0;
  const ready = dep.status?.readyReplicas || 0;
  const available = dep.status?.availableReplicas || 0;
  if (replicas === 0) return 'stopped';
  if (ready === replicas && available === replicas) return 'running';
  if (ready > 0) return 'degraded';
  return 'pending';
}

function extractPorts(dep) {
  const containers = dep.spec?.template?.spec?.containers || [];
  const ports = [];
  for (const c of containers) {
    for (const p of (c.ports || [])) {
      ports.push({ containerPort: p.containerPort, name: p.name || '' });
    }
  }
  return ports;
}

module.exports = {
  listInfraServices,
  getServiceDetail,
  scaleService,
  restartService,
  getServiceLogs,
  deleteService,
  deployFromCompose,
  deployFromManifests,
  composeToK8s,
  INFRA_NS
};
