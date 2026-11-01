/**
 * GAVASAH Tuya LAN Gateway - UDP Auto-Discovery Service
 * Listens for Tuya endpoints broadcasting on UDP 6666 and 6667
 */

const dgram = require('dgram');
const EventEmitter = require('events');
const { DEFAULT_UDP_KEY, decryptECB } = require('./tuya-cipher');

class TuyaDiscovery extends EventEmitter {
  constructor() {
    super();
    this.discoveredDevices = new Map();
    this.sockets = [];
  }

  /**
   * Start listening on UDP ports 6666 and 6667
   */
  start() {
    [6666, 6667].forEach((port) => {
      try {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('message', (msg, rinfo) => {
          this.parseDiscoveryMessage(msg, rinfo, port);
        });

        socket.on('error', (err) => {
          this.emit('log', `[UDP Discovery] Port ${port} error: ${err.message}`);
        });

        socket.bind(port, () => {
          this.emit('log', `[UDP Discovery] Listening for Tuya broadcasts on UDP port ${port}`);
        });

        this.sockets.push(socket);
      } catch (err) {
        this.emit('log', `[UDP Discovery] Failed to bind port ${port}: ${err.message}`);
      }
    });
  }

  /**
   * Process raw UDP broadcast frame
   */
  parseDiscoveryMessage(msg, rinfo, port) {
    if (msg.length < 24) return;
    if (msg.readUInt32BE(0) !== 0x000055aa) return;

    let payload = msg.slice(16, msg.length - 8);

    // If retcode (4 bytes) is present at start of payload
    if (payload.length >= 4 && payload.readUInt32BE(0) === 0) {
      payload = payload.slice(4);
    }

    let parsed = null;

    // 1. Try unencrypted parse (v3.1)
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch (e) {
      // 2. Try standard UDP key decryption (v3.3)
      try {
        const decrypted = decryptECB(payload, DEFAULT_UDP_KEY);
        const cleanStr = decrypted.toString('utf8').replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => (c === '\r' || c === '\n' || c === '\t') ? c : '').trim();
        parsed = JSON.parse(cleanStr);
      } catch (err) {
        // Encrypted with custom local_key (v3.4/v3.5)
      }
    }

    const deviceId = parsed?.gwId || parsed?.devId || `unidentified_${rinfo.address.replace(/\./g, '_')}`;
    const deviceEntry = {
      id: deviceId,
      gwId: parsed?.gwId || deviceId,
      devId: parsed?.devId || deviceId,
      ip: rinfo.address,
      port: rinfo.port,
      discoveryPort: port,
      version: parsed?.version || '3.3',
      productKey: parsed?.productKey || null,
      lastSeen: Date.now(),
      rawPayload: parsed || msg.toString('hex')
    };

    const isNew = !this.discoveredDevices.has(deviceId);
    this.discoveredDevices.set(deviceId, deviceEntry);

    if (isNew) {
      this.emit('log', `[UDP Discovery] Discovered Tuya endpoint: ${deviceId} at ${rinfo.address} (v${deviceEntry.version})`);
    }

    // Always emit discovered and raw-discovery for continuous dynamic DHCP IP tracking
    this.emit('discovered', deviceEntry);
    this.emit('raw-discovery', deviceEntry);
  }

  getDevices() {
    return Array.from(this.discoveredDevices.values());
  }

  stop() {
    this.sockets.forEach((s) => {
      try {
        s.close();
      } catch (e) {}
    });
    this.sockets = [];
  }
}

module.exports = TuyaDiscovery;
