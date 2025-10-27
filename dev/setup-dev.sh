#!/bin/bash

#########################################
# Hydra SAML Auth - Local Dev Setup
#########################################

set -e

echo "🚀 Setting up Hydra SAML Auth development environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root (needed for hosts file)
check_sudo() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${YELLOW}This script needs sudo access to update /etc/hosts${NC}"
        exec sudo "$0" "$@"
    fi
}

# Add local domains to hosts file
setup_hosts() {
    echo -e "${GREEN}Setting up local domains...${NC}"
    
    # Check if entries already exist
    if ! grep -q "hydra.local" /etc/hosts; then
        echo "# Hydra SAML Auth Development" >> /etc/hosts
        echo "127.0.0.1 hydra.local" >> /etc/hosts
        echo "127.0.0.1 gpt.hydra.local" >> /etc/hosts
        echo "127.0.0.1 n8n.hydra.local" >> /etc/hosts
        echo "127.0.0.1 traefik.hydra.local" >> /etc/hosts
        echo -e "${GREEN}✓ Added local domains to /etc/hosts${NC}"
    else
        echo -e "${YELLOW}Local domains already configured${NC}"
    fi
}

# Generate JWT keys
generate_jwt_keys() {
    echo -e "${GREEN}Generating JWT keys...${NC}"
    
    mkdir -p jwt-keys
    
    if [ ! -f "jwt-keys/private.pem" ] || [ ! -f "jwt-keys/public.pem" ]; then
        openssl genrsa -out jwt-keys/private.pem 2048
        openssl rsa -in jwt-keys/private.pem -pubout -out jwt-keys/public.pem
        echo -e "${GREEN}✓ Generated JWT key pair${NC}"
    else
        echo -e "${YELLOW}JWT keys already exist${NC}"
    fi
}

# Create required directories
create_directories() {
    echo -e "${GREEN}Creating required directories...${NC}"
    mkdir -p ../public
    mkdir -p ../views
    mkdir -p ../routes
    echo -e "${GREEN}✓ Directories created${NC}"
}

# Check Docker and Docker Compose
check_docker() {
    echo -e "${GREEN}Checking Docker installation...${NC}"
    
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Docker is not installed. Please install Docker first.${NC}"
        exit 1
    fi
    
    if ! docker compose version &> /dev/null && ! docker-compose version &> /dev/null; then
        echo -e "${RED}Docker Compose is not installed. Please install Docker Compose.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ Docker and Docker Compose are installed${NC}"
}

# Create sample SAML users for mock IdP
create_mock_users() {
    echo -e "${GREEN}Creating mock SAML users configuration...${NC}"
    
    cat > mock-users.md <<EOF
# Mock SAML IdP Users

The mock SAML IdP provides these test users:

## Available Users:
1. **user1** / **user1pass**
   - Email: user1@example.com
   - Groups: students
   
2. **user2** / **user2pass**  
   - Email: user2@example.com
   - Groups: faculty

## Accessing Mock IdP:
- URL: http://localhost:8080/simplesaml
- Admin: admin / secret

## SAML Metadata:
- URL: http://localhost:8080/simplesaml/saml2/idp/metadata.php
EOF
    
    echo -e "${GREEN}✓ Mock users documentation created${NC}"
}

# Main setup flow
main() {
    echo -e "${GREEN}
╔══════════════════════════════════════════╗
║   Hydra SAML Auth - Development Setup   ║
╚══════════════════════════════════════════╝
${NC}"
    
    # Check if we need sudo for hosts file
    if [[ "$1" != "--skip-hosts" ]]; then
        check_sudo
        setup_hosts
    fi
    
    check_docker
    generate_jwt_keys
    create_directories
    create_mock_users
    
    # Copy env file if it doesn't exist
    if [ ! -f ".env.dev" ]; then
        echo -e "${RED}.env.dev not found! Please create it first.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}
╔══════════════════════════════════════════╗
║           Setup Complete! 🎉             ║
╚══════════════════════════════════════════╝

Next steps:
1. Start the services:
   ${YELLOW}docker compose -f docker-compose.dev.yml up${NC}

2. Wait for all services to start, then visit:
   - Main app: ${YELLOW}http://hydra.local:6969${NC}
   - OpenWebUI: ${YELLOW}http://localhost:3000${NC}
   - Mock SAML IdP: ${YELLOW}http://localhost:8080${NC}
   - Traefik Dashboard: ${YELLOW}http://localhost:8081${NC}
   - n8n: ${YELLOW}http://localhost:5678${NC}

3. Login with mock users (see mock-users.md)

4. To stop services:
   ${YELLOW}docker compose -f docker-compose.dev.yml down${NC}

${YELLOW}Note: First startup will take time to build images and pull dependencies.${NC}
"
}

# Run main function
main "$@"
