/**
 * GAVASAH Tuya LAN Gateway - Cryptographic Engine
 * Supports Tuya Protocol v3.1, v3.3, v3.4, and v3.5 (AES-128-ECB and AES-128-GCM)
 */

const crypto = require('crypto');

// Standard Tuya Protocol Headers and Footers
const PREFIX_BYTES = Buffer.from([0x00, 0x00, 0x55, 0xaa]);
const SUFFIX_BYTES = Buffer.from([0x00, 0x00, 0xaa, 0x55]);

// Default UDP broadcast decryption key (MD5 of "yGAdlopoPVldABfn")
const DEFAULT_UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

// Standard Tuya Command Codes
const COMMANDS = {
  UDP_DISCOVERY: 0x13, // 19
  AP_CONFIG: 0x01,     // 1
  ACTIVE: 0x02,        // 2
  BIND: 0x03,          // 3
  RENAME_GW: 0x04,     // 4
  RENAME_DEVICE: 0x05, // 5
  UNBIND: 0x06,        // 6
  CONTROL: 0x07,       // 7
  STATUS: 0x08,        // 8
  HEARTBEAT: 0x09,     // 9
  DP_QUERY: 0x0a,      // 10
  STATUS_NEW: 0x0b,    // 11
  DP_QUERY_NEW: 0x10,  // 16
  CONTROL_NEW: 0x0d    // 13
};

/**
 * Calculate CRC-32 for Tuya v3.1 and v3.3 frames
 */
function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
 * AES-128-ECB Decryption (Robust PKCS#7 handling)
 */
function decryptECB(encryptedBuffer, key) {
  const cipherKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8');
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', cipherKey, '');
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  } catch (err) {
    // Fallback: manually strip PKCS#7 padding if standard autoPadding rejects
    const decipher = crypto.createDecipheriv('aes-128-ecb', cipherKey, '');
    decipher.setAutoPadding(false);
    const raw = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
    const pad = raw[raw.length - 1];
    if (pad > 0 && pad <= 16) {
      return raw.slice(0, raw.length - pad);
    }
    return raw;
  }
}

/**
 * AES-128-ECB Encryption
 */
function encryptECB(plainBuffer, key) {
  const cipherKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', cipherKey, '');
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
}

/**
 * AES-128-GCM Decryption (v3.4 / v3.5)
 */
function decryptGCM(encryptedBuffer, key, iv, authTag, aad = Buffer.alloc(0)) {
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
  if (aad && aad.length > 0) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
}

/**
 * Encode a full Tuya LAN TCP frame
 */
function encodeFrame(cmd, payloadObj, key, version = '3.3', seq = 0) {
  const cipherKey = Buffer.isBuffer(key) ? key : Buffer.from(key, 'utf8');
  let payloadBuffer;

  if (cmd === COMMANDS.HEARTBEAT) {
    // Tuya 3.3 Heartbeat has 0-length payload
    payloadBuffer = Buffer.alloc(0);
  } else {
    const jsonStr = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
    if (version === '3.1') {
      payloadBuffer = Buffer.from(jsonStr, 'utf8');
    } else if (version === '3.3') {
      const rawBuffer = Buffer.from(jsonStr, 'utf8');
      const encrypted = encryptECB(rawBuffer, cipherKey);
      // In v3.3 CONTROL or DP_QUERY, prefix payload with "3.3" + 12 zero bytes
      const headerPrefix = Buffer.from('3.3\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00');
      payloadBuffer = Buffer.concat([headerPrefix, encrypted]);
    } else {
      payloadBuffer = encryptECB(Buffer.from(jsonStr, 'utf8'), cipherKey);
    }
  }

  // Length = payload length + 4 (CRC) + 4 (Suffix)
  const length = payloadBuffer.length + 8;
  const header = Buffer.alloc(16);
  PREFIX_BYTES.copy(header, 0);
  header.writeUInt32BE(seq, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(length, 12);

  // Calculate CRC over header + payload
  const toChecksum = Buffer.concat([header, payloadBuffer]);
  const crc = crc32(toChecksum);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);

  return Buffer.concat([header, payloadBuffer, crcBuf, SUFFIX_BYTES]);
}

/**
 * Decode an incoming Tuya LAN packet
 */
function decodeFrame(buffer, key, version = '3.3') {
  if (buffer.length < 24) return null;
  if (!buffer.slice(0, 4).equals(PREFIX_BYTES)) return null;

  const seq = buffer.readUInt32BE(4);
  const cmd = buffer.readUInt32BE(8);
  const length = buffer.readUInt32BE(12);

  let payload = buffer.slice(16, buffer.length - 8);
  let retCode = 0;

  if (payload.length >= 4) {
    retCode = payload.readUInt32BE(0);
    if (retCode === 0) {
      payload = payload.slice(4);
    }
  }

  if (payload.length === 0) {
    return { seq, cmd, retCode, payload: null };
  }

  // Version 3.3 payload unstripping
  if (payload.length >= 15 && payload.slice(0, 3).toString('ascii') === '3.3') {
    payload = payload.slice(15);
  }

  let decryptedJson = null;
  if (payload.length > 0 && payload.length % 16 === 0) {
    try {
      const decryptedBuf = decryptECB(payload, key);
      decryptedJson = JSON.parse(decryptedBuf.toString('utf8').trim());
    } catch (err) {
      try {
        decryptedJson = JSON.parse(payload.toString('utf8').trim());
      } catch (e) {}
    }
  } else {
    try {
      decryptedJson = JSON.parse(payload.toString('utf8').trim());
    } catch (e) {}
  }

  return { seq, cmd, retCode, payload: decryptedJson };
}

module.exports = {
  PREFIX_BYTES,
  SUFFIX_BYTES,
  DEFAULT_UDP_KEY,
  COMMANDS,
  crc32,
  decryptECB,
  encryptECB,
  decryptGCM,
  encodeFrame,
  decodeFrame
};
