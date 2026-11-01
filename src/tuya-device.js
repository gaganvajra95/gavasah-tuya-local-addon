/**
 * GAVASAH Tuya LAN Gateway - Device TCP Client
 * Manages persistent bi-directional TCP sessions on Port 6668
 */

const net = require('net');
const EventEmitter = require('events');
const { COMMANDS, encodeFrame, decodeFrame } = require('./tuya-cipher');

class TuyaDevice extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;                     // Device ID / gwId
    this.name = options.name || options.id;
    this.ip = options.ip;                     // LAN IP
    this.port = options.port || 6668;         // Default Tuya TCP port
    this.key = options.local_key;             // 16-character local_key
    this.version = options.version || '3.3';  // Protocol version
    this.type = options.type || 'generic';    // Device category

    this.socket = null;
    this.isConnected = false;
    this.seq = 1;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.dps = {};                            // Current cached Data Points
    this.incomingBuffer = Buffer.alloc(0);
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
    this.socket.setNoDelay(true); // Disable Nagle's algorithm for sub-millisecond dispatch

    this.socket.connect(this.port, this.ip, () => {
      this.isConnected = true;
      this.emit('log', `[${this.name}] Connected to ${this.ip} on TCP ${this.port}`);
      this.emit('connected', { id: this.id, ip: this.ip });

      // Start periodic heartbeat
      this.startHeartbeat();

      // Immediately query current Data Point states
      this.query();
    });

    this.socket.on('data', (chunk) => {
      this.handleIncomingData(chunk);
    });

    this.socket.on('error', (err) => {
      this.emit('log', `[${this.name}] Socket error: ${err.message}`);
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('log', `[${this.name}] Socket closed. Scheduling reconnect in 5s...`);
      this.emit('disconnected', { id: this.id });
      this.scheduleReconnect();
    });
  }

  /**
   * Process raw bytes from the TCP stream and extract frames
   */
  handleIncomingData(chunk) {
    this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);

    while (this.incomingBuffer.length >= 24) {
      // Find 0x000055aa prefix
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
        // Frame incomplete, await more bytes
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

      this.emit('raw-packet', {
        id: this.id,
        direction: 'in',
        cmd: decoded.cmd,
        data: decoded.payload,
        timestamp: Date.now()
      });

      // Handle unsolicited STATUS push (0x08) or DP_QUERY response (0x0a)
      if (decoded.cmd === COMMANDS.STATUS || decoded.cmd === COMMANDS.DP_QUERY || decoded.cmd === COMMANDS.STATUS_NEW) {
        if (decoded.payload && typeof decoded.payload === 'object') {
          const receivedDps = decoded.payload.dps || {};
          let hasChanges = false;

          for (const [dpId, val] of Object.entries(receivedDps)) {
            if (this.dps[dpId] !== val) {
              this.dps[dpId] = val;
              hasChanges = true;
              this.emit('dp-update', { id: this.id, dp: dpId, value: val });
            }
          }

          if (hasChanges) {
            this.emit('status', { id: this.id, dps: { ...this.dps } });
          }
        }
      }
    } catch (err) {
      this.emit('log', `[${this.name}] Frame decode error: ${err.message}`);
    }
  }

  /**
   * Query all Data Points from the device
   */
  query() {
    if (!this.isConnected || !this.socket) return;
    const payload = {
      gwId: this.id,
      devId: this.id,
      t: Math.floor(Date.now() / 1000).toString(),
      dps: {}
    };

    const frame = encodeFrame(COMMANDS.DP_QUERY, payload, this.key, this.version, this.seq++);
    this.send(frame, COMMANDS.DP_QUERY, payload);
  }

  /**
   * Set one or multiple Data Points with instant sub-20ms send
   */
  set(dps) {
    if (!this.isConnected || !this.socket) {
      throw new Error(`Device ${this.name} is not connected over LAN.`);
    }

    const payload = {
      gwId: this.id,
      devId: this.id,
      uid: this.id,
      t: Math.floor(Date.now() / 1000).toString(),
      dps: dps
    };

    const frame = encodeFrame(COMMANDS.CONTROL, payload, this.key, this.version, this.seq++);
    this.send(frame, COMMANDS.CONTROL, payload);

    // Optimistically update local cache and emit state
    for (const [k, v] of Object.entries(dps)) {
      this.dps[k] = v;
      this.emit('dp-update', { id: this.id, dp: k, value: v });
    }
    this.emit('status', { id: this.id, dps: { ...this.dps } });
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

