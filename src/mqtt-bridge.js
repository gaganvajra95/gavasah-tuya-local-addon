/**
 * GAVASAH Tuya LAN Gateway - Home Assistant MQTT Discovery & Bridge
 * Automates native Home Assistant entity provisioning and bidirectional state synchronization
 * Full support for DALI DT6/DT8, Tuya Standalone Wi-Fi, and Zigbee Remotes / Scene Buttons
 * Unified Single-Name Architecture (has_entity_name: true, name: null)
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
   * Register a Gateway or Wi-Fi device instance to the bridge
   */
  registerGateway(gw) {
    this.gateways.set(gw.id, gw);

    // Bind real-time status events
    gw.on('status', (data) => {
      this.publishDeviceState(gw, data.subId || 'root');
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
   * Subscribe to Home Assistant command topics for both Gateways and Standalone Wi-Fi devices
   */
  subscribeCommands() {
    if (!this.client || !this.client.connected) return;
    this.client.subscribe(['gavasah/tuya/+/set', 'gavasah/tuya/+/+/set'], (err) => {
      if (!err) {
        this.emit('log', `[MQTT Bridge] Subscribed to command topics (WiFi & Gateways)`);
      }
    });
  }

  /**
   * Publish Home Assistant MQTT Discovery configuration for all gateways & devices
   */
  publishAllDiscoveries() {
    this.gateways.forEach((gw) => {
      this.publishGatewayDiscovery(gw);
      this.publishAvailability(gw, gw.isConnected ? 'online' : 'offline');
    });
  }

  /**
   * Publish Discovery schemas for all subdevices of a gateway or a standalone Wi-Fi device
   */
  publishGatewayDiscovery(gw) {
    if (!this.client || !this.client.connected) return;

    if (gw.category === 'wifi_device') {
      this.publishWifiDeviceDiscovery(gw);
      this.publishDeviceState(gw, 'root');
      return;
    }

    Object.entries(gw.subDevices || {}).forEach(([subId, info]) => {
      this.publishSubDeviceDiscovery(gw, subId, info);
      this.publishDeviceState(gw, subId);
    });
  }

  /**
   * Publish Discovery schema for a standalone Tuya Wi-Fi device
   */
  publishWifiDeviceDiscovery(dev) {
    if (!this.client || !this.client.connected) return;

    const friendlyName = dev.name;
    const type = dev.type || 'switch';
    const isLight = type.includes('light') || type.includes('dimmer') || dev.dps['20'] !== undefined || dev.dps['22'] !== undefined;

    if (isLight) {
      const discoveryTopic = `homeassistant/light/${dev.id}/config`;
      const isCct = type === 'light_cct' || type === 'light_rgbcw' || dev.dps['23'] !== undefined;
      const isRgb = type === 'light_rgb' || type === 'light_rgbw' || type === 'light_rgbcw' || dev.dps['24'] !== undefined;

      const colorModes = ['brightness'];
      if (isCct) colorModes.push('color_temp');
      if (isRgb) colorModes.push('hs', 'rgb');

      const payload = {
        name: null,
        has_entity_name: true,
        unique_id: `tuya_${dev.id}`,
        schema: 'json',
        state_topic: `gavasah/tuya/${dev.id}/state`,
        command_topic: `gavasah/tuya/${dev.id}/set`,
        availability_topic: `gavasah/tuya/${dev.id}/availability`,
        brightness: true,
        brightness_scale: 255,
        color_mode: true,
        supported_color_modes: colorModes,
        device: {
          identifiers: [`tuya_${dev.id}`],
          name: friendlyName,
          model: dev.type || 'Tuya WiFi Light',
          manufacturer: 'Tuya / GAVASAH',
          connections: dev.mac ? [['mac', dev.mac]] : []
        }
      };

      if (isCct) {
        payload.min_mireds = 153;
        payload.max_mireds = 500;
      }

      this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
      this.emit('log', `[MQTT Bridge] Published WiFi Light discovery: ${friendlyName}`);
    } else {
      // Switch / Relay / Plug
      const discoveryTopic = `homeassistant/switch/${dev.id}/config`;
      const payload = {
        name: null,
        has_entity_name: true,
        unique_id: `tuya_${dev.id}`,
        state_topic: `gavasah/tuya/${dev.id}/state`,
        command_topic: `gavasah/tuya/${dev.id}/set`,
        availability_topic: `gavasah/tuya/${dev.id}/availability`,
        value_template: '{{ value_json.state }}',
        state_on: 'ON',
        state_off: 'OFF',
        payload_on: JSON.stringify({ state: 'ON' }),
        payload_off: JSON.stringify({ state: 'OFF' }),
        device: {
          identifiers: [`tuya_${dev.id}`],
          name: friendlyName,
          model: dev.type || 'Tuya WiFi Switch',
          manufacturer: 'Tuya / GAVASAH',
          connections: dev.mac ? [['mac', dev.mac]] : []
        }
      };

      this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
      this.emit('log', `[MQTT Bridge] Published WiFi Switch discovery: ${friendlyName}`);
    }
  }

  /**
   * Publish Discovery schema for a specific gateway sub-device
   * Uses single unified name architecture (name: null, has_entity_name: true)
   */
  publishSubDeviceDiscovery(gw, subId, info) {
    if (!this.client || !this.client.connected) return;

    const type = info.type || 'dimmer';
    const friendlyName = info.name || `${gw.name} ${subId}`;

    // If device is a Remote or Scene Controller, publish as HA Event Entity
    if (type === 'remote_button') {
      const discoveryTopic = `homeassistant/event/${gw.id}_${subId}/config`;
      const payload = {
        name: null,
        has_entity_name: true,
        unique_id: `${gw.id}_${subId}_event`,
        state_topic: `gavasah/tuya/${gw.id}/${subId}/action`,
        event_types: ['single', 'double', 'hold', 'click', 'rotate_left', 'rotate_right', 'press', 'alarm'],
        device: {
          identifiers: [`tuya_${gw.id}_${subId}`],
          name: friendlyName,
          model: 'Tuya Zigbee Remote Controller',
          manufacturer: 'Tuya / GAVASAH',
          via_device: `tuya_${gw.id}`
        }
      };
      this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
      this.emit('log', `[MQTT Bridge] Published event discovery for remote: ${friendlyName}`);
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
      name: null,
      has_entity_name: true,
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
        identifiers: [`tuya_${gw.id}_${subId}`],
        name: friendlyName,
        model: `${gw.name} (${type.toUpperCase()})`,
        manufacturer: 'Sunricher / GAVASAH',
        via_device: `tuya_${gw.id}`
      }
    };

    if (isCct) {
      payload.min_mireds = 153;
      payload.max_mireds = 500;
    }

    this.client.publish(discoveryTopic, JSON.stringify(payload), { retain: true });
    this.emit('log', `[MQTT Bridge] Published unified discovery config for ${friendlyName} (${type})`);
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

    if (gw.category === 'wifi_device') {
      const dps = gw.dps || {};
      const isPowerOn = dps['1'] === true || dps['20'] === true;
      const stateTopic = `gavasah/tuya/${gw.id}/state`;
      const statePayload = {
        state: isPowerOn ? 'ON' : 'OFF',
        dps: dps
      };

      if (dps['22'] !== undefined) {
        statePayload.brightness = tuyaBrightnessToHa(dps['22']);
      }
      if (dps['23'] !== undefined) {
        statePayload.color_temp = tuyaColorTempToMireds(dps['23']);
      }
      this.client.publish(stateTopic, JSON.stringify(statePayload), { retain: true });
      return;
    }

    const subInfo = gw.subDevices && gw.subDevices[targetSub];
    const dps = subInfo ? subInfo.dps : {};
    const type = (subInfo && subInfo.type) || 'dimmer';

    // Skip light state publishing for pure remote buttons
    if (type === 'remote_button') return;

    const isPowerOn = dps['20'] === true || dps['1'] === true;
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
   * Handle incoming commands from Home Assistant (both Gateways and Standalone Wi-Fi)
   */
  handleIncomingMqtt(topic, message) {
    try {
      const parts = topic.split('/');
      // Formats:
      // gavasah/tuya/<deviceId>/set
      // gavasah/tuya/<deviceId>/<subId>/set
      if (parts.length < 4) return;
      const deviceId = parts[2];
      const subId = parts.length >= 5 ? parts[3] : 'root';

      const gw = this.gateways.get(deviceId) || this.gateways.values().next().value;
      if (!gw) return;

      const payload = JSON.parse(message.toString('utf8'));
      this.emit('log', `[MQTT Bridge] Command from HA for [${deviceId}/${subId}]: ${JSON.stringify(payload)}`);

      const dpsToSet = {};

      if (payload.dps) {
        Object.assign(dpsToSet, payload.dps);
      }

      if (payload.state !== undefined) {
        const isTrue = payload.state.toUpperCase() === 'ON';
        if (gw.category === 'wifi_device') {
          if (gw.dps['1'] !== undefined || Object.keys(gw.dps).length === 0) {
            dpsToSet['1'] = isTrue;
          }
          if (gw.dps['20'] !== undefined) {
            dpsToSet['20'] = isTrue;
          }
        } else {
          dpsToSet['20'] = isTrue;
        }
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
