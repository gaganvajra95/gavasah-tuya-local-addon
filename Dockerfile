ARG BUILD_FROM=alpine:3.20
FROM ${BUILD_FROM}

# Install Node.js, NPM, Python3, Pillow, and cryptographic dependencies
RUN apk add --no-cache nodejs npm bash python3 py3-pip py3-pillow py3-cryptography py3-requests py3-paho-mqtt
RUN pip install --no-cache-dir --break-system-packages tuya-device-sharing-sdk qrcode tinytuya

WORKDIR /app

# Copy package definition and install dependencies
COPY package.json /app/
RUN npm install --omit=dev

# Copy application source code
COPY . /app/
RUN chmod +x /app/run.sh

EXPOSE 8199
CMD [ "/app/run.sh" ]
