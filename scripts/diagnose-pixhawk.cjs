const WebSocket = require('ws');

const ws = new WebSocket('wss://vishal-done-backup.onrender.com/ws?token=saeindia_sec_99348a7b1c0e');

console.log('Connecting to wss://vishal-done-backup.onrender.com/ws ...');

const MAVLINK_CRC_EXTRAS = {
  0: 50,   // HEARTBEAT
  1: 124,  // SYS_STATUS
  2: 137,  // SYSTEM_TIME
  4: 237,  // PING
  11: 89,  // SET_MODE
  20: 214, // PARAM_REQUEST_READ
  21: 159, // PARAM_REQUEST_LIST
  22: 220, // PARAM_VALUE
  23: 168, // PARAM_SET
  24: 24,  // GPS_RAW_INT
  29: 115, // SCALED_PRESSURE
  30: 39,  // ATTITUDE
  32: 185, // LOCAL_POSITION_NED
  33: 104, // GLOBAL_POSITION_INT
  36: 222, // SERVO_OUTPUT_RAW
  39: 254, // MISSION_ITEM
  40: 230, // MISSION_REQUEST
  42: 28,  // MISSION_SET_CURRENT
  43: 132, // MISSION_REQUEST_LIST
  44: 221, // MISSION_COUNT
  45: 232, // MISSION_CLEAR_ALL
  46: 11,  // MISSION_ITEM_REACHED
  47: 153, // MISSION_ACK
  51: 196, // MISSION_REQUEST_INT
  62: 183, // NAV_CONTROLLER_OUTPUT
  65: 118, // RC_CHANNELS
  66: 148, // REQUEST_DATA_STREAM
  73: 38,  // MISSION_ITEM_INT
  74: 20,  // VFR_HUD
  75: 158, // COMMAND_INT
  76: 152, // COMMAND_LONG
  77: 143, // COMMAND_ACK
  124: 87, // GPS2_RAW
  125: 203, // POWER_STATUS
  147: 154, // BATTERY_STATUS
  163: 187, // AHRS2
  168: 21,  // WIND
  242: 104, // HOME_POSITION
  253: 83  // STATUSTEXT
};

function calculateMavlinkCrc(buffer, msgId) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    let b = buffer[i] ^ (crc & 0xFF);
    b ^= (b << 4) & 0xFF;
    crc = (crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4);
  }
  const extraCrc = MAVLINK_CRC_EXTRAS[msgId];
  if (extraCrc !== undefined) {
    let b = extraCrc ^ (crc & 0xFF);
    b ^= (b << 4) & 0xFF;
    crc = (crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4);
  }
  return crc & 0xFFFF;
}

let rxBuffer = Buffer.alloc(0);

ws.on('open', () => {
  console.log('Connected to Render backend WSS relay!');
});

ws.on('message', (data) => {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (chunk[0] !== 0x7B) { // not JSON
    // console.log(`Received binary chunk: ${chunk.length} bytes`);
  }
  rxBuffer = Buffer.concat([rxBuffer, chunk]);

  let offset = 0;
  while (offset < rxBuffer.length) {
    const magic = rxBuffer[offset];
    if (magic !== 0xFE && magic !== 0xFD) {
      offset++;
      continue;
    }

    const remaining = rxBuffer.length - offset;

    // MAVLink 1
    if (magic === 0xFE) {
      if (remaining < 6) break;
      const payloadLen = rxBuffer[offset + 1];
      const packetLen = 6 + payloadLen + 2;
      if (remaining < packetLen) break;

      const msgId = rxBuffer[offset + 5];
      if (MAVLINK_CRC_EXTRAS[msgId] !== undefined) {
        const rxCrc = rxBuffer.readUInt16LE(offset + 6 + payloadLen);
        const calcCrc = calculateMavlinkCrc(rxBuffer.slice(offset + 1, offset + 6 + payloadLen), msgId);
        if (rxCrc !== calcCrc) {
          offset++;
          continue;
        }
      } else {
        // Unknown msgId without CRC extra table entry, skip false sync
        offset++;
        continue;
      }

      const sysId = rxBuffer[offset + 3];
      const compId = rxBuffer[offset + 4];
      const payload = rxBuffer.slice(offset + 6, offset + 6 + payloadLen);
      handleMessage(msgId, payload, sysId, compId, 'MAVLink 1');
      offset += packetLen;
      continue;
    }

    // MAVLink 2
    if (magic === 0xFD) {
      if (remaining < 10) break;
      const payloadLen = rxBuffer[offset + 1];
      const incompatFlags = rxBuffer[offset + 2];
      const signatureLen = (incompatFlags & 0x01) ? 13 : 0;
      const packetLen = 10 + payloadLen + 2 + signatureLen;
      if (remaining < packetLen) break;

      const msgId = rxBuffer[offset + 7] | (rxBuffer[offset + 8] << 8) | (rxBuffer[offset + 9] << 16);
      if (MAVLINK_CRC_EXTRAS[msgId] !== undefined) {
        const rxCrc = rxBuffer.readUInt16LE(offset + 10 + payloadLen);
        const calcCrc = calculateMavlinkCrc(rxBuffer.slice(offset + 1, offset + 10 + payloadLen), msgId);
        if (rxCrc !== calcCrc) {
          offset++;
          continue;
        }
      } else {
        // console.log(`[UNKNOWN MSG] MAVLink 2 msgId=${msgId} len=${payloadLen}`);
        offset++;
        continue;
      }

      const sysId = rxBuffer[offset + 5];
      const compId = rxBuffer[offset + 6];
      const payload = rxBuffer.slice(offset + 10, offset + 10 + payloadLen);
      handleMessage(msgId, payload, sysId, compId, 'MAVLink 2');
      offset += packetLen;
      continue;
    }
  }

  if (offset > 0) {
    rxBuffer = rxBuffer.slice(offset);
  }
});

let lastHeartbeat = 0;

function handleMessage(msgId, payload, sysId, compId, ver) {
  if (msgId === 0) {
    const now = Date.now();
    if (now - lastHeartbeat > 3000) {
      lastHeartbeat = now;
      const customMode = payload.readUInt32LE(0);
      const isArmed = (payload[6] & 128) !== 0;
      console.log(`[HEARTBEAT] ${ver} sys=${sysId} comp=${compId} armed=${isArmed} customMode=${customMode}`);
    }
  } else if (msgId === 253) {
    const severity = payload[0];
    const textBytes = payload.slice(1);
    let nullIdx = textBytes.indexOf(0);
    if (nullIdx === -1) nullIdx = textBytes.length;
    const text = textBytes.slice(0, nullIdx).toString('utf8');
    console.log(`[STATUSTEXT] sev=${severity} text="${text}"`);
  } else if (msgId === 24) {
    const fixType = payload[28];
    const lat = payload.readInt32LE(8) / 1e7;
    const lon = payload.readInt32LE(12) / 1e7;
    const alt = payload.readInt32LE(16) / 1000;
    const sats = payload[29];
    if (Math.random() < 0.05) {
      console.log(`[GPS_RAW_INT] fix=${fixType} sats=${sats} lat=${lat.toFixed(6)} lon=${lon.toFixed(6)} alt=${alt.toFixed(1)}m`);
    }
  } else if (msgId === 44) {
    const count = payload.readUInt16LE(0);
    console.log(`[MISSION_COUNT] count=${count} targetSys=${payload[2]} targetComp=${payload[3]}`);
  } else if (msgId === 40 || msgId === 51) {
    const seq = payload.readUInt16LE(0);
    console.log(`[MISSION_REQUEST${msgId === 51 ? '_INT' : ''}] seq=${seq}`);
  } else if (msgId === 39 || msgId === 73) {
    const seq = payload.readUInt16LE(28);
    const cmd = payload.readUInt16LE(30);
    const frame = payload[34];
    console.log(`[MISSION_ITEM${msgId === 73 ? '_INT' : ''}] seq=${seq} cmd=${cmd} frame=${frame}`);
  } else if (msgId === 47) {
    const ackResult = payload[2];
    const ackNames = {
      0: 'ACCEPTED',
      1: 'ERROR',
      2: 'UNSUPPORTED_FRAME',
      3: 'UNSUPPORTED',
      4: 'NO_SPACE',
      5: 'INVALID',
      6: 'INVALID_PARAM1',
      7: 'INVALID_PARAM2',
      8: 'INVALID_PARAM3',
      9: 'INVALID_PARAM4',
      10: 'INVALID_PARAM5_X',
      11: 'INVALID_PARAM6_Y',
      12: 'INVALID_PARAM7',
      13: 'INVALID_SEQUENCE',
      14: 'DENIED',
      15: 'CANCELLED'
    };
    console.log(`[MISSION_ACK] result=${ackResult} (${ackNames[ackResult] || 'UNKNOWN'})`);
  }
}

ws.on('error', (err) => console.error('WS Error:', err));
setTimeout(() => {
  console.log('Finished 15s listening.');
  ws.close();
  process.exit(0);
}, 15000);
