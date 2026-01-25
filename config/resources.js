// config/resources.js - Resource presets and node configuration
// Replaces hardcoded values in routes/containers.js

module.exports = {
  // Per-node configurations
  nodes: {
    hydra: {
      role: 'control-plane',
      label: 'Hydra (Control Plane)',
      host: 'localhost',
      dockerSocket: '/var/run/docker.sock',
      maxContainers: 100,
      gpuEnabled: false,
      gpuCount: 0,
      defaultImage: process.env.STUDENT_IMAGE || 'ndg8743/hydra-student-container:latest',
      network: 'hydra_students_net',
      storageBackend: 'zfs',
      storagePath: '/srv/student-volumes',
      // Kubernetes configuration
      k8s: {
        nodeSelector: { 'hydra.node-role': 'control-plane' },
        tolerations: [],
        storageClass: 'hydra-local'
      }
    },
    chimera: {
      role: 'inference',
      label: 'Chimera (GPU Inference)',
      description: 'Reserved for OpenWebUI and inference workloads. For GPU training, use Cerberus instead.',
      host: process.env.CHIMERA_HOST || '192.168.1.150',
      dockerSocket: process.env.CHIMERA_DOCKER_SOCKET || 'tcp://192.168.1.150:2376',
      maxContainers: 20,
      gpuEnabled: true,
      gpuCount: 3,
      gpuModel: 'RTX 3090',
      gpuVramPerCard: 24, // GB
      gpuVramTotal: 72, // GB total (3x24GB)
      defaultImage: process.env.GPU_STUDENT_IMAGE || 'ndg8743/hydra-student-container-gpu:latest',
      network: 'chimera_students_net',
      nfsPath: '/mnt/hydra-nfs',
      requiresApproval: true,
      // OpenWebUI and Ollama run here - prioritize inference over student containers
      reservedForOpenWebUI: true,
      openwebuiGpuReserved: 1, // Reserve 1 GPU for OpenWebUI/Ollama
      // Kubernetes configuration
      k8s: {
        nodeSelector: {
          'hydra.node-role': 'inference',
          'hydra.gpu-enabled': 'true'
        },
        tolerations: [
          { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }
        ],
        storageClass: 'hydra-nfs'  // NFS for cross-node access
      }
    },
    cerberus: {
      role: 'training',
      label: 'Cerberus (GPU Training)',
      description: 'Recommended for student GPU work and training. Chimera is reserved for OpenWebUI.',
      host: process.env.CERBERUS_HOST || '192.168.1.242',
      dockerSocket: process.env.CERBERUS_DOCKER_SOCKET || 'tcp://192.168.1.242:2376',
      maxContainers: 10,
      gpuEnabled: true,
      gpuCount: 2,
      gpuModel: 'RTX 5090',
      gpuVramPerCard: 32, // GB
      gpuVramTotal: 64, // GB total (2x32GB)
      defaultImage: process.env.GPU_STUDENT_IMAGE || 'ndg8743/hydra-student-container-gpu:latest',
      network: 'cerberus_students_net',
      nfsPath: '/mnt/hydra-nfs',
      requiresApproval: true,
      // Preferred node for student GPU work - Chimera reserved for OpenWebUI
      preferredForGpuWork: true,
      // Kubernetes configuration
      k8s: {
        nodeSelector: {
          'hydra.node-role': 'training',
          'hydra.gpu-enabled': 'true'
        },
        tolerations: [
          { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }
        ],
        storageClass: 'hydra-nfs'  // NFS for cross-node access
      }
    }
  },

  // Resource presets (dropdown options for students)
  // Designed for ~500 students with 21TB total storage
  presets: {
    minimal: {
      id: 'minimal',
      label: 'Minimal',
      description: 'Basic coding without Java - auto-approved',
      memory_mb: 1024,
      memory_gb: 1,
      cpus: 0.5,
      storage_gb: 5,
      gpu_count: 0,
      autoApproveOnHydra: true,
      allowedNodes: ['hydra', 'chimera', 'cerberus']
    },
    conservative: {
      id: 'conservative',
      label: 'Conservative',
      description: 'Light workloads - auto-approved',
      memory_mb: 1536,
      memory_gb: 1.5,
      cpus: 1,
      storage_gb: 10,
      gpu_count: 0,
      autoApproveOnHydra: true,
      allowedNodes: ['hydra', 'chimera', 'cerberus']
    },
    standard: {
      id: 'standard',
      label: 'Standard (Default)',
      description: 'Default with Java support - auto-approved',
      memory_mb: 2048,
      memory_gb: 2,
      cpus: 1,
      storage_gb: 20,
      gpu_count: 0,
      autoApproveOnHydra: true,
      allowedNodes: ['hydra', 'chimera', 'cerberus']
    },
    enhanced: {
      id: 'enhanced',
      label: 'Enhanced',
      description: 'Heavy workloads - auto-approved',
      memory_mb: 4096,
      memory_gb: 4,
      cpus: 2,
      storage_gb: 40,
      gpu_count: 0,
      autoApproveOnHydra: true,
      allowedNodes: ['hydra', 'chimera', 'cerberus']
    },
    gpu_inference: {
      id: 'gpu_inference',
      label: 'GPU Inference',
      description: 'Limited availability - Chimera prioritized for OpenWebUI. Consider Cerberus for GPU work.',
      memory_gb: 32,
      cpus: 8,
      storage_gb: 100,
      gpu_count: 1,
      autoApproveOnHydra: false,
      allowedNodes: ['chimera'],
      warning: 'Chimera GPUs are shared with OpenWebUI. For dedicated GPU access, use Cerberus (gpu_training).'
    },
    gpu_training: {
      id: 'gpu_training',
      label: 'GPU Training (Recommended)',
      description: 'Cerberus - Recommended for student GPU work. RTX 5090 with 32GB VRAM.',
      memory_gb: 48,
      cpus: 16,
      storage_gb: 200,
      gpu_count: 2,
      autoApproveOnHydra: false,
      allowedNodes: ['cerberus'],
      recommended: true,
      note: 'Use Cerberus for GPU work - Chimera is reserved for OpenWebUI inference.'
    }
  },

  // Storage tier options (for dropdown)
  // 21TB total / 500 students = 42GB max avg, but use 10GB default for buffer
  storageTiers: [
    { value: 5, label: '5 GB', requiresApproval: false },
    { value: 10, label: '10 GB (Default)', requiresApproval: false },
    { value: 20, label: '20 GB', requiresApproval: false },
    { value: 40, label: '40 GB', requiresApproval: true },
    { value: 75, label: '75 GB', requiresApproval: true },
    { value: 100, label: '100 GB', requiresApproval: true },
    { value: 200, label: '200 GB (GPU Training)', requiresApproval: true }
  ],

  // Memory tier options (for dropdown)
  // Java/VS Code need at least 1GB, 2GB recommended
  memoryTiers: [
    { value: 1, label: '1 GB (Minimal)', requiresApproval: false },
    { value: 1.5, label: '1.5 GB', requiresApproval: false },
    { value: 2, label: '2 GB (Default)', requiresApproval: false },
    { value: 4, label: '4 GB', requiresApproval: false },
    { value: 8, label: '8 GB', requiresApproval: true },
    { value: 16, label: '16 GB', requiresApproval: true },
    { value: 32, label: '32 GB (GPU)', requiresApproval: true }
  ],

  // CPU tier options (for dropdown)
  cpuTiers: [
    { value: 0.5, label: '0.5 Core', requiresApproval: false },
    { value: 1, label: '1 Core (Default)', requiresApproval: false },
    { value: 2, label: '2 Cores', requiresApproval: false },
    { value: 4, label: '4 Cores', requiresApproval: true },
    { value: 8, label: '8 Cores', requiresApproval: true },
    { value: 16, label: '16 Cores', requiresApproval: true }
  ],

  // Duration tier options (for dropdown) - how long resources are allocated
  durationTiers: [
    { value: 1, label: '1 Day (Default)', requiresApproval: false, description: 'Quick testing', default: true },
    { value: 3, label: '3 Days', requiresApproval: false, description: 'Short assignment' },
    { value: 7, label: '1 Week', requiresApproval: false, description: 'Good for short projects' },
    { value: 14, label: '2 Weeks', requiresApproval: false, description: 'Standard project length' },
    { value: 30, label: '1 Month', requiresApproval: false, description: 'Semester project' },
    { value: 60, label: '2 Months', requiresApproval: true, description: 'Extended project' },
    { value: 90, label: '3 Months', requiresApproval: true, description: 'Full semester' }
  ],

  // Default duration for resource allocations (in days)
  defaultDurationDays: 1,

  // Default quota for new users
  defaults: {
    storage_gb: 10,     // 10GB default for projects
    memory_gb: 2,       // 2GB - needed for VS Code + Java extensions
    memory_mb: 2048,
    cpus: 1,
    gpu_count: 0,
    preset: 'standard', // Standard preset - 1GB min for Java
    node: 'hydra',
    image: process.env.STUDENT_IMAGE || 'hydra-student-container:latest'
  },

  // Container limits (absolute maximums)
  limits: {
    maxStoragePerUser: 200, // GB
    maxMemoryPerContainer: 48, // GB
    maxCpusPerContainer: 16,
    maxGpusPerContainer: 2,
    maxContainersPerUser: 1 // Currently 1, could be expanded
  },

  // Approval settings
  approval: {
    adminEmail: process.env.APPROVAL_EMAIL || 'cslab@newpaltz.edu',
    requestExpiryDays: 7,
    autoApproveConservativeOnHydra: true,
    // Thresholds for auto-approval on Hydra
    autoApproveThresholds: {
      maxMemory_gb: 4,      // Up to 4GB auto-approved
      maxCpus: 2,           // Up to 2 cores auto-approved
      maxStorage_gb: 40     // Up to 40GB auto-approved
    }
  },

  // Migration settings
  migration: {
    nfsStagingPath: process.env.NFS_STAGING_PATH || '/mnt/hydra-nfs/migrations',
    timeoutMs: 300000, // 5 minutes
    cleanupAfterDays: 7
  },

  // Kubernetes resource quota mappings for presets
  k8sResourceQuotas: {
    minimal: {
      requests: { memory: '512Mi', cpu: '250m' },
      limits: { memory: '1Gi', cpu: '1' }
    },
    conservative: {
      requests: { memory: '768Mi', cpu: '500m' },
      limits: { memory: '1536Mi', cpu: '1' }
    },
    standard: {
      requests: { memory: '1Gi', cpu: '500m' },
      limits: { memory: '2Gi', cpu: '2' }
    },
    enhanced: {
      requests: { memory: '2Gi', cpu: '1' },
      limits: { memory: '4Gi', cpu: '4' }
    },
    gpu_inference: {
      requests: { memory: '16Gi', cpu: '4', 'nvidia.com/gpu': '1' },
      limits: { memory: '32Gi', cpu: '8', 'nvidia.com/gpu': '1' }
    },
    gpu_training: {
      requests: { memory: '32Gi', cpu: '8', 'nvidia.com/gpu': '2' },
      limits: { memory: '48Gi', cpu: '16', 'nvidia.com/gpu': '2' }
    }
  },

  // Get K8s resource quota for a preset
  getK8sResourceQuota(presetId) {
    return this.k8sResourceQuotas[presetId] || this.k8sResourceQuotas.conservative;
  },

  // Helper function to check if a request requires approval
  requiresApproval(targetNode, preset, memory_gb, cpus, storage_gb) {
    // GPU nodes always require approval
    if (targetNode !== 'hydra') {
      return true;
    }

    // Check if preset auto-approves on Hydra
    const presetConfig = this.presets[preset];
    if (presetConfig && !presetConfig.autoApproveOnHydra) {
      return true;
    }

    // Check against auto-approve thresholds
    const thresholds = this.approval.autoApproveThresholds;
    if (memory_gb > thresholds.maxMemory_gb) return true;
    if (cpus > thresholds.maxCpus) return true;
    if (storage_gb > thresholds.maxStorage_gb) return true;

    return false;
  },

  // Get presets available for a specific node
  getPresetsForNode(nodeName) {
    return Object.values(this.presets).filter(
      preset => preset.allowedNodes.includes(nodeName)
    );
  },

  // Get node configuration
  getNodeConfig(nodeName) {
    return this.nodes[nodeName] || null;
  },

  // Convert memory GB to bytes for Docker
  memoryToBytes(gb) {
    return Math.round(gb * 1024 * 1024 * 1024);
  },

  // Convert memory MB to bytes for Docker
  memoryMbToBytes(mb) {
    return Math.round(mb * 1024 * 1024);
  },

  // Convert CPUs to nanoseconds for Docker
  cpusToNanoCpus(cpus) {
    return Math.round(cpus * 1e9);
  },

  // Get capacity summary for admin dashboard
  getCapacitySummary(totalStudents = 500) {
    const d = this.defaults;
    return {
      totalStorage_tb: 21,
      totalStudents,
      perStudentDefault: {
        memory_mb: d.memory_mb || d.memory_gb * 1024,
        cpus: d.cpus,
        storage_gb: d.storage_gb
      },
      worstCase: {
        storage_tb: (totalStudents * d.storage_gb) / 1024,
        memory_gb: totalStudents * d.memory_gb
      }
    };
  }
};
