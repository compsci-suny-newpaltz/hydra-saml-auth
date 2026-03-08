#!/bin/bash
set -e

# Create log directory
mkdir -p /var/log/supervisor

# Set SSH password for student user if provided
if [ -n "$SSH_PASSWORD" ]; then
    echo "student:$SSH_PASSWORD" | chpasswd
    echo "SSH password configured for student user"
fi

# Setup SSH authorized_keys if provided
if [ -n "$SSH_PUBLIC_KEY" ]; then
    mkdir -p /home/student/.ssh
    echo "$SSH_PUBLIC_KEY" > /home/student/.ssh/authorized_keys
    chmod 700 /home/student/.ssh
    chmod 600 /home/student/.ssh/authorized_keys
    chown -R student:student /home/student/.ssh
    echo "SSH public key configured"
fi

# Ensure SSH host keys exist
if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    ssh-keygen -A
fi

# Ensure .local directory structure exists with proper permissions
# This is needed for both code-server and Jupyter on mounted volumes
mkdir -p /home/student/.local/share/code-server/User
mkdir -p /home/student/.local/share/jupyter/runtime
mkdir -p /home/student/.jupyter
chown -R student:student /home/student/.local /home/student/.jupyter

# Create Jenkins home if not present
mkdir -p /home/student/.jenkins
chown student:student /home/student/.jenkins

# Copy default VS Code settings if user doesn't have any (fresh volume)
SETTINGS_DIR="/home/student/.local/share/code-server/User"
if [ ! -f "$SETTINGS_DIR/settings.json" ]; then
    echo "Copying default VS Code settings..."
    cp /etc/skel/.local/share/code-server/User/settings.json "$SETTINGS_DIR/"
fi

# Copy VS Code extensions if not present or outdated
EXTENSIONS_DIR="/home/student/.local/share/code-server/extensions"
SKEL_EXTENSIONS="/etc/skel/.local/share/code-server/extensions"
if [ -d "$SKEL_EXTENSIONS" ]; then
    mkdir -p "$EXTENSIONS_DIR"
    for ext in "$SKEL_EXTENSIONS"/*; do
        ext_name=$(basename "$ext")
        if [ ! -d "$EXTENSIONS_DIR/$ext_name" ]; then
            echo "Installing extension: $ext_name"
            cp -r "$ext" "$EXTENSIONS_DIR/"
        fi
    done
    chown -R student:student "$EXTENSIONS_DIR"
fi

# Copy CUH63 tools to user's home directory if not present
if [ ! -d "/home/student/cuh63" ] && [ -d "/etc/skel/cuh63" ]; then
    echo "Copying CUH63 tools to home directory..."
    cp -r /etc/skel/cuh63 /home/student/cuh63
    chown -R student:student /home/student/cuh63
fi

# Copy nvm to user's home directory if not present (for fresh or old volumes)
if [ ! -d "/home/student/.nvm" ] && [ -d "/etc/skel/.nvm" ]; then
    echo "Installing nvm and Node.js to home directory..."
    cp -r /etc/skel/.nvm /home/student/.nvm
    chown -R student:student /home/student/.nvm
    echo "Node.js $(cat /home/student/.nvm/alias/default) installed"
fi

# Copy supervisor.d README/examples if not present (for fresh or old volumes)
if [ ! -d "/home/student/supervisor.d" ] && [ -d "/etc/skel/supervisor.d" ]; then
    echo "Copying supervisor.d templates to home directory..."
    cp -r /etc/skel/supervisor.d /home/student/supervisor.d
    chown -R student:student /home/student/supervisor.d
elif [ -d "/home/student/supervisor.d" ] && [ ! -f "/home/student/supervisor.d/README.md" ] && [ -f "/etc/skel/supervisor.d/README.md" ]; then
    # Directory exists but README missing — copy just the README
    cp /etc/skel/supervisor.d/README.md /home/student/supervisor.d/README.md
    chown student:student /home/student/supervisor.d/README.md
fi

# Create Jupyter approval marker if env var is set
# This enables the CLI wrapper (jupyter-gate.sh) to allow direct jupyter usage
if [ "$JUPYTER_APPROVED" = "true" ]; then
    touch /var/run/jupyter-approved
fi

if [ "$JENKINS_APPROVED" = "true" ]; then
    touch /var/run/jenkins-approved
fi

# Fix Docker socket permissions — DinD sidecar creates it with GID 2375,
# but student's docker group is GID 1000. Wait for socket then fix group.
if [ -S /var/run/docker/docker.sock ]; then
    chgrp docker /var/run/docker/docker.sock 2>/dev/null || true
elif [ -d /var/run/docker ]; then
    # Socket not ready yet — fix it in background once DinD starts
    (for i in $(seq 1 30); do
        if [ -S /var/run/docker/docker.sock ]; then
            chgrp docker /var/run/docker/docker.sock 2>/dev/null || true
            break
        fi
        sleep 1
    done) &
fi

# Handle graceful shutdown
trap 'supervisorctl shutdown && exit 0' SIGTERM SIGINT

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
