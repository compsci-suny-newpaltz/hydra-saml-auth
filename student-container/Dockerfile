FROM ubuntu:22.04

# Prevent interactive prompts during installation
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
    python3 \
    python3-pip \
    python3-venv \
    openjdk-21-jdk \
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

# Ensure `python` maps to Python 3 for non-interactive use
RUN apt-get update && apt-get install -y python-is-python3 && rm -rf /var/lib/apt/lists/*

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

# Install Jupyter
RUN pip3 install --user --no-cache-dir \
    jupyter \
    jupyterlab \
    notebook

# Add Python user bin to PATH
ENV PATH=/home/student/.local/bin:$PATH

# Create supervisor drop-in directory and copy template files
RUN mkdir -p /home/student/supervisor.d
COPY supervisor.d/ /home/student/supervisor.d/

# Switch back to root for supervisor setup
USER root

# Copy supervisor configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
EXPOSE 8443 8888 9001

# Set working directory
WORKDIR /home/student

# Append a nice PS1 to the student's bashrc without overwriting existing content
RUN printf '\n# Hydra PS1\nexport PS1="\\[\\e[32m\\]\\u\\[\\e[0m\\]@\\[\\e[34m\\]\\h\\[\\e[0m\\]:\\[\\e[36m\\]\\w\\[\\e[0m\\] \\[\\e[33m\\][\\t]\\[\\e[0m\\]\\n$ "\n' >> /home/student/.bashrc \
 && chown student:student /home/student/.bashrc

# Run entrypoint
ENTRYPOINT ["/entrypoint.sh"]
