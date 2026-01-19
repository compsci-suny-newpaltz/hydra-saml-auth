#!/bin/bash
# Deployment script for Hydra Servers Status Page
# Run with sudo on Hydra

set -e
echo "=== Hydra Servers Status Deployment ==="

# Step 1: Add /servers route to Apache config
echo ""
echo "Step 1: Adding /servers route to Apache..."

APACHE_CONF="/etc/apache2/sites-enabled/hydra.newpaltz.edu.conf"

# Check if /servers location already exists
if grep -q 'Location "/servers"' "$APACHE_CONF" 2>/dev/null; then
    echo "  /servers route already exists in Apache config"
else
    # Add /servers location block after /api/events block
    # Find the line with </Location> after /api/events and insert after it
    sudo sed -i '/<Location "\/api\/events">/,/<\/Location>/{
        /<\/Location>/a\
\
# Proxy /servers to hydra-saml-auth for cluster status page\
<Location "/servers">\
    ProxyPass http://localhost:6969/servers\
    ProxyPassReverse http://localhost:6969/servers\
</Location>\
\
# Static assets for servers page\
<Location "/css/">\
    ProxyPass http://localhost:6969/css/\
    ProxyPassReverse http://localhost:6969/css/\
</Location>\
<Location "/js/">\
    ProxyPass http://localhost:6969/js/\
    ProxyPassReverse http://localhost:6969/js/\
</Location>
    }' "$APACHE_CONF"

    echo "  Added /servers route to Apache config"
fi

# Step 2: Test and reload Apache
echo ""
echo "Step 2: Testing and reloading Apache..."
sudo apachectl configtest
sudo systemctl reload apache2
echo "  Apache reloaded successfully"

# Step 3: Rebuild Docker container with updated metrics collector
echo ""
echo "Step 3: Rebuilding hydra-saml-auth Docker container..."
cd /home/infra/hydra-saml-auth
sudo docker compose build hydra-saml-auth
sudo docker compose up -d hydra-saml-auth
echo "  Container rebuilt and started"

# Step 4: Verify the servers page is accessible
echo ""
echo "Step 4: Verifying deployment..."
sleep 3
if curl -s http://localhost:6969/servers | grep -q "HYDRA CLUSTER STATUS"; then
    echo "  ✓ Servers page is accessible locally"
else
    echo "  ✗ Servers page not accessible - check container logs"
fi

if curl -s http://localhost:6969/api/servers/status | grep -q "hydra"; then
    echo "  ✓ Servers API is returning data"
else
    echo "  ✗ Servers API not working - check container logs"
fi

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "The servers page should now be accessible at:"
echo "  https://hydra.newpaltz.edu/servers"
echo ""
echo "Next steps to show REAL metrics from Chimera and Cerberus:"
echo "  1. Copy agents/metrics-agent.js to each GPU node"
echo "  2. Install as a systemd service (see agents/hydra-metrics-agent.service)"
echo "  3. Metrics will auto-populate within 30 seconds"
echo ""
echo "Manual deployment to GPU nodes:"
echo "  scp agents/metrics-agent.js chimera:/opt/hydra-metrics/"
echo "  scp agents/hydra-metrics-agent.service chimera:/etc/systemd/system/"
echo "  ssh chimera 'systemctl daemon-reload && systemctl enable --now hydra-metrics-agent'"
echo ""
