#!/bin/bash

#########################################
# SAML Debugging Helper
#########################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}
╔══════════════════════════════════════╗
║     SAML Authentication Debugger     ║
╚══════════════════════════════════════╝
${NC}"

# Function to decode base64 SAML
decode_saml() {
    echo -e "${YELLOW}Enter Base64-encoded SAML Response (or 'skip'):${NC}"
    read -r saml_response
    
    if [ "$saml_response" != "skip" ] && [ -n "$saml_response" ]; then
        echo "$saml_response" | base64 -d | xmllint --format - 2>/dev/null || \
        echo -e "${RED}Invalid SAML Response${NC}"
    fi
}

# Function to test SAML flow
test_saml_flow() {
    echo -e "${GREEN}Testing SAML Authentication Flow...${NC}"
    
    # Test SP metadata endpoint
    echo -e "\n${YELLOW}1. Checking SP Metadata:${NC}"
    curl -s http://hydra.local:6969/saml/metadata | xmllint --format - | head -20 || \
    echo -e "${RED}Failed to get SP metadata${NC}"
    
    # Test IdP metadata endpoint
    echo -e "\n${YELLOW}2. Checking IdP Metadata:${NC}"
    curl -s http://localhost:8080/simplesaml/saml2/idp/metadata.php | xmllint --format - | head -20 || \
    echo -e "${RED}Failed to get IdP metadata${NC}"
    
    # Test login redirect
    echo -e "\n${YELLOW}3. Testing Login Redirect:${NC}"
    response=$(curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}" http://hydra.local:6969/login)
    echo "Response: $response"
    
    # Test callback endpoint
    echo -e "\n${YELLOW}4. Checking Callback Endpoint:${NC}"
    curl -s -o /dev/null -w "%{http_code}" -X POST http://hydra.local:6969/login/callback
    echo ""
}

# Function to show current configuration
show_config() {
    echo -e "${GREEN}Current SAML Configuration:${NC}"
    
    if [ -f ".env.dev" ]; then
        echo -e "\n${YELLOW}From .env.dev:${NC}"
        grep -E "SAML|METADATA|CALLBACK" .env.dev | sed 's/^/  /'
    fi
    
    echo -e "\n${YELLOW}Container Status:${NC}"
    docker compose -f docker-compose.dev.yml ps | grep -E "mock-saml|hydra-saml"
}

# Function to test with curl
test_with_curl() {
    echo -e "${GREEN}Testing Authentication with curl...${NC}"
    
    # Create a cookie jar
    COOKIE_JAR=$(mktemp)
    
    # Step 1: Initial request
    echo -e "\n${YELLOW}Step 1: Initial login request${NC}"
    curl -c "$COOKIE_JAR" -v -L http://hydra.local:6969/login 2>&1 | grep -E "< HTTP|< Location"
    
    echo -e "\n${YELLOW}Cookies collected:${NC}"
    cat "$COOKIE_JAR"
    
    # Cleanup
    rm -f "$COOKIE_JAR"
}

# Function to view logs
view_logs() {
    echo -e "${GREEN}Recent SAML-related logs:${NC}"
    
    echo -e "\n${YELLOW}Hydra SAML Auth logs:${NC}"
    docker compose -f docker-compose.dev.yml logs --tail=20 hydra-saml-auth | grep -i saml || echo "No SAML logs found"
    
    echo -e "\n${YELLOW}Mock IdP logs:${NC}"
    docker compose -f docker-compose.dev.yml logs --tail=20 mock-saml-idp | grep -v "GET /simplesaml/module.php/core/frontpage_welcome.php" || echo "No IdP logs found"
}

# Function to generate test SAML assertion
generate_test_assertion() {
    echo -e "${GREEN}Generating Test SAML Assertion...${NC}"
    
    cat > test-assertion.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol"
                 ID="_test_response_id"
                 Version="2.0"
                 IssueInstant="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
                 Destination="http://hydra.local:6969/login/callback">
    <saml2:Issuer xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">
        http://localhost:8080/simplesaml/saml2/idp/metadata.php
    </saml2:Issuer>
    <saml2p:Status>
        <saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
    </saml2p:Status>
    <saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion"
                     ID="_test_assertion_id"
                     Version="2.0"
                     IssueInstant="$(date -u +%Y-%m-%dT%H:%M:%SZ)">
        <saml2:Issuer>http://localhost:8080/simplesaml/saml2/idp/metadata.php</saml2:Issuer>
        <saml2:Subject>
            <saml2:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">
                test-user
            </saml2:NameID>
        </saml2:Subject>
        <saml2:AttributeStatement>
            <saml2:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress">
                <saml2:AttributeValue>test@example.com</saml2:AttributeValue>
            </saml2:Attribute>
            <saml2:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname">
                <saml2:AttributeValue>Test</saml2:AttributeValue>
            </saml2:Attribute>
            <saml2:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname">
                <saml2:AttributeValue>User</saml2:AttributeValue>
            </saml2:Attribute>
        </saml2:AttributeStatement>
    </saml2:Assertion>
</saml2p:Response>
EOF
    
    echo -e "${GREEN}✓ Generated test-assertion.xml${NC}"
    echo -e "${YELLOW}Note: This is unsigned and for structure reference only${NC}"
}

# Main menu
show_menu() {
    echo -e "\n${BLUE}Select an option:${NC}"
    echo "1) Test SAML flow"
    echo "2) Show current configuration"
    echo "3) Test with curl"
    echo "4) View SAML logs"
    echo "5) Decode SAML response"
    echo "6) Generate test assertion"
    echo "7) Check all endpoints"
    echo "8) Exit"
    
    read -p "Choice: " choice
    
    case $choice in
        1) test_saml_flow ;;
        2) show_config ;;
        3) test_with_curl ;;
        4) view_logs ;;
        5) decode_saml ;;
        6) generate_test_assertion ;;
        7) 
            test_saml_flow
            echo -e "\n${YELLOW}JWT/JWKS Endpoints:${NC}"
            curl -s http://hydra.local:6969/.well-known/jwks.json | jq . 2>/dev/null || echo "JWKS not available"
            ;;
        8) exit 0 ;;
        *) echo -e "${RED}Invalid choice${NC}" ;;
    esac
    
    show_menu
}

# Check dependencies
check_deps() {
    for cmd in curl xmllint docker; do
        if ! command -v $cmd &> /dev/null; then
            echo -e "${RED}Missing required command: $cmd${NC}"
            exit 1
        fi
    done
    
    # Optional: jq for JSON formatting
    if ! command -v jq &> /dev/null; then
        echo -e "${YELLOW}Note: Install 'jq' for better JSON formatting${NC}"
    fi
}

# Main execution
check_deps
show_menu
