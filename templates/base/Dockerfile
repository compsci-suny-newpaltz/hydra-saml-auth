# Base template for all student containers
# Provides core functionality: code-server, supervisor, Docker-in-Docker
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/New_York

# Install base packages
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    build-essential \
    sudo \
    supervisor \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CE (for Docker-in-Docker)
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# Create student user
RUN useradd -m -s /bin/bash -u 1000 student && \
    echo "student ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    usermod -aG docker student

# Install nvm and Node.js as student user
USER student
WORKDIR /home/student

ENV NVM_DIR=/home/student/.nvm
ENV NODE_VERSION=20.11.0

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && \
    . "$NVM_DIR/nvm.sh" && \
    nvm install ${NODE_VERSION} && \
    nvm alias default ${NODE_VERSION} && \
    nvm use default

# Add nvm to PATH for all sessions
ENV NODE_PATH=$NVM_DIR/versions/node/v$NODE_VERSION/lib/node_modules
ENV PATH=$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

# Install code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Create supervisor drop-in directory
RUN mkdir -p /home/student/supervisor.d

# Add Python user bin to PATH (for templates that use pip)
ENV PATH=/home/student/.local/bin:$PATH

EXPOSE 8443 8888 9001
WORKDIR /home/student
