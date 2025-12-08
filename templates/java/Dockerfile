# Java Development Template
# Includes: OpenJDK 21, Maven, Gradle, Node.js, code-server with Java extensions
FROM hydra-template-base:latest

USER root

# Install Java development tools
RUN apt-get update && apt-get install -y \
    openjdk-21-jdk \
    maven \
    && rm -rf /var/lib/apt/lists/*

# Install Gradle
ENV GRADLE_VERSION=8.5
RUN curl -fsSL https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -o gradle.zip && \
    unzip -d /opt gradle.zip && \
    rm gradle.zip && \
    ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle

# Set Java environment
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV PATH=$JAVA_HOME/bin:$PATH

USER student

# Install Java extensions for code-server
RUN code-server --install-extension vscjava.vscode-java-pack && \
    code-server --install-extension vmware.vscode-spring-boot && \
    code-server --install-extension vscjava.vscode-gradle && \
    code-server --install-extension vscjava.vscode-maven && \
    code-server --install-extension mtxr.sqltools && \
    code-server --install-extension mtxr.sqltools-driver-mysql && \
    code-server --install-extension mtxr.sqltools-driver-pg

# Copy supervisor configs from base student-container
COPY --from=hydra-student-container:latest /home/student/supervisor.d/ /home/student/supervisor.d/

USER root
COPY --from=hydra-student-container:latest /etc/supervisor/conf.d/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --from=hydra-student-container:latest /entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER student
WORKDIR /home/student

ENTRYPOINT ["/entrypoint.sh"]
