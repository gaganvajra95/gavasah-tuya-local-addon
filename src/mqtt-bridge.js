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
    this.devices = new Map();
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
      this.publishDeviceState(device, data.subId);
    });

    device.on('connected', () => {
      this.publishAvailability(device, 'online');
      this.publishDiscovery(device);
      // Publish initial state for all sub-devices
      ['dali_0', 'dali_1', 'dali_2'].forEach((sub) => {
        this.publishDeviceState(device, sub);
      });
    });

    device.on('disconnected', () => {
      this.publishAvailability(device, 'offline');
    });

    if (this.client && this.client.connected) {
      this.publishDiscovery(device);
      this.publishAvailability(device, device.isConnected ? 'online' : 'offline');
      ['dali_0', 'dali_1', 'dali_2'].forEach((sub) => {
        this.publishDeviceState(device, sub);
      });
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
      this.publishAvailability(device, 'online');
      ['dali_0', 'dali_1', 'dali_2'].forEach((sub) => {
        this.publishDeviceState(device, sub);
      });
    });
  }

  /**
   * Publish Home Assistant Discovery schema for a specific device
   */
  publishDiscovery(device) {
    if (!this.client || !this.client.connected) return;

    if (device.type === 'dali_gateway') {
      // Create native light entities for each DALI lamp
      Object.entries(KNOWN_DALI_PROFILES).forEach(([cid, profile]) => {
        const subId = `dali_${profile.address}`;
        const discoveryTopic = `homeassistant/light/${device.id}_${subId}/config`;

        const isCct = profile.type === 'light_cct';
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
          supported_color_modes: isCct ? ['color_temp'] : ['brightness'],
          min_mireds: 153,
          max_mireds: 500,
          device: {
            identifiers: [`tuya_${device.id}_${subId}`],
            name: profile.name,
            model: `Sunricher DALI Center (${isCct ? 'DT8 Tunable White' : 'DT6 Dimmer'})`,
            manufacturer: 'Sunricher / GAVASAH',
            via_device: `tuya_${device.id}`
          }
        };

        this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
        this.emit('log', `[MQTT Bridge] Published discovery config for ${profile.name}`);
      });
    } else {
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
  publishDeviceState(device, targetSub = 'dali_0') {
    if (!this.client || !this.client.connected) return;

    if (device.type === 'dali_gateway') {
      const subInfo = device.subDevices && device.subDevices[targetSub];
      const dps = subInfo ? subInfo.dps : {};

      const profile = Object.values(KNOWN_DALI_PROFILES).find(p => `dali_${p.address}` === targetSub);
      const isCct = profile && profile.type === 'light_cct';

      const isPowerOn = dps['1'] === true;
      const brightnessRaw = dps['2'] !== undefined ? dps['2'] : 1000;
      const colorTempRaw = dps['3'] !== undefined ? dps['3'] : 500;

      const statePayload = {
        state: isPowerOn ? 'ON' : 'OFF',
        brightness: tuyaBrightnessToHa(brightnessRaw),
        color_mode: isCct ? 'color_temp' : 'brightness'
      };

      if (isCct) {
        statePayload.color_temp = tuyaColorTempToMireds(colorTempRaw);
      }

      const stateTopic = `gavasah/tuya/${device.id}/${targetSub}/state`;
      this.client.publish(stateTopic, JSON.stringify(statePayload), { retain: true });
    } else {
      const isPowerOn = device.dps['1'] === true || device.dps['20'] === true;
      this.client.publish(`gavasah/tuya/${device.id}/state`, isPowerOn ? 'ON' : 'OFF');
    }
  }

  /**
   * Handle incoming commands from Home Assistant
   */
  handleIncomingMqtt(topic, message) {
    try {
      const parts = topic.split('/');
      // Format: gavasah/tuya/<deviceId>/<subId>/set
      if (parts.length < 5) return;
      const deviceId = parts[2];
      const subId = parts[3];

      const device = this.devices.get(deviceId) || this.devices.values().next().value;
      if (!device) return;

      const payload = JSON.parse(message.toString('utf8'));
      this.emit('log', `[MQTT Bridge] Command from HA for [${subId}]: ${JSON.stringify(payload)}`);

      const dpsToSet = {};

      if (payload.state !== undefined) {
        dpsToSet['1'] = payload.state.toUpperCase() === 'ON';
      }

      if (payload.brightness !== undefined) {
        dpsToSet['2'] = haBrightnessToTuya(payload.brightness);
        dpsToSet['1'] = true; // Setting brightness turns the light on
      }

      if (payload.color_temp !== undefined) {
        dpsToSet['3'] = haMiredsToTuya(payload.color_temp);
      }

      // Send to hardware via persistent TCP socket in sub-20ms with sub-device CID
      device.set(dpsToSet, subId);
    } catch (err) {
      this.emit('log', `[MQTT Bridge] Command dispatch failed: ${err.message}`);
    }
  }
}

module.exports = MqttBridge;
