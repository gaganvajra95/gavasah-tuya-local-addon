/**
 * GAVASAH Tuya LAN Gateway - Home Assistant MQTT Discovery & Bridge
 * Automates native Home Assistant entity provisioning and bidirectional state synchronization
 * Full support for DALI DT6/DT8, Tuya Wi-Fi, and Zigbee Remotes / Scene Buttons
 */

const mqtt = require('mqtt');
const EventEmitter = require('events');
const {
  haBrightnessToTuya,
  tuyaBrightnessToHa,
  haMiredsToTuya,
  tuyaColorTempToMireds,
  tuyaHsvToHaHs,
  haHsToTuyaHsv,
  rgbToTuyaHsv,
  KNOWN_DALI_PROFILES
} = require('./dali-helper');

class MqttBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.mqtt_host || 'core-mosquitto';
    this.port = options.mqtt_port || 1883;
    this.username = options.mqtt_user || undefined;
    this.password = options.mqtt_password || undefined;
    this.client = null;
    this.gateways = new Map();
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
   * Register a Gateway instance to the bridge
   */
  registerGateway(gw) {
    this.gateways.set(gw.id, gw);

    // Bind real-time status events
    gw.on('status', (data) => {
      this.publishDeviceState(gw, data.subId);
    });

    // Bind real-time remote button / scene action events
    gw.on('action', (actionData) => {
      this.publishActionEvent(gw, actionData.subId, actionData);
    });

    gw.on('connected', () => {
      this.publishAvailability(gw, 'online');
      this.publishGatewayDiscovery(gw);
    });

    gw.on('disconnected', () => {
      this.publishAvailability(gw, 'offline');
    });

    gw.on('new-subdevice', (data) => {
      this.publishSubDeviceDiscovery(gw, data.subId, data.subDevice);
      this.publishDeviceState(gw, data.subId);
    });

    if (this.client && this.client.connected) {
      this.publishGatewayDiscovery(gw);
      this.publishAvailability(gw, gw.isConnected ? 'online' : 'offline');
    }
  }

  unregisterGateway(gwId) {
    this.gateways.delete(gwId);
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
   * Publish Home Assistant MQTT Discovery configuration for all gateways & sub-devices
   */
  publishAllDiscoveries() {
    this.gateways.forEach((gw) => {
      this.publishGatewayDiscovery(gw);
      this.publishAvailability(gw, gw.isConnected ? 'online' : 'offline');
    });
  }

  /**
   * Publish Discovery schemas for all subdevices of a gateway
   */
  publishGatewayDiscovery(gw) {
    if (!this.client || !this.client.connected) return;

    Object.entries(gw.subDevices || {}).forEach(([subId, info]) => {
      this.publishSubDeviceDiscovery(gw, subId, info);
      this.publishDeviceState(gw, subId);
    });
  }

  /**
   * Publish Discovery schema for a specific sub-device
   */
  publishSubDeviceDiscovery(gw, subId, info) {
    if (!this.client || !this.client.connected) return;

    const type = info.type || 'dimmer';

    // If device is a Remote or Scene Controller, publish as HA Event Entity
    if (type === 'remote_button') {
      const discoveryTopic = `homeassistant/event/${gw.id}_${subId}/config`;
      const payload = {
        name: info.name || `${gw.name} Remote ${subId}`,
        unique_id: `${gw.id}_${subId}_event`,
        state_topic: `gavasah/tuya/${gw.id}/${subId}/action`,
        event_types: ['single', 'double', 'hold', 'click', 'rotate_left', 'rotate_right', 'press', 'alarm'],
        device: {
          identifiers: [`tuya_${gw.id}`],
          name: gw.name,
          model: `${gw.name} Remote Controller`,
          manufacturer: 'Tuya / GAVASAH',
          connections: [['mac', gw.mac || '00:0c:43:e1:76:29']]
        }
      };
      this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
      this.emit('log', `[MQTT Bridge] Published event discovery for remote: ${info.name || subId}`);
      return;
    }

    const discoveryTopic = `homeassistant/light/${gw.id}_${subId}/config`;
    const isCct = type === 'light_cct' || type === 'light_rgbcw';
    const isRgb = type === 'light_rgb' || type === 'light_rgbw' || type === 'light_rgbcw';

    const colorModes = [];
    if (type === 'dimmer') {
      colorModes.push('brightness');
    } else if (type === 'light_cct') {
      colorModes.push('color_temp');
    } else if (type === 'light_rgb') {
      colorModes.push('hs', 'rgb');
    } else if (type === 'light_rgbw') {
      colorModes.push('rgbw', 'hs');
    } else if (type === 'light_rgbcw') {
      colorModes.push('rgbcw', 'color_temp', 'hs');
    }

    const payload = {
      name: info.name || `${gw.name} ${subId}`,
      unique_id: `${gw.id}_${subId}`,
      schema: 'json',
      state_topic: `gavasah/tuya/${gw.id}/${subId}/state`,
      command_topic: `gavasah/tuya/${gw.id}/${subId}/set`,
      availability_topic: `gavasah/tuya/${gw.id}/availability`,
      brightness: true,
      brightness_scale: 255,
      color_mode: true,
      supported_color_modes: colorModes,
      device: {
        identifiers: [`tuya_${gw.id}`],
        name: gw.name,
        model: `${gw.name} (${gw.type.toUpperCase()})`,
        manufacturer: 'Sunricher / GAVASAH',
        connections: [['mac', gw.mac || '00:0c:43:e1:76:29']]
      }
    };

    if (isCct) {
      payload.min_mireds = 153;
      payload.max_mireds = 500;
    }

    this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
    this.emit('log', `[MQTT Bridge] Published discovery config for ${info.name || subId} (${type})`);
  }

  /**
   * Publish availability status (online/offline)
   */
  publishAvailability(gw, status) {
    if (!this.client || !this.client.connected) return;
    this.client.publish(`gavasah/tuya/${gw.id}/availability`, status, { retain: true });
  }

  /**
   * Publish remote button press / scene trigger action
   */
  publishActionEvent(gw, subId, actionData) {
    if (!this.client || !this.client.connected) return;

    // Standard action topic for automations
    const actionTopic = `gavasah/tuya/${gw.id}/${subId}/action`;
    const actionPayload = {
      event_type: actionData.action,
      button: actionData.button,
      action: actionData.action,
      timestamp: actionData.timestamp || Date.now(),
      raw_dps: actionData.dps || {}
    };

    this.client.publish(actionTopic, JSON.stringify(actionPayload));

    // Also publish raw DP snapshot for debugging
    const rawTopic = `gavasah/tuya/${gw.id}/${subId}/raw`;
    this.client.publish(rawTopic, JSON.stringify(actionData.dps || {}));

    this.emit('log', `[MQTT Bridge] Published Remote Action -> ${actionTopic}: ${JSON.stringify(actionPayload)}`);
  }

  /**
   * Translate current device DP values and publish state JSON to Home Assistant
   */
  publishDeviceState(gw, targetSub = 'dali_0') {
    if (!this.client || !this.client.connected) return;

    const subInfo = gw.subDevices && gw.subDevices[targetSub];
    const dps = subInfo ? subInfo.dps : {};
    const type = (subInfo && subInfo.type) || 'dimmer';

    // Skip light state publishing for pure remote buttons
    if (type === 'remote_button') return;

    const isPowerOn = dps['20'] === true;
    const brightnessRaw = dps['22'] !== undefined ? dps['22'] : 1000;
    const colorTempRaw = dps['23'] !== undefined ? dps['23'] : 500;
    const hsvRaw = dps['24'] || '000003e803e8';

    const statePayload = {
      state: isPowerOn ? 'ON' : 'OFF',
      brightness: tuyaBrightnessToHa(brightnessRaw)
    };

    if (type === 'light_cct') {
      statePayload.color_mode = 'color_temp';
      statePayload.color_temp = tuyaColorTempToMireds(colorTempRaw);
    } else if (type === 'light_rgb' || type === 'light_rgbw') {
      statePayload.color_mode = 'hs';
      const [h, s] = tuyaHsvToHaHs(hsvRaw);
      statePayload.color = { hs: [h, s] };
    } else if (type === 'light_rgbcw') {
      if (dps['21'] === 'white') {
        statePayload.color_mode = 'color_temp';
        statePayload.color_temp = tuyaColorTempToMireds(colorTempRaw);
      } else {
        statePayload.color_mode = 'hs';
        const [h, s] = tuyaHsvToHaHs(hsvRaw);
        statePayload.color = { hs: [h, s] };
      }
    } else {
      statePayload.color_mode = 'brightness';
    }

    const stateTopic = `gavasah/tuya/${gw.id}/${targetSub}/state`;
    this.client.publish(stateTopic, JSON.stringify(statePayload), { retain: true });
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

      const gw = this.gateways.get(deviceId) || this.gateways.values().next().value;
      if (!gw) return;

      const payload = JSON.parse(message.toString('utf8'));
      this.emit('log', `[MQTT Bridge] Command from HA for [${subId}]: ${JSON.stringify(payload)}`);

      const dpsToSet = {};

      if (payload.state !== undefined) {
        dpsToSet['20'] = payload.state.toUpperCase() === 'ON';
      }

      if (payload.brightness !== undefined) {
        dpsToSet['22'] = haBrightnessToTuya(payload.brightness);
        dpsToSet['20'] = true;
      }

      if (payload.color_temp !== undefined) {
        dpsToSet['23'] = haMiredsToTuya(payload.color_temp);
        dpsToSet['21'] = 'white';
        dpsToSet['20'] = true;
      }

      // Handle HS, RGB, or RGBW color inputs
      if (payload.color) {
        if (payload.color.hs) {
          const bri = payload.brightness || 255;
          dpsToSet['24'] = haHsToTuyaHsv(payload.color.hs, bri);
          dpsToSet['21'] = 'colour';
          dpsToSet['20'] = true;
        } else if (payload.color.r !== undefined) {
          dpsToSet['24'] = rgbToTuyaHsv(payload.color.r, payload.color.g, payload.color.b);
          dpsToSet['21'] = 'colour';
          dpsToSet['20'] = true;
        }
      }

      // Dispatch to hardware via persistent TCP socket in sub-20ms
      gw.set(dpsToSet, subId);
    } catch (err) {
      this.emit('log', `[MQTT Bridge] Command dispatch failed: ${err.message}`);
    }
  }
}

module.exports = MqttBridge;
