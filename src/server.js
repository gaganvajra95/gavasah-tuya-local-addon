/**
 * GAVASAH Tuya LAN Gateway - Main Server Entrypoint
 * Orchestrates Discovery, TCP Session Management, MQTT Bridge, and Web Ingress
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const TuyaDevice = require('./tuya-device');
const TuyaDiscovery = require('./tuya-discovery');
const MqttBridge = require('./mqtt-bridge');

// 1. Initialize Web Express & WebSocket Server (HA Ingress Port 8099)
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// Broadcast packet and log events to WebSocket clients
function broadcastWs(data) {
  if (!wss || !wss.clients) return;
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      try {
        client.send(payload);
      } catch (e) {}
    }
  });
}

// 2. Read options from Home Assistant Supervisor
let options = {
  mqtt_host: process.env.MQTT_HOST || 'core-mosquitto',
  mqtt_port: parseInt(process.env.MQTT_PORT || '1883', 10),
  mqtt_user: process.env.MQTT_USER || '',
  mqtt_password: process.env.MQTT_PASSWORD || '',
  log_level: 'info',
  auto_discover_udp: true,
  devices: []
};

const optionsPath = process.env.OPTIONS_PATH || '/data/options.json';
if (fs.existsSync(optionsPath)) {
  try {
    const rawOptions = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    options = { ...options, ...rawOptions };
    console.log(`[Config] Loaded options from ${optionsPath}`);
  } catch (err) {
    console.error(`[Config] Failed to parse ${optionsPath}:`, err.message);
  }
}

// Verified configuration for Sunricher DALI Center
const DEFAULT_GATEWAY_CONFIG = {
  id: 'd7b3f345b23032557azteo',
  name: 'Sunricher DALI Center',
  ip: '192.168.1.210',
  port: 6668,
  local_key: 'K}>t}vi=XskqREC@',
  version: '3.3',
  type: 'dali_gateway'
};

if (!options.devices || options.devices.length === 0) {
  options.devices = [DEFAULT_GATEWAY_CONFIG];
} else {
  // Ensure local_key is updated if placeholder was used
  options.devices.forEach((d) => {
    if (!d.local_key || d.local_key === '0000000000000000') {
      d.local_key = 'K}>t}vi=XskqREC@';
      d.id = 'd7b3f345b23032557azteo';
    }
  });
}

console.log('=====================================================');
console.log('       GAVASAH Tuya LAN Gateway v1.0.0               ');
console.log('=====================================================');

// 3. Initialize MQTT Bridge
const mqttBridge = new MqttBridge({
  mqtt_host: options.mqtt_host,
  mqtt_port: options.mqtt_port,
  mqtt_user: options.mqtt_user,
  mqtt_password: options.mqtt_password
});

mqttBridge.on('log', (msg) => {
  console.log(msg);
  broadcastWs({ type: 'log', level: 'MQTT', msg });
});
mqttBridge.connect();

// 4. Initialize Tuya Devices
const activeDevices = new Map();

options.devices.forEach((devConf) => {
  console.log(`[Device] Initializing device: ${devConf.name} (${devConf.ip}:${devConf.port || 6668})`);
  const device = new TuyaDevice(devConf);

  device.on('log', (msg) => {
    console.log(msg);
    broadcastWs({ type: 'log', level: 'TUYA', msg });
  });

  device.on('raw-packet', (packet) => {
    broadcastWs({ type: 'packet', ...packet });
  });

  device.on('status', (data) => {
    broadcastWs({ type: 'state_update', device: device.id, subId: data.subId, dps: data.dps });
  });

  mqttBridge.registerDevice(device);
  activeDevices.set(device.id, device);

  // Initiate TCP connection
  device.connect();
});

// 5. Initialize UDP Auto-Discovery
const discovery = new TuyaDiscovery();
discovery.on('log', (msg) => {
  console.log(msg);
  broadcastWs({ type: 'log', level: 'DISCOVERY', msg });
});
if (options.auto_discover_udp) {
  discovery.start();
}

// REST Endpoints
app.get('/api/devices', (req, res) => {
  const result = Array.from(activeDevices.values()).map((d) => ({
    id: d.id,
    name: d.name,
    ip: d.ip,
    port: d.port,
    version: d.version,
    type: d.type,
    connected: d.isConnected,
    subDevices: d.subDevices,
    dps: d.dps
  }));
  res.json(result);
});

app.get('/api/discovery', (req, res) => {
  res.json(discovery.getDevices());
});

app.post('/api/control', (req, res) => {
  const { deviceId, subId, dps } = req.body;
  const targetId = deviceId || 'd7b3f345b23032557azteo';
  const device = activeDevices.get(targetId) || activeDevices.values().next().value;
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  try {
    const targetSub = subId || 'dali_0';
    device.set(dps, targetSub);
    res.json({ success: true, subId: targetSub, subDevices: device.subDevices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8099;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ingress] Web UI active on http://0.0.0.0:${PORT}`);
});
