# =============================================================================
# Hydra Student Container - Optimized Multi-Stage Build
# Build with: docker build -t hydra-student-container:latest .
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build LCC VS Code extension
# -----------------------------------------------------------------------------
FROM node:20-slim AS lcc-builder

RUN npm install -g @vscode/vsce && \
    apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 https://github.com/lettucegoblin/vscode-lcc.git . && \
    npm ci --omit=dev && \
    vsce package --allow-missing-repository && \
    mv *.vsix /lcc-tools.vsix

# -----------------------------------------------------------------------------
# Stage 2: Final image
# -----------------------------------------------------------------------------
FROM ubuntu:22.04

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/New_York

# Install all apt packages in a single layer with --no-install-recommends
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core utilities
    git \
    curl \
    wget \
    sudo \
    supervisor \
    ca-certificates \
    gnupg \
    lsb-release \
    # SSH server for direct terminal access
    openssh-server \
    # Build tools
    build-essential \
    gcc \
    g++ \
    gdb \
    cmake \
    make \
    clangd \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    python-is-python3 \
    # Java (full JDK for compilation)
    openjdk-21-jdk \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Configure SSH server
RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    echo "AllowUsers student" >> /etc/ssh/sshd_config

# Install Docker CLI only (no daemon - uses host's Docker socket)
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        docker-ce-cli \
        docker-buildx-plugin \
        docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Create student user with docker group access
RUN groupadd -f docker && \
    useradd -m -s /bin/bash -u 1000 student && \
    echo "student ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    usermod -aG docker student

# Switch to student user for remaining installs
USER student
WORKDIR /home/student

# Install nvm, Node.js, and pnpm (single layer)
ENV NVM_DIR=/home/student/.nvm
ENV NODE_VERSION=20.11.0

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && \
    . "$NVM_DIR/nvm.sh" && \
    nvm install ${NODE_VERSION} && \
    nvm alias default ${NODE_VERSION} && \
    nvm use default && \
    npm install -g pnpm && \
    # Clean npm cache
    npm cache clean --force && \
    rm -rf /home/student/.npm/_cacache

ENV NODE_PATH=$NVM_DIR/versions/node/v$NODE_VERSION/lib/node_modules
ENV PATH=$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

# Install code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh && \
    rm -rf /tmp/*

# Copy extension list and settings
COPY code-server/extensions.txt /tmp/extensions.txt
COPY code-server/settings.json /tmp/default-settings.json

# Install VS Code extensions (skip comments/empty lines, continue on failure)
RUN while IFS= read -r ext || [ -n "$ext" ]; do \
      case "$ext" in \#*|"") continue ;; esac; \
      echo "Installing extension: $ext"; \
      code-server --install-extension "$ext" || true; \
    done < /tmp/extensions.txt && \
    # Clean extension download cache
    rm -rf /home/student/.local/share/code-server/CachedExtensionVSIXs

# Copy pre-built LCC extension from builder stage and install
COPY --from=lcc-builder /lcc-tools.vsix /tmp/lcc-tools.vsix
RUN code-server --install-extension /tmp/lcc-tools.vsix && \
    rm -f /tmp/lcc-tools.vsix || true

# Setup code-server settings
RUN mkdir -p /home/student/.local/share/code-server/User && \
    cp /tmp/default-settings.json /home/student/.local/share/code-server/User/settings.json

# Switch to root to install Jupyter system-wide
USER root

# Install Jupyter system-wide (not --user, so it works on mounted volumes)
RUN pip3 install --no-cache-dir \
    jupyter \
    jupyterlab \
    notebook

USER student

# Create supervisor drop-in directory
RUN mkdir -p /home/student/supervisor.d
COPY supervisor.d/ /home/student/supervisor.d/

# Switch to root for final setup
USER root

# Setup /etc/skel for fresh volumes and supervisor config
# Copy settings and extensions to skel so they persist on mounted volumes
RUN mkdir -p /etc/skel/.local/share/code-server/User && \
    cp /tmp/default-settings.json /etc/skel/.local/share/code-server/User/settings.json && \
    # Copy installed extensions to skel
    cp -r /home/student/.local/share/code-server/extensions /etc/skel/.local/share/code-server/ && \
    rm -rf /tmp/*

# Install CUH63 tools (lcc compiler, assembler, examples)
COPY cuh63.zip /tmp/cuh63.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip && \
    rm -rf /var/lib/apt/lists/* && \
    # Extract to system-wide location
    mkdir -p /opt/cuh63 && \
    unzip -q /tmp/cuh63.zip -d /opt/cuh63 && \
    # Move contents up if nested in folder
    if [ -d "/opt/cuh63/cuh63Linux" ]; then \
        mv /opt/cuh63/cuh63Linux/* /opt/cuh63/ && \
        rmdir /opt/cuh63/cuh63Linux; \
    fi && \
    # Use Linux binaries from lnx/ subdirectory (not Windows .exe)
    chmod +x /opt/cuh63/lnx/* && \
    # Create symlinks to Linux binaries in /usr/local/bin for PATH access
    ln -sf /opt/cuh63/lnx/b /usr/local/bin/lcc-b && \
    ln -sf /opt/cuh63/lnx/basic /usr/local/bin/lcc-basic && \
    ln -sf /opt/cuh63/lnx/lcc /usr/local/bin/lcc && \
    ln -sf /opt/cuh63/lnx/linker /usr/local/bin/lcc-linker && \
    ln -sf /opt/cuh63/lnx/sim /usr/local/bin/lcc-sim && \
    ln -sf /opt/cuh63/lnx/micro /usr/local/bin/lcc-micro && \
    ln -sf /opt/cuh63/lnx/see /usr/local/bin/lcc-see && \
    # Also copy to /etc/skel so users get it in home directory
    mkdir -p /etc/skel/cuh63 && \
    cp -r /opt/cuh63/* /etc/skel/cuh63/ && \
    chown -R root:root /etc/skel/cuh63 && \
    chmod -R 755 /etc/skel/cuh63 && \
    rm /tmp/cuh63.zip

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports: SSH, code-server, jupyter, supervisor
EXPOSE 22 8443 8888 9001

WORKDIR /home/student
ENTRYPOINT ["/entrypoint.sh"]
