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
  const extraCrc = MAVLINK_CRC_EXTRAS[msgId] ?? 152;
  let b = extraCrc ^ (crc & 0xFF);
  b ^= (b << 4) & 0xFF;
  crc = (crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4);
  return crc & 0xFFFF;
}

let sendSeq = 0;
function buildMavlink2Frame(msgId, payload) {
  sendSeq = (sendSeq + 1) % 256;
  const len = payload.length;
  const frame = new Uint8Array(10 + len + 2);
  frame[0] = 0xFD;
  frame[1] = len;
  frame[2] = 0;
  frame[3] = 0;
  frame[4] = sendSeq;
  frame[5] = 255;
  frame[6] = 190;
  frame[7] = msgId & 0xFF;
  frame[8] = (msgId >> 8) & 0xFF;
  frame[9] = (msgId >> 16) & 0xFF;
  frame.set(payload, 10);
  const crc = calculateMavlinkCrc(frame.subarray(1, 10 + len), msgId);
  frame[10 + len] = crc & 0xFF;
  frame[10 + len + 1] = (crc >> 8) & 0xFF;
  return frame;
}

function buildMavlink1Frame(msgId, payload) {
  sendSeq = (sendSeq + 1) % 256;
  const len = payload.length;
  const frame = new Uint8Array(6 + len + 2);
  frame[0] = 0xFE;
  frame[1] = len;
  frame[2] = sendSeq;
  frame[3] = 255;
  frame[4] = 190;
  frame[5] = msgId;
  frame.set(payload, 6);
  const crc = calculateMavlinkCrc(frame.subarray(1, 6 + len), msgId);
  frame[6 + len] = crc & 0xFF;
  frame[6 + len + 1] = (crc >> 8) & 0xFF;
  return frame;
}

let rxBuffer = Buffer.alloc(0);
let pixhawkSysId = 1;
let pixhawkCompId = 1;
let receivedHeartbeat = false;

ws.on('open', () => {
  console.log('Connected to Render backend WSS relay!');
});

ws.on('message', (data) => {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  console.log(`[WS RX] ${chunk.length} bytes, magic=0x${chunk[0].toString(16)}`);
  rxBuffer = Buffer.concat([rxBuffer, chunk]);

  let offset = 0;
  while (offset < rxBuffer.length) {
    const magic = rxBuffer[offset];
    if (magic !== 0xFE && magic !== 0xFD) {
      offset++;
      continue;
    }

    const remaining = rxBuffer.length - offset;

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

function handleMessage(msgId, payload, sysId, compId, ver) {
  if (msgId === 0) {
    if (!receivedHeartbeat) {
      receivedHeartbeat = true;
      pixhawkSysId = sysId;
      pixhawkCompId = compId;
      console.log(`[HEARTBEAT] Pixhawk identified: sys=${sysId} comp=${compId}`);
      testMissionCount();
    }
  } else if (msgId === 253) {
    const text = payload.slice(1, payload.indexOf(0) === -1 ? payload.length : payload.indexOf(0)).toString('utf8');
    console.log(`[STATUSTEXT] sev=${payload[0]} text="${text}"`);
  } else if (msgId === 44) {
    console.log(`[MISSION_COUNT RX] count=${payload.readUInt16LE(0)}`);
  } else if (msgId === 40 || msgId === 51) {
    const seq = payload.readUInt16LE(0);
    console.log(`[MISSION_REQUEST RX] msgId=${msgId} requested seq=${seq}`);
    // Respond to requested seq
    sendTestItem(seq);
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
    console.log(`[MISSION_ACK RX] result=${ackResult} (${ackNames[ackResult] || 'CODE_' + ackResult})`);
  }
}

function testMissionCount() {
  console.log('Sending MISSION_COUNT (count=3)...');
  const countPayload = new Uint8Array(5);
  const view = new DataView(countPayload.buffer);
  view.setUint16(0, 3, true);
  view.setUint8(2, pixhawkSysId);
  view.setUint8(3, pixhawkCompId);
  view.setUint8(4, 0); // MAV_MISSION_TYPE_MISSION

  const packet = buildMavlink2Frame(44 /* MISSION_COUNT */, countPayload);
  ws.send(packet, { binary: true });
  console.log('MISSION_COUNT sent via WebSocket!');
}

function sendTestItem(seq) {
  console.log(`Sending MISSION_ITEM_INT for seq=${seq}...`);
  const payload = new Uint8Array(38);
  const view = new DataView(payload.buffer);
  
  if (seq === 0) {
    // Seq 0: Home (cmd 16, frame 0)
    view.setFloat32(0, 0, true);
    view.setFloat32(4, 0, true);
    view.setFloat32(8, 0, true);
    view.setFloat32(12, 0, true);
    view.setInt32(16, Math.round(17.282962 * 1e7), true);
    view.setInt32(20, Math.round(78.553620 * 1e7), true);
    view.setFloat32(24, 0, true);
    view.setUint16(28, 0, true);
    view.setUint16(30, 16, true);
    view.setUint8(32, pixhawkSysId);
    view.setUint8(33, pixhawkCompId);
    view.setUint8(34, 0); // MAV_FRAME_GLOBAL
    view.setUint8(35, 0);
    view.setUint8(36, 1);
    view.setUint8(37, 0);
  } else if (seq === 1) {
    // Seq 1: Takeoff (cmd 22, frame 6)
    view.setFloat32(0, 0, true);
    view.setFloat32(4, 0, true);
    view.setFloat32(8, 0, true);
    view.setFloat32(12, 0, true);
    view.setInt32(16, Math.round(17.282962 * 1e7), true);
    view.setInt32(20, Math.round(78.553620 * 1e7), true);
    view.setFloat32(24, 15, true); // 15m alt
    view.setUint16(28, 1, true);
    view.setUint16(30, 22, true); // MAV_CMD_NAV_TAKEOFF
    view.setUint8(32, pixhawkSysId);
    view.setUint8(33, pixhawkCompId);
    view.setUint8(34, 6); // MAV_FRAME_GLOBAL_RELATIVE_ALT_INT
    view.setUint8(35, 0);
    view.setUint8(36, 1);
    view.setUint8(37, 0);
  } else if (seq === 2) {
    // Seq 2: RTL (cmd 20, frame 0)
    view.setFloat32(0, 0, true);
    view.setFloat32(4, 0, true);
    view.setFloat32(8, 0, true);
    view.setFloat32(12, 0, true);
    view.setInt32(16, Math.round(17.282962 * 1e7), true);
    view.setInt32(20, Math.round(78.553620 * 1e7), true);
    view.setFloat32(24, 0, true);
    view.setUint16(28, 2, true);
    view.setUint16(30, 20, true); // MAV_CMD_NAV_RETURN_TO_LAUNCH
    view.setUint8(32, pixhawkSysId);
    view.setUint8(33, pixhawkCompId);
    view.setUint8(34, 0);
    view.setUint8(35, 0);
    view.setUint8(36, 1);
    view.setUint8(37, 0);
  }

  const packet = buildMavlink2Frame(73 /* MISSION_ITEM_INT */, payload);
  ws.send(packet, { binary: true });
  console.log(`MISSION_ITEM_INT seq=${seq} sent!`);
}

setTimeout(() => {
  console.log('Test completed.');
  ws.close();
  process.exit(0);
}, 10000);
