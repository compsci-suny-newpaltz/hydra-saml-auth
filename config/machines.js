/**
 * Machine registry for multi-host container management.
 * Each machine can run student containers with different capabilities.
 */

const MACHINES = {
    hydra: {
        id: 'hydra',
        name: 'Hydra',
        label: 'Hydra (Control)',
        host: 'hydra',
        dockerHost: process.env.HYDRA_DOCKER_HOST || 'unix:///var/run/docker.sock',
        description: 'Main control node for student containers',
        hasGpu: false,
        gpuCount: 0,
        gpuType: null,
        isLocal: true
    },
    chimera: {
        id: 'chimera',
        name: 'Chimera',
        label: 'Chimera (GPU/Inference)',
        host: 'chimera',
        dockerHost: process.env.CHIMERA_DOCKER_HOST || 'tcp://chimera:2375',
        description: 'GPU node for inference workloads (3x RTX 3090)',
        hasGpu: true,
        gpuCount: 3,
        gpuType: 'RTX 3090',
        isLocal: false
    },
    cerberus: {
        id: 'cerberus',
        name: 'Cerberus',
        label: 'Cerberus (GPU/Training)',
        host: 'cerberus',
        dockerHost: process.env.CERBERUS_DOCKER_HOST || 'tcp://cerberus:2375',
        description: 'GPU node for training workloads (2x RTX 5090)',
        hasGpu: true,
        gpuCount: 2,
        gpuType: 'RTX 5090',
        isLocal: false
    }
};

// Default machine for new containers
const DEFAULT_MACHINE = 'hydra';

// Get machine by ID
function getMachine(machineId) {
    return MACHINES[machineId] || MACHINES[DEFAULT_MACHINE];
}

// Validate machine ID
function isValidMachine(machineId) {
    return Object.prototype.hasOwnProperty.call(MACHINES, machineId);
}

// Get list of all machines
function getAllMachines() {
    return Object.values(MACHINES);
}

// Get GPU-enabled machines
function getGpuMachines() {
    return Object.values(MACHINES).filter(m => m.hasGpu);
}

// Docker client cache
const dockerClients = {};

// Get Docker client for a machine
function getDocker(machineId) {
    const Docker = require('dockerode');
    const machine = MACHINES[machineId] || MACHINES[DEFAULT_MACHINE];

    if (!dockerClients[machineId]) {
        if (machine.isLocal) {
            dockerClients[machineId] = new Docker({ socketPath: '/var/run/docker.sock' });
        } else {
            const host = machine.dockerHost;
            if (host.startsWith('tcp://')) {
                const [, hostPort] = host.replace('tcp://', '').split(':');
                const [hostname, port] = hostPort ? [host.replace('tcp://', '').split(':')[0], parseInt(hostPort.split(':')[1] || '2375')] : [host.replace('tcp://', ''), 2375];
                dockerClients[machineId] = new Docker({ host: hostname.split(':')[0], port: parseInt(hostname.split(':')[1]) || 2375 });
            } else {
                dockerClients[machineId] = new Docker({ socketPath: host });
            }
        }
    }

    return dockerClients[machineId];
}

module.exports = {
    MACHINES,
    DEFAULT_MACHINE,
    getMachine,
    isValidMachine,
    getAllMachines,
    getGpuMachines,
    getDocker
};
