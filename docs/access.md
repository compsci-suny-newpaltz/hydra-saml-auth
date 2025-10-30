# Open WebUI Integration Guide

This guide will walk you through accessing Hydra GPT, creating an account, obtaining your API key, and integrating it with Open WebUI for local LLM access.

---

## Accessing Hydra GPT

Hydra GPT is a local LLM platform hosted at SUNY New Paltz. To access it:

1. **Navigate to the platform:**
    
    - Open your web browser
    - Go to: **https://gpt.hydra.newpaltz.edu** if you have an account already
    - If not make one on https://hydra.newpaltz.edu/dashboard

---

## Obtaining Your API Key

Once you're logged into Open WebUI (Hydra GPT), you need to generate an API key:

### Step 1: Navigate to Settings

1. Click on your **profile icon** or **username** in the top-right corner
2. Select **Settings** from the dropdown menu

### Step 2: Access API Keys Section

1. In the Settings menu, look for the **Account** or **API Keys** section
2. Click on **API Keys** (or similar option)

### Step 3: Generate a New API Key

1. Click the **"Create new secret key"** or **"Generate API Key"** button
2. **Optional:** Give your key a descriptive name (e.g., "Local Development" or "Personal Access")
3. Click **"Create"** or **"Generate"**

### Step 4: Copy Your API Key

1. Your new API key will be displayed **only once**
2. **Important:** Copy the key immediately and store it securely
3. The format will look something like: `sk-140ddce3f0sd480984b4c74b07ed60sd`

> **⚠️ Security Note:** Treat your API key like a password. Never share it publicly or commit it to version control systems.

---

## Integrating with Open WebUI

Now that you have your API key, you can configure Open WebUI to connect to Hydra GPT:

### Configuration Parameters

Use the following settings for your integration:

```bash
ENDPOINT=https://gpt.hydra.newpaltz.edu/api/chat/completions
MODEL=gemma3:12b
API_KEY=sk-your-actual-api-key-here
```

### Integration Methods

#### Method 1: Environment Variables

Set these environment variables in your terminal or `.env` file:

```bash
export OPENAI_API_BASE="https://gpt.hydra.newpaltz.edu/api"
export OPENAI_API_KEY="sk-your-actual-api-key-here"
export OPENAI_MODEL="gemma3:12b"
```

#### Method 2: Configuration File

Create or edit your Open WebUI configuration file:

**For Open WebUI (config.json):**

```json
{
  "api": {
    "base_url": "https://gpt.hydra.newpaltz.edu/api/chat/completions",
    "api_key": "sk-your-actual-api-key-here",
    "default_model": "gemma3:12b"
  }
}
```

#### Method 3: Python Code Integration

If you're integrating programmatically:

```python
import openai

# Configure the OpenAI client to use Hydra GPT
openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = "sk-your-actual-api-key-here"

# Make a request
response = openai.ChatCompletion.create(
    model="gemma3:12b",
    messages=[
        {"role": "user", "content": "Hello, how are you?"}
    ]
)

print(response.choices[0].message.content)
```

#### Method 4: cURL Test

Test your connection with a simple cURL command:

```bash
curl https://gpt.hydra.newpaltz.edu/api/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-actual-api-key-here" \
  -d '{
    "model": "gemma3:12b",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'
```

---

## Testing Your Connection

After configuration, verify that everything is working:

### 1. Check API Connectivity

```bash
curl -I https://gpt.hydra.newpaltz.edu/api/models \
  -H "Authorization: Bearer sk-your-actual-api-key-here"
```

You should receive a `200 OK` response.

### 2. List Available Models

```bash
curl https://gpt.hydra.newpaltz.edu/api/models \
  -H "Authorization: Bearer sk-your-actual-api-key-here"
```

This should return a JSON list of available models, including `gemma3:12b`.

### 3. Send a Test Message

Use the cURL example from Method 4 above to send a test message and verify you receive a response.

---

## Troubleshooting

### Common Issues and Solutions

#### 1. **401 Unauthorized Error**

- **Cause:** Invalid or expired API key
- **Solution:**
    - Verify your API key is correct
    - Generate a new API key if needed
    - Ensure no extra spaces or characters in the key

#### 2. **Connection Timeout**

- **Cause:** Not connected to SUNY New Paltz network
- **Solution:**
    - Connect to campus VPN if off-campus
    - Verify you can access https://gpt.hydra.newpaltz.edu in your browser

#### 3. **Model Not Found Error**

- **Cause:** Specified model doesn't exist or isn't available
- **Solution:**
    - Use the "List Available Models" command above
    - Verify `gemma3:12b` is in the list
    - Check for typos in the model name

#### 4. **SSL Certificate Errors**

- **Cause:** Certificate verification issues
- **Solution:**
    - Ensure your system's CA certificates are up to date
    - If using Python, you may need to install `certifi`

#### 5. **Rate Limiting**

- **Cause:** Too many requests in a short time
- **Solution:**
    - Implement exponential backoff in your code
    - Contact Hydra Lab administrators for rate limit details

### Getting Help

If you continue to experience issues:

1. **Check Hydra Lab Status:**
    - Visit the Hydra Lab website or contact the administrators
2. **Documentation:**
    - Refer to the Open WebUI documentation: https://docs.openwebui.com
    - Check for updates to the integration process

---

## Additional Resources

- **Hydra GPT Platform:** https://gpt.hydra.newpaltz.edu
- **Open WebUI Documentation:** https://docs.openwebui.com

---

## Security Best Practices

1. **Never share your API key** publicly or in code repositories
2. **Use environment variables** for sensitive configuration
3. **Rotate your API keys** regularly
4. **Revoke unused keys** from your account settings
5. **Monitor your usage** for any suspicious activity

---

## Example Use Cases

### Simple Chat Application

```python
import os
import openai

# Set up the client
openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = os.getenv("HYDRA_API_KEY")

def chat(message):
    response = openai.ChatCompletion.create(
        model="gemma3:12b",
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": message}
        ],
        temperature=0.7,
        max_tokens=500
    )
    return response.choices[0].message.content

# Example usage
user_message = "Explain quantum computing in simple terms."
bot_response = chat(user_message)
print(bot_response)
```

### Batch Processing

```python
import openai
import os

openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = os.getenv("HYDRA_API_KEY")

questions = [
    "What is machine learning?",
    "Explain neural networks.",
    "What is deep learning?"
]

for question in questions:
    response = openai.ChatCompletion.create(
        model="gemma3:12b",
        messages=[{"role": "user", "content": question}],
        max_tokens=200
    )
    print(f"Q: {question}")
    print(f"A: {response.choices[0].message.content}\n")
```

---

## Changelog

- **v1.0** - Initial guide created with Hydra GPT integration instructions
- Endpoint: `https://gpt.hydra.newpaltz.edu/api/chat/completions`
- Default Model: `gemma3:12b`

---


# Hydra Infrastructure Architecture & API Access Guide

## System Overview

```mermaid
graph TB
    subgraph "Internet"
        Student[Student Applications<br/>Python/JS/PHP/Java]
        Browser[Web Browser<br/>Dashboard Access]
    end
    
    subgraph "Hydra Infrastructure - hydra.newpaltz.edu"
        subgraph "Authentication Layer"
            SAML[SAML Auth Service<br/>:6969]
            Azure[Azure AD<br/>Identity Provider]
            JWT[JWT/JWKS<br/>Token Service]
        end
        
        subgraph "Reverse Proxy"
            Traefik[Traefik<br/>Path-based Routing]
        end
        
        subgraph "Core Services"
            Dashboard[Hydra Dashboard<br/>Account Management]
            OpenWebUI[OpenWebUI<br/>:3000/8080<br/>gpt.hydra.newpaltz.edu]
            Middleman[OpenWebUI Middleman<br/>:7070<br/>Database API]
        end
        
        subgraph "AI Backend"
            Ollama[Ollama Service<br/>:11434<br/>Model Management]
            Models[AI Models<br/>Llama/Mistral/etc]
        end
        
        subgraph "Student Containers"
            Jupyter[Jupyter Notebooks]
            VSCode[VS Code Server]
            Static[Static Sites]
            GitProj[GitHub Projects]
        end
        
        subgraph "Storage"
            DB[(SQLite Database<br/>User Accounts)]
            Volumes[(Docker Volumes<br/>Student Data)]
        end
    end
    
    %% Authentication Flow
    Browser -->|HTTPS| Traefik
    Traefik -->|/login| SAML
    SAML <-->|SAML 2.0| Azure
    SAML -->|Issues JWT| JWT
    Browser -->|JWT Cookie| Dashboard
    
    %% API Access Flow
    Student -->|API Key| Traefik
    Traefik -->|/api| OpenWebUI
    OpenWebUI <-->|Model Requests| Ollama
    Ollama <-->|Inference| Models
    
    %% Internal Communications
    Dashboard -->|Manage| Middleman
    Middleman <-->|User CRUD| DB
    OpenWebUI <-->|User Auth| DB
    
    %% Student Container Management
    Dashboard -->|Docker API| Jupyter
    Dashboard -->|Docker API| VSCode
    Dashboard -->|Docker API| Static
    Dashboard -->|Git Clone/Pull| GitProj
    
    %% Storage Connections
    Jupyter -.->|Mount| Volumes
    VSCode -.->|Mount| Volumes
    Static -.->|Mount| Volumes
    GitProj -.->|Mount| Volumes
    
    classDef auth fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef api fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef storage fill:#fce4ec,stroke:#880e4f,stroke-width:2px
    classDef container fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    
    class SAML,Azure,JWT auth
    class OpenWebUI,Ollama,Models api
    class DB,Volumes storage
    class Jupyter,VSCode,Static,GitProj container
```

## Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser
    participant T as Traefik
    participant H as Hydra SAML Auth
    participant A as Azure AD
    participant D as Dashboard
    participant O as OpenWebUI

    Note over U,O: Initial Login Flow
    U->>B: Visit hydra.newpaltz.edu
    B->>T: HTTPS Request
    T->>H: Route to Hydra Auth
    H->>B: Redirect to /login
    B->>A: SAML AuthN Request
    A->>U: Show SUNY Login Page
    U->>A: Enter Credentials
    A->>B: SAML Response + Attributes
    B->>H: POST /login/callback
    H->>H: Validate SAML
    H->>H: Generate JWT Token
    H->>B: Set np_access Cookie
    B->>D: Access Dashboard
    
    Note over U,O: API Key Generation
    U->>D: Settings → Account
    D->>D: Generate API Key
    D->>U: Display API Key (one time)
    
    Note over U,O: API Usage
    U->>O: API Request + Bearer Token
    O->>O: Validate API Key
    O->>O: Process Request
    O->>U: JSON Response
```

## Student API Access Pattern

```mermaid
graph LR
    subgraph "Student Development"
        Code[Student Code<br/>API Integration]
        ENV[Environment Variables<br/>OPENWEBUI_API_KEY]
    end
    
    subgraph "API Endpoints"
        Auth[/api/auth<br/>Authentication]
        Chat[/api/chat/completions<br/>Chat API]
        Models[/api/models<br/>List Models]
        Files[/api/v1/files<br/>RAG Upload]
    end
    
    subgraph "Processing"
        OpenWebUI[OpenWebUI<br/>Request Router]
        Ollama[Ollama<br/>Model Engine]
        RAG[RAG Pipeline<br/>Document Processing]
    end
    
    Code -->|Bearer Token| Auth
    Code -->|Bearer Token| Chat
    Code -->|Bearer Token| Models
    Code -->|Bearer Token| Files
    
    Auth --> OpenWebUI
    Chat --> OpenWebUI
    Models --> OpenWebUI
    Files --> OpenWebUI
    
    OpenWebUI --> Ollama
    OpenWebUI --> RAG
    
    style Code fill:#fff2cc
    style ENV fill:#d4edda
```

## Network Architecture

```mermaid
graph TB
    subgraph "External Network"
        Internet[Internet<br/>HTTPS Only]
    end
    
    subgraph "DMZ - Traefik Proxy"
        Traefik[Traefik<br/>:80/:443<br/>SSL Termination]
    end
    
    subgraph "Internal Networks"
        subgraph "hydra-main-net"
            SAML[SAML Auth<br/>10.10.0.2]
            OpenWebUI[OpenWebUI<br/>10.10.0.3]
            Dashboard[Dashboard<br/>10.10.0.4]
        end
        
        subgraph "hydra-students-net"
            Student1[Student Container 1<br/>172.20.0.x]
            Student2[Student Container 2<br/>172.20.0.y]
            StudentN[Student Container N<br/>172.20.0.z]
        end
        
        subgraph "ollama-net"
            Ollama[Ollama Service<br/>10.11.0.2]
            Models[(Model Storage)]
        end
    end
    
    Internet -->|HTTPS| Traefik
    Traefik -->|Reverse Proxy| SAML
    Traefik -->|Reverse Proxy| OpenWebUI
    Traefik -->|Reverse Proxy| Dashboard
    Traefik -->|Path Routing| Student1
    Traefik -->|Path Routing| Student2
    Traefik -->|Path Routing| StudentN
    
    OpenWebUI <-->|Model API| Ollama
    Dashboard -->|Docker API| Student1
    Dashboard -->|Docker API| Student2
    Dashboard -->|Docker API| StudentN
    
    style Traefik fill:#ffd54f
    style Ollama fill:#81c784
```

## Container Lifecycle Management

```mermaid
stateDiagram-v2
    [*] --> NotExists: Initial State
    
    NotExists --> Creating: User Clicks "Start Container"
    Creating --> Pulling: Pull Docker Image
    Pulling --> Configuring: Set Labels & Network
    Configuring --> Starting: Docker Create & Start
    Starting --> Running: Container Active
    
    Running --> Stopping: User Clicks "Stop"
    Stopping --> Stopped: Container Stopped
    
    Running --> Restarting: User Clicks "Restart"
    Restarting --> Running: Container Restarted
    
    Running --> GitPulling: User Clicks "Pull Latest"
    GitPulling --> Rebuilding: Update Code
    Rebuilding --> Running: Container Updated
    
    Running --> Deleting: User Clicks "Delete"
    Stopped --> Deleting: User Clicks "Delete"
    Deleting --> [*]: Container Removed
    
    Running --> ErrorState: Container Crash
    ErrorState --> Restarting: Auto-restart Policy
    ErrorState --> Stopped: Manual Intervention
```

## API Request Flow

```mermaid
sequenceDiagram
    participant App as Student Application
    participant API as OpenWebUI API
    participant Auth as Auth Service
    participant Model as Ollama/Model
    participant Cache as Response Cache
    
    App->>API: POST /api/chat/completions<br/>Bearer: API_KEY
    API->>Auth: Validate Token
    Auth-->>API: User Context
    
    alt Token Invalid
        API-->>App: 401 Unauthorized
    end
    
    API->>Cache: Check Cache
    alt Response Cached
        Cache-->>API: Cached Response
        API-->>App: 200 OK (from cache)
    else New Request
        API->>Model: Forward Request
        Model->>Model: Process Prompt
        Model-->>API: Generated Response
        API->>Cache: Store Response
        API-->>App: 200 OK (fresh)
    end
```

## Student Container Types

```mermaid
graph TD
    subgraph "Container Presets"
        Jupyter[Jupyter Notebook<br/>Python Data Science]
        Static[Static Website<br/>HTML/CSS/JS]
        Repo[GitHub Repository<br/>Any Language]
    end
    
    subgraph "Jupyter Config"
        J1[Base: jupyter/minimal-notebook]
        J2[Port: 8888]
        J3[Auth: ForwardAuth]
        J4[Volume: /home/jovyan/work]
    end
    
    subgraph "Static Config"
        S1[Base: nginx:alpine]
        S2[Port: 80]
        S3[Auth: None]
        S4[Volume: /usr/share/nginx/html]
    end
    
    subgraph "Repo Config"
        R1[Base: Varies by Runtime]
        R2[Node.js: port 3000]
        R3[Python: port 8000]
        R4[Volume: /workspace]
    end
    
    Jupyter --> J1
    Jupyter --> J2
    Jupyter --> J3
    Jupyter --> J4
    
    Static --> S1
    Static --> S2
    Static --> S3
    Static --> S4
    
    Repo --> R1
    Repo --> R2
    Repo --> R3
    Repo --> R4
```

## OpenWebUI API Structure

```mermaid
graph LR
    subgraph "API Endpoints"
        subgraph "/api - Management"
            M1[/api/models]
            M2[/api/chats]
            M3[/api/auth]
        end
        
        subgraph "/api/v1 - Files"
            F1[/api/v1/files]
            F2[/api/v1/knowledge]
            F3[/api/v1/documents]
        end
        
        subgraph "/v1 - OpenAI Compatible"
            O1[/v1/chat/completions]
            O2[/v1/models]
            O3[/v1/embeddings]
        end
        
        subgraph "/ollama - Direct"
            L1[/ollama/api/chat]
            L2[/ollama/api/generate]
            L3[/ollama/api/tags]
        end
    end
    
    M1 --> Backend[OpenWebUI Backend]
    M2 --> Backend
    M3 --> Backend
    
    F1 --> RAG[RAG Pipeline]
    F2 --> RAG
    F3 --> RAG
    
    O1 --> Adapter[OpenAI Adapter]
    O2 --> Adapter
    O3 --> Adapter
    
    L1 --> Ollama[Ollama Service]
    L2 --> Ollama
    L3 --> Ollama
    
    Backend --> Ollama
    Adapter --> Backend
    RAG --> Backend
```

## Security Architecture

```mermaid
graph TB
    subgraph "Security Layers"
        subgraph "Layer 1: Network"
            FW[Firewall Rules]
            SSL[SSL/TLS Encryption]
            CORS[CORS Policy]
        end
        
        subgraph "Layer 2: Authentication"
            SAML[SAML 2.0]
            JWT[JWT Tokens]
            API[API Keys]
        end
        
        subgraph "Layer 3: Authorization"
            RBAC[Role-Based Access]
            Labels[Container Labels]
            Ownership[Resource Ownership]
        end
        
        subgraph "Layer 4: Runtime"
            Isolation[Container Isolation]
            Limits[Resource Limits]
            Volumes[Volume Permissions]
        end
    end
    
    FW --> SSL
    SSL --> CORS
    CORS --> SAML
    SAML --> JWT
    JWT --> API
    API --> RBAC
    RBAC --> Labels
    Labels --> Ownership
    Ownership --> Isolation
    Isolation --> Limits
    Limits --> Volumes
```

## Data Flow for RAG (Retrieval Augmented Generation)

```mermaid
sequenceDiagram
    participant U as User
    participant A as API
    participant F as File Service
    participant V as Vector DB
    participant E as Embeddings
    participant M as Model
    
    Note over U,M: Document Upload Phase
    U->>A: POST /api/v1/files<br/>Upload PDF/TXT
    A->>F: Store File
    F->>E: Generate Embeddings
    E->>V: Store Vectors
    A-->>U: Return file_id
    
    Note over U,M: Query Phase
    U->>A: POST /api/chat/completions<br/>+ file_id
    A->>V: Semantic Search
    V-->>A: Relevant Chunks
    A->>M: Prompt + Context
    M->>M: Generate Response
    M-->>A: Contextual Answer
    A-->>U: JSON Response
```

## Deployment Architecture

```mermaid
graph TB
    subgraph "Development Environment"
        DevCode[Student Code]
        DevAPI[Local OpenWebUI<br/>localhost:3000]
        DevOllama[Local Ollama<br/>localhost:11434]
    end
    
    subgraph "Production - Hydra"
        ProdTraefik[Traefik Proxy<br/>hydra.newpaltz.edu]
        ProdAPI[OpenWebUI<br/>gpt.hydra.newpaltz.edu]
        ProdOllama[Ollama Cluster<br/>GPU Enabled]
        ProdDB[(Production DB)]
    end
    
    subgraph "Models"
        Llama[Llama 3.1]
        Mistral[Mistral]
        CodeLlama[Code Llama]
        Custom[Custom Models]
    end
    
    DevCode -->|Test| DevAPI
    DevAPI <--> DevOllama
    
    DevCode -->|Deploy| ProdTraefik
    ProdTraefik --> ProdAPI
    ProdAPI <--> ProdOllama
    ProdAPI <--> ProdDB
    
    ProdOllama --> Llama
    ProdOllama --> Mistral
    ProdOllama --> CodeLlama
    ProdOllama --> Custom
    
    style DevCode fill:#ffffcc
    style ProdAPI fill:#ccffcc
```

## Troubleshooting Decision Tree

```mermaid
graph TD
    Start[API Not Working?]
    
    Start --> Health{Health Check OK?}
    Health -->|No| CheckService[Check OpenWebUI Service]
    Health -->|Yes| AuthCheck{Auth Working?}
    
    CheckService --> DockerLogs[Check Docker Logs]
    DockerLogs --> ServiceRestart[Restart Service]
    
    AuthCheck -->|No| APIKey{API Key Valid?}
    AuthCheck -->|Yes| ModelCheck{Models Listed?}
    
    APIKey -->|No| GenerateKey[Generate New API Key]
    APIKey -->|Yes| EnableAPI[Enable API in Settings]
    
    ModelCheck -->|No| OllamaCheck{Ollama Running?}
    ModelCheck -->|Yes| RequestCheck{Request Format OK?}
    
    OllamaCheck -->|No| StartOllama[Start/Fix Ollama]
    OllamaCheck -->|Yes| NetworkCheck[Check Network Config]
    
    RequestCheck -->|No| FixFormat[Fix JSON/Headers]
    RequestCheck -->|Yes| CORSCheck{CORS Error?}
    
    CORSCheck -->|Yes| ConfigCORS[Configure CORS]
    CORSCheck -->|No| Success[Working!]
    
    style Start fill:#ffcccc
    style Success fill:#ccffcc
```

## Port Reference

```mermaid
graph LR
    subgraph "Service Ports"
        P1[3000 - OpenWebUI External]
        P2[8080 - OpenWebUI Internal]
        P3[6969 - SAML Auth]
        P4[7070 - Middleman API]
        P5[11434 - Ollama]
        P6[80/443 - Traefik]
        P7[8888 - Jupyter]
        P8[5678 - n8n]
    end
    
    subgraph "Usage"
        U1[Students → 443/HTTPS]
        U2[API Calls → 443/HTTPS]
        U3[Internal → Various]
    end
    
    P1 --> U2
    P2 --> U3
    P3 --> U3
    P4 --> U3
    P5 --> U3
    P6 --> U1
    P6 --> U2
    P7 --> U3
    P8 --> U3
```

## Quick Start Workflow

```mermaid
graph TD
    Start[Student Starts]
    
    Start --> Login[Login via SAML]
    Login --> Dashboard[Access Dashboard]
    Dashboard --> GenKey[Generate API Key]
    GenKey --> TestAPI[Test with curl]
    
    TestAPI --> Success{Working?}
    Success -->|No| Troubleshoot[Check Troubleshooting]
    Success -->|Yes| ChooseLang[Choose Language]
    
    ChooseLang --> Python[Python + OpenAI SDK]
    ChooseLang --> JS[JavaScript + Axios]
    ChooseLang --> PHP[PHP + Guzzle]
    ChooseLang --> Java[Java + OkHttp]
    
    Python --> Build[Build Application]
    JS --> Build
    PHP --> Build
    Java --> Build
    
    Build --> Deploy[Deploy to Container]
    Deploy --> Test[Test in Production]
    
    style Start fill:#e1f5fe
    style Success fill:#c8e6c9
    style Build fill:#fff9c4
```

## Summary

This architecture enables:

1. **Secure Access**: SAML authentication through Azure AD
2. **API Integration**: OpenAI-compatible endpoints for all major languages
3. **Container Management**: Students can run isolated development environments
4. **Model Access**: Direct connection to Ollama-hosted AI models
5. **RAG Capabilities**: Document upload and contextual responses
6. **Scalability**: Traefik routing and Docker orchestration

Students interact with the system by:
1. Authenticating via SAML (automatic with SUNY credentials)
2. Generating an API key through the Dashboard
3. Using that key in their applications to access AI models
4. Optionally deploying their applications as containers on Hydra

The infrastructure handles authentication, routing, model management, and resource allocation transparently, allowing students to focus on building AI-powered applications.