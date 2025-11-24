#!/bin/bash
set -e

# Create log directory
mkdir -p /var/log/supervisor

# Handle graceful shutdown
trap 'supervisorctl shutdown && exit 0' SIGTERM SIGINT

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
