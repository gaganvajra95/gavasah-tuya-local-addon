/**
 * GAVASAH Tuya LAN Gateway - Main Server Entrypoint
 * Multi-Gateway Orchestration, Dynamic DHCP Re-binding, MQTT Bridge, and Web Ingress
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const GatewayManager = require('./gateway-manager');
const TuyaDiscovery = require('./tuya-discovery');
const MqttBridge = require('./mqtt-bridge');
const pkg = require('../package.json');

// 1. Initialize Web Express & WebSocket Server (HA Ingress Port 8099)
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Accept WebSocket upgrades for direct access or Ingress paths
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

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
  auto_discover_udp: true
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

console.log('=====================================================');
console.log(`       GAVASAH Tuya LAN Gateway v${pkg.version}       `);
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

// 4. Initialize Gateway Manager
const gatewayMgr = new GatewayManager();

gatewayMgr.on('log', (msg) => {
  console.log(msg);
  broadcastWs({ type: 'log', level: 'TUYA', msg });
});

gatewayMgr.on('raw-packet', (packet) => {
  broadcastWs({ type: 'packet', ...packet });
});

gatewayMgr.on('status', (data) => {
  broadcastWs({
    type: 'state_update',
    gatewayId: data.gateway.id,
    subId: data.subId,
    dps: data.dps
  });
});

gatewayMgr.on('action', (data) => {
  broadcastWs({
    type: 'remote_action',
    gatewayId: data.gateway ? data.gateway.id : data.gatewayId,
    subId: data.subId,
    action: data.action,
    button: data.button,
    dps: data.dps,
    timestamp: data.timestamp
  });
});

gatewayMgr.on('gateway-added', (gw) => {
  mqttBridge.registerGateway(gw);
  broadcastWs({ type: 'gateway_added', gateway: gatewayMgr.getGatewayInfo(gw) });
});

gatewayMgr.on('gateway-updated', (info) => {
  broadcastWs({ type: 'gateway_updated', gateway: info });
});

gatewayMgr.on('new-subdevice', (data) => {
  broadcastWs({ type: 'new_subdevice', ...data });
});

gatewayMgr.on('renamed', (info) => {
  if (info.targetType === 'gateway') {
    const gw = gatewayMgr.gateways.get(info.id);
    if (gw) mqttBridge.publishGatewayDiscovery(gw);
  } else if (info.targetType === 'device') {
    const gw = gatewayMgr.gateways.get(info.id);
    if (gw && gw.subDevices && gw.subDevices[info.subId]) {
      mqttBridge.publishSubDeviceDiscovery(gw, info.subId, gw.subDevices[info.subId]);
    }
  }
  broadcastWs({ type: 'renamed', ...info });
});

// Register existing gateways to MQTT bridge
gatewayMgr.gateways.forEach((gw) => {
  mqttBridge.registerGateway(gw);
});

// 5. Initialize UDP Discovery (Dynamic DHCP re-binding engine)
const discovery = new TuyaDiscovery();
discovery.on('log', (msg) => {
  console.log(msg);
  broadcastWs({ type: 'log', level: 'DISCOVERY', msg });
});

discovery.on('raw-discovery', (disc) => {
  // If IP changed via DHCP, immediately rebind TCP socket
  gatewayMgr.handleDiscoveredEndpoint(disc);
  broadcastWs({ type: 'discovered_endpoint', endpoint: disc });
});

if (options.auto_discover_udp) {
  discovery.start();
}

// REST Endpoints
app.get('/api/gateways', (req, res) => {
  res.json(gatewayMgr.getAllGateways());
});

app.get('/api/devices', (req, res) => {
  res.json(gatewayMgr.getAllDevices());
});

app.get('/api/discovery', (req, res) => {
  res.json(discovery.getDevices());
});

// Hardware Control Endpoint
app.post('/api/control', (req, res) => {
  const { gatewayId, deviceId, subId, dps } = req.body;
  const targetGwId = gatewayId || deviceId || 'd7b3f345b23032557azteo';
  const gw = gatewayMgr.gateways.get(targetGwId) || gatewayMgr.gateways.values().next().value;

  if (!gw) {
    return res.status(404).json({ error: 'Gateway not found' });
  }

  try {
    const targetSub = subId || 'dali_0';
    gw.set(dps, targetSub);
    res.json({ success: true, subId: targetSub, subDevices: gw.subDevices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename Device or Gateway Endpoint
app.post('/api/rename', (req, res) => {
  const { targetType, id, subId, name } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'Missing id or name' });
  }

  try {
    gatewayMgr.rename(targetType || 'device', id, subId, name);
    res.json({ success: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Gateway Endpoint (with automatic key recovery via Telnet/SSH)
app.post('/api/gateway/add', async (req, res) => {
  const { ip, name, type, autoRecover, id, local_key, mac } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'Missing gateway IP address' });
  }

  try {
    let conf = {
      id: id || `tuya_${ip.replace(/\./g, '_')}`,
      name: name || `Gateway ${ip}`,
      ip: ip,
      mac: mac || '00:0c:43:e1:76:29',
      port: 6668,
      local_key: local_key || 'K}>t}vi=XskqREC@',
      version: '3.3',
      type: type || 'dali_gateway'
    };

    if (autoRecover !== false) {
      try {
        console.log(`[Gateway Manager] Auto-recovering credentials from ${ip}...`);
        const recovered = await gatewayMgr.autoRecoverGateway(ip);
        if (recovered) {
          conf = { ...conf, ...recovered };
          if (name) conf.name = name;
        }
      } catch (recErr) {
        console.log(`[Gateway Manager] Auto-recovery skipped: ${recErr.message}`);
      }
    }

    const device = gatewayMgr.addGateway(conf, true);
    res.json({ success: true, gateway: gatewayMgr.getGatewayInfo(device) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Gateway Endpoint
app.post('/api/gateway/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing gateway id' });

  const ok = gatewayMgr.removeGateway(id);
  mqttBridge.unregisterGateway(id);
  res.json({ success: ok });
});

// Rescan Sub-devices for Gateway
app.post('/api/gateway/rescan', async (req, res) => {
  const { id } = req.body;
  const gw = gatewayMgr.gateways.get(id);
  if (!gw) return res.status(404).json({ error: 'Gateway not found' });

  try {
    const recovered = await gatewayMgr.autoRecoverGateway(gw.ip);
    if (recovered && recovered.subDevices) {
      gw.subDevices = { ...gw.subDevices, ...recovered.subDevices };
      gatewayMgr.persistGateways();
      mqttBridge.publishGatewayDiscovery(gw);
    }
    res.json({ success: true, subDevices: gw.subDevices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8099;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ingress] Web UI active on http://0.0.0.0:${PORT}`);
});
