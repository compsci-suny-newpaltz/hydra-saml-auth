const express = require('express');
const Docker = require('dockerode');

const router = express.Router();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Helper to pull Docker images
async function pullImage(img) {
    return new Promise((resolve, reject) => {
        docker.pull(img, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
        });
    });
}

// Helper to ensure volume exists
async function ensureVolume(volumeName, username, project) {
    try {
        const vol = docker.getVolume(volumeName);
        await vol.inspect();
    } catch {
        await docker.createVolume({
            Name: volumeName,
            Labels: {
                'hydra.managed_by': 'hydra-saml-auth',
                'hydra.owner': username,
                'hydra.project': project
            }
        });
    }
}

// Start a container with presets, GitHub repos, or custom config
// POST /dashboard/api/containers/start { project, preset?, runtime?, repo?, custom?, resources? }
router.post('/start', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }

        const project = String(req.body?.project || '').trim().toLowerCase();
        if (!project || !/^[a-z0-9-]{1,40}$/.test(project)) {
            return res.status(400).json({ success: false, message: 'Invalid project name' });
        }

        const preset = String(req.body?.preset || '').trim(); // 'jupyter' | 'static' | 'repo'
        const runtime = String(req.body?.runtime || '').trim(); // 'python' | 'node' | 'static'
        const repo = req.body?.repo || null; // { url, branch?, subdir?, startCmd? }
        const custom = req.body?.custom || {};
        const limits = req.body?.resources || {};

        const username = String(req.user.email).split('@')[0];
        const host = 'hydra.newpaltz.edu';
        const basePath = `/students/${username}/${project}`;
        const containerName = `student-${username}-${project}`;
        const networkName = 'hydra_students_net';

        // Public URL + labels
        const publicBase = (process.env.PUBLIC_STUDENTS_BASE || `https://${host}/students`).replace(/\/$/, '');
        const publicUrl = `${publicBase}/${username}/${project}/`;

        const labels = {
            'traefik.enable': 'true',
            'hydra.managed_by': 'hydra-saml-auth',
            'hydra.owner': username,
            'hydra.ownerEmail': req.user.email,
            'hydra.project': project,
            'hydra.basePath': basePath,
            'hydra.public_url': publicUrl,
            'hydra.created_at': new Date().toISOString()
        };

        // Runtime/image defaults
        let image = 'nginx:alpine';
        let servicePort = 80;
        let cmd = undefined;
        const env = [];

        // Per-project Docker named volume (no host bind mounts)
        const volumeName = `hydra-vol-${username}-${project}`.replace(/[^a-z0-9-]/g, '').slice(0, 60);

        // Ensure network exists
        const networks = await docker.listNetworks({ filters: { name: [networkName] } });
        if (!networks.length) {
            await docker.createNetwork({ Name: networkName, Driver: 'bridge' });
        }

        // Ensure volume exists (idempotent)
        await ensureVolume(volumeName, username, project);

        // === PRESET: JUPYTER ===
        if (preset === 'jupyter') {
            labels['hydra.preset'] = 'jupyter';
            image = process.env.JUPYTER_IMAGE || 'jupyter/minimal-notebook:latest';
            servicePort = 8888;

            // Generate one-time token
            const crypto = require('crypto');
            const jupyterToken = crypto.randomBytes(16).toString('hex');
            env.push(`JUPYTER_TOKEN=${jupyterToken}`);
            // Configure Jupyter to run at the correct base URL (don't strip prefix)
            env.push(`JUPYTER_BASE_URL=${basePath}`);
            // Store token in labels for later retrieval
            labels['hydra.jupyter_token'] = jupyterToken;

            // Add Traefik labels BEFORE creating container
            // Note: We do NOT use stripprefix for Jupyter - it needs to know its full path
            labels[`traefik.http.routers.${containerName}.entrypoints`] = 'web';
            labels[`traefik.http.routers.${containerName}.rule`] = `PathPrefix(\"${basePath}\")`;
            labels[`traefik.http.services.${containerName}.loadbalancer.server.port`] = String(servicePort);

            await pullImage(image);

            const mounts = [{ Type: 'volume', Source: volumeName, Target: '/home/jovyan/work' }];

            // Custom command to start Jupyter with base_url
            cmd = ['start-notebook.sh', `--NotebookApp.base_url=${basePath}`, '--NotebookApp.allow_origin=*'];

            let container;
            try {
                container = docker.getContainer(containerName);
                await container.inspect();
            } catch {
                container = await docker.createContainer({
                    name: containerName,
                    Image: image,
                    Labels: labels,
                    Env: env,
                    Cmd: cmd,
                    HostConfig: {
                        NetworkMode: networkName,
                        RestartPolicy: { Name: 'unless-stopped' },
                        Mounts: mounts,
                        Memory: limits.memMB ? limits.memMB * 1024 * 1024 : 512 * 1024 * 1024,
                        NanoCpus: limits.cpus ? Math.floor(Number(limits.cpus) * 1e9) : 1e9
                    }
                });
            }

            // Connect to network if needed
            try {
                const info = await container.inspect();
                if (!info.NetworkSettings.Networks?.[networkName]) {
                    await docker.getNetwork(networkName).connect({ Container: info.Id });
                }
            } catch {}

            await container.start();
            return res.json({ success: true, url: publicUrl, name: containerName, jupyterToken });
        }

        // === PRESET: REPO (GitHub integration) ===
        if (preset === 'repo' && repo?.url) {
            labels['hydra.preset'] = 'repo';
            labels['hydra.runtime'] = runtime || '';
            labels['hydra.repo_url'] = repo.url;
            if (repo.branch) labels['hydra.repo_branch'] = repo.branch;
            if (repo.subdir) labels['hydra.repo_subdir'] = repo.subdir;

            // 1) Pre-clone repo into the named volume using alpine/git
            const gitImg = 'alpine/git:latest';
            await pullImage(gitImg);
            await pullImage('busybox:latest'); // Also pull busybox for reading commit hash
            
            const branchOpt = repo.branch ? `-b ${repo.branch}` : '';
            const gitCloneCmd = `
                set -e
                mkdir -p /w
                if [ ! -d /w/src/.git ]; then
                  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git clone --depth=1 ${branchOpt} ${repo.url} /w/src
                fi
                cd /w/src
                git rev-parse HEAD > /w/commit_hash.txt
            `;
            
            const gitInit = await docker.createContainer({
                Image: gitImg,
                Labels: { 'hydra.temp': 'true' },
                Cmd: ['-c', gitCloneCmd],
                HostConfig: { Mounts: [{ Type: 'volume', Source: volumeName, Target: '/w' }] },
                Entrypoint: ['sh'] // Override the entrypoint to use shell
            });
            await gitInit.start();
            const result = await gitInit.wait();
            
            // Check if git clone succeeded
            if (result.StatusCode !== 0) {
                console.error(`[containers] Git clone failed with status ${result.StatusCode}`);
                try {
                    const logs = await gitInit.logs({ stdout: true, stderr: true });
                    console.error('[containers] Git clone logs:', logs.toString());
                } catch {}
                await gitInit.remove({ force: true });
                return res.status(500).json({ success: false, message: 'Failed to clone repository' });
            }
            
            // Get the commit hash
            let commitHash = '';
            try {
                const hashReader = await docker.createContainer({
                    Image: 'busybox:latest',
                    Cmd: ['cat', '/w/commit_hash.txt'],
                    HostConfig: { Mounts: [{ Type: 'volume', Source: volumeName, Target: '/w' }] }
                });
                await hashReader.start();
                await hashReader.wait();
                
                // Get logs as buffer and manually parse Docker stream header
                const logBuffer = await hashReader.logs({ stdout: true, stderr: false });
                
                // Docker stream format: [8 bytes header][payload]
                // Header: [stream type: 1 byte][3 bytes padding][size: 4 bytes big-endian]
                if (logBuffer.length > 8) {
                    const payloadSize = logBuffer.readUInt32BE(4);
                    const payload = logBuffer.slice(8, 8 + payloadSize);
                    commitHash = payload.toString('utf8').trim();
                }
                
                await hashReader.remove();
            } catch (e) {
                console.error('[containers] Failed to read commit hash:', e);
            }
            
            await gitInit.remove({ force: true });
            
            // Store commit hash in labels
            if (commitHash) {
                labels['hydra.repo_commit'] = commitHash;
            }

            // 2) Choose runtime image + bootstrap
            if (runtime === 'node') {
                image = 'node:20-alpine';
                servicePort = Number(req.body?.internalPort || 3000);
                const subdirPath = repo.subdir ? `/${repo.subdir}` : '';
                const startCmd = repo.startCmd || 'npm start';
                cmd = ['sh', '-c', `
                    set -e
                    cd /workspace/src${subdirPath}
                    if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm i; fi
                    exec ${startCmd}
                `];
            } else if (runtime === 'python') {
                image = 'python:3.11-slim';
                servicePort = Number(req.body?.internalPort || 8000);
                const subdirPath = repo.subdir ? `/${repo.subdir}` : '';
                const startCmd = repo.startCmd || `uvicorn app:app --host 0.0.0.0 --port ${servicePort}`;
                cmd = ['sh', '-c', `
                    set -e
                    cd /workspace/src${subdirPath}
                    [ -d /workspace/.venv ] || python -m venv /workspace/.venv
                    . /workspace/.venv/bin/activate
                    if [ -f requirements.txt ]; then pip install --upgrade pip && pip install -r requirements.txt; fi
                    exec ${startCmd}
                `];
            } else if (runtime === 'static') {
                image = 'nginx:alpine';
                servicePort = 80;
                const subdirPath = repo.subdir ? `/${repo.subdir}` : '';
                cmd = ['sh', '-c', `
                    set -e
                    rm -rf /usr/share/nginx/html/*
                    cp -R /workspace/src${subdirPath}/* /usr/share/nginx/html/ || true
                    exec nginx -g 'daemon off;'
                `];
            } else {
                return res.status(400).json({ success: false, message: 'Unsupported runtime' });
            }

            // Add Traefik labels BEFORE creating container
            labels[`traefik.http.routers.${containerName}.entrypoints`] = 'web';
            labels[`traefik.http.routers.${containerName}.rule`] = `PathPrefix(\"${basePath}\")`;
            labels[`traefik.http.services.${containerName}.loadbalancer.server.port`] = String(servicePort);
            labels[`traefik.http.middlewares.${containerName}-stripprefix.stripprefix.prefixes`] = basePath;
            labels[`traefik.http.routers.${containerName}.middlewares`] = `${containerName}-stripprefix`;

            // 3) Pull runtime image and create container with the named volume
            await pullImage(image);
            const container = await docker.createContainer({
                name: containerName,
                Image: image,
                Labels: labels,
                Cmd: cmd,
                Env: env.length ? env : undefined,
                HostConfig: {
                    NetworkMode: networkName,
                    RestartPolicy: { Name: 'unless-stopped' },
                    Mounts: [{ Type: 'volume', Source: volumeName, Target: '/workspace' }],
                    Memory: limits.memMB ? limits.memMB * 1024 * 1024 : 512 * 1024 * 1024,
                    NanoCpus: limits.cpus ? Math.floor(Number(limits.cpus) * 1e9) : 1e9
                }
            });

            await container.start();
            return res.json({ success: true, url: publicUrl, name: containerName });
        }

        // === PRESET: STATIC (simple static site) ===
        if (preset === 'static') {
            labels['hydra.preset'] = 'static';
            image = 'nginx:alpine';
            servicePort = 80;

            // Add Traefik labels BEFORE creating container
            labels[`traefik.http.routers.${containerName}.entrypoints`] = 'web';
            labels[`traefik.http.routers.${containerName}.rule`] = `PathPrefix(\"${basePath}\")`;
            labels[`traefik.http.services.${containerName}.loadbalancer.server.port`] = String(servicePort);
            labels[`traefik.http.middlewares.${containerName}-stripprefix.stripprefix.prefixes`] = basePath;
            labels[`traefik.http.routers.${containerName}.middlewares`] = `${containerName}-stripprefix`;

            await pullImage(image);

            const mounts = [{ Type: 'volume', Source: volumeName, Target: '/usr/share/nginx/html' }];

            const container = await docker.createContainer({
                name: containerName,
                Image: image,
                Labels: labels,
                HostConfig: {
                    NetworkMode: networkName,
                    RestartPolicy: { Name: 'unless-stopped' },
                    Mounts: mounts,
                    Memory: limits.memMB ? limits.memMB * 1024 * 1024 : 256 * 1024 * 1024,
                    NanoCpus: limits.cpus ? Math.floor(Number(limits.cpus) * 1e9) : 5e8
                }
            });

            await container.start();
            return res.json({ success: true, url: publicUrl, name: containerName });
        }

        // === FALLBACK: Simple hello container ===
        labels['hydra.preset'] = 'hello';
        image = 'busybox';
        servicePort = 80;

        await pullImage(image);

        const container = await docker.createContainer({
            name: containerName,
            Image: image,
            Labels: labels,
            Cmd: ['sh', '-c', 'echo "Hello from Hydra!" > index.html && httpd -f -p 80 -h /'],
            HostConfig: {
                NetworkMode: networkName,
                RestartPolicy: { Name: 'unless-stopped' },
                Memory: 128 * 1024 * 1024,
                NanoCpus: 5e8
            }
        });

        labels[`traefik.http.routers.${containerName}.entrypoints`] = 'web';
        labels[`traefik.http.routers.${containerName}.rule`] = `PathPrefix(\"${basePath}\")`;
        labels[`traefik.http.services.${containerName}.loadbalancer.server.port`] = String(servicePort);
        labels[`traefik.http.middlewares.${containerName}-stripprefix.stripprefix.prefixes`] = basePath;
        labels[`traefik.http.routers.${containerName}.middlewares`] = `${containerName}-stripprefix`;

        await container.start();

        return res.json({ success: true, url: publicUrl, name: containerName });
    } catch (err) {
        console.error('[containers] start error:', err);
        return res.status(500).json({ success: false, message: 'Failed to start container' });
    }
});

// List current user's containers
router.get('/mine', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const username = String(req.user.email).split('@')[0];

        const containers = await docker.listContainers({
            all: true,
            filters: { label: [
                `hydra.owner=${username}`,
                'hydra.managed_by=hydra-saml-auth'
            ] }
        });

        const items = containers.map(c => ({
            id: c.Id,
            name: (c.Names && c.Names[0]) ? c.Names[0].replace(/^\//, '') : '',
            image: c.Image,
            state: c.State,
            status: c.Status,
            created: c.Created,
            project: c.Labels?.['hydra.project'] || '',
            url: c.Labels?.['hydra.public_url'] || '',
            preset: c.Labels?.['hydra.preset'] || '',
            jupyterToken: c.Labels?.['hydra.jupyter_token'] || null,
            repoUrl: c.Labels?.['hydra.repo_url'] || null,
            repoCommit: c.Labels?.['hydra.repo_commit'] || null
        }));
        return res.json({ success: true, containers: items });
    } catch (err) {
        console.error('[containers] list mine error:', err);
        return res.status(500).json({ success: false, message: 'Failed to list containers' });
    }
});

// Delete a user's container with cleanup
router.delete('/:name', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const username = String(req.user.email).split('@')[0];
        const nameParam = String(req.params.name || '').trim();
        if (!nameParam) return res.status(400).json({ success: false, message: 'Missing container name' });

        const container = docker.getContainer(nameParam);
        const info = await container.inspect();
        const labels = info?.Config?.Labels || {};
        if (labels['hydra.owner'] !== username || labels['hydra.managed_by'] !== 'hydra-saml-auth') {
            return res.status(403).json({ success: false, message: 'Not allowed' });
        }

        try { await container.stop({ t: 5 }); } catch (_e) {}
        await container.remove({ force: true, v: true });
        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] delete error:', err);
        return res.status(500).json({ success: false, message: 'Failed to delete container' });
    }
});

// Restart a user's container
router.post('/:name/restart', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const username = String(req.user.email).split('@')[0];
        const nameParam = String(req.params.name || '').trim();
        if (!nameParam) return res.status(400).json({ success: false, message: 'Missing container name' });

        const container = docker.getContainer(nameParam);
        const info = await container.inspect();
        const labels = info?.Config?.Labels || {};
        if (labels['hydra.owner'] !== username || labels['hydra.managed_by'] !== 'hydra-saml-auth') {
            return res.status(403).json({ success: false, message: 'Not allowed' });
        }

        try {
            await container.restart();
        } catch (e) {
            await container.start();
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('[containers] restart error:', err);
        return res.status(500).json({ success: false, message: 'Failed to restart container' });
    }
});

// Stream logs (SSE)
router.get('/:name/logs/stream', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).end();
        }
        const username = String(req.user.email).split('@')[0];
        const nameParam = String(req.params.name || '').trim();
        if (!nameParam) return res.status(400).end();

        const container = docker.getContainer(nameParam);
        const info = await container.inspect();
        const labels = info?.Config?.Labels || {};
        if (labels['hydra.owner'] !== username || labels['hydra.managed_by'] !== 'hydra-saml-auth') {
            return res.status(403).end();
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const logStream = await container.logs({
            follow: true, stdout: true, stderr: true, tail: 200
        });

        // Use demuxStream to properly handle Docker's multiplexed stream
        const stdout = {
            write: (chunk) => {
                const lines = chunk.toString('utf8').split(/\r?\n/);
                lines.forEach(line => {
                    if (line) res.write(`data: ${line}\n\n`);
                });
            }
        };
        const stderr = {
            write: (chunk) => {
                const lines = chunk.toString('utf8').split(/\r?\n/);
                lines.forEach(line => {
                    if (line) res.write(`data: [stderr] ${line}\n\n`);
                });
            }
        };

        docker.modem.demuxStream(logStream, stdout, stderr);
        
        logStream.on('end', () => res.end());
        logStream.on('error', () => res.end());
        req.on('close', () => {
            try { logStream.destroy(); } catch {}
        });
    } catch (err) {
        console.error('[containers] logs stream error:', err);
        try { res.status(500).end(); } catch {}
    }
});

// Pull latest changes from git repo
router.post('/:name/git-pull', async (req, res) => {
    try {
        if (!req.isAuthenticated?.() || !req.user?.email) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const username = String(req.user.email).split('@')[0];
        const nameParam = String(req.params.name || '').trim();
        if (!nameParam) return res.status(400).json({ success: false, message: 'Missing container name' });

        const container = docker.getContainer(nameParam);
        const info = await container.inspect();
        const labels = info?.Config?.Labels || {};
        
        if (labels['hydra.owner'] !== username || labels['hydra.managed_by'] !== 'hydra-saml-auth') {
            return res.status(403).json({ success: false, message: 'Not allowed' });
        }

        // Only works for repo containers
        if (labels['hydra.preset'] !== 'repo' || !labels['hydra.repo_url']) {
            return res.status(400).json({ success: false, message: 'Not a repository container' });
        }

        const project = labels['hydra.project'];
        const volumeName = `hydra-vol-${username}-${project}`.replace(/[^a-z0-9-]/g, '').slice(0, 60);

        // Pull latest changes using alpine/git
        const gitImg = 'alpine/git:latest';
        await pullImage(gitImg);
        await pullImage('busybox:latest'); // Also pull busybox for reading commit hash

        const gitPullCmd = `
            set -e
            cd /w/src
            git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"
            GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git fetch origin
            GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git reset --hard origin/HEAD
            git rev-parse HEAD > /w/commit_hash.txt
        `;

        const gitPull = await docker.createContainer({
            Image: gitImg,
            Labels: { 'hydra.temp': 'true' },
            Cmd: ['-c', gitPullCmd],
            HostConfig: { Mounts: [{ Type: 'volume', Source: volumeName, Target: '/w' }] },
            Entrypoint: ['sh']
        });
        
        await gitPull.start();
        const result = await gitPull.wait();

        if (result.StatusCode !== 0) {
            console.error(`[containers] Git pull failed with status ${result.StatusCode}`);
            try {
                const logs = await gitPull.logs({ stdout: true, stderr: true });
                console.error('[containers] Git pull logs:', logs.toString());
            } catch {}
            await gitPull.remove({ force: true });
            return res.status(500).json({ success: false, message: 'Failed to pull latest changes' });
        }

        // Get the new commit hash
        let commitHash = '';
        try {
            const hashReader = await docker.createContainer({
                Image: 'busybox:latest',
                Cmd: ['cat', '/w/commit_hash.txt'],
                HostConfig: { Mounts: [{ Type: 'volume', Source: volumeName, Target: '/w' }] }
            });
            await hashReader.start();
            await hashReader.wait();
            
            // Get logs as buffer and manually parse Docker stream header
            const logBuffer = await hashReader.logs({ stdout: true, stderr: false });
            
            // Docker stream format: [8 bytes header][payload]
            // Header: [stream type: 1 byte][3 bytes padding][size: 4 bytes big-endian]
            if (logBuffer.length > 8) {
                const payloadSize = logBuffer.readUInt32BE(4);
                const payload = logBuffer.slice(8, 8 + payloadSize);
                commitHash = payload.toString('utf8').trim();
            }
            
            await hashReader.remove();
        } catch (e) {
            console.error('[containers] Failed to read commit hash:', e);
        }

        await gitPull.remove({ force: true });

        // Update the container labels with new commit hash (requires recreation)
        if (commitHash) {
            try {
                const oldInfo = await container.inspect();
                const oldConfig = oldInfo.Config;
                const oldHostConfig = oldInfo.HostConfig;
                
                // Update labels
                const updatedLabels = { ...oldConfig.Labels, 'hydra.repo_commit': commitHash };
                
                // Stop and remove old container
                try { await container.stop({ t: 5 }); } catch {}
                await container.remove({ force: true });
                
                // Recreate with updated labels
                const newContainer = await docker.createContainer({
                    name: nameParam,
                    Image: oldConfig.Image,
                    Labels: updatedLabels,
                    Cmd: oldConfig.Cmd,
                    Env: oldConfig.Env,
                    HostConfig: oldHostConfig
                });
                
                await newContainer.start();
            } catch (e) {
                console.error('[containers] Failed to update container labels:', e);
                // If recreation failed, try to restart the old one
                try {
                    await container.restart();
                } catch {}
            }
        } else {
            // No commit hash, just restart
            try {
                await container.restart();
            } catch (e) {
                await container.start();
            }
        }

        return res.json({ success: true, commitHash });
    } catch (err) {
        console.error('[containers] git-pull error:', err);
        return res.status(500).json({ success: false, message: 'Failed to pull latest changes' });
    }
});

module.exports = router;
