ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-nodejs:latest
FROM ${BUILD_FROM}

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Set working directory
WORKDIR /app

# Copy package definition and install production dependencies
COPY package.json /app/
RUN npm install --only=production

# Copy application source code
COPY src /app/src

# Copy rootfs (s6-overlay service definitions and entrypoints)
COPY rootfs /

# Set executable permissions on service runner
RUN chmod +x /etc/s6-overlay/s6-rc.d/gavasah-tuya-local/run

# Expose Ingress Web UI port
EXPOSE 8099
