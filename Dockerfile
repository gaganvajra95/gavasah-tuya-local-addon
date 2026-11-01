ARG BUILD_FROM=alpine:3.20
FROM ${BUILD_FROM}

# Install Node.js, NPM, and Bash
RUN apk add --no-cache nodejs npm bash

WORKDIR /app

# Copy package definition and install dependencies
COPY package.json /app/
RUN npm install --omit=dev

# Copy application source code
COPY . /app/
RUN chmod +x /app/run.sh

EXPOSE 8099
CMD [ "/app/run.sh" ]
