/**
 * GAVASAH Tuya LAN Gateway - Main Server Entrypoint
 * Multi-Gateway Orchestration, Dynamic DHCP Re-binding, MQTT Bridge, and Web Ingress
 * Supports both Gateways (DALI, Zigbee) and Standalone Tuya Wi-Fi Devices
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const GatewayManager = require('./gateway-manager');
const TuyaDiscovery = require('./tuya-discovery');
const MqttBridge = require('./mqtt-bridge');
const { resolveMacAddress, classifyTuyaEndpoint } = require('./device-detector');
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
    gatewayId: data.gateway ? data.gateway.id : data.id,
    subId: data.subId || 'root',
    category: (data.gateway && data.gateway.category) || data.category || 'gateway',
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
  const info = gw.category === 'wifi_device' ? gatewayMgr.getWifiDeviceInfo(gw) : gatewayMgr.getGatewayInfo(gw);
  broadcastWs({ type: 'gateway_added', gateway: info });
});

gatewayMgr.on('gateway-updated', (info) => {
  broadcastWs({ type: 'gateway_updated', gateway: info });
});

gatewayMgr.on('new-subdevice', (data) => {
  broadcastWs({ type: 'new_subdevice', ...data });
});

gatewayMgr.on('renamed', (info) => {
  const gw = gatewayMgr.gateways.get(info.id);
  if (gw) {
    if (gw.category === 'wifi_device' || info.targetType === 'wifi_device') {
      mqttBridge.publishWifiDeviceDiscovery(gw);
      mqttBridge.publishDeviceState(gw, 'root');
    } else if (info.targetType === 'gateway') {
      mqttBridge.publishGatewayDiscovery(gw);
    } else if (info.targetType === 'device') {
      if (gw.subDevices && gw.subDevices[info.subId]) {
        mqttBridge.publishSubDeviceDiscovery(gw, info.subId, gw.subDevices[info.subId]);
        mqttBridge.publishDeviceState(gw, info.subId);
      }
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

discovery.on('discovered', (disc) => {
  gatewayMgr.handleDiscoveredEndpoint(disc);
  broadcastWs({ type: 'discovered_endpoint', endpoint: disc });
});

discovery.on('raw-discovery', (disc) => {
  gatewayMgr.handleDiscoveredEndpoint(disc);
});

if (options.auto_discover_udp) {
  discovery.start();
}

// REST Endpoints
app.get('/api/gateways', (req, res) => {
  res.json(gatewayMgr.getAllGateways());
});

app.get('/api/wifi/devices', (req, res) => {
  res.json(gatewayMgr.getAllWifiDevices());
});

app.get('/api/devices', (req, res) => {
  res.json(gatewayMgr.getAllDevices());
});

app.get('/api/entities', (req, res) => {
  res.json(gatewayMgr.getAllEntities());
});

app.get('/api/discovery', (req, res) => {
  res.json(discovery.getDevices());
});

// Hardware Control Endpoint
app.post('/api/control', (req, res) => {
  const { gatewayId, deviceId, subId, dps } = req.body;
  const targetId = deviceId || gatewayId;
  let dev = gatewayMgr.gateways.get(targetId);

  if (!dev) {
    for (const g of gatewayMgr.gateways.values()) {
      if (g.subDevices && (g.subDevices[targetId] || (subId && g.subDevices[subId]))) {
        dev = g;
        break;
      }
    }
  }

  if (!dev) {
    dev = gatewayMgr.gateways.values().next().value;
  }

  if (!dev) {
    return res.status(404).json({ error: 'Device or Gateway not found' });
  }

  try {
    if (dev.category === 'wifi_device') {
      dev.set(dps);
      res.json({ success: true, dps: dev.dps });
    } else {
      const targetSub = subId || 'dali_0';
      dev.set(dps, targetSub);
      res.json({ success: true, subId: targetSub, subDevices: dev.subDevices });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Query Device Status on Demand
app.post('/api/device/query', (req, res) => {
  const { id, subId } = req.body;
  const dev = gatewayMgr.gateways.get(id);
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  try {
    dev.queryStatus(subId);
    res.json({ success: true, dps: dev.dps });
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

// Commission Gateway Endpoint (with automatic hardware detection & key recovery)
app.post('/api/gateway/add', async (req, res) => {
  const { ip, name, type, autoRecover, id, local_key, mac, productKey } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'Missing gateway IP address' });
  }

  try {
    // 1. Dynamic Hardware Classification & MAC Resolution
    let resolvedMac = mac;
    if (!resolvedMac || (resolvedMac === '00:0c:43:e1:76:29' && ip !== '192.168.1.210')) {
      resolvedMac = await resolveMacAddress(ip);
    }

    let detectedType = type;
    let detectedName = name;
    if (!detectedType) {
      const classification = await classifyTuyaEndpoint(ip, productKey);
      detectedType = classification.type || 'zigbee_gateway';
      if (!detectedName) detectedName = classification.name;
    }

    let conf = {
      id: id || `tuya_${ip.replace(/\./g, '_')}`,
      name: detectedName || `Gateway ${ip}`,
      ip: ip,
      mac: resolvedMac || 'unknown',
      port: 6668,
      local_key: local_key || 'K}>t}vi=XskqREC@',
      version: '3.3',
      type: detectedType || 'zigbee_gateway',
      category: 'gateway',
      subDevices: detectedType === 'dali_gateway' ? undefined : {}
    };

    if (autoRecover !== false) {
      try {
        console.log(`[Gateway Manager] Auto-recovering credentials from ${ip}...`);
        const recovered = await gatewayMgr.autoRecoverGateway(ip);
        if (recovered) {
          conf = { ...conf, ...recovered };
          if (name) conf.name = name;
          if (type) conf.type = type;
          if (mac) conf.mac = mac;
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

// Update Gateway Configuration (Name, Type, MAC, Local Key)
app.post('/api/gateway/update', (req, res) => {
  const { id, name, type, mac, local_key, ip, clearSubDevices } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing gateway id' });

  const updated = gatewayMgr.updateGateway(id, { name, type, mac, local_key, ip, clearSubDevices });
  if (!updated) return res.status(404).json({ error: 'Gateway not found' });
  res.json({ success: true, gateway: updated });
});

// Delete Gateway Endpoint
app.post('/api/gateway/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing gateway id' });

  const ok = gatewayMgr.removeGateway(id);
  mqttBridge.unregisterGateway(id);
  res.json({ success: ok });
});

// Commission Standalone Tuya Wi-Fi Device Endpoint
app.post('/api/wifi/add', async (req, res) => {
  const { ip, name, id, local_key, mac, version, type, productKey } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'Missing device IP address' });
  }

  try {
    let resolvedMac = mac;
    if (!resolvedMac || resolvedMac === '00:00:00:00:00:00') {
      resolvedMac = await resolveMacAddress(ip);
    }

    const devConf = {
      id: id || `tuya_wifi_${ip.replace(/\./g, '_')}`,
      name: name || `WiFi Device ${ip}`,
      ip: ip,
      mac: resolvedMac || 'unknown',
      port: 6668,
      local_key: local_key || '0000000000000000',
      version: version || '3.3',
      type: type || 'switch',
      category: 'wifi_device'
    };

    const device = gatewayMgr.addWifiDevice(devConf, true);
    res.json({ success: true, device: gatewayMgr.getWifiDeviceInfo(device) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Standalone Tuya Wi-Fi Device Endpoint
app.post('/api/wifi/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing device id' });

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

// Resolve Gateway IP by MAC Address (Manual Trigger & Override)
app.post('/api/gateway/resolve-mac', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing gateway id' });

  try {
    const result = await gatewayMgr.triggerManualMacScan(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8199;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Ingress] Web UI active on http://0.0.0.0:${PORT}`);
});
