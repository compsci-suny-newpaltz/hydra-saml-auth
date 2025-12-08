# Data Science Template
# Includes: Python 3.11, Jupyter, pandas, numpy, scikit-learn, matplotlib, code-server with data science extensions
FROM hydra-template-base:latest

USER root

# Install Python and data science dependencies
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3.11-venv \
    python3-pip \
    python-is-python3 \
    libpq-dev \
    libffi-dev \
    libhdf5-dev \
    libblas-dev \
    liblapack-dev \
    gfortran \
    && rm -rf /var/lib/apt/lists/*

# Make Python 3.11 the default
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

USER student

# Install data science Python packages
RUN pip3 install --user --no-cache-dir \
    jupyter \
    jupyterlab \
    notebook \
    ipykernel \
    pandas \
    numpy \
    scipy \
    scikit-learn \
    matplotlib \
    seaborn \
    plotly \
    bokeh \
    altair \
    statsmodels \
    xgboost \
    lightgbm \
    tensorflow \
    torch \
    torchvision \
    transformers \
    opencv-python-headless \
    pillow \
    sqlalchemy \
    psycopg2-binary \
    requests \
    httpx \
    beautifulsoup4 \
    lxml

# Install data science extensions for code-server
RUN code-server --install-extension ms-python.python && \
    code-server --install-extension ms-python.pylance && \
    code-server --install-extension ms-toolsai.jupyter && \
    code-server --install-extension ms-toolsai.datawrangler && \
    code-server --install-extension RandomFractalsInc.vscode-data-preview && \
    code-server --install-extension mechatroner.rainbow-csv && \
    code-server --install-extension GrapeCity.gc-excelviewer

# Copy supervisor configs
COPY --from=hydra-student-container:latest /home/student/supervisor.d/ /home/student/supervisor.d/

USER root
COPY --from=hydra-student-container:latest /etc/supervisor/conf.d/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --from=hydra-student-container:latest /entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER student
WORKDIR /home/student

ENTRYPOINT ["/entrypoint.sh"]
