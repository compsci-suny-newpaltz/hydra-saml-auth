#!/bin/bash

#########################################
# API Endpoint Tests
#########################################

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Base URLs
HYDRA_URL="http://hydra.local:6969"
WEBUI_URL="http://localhost:3000"
MIDDLEMAN_URL="http://localhost:7070"

echo -e "${GREEN}Testing API Endpoints...${NC}\n"

# Test function
test_endpoint() {
    local name=$1
    local url=$2
    local method=${3:-GET}
    local data=$4
    local headers=$5
    
    echo -e "${YELLOW}Testing: $name${NC}"
    echo "URL: $url"
    echo "Method: $method"
    
    if [ "$method" = "POST" ]; then
        if [ -n "$headers" ]; then
            response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" -H "$headers" -d "$data")
        else
            response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" -d "$data")
        fi
    else
        response=$(curl -s -o /dev/null -w "%{http_code}" "$url")
    fi
    
    if [ "$response" = "200" ] || [ "$response" = "302" ] || [ "$response" = "401" ]; then
        echo -e "Status: ${GREEN}$response${NC} ✓\n"
    else
        echo -e "Status: ${RED}$response${NC} ✗\n"
    fi
}

# Public endpoints
echo -e "${GREEN}=== Public Endpoints ===${NC}\n"
test_endpoint "SAML Metadata" "$HYDRA_URL/saml/metadata"
test_endpoint "JWKS" "$HYDRA_URL/.well-known/jwks.json"
test_endpoint "Login Page" "$HYDRA_URL/login"
test_endpoint "Health Check" "$MIDDLEMAN_URL/openwebui/health"

# Protected endpoints (should return 401)
echo -e "${GREEN}=== Protected Endpoints (expecting 401) ===${NC}\n"
test_endpoint "Dashboard" "$HYDRA_URL/dashboard"
test_endpoint "Check User" "$HYDRA_URL/dashboard/api/webui/check-user" "POST" '{"email":"test@example.com"}' "Content-Type: application/json"
test_endpoint "Container List" "$HYDRA_URL/dashboard/api/containers/mine"
test_endpoint "Auth Verify" "$HYDRA_URL/auth/verify"

# Middleman API (with API key)
echo -e "${GREEN}=== Middleman API (with API key) ===${NC}\n"
test_endpoint "Check User (with key)" "$MIDDLEMAN_URL/openwebui/api/check-user" "POST" '{"email":"test@example.com"}' "Content-Type: application/json\nx-api-key: dev-api-key-change-me"

# Service availability
echo -e "${GREEN}=== Service Availability ===${NC}\n"
test_endpoint "OpenWebUI" "$WEBUI_URL"
test_endpoint "Mock SAML IdP" "http://localhost:8080"
test_endpoint "Mock SAML Metadata" "http://localhost:8080/simplesaml/saml2/idp/metadata.php"
test_endpoint "n8n" "http://localhost:5678"
test_endpoint "Traefik Dashboard" "http://localhost:8081/api/overview"

# Test with authentication (requires manual token)
echo -e "${YELLOW}
To test authenticated endpoints:
1. Login at $HYDRA_URL/login (user1/user1pass)
2. Get the 'np_access' cookie from browser DevTools
3. Run: curl -H 'Cookie: np_access=YOUR_TOKEN' $HYDRA_URL/dashboard/api/containers/mine
${NC}"

# Summary
echo -e "${GREEN}
╔══════════════════════════════════════╗
║         Test Complete!               ║
╚══════════════════════════════════════╝
${NC}
Note: Some 401 responses are expected for protected endpoints.
Check the logs if any services are not responding:
  make logs
"
