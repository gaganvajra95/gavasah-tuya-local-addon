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

// Read options from Home Assistant Supervisor
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

// Ensure default configuration for Sunricher DALI IP gateway at 192.168.1.210 if empty
if (!options.devices || options.devices.length === 0) {
  options.devices = [
    {
      id: 'sunricher_dali_210',
      name: 'Sunricher DALI Center',
      ip: '192.168.1.210',
      port: 6668,
      local_key: '0000000000000000',
      version: '3.3',
      type: 'dali_gateway'
    }
  ];
}

console.log('=====================================================');
console.log('       GAVASAH Tuya LAN Gateway v1.0.0               ');
console.log('=====================================================');

// 1. Initialize MQTT Bridge
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

// 2. Initialize Tuya Devices
const activeDevices = new Map();

options.devices.forEach((devConf) => {
  console.log(`[Device] Initializing device: ${devConf.name} (${devConf.ip}:${devConf.port || 6668})`);
  const device = new TuyaDevice(devConf);

  device.on('log', (msg) => {
    console.log(msg);
    broadcastWs({ type: 'log', level: 'TUYA', msg });
  });

  mqttBridge.registerDevice(device);
  activeDevices.set(device.id, device);

  // Initiate TCP connection
  device.connect();
});

// 3. Initialize UDP Auto-Discovery
const discovery = new TuyaDiscovery();
discovery.on('log', (msg) => {
  console.log(msg);
  broadcastWs({ type: 'log', level: 'DISCOVERY', msg });
});
if (options.auto_discover_udp) {
  discovery.start();
}

// 4. Initialize Web Express & WebSocket Server (HA Ingress Port 8099)
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

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
    dps: d.dps
  }));
  res.json(result);
});

app.get('/api/discovery', (req, res) => {
  res.json(discovery.getDevices());
});

app.post('/api/control', (req, res) => {
  const { deviceId, subId, dps, query } = req.body;
  const targetId = deviceId || 'sunricher_dali_210';
  const device = activeDevices.get(targetId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  try {
    if (query) {
      device.query();
      return res.json({ success: true, queried: true });
    }
    device.set(dps, subId);
    res.json({ success: true, dps: device.dps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Broadcast packet events to WebSocket clients
function broadcastWs(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// Wire packet stream to WebSocket
activeDevices.forEach((device) => {
  device.on('raw-packet', (packet) => {
    broadcastWs({ type: 'packet', ...packet });
  });

  device.on('status', (data) => {
    broadcastWs({ type: 'state_update', device: device.id, dps: data.dps });
  });
});

const PORT = process.env.PORT || 8099;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ingress] Web UI active on http://0.0.0.0:${PORT}`);
});
