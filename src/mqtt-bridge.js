/**
 * GAVASAH Tuya LAN Gateway - Home Assistant MQTT Discovery & Bridge
 * Automates native Home Assistant entity provisioning and bidirectional state synchronization
 */

const mqtt = require('mqtt');
const EventEmitter = require('events');
const {
  haBrightnessToTuya,
  tuyaBrightnessToHa,
  haMiredsToTuya,
  tuyaColorTempToMireds,
  KNOWN_DALI_PROFILES
} = require('./dali-helper');

class MqttBridge extends EventEmitter {
  constructor(options) {
    super();
    this.host = options.mqtt_host || 'core-mosquitto';
    this.port = options.mqtt_port || 1883;
    this.username = options.mqtt_user || undefined;
    this.password = options.mqtt_password || undefined;
    this.client = null;
    this.devices = new Map(); // Registered TuyaDevice instances
  }

  /**
   * Connect to Mosquitto MQTT broker
   */
  connect() {
    const brokerUrl = `mqtt://${this.host}:${this.port}`;
    this.emit('log', `[MQTT Bridge] Connecting to ${brokerUrl}...`);

    this.client = mqtt.connect(brokerUrl, {
      username: this.username,
      password: this.password,
      clientId: `gavasah_tuya_bridge_${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000
    });

    this.client.on('connect', () => {
      this.emit('log', `[MQTT Bridge] Connected successfully to MQTT Broker.`);
      this.subscribeCommands();
      this.publishAllDiscoveries();
    });

    this.client.on('message', (topic, message) => {
      this.handleIncomingMqtt(topic, message);
    });

    this.client.on('error', (err) => {
      this.emit('log', `[MQTT Bridge] Connection error: ${err.message}`);
    });
  }

  /**
   * Register a TuyaDevice instance to the bridge
   */
  registerDevice(device) {
    this.devices.set(device.id, device);

    // Bind real-time bidirectional status events
    device.on('status', (data) => {
      this.publishDeviceState(device);
    });

    device.on('connected', () => {
      this.publishAvailability(device, 'online');
      this.publishDiscovery(device);
    });

    device.on('disconnected', () => {
      this.publishAvailability(device, 'offline');
    });

    if (this.client && this.client.connected) {
      this.publishDiscovery(device);
      this.publishAvailability(device, device.isConnected ? 'online' : 'offline');
    }
  }

  /**
   * Subscribe to Home Assistant command topics
   */
  subscribeCommands() {
    if (!this.client || !this.client.connected) return;
    this.client.subscribe('gavasah/tuya/+/+/set', (err) => {
      if (!err) {
        this.emit('log', `[MQTT Bridge] Subscribed to topic: gavasah/tuya/+/+/set`);
      }
    });
  }

  /**
   * Publish Home Assistant MQTT Discovery configuration for all devices
   */
  publishAllDiscoveries() {
    this.devices.forEach((device) => {
      this.publishDiscovery(device);
    });
  }

  /**
   * Publish Home Assistant Discovery schema for a specific device
   */
  publishDiscovery(device) {
    if (!this.client || !this.client.connected) return;

    if (device.type === 'dali_gateway') {
      // Create sub-entities for each DALI light
      Object.entries(KNOWN_DALI_PROFILES).forEach(([cid, profile]) => {
        const subId = `dali_${profile.address}`;
        const discoveryTopic = `homeassistant/light/${device.id}_${subId}/config`;

        const payload = {
          name: profile.name,
          unique_id: `${device.id}_${subId}`,
          schema: 'json',
          state_topic: `gavasah/tuya/${device.id}/${subId}/state`,
          command_topic: `gavasah/tuya/${device.id}/${subId}/set`,
          availability_topic: `gavasah/tuya/${device.id}/availability`,
          brightness: true,
          brightness_scale: 255,
          color_mode: true,
          supported_color_modes: profile.type === 'light_cct' ? ['color_temp'] : ['brightness'],
          min_mireds: 153,
          max_mireds: 500,
          device: {
            identifiers: [`tuya_${device.id}_${subId}`],
            name: profile.name,
            model: `Sunricher DALI Center (${profile.type === 'light_cct' ? 'DT8' : 'DT6'})`,
            manufacturer: 'Sunricher / GAVASAH',
            via_device: `tuya_${device.id}`
          }
        };

        this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
        this.emit('log', `[MQTT Bridge] Published discovery config for ${profile.name}`);
      });
    } else {
      // Standard switch or light entity
      const discoveryTopic = `homeassistant/switch/${device.id}/config`;
      const payload = {
        name: device.name,
        unique_id: `tuya_${device.id}`,
        state_topic: `gavasah/tuya/${device.id}/state`,
        command_topic: `gavasah/tuya/${device.id}/set`,
        availability_topic: `gavasah/tuya/${device.id}/availability`,
        payload_on: 'ON',
        payload_off: 'OFF',
        device: {
          identifiers: [`tuya_${device.id}`],
          name: device.name,
          manufacturer: 'Tuya / GAVASAH',
          model: 'Tuya LAN Endpoint'
        }
      };

      this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
    }
  }

  /**
   * Publish availability status (online/offline)
   */
  publishAvailability(device, status) {
    if (!this.client || !this.client.connected) return;
    this.client.publish(`gavasah/tuya/${device.id}/availability`, status, { retain: true });
  }

  /**
   * Translate current device DP values and publish state JSON to Home Assistant
   */
  publishDeviceState(device) {
    if (!this.client || !this.client.connected) return;

    if (device.type === 'dali_gateway') {
      // Publish state for each DALI sub-device
      Object.entries(KNOWN_DALI_PROFILES).forEach(([cid, profile]) => {
        const subId = `dali_${profile.address}`;
        const stateTopic = `gavasah/tuya/${device.id}/${subId}/state`;

        // DP 20 is power, DP 22 is brightness, DP 23 is color temp
        const isPowerOn = device.dps['20'] === true || device.dps['1'] === true;
        const brightnessRaw = device.dps['22'] || device.dps['2'];
        const colorTempRaw = device.dps['23'] || device.dps['3'];

        const statePayload = {
          state: isPowerOn ? 'ON' : 'OFF',
          brightness: tuyaBrightnessToHa(brightnessRaw),
          color_mode: profile.type === 'light_cct' ? 'color_temp' : 'brightness'
        };

        if (profile.type === 'light_cct') {
          statePayload.color_temp = tuyaColorTempToMireds(colorTempRaw);
        }

        this.client.publish(stateTopic, JSON.stringify(statePayload));
      });
    } else {
      // Standard entity
      const isPowerOn = device.dps['1'] === true || device.dps['20'] === true;
      this.client.publish(`gavasah/tuya/${device.id}/state`, isPowerOn ? 'ON' : 'OFF');
    }
  }

  /**
   * Handle incoming commands from Home Assistant (e.g. user toggled UI or automation fired)
   */
  handleIncomingMqtt(topic, message) {
    try {
      const parts = topic.split('/');
      // Expected format: gavasah/tuya/<deviceId>/<subId>/set
      if (parts.length < 5) return;
      const deviceId = parts[2];
      const subId = parts[3];

      const device = this.devices.get(deviceId);
      if (!device) return;

      const payload = JSON.parse(message.toString('utf8'));
      this.emit('log', `[MQTT Bridge] Received command for [${device.name}] sub [${subId}]: ${JSON.stringify(payload)}`);

      const dpsToSet = {};

      if (payload.state) {
        dpsToSet['20'] = payload.state.toUpperCase() === 'ON';
      }

      if (payload.brightness !== undefined) {
        dpsToSet['22'] = haBrightnessToTuya(payload.brightness);
        // If brightness is set, ensure lamp is also on
        dpsToSet['20'] = true;
      }

      if (payload.color_temp !== undefined) {
        dpsToSet['23'] = haMiredsToTuya(payload.color_temp);
      }

      // Send to hardware via persistent TCP socket in sub-20ms
      device.set(dpsToSet);
    } catch (err) {
      this.emit('log', `[MQTT Bridge] Command dispatch failed: ${err.message}`);
    }
  }
}

module.exports = MqttBridge;
