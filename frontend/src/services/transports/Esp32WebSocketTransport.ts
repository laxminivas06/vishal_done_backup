import { MavlinkTransport, TransportStateEvent, TransportType } from '../../types/transport';
import { Esp32DiagData } from '../../types/mavlink';

export type { Esp32DiagData };

export type WebSocketConnectionMode = 'LOCAL' | 'SECURE';
export type WebSocketProtocolMode = 'AUTO' | 'WS' | 'WSS';
export type Esp32LinkState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR';
export type Esp32ErrorCategory =
  | 'NONE'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'HANDSHAKE_FAILURE'
  | 'WSS_TLS_FAILURE'
  | 'MIXED_CONTENT_BLOCK'
  | 'INVALID_ENDPOINT'
  | 'ESP32_UNAVAILABLE'
  | 'RELAY_UNAVAILABLE'
  | 'CONNECTOR_OFFLINE'
  | 'HEARTBEAT_TIMEOUT'
  | 'SERVER_UNAVAILABLE';

export interface Esp32WebSocketOptions {
  protocolMode?: WebSocketProtocolMode;
  mode?: WebSocketConnectionMode;
  host?: string;
  port?: number;
  path?: string;
  secureEndpoint?: string;
  relayToken?: string;
  protocol?: 'ws' | 'wss';
  baudRate?: number;
  wifiSsid?: string;
}

// Environment defaults
const ENV_ESP32_WS_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ESP32_WS_URL) || 'wss://vishal-done-backup.onrender.com/ws';
const ENV_SECURE_RELAY_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SECURE_RELAY_URL) || 'wss://vishal-done-backup.onrender.com/ws';
const ENV_RELAY_TOKEN = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_TOKEN) || 'saeindia_sec_99348a7b1c0e';
const ENV_WIFI_SSID = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WIFI_SSID) || 'drone123';

/**
 * Normalizes any user or environment relay URL into a canonical, valid WSS URL.
 * Strips repeated/nested protocols (e.g. "wss://https://...", "https://...", "ws://...")
 * and ensures canonical route path (defaults to '/ws') and query strings are preserved.
 */
export function normalizeSecureRelayUrl(input: string, fallbackPath = '/ws'): string {
  let cleaned = (input || '').trim();
  if (!cleaned) return 'wss://vishal-done-backup.onrender.com/ws';

  // Strip any nested or repeated protocol prefixes: wss://, ws://, https://, http://
  cleaned = cleaned.replace(/^(wss?:\/\/|https?:\/\/)+/i, '');

  // Separate query parameters if any
  const qIdx = cleaned.indexOf('?');
  let hostAndPath = qIdx >= 0 ? cleaned.slice(0, qIdx) : cleaned;
  const queryString = qIdx >= 0 ? cleaned.slice(qIdx) : '';

  // Strip trailing slashes
  hostAndPath = hostAndPath.replace(/\/+$/, '');

  // If there's no path (e.g. "vishal-done-backup.onrender.com"), append fallbackPath
  if (!hostAndPath.includes('/')) {
    const formatted = fallbackPath.startsWith('/') ? fallbackPath : '/' + fallbackPath;
    hostAndPath = hostAndPath + formatted;
  }

  return 'wss://' + hostAndPath + queryString;
}

function parseWsEndpoint(urlStr: string) {
  try {
    const clean = urlStr.trim().replace(/^ws(s)?:\/\//i, 'http$1://');
    const parsed = new URL(clean);
    return {
      host: parsed.hostname || 'vishal-done-backup.onrender.com',
      port: parsed.port ? parseInt(parsed.port, 10) : (clean.startsWith('https://') ? 443 : 8080),
      path: parsed.pathname || '/ws'
    };
  } catch (e) {
    return { host: 'vishal-done-backup.onrender.com', port: 443, path: '/ws' };
  }
}

export class Esp32WebSocketTransport implements MavlinkTransport {
  public readonly id = 'esp32_websocket';
  public readonly name = 'ESP32-S3 Wireless MAVLink Bridge';
  public readonly type: TransportType = 'ESP32_WEBSOCKET';

  private dataListeners: Set<(chunk: Uint8Array) => void> = new Set();
  private stateListeners: Set<(event: TransportStateEvent) => void> = new Set();

  private socket: WebSocket | null = null;

  // Protocol configuration: 'AUTO' | 'WS' | 'WSS'
  private protocolMode: WebSocketProtocolMode = 'WSS';
  // Connection Mode: 'LOCAL' (ws://) vs 'SECURE' (wss://)
  private connectionMode: WebSocketConnectionMode = 'SECURE';

  private localHost: string = '192.168.31.194';
  private localPort: number = 8080;
  private path: string = '/ws';
  private secureEndpoint: string = ENV_SECURE_RELAY_URL;
  private relayToken: string = ENV_RELAY_TOKEN;
  private currentProtocol: 'ws' | 'wss' = 'wss';
  private currentBaudRate: number = 57600;

  // Relay Multi-Hop Status
  private connectorOnline: boolean = false;
  private esp32Online: boolean = false;
  private cloudState: 'CONNECTED' | 'DISCONNECTED' = 'DISCONNECTED';
  private esp32Baud: number = 57600;
  private esp32Rssi: number = 0;
  private qrAlertListeners: Set<(payload: string) => void> = new Set();
  private esp32DiagData: Esp32DiagData | null = null;
  private esp32DiagListeners: Set<(diag: Esp32DiagData) => void> = new Set();

  // Link State
  private linkState: Esp32LinkState = 'DISCONNECTED';
  private errorCategory: Esp32ErrorCategory = 'NONE';
  private lastErrorMessage: string = '';
  private latencyMs: number = 0;
  private connectStartTime: number = 0;

  // Wi-Fi State Persistence (Independent of WebSocket & Page Reload)
  private wifiSsid: string = ENV_WIFI_SSID;
  private wifiConnected: boolean = true;

  private isConnecting: boolean = false;
  private manualDisconnect: boolean = false;

  // Reconnect management (guaranteed single timer)
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private reconnectTimer: any = null;
  private connectTimeoutTimer: any = null;

  // Cumulative Metrics
  private cumulativeRxBytes: number = 0;
  private cumulativeTxBytes: number = 0;
  private lastPacketTimestamp: number = 0;

  constructor() {
    // Defaults from environment variables
    const defaultWs = parseWsEndpoint(ENV_ESP32_WS_URL);
    this.localHost = defaultWs.host;
    this.localPort = defaultWs.port;
    this.path = defaultWs.path;
    this.secureEndpoint = (ENV_SECURE_RELAY_URL || '').trim();
    this.relayToken = ENV_RELAY_TOKEN;
    this.wifiSsid = ENV_WIFI_SSID;

    this.protocolMode = 'WSS';
    this.connectionMode = 'SECURE';
    this.currentProtocol = 'wss';

    if (typeof window !== 'undefined') {
      try {
        const savedProtoMode = localStorage.getItem('esp32_proto_mode') as WebSocketProtocolMode;
        const savedMode = localStorage.getItem('esp32_conn_mode');
        const savedHost = localStorage.getItem('esp32_host');
        const savedPort = localStorage.getItem('esp32_port');
        const savedPath = localStorage.getItem('esp32_path');
        const savedSecureEndpoint = localStorage.getItem('esp32_secure_endpoint');
        const savedToken = localStorage.getItem('esp32_relay_token');
        const savedProto = localStorage.getItem('esp32_proto');
        const savedBaud = localStorage.getItem('esp32_baud');
        const savedSsid = localStorage.getItem('esp32_wifi_ssid');

        if (savedProtoMode === 'WS' || savedProtoMode === 'WSS') {
          this.protocolMode = savedProtoMode;
        } else {
          this.protocolMode = 'WSS';
        }

        if (savedMode === 'LOCAL' || savedMode === 'SECURE') {
          this.connectionMode = savedMode;
        } else {
          this.connectionMode = 'SECURE';
        }

        if (savedHost && savedHost.trim().length > 0) {
          this.localHost = savedHost.trim();
        }
        if (savedPort) this.localPort = parseInt(savedPort, 10) || 8080;
        if (savedPath !== null && savedPath !== undefined) this.path = savedPath;
        if (savedSecureEndpoint && savedSecureEndpoint.trim().length > 0 && !savedSecureEndpoint.includes('192.168.')) {
          this.secureEndpoint = normalizeSecureRelayUrl(savedSecureEndpoint);
        } else {
          this.secureEndpoint = normalizeSecureRelayUrl(ENV_SECURE_RELAY_URL);
        }
        if (savedToken && savedToken.trim().length > 0 && savedToken !== 'saeindia_secret_token_2026' && savedToken !== 'CHANGE_ME') {
          this.relayToken = savedToken.trim();
        } else {
          this.relayToken = ENV_RELAY_TOKEN;
        }
        if (savedProto === 'ws' || savedProto === 'wss') {
          this.currentProtocol = savedProto;
        } else {
          this.currentProtocol = 'wss';
        }
        if (savedBaud) this.currentBaudRate = parseInt(savedBaud, 10) || 57600;
        if (savedSsid && savedSsid !== 'DRONE_WIFI_2.4G') {
          this.wifiSsid = savedSsid;
        } else {
          this.wifiSsid = ENV_WIFI_SSID;
        }

        // Auto-connect to ESP32 Cloud Relay on startup unless user explicitly clicked manual disconnect
        const manualDis = localStorage.getItem('esp32_manual_disconnect');
        if (manualDis !== 'true') {
          setTimeout(() => {
            if (!this.manualDisconnect && !this.socket) {
              console.log('[WS] Auto-connecting to ESP32 Cloud WSS Relay (' + this.wifiSsid + ')...');
              this.connect();
            }
          }, 400);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  public isAvailable(): boolean {
    return typeof WebSocket !== 'undefined';
  }

  public isConnectorOnline(): boolean {
    return this.connectorOnline;
  }

  public getCloudState(): 'CONNECTED' | 'DISCONNECTED' {
    return (this.socket && this.socket.readyState === WebSocket.OPEN) ? 'CONNECTED' : 'DISCONNECTED';
  }

  public getEsp32Baud(): number {
    return this.esp32Baud;
  }

  public getEsp32Rssi(): number {
    return this.esp32Rssi;
  }

  public subscribeEsp32Diag(listener: (diag: Esp32DiagData) => void): () => void {
    this.esp32DiagListeners.add(listener);
    if (this.esp32DiagData) {
      try {
        listener(this.esp32DiagData);
      } catch (e) {
        console.error('[WS] Error in esp32Diag listener:', e);
      }
    }
    return () => this.esp32DiagListeners.delete(listener);
  }

  public getEsp32Diag(): Esp32DiagData | null {
    return this.esp32DiagData;
  }

  public subscribeQrAlert(listener: (payload: string) => void): () => void {
    this.qrAlertListeners.add(listener);
    return () => this.qrAlertListeners.delete(listener);
  }

  public getEsp32Online(): boolean {
    return this.esp32Online;
  }

  public isEsp32Online(): boolean {
    return this.esp32Online;
  }

  public getRelayToken(): string {
    return this.relayToken;
  }

  public getProtocolMode(): WebSocketProtocolMode {
    return this.protocolMode;
  }

  public getConnectionMode(): WebSocketConnectionMode {
    return this.connectionMode;
  }

  public getLinkState(): Esp32LinkState {
    return this.linkState;
  }

  public getErrorCategory(): Esp32ErrorCategory {
    return this.errorCategory;
  }

  public getLastErrorMessage(): string {
    return this.lastErrorMessage;
  }

  public getLatencyMs(): number {
    return this.latencyMs;
  }

  public getHost(): string {
    return this.localHost;
  }

  public getPort(): number {
    return this.localPort;
  }

  public getPath(): string {
    return this.path;
  }

  public getSecureEndpoint(): string {
    return this.secureEndpoint;
  }

  public getProtocol(): 'ws' | 'wss' {
    return this.currentProtocol;
  }

  public getBaudRate(): number {
    return this.currentBaudRate;
  }

  public getWifiSsid(): string {
    return this.wifiSsid;
  }

  public isWifiConnected(): boolean {
    return this.wifiConnected;
  }

  public setWifiSsid(ssid: string) {
    this.wifiSsid = ssid.trim();
    this.wifiConnected = true;
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('esp32_wifi_ssid', this.wifiSsid);
      } catch (e) {
        // ignore
      }
    }
  }

  public resetWifi() {
    this.wifiSsid = '';
    this.wifiConnected = false;
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('esp32_wifi_ssid');
        localStorage.setItem('esp32_autoconnect', 'false');
      } catch (e) {
        // ignore
      }
    }
    this.disconnect();
  }

  /**
   * Helper to format path with leading slash if present
   */
  private formatPath(p: string): string {
    const trimmed = (p || '').trim();
    if (!trimmed) return '';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  /**
   * Helper to check if an address is a private/local network address
   */
  public isPrivateIp(hostOrUrl: string): boolean {
    const cleanHost = hostOrUrl
      .replace(/^wss?:\/\//i, '')
      .replace(/^https?:\/\//i, '')
      .split(':')[0]
      .split('/')[0]
      .trim();
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(cleanHost)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanHost)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(cleanHost)) return true;
    return false;
  }

  /**
   * Determine effective WebSocket protocol according to requirements:
   * - If protocolMode === 'WS': explicitly use 'ws'
   * - If protocolMode === 'WSS': explicitly use 'wss'
   * - If protocolMode === 'AUTO':
   *     If application is running through HTTPS: try 'wss'
   *     If application is running through HTTP: use 'ws'
   */
  public determineProtocol(forcedProto?: 'ws' | 'wss'): 'ws' | 'wss' {
    const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (isHttpsOrigin) {
      // In HTTPS origin, browser forbids unencrypted ws://
      return 'wss';
    }

    if (forcedProto) return forcedProto;
    if (this.protocolMode === 'WS') return 'ws';
    if (this.protocolMode === 'WSS') return 'wss';

    // AUTO MODE: If secure endpoint is configured, prefer WSS to connect to active cloud relay
    if (this.secureEndpoint || ENV_SECURE_RELAY_URL) {
      return 'wss';
    }

    // Fallback on HTTP origin without configured secure endpoint:
    return 'ws';
  }

  /**
   * Resolve target WebSocket URL based on configuration
   */
  public getResolvedUrl(overrideProto?: 'ws' | 'wss'): string {
    const proto = this.determineProtocol(overrideProto);
    const formattedPath = this.formatPath(this.path);

    if (proto === 'wss') {
      let ep = (this.secureEndpoint || ENV_SECURE_RELAY_URL || 'wss://vishal-done-backup.onrender.com/ws').trim();
      let url = normalizeSecureRelayUrl(ep, formattedPath || '/ws');

      // Append token if configured and not already included
      const tokenToUse = (this.relayToken || ENV_RELAY_TOKEN).trim();
      if (tokenToUse && !url.includes('token=')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}token=${encodeURIComponent(tokenToUse)}`;
      }

      return url;
    } else {
      // Direct WS to ESP32: Do NOT convert ws:// to wss://
      return `ws://${this.localHost}:${this.localPort}${formattedPath}`;
    }
  }

  public setConfig(options: Esp32WebSocketOptions) {
    const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';

    if (isHttpsOrigin) {
      this.protocolMode = 'WSS';
      this.connectionMode = 'SECURE';
    } else if (options.protocolMode) {
      this.protocolMode = options.protocolMode;
      this.connectionMode = options.protocolMode === 'WSS' ? 'SECURE' : 'LOCAL';
    } else if (options.mode) {
      this.connectionMode = options.mode;
      this.protocolMode = options.mode === 'SECURE' ? 'WSS' : 'AUTO';
    }

    if (options.host !== undefined && options.host.trim().length > 0) {
      this.localHost = options.host.trim();
    }
    if (options.port !== undefined && options.port > 0) {
      this.localPort = options.port;
    }
    if (options.path !== undefined) {
      this.path = options.path.trim();
    }
    if (options.secureEndpoint !== undefined) {
      this.secureEndpoint = normalizeSecureRelayUrl(options.secureEndpoint.trim(), this.path || '/ws');
    }
    if (options.relayToken !== undefined) {
      this.relayToken = options.relayToken.trim();
    }
    if (options.baudRate !== undefined && options.baudRate > 0) {
      this.currentBaudRate = options.baudRate;
    }
    if (options.wifiSsid) {
      this.wifiSsid = options.wifiSsid.trim();
      this.wifiConnected = true;
    }

    this.currentProtocol = this.determineProtocol(options.protocol);

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('esp32_proto_mode', this.protocolMode);
        localStorage.setItem('esp32_conn_mode', this.connectionMode);
        localStorage.setItem('esp32_host', this.localHost);
        localStorage.setItem('esp32_port', this.localPort.toString());
        localStorage.setItem('esp32_path', this.path);
        localStorage.setItem('esp32_secure_endpoint', this.secureEndpoint);
        localStorage.setItem('esp32_relay_token', this.relayToken);
        localStorage.setItem('esp32_proto', this.currentProtocol);
        localStorage.setItem('esp32_baud', this.currentBaudRate.toString());
        if (this.wifiSsid) localStorage.setItem('esp32_wifi_ssid', this.wifiSsid);
      } catch (e) {
        // ignore
      }
    }
  }

  /**
   * HTTP ping check to test if ESP32 web server is reachable on LAN.
   * Direct ESP32 communication allows http://ESP32_IP.
   * Does NOT automatically convert http:// to https://.
   */
  public async checkEsp32Http(host?: string, port?: number): Promise<{ reachable: boolean; latencyMs?: number; message?: string }> {
    const targetHost = host ? host.trim() : this.localHost;
    const targetPort = port || this.localPort;
    // For direct ESP32 check, use http:// - do not force https://
    const portPart = targetPort === 80 ? '' : `:${targetPort}`;
    const testUrl = `http://${targetHost}${portPart}/`;
    const startTime = Date.now();

    const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (isHttpsOrigin) {
      return {
        reachable: false,
        message: `HTTP ping to http://${targetHost}${portPart}/ is blocked by the browser because this page is loaded over HTTPS (Mixed Content restriction). Open the Ground Station over http:// (e.g. http://${window.location.hostname}:5173) for direct HTTP ping to the ESP32.`
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      await fetch(testUrl, {
        method: 'GET',
        mode: 'no-cors', // Avoid CORS preflight block for simple ping
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latency = Date.now() - startTime;
      return {
        reachable: true,
        latencyMs: latency,
        message: `ESP32 reachable at ${targetHost}${portPart} (${latency}ms)`
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { reachable: false, message: `ESP32 at ${targetHost}${portPart} timed out (2.5s). Ensure device is on the same local Wi-Fi.` };
      }
      return { reachable: false, message: `Could not reach http://${targetHost}${portPart}/: ${err.message || 'Host unreachable'}` };
    }
  }

  /**
   * Connect to ESP32 WebSocket server.
   * Supports:
   * - AUTO: HTTPS -> try WSS -> if unavailable report and fallback to WS
   *         HTTP -> use WS
   * - WS: direct ws://ESP32_IP:PORT/path
   * - WSS: direct or relay wss://
   */
  public async connect(options?: Esp32WebSocketOptions): Promise<boolean> {
    if (!this.isAvailable()) {
      this.linkState = 'ERROR';
      this.errorCategory = 'INVALID_ENDPOINT';
      this.lastErrorMessage = 'WebSocket is not supported in this browser environment.';
      this.notifyState({
        phase: 'USB_NOT_DETECTED',
        message: this.lastErrorMessage,
        error: this.lastErrorMessage
      });
      return false;
    }

    if (options) {
      this.setConfig(options);
    }

    // Reset flags & clear existing timers
    this.manualDisconnect = false;
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('esp32_manual_disconnect');
        localStorage.setItem('esp32_autoconnect', 'true');
      } catch (e) {}
    }
    this.reconnectAttempts = 0;
    this.clearAllTimers();
    this.cleanupSocket(false);

    // Initial state transition
    this.linkState = 'CONNECTING';
    this.errorCategory = 'NONE';
    this.lastErrorMessage = '';

    const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';

    // In AUTO mode on HTTPS, start with WSS; if that fails or WSS is unavailable, fallback to WS
    const initialProto = this.determineProtocol();

    return this.attemptConnection(initialProto);
  }

  /**
   * Internal connection attempt with specific protocol ('ws' | 'wss')
   */
  private async attemptConnection(protocolToTry: 'ws' | 'wss'): Promise<boolean> {
    let wsUrl = this.getResolvedUrl(protocolToTry);
    const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';
    const isLocalTarget = this.isPrivateIp(this.localHost);

    console.log(`[WS] INITIATING CONNECTION`);
    console.log(`[WS] Protocol Mode = ${this.protocolMode}`);
    console.log(`[WS] Target Protocol = ${protocolToTry}`);
    console.log(`[WS] Resolved Endpoint = ${wsUrl}`);
    console.log(`[WS] Local Network Target = ${isLocalTarget}`);

    // Mixed-Content Protection: Detect https: origin and upgrade non-local ws:// to wss:// or surface clear error
    if (isHttpsOrigin) {
      if (wsUrl.startsWith("ws://") || this.protocolMode === "WS") {
        if (isLocalTarget) {
          const mixedMsg = `Browser blocks plain ws:// connections to local network (${this.localHost}) from HTTPS (${window.location.origin}). Please use SECURE mode with WSS Relay, or open Ground Station on http:// origin.`;
          console.warn(mixedMsg);
          this.linkState = "ERROR";
          this.errorCategory = "MIXED_CONTENT_BLOCK";
          this.lastErrorMessage = mixedMsg;
          this.notifyState({
            phase: "SERIAL_OPEN_FAILED",
            message: mixedMsg,
            error: "MIXED_CONTENT_BLOCK"
          });
          return false;
        } else {
          console.log(`[WS] Mixed-content protection: Upgrading non-local endpoint to wss:// (${wsUrl})`);
          protocolToTry = "wss";
          this.currentProtocol = "wss";
          wsUrl = this.getResolvedUrl("wss");
        }
      }
    }

    // On HTTPS origin: check if secure relay endpoint is configured
    if (isHttpsOrigin && protocolToTry === "wss") {
      const endpointToCheck = (this.secureEndpoint || ENV_SECURE_RELAY_URL || "").trim();
      if (!endpointToCheck || this.isPrivateIp(endpointToCheck)) {
        const relayMsg = "Secure relay unavailable. Please configure VITE_SECURE_RELAY_URL or enter a valid WSS relay endpoint.";
        console.warn(relayMsg);
        this.linkState = "ERROR";
        this.errorCategory = "RELAY_UNAVAILABLE";
        this.lastErrorMessage = "Secure relay unavailable.";
        this.notifyState({
          phase: "SERIAL_OPEN_FAILED",
          message: "Secure relay unavailable.",
          error: "RELAY_UNAVAILABLE"
        });
        return false;
      }
    }

    // Render Cold-Start Wake-Up: trigger non-blocking fetch to /health prior to opening WebSocket
    let healthUrl: string | null = null;
    if (protocolToTry === "wss") {
      try {
        const clean = wsUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
        const parsed = new URL(clean);
        healthUrl = `${parsed.protocol}//${parsed.host}/health`;
      } catch (e) {
        if (wsUrl.includes(".onrender.com")) {
          healthUrl = wsUrl.replace(/^wss:\/\//i, "https://").split("?")[0].replace(/\/ws$/, "/health");
        }
      }
      if (healthUrl) {
        console.log(`[WS] Render cold-start wake-up: triggering non-blocking fetch to ${healthUrl}`);
        fetch(healthUrl, { mode: "no-cors" }).catch(() => {});
        this.notifyState({
          phase: "WAKING_RELAY",
          message: `Waking up cloud relay container (${healthUrl})...`
        });
      }
    }

    return new Promise<boolean>((resolve) => {
      this.isConnecting = true;
      this.linkState = "CONNECTING";
      this.connectStartTime = Date.now();

      // Progressive UI phase reporting: AUTHENTICATING_WSS (WSS) or SERIAL_OPENING (WS)
      this.notifyState({
        phase: protocolToTry === "wss" ? "AUTHENTICATING_WSS" : "SERIAL_OPENING",
        message: protocolToTry === "wss"
          ? `Authenticating Secure WSS connection to ${wsUrl}...`
          : `Connecting to ESP32 MAVLink bridge at ${wsUrl}...`
      });

      // 30-second progressive connection timeout for cloud WSS relay vs 6s for direct LAN WS
      const timeoutDurationMs = protocolToTry === "wss" ? 30000 : 6000;

      let wakeUpTimer: ReturnType<typeof setTimeout> | null = null;
      if (protocolToTry === "wss") {
        wakeUpTimer = setTimeout(() => {
          if (this.isConnecting) {
            this.notifyState({
              phase: "WAKING_RELAY",
              message: "Waking up cloud relay container on Render (~25s cold start)..."
            });
          }
        }, 3500);
      }

      this.connectTimeoutTimer = setTimeout(() => {
        if (wakeUpTimer) clearTimeout(wakeUpTimer);
        if (this.isConnecting && (!this.socket || this.socket.readyState !== WebSocket.OPEN)) {
          this.isConnecting = false;
          this.cleanupSocket(false);

          let diagError: Esp32ErrorCategory = "CONNECTION_TIMEOUT";
          let timeoutDetails = "";

          if (protocolToTry === "wss") {
            diagError = "RELAY_UNAVAILABLE";
            timeoutDetails = " Cloud relay did not respond within 30 seconds.";
          } else {
            diagError = isLocalTarget ? "ESP32_UNAVAILABLE" : "CONNECTION_TIMEOUT";
            timeoutDetails = ` Could not reach ${wsUrl} within 6 seconds. Verify ESP32 is powered and device is on the same local Wi-Fi.`;
          }

          this.linkState = "ERROR";
          this.errorCategory = diagError;
          this.lastErrorMessage = protocolToTry === "wss" ? `Secure relay unavailable.${timeoutDetails}` : `Connection timeout to ${wsUrl}.${timeoutDetails}`;
          console.error(`[WS ERROR] ${this.lastErrorMessage}`);

          if (!isHttpsOrigin && this.protocolMode === "AUTO" && protocolToTry === "wss") {
            console.warn("[WS] AUTO fallback: WSS timed out on HTTP. Trying WS...");
            this.handleWssFallback(wsUrl).then((fbResult) => resolve(fbResult));
            return;
          }

          this.notifyState({
            phase: "SERIAL_OPEN_FAILED",
            message: this.lastErrorMessage,
            error: diagError
          });
          resolve(false);
        }
      }, timeoutDurationMs);
      try {
        const socket = new WebSocket(wsUrl);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;

        socket.onopen = () => {
          if (wakeUpTimer) clearTimeout(wakeUpTimer);
          this.clearAllTimers();
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.currentProtocol = protocolToTry;
          this.linkState = "CONNECTED";
          this.cloudState = "CONNECTED";
          this.errorCategory = "NONE";
          this.lastErrorMessage = "";
          this.latencyMs = Math.max(1, Date.now() - this.connectStartTime);

          if (typeof window !== "undefined") {
            try {
              localStorage.setItem("esp32_autoconnect", "true");
            } catch (e) {}
          }

          // Distinct UI phases: WAITING_FOR_ESP32 vs WAITING_FOR_HEARTBEAT
          const nextPhase = protocolToTry === "wss"
            ? (this.esp32Online ? "WAITING_FOR_HEARTBEAT" : "WAITING_FOR_ESP32")
            : "WAITING_FOR_HEARTBEAT";

          const successMsg = protocolToTry === "wss"
            ? (this.esp32Online
                ? `Connected to Secure WSS Relay (${wsUrl}) ✓ ESP32 bridge ONLINE. Waiting for MAVLink Heartbeat…`
                : `Connected to Secure WSS Relay (${wsUrl}) ✓ Waiting for ESP32 bridge to come ONLINE…`)
            : `Connected to ESP32 MAVLink bridge (${wsUrl}) ✓ Latency: ${this.latencyMs}ms. Waiting for Pixhawk Heartbeat…`;
          console.log(`[WS] ${successMsg}`);

          this.notifyState({
            phase: nextPhase,
            message: successMsg,
            device: {
              deviceName: protocolToTry === "wss"
                ? `Secure WSS Relay (${this.secureEndpoint || ENV_SECURE_RELAY_URL})`
                : `ESP32-S3 Wireless Bridge (${this.localHost}:${this.localPort})`,
              productName: `ESP32-S3 MAVLink WebSocket [${protocolToTry.toUpperCase()}] (${this.currentBaudRate} baud)`,
              manufacturerName: "Espressif / SAEISS",
              driverType: "ESP32_WEBSOCKET",
              hasPermission: true,
              baudRate: this.currentBaudRate
            }
          });
          resolve(true);
        };

        socket.onmessage = (event: MessageEvent) => {
          this.lastPacketTimestamp = Date.now();
          this.latencyMs = Math.max(1, Date.now() - (this.connectStartTime || Date.now()));

          if (event.data instanceof ArrayBuffer) {
            const chunk = new Uint8Array(event.data);
            this.cumulativeRxBytes += chunk.length;
            this.dataListeners.forEach((fn) => fn(chunk));
          } else if (event.data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => {
              if (reader.result instanceof ArrayBuffer) {
                const chunk = new Uint8Array(reader.result);
                this.cumulativeRxBytes += chunk.length;
                this.dataListeners.forEach((fn) => fn(chunk));
              }
            };
            reader.readAsArrayBuffer(event.data);
          } else if (typeof event.data === "string") {
            // Multi-hop state tracking: RELAY_STATUS, ESP32_STATUS, QR_ALERT JSON frames
            try {
              const meta = JSON.parse(event.data);
              if (meta && typeof meta === "object") {
                if (meta.type === "RELAY_STATUS" || meta.type === "connection_ack") {
                  const isEspOnline = meta.esp32Online === true || meta.status === "CONNECTED" || meta.status === "ONLINE";
                  const isConnOnline = meta.connectorOnline !== false && (meta.connectorOnline === true || isEspOnline);
                  this.connectorOnline = isConnOnline;
                  this.esp32Online = isEspOnline;
                  this.cloudState = "CONNECTED";
                  this.wifiConnected = true;

                  if (meta.baud || meta.esp32Baud || meta.baudRate) {
                    this.esp32Baud = Number(meta.baud || meta.esp32Baud || meta.baudRate);
                    this.currentBaudRate = this.esp32Baud;
                  }
                  if (meta.rssi !== undefined || meta.esp32Rssi !== undefined) {
                    this.esp32Rssi = Number(meta.rssi !== undefined ? meta.rssi : meta.esp32Rssi);
                  }

                  if (isEspOnline) {
                    this.errorCategory = "NONE";
                    this.lastErrorMessage = "";
                    this.linkState = "CONNECTED";
                    this.notifyState({
                      phase: "WAITING_FOR_HEARTBEAT",
                      message: `ESP32 bridge ONLINE (${this.wifiSsid}) ✓ RSSI: ${this.esp32Rssi}dBm @ ${this.esp32Baud} baud. Waiting for MAVLink Heartbeat...`
                    });
                  } else if (!isConnOnline) {
                    this.errorCategory = "CONNECTOR_OFFLINE";
                    this.lastErrorMessage = "ESP32 bridge offline on cloud relay.";
                    this.notifyState({
                      phase: "WAITING_FOR_ESP32",
                      message: "Cloud relay connected. Waiting for ESP32 bridge to come ONLINE...",
                      error: "CONNECTOR_OFFLINE"
                    });
                  } else {
                    this.errorCategory = "ESP32_UNAVAILABLE";
                    this.lastErrorMessage = meta.error || "ESP32 unavailable on cloud relay.";
                    this.notifyState({
                      phase: "WAITING_FOR_ESP32",
                      message: meta.error || "ESP32 bridge offline. Waiting for device...",
                      error: "ESP32_UNAVAILABLE"
                    });
                  }
                  return;
                }

                if (meta.type === "ESP32_STATUS") {
                  const isEspOnline = meta.status === "CONNECTED" || meta.status === "ONLINE" || meta.esp32 === "ONLINE";
                  this.esp32Online = isEspOnline;
                  this.cloudState = "CONNECTED";

                  if (meta.baud || meta.esp32Baud || meta.baudRate) {
                    this.esp32Baud = Number(meta.baud || meta.esp32Baud || meta.baudRate);
                    this.currentBaudRate = this.esp32Baud;
                  }
                  if (meta.rssi !== undefined || meta.esp32Rssi !== undefined) {
                    this.esp32Rssi = Number(meta.rssi !== undefined ? meta.rssi : meta.esp32Rssi);
                  }

                  if (isEspOnline) {
                    this.errorCategory = "NONE";
                    this.lastErrorMessage = "";
                    this.notifyState({
                      phase: "WAITING_FOR_HEARTBEAT",
                      message: `ESP32 status: ONLINE (${this.wifiSsid}) ✓ RSSI: ${this.esp32Rssi}dBm @ ${this.esp32Baud} baud. Waiting for MAVLink Heartbeat...`
                    });
                  } else {
                    this.notifyState({
                      phase: "WAITING_FOR_ESP32",
                      message: meta.error || "ESP32 bridge offline or searching for Wi-Fi AP..."
                    });
                  }
                  return;
                }

                if (meta.type === "ESP32_DIAG") {
                  const diag: Esp32DiagData = {
                    type: "ESP32_DIAG",
                    rssi: meta.rssi !== undefined ? Number(meta.rssi) : this.esp32Rssi,
                    freeHeap: meta.freeHeap !== undefined ? Number(meta.freeHeap) : undefined,
                    uartRxBytes: meta.uartRxBytes !== undefined ? Number(meta.uartRxBytes) : 0,
                    uartTxBytes: meta.uartTxBytes !== undefined ? Number(meta.uartTxBytes) : undefined,
                    baud: meta.baud !== undefined ? Number(meta.baud) : this.esp32Baud,
                    ...meta
                  };
                  this.esp32DiagData = diag;
                  this.esp32Online = true;
                  this.cloudState = "CONNECTED";
                  this.wifiConnected = true;

                  if (diag.rssi !== undefined) {
                    this.esp32Rssi = diag.rssi;
                  }
                  if (diag.baud !== undefined && diag.baud > 0) {
                    this.esp32Baud = diag.baud;
                    this.currentBaudRate = diag.baud;
                  }

                  if (diag.uartRxBytes === 0) {
                    const warningMsg = "ESP32 Online, but 0 bytes on GPIO 18 RX — Check Pixhawk TELEM2 Pin 2/3 wiring";
                    this.lastErrorMessage = warningMsg;
                    this.errorCategory = "NONE";
                    this.notifyState({
                      phase: "WAITING_FOR_HEARTBEAT",
                      message: warningMsg
                    });
                  } else {
                    this.lastErrorMessage = "";
                    this.errorCategory = "NONE";
                    this.notifyState({
                      phase: "WAITING_FOR_HEARTBEAT",
                      message: `ESP32 Online (${diag.uartRxBytes} bytes RX, RSSI: ${this.esp32Rssi}dBm)`
                    });
                  }

                  this.esp32DiagListeners.forEach((fn) => {
                    try {
                      fn(diag);
                    } catch (e) {
                      console.error('[WS] Error notifying esp32Diag listener:', e);
                    }
                  });
                  return;
                }

                if (meta.type === "QR_ALERT") {
                  const qrPayload = meta.payload || meta.code || meta.data || meta.qr;
                  console.log(`[WS] QR_ALERT frame intercepted: "${qrPayload}"`);
                  this.qrAlertListeners.forEach((fn) => fn(String(qrPayload)));
                  this.notifyState({
                    phase: "WAITING_FOR_HEARTBEAT",
                    message: `QR Alert intercepted from drone bridge: [${qrPayload}]`
                  });
                  return;
                }
              }
            } catch (err) {
              // Non-JSON frame: forward as text byte stream
            }

            const encoder = new TextEncoder();
            const chunk = encoder.encode(event.data);
            this.cumulativeRxBytes += chunk.length;
            this.dataListeners.forEach((fn) => fn(chunk));
          }
        };

        socket.onerror = (err: Event) => {
          this.clearAllTimers();
          this.isConnecting = false;

          const durationMs = Date.now() - this.connectStartTime;
          let diagCategory: Esp32ErrorCategory = 'HANDSHAKE_FAILURE';
          let diagMsg = '';

          if (protocolToTry === 'wss') {
            diagCategory = 'RELAY_UNAVAILABLE';
            diagMsg = 'Secure relay unavailable.';
          } else if (isHttpsOrigin && protocolToTry === 'ws') {
            diagCategory = 'MIXED_CONTENT_BLOCK';
            diagMsg = `Browser blocks plain ws:// connections from HTTPS (${window.location.origin}). Please use SECURE mode with WSS Relay, or open Ground Station on http:// origin.`;
          } else if (durationMs < 350) {
            diagCategory = 'CONNECTION_REFUSED';
            diagMsg = `[WS ERROR] Connection refused: ESP32 port ${this.localPort} rejected the connection. Verify ESP32 firmware is running WebSocket server on port ${this.localPort}.`;
          } else {
            diagCategory = 'HANDSHAKE_FAILURE';
            diagMsg = `[WS ERROR] WebSocket handshake failure with ${wsUrl}. Verify host IP and WebSocket path.`;
          }

          console.warn(diagMsg, err);

          // On HTTP origin ONLY, fallback to WS if AUTO mode WSS failed
          if (!isHttpsOrigin && this.protocolMode === 'AUTO' && protocolToTry === 'wss') {
            this.handleWssFallback(wsUrl).then((fbResult) => resolve(fbResult));
            return;
          }

          this.linkState = 'ERROR';
          this.errorCategory = diagCategory;
          this.lastErrorMessage = diagMsg;

          this.notifyState({
            phase: 'SERIAL_OPEN_FAILED',
            message: diagMsg,
            error: diagCategory
          });
          resolve(false);
        };

        socket.onclose = (event: CloseEvent) => {
          this.clearAllTimers();
          this.isConnecting = false;
          this.socket = null;

          // If manually disconnected by user, do not reconnect
          if (this.manualDisconnect) {
            this.linkState = 'DISCONNECTED';
    this.esp32DiagData = null;
            this.errorCategory = 'NONE';
            this.lastErrorMessage = 'Disconnected by user';
            this.notifyState({
              phase: 'DISCONNECTED',
              message: 'ESP32-S3 bridge disconnected by user.'
            });
            return;
          }

          // If closed during initial handshake, let onerror or connectTimeout handle it
          if (this.linkState === 'CONNECTING') {
            return;
          }

          // Connection dropped unexpectedly -> Start reconnection sequence
          this.linkState = 'RECONNECTING';

          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delays = [1000, 2000, 3000, 5000, 8000];
            const delay = delays[this.reconnectAttempts - 1] || 5000;

            const reconMsg = `[WS] Connection lost. Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay / 1000}s…`;
            console.log(reconMsg);

            this.notifyState({
              phase: 'WAITING_FOR_MAVLINK',
              message: reconMsg
            });

            // Single reconnect timer guarantee
            this.reconnectTimer = setTimeout(() => {
              if (!this.manualDisconnect) {
                this.attemptConnection(this.currentProtocol);
              }
            }, delay);
          } else {
            this.linkState = 'ERROR';
            this.errorCategory = protocolToTry === 'wss' ? 'RELAY_UNAVAILABLE' : 'CONNECTION_REFUSED';
            this.lastErrorMessage = protocolToTry === 'wss'
              ? 'Secure relay unavailable.'
              : `ESP32 connection lost. Failed to reconnect after ${this.maxReconnectAttempts} attempts. Press CONNECT to retry.`;

            console.error(this.lastErrorMessage);

            this.notifyState({
              phase: 'CONNECTION_LOST',
              message: this.lastErrorMessage,
              error: 'Max reconnect attempts exceeded'
            });
          }
        };

      } catch (err: any) {
        this.clearAllTimers();
        this.isConnecting = false;

        const isSecurityError = err.name === 'SecurityError' || /insecure/i.test(err.message || '');
        const errorCategory: Esp32ErrorCategory = isSecurityError ? 'MIXED_CONTENT_BLOCK' : 'INVALID_ENDPOINT';
        const errDesc = isSecurityError
          ? `Browser blocks plain ws:// connections from HTTPS (${window.location.origin}). Please use SECURE mode with WSS Relay, or open Ground Station on http:// origin.`
          : `[WS ERROR] Failed to initialize WebSocket to ${wsUrl}: ${err.message || err}`;

        console.error(errDesc);

        this.linkState = 'ERROR';
        this.errorCategory = errorCategory;
        this.lastErrorMessage = errDesc;

        this.notifyState({
          phase: 'SERIAL_OPEN_FAILED',
          message: errDesc,
          error: errorCategory
        });
        resolve(false);
      }
    });
  }

  /**
   * Handle WSS fallback when AUTO mode tries WSS on HTTP and fails
   */
  private async handleWssFallback(failedWssUrl: string): Promise<boolean> {
    const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (isHttpsOrigin) {
      const secureMsg = 'Secure relay unavailable.';
      this.linkState = 'ERROR';
      this.errorCategory = 'RELAY_UNAVAILABLE';
      this.lastErrorMessage = secureMsg;
      this.notifyState({
        phase: 'SERIAL_OPEN_FAILED',
        message: secureMsg,
        error: 'RELAY_UNAVAILABLE'
      });
      return false;
    }

    console.log('[WS] Falling back to direct ws:// connection...');
    return this.attemptConnection('ws');
  }

  /**
   * Explicit DISCONNECT (Browser Communication Only):
   * Closes WebSocket cleanly, stops telemetry, does NOT erase Wi-Fi credentials,
   * does NOT restart ESP32 Wi-Fi or AP.
   */
  public async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.reconnectAttempts = 0;
    this.isConnecting = false;
    this.clearAllTimers();

    this.linkState = 'DISCONNECTED';
    this.errorCategory = 'NONE';
    this.lastErrorMessage = '';

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('esp32_autoconnect', 'false');
        localStorage.setItem('esp32_manual_disconnect', 'true');
      } catch (e) {
        // ignore
      }
    }

    this.cleanupSocket(true);

    this.notifyState({
      phase: 'DISCONNECTED',
      message: 'ESP32-S3 WebSocket bridge disconnected by user. Wi-Fi remains active on ESP32.'
    });
  }

  private cleanupSocket(isManual: boolean) {
    if (this.socket) {
      try {
        this.socket.onopen = null;
        this.socket.onmessage = null;
        this.socket.onerror = null;
        this.socket.onclose = null;

        if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
          this.socket.close(1000, isManual ? 'User requested disconnect' : 'Cleaning up socket');
        }
      } catch (e) {
        // ignore
      }
      this.socket = null;
    }
  }

  private clearAllTimers() {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  public async send(data: Uint8Array): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      // Zero-copy direct transmit: modern browsers accept ArrayBufferView (Uint8Array) directly without copying
      this.socket.send(data);
      this.cumulativeTxBytes += data.length;
      return true;
    } catch (e) {
      console.error('[WS TX] Failed to send MAVLink bytes over WebSocket:', e);
      return false;
    }
  }

  public subscribeData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  public subscribeState(listener: (event: TransportStateEvent) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private notifyState(event: TransportStateEvent) {
    this.stateListeners.forEach((fn) => fn(event));
  }

  public async getDiagnostics(): Promise<Record<string, any>> {
    const pageProtocol = typeof window !== 'undefined' ? window.location.protocol.replace(':', '').toUpperCase() : 'HTTP';
    return {
      protocolMode: this.protocolMode,
      connectionMode: this.connectionMode,
      linkState: this.linkState,
      errorCategory: this.errorCategory,
      lastErrorMessage: this.lastErrorMessage,
      latencyMs: this.latencyMs,
      pageProtocol,
      host: this.localHost,
      port: this.localPort,
      path: this.path,
      secureEndpoint: this.secureEndpoint,
      connectorOnline: this.connectorOnline,
      esp32Online: this.esp32Online,
      cloud: this.getCloudState(),
      esp32: this.esp32Online ? "ONLINE" : "OFFLINE",
      esp32Baud: this.esp32Baud,
      esp32Rssi: this.esp32Rssi,
      esp32Diag: this.esp32DiagData,
      uartRxBytes: this.esp32DiagData?.uartRxBytes ?? 0,
      freeHeap: this.esp32DiagData?.freeHeap,
      relayTokenConfigured: Boolean(this.relayToken),
      protocol: this.currentProtocol,
      baudRate: this.currentBaudRate,
      url: this.getResolvedUrl(),
      wifiSsid: this.wifiSsid,
      wifiConnected: this.wifiConnected,
      isHttpsOrigin: typeof window !== 'undefined' && window.location.protocol === 'https:',
      readyState: this.socket ? this.socket.readyState : WebSocket.CLOSED,
      isConnecting: this.isConnecting,
      manualDisconnect: this.manualDisconnect,
      reconnectAttempts: this.reconnectAttempts,
      bytesReceived: this.cumulativeRxBytes,
      bytesSent: this.cumulativeTxBytes,
      lastPacketTimestamp: this.lastPacketTimestamp,
      lastPacketAgeMs: this.lastPacketTimestamp > 0 ? Date.now() - this.lastPacketTimestamp : null
    };
  }
}
