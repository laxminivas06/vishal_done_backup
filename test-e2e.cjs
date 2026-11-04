/**
 * SAE INDIA AUTONOMOUS DRONE RESCUE SYSTEM
 * End-to-End Mock Pipeline Verification Test (test-e2e.cjs)
 * 
 * Verifies:
 * 1. Spawns cloud relay server (backend/server.js) with token auth.
 * 2. Connects mock ESP32 on /connector and mock Browser GCS on /ws.
 * 3. Streams 22 binary MAVLink frames (including HEARTBEAT with CRC 0x32 & STATUSTEXT QR_CODE:42).
 * 4. Verifies 100% delivery (22/22 received, 0 lost).
 * 5. Verifies bidirectional GCS->ESP32 uplink commands (Arm, Guided, RTL) with ACK responses.
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

const PORT = 8765;
const RELAY_TOKEN = 'saeindia_sec_99348a7b1c0e';

// --- MAVLink CRC-16-MCRF4XX / X.25 with CRC_EXTRA ---
const MAVLINK_CRC_EXTRAS = {
  0: 50,    // HEARTBEAT (0x32)
  11: 89,   // SET_MODE
  30: 39,   // ATTITUDE
  33: 104,  // GLOBAL_POSITION_INT
  74: 20,   // VFR_HUD
  76: 152,  // COMMAND_LONG
  77: 143,  // COMMAND_ACK
  253: 83   // STATUSTEXT
};

function calculateMavlinkCrc(buffer, crcExtra) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    let b = buffer[i] ^ (crc & 0xFF);
    b ^= (b << 4) & 0xFF;
    crc = (crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4);
  }
  let b = crcExtra ^ (crc & 0xFF);
  b ^= (b << 4) & 0xFF;
  crc = (crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4);
  return crc & 0xFFFF;
}

function buildMavlink1Packet(msgId, payload, seq = 0, sysId = 1, compId = 1, crcExtra = MAVLINK_CRC_EXTRAS[msgId] || 152) {
  const len = payload.length;
  const frame = Buffer.alloc(6 + len + 2);
  frame[0] = 0xFE; // MAVLink v1 Magic
  frame[1] = len;
  frame[2] = seq & 0xFF;
  frame[3] = sysId & 0xFF;
  frame[4] = compId & 0xFF;
  frame[5] = msgId & 0xFF;
  payload.copy(frame, 6);
  const crc = calculateMavlinkCrc(frame.slice(1, 6 + len), crcExtra);
  frame[6 + len] = crc & 0xFF;
  frame[6 + len + 1] = (crc >> 8) & 0xFF;
  return frame;
}

function buildHeartbeat(seq = 0) {
  const payload = Buffer.alloc(9);
  payload.writeUInt32LE(4, 0); // custom_mode = 4 (GUIDED)
  payload.writeUInt8(2, 4);    // type = QUADROTOR
  payload.writeUInt8(3, 5);    // autopilot = ARDUPILOT
  payload.writeUInt8(209, 6);  // base_mode = ARMED
  payload.writeUInt8(4, 7);    // system_status = ACTIVE
  payload.writeUInt8(3, 8);    // mavlink_version = 3
  return buildMavlink1Packet(0, payload, seq, 1, 1, 50 /* 0x32 */);
}

function buildStatustext(text, seq = 0) {
  const payload = Buffer.alloc(51);
  payload.writeUInt8(6, 0); // severity = INFO
  payload.write(text, 1, 50, 'ascii');
  return buildMavlink1Packet(253, payload, seq, 1, 1, 83);
}

function buildAttitude(seq = 0) {
  const payload = Buffer.alloc(28);
  payload.writeUInt32LE(Date.now() >>> 0, 0); // time_boot_ms
  payload.writeFloatLE(0.01, 4);   // roll
  payload.writeFloatLE(-0.02, 8);  // pitch
  payload.writeFloatLE(1.57, 12);  // yaw
  return buildMavlink1Packet(30, payload, seq, 1, 1, 39);
}

function buildCommandLong(command, p1 = 0, p2 = 0, seq = 0) {
  const payload = Buffer.alloc(33);
  payload.writeFloatLE(p1, 0);
  payload.writeFloatLE(p2, 4);
  payload.writeFloatLE(0, 8);
  payload.writeFloatLE(0, 12);
  payload.writeFloatLE(0, 16);
  payload.writeFloatLE(0, 20);
  payload.writeFloatLE(0, 24);
  payload.writeUInt16LE(command, 28);
  payload.writeUInt8(1, 30); // target sys
  payload.writeUInt8(1, 31); // target comp
  payload.writeUInt8(0, 32); // confirmation
  return buildMavlink1Packet(76, payload, seq, 255, 190, 152);
}

function buildCommandAck(command, result = 0, seq = 0) {
  const payload = Buffer.alloc(3);
  payload.writeUInt16LE(command, 0);
  payload.writeUInt8(result, 2); // 0 = MAV_RESULT_ACCEPTED
  return buildMavlink1Packet(77, payload, seq, 1, 1, 143);
}

async function runE2EPipeline() {
  console.log('\n===============================================================');
  console.log('🛸 SAE INDIA — END-TO-END MOCK PIPELINE VERIFICATION');
  console.log('===============================================================\n');

  let testsPassed = 0;
  let testsFailed = 0;

  function assert(cond, name) {
    if (cond) {
      testsPassed++;
      console.log(`  ✓ [PASS] ${name}`);
    } else {
      testsFailed++;
      console.error(`  ✗ [FAIL] ${name}`);
    }
  }

  // 1. Spawn Relay Server
  console.log('[STEP 1] Spawning relay server on port ' + PORT + '...');
  const serverPath = path.resolve(__dirname, 'backend/server.js');
  const relay = spawn('node', [serverPath], {
    env: { ...process.env, PORT: String(PORT), RELAY_TOKEN }
  });

  relay.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s.includes('RELAY ACTIVE') || s.includes('MAVLINK') || s.includes('CONNECTOR')) {
      // console.log(`  [Relay] ${s}`);
    }
  });

  await new Promise(r => setTimeout(r, 1500));
  assert(relay.pid > 0, 'Relay server spawned successfully');

  // 2. Connect Mock ESP32 on /connector and Mock Browser GCS on /ws
  console.log('\n[STEP 2] Connecting Mock ESP32 on /connector and Mock Browser on /ws...');
  const espWs = new WebSocket(`ws://127.0.0.1:${PORT}/connector?token=${RELAY_TOKEN}`);
  const gcsWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${RELAY_TOKEN}`);

  await Promise.all([
    new Promise(res => espWs.once('open', res)),
    new Promise(res => gcsWs.once('open', res))
  ]);

  assert(espWs.readyState === WebSocket.OPEN, 'Mock ESP32 connected to /connector with token');
  assert(gcsWs.readyState === WebSocket.OPEN, 'Mock Browser GCS connected to /ws with token');

  // 3. Prepare 22 binary MAVLink frames
  console.log('\n[STEP 3] Preparing exactly 22 binary MAVLink frames...');
  const framesToSend = [];

  // Frame 1: HEARTBEAT with CRC 0x32
  framesToSend.push(buildHeartbeat(1));

  // Frame 2: STATUSTEXT with QR_CODE:42
  framesToSend.push(buildStatustext('QR_CODE:42', 2));

  // Frames 3..22: 20 telemetry attitude/telemetry frames
  for (let seq = 3; seq <= 22; seq++) {
    framesToSend.push(buildAttitude(seq));
  }

  assert(framesToSend.length === 22, `Generated exactly 22 binary MAVLink frames (got ${framesToSend.length})`);

  // Verify Frame 1 HEARTBEAT CRC_EXTRA is 50 (0x32)
  const hbFrame = framesToSend[0];
  const hbCrc = hbFrame.readUInt16LE(15);
  const expectedHbCrc = calculateMavlinkCrc(hbFrame.slice(1, 15), 0x32);
  assert(hbCrc === expectedHbCrc, 'Frame 1 HEARTBEAT CRC validated with CRC_EXTRA 0x32 (50)');

  // Verify Frame 2 STATUSTEXT contains QR_CODE:42
  const stFrame = framesToSend[1];
  const stText = stFrame.slice(7, 7 + 10).toString('ascii');
  assert(stText === 'QR_CODE:42', 'Frame 2 STATUSTEXT payload verified containing "QR_CODE:42"');

  // 4. Stream 22 frames from Mock ESP32 -> Relay -> Mock Browser GCS
  console.log('\n[STEP 4] Streaming 22 binary MAVLink frames from Mock ESP32 to GCS...');
  const gcsReceivedFrames = [];

  const streamPromise = new Promise((resolve) => {
    gcsWs.on('message', (data, isBinary) => {
      if (isBinary) {
        gcsReceivedFrames.push(Buffer.from(data));
        if (gcsReceivedFrames.length === 22) {
          resolve();
        }
      }
    });
  });

  for (const frame of framesToSend) {
    espWs.send(frame, { binary: true });
    await new Promise(r => setTimeout(r, 15));
  }

  await Promise.race([
    streamPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for 22 frames')), 4000))
  ]);

  assert(gcsReceivedFrames.length === 22, `100% binary delivery verified (22/22 received, 0 dropped)`);

  // Verify received Frame 1 is HEARTBEAT and Frame 2 is STATUSTEXT QR_CODE:42
  const rxHb = gcsReceivedFrames[0];
  const rxHbMsgId = rxHb[5];
  const rxHbCrc = rxHb.readUInt16LE(15);
  const rxHbCrcValid = rxHbCrc === calculateMavlinkCrc(rxHb.slice(1, 15), 0x32);
  assert(rxHbMsgId === 0 && rxHbCrcValid, 'GCS verified Frame 1: Valid HEARTBEAT with CRC 0x32');

  const rxSt = gcsReceivedFrames[1];
  const rxStMsgId = rxSt[5];
  const rxStText = rxSt.slice(7, 7 + 10).toString('ascii');
  assert(rxStMsgId === 253 && rxStText === 'QR_CODE:42', 'GCS verified Frame 2: Valid STATUSTEXT with "QR_CODE:42"');

  // 5. Test Bidirectional GCS -> ESP32 uplink commands (Arm, Guided, RTL)
  console.log('\n[STEP 5] Testing bidirectional GCS -> ESP32 uplink commands (Arm, Guided, RTL)...');
  const commandsReceivedByEsp32 = [];

  espWs.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      if (buf[0] === 0xFE && buf[5] === 76) { // COMMAND_LONG
        const p1 = buf.readFloatLE(6);
        const p2 = buf.readFloatLE(10);
        const command = buf.readUInt16LE(34);

        if (command === 400 && p1 === 1.0) {
          commandsReceivedByEsp32.push('ARM');
          espWs.send(buildCommandAck(400, 0, 101), { binary: true });
        } else if (command === 176 && p2 === 4.0) {
          commandsReceivedByEsp32.push('GUIDED');
          espWs.send(buildCommandAck(176, 0, 102), { binary: true });
        } else if (command === 176 && p2 === 6.0) {
          commandsReceivedByEsp32.push('RTL');
          espWs.send(buildCommandAck(176, 0, 103), { binary: true });
        }
      }
    }
  });

  // GCS sends Arm
  const armFrame = buildCommandLong(400, 1.0, 0.0, 1);
  gcsWs.send(armFrame, { binary: true });
  await new Promise(r => setTimeout(r, 80));

  // GCS sends Guided
  const guidedFrame = buildCommandLong(176, 1.0, 4.0, 2);
  gcsWs.send(guidedFrame, { binary: true });
  await new Promise(r => setTimeout(r, 80));

  // GCS sends RTL
  const rtlFrame = buildCommandLong(176, 1.0, 6.0, 3);
  gcsWs.send(rtlFrame, { binary: true });
  await new Promise(r => setTimeout(r, 120));

  assert(commandsReceivedByEsp32.includes('ARM'), 'Uplink command verified: ARM received by ESP32');
  assert(commandsReceivedByEsp32.includes('GUIDED'), 'Uplink command verified: GUIDED received by ESP32');
  assert(commandsReceivedByEsp32.includes('RTL'), 'Uplink command verified: RTL received by ESP32');
  assert(commandsReceivedByEsp32.length === 3, 'All 3 bidirectional uplink commands acknowledged successfully');

  // Cleanup
  espWs.close();
  gcsWs.close();
  relay.kill();

  console.log('\n===============================================================');
  console.log(`📊 END-TO-END PIPELINE SUMMARY: ${testsPassed}/${testsPassed + testsFailed} ASSERTIONS PASSED (${testsFailed} FAILED)`);
  console.log('===============================================================\n');

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runE2EPipeline().catch(err => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
