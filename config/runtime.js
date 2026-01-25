// config/runtime.js - Runtime configuration for Docker/Kubernetes orchestration
// This allows switching between Docker and Kubernetes modes via environment variable

module.exports = {
  // Orchestrator mode: 'docker' or 'kubernetes'
  orchestrator: process.env.ORCHESTRATOR || 'docker',

  // Docker-specific settings
  docker: {
    socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
    network: process.env.DOCKER_NETWORK || 'hydra_students_net',
    traefikConfigPath: process.env.TRAEFIK_CONFIG_PATH || '/etc/traefik/dynamic'
  },

  // Kubernetes-specific settings
  k8s: {
    // Namespace for student workloads
    namespace: process.env.K8S_NAMESPACE || 'hydra-students',
    // Namespace for system components (hydra-auth, traefik)
    systemNamespace: process.env.K8S_SYSTEM_NAMESPACE || 'hydra-system',
    // Whether running inside a K8s cluster (uses in-cluster config)
    inCluster: process.env.K8S_IN_CLUSTER === 'true',
    // Path to kubeconfig file (only used if not in-cluster)
    kubeconfigPath: process.env.KUBECONFIG || null,
    // Default storage class for student volumes
    defaultStorageClass: process.env.K8S_STORAGE_CLASS || 'hydra-hot',
    // Student container image (use docker.io prefix for containerd compatibility)
    studentImage: process.env.STUDENT_IMAGE || 'docker.io/ndg8743/hydra-student-container:latest',
    // GPU student container image
    gpuStudentImage: process.env.GPU_STUDENT_IMAGE || 'docker.io/ndg8743/hydra-student-container-gpu:latest'
  },

  // Helper to check if running in K8s mode
  isKubernetes() {
    return this.orchestrator === 'kubernetes';
  },

  // Helper to check if running in Docker mode
  isDocker() {
    return this.orchestrator === 'docker';
  },

  // Get the container service based on orchestrator mode
  getContainerService() {
    if (this.isKubernetes()) {
      return require('../services/k8s-containers');
    }
    return require('../services/docker-containers');
  }
};
