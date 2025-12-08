/**
 * Machine management API for multi-host container deployment.
 * Provides live resource stats and machine selection.
 */

const express = require('express');
const Docker = require('dockerode');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const { getAllMachines, getMachine, isValidMachine } = require('../config/machines');

const router = express.Router();
const execAsync = promisify(exec);

// Cache for machine stats (30 second TTL)
const statsCache = new Map();
const CACHE_TTL = 30000;

// Create Docker client for a machine
function getDockerClient(machine) {
    if (machine.isLocal) {
        return new Docker({ socketPath: '/var/run/docker.sock' });
    }
    return new Docker({ host: machine.host, port: 2375 });
}

// Get local machine stats
async function getLocalStats() {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    // Calculate CPU usage
    const cpuUsage = cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const idle = cpu.times.idle;
        return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;

    // Get disk usage
    let diskStats = { total: 0, used: 0, free: 0 };
    try {
        const { stdout } = await execAsync("df -B1 / | tail -1 | awk '{print $2,$3,$4}'");
        const [total, used, free] = stdout.trim().split(' ').map(Number);
        diskStats = { total, used, free };
    } catch (e) {
        console.error('[machines] Failed to get disk stats:', e.message);
    }

    return {
        cpu: {
            cores: cpus.length,
            usagePercent: Math.round(cpuUsage * 10) / 10
        },
        memory: {
            total: totalMemory,
            used: usedMemory,
            free: freeMemory,
            usagePercent: Math.round((usedMemory / totalMemory) * 1000) / 10
        },
        disk: {
            total: diskStats.total,
            used: diskStats.used,
            free: diskStats.free,
            usagePercent: diskStats.total ? Math.round((diskStats.used / diskStats.total) * 1000) / 10 : 0
        }
    };
}

// Get remote machine stats via SSH
async function getRemoteStats(machine) {
    try {
        // Get CPU, memory, disk via SSH
        const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no infra@${machine.host} 'cat /proc/stat | head -1; free -b; df -B1 / | tail -1'`;
        const { stdout } = await execAsync(cmd);

        const lines = stdout.trim().split('\n');

        // Parse CPU
        const cpuLine = lines[0];
        const cpuParts = cpuLine.split(/\s+/).slice(1).map(Number);
        const total = cpuParts.reduce((a, b) => a + b, 0);
        const idle = cpuParts[3];
        const cpuUsage = ((total - idle) / total) * 100;

        // Parse memory
        const memLine = lines.find(l => l.startsWith('Mem:'));
        const memParts = memLine.split(/\s+/).map(n => parseInt(n, 10) || 0);
        const totalMem = memParts[1];
        const usedMem = memParts[2];
        const freeMem = memParts[3];

        // Parse disk
        const diskLine = lines[lines.length - 1];
        const diskParts = diskLine.split(/\s+/);
        const totalDisk = parseInt(diskParts[1], 10) || 0;
        const usedDisk = parseInt(diskParts[2], 10) || 0;
        const freeDisk = parseInt(diskParts[3], 10) || 0;

        return {
            cpu: {
                cores: os.cpus().length, // Approximate
                usagePercent: Math.round(cpuUsage * 10) / 10
            },
            memory: {
                total: totalMem,
                used: usedMem,
                free: freeMem,
                usagePercent: Math.round((usedMem / totalMem) * 1000) / 10
            },
            disk: {
                total: totalDisk,
                used: usedDisk,
                free: freeDisk,
                usagePercent: totalDisk ? Math.round((usedDisk / totalDisk) * 1000) / 10 : 0
            }
        };
    } catch (e) {
        console.error(`[machines] Failed to get remote stats for ${machine.id}:`, e.message);
        return null;
    }
}

// Get GPU stats via nvidia-smi
async function getGpuStats(machine) {
    if (!machine.hasGpu) {
        return null;
    }

    try {
        let cmd;
        if (machine.isLocal) {
            cmd = "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits";
        } else {
            cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no infra@${machine.host} "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu --format=csv,noheader,nounits"`;
        }

        const { stdout } = await execAsync(cmd);
        const gpus = stdout.trim().split('\n').map((line, index) => {
            const [name, totalMem, usedMem, freeMem, utilization] = line.split(', ').map(s => s.trim());
            return {
                index,
                name,
                memory: {
                    total: parseInt(totalMem, 10) * 1024 * 1024, // Convert MB to bytes
                    used: parseInt(usedMem, 10) * 1024 * 1024,
                    free: parseInt(freeMem, 10) * 1024 * 1024,
                    usagePercent: Math.round((parseInt(usedMem, 10) / parseInt(totalMem, 10)) * 1000) / 10
                },
                utilizationPercent: parseInt(utilization, 10)
            };
        });

        return gpus;
    } catch (e) {
        console.error(`[machines] Failed to get GPU stats for ${machine.id}:`, e.message);
        return null;
    }
}

// Get container count for a machine
async function getContainerCount(machine) {
    try {
        const docker = getDockerClient(machine);
        const containers = await docker.listContainers({
            filters: { label: ['hydra.managed_by=hydra-saml-auth'] }
        });
        return containers.length;
    } catch (e) {
        console.error(`[machines] Failed to get container count for ${machine.id}:`, e.message);
        return 0;
    }
}

// Get full stats for a machine
async function getMachineStats(machine) {
    const cacheKey = machine.id;
    const cached = statsCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.stats;
    }

    const [systemStats, gpuStats, containerCount] = await Promise.all([
        machine.isLocal ? getLocalStats() : getRemoteStats(machine),
        getGpuStats(machine),
        getContainerCount(machine)
    ]);

    const stats = {
        machine: {
            id: machine.id,
            name: machine.name,
            label: machine.label,
            description: machine.description,
            hasGpu: machine.hasGpu,
            gpuCount: machine.gpuCount,
            gpuType: machine.gpuType
        },
        available: systemStats !== null,
        system: systemStats,
        gpu: gpuStats,
        containers: {
            running: containerCount
        },
        timestamp: new Date().toISOString()
    };

    statsCache.set(cacheKey, { stats, timestamp: Date.now() });
    return stats;
}

// List all machines with their capabilities
// GET /dashboard/api/machines
router.get('/', (req, res) => {
    const machines = getAllMachines().map(m => ({
        id: m.id,
        name: m.name,
        label: m.label,
        description: m.description,
        hasGpu: m.hasGpu,
        gpuCount: m.gpuCount,
        gpuType: m.gpuType
    }));

    return res.json({ success: true, machines });
});

// Get stats for all machines
// GET /dashboard/api/machines/stats
router.get('/stats', async (req, res) => {
    try {
        const machines = getAllMachines();
        const statsPromises = machines.map(m => getMachineStats(m));
        const allStats = await Promise.all(statsPromises);

        return res.json({ success: true, stats: allStats });
    } catch (err) {
        console.error('[machines] stats error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get machine stats' });
    }
});

// Get stats for a specific machine
// GET /dashboard/api/machines/:id/stats
router.get('/:id/stats', async (req, res) => {
    try {
        const machineId = req.params.id;

        if (!isValidMachine(machineId)) {
            return res.status(404).json({ success: false, message: 'Machine not found' });
        }

        const machine = getMachine(machineId);
        const stats = await getMachineStats(machine);

        return res.json({ success: true, ...stats });
    } catch (err) {
        console.error('[machines] stats error:', err);
        return res.status(500).json({ success: false, message: 'Failed to get machine stats' });
    }
});

// Helper function to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
