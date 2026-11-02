/**
 * GAVASAH Tuya LAN Gateway - Tuya Cloud Sync Service
 * Bridges to tuya-sync-worker.py to auto-acquire local_keys, Zigbee remotes,
 * and device configurations via:
 * 1. Smart Life / Tuya Smart App QR-Code Login (Zero Developer Account)
 * 2. Tuya IoT Platform Developer API (tinytuya)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKER_SCRIPT = path.join(__dirname, 'tuya-sync-worker.py');

/**
 * Execute python worker command and parse JSON output
 */
function runWorker(args) {
  return new Promise((resolve, reject) => {
    // Prefer python3, fallback to py or python
    const pythonBin = process.platform === 'win32' ? 'py' : 'python3';
    const child = spawn(pythonBin, [WORKER_SCRIPT, ...args]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      try {
        const clean = stdout.trim();
        const jsonStart = clean.indexOf('{');
        if (jsonStart !== -1) {
          const parsed = JSON.parse(clean.substring(jsonStart));
          resolve(parsed);
        } else {
          resolve({ success: false, error: stderr || stdout || `Process exited with code ${code}` });
        }
      } catch (err) {
        resolve({ success: false, error: `JSON Parse error: ${err.message}. Raw: ${stdout || stderr}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: `Failed to spawn Python process: ${err.message}` });
    });
  });
}

/**
 * Mint a login QR code using the Smart Life / Tuya Smart app user code
 */
async function startQrLogin(userCode, scheme = 'smartlife') {
  if (!userCode) {
    return { success: false, error: 'User Code is required (Find it in Smart Life app -> Me -> Settings -> Account and Security -> User Code).' };
  }
  return runWorker(['mint_qr', userCode.trim(), scheme]);
}

/**
 * Poll QR code login status and fetch devices once authorized
 */
async function pollQrLogin(token, userCode) {
  if (!token || !userCode) {
    return { success: false, error: 'Token and User Code are required' };
  }
  return runWorker(['poll_qr', token.trim(), userCode.trim()]);
}

/**
 * Sync using Tuya IoT Developer credentials
 */
async function syncDeveloper(apiKey, apiSecret, region = 'us', sampleId = '') {
  if (!apiKey || !apiSecret) {
    return { success: false, error: 'API Key (Access ID) and API Secret are required' };
  }
  const args = ['sync_developer', apiKey.trim(), apiSecret.trim(), region.trim()];
  if (sampleId) args.push(sampleId.trim());
  return runWorker(args);
}

/**
 * Apply cloud data to live GatewayManager and MQTT Bridge
 */
function applyCloudImport(gatewayMgr, mqttBridge, cloudData) {
  const result = {
    updatedGateways: [],
    addedGateways: [],
    addedWifiDevices: [],
    discoveredRemotes: []
  };

  if (!cloudData || !cloudData.success) {
    return { success: false, error: cloudData?.error || 'No valid cloud data to apply' };
  }

  const { gateways = [], wifiDevices = [] } = cloudData;

  // 1. Process Gateways & inject real local_keys & Zigbee remotes
  gateways.forEach((cg) => {
    let existing = null;
    if (cg.id === 'd73312627d4f66c788gsrs' || cg.name.toLowerCase().includes('drasis') || cg.name.toLowerCase().includes('zigbee')) {
      existing = gatewayMgr.gateways.get('d73312627d4f66c788gsrs') || Array.from(gatewayMgr.gateways.values()).find(g => g.ip === '192.168.1.194');
    } else if (cg.id === 'd7b3f345b23032557azteo' || cg.name.toLowerCase().includes('dali')) {
      existing = gatewayMgr.gateways.get('d7b3f345b23032557azteo') || Array.from(gatewayMgr.gateways.values()).find(g => g.ip === '192.168.1.210');
    } else if (cg.ip && (cg.ip.startsWith('192.168.') || cg.ip.startsWith('10.') || cg.ip.startsWith('172.'))) {
      existing = Array.from(gatewayMgr.gateways.values()).find(g => g.ip === cg.ip);
    }

    if (existing) {
      console.log(`[Cloud Sync] 🔑 Binding real local_key and hardware ID for ${existing.name} (${existing.id} -> ${cg.id}) -> Key: ${cg.local_key}`);
      
      // Update ID in gateway map if it was a placeholder
      if (existing.id !== cg.id) {
        gatewayMgr.gateways.delete(existing.id);
        existing.id = cg.id;
        gatewayMgr.gateways.set(cg.id, existing);
      }

      existing.name = cg.name || existing.name;
      existing.type = cg.id === 'd7b3f345b23032557azteo' ? 'dali_gateway' : 'zigbee_gateway';
      existing.key = cg.local_key;

      if (cg.id === 'd73312627d4f66c788gsrs') {
        existing.ip = '192.168.1.194';
        existing.subDevices = cg.subDevices && Object.keys(cg.subDevices).length > 0 ? cg.subDevices : existing.subDevices;
      } else if (cg.id === 'd7b3f345b23032557azteo') {
        existing.ip = '192.168.1.210';
        existing.subDevices = { ...existing.subDevices, ...(cg.subDevices || {}) };
      } else if (cg.subDevices && Object.keys(cg.subDevices).length > 0) {
        existing.subDevices = { ...existing.subDevices, ...cg.subDevices };
      }

      Object.entries(existing.subDevices || {}).forEach(([subId, info]) => {
        result.discoveredRemotes.push({
          gateway: existing.name,
          subId,
          name: info.name,
          type: info.type
        });
        mqttBridge.publishSubDeviceDiscovery(existing, subId, info);
      });

      gatewayMgr.persistGateways();
      existing.destroy();
      existing.connect(); // Reconnect immediately with real local_key!

      result.updatedGateways.push({
        id: existing.id,
        name: existing.name,
        ip: existing.ip,
        mac: existing.mac,
        type: existing.type,
        subDeviceCount: Object.keys(existing.subDevices || {}).length
      });
    }
  });

    // 2. Process Standalone Wi-Fi Devices
  wifiDevices.forEach((cw) => {
    if (cw.ip && cw.local_key) {
      const existing = gatewayMgr.gateways.get(cw.id);
      if (existing) {
        existing.key = cw.local_key;
        gatewayMgr.persistGateways();
      } else {
        const dev = gatewayMgr.addWifiDevice({
          id: cw.id,
          name: cw.name,
          ip: cw.ip,
          local_key: cw.local_key,
          type: cw.type || 'switch'
        }, true);
        result.addedWifiDevices.push({
          id: dev.id,
          name: dev.name,
          ip: dev.ip
        });
      }
    }
  });

  return {
    success: true,
    ...result
  };
}

/**
 * Dump all raw device data from current session for inspection
 */
async function dumpSession() {
  return runWorker(['dump_session']);
}

/**
 * Re-sync and classify devices from current active session
 */
async function syncSession() {
  return runWorker(['sync_session']);
}

module.exports = {
  startQrLogin,
  pollQrLogin,
  syncDeveloper,
  dumpSession,
  syncSession,
  applyCloudImport
};

