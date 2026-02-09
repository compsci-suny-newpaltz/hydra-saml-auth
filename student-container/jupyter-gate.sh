#!/bin/bash
# Jupyter execution gate - checks if user has been approved for Jupyter access
# The marker file /var/run/jupyter-approved is created by the entrypoint
# when the JUPYTER_APPROVED env var is set (controlled by hydra-saml-auth)

if [ ! -f /var/run/jupyter-approved ]; then
    echo ""
    echo "=========================================="
    echo "  Jupyter execution is not enabled."
    echo "=========================================="
    echo ""
    echo "  To use Jupyter notebooks, you must first"
    echo "  request access from the Hydra dashboard:"
    echo ""
    echo "  1. Go to hydra.newpaltz.edu/dashboard"
    echo "  2. Click 'Manage Resources'"
    echo "  3. Request Jupyter execution access"
    echo "  4. Wait for admin approval"
    echo ""
    echo "  Once approved, restart your container"
    echo "  and Jupyter will start automatically."
    echo "=========================================="
    echo ""
    exit 1
fi

# Approved — run the real jupyter binary
exec /usr/local/bin/jupyter.real "$@"
