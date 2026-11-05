const fs = require('fs');
const path = require('path');

// 1. UPDATE mavlinkService.ts
const mavlinkPath = path.join(__dirname, '../frontend/src/services/mavlinkService.ts');
let mContent = fs.readFileSync(mavlinkPath, 'utf8');

const oldMavBlock = `    } else if (phase === 'WAITING_FOR_MAVLINK' || phase === 'WAITING_FOR_HEARTBEAT') {
      this.stopGcsHeartbeat();
      this.clearHeartbeatWaitTimer();
      this.connectionState.phase = phase;
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = false;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.phaseMessage = message;
    } else if (phase === 'WAKING_RELAY' || phase === 'AUTHENTICATING_WSS' || phase === 'WAITING_FOR_ESP32') {
      this.stopGcsHeartbeat();
      this.connectionState.phase = phase;
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = false;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.phaseMessage = message;`;

const newMavBlock = `    } else if (phase === 'WAITING_FOR_MAVLINK' || phase === 'WAITING_FOR_HEARTBEAT') {
      this.clearHeartbeatWaitTimer();
      this.connectionState.phase = phase;
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = true;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.phaseMessage = message;

      if (this.connectionState.connectionType === 'ESP32_WEBSOCKET') {
        this.startGcsHeartbeat();
        this.requestMavlinkDataStreams();
      }
    } else if (phase === 'WAITING_FOR_ESP32') {
      this.connectionState.phase = phase;
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = true;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.phaseMessage = message;
      if (this.connectionState.connectionType === 'ESP32_WEBSOCKET') {
        this.startGcsHeartbeat();
      }
    } else if (phase === 'WAKING_RELAY' || phase === 'AUTHENTICATING_WSS') {
      this.stopGcsHeartbeat();
      this.connectionState.phase = phase;
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = false;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.phaseMessage = message;`;

mContent = mContent.replace(oldMavBlock.replace(/\r\n/g, '\n'), newMavBlock);
mContent = mContent.replace(oldMavBlock.replace(/\n/g, '\r\n'), newMavBlock.replace(/\n/g, '\r\n'));
fs.writeFileSync(mavlinkPath, mContent, 'utf8');
console.log('✓ mavlinkService.ts updated.');

// 2. UPDATE PixhawkConnectionCard.tsx
const cardPath = path.join(__dirname, '../frontend/src/components/Drone/PixhawkConnectionCard.tsx');
let cContent = fs.readFileSync(cardPath, 'utf8');

cContent = cContent.replace(
  "const isWebSocketOpen = isUsbConnected && connectionState.connectionType === 'ESP32_WEBSOCKET';",
  "const isWebSocketOpen = (isUsbConnected || connectionState.esp32LinkState === 'CONNECTED' || connectionState.isConnected) && connectionState.connectionType === 'ESP32_WEBSOCKET';"
);

cContent = cContent.replace(
  "<span>Local Connector</span>",
  "<span>Drone Bridge</span>"
);

cContent = cContent.replace(
  "{isWebSocketOpen && connectionState.esp32ConnectorOnline ? 'Online ✓' : 'Local Agent'}",
  "{isWebSocketOpen && (connectionState.esp32ConnectorOnline || connectionState.esp32DeviceOnline) ? 'Online ✓' : isWebSocketOpen ? 'Connecting...' : 'Drone Bridge'}"
);

cContent = cContent.replace(
  "{isWebSocketOpen && connectionState.esp32DeviceOnline ? 'Bridged ✓' : 'LAN 192.168.x.x'}",
  "{isWebSocketOpen && connectionState.esp32DeviceOnline ? 'Online ✓' : isWebSocketOpen ? 'Bridged ✓' : 'LAN 192.168.x.x'}"
);

fs.writeFileSync(cardPath, cContent, 'utf8');
console.log('✓ PixhawkConnectionCard.tsx updated.');
