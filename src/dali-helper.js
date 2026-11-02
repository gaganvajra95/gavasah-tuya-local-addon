/**
 * GAVASAH Tuya LAN Gateway - Sunricher DALI & Tuya Normalization Helper
 * Supports DT6, DT8 CCT, DT8 RGB/RGBW/RGBCW, Tuya Zigbee Remotes, Scene Switches, and Sensors
 */

/**
 * Converts Home Assistant brightness (0 - 255) to Tuya DALI scale (10 - 1000)
 */
function haBrightnessToTuya(haVal) {
  if (haVal <= 0) return 10;
  return Math.round(10 + (Math.min(255, Math.max(0, haVal)) / 255) * 990);
}

/**
 * Converts Tuya DALI brightness (10 - 1000) to Home Assistant scale (0 - 255)
 */
function tuyaBrightnessToHa(tuyaVal) {
  if (!tuyaVal || tuyaVal <= 10) return 0;
  return Math.round(((Math.min(1000, Math.max(10, tuyaVal)) - 10) / 990) * 255);
}

/**
 * Converts Home Assistant color temp in mireds (153 - 500) to Tuya DALI Kelvin/CCT scale (0 - 1000)
 */
function haMiredsToTuya(mireds) {
  const minMireds = 153;
  const maxMireds = 500;
  const clamped = Math.max(minMireds, Math.min(maxMireds, mireds));
  const ratio = (maxMireds - clamped) / (maxMireds - minMireds);
  return Math.round(ratio * 1000);
}

/**
 * Converts Tuya DALI Kelvin/CCT (0 - 1000) to Home Assistant mireds (153 - 500)
 */
function tuyaColorTempToMireds(tuyaVal) {
  const minMireds = 153;
  const maxMireds = 500;
  const clamped = Math.max(0, Math.min(1000, tuyaVal || 0));
  const ratio = clamped / 1000;
  return Math.round(maxMireds - ratio * (maxMireds - minMireds));
}

/**
 * Converts Tuya HSV hex string (HHHHSSSSVVVV, 12 hex chars) to Home Assistant HS [hue, saturation]
 */
function tuyaHsvToHaHs(hsvStr) {
  if (!hsvStr || hsvStr.length < 12) return [0, 100];
  const h = parseInt(hsvStr.substring(0, 4), 16) || 0;
  const s = parseInt(hsvStr.substring(4, 8), 16) || 0;
  return [Math.min(360, Math.max(0, h)), Math.min(100, Math.max(0, Math.round(s / 10)))];
}

/**
 * Converts Home Assistant HS [hue, saturation] and brightness to Tuya HSV hex string
 */
function haHsToTuyaHsv(hsArray, haBri = 255) {
  const h = Math.min(360, Math.max(0, Math.round(hsArray[0] || 0)));
  const s = Math.min(1000, Math.max(0, Math.round((hsArray[1] || 100) * 10)));
  const v = Math.min(1000, Math.max(10, Math.round(10 + (haBri / 255) * 990)));

  const hHex = h.toString(16).padStart(4, '0');
  const sHex = s.toString(16).padStart(4, '0');
  const vHex = v.toString(16).padStart(4, '0');
  return `${hHex}${sHex}${vHex}`;
}

/**
 * Converts RGB [r, g, b] (0-255) to Tuya HSV hex string
 */
function rgbToTuyaHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;

  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  const tuyaH = Math.round(h * 360);
  const tuyaS = Math.round(s * 1000);
  const tuyaV = Math.round(v * 1000);

  return tuyaH.toString(16).padStart(4, '0') +
         tuyaS.toString(16).padStart(4, '0') +
         tuyaV.toString(16).padStart(4, '0');
}

/**
 * Known profiles for Sunricher DALI drivers
 */
const KNOWN_DALI_PROFILES = {
  '010008020000': {
    address: 0,
    name: 'DALI Lamp 0',
    type: 'light_cct',
    label: 'DT8 Tunable White'
  },
  '010008020001': {
    address: 1,
    name: 'DALI Lamp 1',
    type: 'light_cct',
    label: 'DT8 Tunable White'
  },
  '010006000002': {
    address: 2,
    name: 'DALI Lamp 2',
    type: 'dimmer',
    label: 'DT6 Dimmer'
  }
};

/**
 * Check if payload looks like a Tuya remote button action or scene switch
 */
function isRemoteAction(dps = {}) {
  const remoteKeywords = ['single', 'double', 'hold', 'click', 'rotate_left', 'rotate_right', 'press', 'alarm'];
  for (const [k, val] of Object.entries(dps)) {
    let buttonNum = k;
    const match = k.match(/(\d+)/);
    if (match) {
      buttonNum = match[1];
    }
    if (typeof val === 'string' && remoteKeywords.some(kw => val.toLowerCase().includes(kw))) {
      return { isRemote: true, button: buttonNum, action: val };
    }
    // Scene switch button numbers where DP is 1,2,3,4 and not 20/22
    if (!dps['20'] && !dps['22'] && ['1', '2', '3', '4'].includes(k) && typeof val === 'string') {
      return { isRemote: true, button: k, action: val };
    }
  }
  return { isRemote: false };
}

/**
 * Determine driver/device type from DP capability
 */
function inferDriverType(dps = {}) {
  const remoteCheck = isRemoteAction(dps);
  if (remoteCheck.isRemote) {
    return 'remote_button';
  }
  if (dps['24']) {
    return dps['23'] ? 'light_rgbcw' : 'light_rgb';
  }
  if (dps['23']) {
    return 'light_cct';
  }
  if (dps['20'] !== undefined || dps['22'] !== undefined) {
    return 'dimmer';
  }
  return 'switch';
}

module.exports = {
  haBrightnessToTuya,
  tuyaBrightnessToHa,
  haMiredsToTuya,
  tuyaColorTempToMireds,
  tuyaHsvToHaHs,
  haHsToTuyaHsv,
  rgbToTuyaHsv,
  inferDriverType,
  isRemoteAction,
  KNOWN_DALI_PROFILES
};
