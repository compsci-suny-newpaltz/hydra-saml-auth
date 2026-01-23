#!/bin/bash
# migrate-sshpiper.sh - Generate sshpiper configs for existing student containers

SSHPIPER_CONFIG_DIR="/home/infra/hydra-saml-auth/sshpiper/config"
SSH_KEYS_DIR="/home/infra/hydra-saml-auth/data/ssh-keys"

echo "=== SSHPiper Migration Script ==="
echo "Config directory: $SSHPIPER_CONFIG_DIR"
echo ""

# Get all running student containers
containers=$(docker ps --filter "name=student-" --format "{{.Names}}")

if [ -z "$containers" ]; then
    echo "No student containers found."
    exit 0
fi

echo "Found student containers:"
echo "$containers"
echo ""

# Create config for each container
for container in $containers; do
    # Extract username from container name (student-username -> username)
    username="${container#student-}"

    echo "Processing: $username"

    # Create user directory
    user_dir="$SSHPIPER_CONFIG_DIR/$username"
    mkdir -p "$user_dir"

    # Create sshpiper_upstream file
    # Format: target_host:port
    echo "$container:22" > "$user_dir/sshpiper_upstream"

    # Copy the user's private key for sshpiper to use when connecting to upstream
    # sshpiper needs the private key to authenticate to the container
    if [ -f "$SSH_KEYS_DIR/${username}_id_ed25519" ]; then
        cp "$SSH_KEYS_DIR/${username}_id_ed25519" "$user_dir/id_ed25519"
        chmod 600 "$user_dir/id_ed25519"
        echo "  ✓ Created upstream config and copied key"
    else
        echo "  ⚠ Warning: No SSH key found for $username"
    fi

    # Create authorized_keys for this user (so they can authenticate TO sshpiper)
    if [ -f "$SSH_KEYS_DIR/${username}_id_ed25519.pub" ]; then
        cp "$SSH_KEYS_DIR/${username}_id_ed25519.pub" "$user_dir/authorized_keys"
        chmod 644 "$user_dir/authorized_keys"
        echo "  ✓ Created authorized_keys"
    fi
done

echo ""
echo "=== Migration Complete ==="
echo "Total containers configured: $(echo "$containers" | wc -l)"
echo ""
echo "Next steps:"
echo "1. Start sshpiper: cd /home/infra/hydra-saml-auth/sshpiper && docker compose up -d"
echo "2. Test: ssh -i ~/.ssh/[user]_hydra_key [username]@hydra.newpaltz.edu -p 2222"
