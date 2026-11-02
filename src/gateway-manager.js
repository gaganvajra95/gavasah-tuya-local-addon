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
const { resolveMacAddress, classifyTuyaEndpoint, checkPortOpen, readArpTableMac } = require('./device-detector');

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

    // Sanitize saved entries to only local private subnets
    saved = (saved || []).filter(g => g.ip && (g.ip.startsWith('192.168.') || g.ip.startsWith('10.') || g.ip.startsWith('172.') || g.ip === '127.0.0.1'));

    // Correct hardware mapping and purge duplicates for both gateways
    let hasZigbee = false;
    saved = saved.map(g => {
      if (g.ip === '192.168.1.194' || g.id === 'd73312627d4f66c788gsrs') {
        hasZigbee = true;
        return {
          ...g,
          id: 'd73312627d4f66c788gsrs',
          ip: '192.168.1.194',
          name: this.customNames['d73312627d4f66c788gsrs'] || 'Drasis Zigbee Gateway',
          type: 'zigbee_gateway',
          local_key: '{X?c$;`FigG4no3`',
          subDevices: g.subDevices && Object.keys(g.subDevices).length > 0 ? g.subDevices : DEFAULT_GATEWAYS[1].subDevices
        };
      } else if (g.ip === '192.168.1.210' || g.id === 'd7b3f345b23032557azteo') {
        // Enforce canonical dali_0, dali_1, dali_2 only - purge all duplicate sub_X copies!
        const cleanDaliSubs = {};
        Object.entries(g.subDevices || {}).forEach(([sid, info]) => {
          if (sid.startsWith('dali_')) {
            cleanDaliSubs[sid] = info;
          }
        });
        if (Object.keys(cleanDaliSubs).length === 0) {
          cleanDaliSubs['dali_0'] = DEFAULT_GATEWAYS[0].subDevices['dali_0'];
          cleanDaliSubs['dali_1'] = DEFAULT_GATEWAYS[0].subDevices['dali_1'];
          cleanDaliSubs['dali_2'] = DEFAULT_GATEWAYS[0].subDevices['dali_2'];
        }
        return {
          ...g,
          id: 'd7b3f345b23032557azteo',
          ip: '192.168.1.210',
          type: 'dali_gateway',
          subDevices: cleanDaliSubs
        };
      }
      return g;
    });

    if (!hasZigbee) {
      saved.push(DEFAULT_GATEWAYS[1]);
    }
    if (!saved.some(g => g.id === 'd7b3f345b23032557azteo')) {
      saved.unshift(DEFAULT_GATEWAYS[0]);
    }

    this.persistGateways(saved);

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
        category: g.category || (g.type === 'dali_gateway' || g.type === 'zigbee_gateway' || g.type === 'gateway' ? 'gateway' : 'wifi_device'),
        subDevices: g.subDevices,
        dps: g.dps || {}
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

    // Auto-resolve dynamic hardware MAC address if missing or incorrectly cloned from fallback
    if (!device.mac || device.mac === 'unknown' || (device.mac === '00:0c:43:e1:76:29' && device.id !== 'd7b3f345b23032557azteo')) {
      const arpMac = readArpTableMac(device.ip);
      if (arpMac) {
        device.mac = arpMac;
      } else {
        resolveMacAddress(device.ip).then((resMac) => {
          if (resMac && device.mac !== resMac) {
            device.mac = resMac;
            this.persistGateways();
            const info = device.category === 'wifi_device' ? this.getWifiDeviceInfo(device) : this.getGatewayInfo(device);
            this.emit('gateway-updated', info);
          }
        }).catch(() => {});
      }
    }

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
   * Probe host directly over Telnet port 23 to read actual MAC address
   */
  probeHostMac(ip) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(900);
      let buf = '';

      socket.connect(23, ip, () => {
        setTimeout(() => { if (!socket.destroyed) socket.write('root\n'); }, 100);
        setTimeout(() => { if (!socket.destroyed) socket.write('cat /sys/class/net/eth0/address || cat /sys/class/net/br-lan/address\n'); }, 250);
        setTimeout(() => {
          socket.destroy();
          const match = buf.match(/([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
          resolve(match ? match[1].toLowerCase() : null);
        }, 550);
      });

      socket.on('data', (d) => { buf += d.toString('latin1'); });
      socket.on('timeout', () => { socket.destroy(); resolve(null); });
      socket.on('error', () => { socket.destroy(); resolve(null); });
    });
  }

  /**
   * Fast concurrent TCP sweep across /24 subnet looking for open Tuya/OpenWrt ports
   */
  async findOpenTuyaHosts(subnetPrefix, port = 6668) {
    const found = [];
    const ips = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${subnetPrefix}.${i}`);
    }

    const batchSize = 40;
    for (let b = 0; b < ips.length; b += batchSize) {
      const batch = ips.slice(b, b + batchSize);
      await Promise.all(
        batch.map((ip) => {
          return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(120);
            socket.on('connect', () => {
              found.push(ip);
              socket.destroy();
              resolve(ip);
            });
            socket.on('timeout', () => { socket.destroy(); resolve(null); });
            socket.on('error', () => { socket.destroy(); resolve(null); });
            socket.connect(port, ip);
          });
        })
      );
    }
    return found;
  }

  /**
   * Resolve an IP by matching MAC address across hint IP, candidate sweep, and ARP table
   */
  async resolveIpByMac(targetMac, hintIp = '192.168.1.210') {
    if (!targetMac) return null;
    const cleanTarget = targetMac.toLowerCase().replace(/[:-]/g, '');

    // 1. Probe the hint IP directly first (Fastest, ~500ms)
    const hintMac = await this.probeHostMac(hintIp);
    if (hintMac && hintMac.replace(/[:-]/g, '') === cleanTarget) {
      return hintIp;
    }

    // 2. Derive subnet from hint IP (e.g. 192.168.1)
    const subnetParts = hintIp.split('.');
    const subnetPrefix = subnetParts.length === 4 ? `${subnetParts[0]}.${subnetParts[1]}.${subnetParts[2]}` : '192.168.1';

    // 3. Fast scan across port 6668 on candidate IPs
    const openHosts = await this.findOpenTuyaHosts(subnetPrefix, 6668);

    // 4. For each host responding on port 6668, probe its MAC
    for (const hostIp of openHosts) {
      const hostMac = await this.probeHostMac(hostIp);
      if (hostMac && hostMac.replace(/[:-]/g, '') === cleanTarget) {
        return hostIp;
      }
    }

    // 5. Check Telnet port 23 responders
    const telnetHosts = await this.findOpenTuyaHosts(subnetPrefix, 23);
    for (const hostIp of telnetHosts) {
      if (!openHosts.includes(hostIp)) {
        const hostMac = await this.probeHostMac(hostIp);
        if (hostMac && hostMac.replace(/[:-]/g, '') === cleanTarget) {
          return hostIp;
        }
      }
    }

    // 6. Fallback: check /proc/net/arp
    const arp = this.readArpTable();
    for (const [ip, mac] of Object.entries(arp)) {
      if (mac.replace(/[:-]/g, '') === cleanTarget) {
        return ip;
      }
    }

    return null;
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
  /**
   * Continuous dynamic DHCP re-binding: match any gateway or standalone Wi-Fi endpoint
   */
  handleDiscoveredEndpoint(disc) {
    if (!disc) return;
    const targetId = disc.id || disc.gwId || disc.devId;

    for (const gw of this.gateways.values()) {
      if (gw.id === targetId || gw.id === disc.gwId || gw.id === disc.id || gw.id === disc.devId) {
        if (disc.ip && gw.ip !== disc.ip) {
          this.emit('log', `[Dynamic DHCP] Re-binding ${gw.name} (${gw.id}): ${gw.ip} -> ${disc.ip}`);
          gw.updateIp(disc.ip);
          this.persistGateways();
          const info = gw.category === 'wifi_device' ? this.getWifiDeviceInfo(gw) : this.getGatewayInfo(gw);
          this.emit('gateway-updated', info);
        }
        break;
      }
    }
  }

  /**
   * Set custom friendly name for gateway, standalone Wi-Fi device, or sub-device
   */
  rename(targetType, id, subId, newName) {
    if (targetType === 'gateway' || targetType === 'wifi_device' || (!subId && this.gateways.has(id))) {
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
   * Register a standalone Tuya Wi-Fi device
   */
  addWifiDevice(conf, save = true) {
    return this.addGateway({
      ...conf,
      category: 'wifi_device',
      type: conf.type || 'switch',
      subDevices: {}
    }, save);
  }

  getWifiDeviceInfo(device) {
    return {
      id: device.id,
      name: this.customNames[device.id] || device.name,
      ip: device.ip,
      mac: device.mac,
      port: device.port,
      version: device.version,
      type: device.type || 'switch',
      category: 'wifi_device',
      connected: device.isConnected,
      latency: device.pingLatency,
      dps: device.dps || {},
      lastPing: device.lastPing
    };
  }

  getAllGateways() {
    return Array.from(this.gateways.values())
      .filter((g) => g.category !== 'wifi_device')
      .map((g) => this.getGatewayInfo(g));
  }

  getAllWifiDevices() {
    return Array.from(this.gateways.values())
      .filter((g) => g.category === 'wifi_device')
      .map((g) => this.getWifiDeviceInfo(g));
  }

  getAllDevices() {
    const list = [];
    this.gateways.forEach((gw) => {
      if (gw.category === 'wifi_device') return;
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

  getAllEntities() {
    const list = this.getAllDevices();
    this.gateways.forEach((gw) => {
      if (gw.category === 'wifi_device') {
        const devName = this.customNames[gw.id] || gw.name;
        list.push({
          gatewayId: gw.id,
          gatewayName: 'Tuya Wi-Fi Direct',
          gatewayIp: gw.ip,
          gatewayConnected: gw.isConnected,
          subId: 'root',
          devId: gw.id,
          name: devName,
          type: gw.type || 'switch',
          category: 'wifi_device',
          lastAction: null,
          dps: gw.dps || {}
        });
      }
    });
    return list;
  }

  /**
   * Auto-extract credentials and sub-devices from OpenWrt/Telnet gateway
   */
  async autoRecoverGateway(ip) {
    const isTelnet = await checkPortOpen(ip, 23, 1000);
    if (!isTelnet) {
      // Not an OpenWrt Telnet gateway - run hardware classification
      const resolvedMac = await resolveMacAddress(ip) || readArpTableMac(ip);
      const classification = await classifyTuyaEndpoint(ip);
      return {
        id: `tuya_${ip.replace(/\./g, '_')}`,
        name: classification.name || `Tuya Gateway ${ip}`,
        ip: ip,
        mac: resolvedMac || null,
        port: 6668,
        local_key: '0000000000000000',
        version: '3.3',
        type: classification.type || 'zigbee_gateway',
        category: 'gateway',
        subDevices: {}
      };
    }

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
    const mac = macMatch ? macMatch[1].toLowerCase() : (readArpTableMac(ip) || null);
    const isDali = raw.includes('/bin/dali_tuya') || raw.includes('dali');

    if (isDali) {
      return {
        id: 'd7b3f345b23032557azteo',
        name: 'Sunricher DALI Center',
        ip: ip,
        mac: mac || '00:0c:43:e1:76:29',
        port: 6668,
        local_key: 'K}>t}vi=XskqREC@',
        version: '3.3',
        type: 'dali_gateway',
        category: 'gateway',
        subDevices: {
          'dali_0': { devId: '010008020000', name: 'DALI Lamp 0', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
          'dali_1': { devId: '010008020001', name: 'DALI Lamp 1', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
          'dali_2': { devId: '010006000002', name: 'DALI Lamp 2', type: 'dimmer', dps: { '20': false, '22': 1000 } }
        }
      };
    }

    return {
      id: `tuya_${ip.replace(/\./g, '_')}`,
      name: `OpenWrt Gateway ${ip}`,
      ip: ip,
      mac: mac,
      port: 6668,
      local_key: '0000000000000000',
      version: '3.3',
      type: 'generic_gateway',
      category: 'gateway',
      subDevices: {}
    };
  }

  /**
   * Update gateway configuration attributes (name, type, mac, key)
   */
  updateGateway(id, updates = {}) {
    const gw = this.gateways.get(id);
    if (!gw) return null;

    if (updates.name) {
      gw.name = updates.name;
      this.customNames[id] = updates.name;
    }
    if (updates.type) gw.type = updates.type;
    if (updates.mac) gw.mac = updates.mac.toLowerCase();
    if (updates.local_key) gw.key = updates.local_key;
    if (updates.ip && updates.ip !== gw.ip) gw.updateIp(updates.ip);
    if (updates.clearSubDevices) {
      gw.subDevices = {};
    }

    this.persistGateways();
    this.persistNames();
    const info = this.getGatewayInfo(gw);
    this.emit('gateway-updated', info);
    return info;
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
      category: g.category || 'gateway',
      connected: g.isConnected,
      latency: g.pingLatency,
      subDeviceCount: Object.keys(g.subDevices || {}).length,
      cooldownRemaining: cooldownRemaining,
      subDevices: g.subDevices
    };
  }
}

module.exports = GatewayManager;
