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
        storageBytes: 40 * 1024 * 1024 * 1024
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

module.exports = {
    RESOURCE_TIERS,
    DEFAULT_TIER,
    getTier,
    isValidTier,
    getAllTiers
};
