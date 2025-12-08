/**
 * Resource tier definitions for student containers.
 * Each tier defines memory, CPU, and storage limits.
 */

const RESOURCE_TIERS = {
    micro: {
        id: 'micro',
        name: 'Micro',
        label: 'Micro (512MB RAM, 0.25 CPU)',
        description: 'Minimal environment for basic tasks',
        memory: 512 * 1024 * 1024,  // 512MB in bytes
        memoryLabel: '512MB',
        cpus: 0.25,
        nanoCpus: 0.25e9,
        storage: '2g',
        storageBytes: 2 * 1024 * 1024 * 1024
    },
    tiny: {
        id: 'tiny',
        name: 'Tiny',
        label: 'Tiny (1GB RAM, 0.5 CPU)',
        description: 'Light scripting, text editing',
        memory: 1 * 1024 * 1024 * 1024,  // 1GB in bytes
        memoryLabel: '1GB',
        cpus: 0.5,
        nanoCpus: 0.5e9,
        storage: '5g',
        storageBytes: 5 * 1024 * 1024 * 1024
    },
    small: {
        id: 'small',
        name: 'Small',
        label: 'Small (2GB RAM, 1 CPU)',
        description: 'Single project development',
        memory: 2 * 1024 * 1024 * 1024,  // 2GB in bytes
        memoryLabel: '2GB',
        cpus: 1,
        nanoCpus: 1e9,
        storage: '10g',
        storageBytes: 10 * 1024 * 1024 * 1024
    },
    medium: {
        id: 'medium',
        name: 'Medium',
        label: 'Medium (4GB RAM, 2 CPU)',
        description: 'Multi-project, databases',
        memory: 4 * 1024 * 1024 * 1024,  // 4GB in bytes
        memoryLabel: '4GB',
        cpus: 2,
        nanoCpus: 2e9,
        storage: '20g',
        storageBytes: 20 * 1024 * 1024 * 1024
    },
    large: {
        id: 'large',
        name: 'Large',
        label: 'Large (8GB RAM, 4 CPU)',
        description: 'Heavy compilation, ML training',
        memory: 8 * 1024 * 1024 * 1024,  // 8GB in bytes
        memoryLabel: '8GB',
        cpus: 4,
        nanoCpus: 4e9,
        storage: '40g',
        storageBytes: 40 * 1024 * 1024 * 1024,
        gpu: false
    },
    gpu_small: {
        id: 'gpu_small',
        name: 'GPU Small',
        label: 'GPU Small (4GB RAM, 2 CPU, GPU)',
        description: 'ML inference, CUDA development',
        memory: 4 * 1024 * 1024 * 1024,  // 4GB in bytes
        memoryLabel: '4GB',
        cpus: 2,
        nanoCpus: 2e9,
        storage: '20g',
        storageBytes: 20 * 1024 * 1024 * 1024,
        gpu: true,
        gpuCount: 1,
        requiresMachine: ['chimera', 'cerberus']
    },
    gpu_large: {
        id: 'gpu_large',
        name: 'GPU Large',
        label: 'GPU Large (16GB RAM, 4 CPU, GPU)',
        description: 'ML training, large models',
        memory: 16 * 1024 * 1024 * 1024,  // 16GB in bytes
        memoryLabel: '16GB',
        cpus: 4,
        nanoCpus: 4e9,
        storage: '50g',
        storageBytes: 50 * 1024 * 1024 * 1024,
        gpu: true,
        gpuCount: 1,
        requiresMachine: ['chimera', 'cerberus']
    }
};

// Default tier for new containers
const DEFAULT_TIER = 'micro';

// Get tier by ID, returns default if not found
function getTier(tierId) {
    return RESOURCE_TIERS[tierId] || RESOURCE_TIERS[DEFAULT_TIER];
}

// Validate tier ID
function isValidTier(tierId) {
    return Object.prototype.hasOwnProperty.call(RESOURCE_TIERS, tierId);
}

// Get list of all tiers for UI dropdowns
function getAllTiers() {
    return Object.values(RESOURCE_TIERS);
}

// Get tiers that require GPU
function getGpuTiers() {
    return Object.values(RESOURCE_TIERS).filter(t => t.gpu === true);
}

// Get tiers that don't require GPU
function getNonGpuTiers() {
    return Object.values(RESOURCE_TIERS).filter(t => t.gpu !== true);
}

// Check if tier requires a specific machine
function getTierRequiredMachines(tierId) {
    const tier = RESOURCE_TIERS[tierId];
    return tier?.requiresMachine || null;
}

module.exports = {
    RESOURCE_TIERS,
    DEFAULT_TIER,
    getTier,
    isValidTier,
    getAllTiers,
    getGpuTiers,
    getNonGpuTiers,
    getTierRequiredMachines
};
