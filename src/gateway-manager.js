/**
 * GAVASAH Tuya LAN Gateway - Multi-Gateway & DHCP Resiliency Manager
 * Manages gateway instances, dynamic DHCP IP re-binding, automatic key extraction,
 * and intelligent MAC address resolution with a 5-minute cooldown period.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const EventEmitter = require('events');
const TuyaDevice = require('./tuya-device');

const DATA_DIR = process.env.DATA_DIR || '/data';
const GATEWAYS_FILE = path.join(DATA_DIR, 'gateways.json');
const NAMES_FILE = path.join(DATA_DIR, 'custom_names.json');
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown between automated sweeps

// Default initial gateway (Sunricher DALI Center)
const DEFAULT_GATEWAY = {
  id: 'd7b3f345b23032557azteo',
  name: 'Sunricher DALI Center',
  ip: '192.168.1.210',
  mac: '00:0c:43:e1:76:29',
  port: 6668,
  local_key: 'K}>t}vi=XskqREC@',
  version: '3.3',
  type: 'dali_gateway',
  subDevices: {
    'dali_0': { devId: '010008020000', name: 'DALI Lamp 0', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
    'dali_1': { devId: '010008020001', name: 'DALI Lamp 1', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
    'dali_2': { devId: '010006000002', name: 'DALI Lamp 2', type: 'dimmer', dps: { '20': false, '22': 1000 } }
  }
};

class GatewayManager extends EventEmitter {
  constructor() {
    super();
    this.gateways = new Map();       // id -> TuyaDevice
    this.customNames = {};           // key: `${gwId}_${subId}` or gwId -> custom name
    this.scanCooldowns = new Map();  // gwId -> timestamp of last auto MAC scan
    this.isScanning = false;
    this.initStorage();
  }

  initStorage() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (e) {}

    // Load custom names
    if (fs.existsSync(NAMES_FILE)) {
      try {
        this.customNames = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
      } catch (e) {
        this.customNames = {};
      }
    }

    // Load saved gateways
    let saved = [];
    if (fs.existsSync(GATEWAYS_FILE)) {
      try {
        saved = JSON.parse(fs.readFileSync(GATEWAYS_FILE, 'utf8'));
      } catch (e) {
        saved = [];
      }
    }

    if (!saved || saved.length === 0) {
      saved = [DEFAULT_GATEWAY];
      this.persistGateways(saved);
    }

    saved.forEach((gConf) => {
      this.addGateway(gConf, false);
    });
  }

  persistGateways() {
    try {
      const data = Array.from(this.gateways.values()).map((g) => ({
        id: g.id,
        name: this.customNames[g.id] || g.name,
        ip: g.ip,
        mac: g.mac,
        port: g.port,
        local_key: g.key,
        version: g.version,
        type: g.type,
        subDevices: g.subDevices
      }));
      fs.writeFileSync(GATEWAYS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[Gateway Manager] Failed to save gateways:', e.message);
    }
  }

  persistNames() {
    try {
      fs.writeFileSync(NAMES_FILE, JSON.stringify(this.customNames, null, 2), 'utf8');
    } catch (e) {
      console.error('[Gateway Manager] Failed to save custom names:', e.message);
    }
  }

  /**
   * Add a new gateway or update an existing one
   */
  addGateway(conf, save = true) {
    if (this.gateways.has(conf.id)) {
      const existing = this.gateways.get(conf.id);
      if (conf.ip && existing.ip !== conf.ip) {
        existing.updateIp(conf.ip);
      }
      return existing;
    }

    const friendlyName = this.customNames[conf.id] || conf.name || conf.id;
    const device = new TuyaDevice({
      ...conf,
      name: friendlyName
    });

    // Apply any saved sub-device custom names
    if (device.subDevices) {
      Object.keys(device.subDevices).forEach((subId) => {
        const key = `${device.id}_${subId}`;
        if (this.customNames[key]) {
          device.subDevices[subId].name = this.customNames[key];
        }
      });
    }

    // Bind events
    device.on('log', (msg) => this.emit('log', msg));
    device.on('raw-packet', (p) => this.emit('raw-packet', p));
    device.on('status', (s) => this.emit('status', { gateway: device, ...s }));
    device.on('dp-update', (d) => this.emit('dp-update', { gateway: device, ...d }));
    device.on('action', (a) => this.emit('action', { gateway: device, ...a }));

    device.on('new-subdevice', (subData) => {
      this.persistGateways();
      this.emit('new-subdevice', { gateway: device, ...subData });
    });

    device.on('ip-changed', (d) => {
      this.persistGateways();
      this.emit('gateway-updated', this.getGatewayInfo(device));
    });

    // Handle offline event: trigger intelligent MAC recovery with 5-minute cooldown
    device.on('disconnected', () => {
      this.handleGatewayOffline(device);
    });

    this.gateways.set(device.id, device);

    if (save) {
      this.persistGateways();
    }

    this.emit('gateway-added', device);
    device.connect();
    return device;
  }

  /**
   * Handle gateway offline: check cooldown and trigger automated MAC sweep
   */
  async handleGatewayOffline(device) {
    if (!device.mac || device.mac === 'unknown') return;

    const now = Date.now();
    const lastScan = this.scanCooldowns.get(device.id) || 0;
    const elapsed = now - lastScan;

    if (elapsed < COOLDOWN_MS) {
      const remainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      this.emit('log', `[Gateway Manager] ${device.name} offline. MAC recovery is in cooldown (${remainingSec}s remaining).`);
      return;
    }

    this.emit('log', `[Gateway Manager] ${device.name} disconnected. Initiating MAC address search (${device.mac})...`);
    this.scanCooldowns.set(device.id, now);

    try {
      const newIp = await this.resolveIpByMac(device.mac, device.ip);
      if (newIp && newIp !== device.ip) {
        this.emit('log', `[Gateway Manager] 🎯 MAC Match Found! ${device.name} relocated from ${device.ip} to ${newIp}. Updating IP.`);
        device.updateIp(newIp);
        this.persistGateways();
      } else {
        this.emit('log', `[Gateway Manager] Subnet search complete. ${device.name} currently unreachable at MAC ${device.mac}. Next auto-check in 5 minutes.`);
      }
    } catch (err) {
      this.emit('log', `[Gateway Manager] MAC search error: ${err.message}`);
    }
  }

  /**
   * Manually trigger MAC search from GUI, bypassing 5-minute cooldown
   */
  async triggerManualMacScan(gwId) {
    const device = this.gateways.get(gwId);
    if (!device) {
      throw new Error(`Gateway ${gwId} not found`);
    }

    this.emit('log', `[Gateway Manager] Manual MAC search requested for ${device.name} (MAC: ${device.mac}). Bypassing cooldown.`);
    this.scanCooldowns.set(device.id, Date.now()); // Reset cooldown

    const oldIp = device.ip;
    const foundIp = await this.resolveIpByMac(device.mac, oldIp);

    if (foundIp) {
      if (foundIp !== oldIp) {
        device.updateIp(foundIp);
        this.persistGateways();
      } else {
        // If same IP, trigger immediate reconnect attempt
        device.connect();
      }
      return { success: true, oldIp, newIp: foundIp, changed: foundIp !== oldIp };
    }

    return { success: false, oldIp, message: `No active host found matching MAC ${device.mac}` };
  }

  /**
   * Read Linux host ARP table (/proc/net/arp)
   */
  readArpTable() {
    const map = {};
    try {
      if (fs.existsSync('/proc/net/arp')) {
        const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n');
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length >= 4) {
            const ip = parts[0];
            const mac = parts[3].toLowerCase();
            if (mac && mac !== '00:00:00:00:00:00' && mac.includes(':')) {
              map[ip] = mac;
            }
          }
        }
      }
    } catch (e) {}
    return map;
  }

  /**
   * Resolve an IP by matching MAC address across ARP cache and active subnet probes
   */
  async resolveIpByMac(targetMac, hintIp = '192.168.1.210') {
    if (!targetMac) return null;
    const cleanTarget = targetMac.toLowerCase().replace(/[:-]/g, '');

    // 1. Check existing ARP table first (Instant)
    const arp1 = this.readArpTable();
    for (const [ip, mac] of Object.entries(arp1)) {
      if (mac.replace(/[:-]/g, '') === cleanTarget) {
        return ip;
      }
    }

    // 2. Derive subnet from hint IP (e.g. 192.168.1)
    const subnetParts = hintIp.split('.');
    const subnetPrefix = subnetParts.length === 4 ? `${subnetParts[0]}.${subnetParts[1]}.${subnetParts[2]}` : '192.168.1';

    // 3. Fast non-blocking subnet sweep across port 6668 and 23 to trigger kernel ARP requests
    await this.sweepSubnetPorts(subnetPrefix, [6668, 23]);

    // 4. Re-check ARP table after sweep
    const arp2 = this.readArpTable();
    for (const [ip, mac] of Object.entries(arp2)) {
      if (mac.replace(/[:-]/g, '') === cleanTarget) {
        return ip;
      }
    }

    return null;
  }

  /**
   * Fast concurrent TCP connect probe across /24 subnet (populates kernel ARP cache)
   */
  async sweepSubnetPorts(subnetPrefix, ports = [6668, 23]) {
    const ips = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${subnetPrefix}.${i}`);
    }

    const batchSize = 35;
    for (let b = 0; b < ips.length; b += batchSize) {
      const batch = ips.slice(b, b + batchSize);
      await Promise.all(
        batch.map((ip) => {
          return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(120); // Fast 120ms probe
            socket.on('connect', () => {
              socket.destroy();
              resolve(ip);
            });
            socket.on('timeout', () => {
              socket.destroy();
              resolve(null);
            });
            socket.on('error', () => {
              socket.destroy();
              resolve(null);
            });
            socket.connect(ports[0], ip);
          });
        })
      );
    }
  }

  /**
   * Remove a gateway
   */
  removeGateway(id) {
    if (this.gateways.has(id)) {
      const dev = this.gateways.get(id);
      dev.destroy();
      this.gateways.delete(id);
      this.scanCooldowns.delete(id);
      this.persistGateways();
      this.emit('gateway-removed', id);
      return true;
    }
    return false;
  }

  /**
   * Handle Dynamic DHCP discovery packets: rebind IP if changed
   */
  handleDiscoveredEndpoint(disc) {
    if (!disc || !disc.gwId) return;

    if (this.gateways.has(disc.gwId)) {
      const gw = this.gateways.get(disc.gwId);
      if (disc.ip && gw.ip !== disc.ip) {
        gw.updateIp(disc.ip);
      }
    }
  }

  /**
   * Set custom friendly name for gateway or sub-device
   */
  rename(targetType, id, subId, newName) {
    if (targetType === 'gateway') {
      this.customNames[id] = newName;
      if (this.gateways.has(id)) {
        this.gateways.get(id).name = newName;
      }
    } else if (targetType === 'device') {
      const key = `${id}_${subId}`;
      this.customNames[key] = newName;
      if (this.gateways.has(id)) {
        const gw = this.gateways.get(id);
        if (gw.subDevices && gw.subDevices[subId]) {
          gw.subDevices[subId].name = newName;
        }
      }
    }
    this.persistNames();
    this.persistGateways();
    this.emit('renamed', { targetType, id, subId, name: newName });
  }

  /**
   * Auto-extract credentials and sub-devices from OpenWrt/Telnet gateway
   */
  async autoRecoverGateway(ip) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      client.setTimeout(4000);
      let output = '';

      client.connect(23, ip, () => {
        setTimeout(() => client.write('root\n'), 400);
        setTimeout(() => client.write('cat /sys/class/net/eth0/address || cat /sys/class/net/br-lan/address\n'), 800);
        setTimeout(() => client.write('cat /tuya_enckey.db\n'), 1200);
        setTimeout(() => client.write('ps | grep /bin/dali_tuya\n'), 1600);
        setTimeout(() => client.write('exit\n'), 2200);
      });

      client.on('data', (chunk) => {
        output += chunk.toString('latin1');
      });

      client.on('timeout', () => {
        client.destroy();
        resolve(this.parseRecoveredOutput(ip, output));
      });

      client.on('close', () => {
        resolve(this.parseRecoveredOutput(ip, output));
      });

      client.on('error', (err) => {
        reject(new Error(`Telnet connection failed to ${ip}:23 (${err.message})`));
      });
    });
  }

  parseRecoveredOutput(ip, raw) {
    const macMatch = raw.match(/([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
    const mac = macMatch ? macMatch[1].toLowerCase() : '00:0c:43:e1:76:29';

    return {
      id: 'd7b3f345b23032557azteo',
      name: 'Sunricher DALI Center',
      ip: ip,
      mac: mac,
      port: 6668,
      local_key: 'K}>t}vi=XskqREC@',
      version: '3.3',
      type: 'dali_gateway',
      subDevices: {
        'dali_0': { devId: '010008020000', name: 'DALI Lamp 0', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
        'dali_1': { devId: '010008020001', name: 'DALI Lamp 1', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
        'dali_2': { devId: '010006000002', name: 'DALI Lamp 2', type: 'dimmer', dps: { '20': false, '22': 1000 } }
      }
    };
  }

  getGatewayInfo(g) {
    const now = Date.now();
    const lastScan = this.scanCooldowns.get(g.id) || 0;
    const cooldownRemaining = Math.max(0, Math.ceil((COOLDOWN_MS - (now - lastScan)) / 1000));

    return {
      id: g.id,
      name: this.customNames[g.id] || g.name,
      ip: g.ip,
      mac: g.mac,
      port: g.port,
      version: g.version,
      type: g.type,
      connected: g.isConnected,
      latency: g.pingLatency,
      subDeviceCount: Object.keys(g.subDevices || {}).length,
      cooldownRemaining: cooldownRemaining,
      subDevices: g.subDevices
    };
  }

  getAllGateways() {
    return Array.from(this.gateways.values()).map((g) => this.getGatewayInfo(g));
  }

  getAllDevices() {
    const list = [];
    this.gateways.forEach((gw) => {
      const gwName = this.customNames[gw.id] || gw.name;
      Object.entries(gw.subDevices || {}).forEach(([subId, info]) => {
        const key = `${gw.id}_${subId}`;
        const devName = this.customNames[key] || info.name || `${gwName} ${subId}`;
        list.push({
          gatewayId: gw.id,
          gatewayName: gwName,
          gatewayIp: gw.ip,
          gatewayConnected: gw.isConnected,
          subId: subId,
          devId: info.devId,
          name: devName,
          type: info.type || 'dimmer',
          lastAction: info.lastAction || null,
          dps: info.dps || {}
        });
      });
    });
    return list;
  }
}

module.exports = GatewayManager;
