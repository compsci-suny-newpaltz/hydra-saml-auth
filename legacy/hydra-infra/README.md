# Hydra Infrastructure

A comprehensive infrastructure repository for New Paltz University's Hydra authentication system and associated services. This repository contains Docker Compose configurations for various services including AI/ML tools, Minecraft server management, and authentication systems.

## 🏗️ Repository Structure

```
hydra-infra/
├── Chimera/                    # AI/ML Services (Ollama + Open WebUI)
├── Minecraft-Server/           # Minecraft Server with Whitelist Management
├── Hydra/                      # Hydra Authentication Services
├── Guides/                     # Documentation and Integration Guides
└── README.md                   # This file
```

## 🚀 Services Overview

### 1. Chimera - AI/ML Platform
**Location**: `Chimera/`

A complete AI/ML platform combining Ollama (local LLM server) with Open WebUI for a ChatGPT-like interface.

**Components**:
- **Ollama**: Local LLM server with GPU support
- **Open WebUI**: Web interface for interacting with LLMs
- **Hydra SAML Auth**: Authentication integration for secure access

**Features**:
- GPU-accelerated inference (NVIDIA GPU support)
- Persistent model storage
- Authentication via Hydra SAML
- Web-based chat interface

**Ports**:
- Ollama: `11434`
- Open WebUI: `3000` (configurable)
- Hydra SAML Auth: `6969`

### 2. Minecraft Server with Management
**Location**: `Minecraft-Server/`

A complete Minecraft server setup with role-based whitelist management and web administration interface.

**Components**:
- **Minecraft Server**: Paper server with RCON enabled
- **Whitelist Admin**: Web interface for managing server access
- **Database**: SQLite for user/whitelist management

**Features**:
- Role-based access control (Faculty/Student)
- Web-based whitelist management
- RCON console access
- Integration with Hydra authentication
- Automatic whitelist synchronization

**Ports**:
- Minecraft Server: `25565`
- Whitelist Admin: `3000`

### 3. Hydra Authentication Services
**Location**: `Hydra/`

Core authentication services and configurations for the Hydra system.

**Components**:
- Authentication service configurations
- SAML integration components
- Service definitions and deployments

### 4. Authentication & Documentation
**Location**: `Guides/`

Comprehensive documentation for integrating with the Hydra authentication system.

**Components**:
- **NP Access Auth Guide**: Complete integration guide for Hydra authentication
- Multi-language examples (Node.js, PHP, Java, Python)
- Security best practices
- Role-based access control patterns

## 🛠️ Quick Start

### Prerequisites
- Docker and Docker Compose
- NVIDIA GPU (for Chimera AI services)
- Environment variables configured

### Environment Setup

Create a `.env` file in each service directory:

**Chimera/.env**:
```bash
OLLAMA_DOCKER_TAG=latest
WEBUI_DOCKER_TAG=main
OPEN_WEBUI_PORT=3000
```

**Minecraft-Server/.env**:
```bash
RCON_PASSWORD=your_secure_rcon_password
```

### Starting Services

#### Chimera (AI/ML Platform)
```bash
cd Chimera/
docker-compose up -d
```

#### Minecraft Server
```bash
cd Minecraft-Server/
docker-compose up -d
```

## 🔐 Authentication Integration

This repository includes comprehensive authentication integration using the Hydra system. Applications are typically hosted at `hydra.newpaltz.edu/students/{username}/{project}/` and integrate with the centralized NP Access authentication service.

### Key Features
- **JWT-based Authentication**: Simple token verification
- **Role-based Access Control**: Student, Faculty, Staff roles
- **Multi-language Support**: Examples in Node.js, PHP, Java, Python
- **Security Best Practices**: HTTPS, token validation, audit logging

### Integration Examples

**Node.js/Express**:
```javascript
// Verify Hydra token
async function verifyWithHydra(token) {
  const response = await fetch(`${HYDRA_BASE_URL}/check`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.json();
}
```

**PHP**:
```php
// Hydra authentication class
class HydraAuth {
    public function verifyToken($token) {
        // Implementation details in Guides/np-access-auth-guide.md
    }
}
```

## 📚 Documentation

### Comprehensive Guides
- **[NP Access Authentication Guide](Guides/np-access-auth-guide.md)**: Complete integration guide
- **Multi-language Examples**: Node.js, PHP, Java, Python implementations
- **Security Best Practices**: HTTPS, token validation, rate limiting
- **Role-based Access Control**: Faculty, Student, Staff permissions

### Key Documentation Sections
1. **Authentication Lifecycle**: Step-by-step flow
2. **Implementation Examples**: Code samples for multiple languages
3. **Role-Based Access Control**: Permission management
4. **Security Considerations**: Best practices and vulnerabilities
5. **Troubleshooting**: Common issues and solutions

## 🔧 Configuration

### Hydra Authentication
All services integrate with the Hydra authentication system. Student projects are hosted at:

```
https://hydra.newpaltz.edu/students/{username}/{project_name}/
```

**Environment Configuration**:
```bash
# Environment variables
HYDRA_BASE_URL=https://hydra.newpaltz.edu
RETURN_TO=https://hydra.newpaltz.edu/students/{username}/{project_name}/
```

### Service-Specific Configuration

**Chimera**:
- GPU support for AI inference
- Persistent storage for models
- Authentication integration

**Minecraft**:
- RCON password configuration
- Whitelist management
- Role-based access control

## 🚨 Security Considerations

### Best Practices
- Always use HTTPS in production
- Implement token refresh strategies
- Use rate limiting for authentication endpoints
- Enable audit logging
- Follow principle of least privilege

### Common Vulnerabilities to Avoid
- Token exposure in URLs
- XSS attacks (use httpOnly cookies)
- CSRF attacks (implement CSRF tokens)
- Token leakage in logs

## 🐛 Troubleshooting

### Common Issues
1. **Token Not Found**: Check cookie configuration
2. **CORS Issues**: Configure CORS for API access
3. **Authentication Failures**: Verify Hydra endpoint accessibility
4. **Permission Denied**: Check role assignments

### Debug Checklist
- [ ] Cookie name is exactly `np_access`
- [ ] HYDRA_BASE_URL is correctly configured
- [ ] Using HTTPS in production
- [ ] Tokens haven't expired
- [ ] Return URL is properly encoded


---

*Last updated: 2024*  
*Version: 1.0.0*
