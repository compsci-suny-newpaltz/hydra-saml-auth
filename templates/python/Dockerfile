# Python Development Template
# Includes: Python 3.11, pip, venv, poetry, Jupyter, code-server with Python extensions
FROM hydra-template-base:latest

USER root

# Install Python and development tools
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3.11-venv \
    python3-pip \
    python-is-python3 \
    libpq-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Make Python 3.11 the default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

USER student

# Install Poetry
RUN curl -sSL https://install.python-poetry.org | python3 - && \
    echo 'export PATH="/home/student/.local/bin:$PATH"' >> ~/.bashrc

ENV PATH="/home/student/.local/bin:$PATH"

# Install Jupyter and common Python packages
RUN pip3 install --user --no-cache-dir \
    jupyter \
    jupyterlab \
    notebook \
    ipykernel \
    black \
    flake8 \
    pylint \
    pytest \
    requests \
    httpx

# Install Python extensions for code-server
RUN code-server --install-extension ms-python.python && \
    code-server --install-extension ms-python.pylance && \
    code-server --install-extension ms-toolsai.jupyter && \
    code-server --install-extension njpwerner.autodocstring && \
    code-server --install-extension ms-python.black-formatter

# Copy supervisor configs
COPY --from=hydra-student-container:latest /home/student/supervisor.d/ /home/student/supervisor.d/

USER root
COPY --from=hydra-student-container:latest /etc/supervisor/conf.d/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --from=hydra-student-container:latest /entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER student
WORKDIR /home/student

ENTRYPOINT ["/entrypoint.sh"]
