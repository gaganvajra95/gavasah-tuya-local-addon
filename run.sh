#!/bin/bash
set -e

echo "[Tuya LAN] Starting Gavasah Tuya LAN Gateway engine..."

# Load Supervisor options if present
export OPTIONS_PATH="/data/options.json"

cd /app
exec node src/server.js

