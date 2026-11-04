import { DroneTelemetry, GPSLocation, HomePoint } from '../types/mission';
import {
  MAVLinkPacket,
  PixhawkConnectionState,
  FlightControllerConnection,
  PixhawkStatusMessage,
  ConnectionPhase,
  UsbDeviceDiagnostics,
  DiagnosticsLogEntry,
  RescueTarget,
  Esp32DiagData
} from '../types/mavlink';
import { usbHostService } from './usbHostService';
import { transportManager } from './transports/TransportManager';
import { audioService } from './audioService';

type TelemetryListener = (telemetry: DroneTelemetry) => void;
type MAVLinkPacketListener = (packet: MAVLinkPacket) => void;
type ConnectionStateListener = (state: PixhawkConnectionState) => void;

export interface MavlinkMissionItem {
  seq?: number;
  lat: number;
  lon: number;
  alt: number;
  command?: number;
  frame?: number;
  param1?: number;
  param2?: number;
  param3?: number;
  param4?: number;
  current?: number;
  autocontinue?: number;
  mission_type?: number;
}

// ArduPilot Copter Flight Mode Map
const ARDUPILOT_MODES: Record<number, string> = {
  0: 'STABILIZE',
  1: 'ACRO',
  2: 'ALT_HOLD',
  3: 'AUTO',
  4: 'GUIDED',
  5: 'LOITER',
  6: 'RTL',
  7: 'CIRCLE',
  8: 'POSITION',
  9: 'LAND',
  10: 'OF_LOITER',
  11: 'DRIFT',
  13: 'SPORT',
  14: 'FLIP',
  15: 'AUTOTUNE',
  16: 'POSHOLD',
  17: 'BRAKE',
  18: 'THROW',
  19: 'AVOID_ADSB',
  20: 'GUIDED_NOGPS',
  21: 'SMART_RTL',
  22: 'FLOWHOLD',
  23: 'FOLLOW',
  24: 'ZIGZAG',
  25: 'SYSTEMID',
  26: 'AUTOROTATE',
  27: 'AUTO_RTL'
};

const AUTOPILOT_NAMES: Record<number, string> = {
  0: 'GENERIC',
  3: 'MAV_AUTOPILOT_ARDUPILOT',
  12: 'MAV_AUTOPILOT_PX4'
};

const VEHICLE_TYPE_NAMES: Record<number, string> = {
  0: 'GENERIC',
  1: 'FIXED_WING',
  2: 'QUADROTOR',
  3: 'COAXIAL',
  4: 'HELICOPTER',
  5: 'ANTENNA_TRACKER',
  6: 'GCS',
  7: 'AIRSHIP',
  8: 'FREE_BALLOON',
  9: 'ROCKET',
  10: 'GROUND_ROVER',
  11: 'SURFACE_BOAT',
  12: 'SUBMARINE',
  13: 'HEXAROTOR',
  14: 'OCTOROTOR',
  15: 'TRICOPTER',
  16: 'FLAPPING_WING',
  17: 'KITE',
  18: 'ONBOARD_CONTROLLER',
  19: 'VTOL_DUOROTOR',
  20: 'VTOL_QUADROTOR',
  21: 'VTOL_TILTROTOR'
};

const SEVERITY_NAMES: Array<PixhawkStatusMessage['severity']> = [
  'EMERGENCY',
  'ALERT',
  'CRITICAL',
  'ERROR',
  'WARNING',
  'NOTICE',
  'INFO',
  'DEBUG'
];

export const MAVLINK_CRC_EXTRAS: Record<number, number> = {
  0: 50,   // HEARTBEAT (msgid 0 -> CRC_EXTRA = 50 / 0x32)
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
  35: 244, // RC_CHANNELS_RAW
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
  69: 243, // MANUAL_CONTROL
  70: 124, // RC_CHANNELS_OVERRIDE
  73: 38,  // MISSION_ITEM_INT
  74: 20,  // VFR_HUD
  75: 158, // COMMAND_INT
  76: 152, // COMMAND_LONG
  77: 143, // COMMAND_ACK
  83: 22,  // ATTITUDE_TARGET
  85: 140, // POSITION_TARGET_LOCAL_NED
  87: 150, // POSITION_TARGET_GLOBAL_INT
  111: 34, // TIMESYNC
  116: 76, // SCALED_IMU2
  124: 87, // GPS2_RAW
  125: 203, // POWER_STATUS
  133: 6,  // TERRAIN_REQUEST
  134: 229, // TERRAIN_DATA
  135: 203, // TERRAIN_CHECK
  136: 1,  // TERRAIN_REPORT
  147: 154, // BATTERY_STATUS
  148: 178, // AUTOPILOT_VERSION
  163: 187, // AHRS2
  168: 21,  // WIND
  242: 104, // HOME_POSITION
  253: 83  // STATUSTEXT
};

class MAVLinkService {
  private listeners: Set<TelemetryListener> = new Set();
  private packetListeners: Set<MAVLinkPacketListener> = new Set();
  private connectionListeners: Set<ConnectionStateListener> = new Set();

  private connectionState: PixhawkConnectionState = {
    connectionType: 'ESP32_WEBSOCKET',
    phase: 'DISCONNECTED',
    phaseMessage: 'Ready for ESP32 wireless telemetry connection',
    isConnected: false,
    isUsbConnected: false,
    portOrAddress: 'Disconnected',
    baudRate: 57600,
    bytesReceived: 0,
    bytesSent: 0,
    lastHeartbeat: 0,
    heartbeatHz: 0,
    packetLossPercent: 0,
    firmwareVersion: 'Pixhawk 2.4.8 (ArduCopter / PX4)',
    autopilotType: 'MAV_AUTOPILOT_ARDUPILOT',
    mavlinkVersion: 'MAVLink 2.0 / 1.0',
    isReceivingTelemetry: false,
    ekfHealthy: true,
    preArmChecksPassed: false,
    statusHistory: [],
    commandAckHistory: [],
    diagnosticsLogs: [],
    isRealHardware: true,
    wifiSsid: 'drone123',
    wifiState: 'CONNECTED',
    esp32LinkState: 'DISCONNECTED',
    diagnostics: {
      totalPacketsReceived: 0,
      heartbeatsCount: 0,
      driverType: 'ESP32_WEBSOCKET',
      hostPowerStatus: 'HOST_ACTIVE',
      serialDataReceived: false
    }
  };

  private telemetry: DroneTelemetry = {
    latitude: 0.0,
    longitude: 0.0,
    altitude: 0.0,
    targetAltitude: 0.0,
    groundSpeed: 0.0,
    verticalSpeed: 0.0,
    heading: 0,
    batteryPercent: 0,
    batteryVoltage: 0.0,
    batteryCurrent: 0.0,
    batteryCellCount: 3,
    gps: {
      latitude: 0.0,
      longitude: 0.0,
      altitude: 0.0,
      satellites: 0,
      hdop: 99.0,
      fixType: 'NO_GPS',
      isLocked: false
    },
    flightMode: 'DISARMED',
    isArmed: false,
    distanceToHome: 0,
    searchProgress: 0,
    pixhawkConnected: false,
    runnerConnected: true,
    cameraReady: true
  };

  private homePoint: HomePoint = {
    latitude: 0.0,
    longitude: 0.0,
    altitude: 0.0,
    timestamp: 0,
    isSet: false
  };
  private homePointManualLock: boolean = false;

  private pendingMissionItems: MavlinkMissionItem[] = [];
  private missionUploadResolver: ((result: { success: boolean; message: string; upload_id?: string }) => void) | null = null;
  private missionClearResolver: ((result: { success: boolean; message: string }) => void) | null = null;
  private missionDownloadResolver: ((result: { success: boolean; items: MavlinkMissionItem[]; message: string }) => void) | null = null;
  private downloadedMissionItems: MavlinkMissionItem[] = [];
  private expectedDownloadCount: number = 0;
  private currentUploadId: string | null = null;
  private missionUploadTimeoutTimer: any = null;
  private missionCountRetryTimer: any = null;
  private missionUploadOverallTimer: any = null;
  private missionItemRetryTimer: any = null;
  private lastRequestedSeq: number = -1;
  private lastSentSeq: number = -1;
  private lastSentTimeMs: number = 0;
  private missionTransferActive: boolean = false;

  // MAVLink Parser Buffers
  private rxBuffer: Uint8Array = new Uint8Array(4096);
  private rxBufferLen: number = 0;
  private sendSeq: number = 0;
  private isArmCommandInFlight: boolean = false;

  // Heartbeat Rate Monitoring & Timeout Tracking
  private heartbeatTimestamps: number[] = [];
  private heartbeatWatchdogTimer: any = null;
  private heartbeatWaitingTimer: any = null;
  private serialDataCheckTimer: any = null;
  private gcsHeartbeatTimer: any = null;
  private heartbeatWaitStartTime: number = 0;

  // Link Quality Tracker: Track MAVLink sequence numbers (0-255) for packet loss %
  private lastMavlinkSeq: number = -1;
  private totalPacketsExpected: number = 0;
  private totalPacketsLost: number = 0;
  private totalPacketsReceived: number = 0;
  private seqHistoryWindow: Array<{ seq: number; lost: number; time: number }> = [];

  // Competition QR Code Rescue Target Listeners
  private rescueTargetListeners: Set<(code: string, target?: RescueTarget) => void> = new Set();
  private rescueTarget: RescueTarget | null = null;

  // Multi-Instance GPS tracking (Arbitrate between GPS 1 on SERIAL3 and GPS 2 on SERIAL4/5)
  private gps1Data = {
    fixType: 'NO_GPS' as GPSLocation['fixType'],
    rawFixType: 0,
    satellites: 0,
    hdop: 99.9,
    lat: 0,
    lon: 0,
    alt: 0,
    lastUpdated: 0
  };

  private gps2Data = {
    fixType: 'NO_GPS' as GPSLocation['fixType'],
    rawFixType: 0,
    satellites: 0,
    hdop: 99.9,
    lat: 0,
    lon: 0,
    alt: 0,
    lastUpdated: 0
  };

  private modeChangeResolver: ((res: { success: boolean; message: string }) => void) | null = null;
  private modeChangeTimer: any = null;
  private downloadItemRetryTimer: any = null;

  // Simulator Interval (Only active when in SIMULATED mode)
  private simInterval: any = null;
  private simWaypoints: Array<{ lat: number; lon: number; alt: number }> = [];
  private currentWpIndex: number = 0;
  private searchProgressCount: number = 0;

  private startGcsHeartbeat() {
    this.stopGcsHeartbeat(); // Clear any existing timer to guarantee single instance
    this.sendGcsHeartbeat();
    this.gcsHeartbeatTimer = setInterval(() => {
      if ((this.connectionState.isUsbConnected || this.connectionState.isConnected) && !this.simInterval) {
        this.sendGcsHeartbeat();
      }
    }, 1000);
  }

  private stopGcsHeartbeat() {
    if (this.gcsHeartbeatTimer) {
      clearInterval(this.gcsHeartbeatTimer);
      this.gcsHeartbeatTimer = null;
    }
  }

  public async sendGcsHeartbeat(): Promise<boolean> {
    try {
      if ((!this.connectionState.isUsbConnected && !this.connectionState.isConnected) || this.simInterval) return false;
      // MAVLink v1 HEARTBEAT (msgId = 0, payload len = 9)
      const payload = new Uint8Array(9);
      const view = new DataView(payload.buffer);
      view.setUint32(0, 0, true); // custom_mode
      view.setUint8(4, 6);        // type = MAV_TYPE_GCS (6)
      view.setUint8(5, 8);        // autopilot = MAV_AUTOPILOT_INVALID (8)
      view.setUint8(6, 0);        // base_mode
      view.setUint8(7, 4);        // system_status = MAV_STATE_ACTIVE (4)
      view.setUint8(8, 3);        // mavlink_version = 3

      const packet = this.buildMavlink1Frame(0 /* HEARTBEAT */, payload);
      const success = await usbHostService.sendBytes(packet);
      if (success) {
        this.connectionState.bytesSent += packet.length;
      }
      return success;
    } catch {
      return false;
    }
  }

  constructor() {
    this.logDiagnostic('SYSTEM', 'MAVLink Engine Initialized. Ready for ESP32 Wi-Fi bridge (drone123).', 'info');

    // Subscribe to byte stream from unified cross-platform USB / ESP32 Host
    usbHostService.subscribeData((chunk: Uint8Array) => {
      this.connectionState.bytesReceived += chunk.length;
      this.processIncomingSerialBytes(chunk);
    });

    // Subscribe to hardware / bridge phase transitions
    usbHostService.subscribeState((phase: ConnectionPhase, message: string, diag) => {
      this.handleUsbHostStateChange(phase, message, diag);
    });

    // Subscribe to multi-hop QR_ALERT frames intercepted by ESP32 transport
    transportManager.getEsp32Transport().subscribeQrAlert((payload: string) => {
      this.logDiagnostic("MAVLINK", `[MULTI-HOP QR] Intercepted QR alert payload: "${payload}"`, "info");
      this.validateAndProcessQrPayload(payload);
    });

    // Subscribe to ESP32 live telemetry diagnostics (TELEM2 GPIO 18 RX byte monitor)
    transportManager.getEsp32Transport().subscribeEsp32Diag((diag) => {
      this.handleEsp32Diag(diag);
    });

    // Start heartbeat watchdog
    this.startHeartbeatWatchdog();

    // Auto-connect to ESP32 wireless bridge on startup if not explicitly disconnected by user
    if (typeof window !== 'undefined') {
      try {
        const manualDis = localStorage.getItem('esp32_manual_disconnect');
        if (manualDis !== 'true') {
          setTimeout(() => {
            this.connectEsp32().catch((err) => {
              console.warn('[MAVLINK] Auto-connect to ESP32 postponed:', err);
            });
          }, 350);
        }
      } catch (e) {}
    }
  }

  public logDiagnostic(tag: DiagnosticsLogEntry['tag'], message: string, level: DiagnosticsLogEntry['level'] = 'info') {
    const entry: DiagnosticsLogEntry = {
      id: `DIAG_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
      tag,
      message,
      level
    };
    this.connectionState.diagnosticsLogs = [entry, ...this.connectionState.diagnosticsLogs.slice(0, 99)];
    this.notifyConnection();
  }

  private handleUsbHostStateChange(phase: ConnectionPhase, message: string, diag: Partial<UsbDeviceDiagnostics>) {
    this.connectionState.phaseMessage = message;
    this.connectionState.diagnostics = {
      ...this.connectionState.diagnostics,
      ...diag
    };

    if (diag.productName || diag.deviceName) {
      this.connectionState.portOrAddress = `${diag.productName || diag.deviceName} (@ ${diag.baudRate || this.connectionState.baudRate} baud)`;
    }

    if (phase === 'DISCONNECTED') {
      this.stopGcsHeartbeat();
      this.connectionState.phase = 'DISCONNECTED';
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = false;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.isRealHardware = false;
      this.connectionState.diagnostics.serialDataReceived = false;
      this.telemetry.pixhawkConnected = false;
      this.telemetry.isArmed = false;
      this.clearHeartbeatWaitTimer();
      this.clearSerialDataCheckTimer();
      this.logDiagnostic('USB', message || 'Device Disconnected', 'warn');
      this.addStatusMessage('WARNING', 4, message || 'Device Disconnected');
    } else if (phase === 'CONNECTION_LOST') {
      this.stopGcsHeartbeat();
      this.connectionState.phase = 'CONNECTION_LOST';
      this.connectionState.isConnected = false;
      this.connectionState.isUsbConnected = false;
      this.connectionState.isReceivingTelemetry = false;
      this.connectionState.isRealHardware = false;
      this.connectionState.diagnostics.serialDataReceived = false;
      this.telemetry.pixhawkConnected = false;
      this.telemetry.isArmed = false;
      this.clearHeartbeatWaitTimer();
      this.clearSerialDataCheckTimer();
      this.logDiagnostic('USB', 'Link connection lost. Waiting for reconnection…', 'warn');
      this.addStatusMessage('WARNING', 4, 'Link connection lost');
    } else if (phase === 'WAITING_FOR_MAVLINK' || phase === 'WAITING_FOR_HEARTBEAT') {
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
      this.connectionState.phaseMessage = message;
    } else if (phase === 'USB_DEVICE_DETECTED') {
      this.connectionState.phase = 'USB_DEVICE_DETECTED';
      this.connectionState.isRealHardware = true;
      this.connectionState.isUsbConnected = false;
      this.connectionState.connectionType = 'USB_SERIAL';
      this.logDiagnostic('USB', `[USB] Device detected: ${diag.productName || 'Pixhawk / Flight Controller'} (VID: 0x${diag.vendorId?.toString(16).toUpperCase() || '????'}, PID: 0x${diag.productId?.toString(16).toUpperCase() || '????'}, Interface: ${diag.interfaceType || 'CDC ACM'})`, 'info');
      this.addStatusMessage('INFO', 6, message);
    } else if (phase === 'USB_PERMISSION_REQUIRED' || phase === 'REQUESTING_PERMISSION') {
      this.connectionState.phase = 'USB_PERMISSION_REQUIRED';
      this.logDiagnostic('USB', '[USB] Requesting Android USB permission…', 'info');
      this.addStatusMessage('INFO', 6, 'Requesting Android USB permission...');
    } else if (phase === 'USB_PERMISSION_GRANTED' || phase === 'PERMISSION_GRANTED') {
      this.connectionState.phase = 'USB_PERMISSION_GRANTED';
      this.connectionState.diagnostics.hasPermission = true;
      this.logDiagnostic('USB', '[USB] USB permission granted by user ✓', 'success');
      this.addStatusMessage('INFO', 6, 'USB permission granted');
    } else if (phase === 'SERIAL_OPENING' || phase === 'OPENING_USB') {
      this.connectionState.phase = 'SERIAL_OPENING';
      this.logDiagnostic('USB', '[USB] Opening serial/network connection…', 'info');
    } else if (phase === 'SERIAL_OPEN' || phase === 'USB_CONNECTED') {
      this.connectionState.isUsbConnected = true;
      this.connectionState.phase = 'SERIAL_OPEN';
      this.connectionState.phaseMessage = message || 'Link opened. Testing serial/network data…';
      this.logDiagnostic('USB', `Link opened @ ${this.connectionState.baudRate} baud. Testing data streams…`, 'success');
      this.addStatusMessage('INFO', 6, 'Link opened. Testing data streams…');

      this.startGcsHeartbeat();
      this.requestMavlinkDataStreams();
      this.startSerialDataCheck();
      this.startHeartbeatWaitTimeout();
    } else if (
      phase === 'USB_NOT_DETECTED' ||
      phase === 'PERMISSION_DENIED' ||
      phase === 'SERIAL_OPEN_FAILED' ||
      phase === 'UNSUPPORTED_DEVICE' ||
      phase === 'INTERFACE_NOT_SUPPORTED' ||
      phase === 'IOS_UNSUPPORTED'
    ) {
      this.stopGcsHeartbeat();
      this.connectionState.phase = phase;
      this.connectionState.isUsbConnected = false;
      this.connectionState.isConnected = false;
      this.connectionState.errorMessage = message;
      this.connectionState.diagnostics.lastError = message;
      this.clearHeartbeatWaitTimer();
      this.clearSerialDataCheckTimer();
      this.logDiagnostic('ERROR', `[ERROR] ${message}`, 'error');
      this.addStatusMessage('ERROR', 3, message);
    }

    // Synchronize ESP32 WebSocket Link State if currently on ESP32
    if (this.connectionState.connectionType === 'ESP32_WEBSOCKET') {
      const esp32Transport = transportManager.getEsp32Transport();
      this.connectionState.esp32LinkState = esp32Transport.getLinkState();
      this.connectionState.esp32ProtocolMode = esp32Transport.getProtocolMode();
      this.connectionState.esp32Path = esp32Transport.getPath();
      this.connectionState.esp32LatencyMs = esp32Transport.getLatencyMs();
      this.connectionState.esp32ErrorCategory = esp32Transport.getErrorCategory();
      this.connectionState.esp32ErrorMessage = esp32Transport.getLastErrorMessage();
      this.connectionState.esp32ConnectorOnline = esp32Transport.isConnectorOnline();
      this.connectionState.esp32DeviceOnline = esp32Transport.isEsp32Online();
      this.connectionState.cloudState = esp32Transport.getCloudState();
      this.connectionState.esp32Baud = esp32Transport.getEsp32Baud();
      this.connectionState.esp32Rssi = esp32Transport.getEsp32Rssi();
    }

    this.notifyConnection();
    this.notifyTelemetry();
  }

  private startSerialDataCheck() {
    this.clearSerialDataCheckTimer();
    this.serialDataCheckTimer = setTimeout(() => {
      if (this.connectionState.isUsbConnected && !this.connectionState.diagnostics.serialDataReceived) {
        this.connectionState.phase = 'NO_SERIAL_DATA';
        const msg = 'Serial port opened, but no serial data received. Verify Pixhawk power and cable.';
        this.connectionState.phaseMessage = msg;
        this.logDiagnostic('USB', `[USB] ${msg}`, 'warn');
        this.addStatusMessage('WARNING', 4, msg);
        this.notifyConnection();
      }
    }, 15000);
  }

  private clearSerialDataCheckTimer() {
    if (this.serialDataCheckTimer) {
      clearTimeout(this.serialDataCheckTimer);
      this.serialDataCheckTimer = null;
    }
  }

  private startHeartbeatWaitTimeout() {
    this.clearHeartbeatWaitTimer();
    this.heartbeatWaitStartTime = Date.now();

    // If no heartbeat within 15 seconds after link opened -> HEARTBEAT_TIMEOUT
    this.heartbeatWaitingTimer = setTimeout(() => {
      if (this.connectionState.isUsbConnected && !this.connectionState.isConnected) {
        this.connectionState.phase = 'HEARTBEAT_TIMEOUT';
        const timeoutMsg = 'Connection open, but no MAVLink heartbeat received. Verify Pixhawk is powered & baud rate matches.';
        this.connectionState.phaseMessage = timeoutMsg;
        this.connectionState.errorMessage = timeoutMsg;
        this.connectionState.diagnostics.lastError = timeoutMsg;
        this.logDiagnostic('MAVLINK', `[MAVLINK] Heartbeat timeout (no heartbeat packet within 15s). ${timeoutMsg}`, 'warn');
        this.addStatusMessage('WARNING', 4, timeoutMsg);
        this.notifyConnection();
      }
    }, 15000);
  }

  private clearHeartbeatWaitTimer() {
    if (this.heartbeatWaitingTimer) {
      clearTimeout(this.heartbeatWaitingTimer);
      this.heartbeatWaitingTimer = null;
    }
  }

  private startHeartbeatWatchdog() {
    if (this.heartbeatWatchdogTimer) clearInterval(this.heartbeatWatchdogTimer);
    this.heartbeatWatchdogTimer = setInterval(() => {
      const now = Date.now();
      if (this.connectionState.lastHeartbeat > 0) {
        const ageMs = now - this.connectionState.lastHeartbeat;
        this.connectionState.diagnostics.lastHeartbeatAgeMs = ageMs;

        // Sliding 3.5-second heartbeat window
        this.heartbeatTimestamps = this.heartbeatTimestamps.filter(t => now - t <= 3500);
        if (this.heartbeatTimestamps.length >= 2) {
          const spanSec = (this.heartbeatTimestamps[this.heartbeatTimestamps.length - 1] - this.heartbeatTimestamps[0]) / 1000;
          this.connectionState.heartbeatHz = spanSec > 0 ? +( (this.heartbeatTimestamps.length - 1) / spanSec ).toFixed(1) : 0;
        } else if (ageMs > 1500) {
          this.connectionState.heartbeatHz = 0;
        }
        this.connectionState.diagnostics.heartbeatHz = this.connectionState.heartbeatHz;

        // Strictly revert to WAITING_FOR_HEARTBEAT if no heartbeat arrives within 3.5 seconds
        if (ageMs > 3500) {
          if (this.connectionState.isConnected || this.connectionState.isReceivingTelemetry) {
            this.connectionState.isConnected = false;
            this.connectionState.isReceivingTelemetry = false;
            this.connectionState.phase = "WAITING_FOR_HEARTBEAT";
            this.connectionState.phaseMessage = `Waiting for MAVLink Heartbeat (no heartbeat received for ${(ageMs / 1000).toFixed(1)}s)...`;
            this.connectionState.heartbeatHz = 0;
            this.telemetry.pixhawkConnected = false;
            this.logDiagnostic("MAVLINK", "[MAVLINK] Heartbeat lost (> 3.5s). Reverting to WAITING_FOR_HEARTBEAT.", "warn");
            this.addStatusMessage("WARNING", 4, "MAVLink Heartbeat lost (> 3.5s). Reverting to WAITING_FOR_HEARTBEAT.");
            this.notifyConnection();
            this.notifyTelemetry();
          }
        } else if (this.connectionState.isConnected) {
          if (!this.connectionState.isReceivingTelemetry) {
            this.connectionState.isReceivingTelemetry = true;
            this.connectionState.phase = "PIXHAWK_CONNECTED";
            this.connectionState.phaseMessage = `Pixhawk connected ✓ (${this.connectionState.heartbeatHz} Hz)`;
            this.notifyConnection();
          }
          // Telemetry stream keeper: refresh stream requests if GPS is absent > 3.5s
          const lastGpsAge = now - Math.max(this.gps1Data?.lastUpdated || 0, this.gps2Data?.lastUpdated || 0);
          if (lastGpsAge > 3500) {
            this.requestMavlinkDataStreams();
          }
        }
      }
    }, 250);
  }
  public subscribeTelemetry(fn: TelemetryListener) {
    this.listeners.add(fn);
    fn(this.getTelemetry());
    return () => this.listeners.delete(fn);
  }

  public subscribePackets(fn: MAVLinkPacketListener) {
    this.packetListeners.add(fn);
    return () => this.packetListeners.delete(fn);
  }

  public subscribeConnection(fn: ConnectionStateListener) {
    this.connectionListeners.add(fn);
    fn(this.getConnectionState());
    return () => this.connectionListeners.delete(fn);
  }

  public getTelemetry(): DroneTelemetry {
    return { ...this.telemetry, gps: { ...this.telemetry.gps } };
  }

  public getConnectionState(): PixhawkConnectionState {
    const isReceiving = this.connectionState.isConnected && (Date.now() - this.connectionState.lastHeartbeat < 10000);
    return {
      ...this.connectionState,
      isReceivingTelemetry: isReceiving,
      diagnostics: { ...this.connectionState.diagnostics },
      diagnosticsLogs: [...this.connectionState.diagnosticsLogs]
    };
  }

  public getHomePoint(): HomePoint {
    return { ...this.homePoint };
  }

  public async setHomePoint(lat?: number, lon?: number, alt?: number): Promise<HomePoint> {
    const validLat = (lat !== undefined && Math.abs(lat) > 0.0001) ? lat : (this.telemetry.latitude || this.telemetry.gps.latitude);
    const validLon = (lon !== undefined && Math.abs(lon) > 0.0001) ? lon : (this.telemetry.longitude || this.telemetry.gps.longitude);
    const validAlt = (alt !== undefined) ? alt : (this.telemetry.gps.altitude || this.telemetry.altitude);

    // Command MAV_CMD_DO_SET_HOME (179)
    // param1 = 1.0: use current vehicle position; 0.0: use explicit coords in param5, 6, 7
    const useCurrent = (lat === undefined || lon === undefined || (lat === 0 && lon === 0));
    try {
      await this.sendMavlinkCommandLong(
        179, // MAV_CMD_DO_SET_HOME
        useCurrent ? 1.0 : 0.0,
        0, 0, 0,
        validLat,
        validLon,
        validAlt
      );
      this.logDiagnostic('MAVLINK', `[CMD 179] MAV_CMD_DO_SET_HOME sent to Pixhawk (useCurrent=${useCurrent}, lat=${validLat.toFixed(7)}, lon=${validLon.toFixed(7)})`, 'info');
    } catch (e) {
      console.warn('[SET_HOME] Note: Command send handled:', e);
    }

    this.homePoint = {
      latitude: validLat,
      longitude: validLon,
      altitude: validAlt,
      timestamp: Date.now(),
      isSet: true
    };
    this.homePointManualLock = true;

    this.telemetry.distanceToHome = 0;
    this.notifyTelemetry();
    this.notifyConnection();
    this.logDiagnostic('SYSTEM', `Home Point Locked: ${validLat.toFixed(6)}, ${validLon.toFixed(6)} (Alt: ${validAlt.toFixed(1)}m)`, 'success');
    this.addStatusMessage('INFO', 6, `Home Point Locked: ${validLat.toFixed(6)}, ${validLon.toFixed(6)}`);
    return this.homePoint;
  }

  public clearHomePoint(): void {
    this.homePoint = {
      latitude: 0,
      longitude: 0,
      altitude: 0,
      timestamp: 0,
      isSet: false
    };
    this.homePointManualLock = false;
    this.telemetry.distanceToHome = 0;
    this.notifyTelemetry();
    this.notifyConnection();
    this.logDiagnostic('SYSTEM', 'Home Point Cleared by Operator', 'info');
    this.addStatusMessage('INFO', 6, 'Home Point Cleared');
  }

  public calibrateGroundAltitude(): void {
    const currentMsl = this.telemetry.gps.altitude || (this.homePoint.isSet ? this.homePoint.altitude : 0);
    if (this.homePoint.isSet && currentMsl > 0) {
      this.homePoint.altitude = currentMsl;
    }
    this.telemetry.altitude = 0.0;
    this.notifyTelemetry();
    this.addStatusMessage('NOTICE', 5, 'Ground altitude zeroed.');
    this.logDiagnostic('SYSTEM', 'Ground altitude calibrated to 0.0m AGL', 'success');
  }

  private addStatusMessage(severity: PixhawkStatusMessage['severity'], severityLevel: number, text: string) {
    const msg: PixhawkStatusMessage = {
      id: `STAT_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
      severity,
      severityLevel,
      text: text.trim()
    };

    this.connectionState.latestStatusMessage = msg;
    this.connectionState.statusHistory = [msg, ...this.connectionState.statusHistory.slice(0, 24)];

    const lower = text.toLowerCase();
    
    // Check if this is an informational satellite report (e.g. "16/7 sats", "16 / 7", "16 sats (minimum 7)") or passing check
    const isPassingMsg = lower.includes('passed') || lower.includes('ready') || lower.includes('good') || lower.includes('armed');
    const isHealthyGpsReport = (lower.includes('sat') || lower.includes('gps')) && (/\d+\s*\/\s*\d+/.test(lower) || lower.includes('min') || lower.includes('lock'));

    if (severityLevel <= 4 && (lower.includes('prearm') || lower.includes('fail') || lower.includes('bad') || lower.includes('inconsistent')) && !isPassingMsg && !isHealthyGpsReport) {
      this.connectionState.preArmChecksPassed = false;
      this.connectionState.preArmFailReason = text;
    } else if (isPassingMsg || isHealthyGpsReport || lower.includes('armed')) {
      this.connectionState.preArmChecksPassed = true;
      if (this.connectionState.preArmFailReason && (isPassingMsg || isHealthyGpsReport)) {
        this.connectionState.preArmFailReason = undefined;
      }
    }

    this.notifyConnection();
  }

  /**
   * Determine if a flight mode requires a GPS 3D fix / position estimate for arming.
   * AltHold, Stabilize, Acro, Manual are barometric/rate modes and do NOT require GPS.
   */
  public isModePositionDependent(modeName?: string): boolean {
    const raw = (modeName || this.telemetry.flightMode || '').toUpperCase().trim();
    const mode = raw.replace(/[^A-Z]/g, '');
    if (mode === 'ALTHOLD' || mode === 'ALT_HOLD' || mode === 'STABILIZE' || mode === 'ACRO' || mode === 'MANUAL' || mode === 'DISARMED' || mode === '') {
      return false;
    }
    // Loiter, PosHold, Guided, Auto, RTL, SmartRTL, Follow, Circle require position
    return true;
  }

  /**
   * Translates cryptic ArduPilot STATUSTEXT and pre-arm failures into actionable, human-readable guidance.
   */
  public explainPreArmFailure(raw: string): string {
    const lower = (raw || '').toLowerCase();
    if (lower.includes('mode change') || (lower.includes('requires position') && (lower.includes('mode') || lower.includes('failed')))) {
      return 'Flight Mode Rejected: Pixhawk requires a 3D GPS position fix with EKF convergence before entering LOITER, GUIDED, or AUTO. Switch to STABILIZE or ALT_HOLD to arm/fly without GPS.';
    }
    if (lower.includes('compass') && (lower.includes('calibrat') || lower.includes('health') || lower.includes('variance') || lower.includes('offset') || lower.includes('bad'))) {
      return 'Compass Error: Verify external compass 4-pin cable is plugged into the Pixhawk I2C port (SERIAL4/5 has no I2C pins), move away from metal, or perform compass calibration in Mission Planner.';
    }
    if (lower.includes('gps') || lower.includes('3d fix') || lower.includes('hdop') || lower.includes('pos hold') || lower.includes('bad gps') || lower.includes('need 3d') || lower.includes('nav checks')) {
      return 'GPS Not Ready: Requires 3D GPS fix with ≥ 6 satellites and HDOP < 2.0 before arming in GUIDED/LOITER. If GPS is plugged into SERIAL4/5, set SERIAL4_PROTOCOL = 5 and SERIAL3_PROTOCOL = 0 in Mission Planner.';
    }
    if (lower.includes('safety switch') || (lower.includes('safety') && lower.includes('switch'))) {
      return 'Safety Switch Locked: Press and hold the physical red safety switch on Pixhawk until solid.';
    }
    if (lower.includes('baro') || lower.includes('barometer')) {
      return 'Barometer Stabilizing: Wait 15–30 seconds after powering on level ground before arming.';
    }
    if (lower.includes('batt') || lower.includes('voltage') || lower.includes('low batt')) {
      return 'Battery Failsafe: Voltage is below safe arming threshold. Replace or charge LiPo battery.';
    }
    if (lower.includes('rc') || lower.includes('radio') || lower.includes('throttle')) {
      return 'Radio Failsafe (RC / Radio Check: Ensure RC transmitter is powered ON and throttle stick centered. If testing autonomous GCS/bench without RC, set FS_THR_ENABLE = 0 and ARMING_CHECK = 0 in Mission Planner).';
    }
    if (lower.includes('accel') || lower.includes('ahrs') || lower.includes('inertial')) {
      return 'IMU / Accel Check: Keep vehicle completely stationary on level ground.';
    }
    if (lower.includes('log') || lower.includes('sd card')) {
      return 'MicroSD Card Check: Pixhawk SD card is missing, full, or write-protected.';
    }
    if (lower.includes('fence')) {
      return 'Geo-Fence Alert: Vehicle is outside configured geofence boundary.';
    }
    return raw;
  }

  public evaluatePreArmSafety(): { passed: boolean; reason?: string } {
    if (!this.connectionState.isConnected && !this.simInterval) {
      return { passed: false, reason: 'Pixhawk FC Disconnected (Connect ESP32-S3 / USB & verify MAVLink Heartbeat)' };
    }

    if (!this.simInterval && Date.now() - this.connectionState.lastHeartbeat > 10000) {
      return { passed: false, reason: 'MAVLink Telemetry Lost (No Heartbeat received from FC in 10s)' };
    }

    // Real Hardware: Check for genuine Pixhawk PreArm failures from STATUSTEXT
    if (this.connectionState.isRealHardware) {
      if (this.connectionState.preArmFailReason && !this.telemetry.isArmed) {
        return { passed: false, reason: this.explainPreArmFailure(this.connectionState.preArmFailReason) };
      }
    } else {
      // Simulation: Only check GPS if mode requires position
      const requiresGps = this.isModePositionDependent(this.telemetry.flightMode);
      if (requiresGps && (!this.telemetry.gps.isLocked || this.telemetry.gps.satellites < 6)) {
        return { passed: false, reason: `GPS Not Ready (${this.telemetry.gps.satellites} Sats visible for ${this.telemetry.flightMode})` };
      }
      if (this.telemetry.batteryPercent > 0 && this.telemetry.batteryPercent < 15) {
        return { passed: false, reason: `Low Battery (${this.telemetry.batteryPercent}%)` };
      }
    }

    return { passed: true };
  }

  /**
   * 1-Click Hardware Connection (Zero Port Selection Required)
   */
  public async connectHardware(baudRate: number = 57600): Promise<boolean> {
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }
    this.connectionState.baudRate = baudRate;
    this.connectionState.connectionType = 'USB_SERIAL';
    this.connectionState.isRealHardware = true;
    this.connectionState.diagnostics.serialDataReceived = false;
    this.logDiagnostic('TRANSPORT', `Initiating hardware connection @ ${baudRate} baud…`, 'info');
    return await usbHostService.autoConnect(baudRate);
  }

  /**
   * 1-Click ESP32-S3 Wireless Bridge Connection (WebSocket)
   * Supports AUTO (protocol negotiation), direct WS, and WSS connection modes.
   */
  public async connectEsp32(options?: import('./transports/Esp32WebSocketTransport').Esp32WebSocketOptions | string, port: number = 8080, protocol: 'ws' | 'wss' = 'ws', baudRate: number = 57600): Promise<boolean> {
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }

    let resolvedOptions: import('./transports/Esp32WebSocketTransport').Esp32WebSocketOptions & {
      protocolMode: 'AUTO' | 'WS' | 'WSS';
      mode: 'LOCAL' | 'SECURE';
      host: string;
      port: number;
      path: string;
      secureEndpoint: string;
      protocol: 'ws' | 'wss';
      baudRate: number;
      wifiSsid?: string;
    };

    if (typeof options === 'string') {
      // Legacy string overload: connectEsp32(host, port, protocol, baudRate)
      const pMode: 'AUTO' | 'WS' | 'WSS' = protocol === 'wss' ? 'WSS' : 'WS';
      resolvedOptions = {
        protocolMode: pMode,
        mode: protocol === 'wss' ? 'SECURE' : 'LOCAL',
        host: options.trim(),
        port,
        path: '/ws',
        secureEndpoint: `${options}:${port}`,
        protocol,
        baudRate,
        wifiSsid: transportManager.getEsp32Transport().getWifiSsid()
      };
    } else {
      const defaultRelayUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SECURE_RELAY_URL) || '';
      const protocolMode = options?.protocolMode || (options?.mode === 'SECURE' ? 'WSS' : 'AUTO');
      const mode = options?.mode || (protocolMode === 'WSS' ? 'SECURE' : 'LOCAL');
      const host = (options?.host && options.host.trim().length > 0 ? options.host.trim() : '192.168.31.194');
      const p = options?.port || 8080;
      const path = options?.path !== undefined ? options.path.trim() : '/ws';
      const secureEp = (options?.secureEndpoint || defaultRelayUrl || transportManager.getEsp32Transport().getSecureEndpoint()).trim();
      const relayToken = options?.relayToken || transportManager.getEsp32Transport().getRelayToken();
      const proto = options?.protocol || (protocolMode === 'WSS' ? 'wss' : 'ws');
      const baud = options?.baudRate || 57600;
      const ssid = options?.wifiSsid || transportManager.getEsp32Transport().getWifiSsid();

      resolvedOptions = {
        protocolMode,
        mode,
        host,
        port: p,
        path,
        secureEndpoint: secureEp,
        relayToken,
        protocol: proto,
        baudRate: baud,
        wifiSsid: ssid
      };
    }

    transportManager.getEsp32Transport().setConfig(resolvedOptions);
    const resolvedUrl = transportManager.getEsp32Transport().getResolvedUrl();

    this.connectionState.connectionType = 'ESP32_WEBSOCKET';
    this.connectionState.portOrAddress = resolvedUrl;
    this.connectionState.baudRate = resolvedOptions.baudRate;
    this.connectionState.isRealHardware = true;
    this.connectionState.diagnostics.serialDataReceived = false;
    this.connectionState.esp32ProtocolMode = resolvedOptions.protocolMode;
    this.connectionState.esp32Path = resolvedOptions.path;
    this.connectionState.esp32LinkState = 'CONNECTING';

    this.logDiagnostic(
      'TRANSPORT',
      `[WS] Initiating [${resolvedOptions.protocolMode}] bridge connection to ${resolvedUrl} (${resolvedOptions.baudRate} baud)…`,
      'info'
    );

    this.connectionState.wifiSsid = resolvedOptions.wifiSsid || transportManager.getEsp32Transport().getWifiSsid();
    this.connectionState.wifiState = 'CONNECTED';

    return await usbHostService.connectEsp32(resolvedOptions);
  }

  public getWifiSsid(): string {
    return transportManager.getEsp32Transport().getWifiSsid();
  }

  public setWifiSsid(ssid: string): void {
    transportManager.getEsp32Transport().setWifiSsid(ssid);
    this.connectionState.wifiSsid = ssid;
    this.connectionState.wifiState = 'CONNECTED';
    this.logDiagnostic('TRANSPORT', `Wi-Fi SSID updated to: ${ssid}`, 'info');
    this.notifyConnection();
  }

  public resetWifi(): void {
    transportManager.getEsp32Transport().resetWifi();
    this.connectionState.wifiSsid = undefined;
    this.connectionState.wifiState = 'DISCONNECTED';
    this.logDiagnostic('TRANSPORT', 'Wi-Fi configuration reset by user.', 'warn');
    this.notifyConnection();
  }

  public async checkEsp32Http(host?: string, port?: number): Promise<{ reachable: boolean; latencyMs?: number; message?: string }> {
    return await usbHostService.checkEsp32Http(host, port);
  }

  public async scanUsbDevices(): Promise<any[]> {
    this.logDiagnostic('USB', 'Scanning connected USB devices on USB Host...', 'info');
    return await usbHostService.scanUsbDevices();
  }

  public async requestUsbPermission(): Promise<boolean> {
    this.logDiagnostic('USB', 'Requesting explicit USB permission for detected flight controller...', 'info');
    return await usbHostService.requestUsbPermission();
  }

  /**
   * Centralized cleanup for MAVLink connection and state
   */
  public async cleanupMavlinkConnection(): Promise<void> {
    this.clearHeartbeatWaitTimer();
    this.clearSerialDataCheckTimer();
    this.stopGcsHeartbeat();
    this.clearMissionUploadTimers();
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }

    // Clear MAVLink parser ring buffer
    this.rxBufferLen = 0;
    this.heartbeatTimestamps = [];
    this.lastMavlinkSeq = -1;
    this.totalPacketsExpected = 0;
    this.totalPacketsLost = 0;
    this.totalPacketsReceived = 0;
    this.seqHistoryWindow = [];
    this.connectionState.packetLossPercent = 0;

    // Disconnect active transport
    await usbHostService.disconnect();

    // Reset full connection state
    this.connectionState.isConnected = false;
    this.connectionState.isUsbConnected = false;
    this.connectionState.isRealHardware = false;
    this.connectionState.isReceivingTelemetry = false;
    this.connectionState.diagnostics.serialDataReceived = false;
    this.connectionState.diagnostics.lastPacketTimestamp = 0;
    this.connectionState.diagnostics.lastMavlinkMessageId = undefined;
    this.connectionState.diagnostics.lastMavlinkMessageName = undefined;
    this.connectionState.phase = 'DISCONNECTED';
    this.connectionState.phaseMessage = 'Disconnected';
    this.connectionState.heartbeatHz = 0;

    // Reset Telemetry FC Link
    this.telemetry.pixhawkConnected = false;
    this.telemetry.isArmed = false;
    this.telemetry.flightMode = 'DISARMED';

    this.logDiagnostic('TRANSPORT', 'MAVLink connection completely cleaned up & disconnected.', 'info');
    this.notifyConnection();
    this.notifyTelemetry();
  }

  public async disconnect(): Promise<void> {
    await this.cleanupMavlinkConnection();
  }

  public async setTransport(transportId: string): Promise<boolean> {
    const success = transportManager.setTransport(transportId);
    if (success) {
      this.logDiagnostic('TRANSPORT', `Active transport changed to ${transportId}`, 'info');
      this.notifyConnection();
    }
    return success;
  }

  /**
   * MAVLink Byte Stream Parser (Sliding Window Ring Buffer for MAVLink 1.0 & 2.0)
   */
  public parseMavlinkStream(chunk: Uint8Array): void {
    this.processIncomingSerialBytes(chunk);
  }

  private processIncomingSerialBytes(chunk: Uint8Array) {
    if (chunk.length === 0) return;

    this.connectionState.bytesReceived += chunk.length;
    this.connectionState.diagnostics.lastPacketTimestamp = Date.now();

    if (!this.connectionState.diagnostics.serialDataReceived) {
      this.connectionState.diagnostics.serialDataReceived = true;
      this.clearSerialDataCheckTimer();
      this.logDiagnostic('TRANSPORT', `[RX DATA] Data detected ✓ (${chunk.length} bytes received). Passing to MAVLink parser…`, 'success');
      if (this.connectionState.phase === 'SERIAL_OPEN') {
        this.connectionState.phase = 'WAITING_FOR_MAVLINK';
        this.connectionState.phaseMessage = 'Data link open ✓. Waiting for MAVLink heartbeat…';
        this.notifyConnection();
      }
    }

    // Append chunk to rxBuffer safely
    if (this.rxBufferLen + chunk.length > this.rxBuffer.length) {
      const newBuf = new Uint8Array(Math.max(this.rxBuffer.length * 2, this.rxBufferLen + chunk.length + 1024));
      newBuf.set(this.rxBuffer.subarray(0, this.rxBufferLen), 0);
      this.rxBuffer = newBuf;
    }
    this.rxBuffer.set(chunk, this.rxBufferLen);
    this.rxBufferLen += chunk.length;

    // Sliding window packet extractor
    let offset = 0;
    while (offset < this.rxBufferLen) {
      const magic = this.rxBuffer[offset];
      if (magic !== 0xFE && magic !== 0xFD) {
        offset++;
        continue;
      }

      const remaining = this.rxBufferLen - offset;

      // MAVLink 1.0 (magic = 0xFE)
      if (magic === 0xFE) {
        if (remaining < 6) break;
        const payloadLen = this.rxBuffer[offset + 1];
        const packetLen = 6 + payloadLen + 2;
        if (remaining < packetLen) break;

        const frame = this.rxBuffer.subarray(offset, offset + packetLen);
        const msgId = frame[5];
        if (MAVLINK_CRC_EXTRAS[msgId] !== undefined) {
          const rxCrc = frame[6 + payloadLen] | (frame[6 + payloadLen + 1] << 8);
          const expectedCrc = this.calculateMavlinkCrc(frame.subarray(1, 6 + payloadLen), msgId);
          if (rxCrc !== expectedCrc) {
            // Checksum failure: false sync or corrupted frame. Step 1 byte and rescan.
            offset++;
            continue;
          }
        }
        this.decodeMavlink1Packet(frame);
        offset += packetLen;
        continue;
      }

      // MAVLink 2.0 (magic = 0xFD)
      if (magic === 0xFD) {
        if (remaining < 10) break;
        const payloadLen = this.rxBuffer[offset + 1];
        const incompatFlags = this.rxBuffer[offset + 2];
        const signatureLen = (incompatFlags & 0x01) ? 13 : 0;
        const packetLen = 10 + payloadLen + 2 + signatureLen;
        if (remaining < packetLen) break;

        const frame = this.rxBuffer.subarray(offset, offset + packetLen);
        const msgId = frame[7] | (frame[8] << 8) | (frame[9] << 16);
        if (MAVLINK_CRC_EXTRAS[msgId] !== undefined) {
          const rxCrc = frame[10 + payloadLen] | (frame[10 + payloadLen + 1] << 8);
          const expectedCrc = this.calculateMavlinkCrc(frame.subarray(1, 10 + payloadLen), msgId);
          if (rxCrc !== expectedCrc) {
            // Checksum failure: step 1 byte and rescan.
            offset++;
            continue;
          }
        }
        this.decodeMavlink2Packet(frame);
        offset += packetLen;
        continue;
      }
    }

    // Slide remaining unparsed bytes to front of buffer
    if (offset > 0) {
      if (offset < this.rxBufferLen) {
        this.rxBuffer.copyWithin(0, offset, this.rxBufferLen);
        this.rxBufferLen -= offset;
      } else {
        this.rxBufferLen = 0;
      }
    } else if (this.rxBufferLen > 1024) {
      // Avoid buffer deadlock if corrupted non-MAVLink byte occupies offset 0
      this.rxBuffer.copyWithin(0, 1, this.rxBufferLen);
      this.rxBufferLen--;
    }
  }

  /** Link Quality Tracker: Track MAVLink sequence numbers (0-255) to calculate real-time packet loss percentage */
  private trackMavlinkSequence(seq: number) {
    this.totalPacketsReceived++;
    if (this.lastMavlinkSeq === -1) {
      this.lastMavlinkSeq = seq;
      this.totalPacketsExpected = 1;
      this.connectionState.packetLossPercent = 0;
      return;
    }
    const diff = (seq - this.lastMavlinkSeq) & 0xFF;
    if (diff === 0) {
      // Duplicate packet
      return;
    }
    const lost = diff > 1 ? diff - 1 : 0;
    this.totalPacketsExpected += diff;
    this.totalPacketsLost += lost;
    this.lastMavlinkSeq = seq;

    // Real-time sliding window over the last 100 packets
    this.seqHistoryWindow.push({ seq, lost, time: Date.now() });
    if (this.seqHistoryWindow.length > 100) {
      this.seqHistoryWindow.shift();
    }
    const windowLost = this.seqHistoryWindow.reduce((acc, cur) => acc + cur.lost, 0);
    const windowTotal = this.seqHistoryWindow.length + windowLost;
    const lossPercent = windowTotal > 0 ? (windowLost / windowTotal) * 100 : 0;

    this.connectionState.packetLossPercent = +lossPercent.toFixed(1);
    this.connectionState.diagnostics.packetLossPercent = this.connectionState.packetLossPercent;
    this.connectionState.diagnostics.packetsLost = this.totalPacketsLost;
  }
  private decodeMavlink1Packet(frame: Uint8Array) {
    const payloadLen = frame[1];
    const seq = frame[2];
    this.trackMavlinkSequence(seq);
    const sysId = frame[3];
    const compId = frame[4];
    const msgId = frame[5];
    const payload = frame.subarray(6, 6 + payloadLen);

    this.handleParsedMavlinkMessage(msgId, payload, seq, sysId, compId, 'MAVLink 1.0');
  }

  private decodeMavlink2Packet(frame: Uint8Array) {
    const payloadLen = frame[1];
    const seq = frame[4];
    this.trackMavlinkSequence(seq);
    const sysId = frame[5];
    const compId = frame[6];
    const msgId = frame[7] | (frame[8] << 8) | (frame[9] << 16);
    const payload = frame.subarray(10, 10 + payloadLen);

    this.handleParsedMavlinkMessage(msgId, payload, seq, sysId, compId, 'MAVLink 2.0');
  }

  private handleParsedMavlinkMessage(
    msgId: number,
    payload: Uint8Array,
    seq: number,
    sysId: number,
    compId: number,
    mavVersion: string
  ) {
    const now = Date.now();
    this.connectionState.diagnostics.totalPacketsReceived++;

    const msgNames: Record<number, string> = {
      0: 'HEARTBEAT',
      1: 'SYS_STATUS',
      24: 'GPS_RAW_INT',
      30: 'ATTITUDE',
      33: 'GLOBAL_POSITION_INT',
      39: 'MISSION_ITEM',
      40: 'MISSION_REQUEST',
      44: 'MISSION_COUNT',
      47: 'MISSION_ACK',
      51: 'MISSION_REQUEST_INT',
      73: 'MISSION_ITEM_INT',
      74: 'VFR_HUD',
      76: 'COMMAND_LONG',
      77: 'COMMAND_ACK',
      124: 'GPS2_RAW',
      147: 'BATTERY_STATUS',
      242: 'HOME_POSITION',
      253: 'STATUSTEXT'
    };
    this.connectionState.diagnostics.lastMavlinkMessageName = msgNames[msgId] || `MSG_${msgId}`;
    this.connectionState.diagnostics.lastMavlinkMessageId = msgId;
    this.connectionState.diagnostics.lastPacketTimestamp = now;

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    switch (msgId) {
      // HEARTBEAT (msgId = 0) -> Strict gating of isConnected = true on >= 1.0 Hz
      case 0: {
        this.clearHeartbeatWaitTimer();
        this.connectionState.lastHeartbeat = now;
        this.heartbeatTimestamps.push(now);
        this.heartbeatTimestamps = this.heartbeatTimestamps.filter(t => now - t <= 3500);

        // Real-time instantaneous & sliding window frequency calculation
        let currentHz = 0;
        if (this.heartbeatTimestamps.length >= 2) {
          const spanSec = (this.heartbeatTimestamps[this.heartbeatTimestamps.length - 1] - this.heartbeatTimestamps[0]) / 1000;
          currentHz = spanSec > 0 ? (this.heartbeatTimestamps.length - 1) / spanSec : 1.0;
        } else if (this.heartbeatTimestamps.length === 1 && this.connectionState.isConnected) {
          currentHz = 1.0;
        }
        this.connectionState.heartbeatHz = +currentHz.toFixed(1);
        this.connectionState.diagnostics.heartbeatHz = this.connectionState.heartbeatHz;
        this.connectionState.diagnostics.heartbeatsCount++;
        this.connectionState.systemId = sysId;
        this.connectionState.componentId = compId;
        this.connectionState.diagnostics.systemId = sysId;
        this.connectionState.diagnostics.componentId = compId;
        this.connectionState.mavlinkVersion = mavVersion;

        // Strictly gate isConnected = true on valid HEARTBEAT reception at >= 1.0 Hz
        const isRateValid = currentHz >= 1.0 || (
          this.heartbeatTimestamps.length >= 2 &&
          (this.heartbeatTimestamps[this.heartbeatTimestamps.length - 1] - this.heartbeatTimestamps[this.heartbeatTimestamps.length - 2]) <= 1100
        );

        if (isRateValid) {
          const wasNotConnected = !this.connectionState.isConnected;
          this.connectionState.isConnected = true;
          this.connectionState.isReceivingTelemetry = true;
          this.connectionState.phase = "PIXHAWK_CONNECTED";
          this.connectionState.phaseMessage = `Pixhawk connected ✓ (${mavVersion} @ ${this.connectionState.heartbeatHz} Hz)`;
          this.telemetry.pixhawkConnected = true;

          if (wasNotConnected) {
            this.startGcsHeartbeat();
            // Auto Stream Rate Request on first valid HEARTBEAT:
            this.requestMavlinkDataStreams();
            this.logDiagnostic("MAVLINK", `[MAVLINK] HEARTBEAT validated at ${this.connectionState.heartbeatHz} Hz (>= 1.0 Hz) ✓ SysID: ${sysId}, CompID: ${compId}`, "success");
            this.addStatusMessage("INFO", 6, `Pixhawk Connected: Heartbeat verified at ${this.connectionState.heartbeatHz} Hz`);
          }
        } else {
          if (!this.connectionState.isConnected) {
            this.connectionState.phase = "WAITING_FOR_HEARTBEAT";
            this.connectionState.phaseMessage = `Heartbeat detected (${this.connectionState.heartbeatHz} Hz). Awaiting >= 1.0 Hz stream...`;
          }
        }

        if (payload.length >= 9) {
          const customMode = view.getUint32(0, true);
          const type = view.getUint8(4);
          const autopilot = view.getUint8(5);
          const baseMode = view.getUint8(6);
          const isArmed = (baseMode & 128) !== 0; // MAV_MODE_FLAG_SAFETY_ARMED (128)
          const flightModeName = ARDUPILOT_MODES[customMode] || `MODE_${customMode}`;

          this.connectionState.autopilotType = AUTOPILOT_NAMES[autopilot] || `AUTOPILOT_${autopilot}`;
          this.connectionState.diagnostics.autopilotType = this.connectionState.autopilotType;
          this.connectionState.diagnostics.vehicleType = VEHICLE_TYPE_NAMES[type] || `TYPE_${type}`;

          this.telemetry.isArmed = isArmed;
          this.telemetry.flightMode = flightModeName || "STABILIZE";
          this.connectionState.vehicleState = isArmed ? "ARMED" : "DISARMED";
          this.telemetry.vehicleState = isArmed ? "ARMED" : "DISARMED";

          if (this.connectionState.pendingFlightMode && this.connectionState.pendingFlightMode === flightModeName) {
            this.connectionState.pendingFlightMode = undefined;
            this.connectionState.lastModeChangeError = undefined;
            if (this.modeChangeResolver) {
              const res = this.modeChangeResolver;
              this.modeChangeResolver = null;
              if (this.modeChangeTimer) clearTimeout(this.modeChangeTimer);
              res({ success: true, message: `Mode confirmed: ${flightModeName}` });
            }
          }

          if (isArmed && this.connectionState.preArmFailReason) {
            this.connectionState.preArmFailReason = undefined;
            this.connectionState.preArmChecksPassed = true;
          }
        }        this.emitPacket('HEARTBEAT', { sysId, compId, seq });
        this.notifyTelemetry();
        this.notifyConnection();
        break;
      }

      // SYS_STATUS (msgId = 1)
      case 1: {
        // MAVLink wire format: uint16_t voltage_battery is at offset 14 (in mV)
        // MAVLink 2 zero-truncation means payload can be 16 to 31 bytes
        if (payload.length >= 16) {
          const voltageMv = view.getUint16(14, true);
          const currentA = payload.length >= 18 ? view.getInt16(16, true) / 100 : 0;
          const batteryRemaining = payload.length >= 19 ? view.getInt8(18) : -1;

          // 65535 indicates voltage is unmonitored or invalid
          if (voltageMv > 0 && voltageMv < 65000) {
            const voltageV = +(voltageMv / 1000).toFixed(2);
            this.telemetry.batteryVoltage = voltageV;
            this.telemetry.batteryCurrent = +Math.max(0, currentA).toFixed(2);

            // Dynamically detect or refine cell count (default 3S for this drone)
            if (voltageV > 20.0) {
              this.telemetry.batteryCellCount = 6;
            } else if (voltageV > 13.2) {
              this.telemetry.batteryCellCount = 4;
            } else {
              this.telemetry.batteryCellCount = 3;
            }

            if (batteryRemaining >= 0 && batteryRemaining <= 100) {
              this.telemetry.batteryPercent = batteryRemaining;
            } else if (voltageV > 0) {
              this.telemetry.batteryPercent = this.calculateLiPoPercentage(voltageV, this.telemetry.batteryCellCount);
            }
          }
          this.notifyTelemetry();
        }
        break;
      }

      // VFR_HUD (msgId = 74) - Primary flight instruments stream (Altitude, Speed, Throttle)
      case 74: {
        if (payload.length >= 12) {
          const groundspeed = view.getFloat32(4, true);
          const alt = view.getFloat32(8, true);
          const climb = payload.length >= 16 ? view.getFloat32(12, true) : 0;
          const heading = payload.length >= 18 ? view.getInt16(16, true) : 0;

          if (Number.isFinite(groundspeed) && groundspeed >= 0) {
            this.telemetry.groundSpeed = +groundspeed.toFixed(2);
          }
          if (Number.isFinite(climb)) {
            this.telemetry.verticalSpeed = +climb.toFixed(2);
          }
          if (Number.isFinite(heading) && heading >= 0) {
            this.telemetry.heading = heading;
          }
          if (Number.isFinite(alt) && alt >= 0) {
            this.telemetry.altitude = +alt.toFixed(2);
          }
          this.notifyTelemetry();
        }
        break;
      }

      // BATTERY_STATUS (msgId = 147)
      case 147: {
        // Wire order: 0..3 current_consumed, 4..7 energy_consumed, 8..9 temperature,
        // 10..29 voltages[10] (uint16 mV), 30..31 current_battery (int16 10*mA), 35 battery_remaining
        if (payload.length >= 12) {
          let totalVolts = 0;
          let activeCells = 0;
          for (let c = 0; c < 10; c++) {
            const cellOffset = 10 + c * 2;
            if (cellOffset + 2 <= payload.length) {
              const cellMv = view.getUint16(cellOffset, true);
              if (cellMv > 0 && cellMv < 65000) {
                totalVolts += cellMv / 1000;
                activeCells++;
              }
            }
          }

          if (activeCells > 0) {
            this.telemetry.batteryCellCount = activeCells;
          } else if (totalVolts > 0) {
            this.telemetry.batteryCellCount = totalVolts > 20.0 ? 6 : totalVolts > 13.2 ? 4 : 3;
          }

          if (totalVolts > 0) {
            this.telemetry.batteryVoltage = +totalVolts.toFixed(2);
          }

          if (payload.length >= 32) {
            const currentRaw = view.getInt16(30, true);
            if (currentRaw >= 0) {
              this.telemetry.batteryCurrent = +(currentRaw / 100).toFixed(2);
            }
          }

          if (payload.length >= 36) {
            const batteryRemaining = view.getInt8(35);
            if (batteryRemaining >= 0 && batteryRemaining <= 100) {
              this.telemetry.batteryPercent = batteryRemaining;
            } else if (this.telemetry.batteryVoltage > 0) {
              this.telemetry.batteryPercent = this.calculateLiPoPercentage(this.telemetry.batteryVoltage, this.telemetry.batteryCellCount);
            }
          } else if (this.telemetry.batteryVoltage > 0) {
            this.telemetry.batteryPercent = this.calculateLiPoPercentage(this.telemetry.batteryVoltage, this.telemetry.batteryCellCount);
          }
          this.notifyTelemetry();
        }
        break;
      }

      // MISSION_COUNT (msgId = 44) - Received from FC during mission download/readback
      case 44: {
        if (payload.length >= 2 && this.missionDownloadResolver) {
          const count = view.getUint16(0, true);
          this.expectedDownloadCount = count;
          this.downloadedMissionItems = [];
          this.logDiagnostic('MAVLINK', `[MAVLINK] RX MISSION_COUNT count=${count} sys=${sysId} comp=${compId}`, 'info');
          if (count === 0) {
            this.sendMissionAck(0);
            const res = this.missionDownloadResolver;
            this.missionDownloadResolver = null;
            if (this.downloadItemRetryTimer) {
              clearTimeout(this.downloadItemRetryTimer);
              this.downloadItemRetryTimer = null;
            }
            res({ success: true, items: [], message: 'Pixhawk reports 0 mission items in storage' });
          } else {
            this.requestDownloadItem(0);
          }
        }
        break;
      }

      // MISSION_ITEM_INT (msgId = 73) & MISSION_ITEM (msgId = 39) - Received during download/readback
      case 73:
      case 39: {
        if (this.missionDownloadResolver && payload.length >= 32) {
          const p1 = view.getFloat32(0, true);
          const p2 = view.getFloat32(4, true);
          const p3 = view.getFloat32(8, true);
          const p4 = view.getFloat32(12, true);
          let lat: number, lon: number;
          if (msgId === 73) {
            lat = view.getInt32(16, true) / 1e7;
            lon = view.getInt32(20, true) / 1e7;
          } else {
            lat = view.getFloat32(16, true);
            lon = view.getFloat32(20, true);
          }
          const alt = view.getFloat32(24, true);
          const seq = view.getUint16(28, true);
          const cmd = view.getUint16(30, true);
          const frame = payload.length >= 35 ? view.getUint8(34) : (seq === 0 ? 0 : 6);
          const autocontinue = payload.length >= 37 ? view.getUint8(36) : 1;

          const newItem: MavlinkMissionItem = {
            seq,
            command: cmd,
            frame,
            param1: p1,
            param2: p2,
            param3: p3,
            param4: p4,
            lat,
            lon,
            alt,
            autocontinue
          };

          const existingIdx = this.downloadedMissionItems.findIndex((it) => it.seq === seq);
          if (existingIdx >= 0) {
            this.downloadedMissionItems[existingIdx] = newItem;
          } else {
            this.downloadedMissionItems.push(newItem);
            this.downloadedMissionItems.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
          }

          this.logDiagnostic('MAVLINK', `[MAVLINK] RX ${msgId === 73 ? 'MISSION_ITEM_INT' : 'MISSION_ITEM'} seq=${seq} cmd=${cmd} lat=${lat.toFixed(6)} lon=${lon.toFixed(6)} alt=${alt.toFixed(1)}m`, 'info');

          const nextSeq = this.downloadedMissionItems.length;
          if (nextSeq < this.expectedDownloadCount) {
            this.requestDownloadItem(nextSeq);
          } else {
            if (this.downloadItemRetryTimer) {
              clearTimeout(this.downloadItemRetryTimer);
              this.downloadItemRetryTimer = null;
            }
            this.sendMissionAck(0);
            const res = this.missionDownloadResolver;
            this.missionDownloadResolver = null;
            this.logDiagnostic('MAVLINK', `[MISSION READBACK] Successfully verified ${this.downloadedMissionItems.length} items from Pixhawk ✓`, 'success');
            res({
              success: true,
              items: this.downloadedMissionItems,
              message: `Successfully verified ${this.downloadedMissionItems.length} items from Pixhawk`
            });
          }
        }
        break;
      }

      // MISSION_REQUEST (msgId = 40) & MISSION_REQUEST_INT (msgId = 51)
      case 40:
      case 51: {
        if (payload.length >= 2) {
          // Pixhawk has begun requesting items -> permanently cancel MISSION_COUNT retries
          this.missionTransferActive = true;
          if (this.missionCountRetryTimer) {
            clearTimeout(this.missionCountRetryTimer);
            clearInterval(this.missionCountRetryTimer);
            this.missionCountRetryTimer = null;
          }
          this.resetMissionItemWatchdog(8000);

          const requestedSeq = view.getUint16(0, true);
          const now = Date.now();
          const reqName = msgId === 51 ? 'MISSION_REQUEST_INT' : 'MISSION_REQUEST';

          // Debounce rapid duplicate requests for the exact same sequence within 150ms
          if (requestedSeq === this.lastSentSeq && now - this.lastSentTimeMs < 150) {
            this.logDiagnostic('MAVLINK', `[MAVLINK] Debounced duplicate ${reqName} for seq ${requestedSeq} (${now - this.lastSentTimeMs}ms)`, 'info');
            break;
          }

          this.logDiagnostic('MAVLINK', `[MAVLINK] RX ${reqName} seq=${requestedSeq}`, 'info');

          if (this.pendingMissionItems && requestedSeq < this.pendingMissionItems.length) {
            this.lastRequestedSeq = requestedSeq;
            this.lastSentSeq = requestedSeq;
            this.lastSentTimeMs = now;
            const item = this.pendingMissionItems[requestedSeq];

            // Critical ArduPilot compliance:
            // ArduPilot requires MISSION_ITEM_INT (msg 73).
            // When sent legacy MISSION_ITEM (msg 39), ArduPilot firmware explicitly rejects with:
            // "got MISSION_ITEM; GCS should send MISSION_ITEM_INT" and aborts with MAV_MISSION_ERROR.
            // Therefore, ALWAYS respond with MISSION_ITEM_INT (msg 73).
            this.sendMissionItemInt(requestedSeq, item);

            // Item retransmission watchdog (retry up to 5 times if FC drops the packet)
            if (this.missionItemRetryTimer) {
              clearTimeout(this.missionItemRetryTimer);
              this.missionItemRetryTimer = null;
            }
            let itemRetries = 0;
            const scheduleItemRetry = () => {
              this.missionItemRetryTimer = setTimeout(() => {
                if (this.missionUploadResolver && this.lastRequestedSeq === requestedSeq && itemRetries < 5) {
                  itemRetries++;
                  this.logDiagnostic('MAVLINK', `[MAVLINK] Retrying waypoint seq ${requestedSeq} (attempt ${itemRetries}/5)...`, 'warn');
                  this.sendMissionItemInt(requestedSeq, item);
                  scheduleItemRetry();
                }
              }, 1500);
            };
            scheduleItemRetry();
          } else {
            this.logDiagnostic('MAVLINK', `[MAVLINK] Requested seq ${requestedSeq} out of bounds (pending items: ${this.pendingMissionItems?.length || 0})`, 'warn');
          }
        }
        break;
      }

      // MISSION_ACK (msgId = 47)
      case 47: {
        // MAVLink 2 zero-byte truncation:
        // When type = 0 (MAV_MISSION_ACCEPTED) and mission_type = 0, trailing zero bytes are trimmed,
        // resulting in a 2-byte payload: [target_system, target_component].
        if (payload.length >= 1) {
          const ackType = payload.length >= 3 ? view.getUint8(2) : 0;

          // Handle MISSION_CLEAR_ALL acknowledgement if pending
          if (this.missionClearResolver) {
            const resolve = this.missionClearResolver;
            this.missionClearResolver = null;
            if (ackType === 0) {
              this.logDiagnostic('MAVLINK', '[MISSION_CLEAR_ALL RX] Pixhawk cleared all existing mission waypoints ✓', 'success');
              resolve({ success: true, message: 'Pixhawk cleared all existing waypoints ✓' });
            } else {
              this.logDiagnostic('MAVLINK', `[MISSION_CLEAR_ALL RX] Pixhawk clear returned code ${ackType}`, 'warn');
              resolve({ success: false, message: `Clear failed with code ${ackType}` });
            }
            break;
          }

          if (ackType === 0) {
            this.clearMissionUploadTimers();
            this.logDiagnostic('MAVLINK', `[MISSION_ACK RX] Pixhawk accepted mission waypoints (${this.pendingMissionItems?.length || 0} items) ✓`, 'success');
            this.addStatusMessage('NOTICE', 5, 'Mission stored in Pixhawk');
            if (this.missionUploadResolver) {
              const resolve = this.missionUploadResolver;
              this.missionUploadResolver = null;
              resolve({
                success: true,
                message: `Mission uploaded and verified by Pixhawk (${this.pendingMissionItems?.length || 0} waypoints) ✓`
              });
            }
          } else if (ackType === 13) {
            // MAV_MISSION_INVALID_SEQUENCE
            // Transient sequence desync: ArduPilot sends an INVALID_SEQUENCE NACK for an out-of-order duplicate packet,
            // then immediately re-requests the expected item. Allow 4s for Pixhawk to re-sync rather than immediately aborting.
            this.logDiagnostic('MAVLINK', `[MISSION_ACK RX] Pixhawk reported transient INVALID_SEQUENCE. Maintaining transfer session for re-sync item request...`, 'warn');
            this.resetMissionItemWatchdog(4000);
          } else {
            this.clearMissionUploadTimers();
            const ackErrors: Record<number, string> = {
              1: 'MAV_MISSION_ERROR (generic)',
              2: 'MAV_MISSION_UNSUPPORTED_FRAME',
              3: 'MAV_MISSION_UNSUPPORTED',
              4: 'MAV_MISSION_NO_SPACE',
              5: 'MAV_MISSION_INVALID',
              6: 'MAV_MISSION_INVALID_PARAM1',
              7: 'MAV_MISSION_INVALID_PARAM2',
              8: 'MAV_MISSION_INVALID_PARAM3',
              9: 'MAV_MISSION_INVALID_PARAM4',
              10: 'MAV_MISSION_INVALID_PARAM5_X',
              11: 'MAV_MISSION_INVALID_PARAM6_Y',
              12: 'MAV_MISSION_INVALID_PARAM7',
              13: 'MAV_MISSION_INVALID_SEQUENCE',
              14: 'MAV_MISSION_DENIED',
              15: 'MAV_MISSION_OPERATION_CANCELLED'
            };
            const errDesc = ackErrors[ackType] || `Code ${ackType}`;
            this.logDiagnostic('MAVLINK', `[MISSION_ACK RX] Pixhawk rejected mission: ${errDesc}`, 'warn');
            if (this.missionUploadResolver) {
              const resolve = this.missionUploadResolver;
              this.missionUploadResolver = null;
              resolve({
                success: false,
                message: `Pixhawk rejected mission: ${errDesc}`
              });
            }
          }
        }
        break;
      }

      // GPS_RAW_INT (msgId = 24) & GPS2_RAW (msgId = 124)
      case 24:
      case 124: {
        if (payload.length >= 30) {
          // Offsets per MAVLink v1/v2 wire specification:
          // 0..7:   time_usec (uint64)
          // 8..11:  lat (int32, degE7)
          // 12..15: lon (int32, degE7)
          // 16..19: alt (int32, mm)
          // 20..21: eph (uint16, HDOP * 100)
          // 22..23: epv (uint16, VDOP * 100)
          // 24..25: vel (uint16, groundspeed cm/s)
          // 26..27: cog (uint16, cdeg)
          // 28:     fix_type (uint8)
          // 29:     satellites_visible (uint8)
          const lat = view.getInt32(8, true) / 1e7;
          const lon = view.getInt32(12, true) / 1e7;
          const alt = view.getInt32(16, true) / 1000;
          const ephRaw = view.getUint16(20, true);
          const eph = (ephRaw === 65535 || ephRaw === 0) ? 1.0 : +(ephRaw / 100).toFixed(2);
          const fixType = view.getUint8(28);
          const satellitesVisible = view.getUint8(29);

          const fixMap: Record<number, GPSLocation['fixType']> = {
            0: 'NO_GPS',
            1: 'NO_FIX',
            2: '2D_FIX',
            3: '3D_FIX',
            4: 'DGPS',
            5: 'RTK_FLOAT',
            6: 'RTK_FIXED'
          };

          const instanceFixType = fixMap[fixType] || (fixType >= 3 ? '3D_FIX' : 'NO_FIX');
          const instanceEntry = {
            fixType: instanceFixType,
            rawFixType: fixType,
            satellites: satellitesVisible,
            hdop: eph,
            lat,
            lon,
            alt,
            lastUpdated: now
          };

          if (msgId === 24) {
            this.gps1Data = instanceEntry;
          } else {
            this.gps2Data = instanceEntry;
          }

          // Multi-GPS Arbitration:
          // When GPS is on SERIAL4/5, Pixhawk outputs GPS 2 (msg 124) with 18 sats, while GPS 1 (msg 24) is 0 sats.
          // We arbitrate so that an inactive/empty GPS instance never clobbers active GPS telemetry!
          const isGps1Fresh = (now - this.gps1Data.lastUpdated) < 4000;
          const isGps2Fresh = (now - this.gps2Data.lastUpdated) < 4000;

          let bestGps = msgId === 24 ? this.gps1Data : this.gps2Data;
          let activeInstance: 1 | 2 = msgId === 24 ? 1 : 2;

          if (isGps1Fresh && isGps2Fresh) {
            if (this.gps2Data.rawFixType > this.gps1Data.rawFixType) {
              bestGps = this.gps2Data;
              activeInstance = 2;
            } else if (this.gps1Data.rawFixType > this.gps2Data.rawFixType) {
              bestGps = this.gps1Data;
              activeInstance = 1;
            } else {
              if (this.gps2Data.satellites > this.gps1Data.satellites) {
                bestGps = this.gps2Data;
                activeInstance = 2;
              } else {
                bestGps = this.gps1Data;
                activeInstance = 1;
              }
            }
          } else if (isGps2Fresh && !isGps1Fresh) {
            bestGps = this.gps2Data;
            activeInstance = 2;
          } else if (isGps1Fresh && !isGps2Fresh) {
            bestGps = this.gps1Data;
            activeInstance = 1;
          }

          this.connectionState.gpsInstances = {
            gps1: { sats: this.gps1Data.satellites, fix: this.gps1Data.fixType || 'NO_GPS', hdop: this.gps1Data.hdop, lastUpdated: this.gps1Data.lastUpdated },
            gps2: { sats: this.gps2Data.satellites, fix: this.gps2Data.fixType || 'NO_GPS', hdop: this.gps2Data.hdop, lastUpdated: this.gps2Data.lastUpdated },
            activeInstance
          };

          const hasCoord = Math.abs(bestGps.lat) > 0.001 && Math.abs(bestGps.lon) > 0.001;
          const is3DFix = bestGps.rawFixType >= 3 || (hasCoord && bestGps.satellites >= 6);
          this.telemetry.gps.fixType = is3DFix ? (bestGps.fixType === 'NO_GPS' || bestGps.fixType === 'NO_FIX' ? '3D_FIX' : bestGps.fixType) : bestGps.fixType;
          this.telemetry.gps.isLocked = (is3DFix || bestGps.rawFixType >= 2) && (bestGps.satellites >= 4 || hasCoord);
          this.telemetry.gps.satellites = bestGps.satellites;
          this.telemetry.gps.hdop = bestGps.hdop;

          if (hasCoord) {
            this.telemetry.latitude = bestGps.lat;
            this.telemetry.longitude = bestGps.lon;
            this.telemetry.gps.latitude = bestGps.lat;
            this.telemetry.gps.longitude = bestGps.lon;
            this.telemetry.gps.altitude = bestGps.alt;

            // Auto-seed or refine initial Home if disarmed on ground and not manually locked
            const isHomeFarFromDrone = this.homePoint.isSet && (
              Math.abs(bestGps.lat - this.homePoint.latitude) > 0.0003 ||
              Math.abs(bestGps.lon - this.homePoint.longitude) > 0.0003
            );
            if ((!this.homePoint.isSet || (isHomeFarFromDrone && !this.homePointManualLock)) && !this.telemetry.isArmed && this.telemetry.altitude <= 1.5) {
              this.homePoint = {
                latitude: bestGps.lat,
                longitude: bestGps.lon,
                altitude: bestGps.alt,
                timestamp: now,
                isSet: true
              };
            }
          }
          this.notifyTelemetry();
        }
        break;
      }

      // GLOBAL_POSITION_INT (msgId = 33)
      case 33: {
        if (payload.length >= 28) {
          const lat = view.getInt32(4, true) / 1e7;
          const lon = view.getInt32(8, true) / 1e7;
          const relativeAlt = view.getInt32(16, true) / 1000;
          const vx = view.getInt16(20, true) / 100;
          const vy = view.getInt16(22, true) / 100;
          const vz = view.getInt16(24, true) / 100;
          const hdg = view.getUint16(26, true) / 100;

          if (Math.abs(lat) > 0.001 && Math.abs(lon) > 0.001) {
            this.telemetry.latitude = lat;
            this.telemetry.longitude = lon;
            // Valid coordinates from Pixhawk EKF confirms live position lock
            if (!this.telemetry.gps.isLocked && this.telemetry.gps.satellites >= 6) {
              this.telemetry.gps.isLocked = true;
              if (this.telemetry.gps.fixType === 'NO_GPS' || this.telemetry.gps.fixType === 'NO_FIX') {
                this.telemetry.gps.fixType = '3D_FIX';
              }
            }
          } else {
            // EKF coordinate fallback: If EKF is not blended yet, keep the best raw GPS lat/lon
            const activeBestGps = (Math.abs(this.gps2Data.lat) > 0.001 && Math.abs(this.gps2Data.lon) > 0.001)
              ? this.gps2Data
              : (Math.abs(this.gps1Data.lat) > 0.001 && Math.abs(this.gps1Data.lon) > 0.001)
                ? this.gps1Data
                : (this.gps2Data.satellites > this.gps1Data.satellites ? this.gps2Data : this.gps1Data);
            if (Math.abs(activeBestGps.lat) > 0.001 && Math.abs(activeBestGps.lon) > 0.001) {
              if (Math.abs(this.telemetry.latitude) < 0.001 || Math.abs(this.telemetry.longitude) < 0.001) {
                this.telemetry.latitude = activeBestGps.lat;
                this.telemetry.longitude = activeBestGps.lon;
              }
            }
          }
          this.telemetry.altitude = +Math.max(0, relativeAlt).toFixed(2);
          this.telemetry.groundSpeed = +Math.hypot(vx, vy).toFixed(2);
          this.telemetry.verticalSpeed = +(-vz).toFixed(2);
          this.telemetry.heading = +hdg.toFixed(0);

          if (this.homePoint.isSet && this.homePoint.latitude !== 0) {
            const dy = (this.telemetry.latitude - this.homePoint.latitude) * 111320;
            const dx = (this.telemetry.longitude - this.homePoint.longitude) * 111320 * Math.cos((this.homePoint.latitude * Math.PI) / 180);
            this.telemetry.distanceToHome = +Math.hypot(dx, dy).toFixed(1);
          }

          this.notifyTelemetry();
        }
        break;
      }

      // HOME_POSITION (msgId = 242)
      case 242: {
        if (payload.length >= 12) {
          const lat = view.getInt32(0, true) / 1e7;
          const lon = view.getInt32(4, true) / 1e7;
          const alt = view.getInt32(8, true) / 1000;
          if (Math.abs(lat) > 0.0001 && Math.abs(lon) > 0.0001) {
            this.homePoint = {
              latitude: lat,
              longitude: lon,
              altitude: alt,
              timestamp: now,
              isSet: true
            };
            if (this.telemetry.latitude !== 0 && this.telemetry.longitude !== 0) {
              const dy = (this.telemetry.latitude - this.homePoint.latitude) * 111320;
              const dx = (this.telemetry.longitude - this.homePoint.longitude) * 111320 * Math.cos((this.homePoint.latitude * Math.PI) / 180);
              this.telemetry.distanceToHome = +Math.hypot(dx, dy).toFixed(1);
            }
            this.notifyTelemetry();
            this.logDiagnostic('MAVLINK', `[HOME_POSITION RX] Pixhawk Home: ${lat.toFixed(7)}, ${lon.toFixed(7)} (Alt: ${alt.toFixed(1)}m)`, 'success');
          }
        }
        break;
      }

      // STATUSTEXT (msgId = 253)
      case 253: {
        if (payload.length >= 1) {
          const severityLevel = view.getUint8(0);
          const severity = SEVERITY_NAMES[severityLevel] || 'INFO';
          const textBytes = payload.subarray(1);
          let text = '';
          for (let j = 0; j < textBytes.length; j++) {
            if (textBytes[j] === 0) break;
            text += String.fromCharCode(textBytes[j]);
          }
          if (text.length > 0) {
            // Scan for intercepted QR competition rescue payloads (e.g. "QR_CODE:42", "QR: 42" or "RESCUE_CODE: 42")
            const qrMatch = text.match(/QR_CODE:(\d{2})/i) ||
                            text.match(/(?:QR(?:_CODE)?|TARGET|RESCUE)[_:\s=]+(\d{2})\b/i) ||
                            text.match(/\bQR\s*(\d{2})\b/i);
            if (qrMatch && qrMatch[1]) {
              this.lockRescueTarget(qrMatch[1]);
            }
            const lower = text.toLowerCase();
            const explanation = this.explainPreArmFailure(text);
            const displayMsg = explanation !== text ? `${text} (${explanation})` : text;

            // Surface all Arm, PreArm, Logging, Calibration, and Safety rejections to UI
            if (
              lower.includes('arm') || 
              lower.includes('prearm') || 
              lower.includes('log') || 
              lower.includes('fail') || 
              lower.includes('check') || 
              lower.includes('disabled') || 
              lower.includes('compass') || 
              lower.includes('gps') || 
              lower.includes('switch') || 
              lower.includes('bad') || 
              severityLevel <= 4
            ) {
              this.connectionState.preArmFailReason = explanation;
              if (lower.includes('arm') || lower.includes('fail')) {
                this.connectionState.vehicleState = 'DISARMED';
                this.telemetry.vehicleState = 'DISARMED';
              }
            }
            // Surface mode change rejections to UI
            if (lower.includes('mode change') || (lower.includes('requires position') && (lower.includes('mode') || lower.includes('failed')))) {
              this.connectionState.lastModeChangeError = explanation;
              this.connectionState.pendingFlightMode = undefined;
              if (this.modeChangeResolver) {
                const res = this.modeChangeResolver;
                this.modeChangeResolver = null;
                if (this.modeChangeTimer) clearTimeout(this.modeChangeTimer);
                res({ success: false, message: explanation });
              }
            }

            // Pixhawk explicitly announces "Flight plan received" when all mission items are safely committed to EEPROM
            if (lower.includes('flight plan received')) {
              this.logDiagnostic('MAVLINK', `[STATUSTEXT] Pixhawk confirmed: "${text}" ✓`, 'success');
              if (this.missionUploadResolver) {
                this.clearMissionUploadTimers();
                const resolve = this.missionUploadResolver;
                this.missionUploadResolver = null;
                resolve({
                  success: true,
                  message: `Mission uploaded and verified by Pixhawk (${this.pendingMissionItems?.length || 0} waypoints) ✓`
                });
              }
            }

            this.logDiagnostic('MAVLINK', `[STATUSTEXT] [${severity}] ${displayMsg}`, severityLevel <= 3 ? 'error' : severityLevel === 4 ? 'warn' : 'info');
            this.addStatusMessage(severity, severityLevel, displayMsg);
            this.notifyConnection();
            this.notifyTelemetry();
          }
        }
        break;
      }

      // RC_CHANNELS_RAW (msgId = 35) & RC_CHANNELS (msgId = 65)
      case 35:
      case 65: {
        if (payload.length >= 8) {
          const ch1 = view.getUint16(4, true);
          const ch2 = view.getUint16(6, true);
          const ch3 = payload.length >= 10 ? view.getUint16(8, true) : 0;
          const ch4 = payload.length >= 12 ? view.getUint16(10, true) : 0;
          const rssi = payload.length >= 22 ? view.getUint8(21) : 0;
          const hasValidSignals = ch1 >= 850 && ch1 <= 2150 && ch3 >= 850 && ch3 <= 2150;
          this.telemetry.rcSignalDetected = hasValidSignals;
          this.connectionState.rcSignalDetected = hasValidSignals;
          this.telemetry.rcRssi = rssi;
          this.connectionState.rcRssi = rssi;
          this.notifyTelemetry();
        }
        break;
      }

      // COMMAND_ACK (msgId = 77)
      case 77: {
        if (payload.length >= 2) {
          const command = view.getUint16(0, true);
          const result = payload.length >= 3 ? view.getUint8(2) : 0;
          const progress = payload.length >= 4 ? view.getUint8(3) : 0;
          const resultParam2 = payload.length >= 8 ? view.getInt32(4, true) : 0;
          const resultNames = [
            'MAV_RESULT_ACCEPTED', // 0
            'MAV_RESULT_TEMPORARILY_REJECTED', // 1
            'MAV_RESULT_DENIED', // 2
            'MAV_RESULT_UNSUPPORTED', // 3
            'MAV_RESULT_FAILED', // 4
            'MAV_RESULT_IN_PROGRESS', // 5
            'MAV_RESULT_CANCELLED' // 6
          ];
          const resultName = resultNames[result] || `MAV_RESULT_${result}`;
          const resText = `Command ${command} ACK: ${resultName}${resultParam2 ? ` (param2=${resultParam2})` : ''}`;

          if (command === 400) {
            console.log(`[MAVLINK ACK]\ncommand = ${command}\nresult = ${resultName} (${result})`);
            if (result === 0) {
              console.log('[ARM] PIXHAWK ACCEPTED COMMAND');
            } else {
              console.warn(`[ARM] PIXHAWK REJECTED COMMAND: ${resultName} (Code ${result})`);
            }
          } else if (command === 176) {
            console.log(`[MAVLINK ACK]\ncommand = 176 (SET_MODE)\nresult = ${resultName} (${result})`);
            if (result === 0) {
              this.logDiagnostic('MAVLINK', `[SET_MODE ACK] Mode command accepted by Pixhawk ✓`, 'success');
            } else {
              const rejectReason = (result === 4 || result === 1)
                ? 'Mode change rejected: Position lock required (3D GPS Fix & EKF needed). Switch to STABILIZE or ALT_HOLD to fly/arm without GPS.'
                : `Mode change rejected (${resultName})`;
              this.logDiagnostic('MAVLINK', `[SET_MODE ACK] ${rejectReason}`, 'warn');
              this.addStatusMessage('WARNING', 4, rejectReason);
              this.connectionState.lastModeChangeError = rejectReason;
              this.connectionState.pendingFlightMode = undefined;
              if (this.modeChangeResolver) {
                const res = this.modeChangeResolver;
                this.modeChangeResolver = null;
                if (this.modeChangeTimer) clearTimeout(this.modeChangeTimer);
                res({ success: false, message: rejectReason });
              }
              this.notifyConnection();
            }
          } else {
            console.log(`[MAVLINK ACK]\ncommand = ${command}\nresult = ${resultName} (${result})`);
          }

          const ackObj = {
            command,
            commandName: command === 400 ? 'MAV_CMD_COMPONENT_ARM_DISARM' : command === 300 ? 'MAV_CMD_MISSION_START' : `CMD_${command}`,
            result,
            resultName,
            progress,
            resultParam2,
            timestamp: Date.now()
          };

          this.connectionState.lastCommandAck = ackObj;
          this.connectionState.lastCommandAckResultName = resultName;

          if (command === 400) {
            this.connectionState.lastArmCommandAck = ackObj;
            this.connectionState.lastArmAckResult = resultName;
            if (result === 0) {
              this.logDiagnostic('MAVLINK', '[ARM ACK] ARM COMMAND ACCEPTED ✓ (Awaiting Heartbeat armed confirmation)', 'success');
              this.addStatusMessage('INFO', 6, 'ARM COMMAND ACCEPTED (Waiting for vehicle armed state)');
            } else {
              const baseReason = this.connectionState.preArmFailReason 
                ? this.explainPreArmFailure(this.connectionState.preArmFailReason)
                : `Pixhawk rejected Arm (${resultName}). Check safety switch pressed, GPS 3D fix, and compass calibration.`;
              this.connectionState.preArmFailReason = baseReason;
              this.connectionState.vehicleState = 'DISARMED';
              this.telemetry.vehicleState = 'DISARMED';
              this.logDiagnostic('MAVLINK', `[ARM ACK] ARM COMMAND REJECTED by Pixhawk (${resultName}): ${baseReason}`, 'warn');
              this.addStatusMessage('WARNING', 4, `ARM COMMAND REJECTED: ${baseReason}`);
            }
            this.notifyConnection();
            this.notifyTelemetry();
          }
          this.connectionState.commandAckHistory = [ackObj, ...this.connectionState.commandAckHistory.slice(0, 9)];

          this.logDiagnostic('MAVLINK', `[COMMAND_ACK] ${resText}`, result === 0 ? 'success' : 'warn');
          this.emitPacket('COMMAND_ACK', ackObj);
          this.notifyConnection();
        }
        break;
      }
    }
  }

  private currentControlMode: 'RC' | 'NO_RC' = 'NO_RC';

  public getControlMode(): 'RC' | 'NO_RC' {
    return this.currentControlMode;
  }

  public setControlMode(mode: 'RC' | 'NO_RC') {
    if (this.currentControlMode === mode) return;
    console.log(`[CONTROL MODE] Switched to: ${mode}`);
    this.currentControlMode = mode;
    this.telemetry.controlMode = mode;
    this.connectionState.controlMode = mode;
    this.notifyTelemetry();
    this.notifyConnection();
  }

  public async sendRequestDataStream(streamId: number, rateHz: number): Promise<boolean> {
    try {
      const payload = new Uint8Array(6);
      const view = new DataView(payload.buffer);
      view.setUint16(0, rateHz, true); // req_message_rate
      const targetSys = this.connectionState.systemId || 1;
      const targetComp = this.connectionState.componentId || 1;
      view.setUint8(2, targetSys);     // target_system
      view.setUint8(3, targetComp);    // target_component
      view.setUint8(4, streamId);      // req_stream_id (0 = ALL)
      view.setUint8(5, 1);             // start_stop (1 = start)

      const packet = this.buildMavlinkFrame(66 /* REQUEST_DATA_STREAM */, payload);
      const success = await usbHostService.sendBytes(packet);
      if (success) {
        this.connectionState.bytesSent += packet.length;
      }
      return success;
    } catch {
      return false;
    }
  }

  private lastStreamRequestTime = 0;
  public async requestMavlinkDataStreams() {
    const now = Date.now();
    if (now - this.lastStreamRequestTime < 2000) return; // Throttled: at most once every 2.0s
    this.lastStreamRequestTime = now;

    // 1. Universal MAVLink Stream Requests (Required for ArduPilot TELEM2 when SR2 rates are 0)
    // Stream 0 (ALL) signals Pixhawk that a GCS has connected and prompts the flight controller to start streaming
    await this.sendRequestDataStream(0 /* ALL streams */, 4 /* 4 Hz */);
    await this.sendRequestDataStream(1 /* RAW_SENSORS */, 2 /* 2 Hz */);
    await this.sendRequestDataStream(2 /* EXTENDED_STATUS: SYS_STATUS & BATTERY_STATUS */, 4 /* 4 Hz */);
    await this.sendRequestDataStream(3 /* RC_CHANNELS from TELEM1 receiver */, 4 /* 4 Hz */);
    await this.sendRequestDataStream(6 /* POSITION: GPS 1 & GPS 2 (GPS_RAW_INT & GLOBAL_POSITION_INT) */, 5 /* 5 Hz */);
    await this.sendRequestDataStream(10 /* EXTRA1: ATTITUDE */, 5 /* 5 Hz */);
    await this.sendRequestDataStream(11 /* EXTRA2: VFR_HUD */, 4 /* 4 Hz */);
    await this.sendRequestDataStream(12 /* EXTRA3: BATTERY, AHRS */, 2 /* 2 Hz */);

    // 2. Modern MAVLink 2 command: MAV_CMD_SET_MESSAGE_INTERVAL (cmd 511)
    // Param 1 = message ID, Param 2 = interval in microseconds
    try {
      await this.sendMavlinkCommandLong(511, 1 /* SYS_STATUS: battery voltage/current/percentage */, 250000 /* 4 Hz */);
      await this.sendMavlinkCommandLong(511, 147 /* BATTERY_STATUS: multi-cell voltages */, 500000 /* 2 Hz */);
      await this.sendMavlinkCommandLong(511, 74 /* VFR_HUD: altitude, airspeed, heading */, 250000 /* 4 Hz */);
      await this.sendMavlinkCommandLong(511, 33 /* GLOBAL_POSITION_INT: EKF fused position */, 200000 /* 5 Hz */);
      await this.sendMavlinkCommandLong(511, 30 /* ATTITUDE: roll, pitch, yaw */, 100000 /* 10 Hz */);
      await this.sendMavlinkCommandLong(511, 24 /* GPS_RAW_INT: Primary GPS 1 */, 200000 /* 5 Hz */);
      await this.sendMavlinkCommandLong(511, 124 /* GPS2_RAW: Secondary GPS 2 */, 200000 /* 5 Hz */);
      await this.sendMavlinkCommandLong(511, 65 /* RC_CHANNELS: TELEM1 receiver sticks */, 250000 /* 4 Hz */);
      await this.sendMavlinkCommandLong(511, 253 /* STATUSTEXT: Pixhawk notices & alerts */, 500000 /* 2 Hz */);
      this.logDiagnostic("MAVLINK", "[AUTO STREAM] Requested GPS, Attitude, VFR_HUD, and STATUSTEXT streams from Pixhawk ✓", "info");
    } catch (e) {
      console.warn('Failed to send MAV_CMD_SET_MESSAGE_INTERVAL', e);
    }
  }
  public async sendArmCommand(force: boolean = false): Promise<boolean> {
    console.log('[ARM] BUTTON CLICKED');

    // Debounce / In-flight guard: 1 click = exactly 1 command sent
    if (this.isArmCommandInFlight) {
      console.warn('[ARM] ARM command already in flight. Ignoring duplicate request.');
      return false;
    }

    const isWsOpen = this.connectionState.isUsbConnected || this.connectionState.isConnected;
    console.log(`[ARM] WS STATE = ${isWsOpen ? 'OPEN' : 'CLOSED'}`);

    if (!isWsOpen && !this.simInterval) {
      console.error('[ARM] FAILED BEFORE PACKET CREATION: WebSocket disconnected');
      this.logDiagnostic('ERROR', '[ARM] Cannot send ARM: WebSocket disconnected', 'error');
      this.addStatusMessage('WARNING', 4, 'WebSocket disconnected');
      return false;
    }

    // Reset prior rejection state on fresh arm attempt
    this.connectionState.preArmFailReason = undefined;
    this.connectionState.lastArmCommandAck = undefined;

    const targetSys = this.connectionState.systemId || 1;
    const targetComp = this.connectionState.componentId || 1;
    const sourceSys = 255;
    const sourceComp = 190;
    const param2 = force ? 21196.0 : 0.0;

    console.log(`[ARM] SYSID = ${targetSys}`);
    console.log(`[ARM] COMPONENT = ${targetComp}`);
    console.log('[ARM] COMMAND = 400');
    console.log('[ARM] PARAM1 = 1');
    console.log(`[ARM] PARAM2 = ${param2}`);
    console.log(`[ARM] SOURCE SYSID = ${sourceSys}`);
    console.log(`[ARM] SOURCE COMP = ${sourceComp}`);
    console.log(`[ARM] TARGET SYSID = ${targetSys}`);
    console.log(`[ARM] TARGET COMP = ${targetComp}`);
    console.log('[ARM] COMMAND SEND COUNT = 1');

    this.isArmCommandInFlight = true;
    this.connectionState.lastArmButtonClickTime = Date.now();
    this.connectionState.lastArmParam1 = 1.0;
    this.connectionState.lastArmParam2 = param2;
    this.connectionState.lastArmWsSendState = 'START';
    this.connectionState.vehicleState = 'ARMING';
    this.telemetry.vehicleState = 'ARMING';
    this.connectionState.lastCommandName = 'ARM';
    this.connectionState.lastSentCommandId = 400;
    this.notifyConnection();
    this.notifyTelemetry();

    this.addStatusMessage('NOTICE', 5, `Sending MAVLink ARM Command (MAV_CMD_COMPONENT_ARM_DISARM param1=1 param2=${param2})...`);
    this.logDiagnostic('MAVLINK', `[ARM TX] Transmitting MAV_CMD_COMPONENT_ARM_DISARM (400) to SysID ${targetSys} CompID ${targetComp}`, 'info');

    try {
      if (this.connectionState.isRealHardware || isWsOpen) {
        const success = await this.sendMavlinkCommandLong(400 /* MAV_CMD_COMPONENT_ARM_DISARM */, 1.0 /* Arm */, param2, 0.0, 0.0, 0.0, 0.0, 0.0);
        return success;
      } else {
        this.telemetry.isArmed = true;
        this.telemetry.vehicleState = 'ARMED';
        this.connectionState.vehicleState = 'ARMED';
        this.connectionState.lastArmPacketState = 'CREATED';
        this.connectionState.lastArmWsSendState = 'COMPLETE';
        this.addStatusMessage('INFO', 6, 'SIMULATOR: Drone Armed (Motors Spinning)');
        this.notifyTelemetry();
        this.notifyConnection();
        return true;
      }
    } finally {
      // Release in-flight lock after brief debounce period
      setTimeout(() => {
        this.isArmCommandInFlight = false;
      }, 500);
    }
  }

  public async sendDisarmCommand(force: boolean = false): Promise<boolean> {
    console.log(`[DISARM] BUTTON CLICKED (force=${force})`);

    const isWsOpen = this.connectionState.isUsbConnected || this.connectionState.isConnected;
    console.log(`[DISARM] WS STATE = ${isWsOpen ? 'OPEN' : 'CLOSED'}`);

    if (!isWsOpen && !this.simInterval) {
      console.error('[DISARM] Cannot send DISARM: WebSocket disconnected');
      this.logDiagnostic('ERROR', 'Cannot send DISARM: WebSocket disconnected', 'error');
      this.addStatusMessage('WARNING', 4, 'WebSocket disconnected');
      return false;
    }

    const targetSys = this.connectionState.systemId || 1;
    const targetComp = this.connectionState.componentId || 1;
    // param2 = 21196.0 forces disarm on ArduPilot even in mid-air (CRASH RISK)
    // param2 = 0.0 safe standard disarm: ArduPilot safely checks if landed before shutting motors
    const param2 = force ? 21196.0 : 0.0;

    console.log(`[DISARM] SYSID = ${targetSys}`);
    console.log(`[DISARM] COMPONENT = ${targetComp}`);
    console.log('[DISARM] COMMAND = 400');
    console.log('[DISARM] PARAM1 = 0');
    console.log(`[DISARM] PARAM2 = ${param2}`);

    this.connectionState.vehicleState = 'DISARMING';
    this.telemetry.vehicleState = 'DISARMING';
    this.connectionState.lastCommandName = 'DISARM';
    this.connectionState.lastSentCommandId = 400;
    this.notifyConnection();
    this.notifyTelemetry();

    this.addStatusMessage('NOTICE', 5, `Sending MAVLink DISARM Command (MAV_CMD_COMPONENT_ARM_DISARM param1=0 param2=${param2})...`);
    this.logDiagnostic('MAVLINK', `[DISARM TX] Transmitting MAV_CMD_COMPONENT_ARM_DISARM (400) to SysID ${targetSys} CompID ${targetComp}`, 'info');

    if (this.connectionState.isRealHardware || isWsOpen) {
      const success = await this.sendMavlinkCommandLong(400 /* MAV_CMD_COMPONENT_ARM_DISARM */, 0.0 /* Disarm */, param2, 0.0, 0.0, 0.0, 0.0, 0.0);
      return success;
    } else {
      this.telemetry.isArmed = false;
      this.telemetry.vehicleState = 'DISARMED';
      this.connectionState.vehicleState = 'DISARMED';
      this.telemetry.flightMode = 'DISARMED';
      this.telemetry.altitude = 0;
      this.addStatusMessage('INFO', 6, 'SIMULATOR: Drone Disarmed');
      this.notifyTelemetry();
      this.notifyConnection();
      return true;
    }
  }

  public async armDrone(force: boolean = false): Promise<boolean> {
    return this.sendArmCommand(force);
  }

  public async disarmDrone(force: boolean = false): Promise<boolean> {
    return this.sendDisarmCommand(force);
  }

  public async sendSetModeMessage(customMode: number): Promise<boolean> {
    try {
      const payload = new Uint8Array(6);
      const view = new DataView(payload.buffer);
      // MAVLink Message #11 SET_MODE:
      // uint32_t custom_mode (offset 0..3, little-endian)
      // uint8_t  target_system (offset 4)
      // uint8_t  base_mode (offset 5) -> MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1
      view.setUint32(0, customMode, true);
      const targetSys = this.connectionState.systemId || 1;
      view.setUint8(4, targetSys);
      view.setUint8(5, 1 /* MAV_MODE_FLAG_CUSTOM_MODE_ENABLED */);

      const packet = this.buildMavlinkFrame(11 /* SET_MODE */, payload);
      const hexDump = Array.from(packet).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      console.log(`[SET_MODE TX] custom_mode=${customMode} target_sys=${targetSys} (Packet: ${packet.length} B: ${hexDump})`);
      this.logDiagnostic('MAVLINK', `[SET_MODE TX] Sending SET_MODE (11) custom_mode=${customMode} to SysID ${targetSys} (${packet.length} bytes)`, 'info');

      const success = await usbHostService.sendBytes(packet);
      if (success) {
        this.connectionState.bytesSent += packet.length;
        this.logDiagnostic('MAVLINK', `[SET_MODE TX] Successfully forwarded ${packet.length} bytes to flight controller`, 'success');
        this.notifyConnection();
      } else {
        console.error(`[SET_MODE TX] Failed to send SET_MODE binary packet through transport bridge`);
      }
      return success;
    } catch (err: any) {
      console.error(`[SET_MODE TX] Error:`, err);
      return false;
    }
  }

  public async setFlightMode(modeName: 'GUIDED' | 'AUTO' | 'STABILIZE' | 'ALT_HOLD' | 'POSHOLD' | 'LOITER' | 'RTL' | 'LAND' | 'CIRCLE'): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', `Cannot set mode ${modeName}: MAVLink not connected`, 'error');
      return false;
    }
    const modeNumbers: Record<string, number> = {
      STABILIZE: 0,
      ACRO: 1,
      ALT_HOLD: 2,
      AUTO: 3,
      GUIDED: 4,
      LOITER: 5,
      RTL: 6,
      CIRCLE: 7, // ArduPilot CIRCLE mode
      LAND: 9,
      POSHOLD: 16
    };
    const customMode = modeNumbers[modeName] ?? 0;
    this.addStatusMessage('NOTICE', 5, `Setting Flight Mode to ${modeName} (Custom Mode: ${customMode})...`);
    this.connectionState.pendingFlightMode = modeName;
    this.connectionState.lastModeChangeError = undefined;
    this.notifyConnection();

    // Helpful diagnostic if switching into position-dependent mode without 3D GPS lock
    const gpsDependentModes = ['LOITER', 'GUIDED', 'AUTO', 'RTL', 'POSHOLD', 'CIRCLE'];
    if (gpsDependentModes.includes(modeName) && (!this.telemetry.gps.isLocked || this.telemetry.gps.satellites < 6)) {
      const gpsWarn = `Notice: ${modeName} requires a 3D GPS Fix (6+ satellites). If bench testing indoors without GPS, switch to STABILIZE or ALT_HOLD.`;
      this.logDiagnostic('MAVLINK', `[MODE] ${gpsWarn}`, 'warn');
      this.addStatusMessage('WARNING', 4, gpsWarn);
    }

    // In simulation / test mock mode, update telemetry immediately (AUD-11)
    if (!this.connectionState.isRealHardware) {
      this.telemetry.flightMode = modeName;
      this.connectionState.pendingFlightMode = undefined;
      this.notifyTelemetry();
      this.notifyConnection();
      return true;
    }

    if (this.connectionState.isRealHardware || isConnected) {
      // 1. Send native MAVLink message #11 (SET_MODE) - Required by ArduPilot Copter
      await this.sendSetModeMessage(customMode);
      // 2. Also send COMMAND_LONG 176 as redundant fallback
      await this.sendMavlinkCommandLong(176, 1 /* MAV_MODE_FLAG_CUSTOM_MODE_ENABLED */, customMode);

      // Await confirmation or rejection from Pixhawk (4000ms allows cellular hotspot latency)
      return new Promise<boolean>((resolve) => {
        if (this.modeChangeTimer) clearTimeout(this.modeChangeTimer);
        this.modeChangeResolver = (res) => {
          this.modeChangeResolver = null;
          if (this.modeChangeTimer) clearTimeout(this.modeChangeTimer);
          resolve(res.success);
        };
        this.modeChangeTimer = setTimeout(() => {
          if (this.modeChangeResolver) {
            this.modeChangeResolver = null;
            const matched = (this.telemetry.flightMode || '').toUpperCase() === modeName;
            this.connectionState.pendingFlightMode = undefined;
            this.notifyConnection();
            resolve(matched);
          }
        }, 4000);
      });
    } else {
      return true;
    }
  }

  public async commandTakeoff(targetAltMeters: number = 10): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', 'Cannot takeoff: MAVLink not connected', 'error');
      return false;
    }
    this.telemetry.targetAltitude = targetAltMeters;
    this.addStatusMessage('NOTICE', 5, `Sending Takeoff Command to ${targetAltMeters}m...`);
    if (this.connectionState.isRealHardware || isConnected) {
      // ArduPilot requires GUIDED flight mode to accept MAV_CMD_NAV_TAKEOFF (22)
      await this.setFlightMode('GUIDED');
      await this.sendMavlinkCommandInt(22 /* MAV_CMD_NAV_TAKEOFF */, 0, 0, 0, 0, 0, 0, targetAltMeters, 6 /* MAV_FRAME_GLOBAL_RELATIVE_ALT_INT */);
      // Small 50ms stagger before COMMAND_LONG to avoid serial buffer collision & duplicate ACK race (AUD-03)
      await new Promise((r) => setTimeout(r, 50));
      await this.sendMavlinkCommandLong(22 /* MAV_CMD_NAV_TAKEOFF */, 0, 0, 0, 0, 0, 0, targetAltMeters);
      this.notifyTelemetry();
      return true;
    } else {
      this.telemetry.isArmed = true;
      this.telemetry.flightMode = 'AUTO';
      this.telemetry.targetAltitude = targetAltMeters;
      this.notifyTelemetry();
      return true;
    }
  }

  /**
   * Autonomous Circular Orbit Navigation:
   * Commands vehicle to orbit a center reference (takeoff/home) at a specified radius and altitude
   * via MAVLink MAV_CMD_DO_ORBIT (425) in GUIDED mode.
   *
   * @param radiusMeters Circle radius (meters). Positive = Clockwise, Negative = Counter-Clockwise.
   * @param velocityMps Tangential speed (m/s, default 2.0).
   * @param centerLat Center latitude (defaults to Home/takeoff lat).
   * @param centerLon Center longitude (defaults to Home/takeoff lon).
   * @param altitudeMeters Cruise altitude for the orbit.
   */
  public async commandOrbit(
    radiusMeters: number,
    velocityMps: number = 2.0,
    centerLat?: number,
    centerLon?: number,
    altitudeMeters?: number
  ): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', 'Cannot command orbit: MAVLink not connected', 'error');
      return false;
    }
    const lat = (centerLat !== undefined && centerLat !== 0) ? centerLat : (this.homePoint.latitude || this.telemetry.latitude);
    const lon = (centerLon !== undefined && centerLon !== 0) ? centerLon : (this.homePoint.longitude || this.telemetry.longitude);
    const alt = altitudeMeters || this.telemetry.altitude || 5.0;

    this.addStatusMessage('NOTICE', 5, `Commanding Autonomous Orbit (Radius: ${radiusMeters}m, Alt: ${alt}m, Speed: ${velocityMps}m/s)...`);
    this.logDiagnostic('MAVLINK', `[CMD 425] MAV_CMD_DO_ORBIT: R=${radiusMeters}m, V=${velocityMps}m/s, Center=${lat.toFixed(6)}, ${lon.toFixed(6)}`, 'info');

    if (this.connectionState.isRealHardware || isConnected) {
      // 1. Ensure GUIDED mode
      await this.setFlightMode('GUIDED');
      // 2. MAV_CMD_DO_ORBIT (425):
      // param1: radius (m, +CW, -CCW)
      // param2: velocity (m/s)
      // param3: yaw behavior (1 = face forward along path)
      // param4: 0
      // param5: lat
      // param6: lon
      // param7: alt
      return await this.sendMavlinkCommandLong(425 /* MAV_CMD_DO_ORBIT */, radiusMeters, velocityMps, 1.0, 0, lat, lon, alt);
    } else {
      this.telemetry.flightMode = 'GUIDED';
      this.notifyTelemetry();
      return true;
    }
  }

  /**
   * Fly straight to coordinate waypoint in GUIDED mode via MAV_CMD_DO_REPOSITION (192)
   */
  public async flyToPosition(lat: number, lon: number, alt: number, groundSpeedMps: number = 2.0): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      return false;
    }
    if (this.connectionState.isRealHardware || isConnected) {
      await this.setFlightMode('GUIDED');
      // 1. Send modern COMMAND_INT (75) with MAV_CMD_DO_REPOSITION (192) - full int32 precision for lat/lon
      const latE7 = Math.round(lat * 1e7);
      const lonE7 = Math.round(lon * 1e7);
      await this.sendMavlinkCommandInt(
        192 /* MAV_CMD_DO_REPOSITION */,
        groundSpeedMps,
        1.0 /* MAV_DO_REPOSITION_FLAGS_CHANGE_MODE */,
        0,
        0,
        latE7,
        lonE7,
        alt,
        6 /* MAV_FRAME_GLOBAL_RELATIVE_ALT_INT */
      );

      // 2. Also send COMMAND_LONG (192) as fallback for older Pixhawk firmwares
      await this.sendMavlinkCommandLong(192 /* MAV_CMD_DO_REPOSITION */, groundSpeedMps, 1.0, 0, 0, lat, lon, alt);
      return true;
    } else {
      return true;
    }
  }

  /**
   * Controlled Mid-Flight Altitude Update:
   * Changes the target cruising altitude safely via MAV_CMD_DO_CHANGE_ALTITUDE (186)
   */
  public async setTargetAltitude(targetAltMeters: number): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    this.telemetry.targetAltitude = targetAltMeters;
    this.addStatusMessage('NOTICE', 5, `Updating Target Altitude to ${targetAltMeters}m...`);

    if (this.connectionState.isRealHardware || isConnected) {
      // MAV_CMD_DO_CHANGE_ALTITUDE (186): param1 = Target altitude, param2 = Frame (0 = global/default)
      await this.sendMavlinkCommandLong(186 /* MAV_CMD_DO_CHANGE_ALTITUDE */, targetAltMeters, 0, 0, 0, 0, 0, 0);
      this.notifyTelemetry();
      return true;
    } else {
      this.notifyTelemetry();
      return true;
    }
  }

  public async commandStartMission(): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', 'Cannot start mission: MAVLink not connected', 'error');
      return false;
    }
    this.addStatusMessage('NOTICE', 5, 'Sending MAVLink MISSION_START Command to Pixhawk FC...');
    if (this.connectionState.isRealHardware || isConnected) {
      await this.setFlightMode('AUTO');
      await this.sendMavlinkCommandLong(300 /* MAV_CMD_MISSION_START */, 0, 0, 0, 0, 0, 0, 0);
      return true;
    } else {
      this.telemetry.flightMode = 'AUTO';
      this.notifyTelemetry();
      return true;
    }
  }

  public async commandStartSearch(): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', 'Cannot start search: MAVLink not connected', 'error');
      return false;
    }
    this.addStatusMessage('NOTICE', 5, 'Starting Autonomous Search Pattern...');
    if (this.connectionState.isRealHardware || isConnected) {
      await this.setFlightMode('AUTO');
      return true;
    } else {
      this.telemetry.flightMode = 'AUTO';
      // Preserve configured target altitude instead of overriding to 25
      this.telemetry.targetAltitude = this.telemetry.targetAltitude || 10;
      this.generateSearchGridWaypoints();
      this.notifyTelemetry();
      return true;
    }
  }

  public async commandRTL(): Promise<boolean> {
    this.addStatusMessage('WARNING', 4, 'Initiating Emergency Return-To-Launch (RTL)...');
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (this.connectionState.isRealHardware || isConnected) {
      await this.setFlightMode('RTL');
      return true;
    } else {
      this.telemetry.flightMode = 'RTL';
      this.telemetry.targetAltitude = 25;
      this.notifyTelemetry();
      return true;
    }
  }

  public async commandLand(): Promise<boolean> {
    this.addStatusMessage('NOTICE', 5, 'Initiating Landing sequence...');
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (this.connectionState.isRealHardware || isConnected) {
      await this.setFlightMode('LAND');
      return true;
    } else {
      this.telemetry.flightMode = 'LAND';
      this.telemetry.targetAltitude = 0;
      this.notifyTelemetry();
      return true;
    }
  }

  public async commandHold(): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', 'Cannot execute Hold: MAVLink not connected', 'error');
      return false;
    }
    this.addStatusMessage('NOTICE', 5, 'Sending Position Hold (LOITER) Command...');
    if (this.connectionState.isRealHardware || isConnected) {
      return await this.setFlightMode('LOITER');
    } else {
      this.telemetry.flightMode = 'LOITER';
      this.notifyTelemetry();
      return true;
    }
  }

  public async commandManualMove(direction: 'FORWARD' | 'BACKWARD' | 'LEFT' | 'RIGHT' | 'HOLD'): Promise<boolean> {
    if (!this.connectionState.isConnected && !this.simInterval) {
      return false;
    }
    if (direction === 'HOLD') {
      return await this.commandHold();
    }
    this.addStatusMessage('INFO', 6, `Manual Directional Control: ${direction}`);
    return true;
  }

  private clearMissionUploadTimers() {
    if (this.missionUploadTimeoutTimer) {
      clearTimeout(this.missionUploadTimeoutTimer);
      this.missionUploadTimeoutTimer = null;
    }
    if (this.missionCountRetryTimer) {
      clearTimeout(this.missionCountRetryTimer);
      clearInterval(this.missionCountRetryTimer);
      this.missionCountRetryTimer = null;
    }
    if (this.missionUploadOverallTimer) {
      clearTimeout(this.missionUploadOverallTimer);
      this.missionUploadOverallTimer = null;
    }
    if (this.missionItemRetryTimer) {
      clearTimeout(this.missionItemRetryTimer);
      this.missionItemRetryTimer = null;
    }
    this.missionTransferActive = false;
  }

  private resetMissionItemWatchdog(timeoutMs: number = 6000) {
    if (this.missionUploadTimeoutTimer) {
      clearTimeout(this.missionUploadTimeoutTimer);
    }
    this.missionUploadTimeoutTimer = setTimeout(() => {
      if (this.missionUploadResolver) {
        this.logDiagnostic('MAVLINK', `[MISSION UPLOAD] Item handshake timeout after ${timeoutMs}ms.`, 'warn');
        const resolve = this.missionUploadResolver;
        this.missionUploadResolver = null;
        resolve({
          success: false,
          message: 'Mission upload timeout: Flight controller stopped requesting items.'
        });
      }
      this.clearMissionUploadTimers();
    }, timeoutMs);
  }

  /**
   * Clear all mission waypoints on Pixhawk flight controller via MAVLink MISSION_CLEAR_ALL (msg #45).
   * Wipes Pixhawk EEPROM mission table and resets internal transfer state machine to prevent sequence desync.
   */
  public async clearMissionWaypoints(): Promise<{ success: boolean; message: string }> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      return { success: false, message: 'MAVLink link not connected' };
    }

    if (this.connectionState.isRealHardware) {
      return new Promise<{ success: boolean; message: string }>((resolve) => {
        let timer: any = null;

        timer = setTimeout(() => {
          this.missionClearResolver = null;
          this.logDiagnostic('MAVLINK', '[MISSION_CLEAR_ALL] Timeout awaiting ACK (proceeding with clean state)', 'info');
          resolve({ success: true, message: 'Clear timeout (proceeding)' });
        }, 1500);

        this.missionClearResolver = (res) => {
          if (timer) clearTimeout(timer);
          resolve(res);
        };

        const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
        const targetSys = this.connectionState.systemId || 1;
        const targetComp = this.connectionState.componentId || 1; // Target autopilot component (MAV_COMP_ID_AUTOPILOT1)

        const payload = new Uint8Array(isMav2 ? 3 : 2);
        payload[0] = targetSys;
        payload[1] = targetComp;
        if (isMav2) {
          payload[2] = 0; // MAV_MISSION_TYPE_MISSION
        }

        const packet = isMav2
          ? this.buildMavlink2Frame(45 /* MISSION_CLEAR_ALL */, payload)
          : this.buildMavlink1Frame(45 /* MISSION_CLEAR_ALL */, payload);

        usbHostService.sendBytes(packet).then(async (ok) => {
          if (ok) {
            this.connectionState.bytesSent += packet.length;
            this.logDiagnostic('MAVLINK', `[MAVLINK] TX MISSION_CLEAR_ALL target=${targetSys}/${targetComp} type=MISSION`, 'info');
          }
        }).catch((err) => {
          console.error('[MISSION_CLEAR_ALL TX Error]', err);
        });
      });
    } else {
      this.logDiagnostic('MAVLINK', '[SIMULATOR] Cleared simulated mission waypoints', 'info');
      return { success: true, message: 'Simulator cleared waypoints' };
    }
  }

  /**
   * Upload autonomous mission waypoints to Pixhawk flight controller via MAVLink mission protocol
   * (MISSION_CLEAR_ALL -> MISSION_COUNT -> MISSION_REQUEST/MISSION_REQUEST_INT -> MISSION_ITEM/MISSION_ITEM_INT -> MISSION_ACK -> READBACK VERIFICATION)
   */
  public async uploadMissionWaypoints(
    items: Array<MavlinkMissionItem>,
    allowRetry: boolean = true,
    onProgress?: (stage: string, current: number, total: number) => void
  ): Promise<{ success: boolean; message: string; upload_id?: string }> {
    // 1. Concurrency guard: Serialize uploads
    if (this.missionUploadResolver !== null) {
      return {
        success: false,
        message: 'A mission upload is already in progress. Please wait for completion.'
      };
    }

    // 2. Mission validation before touching link
    if (!items || items.length === 0) {
      return { success: false, message: 'Cannot upload empty mission (0 items).' };
    }
    if (items.length > 150) {
      return { success: false, message: `Mission item count (${items.length}) exceeds Pixhawk EEPROM safe limit (150 waypoints).` };
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it.lat !== 'number' || isNaN(it.lat) || typeof it.lon !== 'number' || isNaN(it.lon) || typeof it.alt !== 'number' || isNaN(it.alt)) {
        return { success: false, message: `Invalid waypoint at index ${i}: Coordinates or altitude contain NaN or non-finite values.` };
      }
      const isZeroCoordAllowed = it.command === 20 /* MAV_CMD_NAV_RETURN_TO_LAUNCH */ || it.command === 21 /* MAV_CMD_NAV_LAND */;
      if (i > 0 && !isZeroCoordAllowed && Math.abs(it.lat) < 0.001 && Math.abs(it.lon) < 0.001) {
        return { success: false, message: `Invalid waypoint at index ${i}: Latitude and Longitude cannot be (0, 0).` };
      }
      if (it.lat < -90 || it.lat > 90 || it.lon < -180 || it.lon > 180) {
        return { success: false, message: `Invalid waypoint at index ${i}: Latitude (${it.lat}) or Longitude (${it.lon}) out of WGS-84 bounds.` };
      }
    }

    // 3. Confirm live link: Require fresh HEARTBEAT within 4000ms
    const now = Date.now();
    const heartbeatAgeMs = this.connectionState.lastHeartbeat ? (now - this.connectionState.lastHeartbeat) : Infinity;
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;

    if (this.connectionState.isRealHardware && !this.simInterval) {
      if (!isConnected || heartbeatAgeMs > 4000) {
        const ageSec = Number.isFinite(heartbeatAgeMs) ? (heartbeatAgeMs / 1000).toFixed(1) + 's' : 'never received';
        const errMsg = `Cannot upload mission: No fresh MAVLink heartbeat from Pixhawk in last 4s (last RX: ${ageSec} ago). Ensure Pixhawk is powered and TELEM2 baud matches ESP32 (57600).`;
        this.logDiagnostic('ERROR', errMsg, 'error');
        return { success: false, message: errMsg };
      }
    } else if (!isConnected && !this.simInterval) {
      return { success: false, message: 'Cannot upload mission: MAVLink link not connected' };
    }

    const upload_id = `up_${Date.now().toString(36).slice(-4)}`;
    this.currentUploadId = upload_id;
    const startTime = Date.now();

    this.logDiagnostic('MAVLINK', `[MISSION] upload_id=${upload_id} requested items=${items.length}`, 'info');
    this.logDiagnostic(
      'MAVLINK',
      `[MAVLINK] connection=established transport=${this.connectionState.diagnostics.driverType || 'active'} age=${(heartbeatAgeMs / 1000).toFixed(1)}s`,
      'info'
    );

    // Register job with backend (asynchronous notification)
    try {
      fetch('/mission/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id, items })
      }).catch(() => {});
    } catch (e) {}

    this.clearMissionUploadTimers();

    if (this.connectionState.isRealHardware) {
      onProgress?.('Initiating mission upload to Pixhawk...', 0, items.length);
      this.logDiagnostic('MAVLINK', `[MISSION UPLOAD] Initiating upload of ${items.length} waypoints (upload_id=${upload_id})...`, 'info');

      this.pendingMissionItems = items;
      this.lastRequestedSeq = -1;
      this.lastSentSeq = -1;
      this.lastSentTimeMs = 0;
      this.missionTransferActive = false;

      return new Promise<{ success: boolean; message: string; upload_id?: string }>(async (resolve) => {
        this.missionUploadResolver = async (result) => {
          this.clearMissionUploadTimers();
          this.missionUploadResolver = null;

          if (result.success) {
            // 5. Readback verification!
            onProgress?.('Verifying mission readback from Pixhawk...', items.length, items.length);
            this.logDiagnostic('MAVLINK', `[MISSION READBACK] Starting verification readback for ${items.length} items...`, 'info');
            try {
              const readbackTimeout = Math.max(8000, items.length * 600);
              const readback = await this.downloadMissionWaypoints(readbackTimeout);
              if (readback.success) {
                if (readback.items.length !== items.length) {
                  const mismatchErr = `Readback count mismatch: Pixhawk stored ${readback.items.length} items, expected ${items.length}.`;
                  this.logDiagnostic('ERROR', mismatchErr, 'error');
                  resolve({ success: false, message: mismatchErr, upload_id });
                  return;
                }

                // Complete item-by-item verification (AUD-02)
                for (let i = 0; i < items.length; i++) {
                  const sent = items[i];
                  const recv = readback.items[i];
                  if (!recv) {
                    const mismatchErr = `Readback verification error: Item index ${i} missing from flight controller response.`;
                    this.logDiagnostic('ERROR', mismatchErr, 'error');
                    resolve({ success: false, message: mismatchErr, upload_id });
                    return;
                  }

                  // Command verification (Seq 0 may be reported as 16 or 0 by ArduPilot Home)
                  if (i > 0 && sent.command && recv.command && sent.command !== recv.command) {
                    const mismatchErr = `Readback command mismatch at waypoint #${i}: expected ${sent.command}, FC stored ${recv.command}.`;
                    this.logDiagnostic('ERROR', mismatchErr, 'error');
                    resolve({ success: false, message: mismatchErr, upload_id });
                    return;
                  }

                  // Coordinate & altitude verification:
                  // 1. Seq 0: ArduPilot stores the Home position with absolute AMSL altitude (not relative alt). Skip alt check for Seq 0.
                  // 2. RTL (cmd 20): ArduPilot returns to home and may report (0, 0) coordinates.
                  // 3. Navigation waypoints (i > 0 and cmd !== 20): Enforce strict coordinates (< 0.0005 deg) and altitude (< 2.0m).
                  if (i > 0 && sent.command !== 20) {
                    const latDiff = Math.abs(sent.lat - recv.lat);
                    const lonDiff = Math.abs(sent.lon - recv.lon);
                    const altDiff = Math.abs(sent.alt - recv.alt);
                    if (latDiff > 0.0005 || lonDiff > 0.0005 || altDiff > 2.0) {
                      const mismatchErr = `Readback waypoint data mismatch at #${i}: coords (${recv.lat.toFixed(6)}, ${recv.lon.toFixed(6)}, ${recv.alt}m) do not match expected (${sent.lat.toFixed(6)}, ${sent.lon.toFixed(6)}, ${sent.alt}m).`;
                      this.logDiagnostic('ERROR', mismatchErr, 'error');
                      resolve({ success: false, message: mismatchErr, upload_id });
                      return;
                    }
                  }
                }

                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                this.logDiagnostic('MAVLINK', `[MISSION] upload_id=${upload_id} SUCCESS duration=${duration}s (Readback verified)`, 'success');
                onProgress?.('Mission verified and accepted ✓', items.length, items.length);
                resolve({
                  success: true,
                  message: `Mission uploaded and verified by Pixhawk (${items.length} waypoints) ✓`,
                  upload_id
                });
                return;
              } else {
                const failMsg = `Mission upload readback verification failed: ${readback.message}`;
                this.logDiagnostic('ERROR', `[MISSION READBACK] ${failMsg}`, 'error');
                resolve({
                  success: false,
                  message: failMsg,
                  upload_id
                });
                return;
              }
            } catch (rbErr: any) {
              const failMsg = `Mission upload readback verification error: ${rbErr?.message || rbErr}`;
              this.logDiagnostic('ERROR', `[MISSION READBACK] ${failMsg}`, 'error');
              resolve({
                success: false,
                message: failMsg,
                upload_id
              });
              return;
            }
          } else {
            // Automatic retry if transient sequence desync
            if (result.message.includes('INVALID_SEQUENCE') && allowRetry) {
              this.logDiagnostic('MAVLINK', '[MISSION UPLOAD] Received INVALID_SEQUENCE desync; wiping with MISSION_CLEAR_ALL and retrying...', 'warn');
              await this.clearMissionWaypoints();
              await new Promise((r) => setTimeout(r, 400));
              const retryRes = await this.uploadMissionWaypoints(items, false, onProgress);
              resolve(retryRes);
              return;
            }
            this.logDiagnostic('ERROR', `[MISSION] upload_id=${upload_id} FAILED: ${result.message}`, 'error');
            resolve({ success: false, message: result.message, upload_id });
          }
        };

        // Overall safety timeout (scaled by item count)
        const overallTimeout = Math.max(20000, items.length * 1500);
        this.missionUploadOverallTimer = setTimeout(() => {
          if (this.missionUploadResolver) {
            const res = this.missionUploadResolver;
            this.missionUploadResolver = null;
            this.clearMissionUploadTimers();
            const age = ((Date.now() - this.connectionState.lastHeartbeat) / 1000).toFixed(1);
            res({
              success: false,
              message: `Mission upload timeout: Pixhawk did not complete transfer within ${overallTimeout / 1000}s (last RX heartbeat: ${age}s ago).`
            });
          }
        }, overallTimeout);

        const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
        const targetSys = this.connectionState.systemId || 1;
        const targetComp = this.connectionState.componentId || 1; // Target autopilot component (MAV_COMP_ID_AUTOPILOT1)

        let countAttempts = 0;
        const maxCountAttempts = 7;

        const sendCountPacket = async () => {
          if (this.missionTransferActive || !this.missionUploadResolver) {
            return;
          }
          countAttempts++;
          try {
            const payload = new Uint8Array(isMav2 ? 5 : 4);
            const view = new DataView(payload.buffer);
            view.setUint16(0, items.length, true);
            view.setUint8(2, targetSys);
            view.setUint8(3, targetComp);
            if (isMav2) {
              view.setUint8(4, 0 /* MAV_MISSION_TYPE_MISSION */);
            }

            const packet = isMav2
              ? this.buildMavlink2Frame(44 /* MISSION_COUNT */, payload)
              : this.buildMavlink1Frame(44 /* MISSION_COUNT */, payload);

            await usbHostService.sendBytes(packet);
            this.connectionState.bytesSent += packet.length;

            this.logDiagnostic(
              'MAVLINK',
              `[MAVLINK] TX MISSION_COUNT count=${items.length} target=${targetSys}/${targetComp} type=MISSION (Attempt ${countAttempts}/${maxCountAttempts})`,
              'info'
            );
            onProgress?.(`Announcing mission to Pixhawk (attempt ${countAttempts}/${maxCountAttempts})...`, 0, items.length);

            if (countAttempts < maxCountAttempts) {
              this.missionCountRetryTimer = setTimeout(() => {
                if (!this.missionTransferActive && this.missionUploadResolver) {
                  sendCountPacket();
                }
              }, 1200);
            } else {
              // Set watchdog for final attempt
              this.missionUploadTimeoutTimer = setTimeout(() => {
                if (!this.missionTransferActive && this.missionUploadResolver) {
                  const res = this.missionUploadResolver;
                  this.missionUploadResolver = null;
                  this.clearMissionUploadTimers();
                  const age = ((Date.now() - this.connectionState.lastHeartbeat) / 1000).toFixed(1);
                  res({
                    success: false,
                    message: `Upload failed: Pixhawk did not respond to MISSION_COUNT after ${maxCountAttempts} attempts (last RX heartbeat: ${age}s ago). Verify ESP32 TX pin is wired to Pixhawk TELEM1 RX (Pin 3), set BRD_SER1_RTSCTS=0, and disconnect Mission Planner USB.`
                  });
                }
              }, 1800);
            }
          } catch (e: any) {
            console.error('[MISSION_COUNT TX Error]', e);
          }
        };

        // Send first MISSION_COUNT attempt
        await sendCountPacket();
      });
    } else {
      this.pendingMissionItems = items;
      this.logDiagnostic('MAVLINK', `[SIMULATOR] Stored ${items.length} mission waypoints`, 'info');
      onProgress?.('Mission saved to simulator ✓', items.length, items.length);
      return { success: true, message: `Simulator stored ${items.length} mission waypoints`, upload_id };
    }
  }

  public async sendMissionItem(
    seq: number,
    item: MavlinkMissionItem
  ): Promise<boolean> {
    const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
    const payload = new Uint8Array(isMav2 ? 38 : 37);
    const view = new DataView(payload.buffer);

    const cmd = item.command || 16 /* MAV_CMD_NAV_WAYPOINT */;
    const p1 = item.param1 !== undefined ? item.param1 : 0;
    const p2 = item.param2 !== undefined ? item.param2 : (cmd === 16 ? 2.0 : 0);
    const p3 = item.param3 !== undefined ? item.param3 : 0;
    const p4 = item.param4 !== undefined ? item.param4 : 0;

    view.setFloat32(0, p1, true);
    view.setFloat32(4, p2, true);
    view.setFloat32(8, p3, true);
    view.setFloat32(12, p4, true);

    view.setFloat32(16, item.lat, true); // x: latitude in float deg
    view.setFloat32(20, item.lon, true); // y: longitude in float deg
    view.setFloat32(24, item.alt, true); // z: altitude in meters
    view.setUint16(28, seq, true);
    view.setUint16(30, cmd, true);
    view.setUint8(32, this.connectionState.systemId || 1);
    view.setUint8(33, this.connectionState.componentId || 1);

    // Frame: Seq 0 is Home (MAV_FRAME_GLOBAL = 0), waypoints are MAV_FRAME_GLOBAL_RELATIVE_ALT = 3
    let frame = item.frame !== undefined ? item.frame : (seq === 0 ? 0 /* MAV_FRAME_GLOBAL */ : 3 /* MAV_FRAME_GLOBAL_RELATIVE_ALT */);
    if (frame === 6 /* MAV_FRAME_GLOBAL_RELATIVE_ALT_INT */) {
      frame = 3 /* MAV_FRAME_GLOBAL_RELATIVE_ALT */;
    } else if (frame === 5 /* MAV_FRAME_GLOBAL_INT */) {
      frame = 0 /* MAV_FRAME_GLOBAL */;
    }
    view.setUint8(34, frame);
    view.setUint8(35, item.current || 0 /* current: 0 during upload */);
    view.setUint8(36, item.autocontinue !== undefined ? item.autocontinue : 1);
    if (isMav2) {
      view.setUint8(37, item.mission_type || 0 /* mission_type: MAV_MISSION_TYPE_MISSION */);
    }

    const packet = isMav2
      ? this.buildMavlink2Frame(39 /* MISSION_ITEM */, payload)
      : this.buildMavlink1Frame(39 /* MISSION_ITEM */, payload);

    const success = await usbHostService.sendBytes(packet);
    if (success) {
      this.connectionState.bytesSent += packet.length;
      this.logDiagnostic(
        'MAVLINK',
        `[MAVLINK] TX MISSION_ITEM seq=${seq} cmd=${cmd} frame=${frame} lat=${item.lat.toFixed(6)} lon=${item.lon.toFixed(6)} alt=${item.alt}m p1=${p1} p3=${p3}`,
        'info'
      );
    }
    return success;
  }

  public async sendMissionItemInt(
    seq: number,
    item: MavlinkMissionItem
  ): Promise<boolean> {
    const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
    const payload = new Uint8Array(isMav2 ? 38 : 37);
    const view = new DataView(payload.buffer);

    const cmd = item.command || 16 /* MAV_CMD_NAV_WAYPOINT */;
    const p1 = item.param1 !== undefined ? item.param1 : 0;
    const p2 = item.param2 !== undefined ? item.param2 : (cmd === 16 ? 2.0 : 0);
    const p3 = item.param3 !== undefined ? item.param3 : 0;
    const p4 = item.param4 !== undefined ? item.param4 : 0;

    view.setFloat32(0, p1, true);
    view.setFloat32(4, p2, true);
    view.setFloat32(8, p3, true);
    view.setFloat32(12, p4, true);

    view.setInt32(16, Math.round(item.lat * 1e7), true);
    view.setInt32(20, Math.round(item.lon * 1e7), true);
    view.setFloat32(24, item.alt, true);
    view.setUint16(28, seq, true);
    view.setUint16(30, cmd, true);
    view.setUint8(32, this.connectionState.systemId || 1);
    view.setUint8(33, this.connectionState.componentId || 1);

    // Frame: Seq 0 is Home (MAV_FRAME_GLOBAL = 0), waypoints are MAV_FRAME_GLOBAL_RELATIVE_ALT_INT = 6
    let frame = item.frame !== undefined ? item.frame : (seq === 0 ? 0 /* MAV_FRAME_GLOBAL */ : 6 /* MAV_FRAME_GLOBAL_RELATIVE_ALT_INT */);
    if (frame === 3 /* MAV_FRAME_GLOBAL_RELATIVE_ALT */) {
      frame = 6 /* MAV_FRAME_GLOBAL_RELATIVE_ALT_INT */;
    }
    view.setUint8(34, frame);
    view.setUint8(35, item.current || 0);
    view.setUint8(36, item.autocontinue !== undefined ? item.autocontinue : 1);
    if (isMav2) {
      view.setUint8(37, item.mission_type || 0 /* mission_type: MAV_MISSION_TYPE_MISSION */);
    }

    const packet = isMav2
      ? this.buildMavlink2Frame(73 /* MISSION_ITEM_INT */, payload)
      : this.buildMavlink1Frame(73 /* MISSION_ITEM_INT */, payload);

    const success = await usbHostService.sendBytes(packet);
    if (success) {
      this.connectionState.bytesSent += packet.length;
      this.logDiagnostic(
        'MAVLINK',
        `[MAVLINK] TX MISSION_ITEM_INT seq=${seq} cmd=${cmd} frame=${frame} lat=${item.lat.toFixed(6)} lon=${item.lon.toFixed(6)} alt=${item.alt}m p1=${p1} p3=${p3}`,
        'info'
      );
    }
    return success;
  }

  /**
   * Download and readback all mission waypoints from Pixhawk to verify upload integrity.
   */
  public async downloadMissionWaypoints(timeoutMs: number = 6000): Promise<{ success: boolean; items: MavlinkMissionItem[]; message: string }> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      return { success: false, items: [], message: 'MAVLink link not connected' };
    }

    if (this.simInterval) {
      return { success: true, items: this.pendingMissionItems || [], message: 'Simulator mission items returned' };
    }

    return new Promise<{ success: boolean; items: MavlinkMissionItem[]; message: string }>((resolve) => {
      this.downloadedMissionItems = [];
      this.expectedDownloadCount = 0;
      if (this.downloadItemRetryTimer) {
        clearTimeout(this.downloadItemRetryTimer);
        this.downloadItemRetryTimer = null;
      }

      let reqListRetry: any = null;
      const sendReqList = () => {
        if (this.expectedDownloadCount === 0 && this.missionDownloadResolver) {
          this.sendMissionRequestList();
          reqListRetry = setTimeout(sendReqList, 800);
        }
      };

      const timer = setTimeout(() => {
        if (reqListRetry) clearTimeout(reqListRetry);
        if (this.downloadItemRetryTimer) {
          clearTimeout(this.downloadItemRetryTimer);
          this.downloadItemRetryTimer = null;
        }
        this.missionDownloadResolver = null;
        resolve({
          success: false,
          items: this.downloadedMissionItems,
          message: `Readback download timeout (${timeoutMs / 1000}s)`
        });
      }, timeoutMs);

      this.missionDownloadResolver = (res) => {
        if (reqListRetry) clearTimeout(reqListRetry);
        if (this.downloadItemRetryTimer) {
          clearTimeout(this.downloadItemRetryTimer);
          this.downloadItemRetryTimer = null;
        }
        clearTimeout(timer);
        resolve(res);
      };

      sendReqList();
    });
  }

  public requestDownloadItem(seq: number) {
    if (this.downloadItemRetryTimer) {
      clearTimeout(this.downloadItemRetryTimer);
      this.downloadItemRetryTimer = null;
    }
    this.sendMissionRequestInt(seq);
    this.downloadItemRetryTimer = setTimeout(() => {
      if (this.missionDownloadResolver && this.downloadedMissionItems.length === seq) {
        this.logDiagnostic('MAVLINK', `[MISSION READBACK] Retrying request for seq #${seq}...`, 'info');
        this.requestDownloadItem(seq);
      }
    }, 600);
  }

  public async sendMissionRequestList(): Promise<boolean> {
    const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
    const targetSys = this.connectionState.systemId || 1;
    const targetComp = this.connectionState.componentId || 1;
    const payload = new Uint8Array(isMav2 ? 3 : 2);
    payload[0] = targetSys;
    payload[1] = targetComp;
    if (isMav2) {
      payload[2] = 0; // MAV_MISSION_TYPE_MISSION
    }
    const packet = isMav2
      ? this.buildMavlink2Frame(43 /* MISSION_REQUEST_LIST */, payload)
      : this.buildMavlink1Frame(43 /* MISSION_REQUEST_LIST */, payload);

    this.logDiagnostic('MAVLINK', `[MAVLINK] TX MISSION_REQUEST_LIST target=${targetSys}/${targetComp} type=MISSION`, 'info');
    const success = await usbHostService.sendBytes(packet);
    if (success) {
      this.connectionState.bytesSent += packet.length;
    }
    return success;
  }

  public async sendMissionRequestInt(seq: number): Promise<boolean> {
    const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
    const targetSys = this.connectionState.systemId || 1;
    const targetComp = this.connectionState.componentId || 1;
    const payload = new Uint8Array(isMav2 ? 5 : 4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, seq, true);
    view.setUint8(2, targetSys);
    view.setUint8(3, targetComp);
    if (isMav2) {
      view.setUint8(4, 0 /* MAV_MISSION_TYPE_MISSION */);
    }
    const packet = isMav2
      ? this.buildMavlink2Frame(51 /* MISSION_REQUEST_INT */, payload)
      : this.buildMavlink1Frame(51 /* MISSION_REQUEST_INT */, payload);

    this.logDiagnostic('MAVLINK', `[MAVLINK] TX MISSION_REQUEST_INT seq=${seq} target=${targetSys}/${targetComp}`, 'info');
    const success = await usbHostService.sendBytes(packet);
    if (success) {
      this.connectionState.bytesSent += packet.length;
    }
    return success;
  }

  public async sendMissionAck(result: number = 0): Promise<boolean> {
    const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
    const targetSys = this.connectionState.systemId || 1;
    const targetComp = this.connectionState.componentId || 1;
    const payload = new Uint8Array(isMav2 ? 4 : 3);
    payload[0] = targetSys;
    payload[1] = targetComp;
    payload[2] = result;
    if (isMav2) {
      payload[3] = 0; // MAV_MISSION_TYPE_MISSION
    }
    const packet = isMav2
      ? this.buildMavlink2Frame(47 /* MISSION_ACK */, payload)
      : this.buildMavlink1Frame(47 /* MISSION_ACK */, payload);

    this.logDiagnostic('MAVLINK', `[MAVLINK] TX MISSION_ACK result=${result === 0 ? 'ACCEPTED(0)' : result}`, 'info');
    const success = await usbHostService.sendBytes(packet);
    if (success) {
      this.connectionState.bytesSent += packet.length;
    }
    return success;
  }

  public async sendMavlinkCommandInt(
    command: number,
    param1: number = 0,
    param2: number = 0,
    param3: number = 0,
    param4: number = 0,
    x: number = 0,
    y: number = 0,
    z: number = 0,
    frame: number = 6
  ): Promise<boolean> {
    try {
      const isMav2 = this.connectionState.mavlinkVersion === 'MAVLink 2.0';
      const payload = new Uint8Array(35);
      const view = new DataView(payload.buffer);
      view.setFloat32(0, param1, true);
      view.setFloat32(4, param2, true);
      view.setFloat32(8, param3, true);
      view.setFloat32(12, param4, true);
      view.setInt32(16, Math.round(x), true);
      view.setInt32(20, Math.round(y), true);
      view.setFloat32(24, z, true);
      view.setUint16(28, command, true);
      const targetSys = this.connectionState.systemId || 1;
      const targetComp = this.connectionState.componentId || 1;
      view.setUint8(30, targetSys);
      view.setUint8(31, targetComp);
      view.setUint8(32, frame);
      view.setUint8(33, 0);
      view.setUint8(34, 0);

      const packet = isMav2
        ? this.buildMavlink2Frame(75 /* COMMAND_INT */, payload)
        : this.buildMavlink1Frame(75 /* COMMAND_INT */, payload);

      const success = await usbHostService.sendBytes(packet);
      if (success) {
        this.connectionState.bytesSent += packet.length;
      }
      return success;
    } catch {
      return false;
    }
  }

  private async sendMavlinkCommandLong(
    command: number,
    param1: number = 0,
    param2: number = 0,
    param3: number = 0,
    param4: number = 0,
    param5: number = 0,
    param6: number = 0,
    param7: number = 0
  ): Promise<boolean> {
    const payload = new Uint8Array(33);
    const view = new DataView(payload.buffer);
    view.setFloat32(0, param1, true);
    view.setFloat32(4, param2, true);
    view.setFloat32(8, param3, true);
    view.setFloat32(12, param4, true);
    view.setFloat32(16, param5, true);
    view.setFloat32(20, param6, true);
    view.setFloat32(24, param7, true);
    view.setUint16(28, command, true);
    const targetSys = this.connectionState.systemId || 1;
    const targetComp = this.connectionState.componentId || 1;
    view.setUint8(30, targetSys);
    view.setUint8(31, targetComp);
    view.setUint8(32, 0);

    this.connectionState.lastSentCommandId = command;

    const packet = this.buildMavlinkFrame(76 /* COMMAND_LONG */, payload);
    const hexDump = Array.from(packet).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    const prefix = command === 400 ? (param1 === 1.0 ? '[ARM]' : '[DISARM]') : `[CMD_${command}]`;

    if (command === 400 && param1 === 1.0) {
      this.connectionState.lastArmPacketState = 'CREATED';
      this.connectionState.lastArmPacketLength = packet.length;
      this.connectionState.lastArmPacketHex = hexDump;
      this.connectionState.lastArmWsSendState = 'START';

      console.log('[ARM] PACKET CREATED');
      console.log(`[ARM] PACKET LENGTH = ${packet.length}`);
      console.log(`[ARM] PACKET HEX = ${hexDump}`);
      console.log('[ARM] WS SEND START');
    }

    this.logDiagnostic('MAVLINK', `[COMMAND_LONG TX] Sending cmd ${command} (p1=${param1}, p2=${param2}) to SysID ${targetSys} CompID ${targetComp} (${packet.length} bytes)`, 'info');

    const success = await usbHostService.sendBytes(packet);
    if (success) {
      if (command === 400 && param1 === 1.0) {
        this.connectionState.lastArmWsSendState = 'COMPLETE';
        console.log('[ARM] WS SEND COMPLETE');
      } else if (command === 400 && param1 === 0.0) {
        console.log('[DISARM] WS SEND COMPLETE');
      }
      this.connectionState.bytesSent += packet.length;
      this.logDiagnostic('MAVLINK', `[COMMAND_LONG TX] Successfully forwarded ${packet.length} bytes to transport bridge (Total TX: ${this.connectionState.bytesSent} B)`, 'success');
      this.notifyConnection();
    } else {
      if (command === 400 && param1 === 1.0) {
        this.connectionState.lastArmWsSendState = 'FAILED';
        console.error(`[ARM] WS SEND ERROR: Failed to send binary packet through transport bridge (${packet.length} bytes)`);
      } else {
        console.error(`${prefix} Failed to send binary packet through transport bridge (${packet.length} bytes)`);
      }
      this.logDiagnostic('ERROR', `${prefix} Failed to send ${packet.length} bytes to transport`, 'error');
    }
    return success;
  }

  private buildMavlink1Frame(msgId: number, payload: Uint8Array): Uint8Array {
    this.sendSeq = (this.sendSeq + 1) % 256;
    const len = payload.length;
    const frame = new Uint8Array(6 + len + 2);
    frame[0] = 0xFE;
    frame[1] = len;
    frame[2] = this.sendSeq;
    frame[3] = 255;
    frame[4] = 190;
    frame[5] = msgId;

    frame.set(payload, 6);

    const crc = this.calculateMavlinkCrc(frame.subarray(1, 6 + len), msgId);
    frame[6 + len] = crc & 0xFF;
    frame[6 + len + 1] = (crc >> 8) & 0xFF;

    return frame;
  }

  private buildMavlink2Frame(msgId: number, payload: Uint8Array): Uint8Array {
    this.sendSeq = (this.sendSeq + 1) % 256;
    const len = payload.length;
    const frame = new Uint8Array(10 + len + 2);
    frame[0] = 0xFD; // MAVLink 2.0 Magic
    frame[1] = len;  // Payload length
    frame[2] = 0;    // Incompatibility flags
    frame[3] = 0;    // Compatibility flags
    frame[4] = this.sendSeq;
    frame[5] = 255;  // GCS System ID
    frame[6] = 190;  // GCS Component ID (Mission Planner GCS)
    frame[7] = msgId & 0xFF;
    frame[8] = (msgId >> 8) & 0xFF;
    frame[9] = (msgId >> 16) & 0xFF;

    frame.set(payload, 10);

    const crc = this.calculateMavlinkCrc(frame.subarray(1, 10 + len), msgId);
    frame[10 + len] = crc & 0xFF;
    frame[10 + len + 1] = (crc >> 8) & 0xFF;

    return frame;
  }

  private buildMavlinkFrame(msgId: number, payload: Uint8Array): Uint8Array {
    if (this.connectionState.mavlinkVersion === 'MAVLink 2.0') {
      return this.buildMavlink2Frame(msgId, payload);
    }
    return this.buildMavlink1Frame(msgId, payload);
  }

  private calculateMavlinkCrc(buffer: Uint8Array, msgId: number): number {
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

  /**
   * Lock rescue target in GCS state with rescue coordinates (lat, lon, alt)
   */
  public lockRescueTarget(code: string, lat?: number, lon?: number, alt?: number): RescueTarget | null {
    const trimmed = (code || '').trim();
    const QR_REGEX = /^\d{2}$/;
    if (!QR_REGEX.test(trimmed)) {
      const warnMsg = `Invalid rescue code: "${code}". Must match 2-digit format (^\d{2}$).`;
      this.logDiagnostic("SYSTEM", `[RESCUE TARGET] ${warnMsg}`, "warn");
      this.addStatusMessage("WARNING", 4, warnMsg);
      return null;
    }

    // Capture GPS coordinates from GLOBAL_POSITION_INT / telemetry
    let targetLat = lat !== undefined && Math.abs(lat) > 0.001 ? lat : this.telemetry.latitude;
    let targetLon = lon !== undefined && Math.abs(lon) > 0.001 ? lon : this.telemetry.longitude;
    let targetAlt = alt !== undefined ? alt : this.telemetry.altitude;

    // Fallback to GPS_RAW_INT / raw GPS telemetry if GLOBAL_POSITION_INT is zero
    if (Math.abs(targetLat) <= 0.001 || Math.abs(targetLon) <= 0.001) {
      if (Math.abs(this.telemetry.gps.latitude) > 0.001 && Math.abs(this.telemetry.gps.longitude) > 0.001) {
        targetLat = this.telemetry.gps.latitude;
        targetLon = this.telemetry.gps.longitude;
        if (targetAlt <= 0) targetAlt = this.telemetry.gps.altitude;
      } else if (Math.abs(this.gps2Data.lat) > 0.001 && Math.abs(this.gps2Data.lon) > 0.001) {
        targetLat = this.gps2Data.lat;
        targetLon = this.gps2Data.lon;
        if (targetAlt <= 0) targetAlt = this.gps2Data.alt;
      } else if (Math.abs(this.gps1Data.lat) > 0.001 && Math.abs(this.gps1Data.lon) > 0.001) {
        targetLat = this.gps1Data.lat;
        targetLon = this.gps1Data.lon;
        if (targetAlt <= 0) targetAlt = this.gps1Data.alt;
      }
    }

    const rescueTarget: RescueTarget = {
      code: trimmed,
      lat: targetLat,
      lon: targetLon,
      alt: targetAlt,
      lockedAt: Date.now()
    };

    this.rescueTarget = rescueTarget;
    this.connectionState.rescueTarget = rescueTarget;
    this.connectionState.latestValidatedQr = trimmed;

    const hasValidCoords = Math.abs(targetLat) > 0.001 && Math.abs(targetLon) > 0.001;
    const coordStr = hasValidCoords
      ? `Lat: ${targetLat.toFixed(7)}, Lon: ${targetLon.toFixed(7)}, Alt: ${targetAlt.toFixed(1)}m`
      : `(GPS pending / no fix)`;

    this.logDiagnostic(
      "MAVLINK",
      `[RESCUE TARGET LOCKED] Code: [${trimmed}] at ${coordStr} ✓`,
      "success"
    );
    this.addStatusMessage("NOTICE", 5, `Rescue Target Locked: [${trimmed}] at ${coordStr}`);

    // Trigger audio & haptic notification
    audioService.playQrDetected();
    audioService.triggerHaptic("success");

    // Notify registered rescue target listeners
    this.rescueTargetListeners.forEach((fn) => {
      try {
        fn(trimmed, rescueTarget);
      } catch (e) {
        console.error("[MAVLINK] Error in rescueTargetListener:", e);
      }
    });

    this.notifyConnection();
    this.notifyTelemetry();
    return rescueTarget;
  }

  public getRescueTarget(): RescueTarget | null {
    return this.rescueTarget || this.connectionState.rescueTarget || null;
  }

  /** QR Code Validator: Validate intercepted QR payloads against regex ^\d{2}$ and trigger rescue target locking */
  public validateAndProcessQrPayload(rawPayload: string): { isValid: boolean; code?: string; error?: string } {
    const trimmed = (rawPayload || "").trim();
    let code = "";
    if (/^\d{2}$/.test(trimmed)) {
      code = trimmed;
    } else {
      const match = trimmed.match(/QR_CODE:(\d{2})/i) ||
                    trimmed.match(/(?:QR(?:_CODE)?|TARGET|RESCUE)[_:\s=]+(\d{2})\b/i) ||
                    trimmed.match(/\b(\d{2})\b/);
      if (match && match[1]) {
        code = match[1];
      }
    }

    if (code && /^\d{2}$/.test(code)) {
      this.lockRescueTarget(code);
      return { isValid: true, code };
    } else {
      const warnMsg = `Invalid QR code payload intercepted: "${rawPayload}". Does not match 2-digit format (^\d{2}$).`;
      this.logDiagnostic("SYSTEM", `[QR VALIDATOR] ${warnMsg}`, "warn");
      this.addStatusMessage("WARNING", 4, warnMsg);
      return { isValid: false, error: warnMsg };
    }
  }

  public subscribeRescueTarget(fn: (code: string, target?: RescueTarget) => void): () => void {
    this.rescueTargetListeners.add(fn);
    if (this.connectionState.latestValidatedQr) {
      fn(this.connectionState.latestValidatedQr, this.rescueTarget || undefined);
    }
    return () => this.rescueTargetListeners.delete(fn);
  }

  /**
   * One-click autonomous trigger: Command LOITER at locked rescue target
   */
  public async triggerAutonomousLoiter(): Promise<boolean> {
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (!isConnected && !this.simInterval) {
      this.logDiagnostic('ERROR', 'Cannot trigger Autonomous Loiter: MAVLink not connected', 'error');
      return false;
    }

    const target = this.rescueTarget || this.connectionState.rescueTarget;
    const hasValidCoords = Boolean(target && target.lat && target.lon && Math.abs(target.lat) > 0.001 && Math.abs(target.lon) > 0.001);

    const coordDesc = (hasValidCoords && target) ? ` at (${target.lat.toFixed(5)}, ${target.lon.toFixed(5)})` : '';
    this.logDiagnostic(
      'MAVLINK',
      `[AUTONOMOUS LOITER] Triggering Loiter hold${target ? ` for rescue target [${target.code}]` : ''}${coordDesc}...`,
      'info'
    );
    this.addStatusMessage(
      'NOTICE',
      5,
      `Autonomous Loiter triggered${target ? ` for target [${target.code}]` : ''}`
    );

    // If airborne and target has valid coordinates, reposition over the target coordinates
    if (hasValidCoords && target && this.telemetry.altitude >= 1.0) {
      const alt = target.alt > 1.0 ? target.alt : Math.max(this.telemetry.altitude, 5.0);
      try {
        await this.flyToPosition(target.lat, target.lon, alt, 2.0);
      } catch (err) {
        console.warn('[AUTONOMOUS LOITER] flyToPosition reposition failed, falling back to mode LOITER:', err);
      }
    }

    const success = await this.setFlightMode('LOITER');
    if (success) {
      audioService.playTargetLock();
      audioService.triggerHaptic('success');
    }
    return success;
  }

  /**
   * One-click autonomous trigger: Log payload drop command, trigger audio buzzer & haptics, and send servo trigger
   */
  public async triggerPayloadDrop(): Promise<boolean> {
    const target = this.rescueTarget || this.connectionState.rescueTarget;
    const targetStr = target ? ` Target [${target.code}] @ (${target.lat.toFixed(5)}, ${target.lon.toFixed(5)}, ${target.alt.toFixed(1)}m)` : '';

    this.logDiagnostic(
      'SYSTEM',
      `[PAYLOAD DROP] Autonomous payload release command triggered.${targetStr} ✓`,
      'success'
    );
    this.addStatusMessage(
      'NOTICE',
      5,
      `Payload Drop Command Executed!${target ? ` Target: [${target.code}]` : ''}`
    );

    // Trigger audio buzzer and haptic feedback
    audioService.playBeep(1200, 300, 'square');
    setTimeout(() => audioService.playBeep(1600, 350, 'square'), 320);
    audioService.triggerHaptic('heavy');

    // Send MAVLink command to activate payload release servo / gripper (MAV_CMD_DO_SET_SERVO / Pixhawk AUX1)
    const isConnected = this.connectionState.isConnected || this.connectionState.isUsbConnected;
    if (isConnected) {
      try {
        // MAV_CMD_DO_SET_SERVO = 183: param1 = servo 9 (AUX1), param2 = 2000 pwm
        await this.sendMavlinkCommandLong(183 /* MAV_CMD_DO_SET_SERVO */, 9, 2000, 0, 0, 0, 0, 0);
      } catch (e) {
        console.warn('[PAYLOAD DROP] MAVLink servo command error:', e);
      }
    }

    return true;
  }

  /**
   * Handle incoming ESP32 live diagnostics frame (TELEM2 GPIO 18 RX byte monitor)
   */
  private handleEsp32Diag(diag: Esp32DiagData) {
    this.connectionState.esp32Diag = diag;
    if (diag.uartRxBytes !== undefined) {
      this.connectionState.esp32UartRxBytes = diag.uartRxBytes;
      this.connectionState.diagnostics.serialDataReceived = diag.uartRxBytes > 0;
    }
    if (diag.freeHeap !== undefined) {
      this.connectionState.esp32FreeHeap = diag.freeHeap;
    }
    if (diag.rssi !== undefined) {
      this.connectionState.esp32Rssi = diag.rssi;
    }
    if (diag.baud !== undefined) {
      this.connectionState.esp32Baud = diag.baud;
    }

    if (diag.uartRxBytes === 0) {
      const msg = "ESP32 Online, but 0 bytes on GPIO 18 RX — Check Pixhawk TELEM2 Pin 2/3 wiring";
      this.connectionState.phaseMessage = msg;
      this.connectionState.errorMessage = msg;
      this.logDiagnostic("TRANSPORT", msg, "warn");
    }

    this.notifyConnection();
  }

  public subscribeEsp32Diag(listener: (diag: Esp32DiagData) => void): () => void {
    return transportManager.getEsp32Transport().subscribeEsp32Diag(listener);
  }

  public getEsp32Diag(): Esp32DiagData | null {
    return transportManager.getEsp32Transport().getEsp32Diag();
  }
  public switchToSimulationMode() {
    this.disconnect();
    this.connectionState.connectionType = 'SIMULATED';
    this.connectionState.phase = 'PIXHAWK_CONNECTED';
    this.connectionState.phaseMessage = 'Bench Simulator Mode Active (SITL)';
    this.connectionState.isConnected = true;
    this.connectionState.isUsbConnected = true;
    this.connectionState.isReceivingTelemetry = true;
    this.connectionState.isRealHardware = false;
    this.connectionState.portOrAddress = 'Software-in-the-Loop (SITL Simulator)';
    this.telemetry.pixhawkConnected = true;
    this.telemetry.gps.isLocked = true;
    this.telemetry.gps.satellites = 14;
    this.telemetry.gps.hdop = 0.8;
    this.telemetry.gps.fixType = '3D_FIX';
    this.telemetry.batteryVoltage = 12.6; // 3S LiPo fully charged
    this.telemetry.batteryPercent = 100;
    this.telemetry.batteryCellCount = 3;

    this.startSimulationTelemetryLoop();
    this.logDiagnostic('SYSTEM', 'Switched to Benchmark Software-in-the-Loop Simulator mode', 'info');
    this.addStatusMessage('INFO', 6, 'Benchmark SITL Simulator Mode Active');
    this.notifyConnection();
    this.notifyTelemetry();
  }

  private startSimulationTelemetryLoop() {
    if (this.simInterval) clearInterval(this.simInterval);
    this.simInterval = setInterval(() => {
      if (this.connectionState.connectionType !== 'SIMULATED') return;
      const now = Date.now();
      this.connectionState.lastHeartbeat = now;
      this.connectionState.heartbeatHz = 2.0;

      if (this.telemetry.isArmed && this.telemetry.flightMode === 'AUTO') {
        const targetAlt = this.telemetry.targetAltitude || 10;
        const diff = +(targetAlt - this.telemetry.altitude).toFixed(1);
        if (diff > 0.2) {
          // Climbing automatically
          this.telemetry.altitude = +(this.telemetry.altitude + 0.5).toFixed(1);
          this.telemetry.verticalSpeed = 1.5;
        } else if (diff < -0.2) {
          // Descending in controlled manner
          this.telemetry.altitude = +(this.telemetry.altitude - 0.4).toFixed(1);
          this.telemetry.verticalSpeed = -1.2;
        } else {
          // Altitude reached and held
          this.telemetry.altitude = targetAlt;
          this.telemetry.verticalSpeed = 0.0;
          this.telemetry.groundSpeed = 6.2;
          this.searchProgressCount = Math.min(100, this.searchProgressCount + 1);
          this.telemetry.searchProgress = this.searchProgressCount;
        }
      } else if (this.telemetry.flightMode === 'RTL' || this.telemetry.flightMode === 'LAND') {
        if (this.telemetry.altitude > 0.2) {
          this.telemetry.altitude = +(this.telemetry.altitude - 0.4).toFixed(1);
          this.telemetry.verticalSpeed = -1.2;
        } else {
          this.telemetry.altitude = 0.0;
          this.telemetry.verticalSpeed = 0.0;
          this.telemetry.groundSpeed = 0.0;
          this.telemetry.isArmed = false;
          this.telemetry.flightMode = 'DISARMED';
        }
      }
      this.notifyTelemetry();
    }, 500);
  }

  private generateSearchGridWaypoints() {
    const baseLat = this.homePoint.isSet ? this.homePoint.latitude : 12.9715987;
    const baseLon = this.homePoint.isSet ? this.homePoint.longitude : 77.5945627;
    this.simWaypoints = [
      { lat: baseLat + 0.0002, lon: baseLon + 0.0002, alt: 20 },
      { lat: baseLat + 0.0004, lon: baseLon + 0.0002, alt: 20 },
      { lat: baseLat + 0.0004, lon: baseLon - 0.0002, alt: 20 },
      { lat: baseLat + 0.0002, lon: baseLon - 0.0002, alt: 20 }
    ];
    this.currentWpIndex = 0;
  }

  private calculateLiPoPercentage(voltage: number, cellCount?: number): number {
    let cells = cellCount;
    if (!cells || cells <= 0) {
      if (voltage > 20.0) cells = 6;
      else if (voltage > 13.2) cells = 4;
      else cells = 3; // Default 3S LiPo for this drone
    }

    const cellVolt = voltage / cells;

    // Standard calibrated non-linear LiPo discharge curve per cell:
    // 4.20V: 100%
    // 4.05V: 90%
    // 3.90V: 70%
    // 3.82V: 50% (nominal storage)
    // 3.75V: 25%
    // 3.70V: 15% (low battery warning threshold)
    // 3.50V: 5% (critical failsafe threshold)
    // 3.30V: 0% (empty / cut-off)
    if (cellVolt >= 4.20) return 100;
    if (cellVolt <= 3.30) return 0;

    if (cellVolt >= 4.05) {
      return Math.round(90 + ((cellVolt - 4.05) / 0.15) * 10);
    } else if (cellVolt >= 3.82) {
      return Math.round(50 + ((cellVolt - 3.82) / 0.23) * 40);
    } else if (cellVolt >= 3.70) {
      return Math.round(15 + ((cellVolt - 3.70) / 0.12) * 35);
    } else if (cellVolt >= 3.50) {
      return Math.round(5 + ((cellVolt - 3.50) / 0.20) * 10);
    } else {
      return Math.round(((cellVolt - 3.30) / 0.20) * 5);
    }
  }

  private emitPacket(msgName: MAVLinkPacket['msgName'], payload: Record<string, any>) {
    const packet: MAVLinkPacket = {
      seq: this.sendSeq,
      sysId: this.connectionState.systemId || 1,
      compId: this.connectionState.componentId || 1,
      msgId: 0,
      msgName,
      payload,
      timestamp: Date.now()
    };
    this.packetListeners.forEach((fn) => fn(packet));
  }

  private notifyTelemetry() {
    const data = this.getTelemetry();
    this.listeners.forEach((fn) => fn(data));
  }

  private notifyConnection() {
    const state = this.getConnectionState();
    this.connectionListeners.forEach((fn) => fn(state));
  }
}

export const mavlinkService = new MAVLinkService();
