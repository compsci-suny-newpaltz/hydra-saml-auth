// services/k8s-client.js - Kubernetes API client wrapper
// Provides a unified interface for K8s operations

const k8s = require('@kubernetes/client-node');
const runtimeConfig = require('../config/runtime');

class K8sClient {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.initialized = false;
  }

  // Initialize the K8s client
  init() {
    if (this.initialized) return;

    if (runtimeConfig.k8s.inCluster) {
      // Running inside K8s cluster - use ServiceAccount
      this.kc.loadFromCluster();
      console.log('[K8s] Loaded in-cluster configuration');
    } else if (runtimeConfig.k8s.kubeconfigPath) {
      // Load from specified kubeconfig file
      this.kc.loadFromFile(runtimeConfig.k8s.kubeconfigPath);
      console.log(`[K8s] Loaded kubeconfig from: ${runtimeConfig.k8s.kubeconfigPath}`);
    } else {
      // Load from default location (~/.kube/config)
      this.kc.loadFromDefault();
      console.log('[K8s] Loaded default kubeconfig');
    }

    // Create API clients
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    this.batchApi = this.kc.makeApiClient(k8s.BatchV1Api);

    this.initialized = true;
  }

  // Get namespace from config
  get namespace() {
    return runtimeConfig.k8s.namespace;
  }

  get systemNamespace() {
    return runtimeConfig.k8s.systemNamespace;
  }

  // ==================== POD OPERATIONS ====================

  // Create a pod
  async createPod(podSpec) {
    this.init();
    const namespace = podSpec.metadata?.namespace || this.namespace;
    return await this.coreApi.createNamespacedPod(namespace, podSpec);
  }

  // Get a pod by name
  async getPod(name, namespace = this.namespace) {
    this.init();
    try {
      const response = await this.coreApi.readNamespacedPod(name, namespace);
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // List pods by label selector
  async listPods(labelSelector, namespace = this.namespace) {
    this.init();
    const response = await this.coreApi.listNamespacedPod(
      namespace,
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // continue
      undefined, // fieldSelector
      labelSelector
    );
    return response.body.items;
  }

  // Delete a pod with optional delete options (gracePeriodSeconds, propagationPolicy)
  async deletePod(name, optionsOrNamespace = this.namespace) {
    this.init();
    try {
      // Handle both old signature (name, namespace) and new signature (name, options)
      let namespace = this.namespace;
      let deleteOptions = undefined;

      if (typeof optionsOrNamespace === 'string') {
        namespace = optionsOrNamespace;
      } else if (typeof optionsOrNamespace === 'object' && optionsOrNamespace !== null) {
        // New options object with gracePeriodSeconds etc.
        deleteOptions = {
          gracePeriodSeconds: optionsOrNamespace.gracePeriodSeconds,
          propagationPolicy: optionsOrNamespace.propagationPolicy || 'Background'
        };
      }

      await this.coreApi.deleteNamespacedPod(
        name,
        namespace,
        undefined, // pretty
        undefined, // dryRun
        deleteOptions?.gracePeriodSeconds, // gracePeriodSeconds
        undefined, // orphanDependents (deprecated)
        deleteOptions?.propagationPolicy, // propagationPolicy
        deleteOptions ? { gracePeriodSeconds: deleteOptions.gracePeriodSeconds } : undefined // body (V1DeleteOptions)
      );
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // Get pod logs
  async getPodLogs(name, namespace = this.namespace, container = undefined, tailLines = 100) {
    this.init();
    const response = await this.coreApi.readNamespacedPodLog(
      name,
      namespace,
      container,
      undefined, // follow
      undefined, // insecureSkipTLSVerifyBackend
      undefined, // limitBytes
      undefined, // pretty
      undefined, // previous
      undefined, // sinceSeconds
      tailLines
    );
    return response.body;
  }

  // ==================== PVC OPERATIONS ====================

  // Create a PVC
  async createPVC(pvcSpec) {
    this.init();
    const namespace = pvcSpec.metadata?.namespace || this.namespace;
    return await this.coreApi.createNamespacedPersistentVolumeClaim(namespace, pvcSpec);
  }

  // Get a PVC by name
  async getPVC(name, namespace = this.namespace) {
    this.init();
    try {
      const response = await this.coreApi.readNamespacedPersistentVolumeClaim(name, namespace);
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // Delete a PVC
  async deletePVC(name, namespace = this.namespace) {
    this.init();
    try {
      await this.coreApi.deleteNamespacedPersistentVolumeClaim(name, namespace);
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // ==================== SERVICE OPERATIONS ====================

  // Create a service
  async createService(serviceSpec) {
    this.init();
    const namespace = serviceSpec.metadata?.namespace || this.namespace;
    return await this.coreApi.createNamespacedService(namespace, serviceSpec);
  }

  // Get a service by name
  async getService(name, namespace = this.namespace) {
    this.init();
    try {
      const response = await this.coreApi.readNamespacedService(name, namespace);
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // Delete a service
  async deleteService(name, namespace = this.namespace) {
    this.init();
    try {
      await this.coreApi.deleteNamespacedService(name, namespace);
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // ==================== SECRET OPERATIONS ====================

  // Create a secret
  async createSecret(secretSpec) {
    this.init();
    const namespace = secretSpec.metadata?.namespace || this.namespace;
    return await this.coreApi.createNamespacedSecret(namespace, secretSpec);
  }

  // Get a secret
  async getSecret(name, namespace = this.namespace) {
    this.init();
    try {
      const response = await this.coreApi.readNamespacedSecret(name, namespace);
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // Delete a secret
  async deleteSecret(name, namespace = this.namespace) {
    this.init();
    try {
      await this.coreApi.deleteNamespacedSecret(name, namespace);
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // ==================== CUSTOM RESOURCE OPERATIONS ====================
  // For Traefik IngressRoutes

  // Create IngressRoute
  async createIngressRoute(ingressRouteSpec) {
    this.init();
    const namespace = ingressRouteSpec.metadata?.namespace || this.namespace;
    return await this.customApi.createNamespacedCustomObject(
      'traefik.io',
      'v1alpha1',
      namespace,
      'ingressroutes',
      ingressRouteSpec
    );
  }

  // Get IngressRoute
  async getIngressRoute(name, namespace = this.namespace) {
    this.init();
    try {
      const response = await this.customApi.getNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        namespace,
        'ingressroutes',
        name
      );
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // Delete IngressRoute
  async deleteIngressRoute(name, namespace = this.namespace) {
    this.init();
    try {
      await this.customApi.deleteNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        namespace,
        'ingressroutes',
        name
      );
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // Create Middleware
  async createMiddleware(middlewareSpec) {
    this.init();
    const namespace = middlewareSpec.metadata?.namespace || this.namespace;
    return await this.customApi.createNamespacedCustomObject(
      'traefik.io',
      'v1alpha1',
      namespace,
      'middlewares',
      middlewareSpec
    );
  }

  // Delete Middleware
  async deleteMiddleware(name, namespace = this.namespace) {
    this.init();
    try {
      await this.customApi.deleteNamespacedCustomObject(
        'traefik.io',
        'v1alpha1',
        namespace,
        'middlewares',
        name
      );
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // ==================== JOB OPERATIONS ====================
  // For migration and one-off tasks

  // Create a Job
  async createJob(jobSpec) {
    this.init();
    const namespace = jobSpec.metadata?.namespace || this.namespace;
    return await this.batchApi.createNamespacedJob(namespace, jobSpec);
  }

  // Get a Job by name
  async getJob(name, namespace = this.namespace) {
    this.init();
    try {
      const response = await this.batchApi.readNamespacedJob(name, namespace);
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // Delete a Job
  async deleteJob(name, namespace = this.namespace, propagationPolicy = 'Background') {
    this.init();
    try {
      await this.batchApi.deleteNamespacedJob(name, namespace, undefined, undefined, undefined, undefined, propagationPolicy);
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  // Wait for Job completion
  async waitForJobCompletion(name, namespace = this.namespace, timeoutMs = 300000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const job = await this.getJob(name, namespace);
      if (!job) return { success: false, error: 'Job not found' };

      if (job.status?.succeeded) {
        return { success: true, status: job.status };
      }
      if (job.status?.failed) {
        return { success: false, status: job.status, error: 'Job failed' };
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return { success: false, error: 'Job timed out' };
  }

  // List PVCs by label selector
  async listPVCs(labelSelector, namespace = this.namespace) {
    this.init();
    const response = await this.coreApi.listNamespacedPersistentVolumeClaim(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );
    return response.body.items;
  }

  // ==================== NODE OPERATIONS ====================

  // List nodes
  async listNodes() {
    this.init();
    const response = await this.coreApi.listNode();
    return response.body.items;
  }

  // Get node by name
  async getNode(name) {
    this.init();
    try {
      const response = await this.coreApi.readNode(name);
      return response.body;
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  // Get GPU nodes
  async getGPUNodes() {
    this.init();
    const response = await this.coreApi.listNode(
      undefined,
      undefined,
      undefined,
      undefined,
      'hydra.gpu-enabled=true'
    );
    return response.body.items;
  }
}

// Export singleton instance
module.exports = new K8sClient();
