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

let rxBuffer = Buffer.alloc(0);
let pixhawkSysId = 1;
let pixhawkCompId = 1;
let receivedHeartbeat = false;

ws.on('open', () => {
  console.log('Connected to Render backend WSS relay!');
});

ws.on('message', (data) => {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
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
        if (rxCrc !== calcCrc) { offset++; continue; }
      } else { offset++; continue; }
      handleMessage(msgId, rxBuffer.slice(offset + 6, offset + 6 + payloadLen), rxBuffer[offset + 3], rxBuffer[offset + 4], 'v1');
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
        if (rxCrc !== calcCrc) { offset++; continue; }
      } else { offset++; continue; }
      handleMessage(msgId, rxBuffer.slice(offset + 10, offset + 10 + payloadLen), rxBuffer[offset + 5], rxBuffer[offset + 6], 'v2');
      offset += packetLen;
      continue;
    }
  }

  if (offset > 0) {
    rxBuffer = rxBuffer.slice(offset);
  }
});

let totalItems = 0;
let downloadedItems = [];

function handleMessage(msgId, payload, sysId, compId, ver) {
  if (msgId === 0) {
    if (!receivedHeartbeat) {
      receivedHeartbeat = true;
      pixhawkSysId = sysId;
      pixhawkCompId = compId;
      console.log(`[HEARTBEAT] Pixhawk identified: sys=${sysId} comp=${compId}`);
      requestMissionList();
    }
  } else if (msgId === 44) {
    totalItems = payload.readUInt16LE(0);
    console.log(`[MISSION_COUNT RX] Pixhawk has ${totalItems} items stored.`);
    if (totalItems > 0) {
      requestItem(0);
    }
  } else if (msgId === 39 || msgId === 73) {
    console.log(`[MISSION_ITEM RX] msgId=${msgId} len=${payload.length}`);
    let seq, cmd, lat, lon, alt;
    if (msgId === 73) {
      lat = payload.readInt32LE(16) / 1e7;
      lon = payload.readInt32LE(20) / 1e7;
      alt = payload.readFloatLE(24);
      seq = payload.readUInt16LE(28);
      cmd = payload.readUInt16LE(30);
    } else {
      lat = payload.readFloatLE(16);
      lon = payload.readFloatLE(20);
      alt = payload.readFloatLE(24);
      seq = payload.readUInt16LE(28);
      cmd = payload.readUInt16LE(30);
    }
    console.log(`  Downloaded item #${seq}: cmd=${cmd} lat=${lat.toFixed(6)} lon=${lon.toFixed(6)} alt=${alt.toFixed(1)}m`);
    downloadedItems.push({ seq, cmd, lat, lon, alt });
    if (downloadedItems.length < totalItems) {
      requestItem(downloadedItems.length);
    } else {
      console.log(`All ${totalItems} items successfully downloaded! Sending MISSION_ACK (accepted)...`);
      sendAck();
      setTimeout(() => {
        console.log('Download test PASSED completely!');
        ws.close();
        process.exit(0);
      }, 500);
    }
  }
}

function requestMissionList() {
  console.log('Sending MISSION_REQUEST_LIST...');
  const payload = new Uint8Array(3);
  payload[0] = pixhawkSysId;
  payload[1] = pixhawkCompId;
  payload[2] = 0; // MAV_MISSION_TYPE_MISSION
  const packet = buildMavlink2Frame(43, payload);
  ws.send(packet, { binary: true });
}

function requestItem(seq) {
  console.log(`Requesting item seq=${seq}...`);
  const payload = new Uint8Array(5);
  const view = new DataView(payload.buffer);
  view.setUint16(0, seq, true);
  view.setUint8(2, pixhawkSysId);
  view.setUint8(3, pixhawkCompId);
  view.setUint8(4, 0); // MAV_MISSION_TYPE_MISSION
  const packet = buildMavlink2Frame(51 /* MISSION_REQUEST_INT */, payload);
  ws.send(packet, { binary: true });
}

function sendAck() {
  const payload = new Uint8Array(3);
  payload[0] = pixhawkSysId;
  payload[1] = pixhawkCompId;
  payload[2] = 0; // MAV_MISSION_ACCEPTED
  const packet = buildMavlink2Frame(47, payload);
  ws.send(packet, { binary: true });
}

setTimeout(() => {
  console.log('Timeout test completed.');
  ws.close();
  process.exit(0);
}, 10000);
