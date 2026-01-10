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

# Handle graceful shutdown
trap 'supervisorctl shutdown && exit 0' SIGTERM SIGINT

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
