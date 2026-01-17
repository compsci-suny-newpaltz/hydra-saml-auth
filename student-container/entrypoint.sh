#!/bin/bash
set -e

# Create log directory
mkdir -p /var/log/supervisor

# Copy default VS Code settings if user doesn't have any (fresh volume)
SETTINGS_DIR="/home/student/.local/share/code-server/User"
if [ ! -f "$SETTINGS_DIR/settings.json" ]; then
    echo "Copying default VS Code settings..."
    mkdir -p "$SETTINGS_DIR"
    cp /etc/skel/.local/share/code-server/User/settings.json "$SETTINGS_DIR/"
    chown -R student:student /home/student/.local
fi

# Copy VS Code extensions if not present or outdated
# This ensures extensions are available on mounted volumes
EXTENSIONS_DIR="/home/student/.local/share/code-server/extensions"
SKEL_EXTENSIONS="/etc/skel/.local/share/code-server/extensions"
if [ -d "$SKEL_EXTENSIONS" ]; then
    mkdir -p "$EXTENSIONS_DIR"
    # Copy each extension if not already present
    for ext in "$SKEL_EXTENSIONS"/*; do
        ext_name=$(basename "$ext")
        if [ ! -d "$EXTENSIONS_DIR/$ext_name" ]; then
            echo "Installing extension: $ext_name"
            cp -r "$ext" "$EXTENSIONS_DIR/"
        fi
    done
    chown -R student:student /home/student/.local
fi

# Copy pip-installed tools (jupyter, etc) if not present
if [ ! -d "/home/student/.local/bin" ] && [ -d "/etc/skel/.local/bin" ]; then
    echo "Copying pip tools (jupyter, etc)..."
    mkdir -p /home/student/.local
    cp -r /etc/skel/.local/bin /home/student/.local/
    cp -r /etc/skel/.local/lib /home/student/.local/
    chown -R student:student /home/student/.local
fi

# Copy CUH63 tools to user's home directory if not present
if [ ! -d "/home/student/cuh63" ] && [ -d "/etc/skel/cuh63" ]; then
    echo "Copying CUH63 tools to home directory..."
    cp -r /etc/skel/cuh63 /home/student/cuh63
    chown -R student:student /home/student/cuh63
fi

# Handle graceful shutdown
trap 'supervisorctl shutdown && exit 0' SIGTERM SIGINT

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
