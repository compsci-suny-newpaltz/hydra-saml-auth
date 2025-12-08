# Web Development Template
# Includes: Node.js, npm, pnpm, Vue CLI, React, PHP, SQLite, code-server with web extensions
FROM hydra-template-base:latest

USER root

# Install PHP and web development tools
RUN apt-get update && apt-get install -y \
    php8.1 \
    php8.1-cli \
    php8.1-common \
    php8.1-curl \
    php8.1-mbstring \
    php8.1-xml \
    php8.1-zip \
    php8.1-mysql \
    php8.1-pgsql \
    php8.1-sqlite3 \
    sqlite3 \
    nginx \
    && rm -rf /var/lib/apt/lists/*

# Install Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

USER student

# Install pnpm and global npm packages
RUN npm install -g pnpm && \
    npm install -g @vue/cli && \
    npm install -g create-react-app && \
    npm install -g create-next-app && \
    npm install -g vite && \
    npm install -g typescript && \
    npm install -g ts-node && \
    npm install -g eslint && \
    npm install -g prettier

# Install web development extensions for code-server
RUN code-server --install-extension dbaeumer.vscode-eslint && \
    code-server --install-extension esbenp.prettier-vscode && \
    code-server --install-extension Vue.volar && \
    code-server --install-extension dsznajder.es7-react-js-snippets && \
    code-server --install-extension formulahendry.auto-rename-tag && \
    code-server --install-extension bradlc.vscode-tailwindcss && \
    code-server --install-extension Prisma.prisma && \
    code-server --install-extension mtxr.sqltools && \
    code-server --install-extension mtxr.sqltools-driver-sqlite && \
    code-server --install-extension devsense.phptools-vscode && \
    code-server --install-extension ecmel.vscode-html-css

# Copy supervisor configs
COPY --from=hydra-student-container:latest /home/student/supervisor.d/ /home/student/supervisor.d/

USER root
COPY --from=hydra-student-container:latest /etc/supervisor/conf.d/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --from=hydra-student-container:latest /entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER student
WORKDIR /home/student

ENTRYPOINT ["/entrypoint.sh"]
