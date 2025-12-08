# DevOps Template
# Includes: Docker, kubectl, Terraform, Ansible, Helm, code-server with DevOps extensions
FROM hydra-template-base:latest

USER root

# Install DevOps tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python-is-python3 \
    jq \
    yq \
    && rm -rf /var/lib/apt/lists/*

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl && \
    rm kubectl

# Install Helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Install Terraform
ENV TERRAFORM_VERSION=1.6.6
RUN curl -fsSL https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip -o terraform.zip && \
    unzip terraform.zip && \
    mv terraform /usr/local/bin/ && \
    rm terraform.zip

# Install k9s
RUN curl -sS https://webi.sh/k9s | sh && \
    mv ~/.local/bin/k9s /usr/local/bin/

USER student

# Install Ansible via pip
RUN pip3 install --user --no-cache-dir \
    ansible \
    ansible-lint \
    molecule

# Install DevOps extensions for code-server
RUN code-server --install-extension ms-azuretools.vscode-docker && \
    code-server --install-extension ms-kubernetes-tools.vscode-kubernetes-tools && \
    code-server --install-extension redhat.vscode-yaml && \
    code-server --install-extension hashicorp.terraform && \
    code-server --install-extension redhat.ansible && \
    code-server --install-extension timonwong.shellcheck && \
    code-server --install-extension foxundermoon.shell-format

# Copy supervisor configs
COPY --from=hydra-student-container:latest /home/student/supervisor.d/ /home/student/supervisor.d/

USER root
COPY --from=hydra-student-container:latest /etc/supervisor/conf.d/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --from=hydra-student-container:latest /entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER student
WORKDIR /home/student

ENTRYPOINT ["/entrypoint.sh"]
