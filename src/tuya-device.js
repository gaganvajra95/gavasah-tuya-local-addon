/**
 * GAVASAH Tuya LAN Gateway - Device TCP Client
 * Manages persistent bi-directional TCP sessions on Port 6668 with Dynamic DHCP Re-binding
 * Full support for both Gateways (DALI, Zigbee) and Standalone Tuya Wi-Fi Devices
 */

const net = require('net');
const EventEmitter = require('events');
const { COMMANDS, encodeFrame, decodeFrame } = require('./tuya-cipher');
const { inferDriverType, isRemoteAction } = require('./dali-helper');

// Default initial CID mappings for Sunricher DALI Center
const SUB_DEVICE_MAP = {
  'dali_0': '010008020000',
  'dali_1': '010008020001',
  'dali_2': '010006000002',
  '010008020000': 'dali_0',
  '010008020001': 'dali_1',
  '010006000002': 'dali_2'
};

class TuyaDevice extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;                     // Device ID / gwId (e.g. d7b3f345b23032557azteo)
    this.name = options.name || options.id;
    this.ip = options.ip;                     // Dynamic LAN IP
    this.mac = options.mac || '00:0c:43:e1:76:29'; // Hardware MAC address
    this.port = options.port || 6668;         // Default Tuya TCP port
    this.key = options.local_key || 'K}>t}vi=XskqREC@'; // 16-character local_key
    this.version = options.version || '3.3';  // Protocol version
    this.type = options.type || 'dali_gateway'; // Hardware category / type
    this.category = options.category || (options.type === 'dali_gateway' || options.type === 'zigbee_gateway' || options.type === 'gateway' ? 'gateway' : 'wifi_device');
    this.isGateway = (this.category === 'gateway');

    this.socket = null;
    this.isConnected = false;
    this.lastPing = 0;
    this.pingLatency = 0;
    this.seq = 1;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;

    // Per sub-device Data Point cache for gateways
    this.subDevices = options.subDevices || (this.isGateway ? {
      'dali_0': { devId: '010008020000', name: 'DALI Lamp 0', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
      'dali_1': { devId: '010008020001', name: 'DALI Lamp 1', type: 'light_cct', dps: { '20': false, '22': 1000, '23': 500 } },
      'dali_2': { devId: '010006000002', name: 'DALI Lamp 2', type: 'dimmer', dps: { '20': false, '22': 1000 } }
    } : {});

    // Populate lookup maps if gateway
    if (this.isGateway && this.subDevices) {
      Object.entries(this.subDevices).forEach(([subId, info]) => {
        if (info.devId) {
          SUB_DEVICE_MAP[subId] = info.devId;
          SUB_DEVICE_MAP[info.devId] = subId;
        }
      });
    }

    this.dps = options.dps || {};            // Root device / standalone Wi-Fi DPs
    this.incomingBuffer = Buffer.alloc(0);
  }

  /**
   * Dynamic DHCP update: update IP and reconnect immediately if IP changed
   */
  updateIp(newIp) {
    if (this.ip !== newIp) {
      this.emit('log', `[${this.name}] Dynamic DHCP Re-bind: ${this.ip} -> ${newIp}`);
      this.ip = newIp;
      if (this.isConnected || this.socket) {
        this.destroy();
      }
      this.connect();
      this.emit('ip-changed', { id: this.id, ip: this.ip, mac: this.mac, category: this.category });
    }
  }

  /**
   * Connect to the Tuya device over local LAN TCP socket
   */
  connect() {
    if (this.socket) {
      this.destroy();
    }

    this.emit('log', `[${this.name}] Connecting to ${this.ip}:${this.port}...`);
    this.socket = new net.Socket();
    this.socket.setKeepAlive(true, 5000);
    this.socket.setNoDelay(true); // Sub-millisecond dispatch

    this.socket.connect(this.port, this.ip, () => {
      this.isConnected = true;
      this.emit('log', `[${this.name}] Connected to ${this.ip} on TCP ${this.port}`);
      this.emit('connected', { id: this.id, ip: this.ip, mac: this.mac, category: this.category });

      // Start periodic heartbeat
      this.startHeartbeat();

      // Immediately query live state upon connection for instantaneous 2-way sync
      this.queryStatus();
    });

    this.socket.on('data', (chunk) => {
      this.handleIncomingData(chunk);
    });

    this.socket.on('error', (err) => {
      this.emit('log', `[${this.name}] Socket error: ${err.message}`);
    });

    this.socket.on('close', () => {
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('log', `[${this.name}] Socket closed. Scheduling reconnect in 5s...`);
      this.emit('disconnected', { id: this.id, category: this.category });
      this.scheduleReconnect();
    });
  }

  /**
   * Query status from the device (DP_QUERY 0x0a and 0x10)
   */
  queryStatus(targetSub = null) {
    if (!this.isConnected || !this.socket) return;

    try {
      if (!this.isGateway) {
        // Query standalone Wi-Fi device
        const payload = {
          gwId: this.id,
          devId: this.id,
          uid: this.id,
          t: Math.floor(Date.now() / 1000),
          dps: {}
        };
        const frame = encodeFrame(COMMANDS.DP_QUERY, payload, this.key, this.version, this.seq++);
        this.send(frame, COMMANDS.DP_QUERY, payload);
      } else {
        // Query sub-devices on gateway
        const subsToQuery = targetSub ? [targetSub] : Object.keys(this.subDevices || {});
        subsToQuery.forEach((subId) => {
          const info = this.subDevices[subId];
          const cid = (info && info.devId) || SUB_DEVICE_MAP[subId] || subId;
          const payload = {
            gwId: this.id,
            devId: cid,
            cid: cid,
            uid: this.id,
            t: Math.floor(Date.now() / 1000),
            dps: {}
          };
          const frame = encodeFrame(COMMANDS.DP_QUERY, payload, this.key, this.version, this.seq++);
          this.send(frame, COMMANDS.DP_QUERY, payload);
        });
      }
    } catch (err) {
      this.emit('log', `[${this.name}] Query status failed: ${err.message}`);
    }
  }

  /**
   * Handle stream fragmentation & extract full Tuya frames
   */
  handleIncomingData(chunk) {
    this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);

    while (this.incomingBuffer.length >= 24) {
      const prefixIndex = this.incomingBuffer.indexOf(Buffer.from([0x00, 0x00, 0x55, 0xaa]));
      if (prefixIndex === -1) {
        this.incomingBuffer = Buffer.alloc(0);
        break;
      }

      if (prefixIndex > 0) {
        this.incomingBuffer = this.incomingBuffer.slice(prefixIndex);
      }

      if (this.incomingBuffer.length < 16) break;
      const length = this.incomingBuffer.readUInt32BE(12);
      const totalFrameLength = 16 + length;

      if (this.incomingBuffer.length < totalFrameLength) {
        break;
      }

      const frameBuffer = this.incomingBuffer.slice(0, totalFrameLength);
      this.incomingBuffer = this.incomingBuffer.slice(totalFrameLength);

      this.processFrame(frameBuffer);
    }
  }

  /**
   * Parse a single frame and update internal state
   */
  processFrame(frameBuf) {
    try {
      const decoded = decodeFrame(frameBuf, this.key, this.version);
      if (!decoded) return;

      if (decoded.cmd === COMMANDS.HEARTBEAT && this.lastPing > 0) {
        this.pingLatency = Date.now() - this.lastPing;
      }

      this.emit('raw-packet', {
        id: this.id,
        direction: 'in',
        cmd: decoded.cmd,
        data: decoded.payload,
        timestamp: Date.now()
      });

      // Handle unsolicited STATUS push (0x08), STATUS_NEW (0x0b), DP_QUERY (0x0a), or CONTROL ACK (0x07)
      if (decoded.payload && typeof decoded.payload === 'object') {
        const receivedDevId = decoded.payload.cid || decoded.payload.devId || decoded.payload.gwId;
        const receivedDps = decoded.payload.dps || decoded.payload.data?.dps || {};

        if (!this.isGateway) {
          // Standalone Tuya Wi-Fi device: DPs belong to this device directly
          if (Object.keys(receivedDps).length > 0) {
            this.dps = { ...this.dps, ...receivedDps };
            for (const [dpId, val] of Object.entries(receivedDps)) {
              this.emit('dp-update', { id: this.id, dp: dpId, value: val, category: 'wifi_device' });
            }
            this.emit('log', `[${this.name}] 2-Way Sync -> DPs: ${JSON.stringify(receivedDps)}`);
            this.emit('status', {
              id: this.id,
              dps: { ...this.dps },
              category: 'wifi_device'
            });
          }
        } else {
          // Gateway coordinator: route DPs to sub-devices
          if (receivedDevId && receivedDevId !== this.id) {
            let subId = SUB_DEVICE_MAP[receivedDevId];

            // Auto-sync: automatically discover any new sub-device (DALI or Zigbee endpoint)
            if (!subId) {
              const nextIdx = Object.keys(this.subDevices).length;
              subId = `dev_${nextIdx}`;
              SUB_DEVICE_MAP[receivedDevId] = subId;
              SUB_DEVICE_MAP[subId] = receivedDevId;

              const detectedType = inferDriverType(receivedDps);
              this.subDevices[subId] = {
                devId: receivedDevId,
                name: `SubDevice ${nextIdx}`,
                type: detectedType,
                dps: { ...receivedDps },
                lastAction: null
              };

              this.emit('log', `[${this.name}] Auto-Discovered new endpoint: ${subId} (${receivedDevId}, type: ${detectedType})`);
              this.emit('new-subdevice', { gatewayId: this.id, subId, subDevice: this.subDevices[subId] });
            }

            // Check if this payload represents a remote button press or scene action
            const remoteCheck = isRemoteAction(receivedDps);
            if (remoteCheck.isRemote) {
              const actionText = `Button ${remoteCheck.button}: ${remoteCheck.action}`;
              if (this.subDevices[subId]) {
                this.subDevices[subId].lastAction = {
                  action: remoteCheck.action,
                  button: remoteCheck.button,
                  timestamp: Date.now(),
                  text: actionText
                };
              }
              this.emit('log', `[${this.name}] ⚡ REMOTE ACTION [${subId}]: ${actionText} (Raw DPs: ${JSON.stringify(receivedDps)})`);
              this.emit('action', {
                gatewayId: this.id,
                subId,
                action: remoteCheck.action,
                button: remoteCheck.button,
                dps: receivedDps,
                timestamp: Date.now()
              });
            }

            if (this.subDevices[subId]) {
              for (const [dpId, val] of Object.entries(receivedDps)) {
                this.subDevices[subId].dps[dpId] = val;
                this.emit('dp-update', { id: this.id, subId, dp: dpId, value: val, category: 'gateway' });
              }
              this.emit('log', `[${this.name}] 2-Way Update from Gateway [${subId}]: ${JSON.stringify(receivedDps)}`);
              this.emit('status', {
                id: this.id,
                subId,
                dps: { ...this.subDevices[subId].dps },
                lastAction: this.subDevices[subId].lastAction,
                category: 'gateway'
              });
            }
          } else if (Object.keys(receivedDps).length > 0) {
            // Gateway root DPs
            this.dps = { ...this.dps, ...receivedDps };
            this.emit('status', { id: this.id, dps: { ...this.dps }, category: 'gateway' });
          }
        }
      }
    } catch (err) {
      this.emit('log', `[${this.name}] Frame decode error: ${err.message}`);
    }
  }

  /**
   * Set one or multiple Data Points with instant sub-20ms dispatch
   */
  set(dps, subId = 'dali_0') {
    if (!this.isConnected || !this.socket) {
      throw new Error(`Device ${this.name} is not connected over LAN.`);
    }

    if (!this.isGateway) {
      // Standalone Wi-Fi device: NO cid attribute in payload
      const payload = {
        devId: this.id,
        gwId: this.id,
        uid: this.id,
        t: Math.floor(Date.now() / 1000),
        dps: dps
      };

      const frame = encodeFrame(COMMANDS.CONTROL, payload, this.key, this.version, this.seq++);
      this.send(frame, COMMANDS.CONTROL, payload);
      this.emit('log', `[${this.name}] TX Command -> [WiFi Device]: ${JSON.stringify(dps)}`);

      // Optimistic local state update
      this.dps = { ...this.dps, ...dps };
      for (const [k, v] of Object.entries(dps)) {
        this.emit('dp-update', { id: this.id, dp: k, value: v, category: 'wifi_device' });
      }
      this.emit('status', { id: this.id, dps: { ...this.dps }, category: 'wifi_device' });
    } else {
      // Gateway sub-device
      let targetDevId = SUB_DEVICE_MAP[subId] || subId || this.id;

      const payload = {
        gwId: this.id,
        devId: targetDevId,
        cid: targetDevId,
        uid: this.id,
        t: Math.floor(Date.now() / 1000),
        dps: dps
      };

      const frame = encodeFrame(COMMANDS.CONTROL, payload, this.key, this.version, this.seq++);
      this.send(frame, COMMANDS.CONTROL, payload);

      const resolvedSub = SUB_DEVICE_MAP[targetDevId] || subId;
      this.emit('log', `[${this.name}] TX Command -> [${resolvedSub}] (${targetDevId}): ${JSON.stringify(dps)}`);

      // Optimistically update local cache and emit state
      if (this.subDevices[resolvedSub]) {
        for (const [k, v] of Object.entries(dps)) {
          this.subDevices[resolvedSub].dps[k] = v;
          this.emit('dp-update', { id: this.id, subId: resolvedSub, dp: k, value: v, category: 'gateway' });
        }
        this.emit('status', { id: this.id, subId: resolvedSub, dps: { ...this.subDevices[resolvedSub].dps }, category: 'gateway' });
      }
    }
  }

  /**
   * Send a raw frame over the socket
   */
  send(frame, cmd, payload) {
    if (!this.socket || !this.isConnected) return;
    this.socket.write(frame);
    this.emit('raw-packet', {
      id: this.id,
      direction: 'out',
      cmd: cmd,
      data: payload,
      timestamp: Date.now()
    });
  }

  /**
   * Periodic Tuya Heartbeat
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.socket) {
        this.lastPing = Date.now();
        const frame = encodeFrame(COMMANDS.HEARTBEAT, {}, this.key, this.version, this.seq++);
        this.send(frame, COMMANDS.HEARTBEAT, {});
      }
    }, 10000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  destroy() {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.isConnected = false;
  }
}

module.exports = TuyaDevice;
