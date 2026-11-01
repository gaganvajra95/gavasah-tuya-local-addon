/**
 * GAVASAH Tuya LAN Gateway - Sunricher DALI Center Normalization Helper
 * Translates between Home Assistant MQTT Light entities and DALI DT6 / DT8 Data Points
 */

/**
 * Converts Home Assistant brightness (0 - 255) to Tuya DALI scale (10 - 1000)
 */
function haBrightnessToTuya(haVal) {
  if (haVal <= 0) return 10;
  return Math.round(10 + (haVal / 255) * 990);
}

/**
 * Converts Tuya DALI brightness (10 - 1000) to Home Assistant scale (0 - 255)
 */
function tuyaBrightnessToHa(tuyaVal) {
  if (!tuyaVal || tuyaVal <= 10) return 0;
  return Math.round(((tuyaVal - 10) / 990) * 255);
}

/**
 * Converts Home Assistant color temp in mireds (153 - 500) to Tuya DALI Kelvin/CCT scale (0 - 1000)
 * Note: 153 mireds = ~6500K (Cold white = 1000 in Tuya), 500 mireds = ~2000K (Warm white = 0 in Tuya)
 */
function haMiredsToTuya(mireds) {
  const minMireds = 153;
  const maxMireds = 500;
  const clamped = Math.max(minMireds, Math.min(maxMireds, mireds));
  // Invert because mireds are inversely proportional to Kelvin
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
 * Predefined profiles for Sunricher DALI drivers
 */
const KNOWN_DALI_PROFILES = {
  '010008020000': {
    address: 0,
    name: 'DALI Lamp 0 (Tunable White DT8)',
    type: 'light_cct',
    features: ['brightness', 'color_temp']
  },
  '010008020001': {
    address: 1,
    name: 'DALI Lamp 1 (Tunable White DT8)',
    type: 'light_cct',
    features: ['brightness', 'color_temp']
  },
  '010006000002': {
    address: 2,
    name: 'DALI Lamp 2 (Dimmer DT6)',
    type: 'dimmer',
    features: ['brightness']
  }
};

module.exports = {
  haBrightnessToTuya,
  tuyaBrightnessToHa,
  haMiredsToTuya,
  tuyaColorTempToMireds,
  KNOWN_DALI_PROFILES
};

