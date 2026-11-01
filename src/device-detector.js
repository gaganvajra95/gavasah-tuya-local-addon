/**
 * GAVASAH Tuya LAN Gateway - Device & Gateway Classification Engine
 * Identifies hardware architecture (DALI vs Zigbee vs Wi-Fi) using ProductKey catalogs,
 * online Internet definition queries, port probing, and dynamic Linux ARP MAC resolution.
 */

const fs = require('fs');
const net = require('net');
const https = require('https');

// Local hardware catalog mapping Tuya Product Keys to verified device types
const PRODUCT_CATALOG = {
  '7nq65s28jz9mbhts': {
    name: 'Sunricher DALI Center',
    type: 'dali_gateway',
    category: 'gateway',
    desc: 'Sunricher OpenWrt DALI-1/DALI-2 IP Gateway'
  },
  'keyytm9ujajn77ce': {
    name: 'Tuya Zigbee Gateway',
    type: 'zigbee_gateway',
    category: 'gateway',
    desc: 'Tuya Zigbee 3.0 Smart LAN Gateway'
  },
  '8bexb0k4v3i0qwhj': {
    name: 'Tuya Zigbee Wireless Gateway',
    type: 'zigbee_gateway',
    category: 'gateway',
    desc: 'Tuya Zigbee 3.0 Smart Gateway'
  },
  'bvh0b0n22h1c8m9z': {
    name: 'Tuya Multi-Mode Gateway',
    type: 'zigbee_gateway',
    category: 'gateway',
    desc: 'Tuya Zigbee + BLE Mesh Gateway'
  }
};

/**
 * Check if a TCP port is open on the target IP
 */
function checkPortOpen(ip, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, ip, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Read hardware MAC address directly from Linux ARP table (/proc/net/arp)
 */
function readArpTableMac(ip) {
  if (!ip) return null;
  try {
    if (fs.existsSync('/proc/net/arp')) {
      const text = fs.readFileSync('/proc/net/arp', 'utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === ip && parts[3] && parts[3] !== '00:00:00:00:00:00') {
          return parts[3].toLowerCase();
        }
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Dynamically resolve MAC address for an IP by sending a lightweight probe to populate ARP
 */
async function resolveMacAddress(ip) {
  if (!ip) return null;

  // 1. Check existing ARP cache
  let mac = readArpTableMac(ip);
  if (mac) return mac;

  // 2. Probe port 6668 to trigger kernel ARP resolution
  await checkPortOpen(ip, 6668, 500);
  mac = readArpTableMac(ip);
  if (mac) return mac;

  // 3. Probe port 23
  await checkPortOpen(ip, 23, 500);
  mac = readArpTableMac(ip);
  if (mac) return mac;

  return null;
}

/**
 * Query online Tuya definitions if an unknown productKey is encountered
 */
async function lookupProductOnline(productKey) {
  if (!productKey) return null;
  if (PRODUCT_CATALOG[productKey]) return PRODUCT_CATALOG[productKey];

  try {
    const url = `https://raw.githubusercontent.com/gaganvajra95/tuya-device-definitions/main/products/${productKey}.json`;
    const res = await new Promise((resolve) => {
      const req = https.get(url, { timeout: 2000 }, (r) => {
        if (r.statusCode !== 200) return resolve(null);
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    if (res && res.type) {
      PRODUCT_CATALOG[productKey] = res;
      return res;
    }
  } catch (err) {}

  // Heuristic rule: Tuya Zigbee product keys typically start with 'key' or contain 'zigbee'
  if (productKey.toLowerCase().includes('zigbee') || productKey.startsWith('key')) {
    const inferred = {
      name: 'Tuya Zigbee Gateway',
      type: 'zigbee_gateway',
      category: 'gateway',
      desc: 'Tuya Zigbee 3.0 LAN Gateway'
    };
    PRODUCT_CATALOG[productKey] = inferred;
    return inferred;
  }

  return null;
}

/**
 * Classify a device/gateway based on IP, productKey, and open ports
 */
async function classifyTuyaEndpoint(ip, productKey = null) {
  // 1. ProductKey catalog or online lookup
  if (productKey) {
    const catalogInfo = await lookupProductOnline(productKey);
    if (catalogInfo) {
      return {
        ...catalogInfo,
        productKey
      };
    }
  }

  // 2. Check Telnet port 23 (Sunricher DALI OpenWrt gateway)
  const isTelnetOpen = await checkPortOpen(ip, 23);
  if (isTelnetOpen) {
    return {
      name: 'Sunricher DALI Center',
      type: 'dali_gateway',
      category: 'gateway',
      desc: 'Sunricher OpenWrt DALI Gateway'
    };
  }

  // 3. Check Tuya TCP port 6668
  const isTuyaOpen = await checkPortOpen(ip, 6668);
  if (isTuyaOpen) {
    return {
      name: 'Tuya Zigbee Gateway',
      type: 'zigbee_gateway',
      category: 'gateway',
      desc: 'Tuya Zigbee Smart Gateway'
    };
  }

  return {
    name: `Tuya Gateway ${ip}`,
    type: 'generic_gateway',
    category: 'gateway',
    desc: 'Generic Tuya LAN Gateway'
  };
}

module.exports = {
  PRODUCT_CATALOG,
  checkPortOpen,
  readArpTableMac,
  resolveMacAddress,
  lookupProductOnline,
  classifyTuyaEndpoint
};
