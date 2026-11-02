import React, { useState, useEffect } from 'react';
import { PixhawkConnectionState, ConnectionPhase } from '../../types/mavlink';
import { mavlinkService } from '../../services/mavlinkService';
import { transportManager } from '../../services/transports/TransportManager';
import {
  Usb,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Activity,
  Cpu,
  RefreshCw,
  PowerOff,
  Sliders,
  HelpCircle,
  Radio,
  Zap,
  RotateCcw,
  Check,
  Lock,
  Search,
  Wifi,
  Globe,
  Info,
  Server,
  Cable,
  ArrowRight,
  ShieldAlert,
  Clock,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Layers,
  Network,
  Settings,
  Trash2
} from 'lucide-react';
import { SerialDiagnosticsModal } from './SerialDiagnosticsModal';

interface PixhawkConnectionCardProps {
  connectionState: PixhawkConnectionState;
  className?: string;
  onOpenHelp?: () => void;
}

export const PixhawkConnectionCard: React.FC<PixhawkConnectionCardProps> = ({
  connectionState,
  className = '',
  onOpenHelp
}) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isCheckingEsp32, setIsCheckingEsp32] = useState(false);
  const [esp32PingResult, setEsp32PingResult] = useState<{ reachable: boolean; latencyMs?: number; message?: string } | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showEsp32Guide, setShowEsp32Guide] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showDevDetails, setShowDevDetails] = useState(false);
  const [selectedBaud, setSelectedBaud] = useState<number>(connectionState.baudRate || 57600);
  
  // Wi-Fi Display State (managed directly on ESP32 web portal)
  const [wifiSsid, setWifiSsid] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('esp32_wifi_ssid');
      if (saved && saved !== 'DRONE_WIFI_2.4G' && saved.trim().length > 0) return saved.trim();
    }
    return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WIFI_SSID) || 'drone123';
  });

  // Connection Transport Method: 'ESP32' | 'USB' | 'SIM'
  const [connectionMethod, setConnectionMethod] = useState<'ESP32' | 'USB' | 'SIM'>(() => {
    if (connectionState.connectionType === 'ESP32_WEBSOCKET') return 'ESP32';
    if (connectionState.connectionType === 'SIMULATED') return 'SIM';
    return 'ESP32'; // Default to ESP32 wireless bridge
  });

  const isHttpsOrigin = typeof window !== 'undefined' && window.location.protocol === 'https:';

  // ESP32 WebSocket Connection Protocol: 'AUTO' | 'WS' | 'WSS'
  const [protocolMode, setProtocolMode] = useState<'AUTO' | 'WS' | 'WSS'>(() => {
    if (isHttpsOrigin) return 'WSS';
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('esp32_proto_mode') as 'AUTO' | 'WS' | 'WSS';
      if (saved === 'WS' || saved === 'WSS') return saved;
      const savedMode = localStorage.getItem('esp32_conn_mode');
      if (savedMode === 'SECURE') return 'WSS';
    }
    return 'WSS';
  });

  // Local ESP32 IP, Port & Path settings
  const [esp32Host, setEsp32Host] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('esp32_host');
      if (saved && saved.trim().length > 0) return saved.trim();
    }
    return '192.168.31.194';
  });
  const [esp32Port, setEsp32Port] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const p = localStorage.getItem('esp32_port');
      return p ? parseInt(p, 10) || 8080 : 8080;
    }
    return 8080;
  });
  const [esp32Path, setEsp32Path] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const p = localStorage.getItem('esp32_path');
      return p !== null ? p : '/ws';
    }
    return '/ws';
  });

  // Secure Endpoint / Relay URL settings (WSS Mode)
  const [esp32SecureEndpoint, setEsp32SecureEndpoint] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('esp32_secure_endpoint');
      if (saved && saved.trim().length > 0 && !saved.includes('192.168.')) return saved.trim();
    }
    return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SECURE_RELAY_URL) || 'wss://vishal-done-backup.onrender.com/ws';
  });

  // Secure Relay Token
  const [esp32RelayToken, setEsp32RelayToken] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('esp32_relay_token');
      if (saved && saved.trim().length > 0 && saved !== 'saeindia_secret_token_2026' && saved !== 'CHANGE_ME') return saved.trim();
    }
    return (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_TOKEN) || '';
  });

  // Mobile collapsed toggle
  const [isMobileCollapsed, setIsMobileCollapsed] = useState(false);

  const pageProtocol = typeof window !== 'undefined' ? window.location.protocol.replace(':', '').toUpperCase() : 'HTTP';

  const phase: ConnectionPhase = connectionState.phase;
  const isConnected = connectionState.isConnected; // MAVLink verified
  const isUsbConnected = connectionState.isUsbConnected; // Physical or WS link open
  const isSimulated = connectionState.connectionType === 'SIMULATED';
  const isEsp32Mode = connectionMethod === 'ESP32';
  const diag = connectionState.diagnostics;

  // Active Wi-Fi state (Wi-Fi remains connected on ESP32 regardless of browser page reload/WebSocket state)
  const isWifiConfigured = Boolean(wifiSsid && wifiSsid.trim().length > 0);

  // Resolved connection mode and target URL
  const esp32Mode: 'LOCAL' | 'SECURE' = isHttpsOrigin || protocolMode === 'WSS' ? 'SECURE' : 'LOCAL';
  const cleanPath = esp32Path ? (esp32Path.startsWith('/') ? esp32Path : `/${esp32Path}`) : '';
  const effectiveProto = esp32Mode === 'SECURE' ? 'wss' : 'ws';
  const targetHost = (esp32Mode === 'SECURE' && esp32SecureEndpoint) 
    ? esp32SecureEndpoint.replace(/^wss?:\/\//i, '').replace(/\/+$/, '') 
    : `${esp32Host}:${esp32Port}`;
  const resolvedTargetUrl = (esp32Mode === 'SECURE' && targetHost.includes('/'))
    ? `${effectiveProto}://${targetHost}`
    : `${effectiveProto}://${targetHost}${cleanPath}`;

  // Five Clear Connection States
  const linkState: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR' = (() => {
    if (connectionState.esp32LinkState) return connectionState.esp32LinkState;
    if (isUsbConnected && connectionState.connectionType === 'ESP32_WEBSOCKET') return 'CONNECTED';
    if (isConnecting || phase === 'SERIAL_OPENING') return 'CONNECTING';
    if (phase === 'WAITING_FOR_MAVLINK') return 'RECONNECTING';
    if (phase === 'SERIAL_OPEN_FAILED' || phase === 'CONNECTION_LOST' || Boolean(connectionState.errorMessage)) return 'ERROR';
    return 'DISCONNECTED';
  })();

  const latencyMs = connectionState.esp32LatencyMs || (isConnected && connectionState.lastHeartbeat > 0 ? Math.max(1, Date.now() - connectionState.lastHeartbeat) : 0);

  // Granular Stage Flags - Stable 10s loss threshold to prevent rapid connecting/disconnecting flapping
  const isWebSocketOpen = isUsbConnected && connectionState.connectionType === 'ESP32_WEBSOCKET';
  const isMavlinkHeartbeatReceived = isConnected && connectionState.lastHeartbeat > 0 && (Date.now() - connectionState.lastHeartbeat < 10000);
  const isHeartbeatTimeout = phase === 'HEARTBEAT_TIMEOUT' || phase === 'NO_MAVLINK_HEARTBEAT' || (isConnected && Date.now() - connectionState.lastHeartbeat > 10000);
  const isWaitingMavlink = (phase === 'WAITING_FOR_MAVLINK' || phase === 'WAITING_FOR_HEARTBEAT' || phase === 'SERIAL_OPEN') && !isConnected;

  // Active Connection State per Mode
  const isEsp32Active = connectionState.connectionType === 'ESP32_WEBSOCKET' && (
    isUsbConnected || 
    isConnected || 
    phase === 'SERIAL_OPEN' || 
    phase === 'WAITING_FOR_MAVLINK' || 
    phase === 'WAITING_FOR_HEARTBEAT' ||
    phase === 'HEARTBEAT_RECEIVED' ||
    phase === 'PIXHAWK_CONNECTED' ||
    phase === 'TELEMETRY_ACTIVE' ||
    phase === 'MAVLINK_CONNECTED'
  );

  const isUsbActive = connectionState.connectionType === 'USB_SERIAL' && (
    isUsbConnected || isConnected || phase === 'SERIAL_OPEN'
  );

  const isUsbDetected = 
    phase !== 'DISCONNECTED' && 
    phase !== 'USB_NOT_DETECTED' && 
    phase !== 'IOS_UNSUPPORTED';

  const isPermissionGranted =
    phase === 'USB_PERMISSION_GRANTED' ||
    phase === 'PERMISSION_GRANTED' ||
    phase === 'SERIAL_OPENING' ||
    phase === 'SERIAL_OPEN' ||
    phase === 'WAITING_FOR_MAVLINK' ||
    phase === 'HEARTBEAT_RECEIVED' ||
    phase === 'PIXHAWK_CONNECTED' ||
    phase === 'TELEMETRY_ACTIVE' ||
    phase === 'OPENING_USB' ||
    phase === 'USB_CONNECTED' ||
    phase === 'WAITING_FOR_HEARTBEAT' ||
    phase === 'MAVLINK_CONNECTED';

  const isPermissionRequested = phase === 'USB_PERMISSION_REQUIRED' || phase === 'REQUESTING_PERMISSION';
  const isPermissionDenied = phase === 'PERMISSION_DENIED';
  const isSerialOpen = isUsbConnected || phase === 'SERIAL_OPEN' || isConnected;

  const handleScan = async () => {
    setIsScanning(true);
    try {
      await mavlinkService.scanUsbDevices();
      await mavlinkService.connectHardware(selectedBaud);
    } finally {
      setIsScanning(false);
    }
  };

  const handleConnectUsb = async () => {
    setIsConnecting(true);
    try {
      await mavlinkService.connectHardware(selectedBaud);
    } catch (e) {
      console.warn('Connect error:', e);
    } finally {
      setIsConnecting(false);
    }
  };

  // Backward compatibility alias for legacy view sections
  const setEsp32Mode = (mode: 'LOCAL' | 'SECURE') => setProtocolMode(mode === 'SECURE' ? 'WSS' : 'WS');

  const handleConnectEsp32 = async () => {
    setIsConnecting(true);
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('esp32_proto_mode', protocolMode);
        localStorage.setItem('esp32_conn_mode', protocolMode === 'WSS' ? 'SECURE' : 'LOCAL');
        localStorage.setItem('esp32_host', esp32Host.trim());
        localStorage.setItem('esp32_port', esp32Port.toString());
        localStorage.setItem('esp32_path', esp32Path.trim());
        localStorage.setItem('esp32_secure_endpoint', esp32SecureEndpoint.trim());
        localStorage.setItem('esp32_relay_token', esp32RelayToken.trim());
        localStorage.setItem('esp32_proto', effectiveProto);
        localStorage.setItem('esp32_baud', selectedBaud.toString());
        localStorage.setItem('esp32_wifi_ssid', wifiSsid.trim());
      }
      
      await mavlinkService.connectEsp32({
        protocolMode,
        mode: protocolMode === 'WSS' ? 'SECURE' : 'LOCAL',
        host: esp32Host.trim(),
        port: esp32Port,
        path: esp32Path.trim(),
        secureEndpoint: esp32SecureEndpoint.trim(),
        relayToken: esp32RelayToken.trim(),
        protocol: effectiveProto,
        baudRate: selectedBaud,
        wifiSsid: wifiSsid.trim()
      });
    } catch (e) {
      console.warn('ESP32 connect error:', e);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleCheckEsp32 = async () => {
    setIsCheckingEsp32(true);
    setEsp32PingResult(null);
    try {
      const result = await mavlinkService.checkEsp32Http(esp32Host.trim(), esp32Port);
      setEsp32PingResult(result);
    } catch (e: any) {
      setEsp32PingResult({ reachable: false, message: e.message || 'Check failed' });
    } finally {
      setIsCheckingEsp32(false);
    }
  };

  const handleRequestPermission = async () => {
    setIsConnecting(true);
    try {
      await mavlinkService.requestUsbPermission();
    } finally {
      setIsConnecting(false);
    }
  };

  const handleConfirmDisconnect = async () => {
    setShowDisconnectConfirm(false);
    setIsConnecting(false);
    await mavlinkService.disconnect();
  };



  const handleBaudChange = (newBaud: number) => {
    setSelectedBaud(newBaud);
    if (isUsbConnected && connectionState.connectionType === 'USB_SERIAL') {
      mavlinkService.connectHardware(newBaud);
    }
  };

  // Format bytes helper
  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // Format last packet age
  const formatPacketAge = () => {
    if (!diag.lastPacketTimestamp || diag.lastPacketTimestamp === 0) return 'Never';
    const ageMs = Date.now() - diag.lastPacketTimestamp;
    if (ageMs < 1000) return `${ageMs}ms ago`;
    return `${(ageMs / 1000).toFixed(1)}s ago`;
  };

  return (
    <>
      <div className={`bg-slate-900/95 border-2 rounded-2xl p-3 sm:p-4.5 shadow-2xl font-mono transition-all ${
        isConnected
          ? 'border-emerald-500/80 shadow-emerald-950/40'
          : isHeartbeatTimeout
          ? 'border-amber-500/80 shadow-amber-950/40'
          : phase === 'PERMISSION_DENIED' || phase === 'SERIAL_OPEN_FAILED' || phase === 'UNSUPPORTED_DEVICE' || phase === 'INTERFACE_NOT_SUPPORTED'
          ? 'border-rose-500/80 shadow-rose-950/40'
          : 'border-slate-700/80 shadow-slate-950/60'
      } ${className}`}>
        
        {/* Compact Mobile Link Status Banner (Phones & Small Screens - Keeps camera/mission visible) */}
        <div className="flex sm:hidden items-center justify-between bg-slate-950/90 px-2.5 py-1.5 rounded-xl border border-slate-800 text-[11px] mb-2 font-mono">
          <div className="flex items-center space-x-1.5">
            <span className={`w-2 h-2 rounded-full ${
              linkState === 'CONNECTED'
                ? 'bg-emerald-400 animate-ping'
                : linkState === 'CONNECTING' || linkState === 'RECONNECTING'
                ? 'bg-amber-400 animate-pulse'
                : linkState === 'ERROR'
                ? 'bg-rose-500'
                : 'bg-slate-500'
            }`} />
            <span className="font-bold text-white uppercase text-[10px]">
              ESP32 ● {linkState === 'CONNECTED' ? 'Connected' : linkState === 'CONNECTING' ? 'Connecting' : linkState === 'RECONNECTING' ? 'Reconnecting' : linkState === 'ERROR' ? 'Error' : 'Offline'}
            </span>
          </div>
          <div className="flex items-center space-x-2 text-[10px]">
            <span className={isWebSocketOpen ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
              WS ● {isWebSocketOpen ? 'Healthy' : 'Closed'}
            </span>
            <span className={isMavlinkHeartbeatReceived ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
              HB ● {isMavlinkHeartbeatReceived ? 'OK' : 'Wait'}
            </span>
            <button
              onClick={() => setIsMobileCollapsed(!isMobileCollapsed)}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-purple-300 font-bold border border-slate-700 transition"
              title={isMobileCollapsed ? 'Expand Connection Panel' : 'Collapse Panel'}
            >
              {isMobileCollapsed ? 'Controls ▼' : 'Hide ▲'}
            </button>
          </div>
        </div>

        {/* Responsive Content Wrapper (Collapsible on Mobile) */}
        <div className={isMobileCollapsed ? 'hidden sm:block' : 'block'}>

        {/* Top Header & Connection Mode Selector */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className={`p-2 rounded-xl border shrink-0 ${
              isConnected
                ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/50'
                : isWaitingMavlink
                ? 'bg-amber-950/80 text-amber-400 border-amber-500/50 animate-pulse'
                : isHeartbeatTimeout
                ? 'bg-amber-950/80 text-amber-400 border-amber-500/50'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}>
              {isEsp32Mode ? (
                <Wifi className="w-4 h-4 sm:w-5 sm:h-5" />
              ) : isSimulated ? (
                <Cpu className="w-4 h-4 sm:w-5 sm:h-5" />
              ) : (
                <Usb className="w-4 h-4 sm:w-5 sm:h-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs sm:text-sm font-black uppercase text-white tracking-wider">
                  {isEsp32Mode ? 'ESP32-S3 WIRELESS MAVLINK' : isSimulated ? 'SITL BENCH SIMULATOR' : 'PIXHAWK USB OTG CONNECTION'}
                </span>
                
                {/* Real-time Status Badge */}
                <span className={`text-[10px] sm:text-[11px] font-black px-2 py-0.5 rounded-full border ${
                  isConnected
                    ? isSimulated
                      ? 'bg-purple-950/80 text-purple-300 border-purple-500/50'
                      : connectionState.connectionType === 'ESP32_WEBSOCKET'
                      ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/60 animate-pulse'
                      : 'bg-emerald-950/90 text-emerald-300 border-emerald-500/60'
                    : isWaitingMavlink
                    ? 'bg-amber-950/80 text-amber-300 border-amber-500/50 animate-pulse'
                    : isHeartbeatTimeout
                    ? 'bg-amber-950/80 text-amber-300 border-amber-500/50'
                    : phase === 'PERMISSION_DENIED'
                    ? 'bg-rose-950/80 text-rose-300 border-rose-500/50'
                    : isUsbConnected
                    ? 'bg-sky-950/80 text-sky-300 border-sky-500/50'
                    : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}>
                  {isConnected
                    ? isSimulated
                      ? 'SIMULATED MAVLINK ✓'
                      : connectionState.connectionType === 'ESP32_WEBSOCKET'
                      ? 'MAVLINK CONNECTED ✓'
                      : 'PIXHAWK CONNECTED ✓'
                    : isWaitingMavlink
                    ? 'WAITING HEARTBEAT ⟳'
                    : isHeartbeatTimeout
                    ? 'HEARTBEAT TIMEOUT ⚠️'
                    : isWebSocketOpen
                    ? 'WEBSOCKET OPEN (WAITING)'
                    : phase === 'PERMISSION_DENIED'
                    ? 'PERMISSION DENIED'
                    : 'DISCONNECTED'}
                </span>

                {/* Page Origin Indicator Badge */}
                <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded border ${
                  isHttpsOrigin 
                    ? 'bg-sky-950 text-sky-300 border-sky-600/50' 
                    : 'bg-emerald-950 text-emerald-300 border-emerald-600/50'
                }`}>
                  {pageProtocol}
                </span>
              </div>
              
              <div className="text-[11px] text-slate-400 truncate max-w-[260px] sm:max-w-md">
                {connectionState.portOrAddress || resolvedTargetUrl}
              </div>
            </div>
          </div>

          {/* Connection Method Selector Tabs */}
          <div className="flex items-center space-x-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs shrink-0">
            <button
              onClick={() => {
                setConnectionMethod('ESP32');
                if (connectionState.connectionType !== 'ESP32_WEBSOCKET') {
                  mavlinkService.disconnect();
                }
              }}
              className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                connectionMethod === 'ESP32'
                  ? 'bg-purple-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Wifi className="w-3.5 h-3.5 text-purple-200" />
              <span>ESP32-S3 Wireless</span>
            </button>
            <button
              onClick={() => {
                setConnectionMethod('USB');
                if (connectionState.connectionType !== 'USB_SERIAL') {
                  mavlinkService.disconnect();
                }
              }}
              className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                connectionMethod === 'USB'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Usb className="w-3.5 h-3.5" />
              <span>USB OTG / Serial</span>
            </button>
            <button
              onClick={() => {
                setConnectionMethod('SIM');
                mavlinkService.switchToSimulationMode();
              }}
              className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer flex items-center space-x-1.5 ${
                isSimulated
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Simulator</span>
            </button>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* SECTION 1: ESP32-S3 WIRELESS MAVLINK DECK (WHEN ESP32 MODE IS ACTIVE)     */}
        {/* ========================================================================= */}
        {connectionMethod === 'ESP32' && (
          <div className="my-3 p-3.5 bg-purple-950/30 border border-purple-500/40 rounded-xl space-y-3">
            
            {/* Top Bar: Protocol Selector [ Auto ] [ WS ] [ WSS ] & Direct Webpage & Help */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-purple-500/20">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wide">
                  PROTOCOL:
                </span>
                
                {/* Protocol Selector: [ Auto ] [ WS ] [ WSS ] or Secure Mode badge on HTTPS */}
                {isHttpsOrigin ? (
                  <div className="flex items-center space-x-1.5 bg-emerald-950/80 px-3 py-1 rounded-xl border border-emerald-500/40 text-emerald-300 text-xs font-black">
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>SECURE MODE (WSS Relay)</span>
                    <span className="text-[10px] text-emerald-400/80 font-normal ml-1">(HTTPS Origin)</span>
                  </div>
                ) : (
                  <div className="flex items-center space-x-1 bg-slate-950 p-1 rounded-xl border border-purple-500/40">
                    <button
                      onClick={() => {
                        setProtocolMode('AUTO');
                        if (typeof window !== 'undefined') localStorage.setItem('esp32_proto_mode', 'AUTO');
                      }}
                      className={`px-3 py-1 rounded-lg text-xs font-black transition cursor-pointer flex items-center space-x-1 ${
                        protocolMode === 'AUTO'
                          ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Auto: HTTP → WS, HTTPS → WSS"
                    >
                      <Zap className="w-3 h-3 text-purple-300" />
                      <span>Auto</span>
                    </button>

                    <button
                      onClick={() => {
                        setProtocolMode('WS');
                        if (typeof window !== 'undefined') {
                          localStorage.setItem('esp32_proto_mode', 'WS');
                          localStorage.setItem('esp32_conn_mode', 'LOCAL');
                        }
                      }}
                      className={`px-3 py-1 rounded-lg text-xs font-black transition cursor-pointer flex items-center space-x-1 ${
                        protocolMode === 'WS'
                          ? 'bg-sky-600 text-white shadow-md shadow-sky-600/30'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Direct local non-TLS WebSocket (ws://) for ESP32"
                    >
                      <span>WS (ws://)</span>
                    </button>

                    <button
                      onClick={() => {
                        setProtocolMode('WSS');
                        if (typeof window !== 'undefined') {
                          localStorage.setItem('esp32_proto_mode', 'WSS');
                          localStorage.setItem('esp32_conn_mode', 'SECURE');
                        }
                      }}
                      className={`px-3 py-1 rounded-lg text-xs font-black transition cursor-pointer flex items-center space-x-1 ${
                        protocolMode === 'WSS'
                          ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Secure TLS WebSocket (wss://) for production server / relay"
                    >
                      <Lock className="w-3 h-3 text-emerald-200" />
                      <span>WSS (wss://)</span>
                    </button>
                  </div>
                )}

                {protocolMode === 'AUTO' && (
                  <span className="text-[10px] text-slate-400 font-mono hidden md:inline">
                    ({pageProtocol} page → {isHttpsOrigin ? 'tries WSS first' : 'direct WS'})
                  </span>
                )}
              </div>

              <div className="flex items-center space-x-2">
                {/* Direct link to ESP32 Webpage for Wi-Fi and setup */}
                <a
                  href={`http://${esp32Host}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-purple-300 hover:text-purple-100 rounded-lg border border-purple-500/40 flex items-center space-x-1 cursor-pointer transition font-bold"
                  title="Open ESP32 Configuration Webpage"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-purple-400" />
                  <span>ESP32 Webpage</span>
                </a>

                <button
                  onClick={handleCheckEsp32}
                  disabled={isCheckingEsp32}
                  className="text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 flex items-center space-x-1 cursor-pointer transition"
                >
                  {isCheckingEsp32 ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                  <span>Check Ping</span>
                </button>

                <button
                  onClick={() => setShowEsp32Guide(true)}
                  className="text-[11px] text-purple-300 hover:text-purple-100 flex items-center space-x-1 underline cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  <span>Guide</span>
                </button>
              </div>
            </div>

            {/* Ping Feedback Banner */}
            {esp32PingResult && (
              <div className={`px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between border ${
                esp32PingResult.reachable
                  ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-300'
                  : 'bg-rose-950/80 border-rose-500/60 text-rose-300'
              }`}>
                <div className="flex items-center space-x-1.5">
                  {esp32PingResult.reachable ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
                  <span>{esp32PingResult.message}</span>
                </div>
                <button onClick={() => setEsp32PingResult(null)} className="text-[10px] text-slate-400 hover:text-white ml-2">✕</button>
              </div>
            )}

            {/* Input Controls Bar: Protocol badge + Host + Port + Path + Baud + Connect/Disconnect */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs items-center">
              
              {/* Protocol Badge */}
              <div className="sm:col-span-2 flex items-center space-x-1 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-700">
                <span className="text-slate-400 text-[10px] font-bold uppercase shrink-0">Proto:</span>
                <span className={`font-mono font-bold text-[11px] ${
                  effectiveProto === 'wss' ? 'text-emerald-300' : 'text-purple-300'
                }`}>
                  {effectiveProto}://
                </span>
              </div>

              {/* ESP32 Host Input */}
              <div className="sm:col-span-3 flex items-center space-x-1.5 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-700">
                <span className="text-slate-400 text-[10px] font-bold uppercase shrink-0">Host:</span>
                <input
                  type="text"
                  value={esp32Host}
                  onChange={(e) => setEsp32Host(e.target.value)}
                  placeholder="192.168.31.194"
                  className="bg-transparent text-slate-100 font-mono text-xs w-full focus:outline-none"
                  title="ESP32 IP or Hostname"
                />
              </div>

              {/* Port Input */}
              <div className="sm:col-span-2 flex items-center space-x-1.5 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-700">
                <span className="text-slate-400 text-[10px] font-bold uppercase shrink-0">Port:</span>
                <input
                  type="number"
                  value={esp32Port}
                  onChange={(e) => setEsp32Port(parseInt(e.target.value, 10) || 8080)}
                  placeholder="8080"
                  className="bg-transparent text-slate-100 font-mono text-xs w-full focus:outline-none"
                />
              </div>

              {/* Path Input */}
              <div className="sm:col-span-2 flex items-center space-x-1.5 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-700">
                <span className="text-slate-400 text-[10px] font-bold uppercase shrink-0">Path:</span>
                <input
                  type="text"
                  value={esp32Path}
                  onChange={(e) => setEsp32Path(e.target.value)}
                  placeholder="/ws"
                  className="bg-transparent text-slate-100 font-mono text-xs w-full focus:outline-none"
                  title="WebSocket Path (default /ws)"
                />
              </div>

              {/* Baud Rate */}
              <div className="sm:col-span-1 flex items-center space-x-1 bg-slate-950 px-2 py-1.5 rounded-lg border border-slate-700">
                <select
                  value={selectedBaud}
                  onChange={(e) => handleBaudChange(Number(e.target.value))}
                  className="bg-transparent text-slate-100 font-mono text-[11px] w-full focus:outline-none cursor-pointer"
                  title="MAVLink Baud Rate"
                >
                  <option value={57600} className="bg-slate-900 text-white">57600</option>
                  <option value={115200} className="bg-slate-900 text-white">115200</option>
                  <option value={921600} className="bg-slate-900 text-white">921600</option>
                  <option value={38400} className="bg-slate-900 text-white">38400</option>
                </select>
              </div>

              {/* Action Button: Connect / Disconnect */}
              <div className="sm:col-span-2">
                {isConnecting ? (
                  <button
                    disabled
                    className="w-full py-2 bg-purple-800 text-purple-200 rounded-lg text-xs font-black uppercase tracking-wide flex items-center justify-center space-x-1.5 opacity-80 cursor-not-allowed"
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>CONNECTING...</span>
                  </button>
                ) : isEsp32Active ? (
                  <button
                    onClick={() => setShowDisconnectConfirm(true)}
                    className="w-full py-2 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white rounded-lg text-xs font-black uppercase tracking-wide transition flex items-center justify-center space-x-1.5 shadow-lg shadow-rose-600/30 cursor-pointer"
                  >
                    <PowerOff className="w-3.5 h-3.5" />
                    <span>DISCONNECT</span>
                  </button>
                ) : (
                  <button
                    onClick={handleConnectEsp32}
                    className="w-full py-2 bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white rounded-lg text-xs font-black uppercase tracking-wide transition flex items-center justify-center space-x-1.5 shadow-lg shadow-purple-600/30 cursor-pointer"
                  >
                    <Wifi className="w-3.5 h-3.5" />
                    <span>CONNECT {protocolMode === 'WSS' ? 'WSS' : 'WS'}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Wi-Fi SSID and Secure Relay Endpoint Configuration */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 bg-slate-950/80 p-2.5 rounded-lg border border-purple-500/30 text-xs">
              <div className="sm:col-span-4 flex items-center space-x-1.5">
                <span className="text-purple-300 font-bold shrink-0 flex items-center space-x-1">
                  <Wifi className="w-3.5 h-3.5 text-purple-400" />
                  <span>Wi-Fi SSID:</span>
                </span>
                <input
                  type="text"
                  value={wifiSsid}
                  onChange={(e) => {
                    const next = e.target.value;
                    setWifiSsid(next);
                    if (typeof window !== 'undefined') localStorage.setItem('esp32_wifi_ssid', next);
                    mavlinkService.setWifiSsid(next);
                  }}
                  placeholder="drone123"
                  className="bg-slate-900 px-2 py-1 rounded text-purple-200 font-mono text-xs w-full border border-slate-700 focus:outline-none focus:border-purple-500"
                  title="Wi-Fi SSID network ESP32 is connected to (e.g. drone123)"
                />
              </div>
              <div className="sm:col-span-5 flex items-center space-x-1.5">
                <span className="text-emerald-400 font-bold shrink-0 flex items-center space-x-1">
                  <Lock className="w-3 h-3" />
                  <span>Cloud WSS Relay:</span>
                </span>
                <input
                  type="text"
                  value={esp32SecureEndpoint}
                  onChange={(e) => setEsp32SecureEndpoint(e.target.value)}
                  placeholder="wss://vishal-done-backup.onrender.com/ws"
                  className="bg-slate-900 px-2 py-1 rounded text-slate-100 font-mono text-xs w-full border border-slate-700 focus:outline-none focus:border-emerald-500"
                  title="Cloud WSS Relay URL (e.g. wss://vishal-done-backup.onrender.com/ws)"
                />
              </div>
              <div className="sm:col-span-3 flex items-center space-x-1.5">
                <span className="text-slate-400 font-bold shrink-0 text-[10px] uppercase">
                  Token:
                </span>
                <input
                  type="password"
                  value={esp32RelayToken}
                  onChange={(e) => setEsp32RelayToken(e.target.value)}
                  placeholder="RELAY_TOKEN"
                  className="bg-slate-900 px-2 py-1 rounded text-slate-100 font-mono text-xs w-full border border-slate-700 focus:outline-none focus:border-emerald-500"
                  title="Shared Secret Token for Secure Relay"
                />
              </div>
            </div>

            {/* Real-Time Status Card */}
            <div className={`p-3 rounded-xl border transition ${
              linkState === 'CONNECTED'
                ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200'
                : linkState === 'CONNECTING'
                ? 'bg-amber-950/40 border-amber-500/50 text-amber-200'
                : linkState === 'RECONNECTING'
                ? 'bg-sky-950/40 border-sky-500/50 text-sky-200'
                : linkState === 'ERROR'
                ? 'bg-rose-950/40 border-rose-500/50 text-rose-200'
                : 'bg-slate-950/80 border-slate-800 text-slate-300'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center space-x-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    linkState === 'CONNECTED'
                      ? 'bg-emerald-400 animate-ping'
                      : linkState === 'CONNECTING'
                      ? 'bg-amber-400 animate-pulse'
                      : linkState === 'RECONNECTING'
                      ? 'bg-sky-400 animate-pulse'
                      : linkState === 'ERROR'
                      ? 'bg-rose-500'
                      : 'bg-slate-500'
                  }`} />
                  <span className="font-mono font-black text-sm uppercase">
                    ● {esp32Mode === 'SECURE' ? 'SECURE MODE — WSS Relay' : 'LOCAL MODE — ESP32 Direct WS'} : {linkState === 'CONNECTED' ? 'CONNECTED' : linkState === 'CONNECTING' ? 'CONNECTING...' : linkState === 'RECONNECTING' ? 'RECONNECTING...' : 'DISCONNECTED'}
                  </span>
                </div>

                {/* State metrics */}
                <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                  <div>
                    <span className="text-slate-400">Mode: </span>
                    <span className={`font-bold ${esp32Mode === 'SECURE' ? 'text-emerald-300' : 'text-sky-300'}`}>
                      {esp32Mode === 'SECURE' ? 'SECURE (WSS)' : 'LOCAL (WS)'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">WS Link: </span>
                    <span className="font-bold text-white">
                      {isWebSocketOpen ? 'OPEN' : isConnecting ? 'CONNECTING' : 'CLOSED'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">Heartbeat: </span>
                    <span className={`font-bold ${
                      isMavlinkHeartbeatReceived ? 'text-emerald-400' : isWaitingMavlink ? 'text-amber-400' : 'text-slate-400'
                    }`}>
                      {isMavlinkHeartbeatReceived ? 'Healthy' : isWaitingMavlink ? 'Waiting' : 'None'}
                    </span>
                  </div>
                  {latencyMs > 0 && (
                    <div>
                      <span className="text-slate-400">Latency: </span>
                      <span className="font-bold text-cyan-300">{latencyMs} ms</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Informative Failure Category Banners (Requirement 11) */}
              {(connectionState.esp32ErrorCategory === 'RELAY_UNAVAILABLE' || connectionState.esp32ErrorMessage?.includes('Secure relay unavailable')) && (
                <div className="mt-2.5 pt-2 border-t border-rose-500/30 text-xs text-rose-300 flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <strong className="text-rose-200">Secure relay unavailable.</strong>
                    <div className="text-[11px] text-slate-300 mt-0.5">
                      Could not establish connection to the Secure WSS Relay. Check that your cloud relay server is running and <code>VITE_SECURE_RELAY_URL</code> is set.
                    </div>
                  </div>
                </div>
              )}

              {connectionState.esp32ErrorCategory === 'CONNECTOR_OFFLINE' && (
                <div className="mt-2.5 pt-2 border-t border-amber-500/30 text-xs text-amber-300 flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <strong className="text-amber-200">Awaiting ESP32 Cloud Connection...</strong>
                    <div className="text-[11px] text-slate-300 mt-0.5">
                      Cloud relay is online and listening. Power on your ESP32-S3 with your Phone Hotspot enabled — it will dial directly into this cloud relay with no laptop required.
                    </div>
                  </div>
                </div>
              )}

              {connectionState.esp32ErrorCategory === 'ESP32_UNAVAILABLE' && (
                <div className="mt-2.5 pt-2 border-t border-amber-500/30 text-xs text-amber-300 flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <strong className="text-amber-200">ESP32 unavailable.</strong>
                    <div className="text-[11px] text-slate-300 mt-0.5">
                      The local connector cannot reach the ESP32 at {esp32Host}:{esp32Port}. Verify ESP32 power and Wi-Fi connection.
                    </div>
                  </div>
                </div>
              )}

              {connectionState.esp32ErrorCategory === 'MIXED_CONTENT_BLOCK' && (
                <div className="mt-2.5 pt-2 border-t border-rose-500/30 text-xs text-rose-200 flex items-start space-x-2">
                  <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <strong className="text-rose-100">Browser Mixed Content Block:</strong>
                    <div className="text-[11px] text-slate-300 mt-0.5">
                      Browsers block insecure ws:// connections from HTTPS ({window.location.origin}). Please use SECURE mode with a WSS relay or open Ground Station on http://.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Connection Path Hop Visualizer (Requirement 8) */}
            <div className="p-3 bg-slate-950/90 rounded-xl border border-slate-800 space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-black uppercase text-slate-300 flex items-center space-x-1.5">
                  <Activity className="w-3.5 h-3.5 text-purple-400" />
                  <span>CONNECTION PATH</span>
                </span>
                <span className="text-[10px] text-purple-300 font-mono">
                  {esp32Mode === 'SECURE' ? 'SECURE MODE (WSS Relay)' : 'LOCAL MODE (Direct WS)'}
                </span>
              </div>

              {esp32Mode === 'SECURE' ? (
                /* Multi-hop path: Browser -> WSS Relay -> Local Connector -> ESP32 */
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 text-center text-[11px]">
                  <div className="p-2 rounded-lg border bg-slate-900 border-slate-800 flex flex-col items-center">
                    <span className="font-bold text-emerald-400 flex items-center space-x-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                      <span>Browser</span>
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5">HTTPS Netlify</span>
                  </div>

                  <div className={`p-2 rounded-lg border flex flex-col items-center ${
                    isWebSocketOpen
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}>
                    <span className="font-bold flex items-center space-x-1">
                      <span className={`w-2 h-2 rounded-full ${isWebSocketOpen ? 'bg-emerald-400' : 'bg-slate-600'}`}></span>
                      <span>WSS Relay</span>
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5 truncate max-w-[120px]" title={esp32SecureEndpoint || 'Cloud Relay'}>
                      {isWebSocketOpen ? 'Connected ✓' : 'Cloud Relay'}
                    </span>
                  </div>

                  <div className={`p-2 rounded-lg border flex flex-col items-center ${
                    isWebSocketOpen && connectionState.esp32ConnectorOnline
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : isWebSocketOpen && !connectionState.esp32ConnectorOnline
                      ? 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}>
                    <span className="font-bold flex items-center space-x-1">
                      <span className={`w-2 h-2 rounded-full ${
                        isWebSocketOpen && connectionState.esp32ConnectorOnline
                          ? 'bg-emerald-400'
                          : isWebSocketOpen
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-slate-600'
                      }`}></span>
                      <span>Local Connector</span>
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5">
                      {isWebSocketOpen && connectionState.esp32ConnectorOnline ? 'Online ✓' : 'Local Agent'}
                    </span>
                  </div>

                  <div className={`p-2 rounded-lg border flex flex-col items-center ${
                    isWebSocketOpen && connectionState.esp32DeviceOnline
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : isWebSocketOpen && !connectionState.esp32DeviceOnline
                      ? 'bg-rose-950/30 border-rose-500/30 text-rose-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}>
                    <span className="font-bold flex items-center space-x-1">
                      <span className={`w-2 h-2 rounded-full ${
                        isWebSocketOpen && connectionState.esp32DeviceOnline
                          ? 'bg-emerald-400'
                          : isWebSocketOpen
                          ? 'bg-rose-400'
                          : 'bg-slate-600'
                      }`}></span>
                      <span>ESP32</span>
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5">
                      {isWebSocketOpen && connectionState.esp32DeviceOnline ? 'Bridged ✓' : 'LAN 192.168.x.x'}
                    </span>
                  </div>
                </div>
              ) : (
                /* Direct local path */
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-center text-[11px]">
                  <div className="p-2 rounded-lg border bg-slate-900 border-slate-800 flex flex-col items-center">
                    <span className="font-bold text-sky-400 flex items-center space-x-1">
                      <span className="w-2 h-2 rounded-full bg-sky-400"></span>
                      <span>Browser</span>
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5">Local Origin (http://)</span>
                  </div>

                  <div className={`p-2 rounded-lg border flex flex-col items-center ${
                    isWebSocketOpen
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-900 border-slate-800 text-slate-400'
                  }`}>
                    <span className="font-bold flex items-center space-x-1">
                      <span className={`w-2 h-2 rounded-full ${isWebSocketOpen ? 'bg-emerald-400' : 'bg-slate-600'}`}></span>
                      <span>ESP32 Direct WS</span>
                    </span>
                    <span className="text-[9px] text-slate-400 mt-0.5 font-mono">
                      {esp32Host}:{esp32Port}{cleanPath}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* ========================================================================= */}
            {/* SECTION 9: RESPONSIVE CONNECTION STATUS MATRIX & PERSISTENCE SUMMARY      */}
            {/* ========================================================================= */}
            <div className="bg-slate-950/90 rounded-xl p-3 border border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between text-[11px] pb-1.5 border-b border-slate-800">
                <span className="font-black uppercase text-slate-300 flex items-center space-x-1.5">
                  <Activity className="w-3.5 h-3.5 text-purple-400" />
                  <span>CONNECTION STATUS (PERSISTENT &amp; INDEPENDENT LAYERS)</span>
                </span>
                <span className="text-[10px] text-slate-400 font-mono">
                  {pageProtocol} Origin
                </span>
              </div>

              {/* Status Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-[11px]">
                
                {/* 1. Wi-Fi Layer State (Persistent across reload) */}
                <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">Wi-Fi Network</div>
                    <div className="text-purple-300 font-bold truncate mt-0.5" title={wifiSsid || 'drone123'}>
                      {wifiSsid || 'drone123'}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${
                    isWifiConfigured
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      : 'bg-slate-800 text-slate-400'
                  }`}>
                    {isWifiConfigured ? 'CONNECTED ✓' : 'NOT CONFIGURED'}
                  </span>
                </div>

                {/* 2. ESP32 Host Endpoint */}
                <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">ESP32 Target Endpoint</div>
                    <div className="text-slate-200 font-mono text-[10px] truncate mt-0.5" title={resolvedTargetUrl}>
                      {resolvedTargetUrl}
                    </div>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-slate-800 text-slate-300">
                    {esp32Mode}
                  </span>
                </div>

                {/* 3. WebSocket Link Layer */}
                <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">WebSocket Link</div>
                    <div className={`font-bold mt-0.5 ${
                      isWebSocketOpen ? 'text-emerald-400' : isConnecting ? 'text-amber-400' : 'text-slate-400'
                    }`}>
                      {isWebSocketOpen ? 'CONNECTED ✓' : isConnecting ? 'RECONNECTING...' : 'DISCONNECTED'}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${
                    isWebSocketOpen
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      : isConnecting
                      ? 'bg-amber-950 text-amber-300 border border-amber-500/40 animate-pulse'
                      : 'bg-rose-950/60 text-rose-300 border border-rose-500/30'
                  }`}>
                    {isWebSocketOpen ? 'OPEN' : isConnecting ? 'CONNECTING' : 'CLOSED'}
                  </span>
                </div>

                {/* 4. MAVLink Autopilot Stream */}
                <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">MAVLink Telemetry</div>
                    <div className="font-bold text-slate-200 mt-0.5">
                      SysID: <span className="text-emerald-300">{connectionState.systemId || 1}</span> | Comp: <span className="text-emerald-300">{connectionState.componentId || 1}</span>
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${
                    isConnected
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      : isWaitingMavlink
                      ? 'bg-amber-950 text-amber-300 border border-amber-500/40 animate-pulse'
                      : 'bg-slate-800 text-slate-400'
                  }`}>
                    {isConnected ? 'CONNECTED ✓' : isWaitingMavlink ? 'WAITING ⟳' : 'DISCONNECTED'}
                  </span>
                </div>

                {/* 5. Heartbeat Rate */}
                <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">Heartbeat Stream</div>
                    <div className={`font-bold mt-0.5 ${
                      isMavlinkHeartbeatReceived ? 'text-emerald-400' : 'text-amber-400'
                    }`}>
                      {isMavlinkHeartbeatReceived ? `RECEIVED (${connectionState.heartbeatHz || 1.0} Hz)` : 'NOT RECEIVED'}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${
                    isMavlinkHeartbeatReceived
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                      : 'bg-amber-950 text-amber-300 border border-amber-500/40'
                  }`}>
                    {isMavlinkHeartbeatReceived ? 'ACTIVE' : 'IDLE'}
                  </span>
                </div>

                {/* 6. Cumulative RX / TX */}
                <div className="bg-slate-900/90 p-2 rounded-lg border border-slate-800 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-slate-400 uppercase font-bold">Cumulative RX / TX</div>
                    <div className="font-bold text-slate-200 mt-0.5">
                      <span className="text-emerald-400">{formatBytes(connectionState.bytesReceived)}</span>
                      <span className="text-slate-500"> / </span>
                      <span className="text-sky-400">{formatBytes(connectionState.bytesSent)}</span>
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {diag.totalPacketsReceived} pkts
                  </span>
                </div>

              </div>

              {/* Bottom Persistence Note */}
              <div className="text-[10px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/80">
                <span>ℹ️ Browser refresh only reloads UI. Wi-Fi connection on ESP32 is persistent.</span>
                <button
                  onClick={() => setShowDevDetails(!showDevDetails)}
                  className="text-purple-300 hover:text-purple-100 underline cursor-pointer"
                >
                  {showDevDetails ? 'Hide Diagnostics' : 'Show Diagnostics'}
                </button>
              </div>
            </div>

            {/* Contextual Guidance Banners */}
            {isHttpsOrigin && esp32Mode === 'LOCAL' ? (
              /* HTTPS Mixed-Content Warning */
              <div className="p-3 bg-amber-950/80 border border-amber-500/70 rounded-xl text-amber-200 text-xs space-y-1.5">
                <div className="flex items-center space-x-1.5 font-bold text-amber-300">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>HTTPS Mixed Content Limitation (Local ws:// Blocked by Browser)</span>
                </div>
                <p className="text-[11px] text-amber-200/90 leading-relaxed">
                  This Ground Station page is loaded over <strong>HTTPS</strong> (<code>{window.location.origin}</code>). Modern web browsers block plain <code>ws://</code> connections from secure HTTPS origins to prevent mixed-content vulnerabilities.
                </p>
                <div className="text-[11px] text-amber-300 space-y-1 pt-1 border-t border-amber-500/30">
                  <div>• <strong>For Local Hardware Testing:</strong> Open Ground Station on <code>http://</code> origin (e.g. <code>http://localhost:5173</code>, <code>http://192.168.x.x:5173</code>) or run the native Android build.</div>
                  <div>• <strong>For Deployed Production App:</strong> Switch to <strong>SECURE (wss://)</strong> mode with a TLS reverse-proxy relay.</div>
                </div>
              </div>
            ) : esp32Mode === 'SECURE' ? (
              /* Secure WSS Production Architecture Information */
              <div className="p-3 bg-emerald-950/50 border border-emerald-500/50 rounded-xl text-emerald-200 text-xs space-y-1.5">
                <div className="flex items-center space-x-1.5 font-bold text-emerald-300">
                  <Lock className="w-4 h-4 shrink-0" />
                  <span>Secure WSS Relay Architecture (Zero Port-Forwarding)</span>
                </div>
                <p className="text-[11px] text-emerald-200/90 leading-relaxed">
                  The browser connects securely via WSS to the cloud relay. The local connector agent running on your ESP32 Wi-Fi bridges packets outbound to the relay and forwards to the ESP32 via local WS.
                </p>
                <div className="text-[11px] font-mono text-emerald-300/90 bg-slate-950/80 p-2 rounded border border-emerald-500/30">
                  HTTPS Web GCS (Netlify) ➔ Cloud Relay (WSS) ➔ Local Connector (Outbound WSS) ➔ ESP32 (LAN ws://) ➔ Pixhawk
                </div>
              </div>
            ) : null}

            {/* Collapsible Developer Diagnostics Bar */}
            {showDevDetails && (
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-[11px] space-y-2 text-slate-300">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div><strong className="text-slate-400">Page Origin:</strong> {window.location.origin}</div>
                  <div><strong className="text-slate-400">Page Protocol:</strong> {pageProtocol}</div>
                  <div><strong className="text-slate-400">Connection Mode:</strong> {esp32Mode}</div>
                  <div><strong className="text-slate-400">Target URL:</strong> {resolvedTargetUrl}</div>
                  <div><strong className="text-slate-400">Wi-Fi SSID:</strong> {wifiSsid || 'None'}</div>
                  <div><strong className="text-slate-400">WS Link State:</strong> {isWebSocketOpen ? 'OPEN (ReadyState 1)' : 'CLOSED (ReadyState 3)'}</div>
                  <div><strong className="text-slate-400">SysID / CompID:</strong> {connectionState.systemId || '—'} / {connectionState.componentId || '—'}</div>
                  <div><strong className="text-slate-400">RX Exact:</strong> {connectionState.bytesReceived} bytes</div>
                  <div><strong className="text-slate-400">TX Exact:</strong> {connectionState.bytesSent} bytes</div>
                  <div><strong className="text-slate-400">Last Msg:</strong> {diag.lastMavlinkMessageName ? `${diag.lastMavlinkMessageName} (#${diag.lastMavlinkMessageId})` : '—'}</div>
                  <div className="col-span-2"><strong className="text-slate-400">Phase Message:</strong> <span className="text-purple-300">{connectionState.phaseMessage}</span></div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================================= */}
        {/* SECTION 2: DIRECT USB OTG / SERIAL CONTROLS                               */}
        {/* ========================================================================= */}
        {connectionMethod === 'USB' && (
          <>
            {/* Dedicated Responsive State Cards Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 my-3 text-[11px]">
              
              {/* 1. USB Status */}
              <div className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                isUsbDetected || isConnected
                  ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}>
                <span className="text-[10px] uppercase text-slate-500 font-bold">USB Host</span>
                <div className="flex items-center space-x-1.5 mt-1 font-bold">
                  {isConnected || isUsbConnected ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="text-emerald-300">Connected ✓</span>
                    </>
                  ) : isUsbDetected ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="text-sky-300">Device Detected</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>Not Detected</span>
                    </>
                  )}
                </div>
              </div>

              {/* 2. Device Identity */}
              <div className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                isUsbDetected || isConnected
                  ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}>
                <span className="text-[10px] uppercase text-slate-500 font-bold">Device</span>
                <div className="flex items-center space-x-1.5 mt-1 font-bold">
                  {isUsbDetected || isConnected ? (
                    <span className="text-emerald-300 truncate" title={diag.productName || 'Pixhawk / USB Serial'}>
                      {diag.productName || 'Pixhawk / USB Serial'}
                    </span>
                  ) : (
                    <span className="text-slate-500 font-bold">—</span>
                  )}
                </div>
              </div>

              {/* 3. USB Permission */}
              <div className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                isPermissionGranted || isConnected
                  ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                  : isPermissionRequested
                  ? 'bg-slate-950/80 border-amber-500/50 text-amber-300'
                  : isPermissionDenied
                  ? 'bg-rose-950/40 border-rose-500/50 text-rose-300'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}>
                <span className="text-[10px] uppercase text-slate-500 font-bold">Permission</span>
                <div className="flex items-center space-x-1.5 mt-1 font-bold">
                  {isPermissionGranted || isConnected ? (
                    <span className="text-emerald-300">Granted ✓</span>
                  ) : isPermissionRequested ? (
                    <span className="text-amber-300">Requesting...</span>
                  ) : isPermissionDenied ? (
                    <span className="text-rose-300">Denied</span>
                  ) : (
                    <span className="text-slate-500 font-bold">—</span>
                  )}
                </div>
              </div>

              {/* 4. Serial Baud */}
              <div className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                isSerialOpen || isConnected
                  ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}>
                <span className="text-[10px] uppercase text-slate-500 font-bold">Serial Baud</span>
                <div className="flex items-center space-x-1.5 mt-1 font-bold">
                  {isSerialOpen || isConnected ? (
                    <span className="text-emerald-300">{selectedBaud} Baud</span>
                  ) : (
                    <span className="text-slate-500 font-bold">—</span>
                  )}
                </div>
              </div>

              {/* 5. MAVLink Status */}
              <div className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                isConnected
                  ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                  : isWaitingMavlink
                  ? 'bg-slate-950/80 border-amber-500/50 text-amber-300'
                  : isHeartbeatTimeout
                  ? 'bg-amber-950/40 border-amber-500/50 text-amber-300'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}>
                <span className="text-[10px] uppercase text-slate-500 font-bold">MAVLink</span>
                <div className="flex items-center space-x-1.5 mt-1 font-bold">
                  {isConnected ? (
                    <span className="text-emerald-300">Connected ✓</span>
                  ) : isWaitingMavlink ? (
                    <span className="text-amber-300">Waiting...</span>
                  ) : (
                    <span className="text-slate-500 font-bold">—</span>
                  )}
                </div>
              </div>

              {/* 6. Heartbeat Stream */}
              <div className={`p-2.5 rounded-xl border flex flex-col justify-between ${
                isConnected
                  ? 'bg-slate-950/80 border-emerald-500/40 text-slate-200'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}>
                <span className="text-[10px] uppercase text-slate-500 font-bold">Heartbeat</span>
                <div className="flex items-center space-x-1.5 mt-1 font-bold">
                  {isConnected ? (
                    <span className="text-emerald-300">SysID {connectionState.systemId || 1} ({connectionState.heartbeatHz || 1.0} Hz)</span>
                  ) : (
                    <span className="text-slate-500 font-bold">—</span>
                  )}
                </div>
              </div>
            </div>

            {/* Action Controls Bar for Direct USB OTG Mode */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
              <div className="flex items-center space-x-2 text-xs">
                <span className="text-slate-400 font-bold uppercase text-[10px]">Baud:</span>
                <select
                  value={selectedBaud}
                  onChange={(e) => handleBaudChange(Number(e.target.value))}
                  className="bg-slate-950 text-slate-200 text-xs px-2.5 py-1 rounded-lg border border-slate-700 cursor-pointer"
                >
                  <option value={57600}>57600 (Default Telemetry)</option>
                  <option value={115200}>115200 (USB / High-Speed)</option>
                  <option value={921600}>921600 (Fast UART)</option>
                  <option value={38400}>38400 (Legacy)</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                {isConnecting ? (
                  <button
                    disabled
                    className="px-3.5 py-1.5 bg-emerald-800 text-emerald-200 rounded-lg text-xs font-black uppercase tracking-wide flex items-center space-x-1.5 opacity-80 cursor-not-allowed"
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>CONNECTING...</span>
                  </button>
                ) : isUsbActive ? (
                  <button
                    onClick={() => setShowDisconnectConfirm(true)}
                    className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white rounded-lg text-xs font-black uppercase tracking-wide transition flex items-center justify-center space-x-1.5 shadow-lg shadow-rose-600/30 cursor-pointer"
                  >
                    <PowerOff className="w-3.5 h-3.5" />
                    <span>DISCONNECT</span>
                  </button>
                ) : !isUsbDetected && !isConnected ? (
                  <button
                    onClick={handleScan}
                    disabled={isScanning}
                    className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-black uppercase tracking-wide transition flex items-center space-x-1.5 shadow-lg shadow-sky-600/30 cursor-pointer"
                  >
                    {isScanning ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Search className="w-3.5 h-3.5" />
                    )}
                    <span>SCAN USB DEVICES</span>
                  </button>
                ) : (
                  <button
                    onClick={handleConnectUsb}
                    className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-lg text-xs font-black uppercase tracking-wide transition flex items-center space-x-1.5 shadow-lg shadow-emerald-600/30 cursor-pointer animate-pulse"
                  >
                    <Usb className="w-3.5 h-3.5" />
                    <span>CONNECT PIXHAWK</span>
                  </button>
                )}

                <button
                  onClick={() => setShowDiagnostics(true)}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-sky-400 rounded-lg text-xs font-bold transition flex items-center space-x-1 border border-slate-700 cursor-pointer"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Diagnostics</span>
                </button>

                {onOpenHelp && (
                  <button
                    onClick={onOpenHelp}
                    className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-xs font-bold transition flex items-center space-x-1 border border-slate-700 cursor-pointer"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">OTG Guide</span>
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Real-time Connection Error & Diagnostic Notification Panels */}
        {phase === 'SERIAL_OPEN_FAILED' && connectionState.errorMessage ? (
          <div className="mt-3 p-3 bg-rose-950/60 border border-rose-500/70 rounded-xl text-xs text-rose-200 space-y-2">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <strong className="text-rose-300">Connection Error Encountered</strong>
                <p className="text-[11px] text-rose-200 mt-0.5 leading-relaxed">
                  {connectionState.errorMessage}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-rose-500/30">
              <span className="text-[10px] text-rose-300/80">
                {isEsp32Mode && isHttpsOrigin && esp32Mode === 'LOCAL' 
                  ? 'Switch to SECURE mode or open Ground Station on http:// origin.'
                  : 'Check network reachability, baud rate, and TLS settings.'}
              </span>
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={isEsp32Mode ? handleConnectEsp32 : handleConnectUsb}
                  className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-[11px] cursor-pointer"
                >
                  Retry
                </button>
                <button
                  onClick={() => setShowDiagnostics(true)}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-lg text-[11px] border border-slate-700 cursor-pointer"
                >
                  View Logs
                </button>
              </div>
            </div>
          </div>
        ) : isHeartbeatTimeout ? (
          <div className="mt-3 p-3 bg-amber-950/50 border border-amber-500/50 rounded-xl text-xs text-amber-200 space-y-2">
            <div className="flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <strong className="text-amber-300">
                  {isEsp32Mode ? 'ESP32 connected, but Pixhawk MAVLink heartbeat not received.' : 'USB connected, but no MAVLink heartbeat received.'}
                </strong>
                <p className="text-[11px] text-amber-300/80 mt-0.5">
                  The transport link is active, but the Pixhawk autopilot is not returning valid MAVLink heartbeat packets. Check TELEM2 UART wiring (TX➔RX, RX➔TX, GND➔GND) and verify Pixhawk power.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-amber-300/70">Verify TELEM2 baud rate = 57600 (SERIAL2_BAUD = 57).</span>
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={isEsp32Mode ? handleConnectEsp32 : handleConnectUsb}
                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg text-[11px] cursor-pointer"
                >
                  Retry
                </button>
                <button
                  onClick={() => setShowDiagnostics(true)}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-lg text-[11px] border border-slate-700 cursor-pointer"
                >
                  Inspect
                </button>
              </div>
            </div>
          </div>
        ) : phase === 'PERMISSION_DENIED' ? (
          <div className="mt-3 p-3 bg-rose-950/50 border border-rose-500/50 rounded-xl flex items-center justify-between text-xs text-rose-200">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>USB permission denied. Please allow USB access on your phone.</span>
            </div>
            <button
              onClick={handleRequestPermission}
              className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-xs cursor-pointer"
            >
              Request Permission
            </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* MODAL 1: EXPLICIT DISCONNECT CONFIRMATION MODAL                           */}
      {/* ========================================================================= */}
      {showDisconnectConfirm && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 font-mono select-none">
          <div className="bg-slate-900 border-2 border-rose-500/60 rounded-2xl max-w-md w-full p-4 sm:p-6 space-y-4 text-slate-200 shadow-2xl">
            <div className="flex items-start space-x-3">
              <div className="p-2.5 bg-rose-950/80 border border-rose-500/50 rounded-xl text-rose-400 shrink-0">
                <PowerOff className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-white uppercase tracking-wide">
                  Disconnect from ESP32?
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  This will close the Ground Station MAVLink WebSocket session.
                </p>
              </div>
            </div>

            <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-[11px] text-slate-300 space-y-1.5">
              <div className="flex items-center space-x-1.5 text-emerald-400 font-bold">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>ESP32 Wi-Fi will REMAIN CONNECTED</span>
              </div>
              <p className="text-slate-400 text-[10px] leading-relaxed">
                Disconnecting from the browser does NOT erase Wi-Fi settings or restart the ESP32. You can reconnect at any time by pressing <strong>CONNECT</strong>.
              </p>
            </div>

            <div className="flex items-center space-x-2 pt-2">
              <button
                onClick={() => setShowDisconnectConfirm(false)}
                className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition cursor-pointer"
              >
                CANCEL
              </button>
              <button
                onClick={handleConfirmDisconnect}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-black text-xs rounded-xl transition flex items-center justify-center space-x-1.5 shadow-lg shadow-rose-600/30 cursor-pointer"
              >
                <PowerOff className="w-4 h-4" />
                <span>DISCONNECT</span>
              </button>
            </div>
          </div>
        </div>
      )}



      {/* ========================================================================= */}
      {/* MODAL 4: ESP32-S3 PROVISIONING, WIRING & PRODUCTION WSS ARCHITECTURE MODAL */}
      {/* ========================================================================= */}
      {showEsp32Guide && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 font-mono">
          <div className="bg-slate-900 border-2 border-purple-500/60 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-4 sm:p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2.5">
                <div className="p-2 bg-purple-950 rounded-xl border border-purple-500/50 text-purple-400">
                  <Wifi className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-black text-sm sm:text-base text-white uppercase tracking-wider">
                    ESP32-S3 Wireless Bridge &amp; Production Architecture
                  </h3>
                  <p className="text-xs text-purple-300">Local HTTP vs Deployed HTTPS (WSS) Connectivity</p>
                </div>
              </div>
              <button
                onClick={() => setShowEsp32Guide(false)}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* 1. Architecture: Local vs Production HTTPS */}
            <div className="space-y-2">
              <div className="text-xs font-black uppercase text-purple-300 flex items-center space-x-1.5">
                <Network className="w-4 h-4" />
                <span>1. Network Architecture (LOCAL vs PRODUCTION)</span>
              </div>
              <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-[11px] text-slate-300 space-y-3">
                
                {/* Local HTTP Architecture */}
                <div className="p-2.5 bg-slate-900/90 rounded-lg border border-purple-500/30 space-y-1">
                  <div className="font-bold text-purple-300 flex items-center space-x-1">
                    <span>A. LOCAL DEVELOPMENT (Working Hardware Test)</span>
                  </div>
                  <div className="font-mono text-emerald-400 text-[10px] p-2 bg-black/60 rounded">
                    http://ESP32-IP (or http://localhost:5173 / Android App)<br/>
                    &nbsp;&nbsp;&nbsp;&nbsp;↓<br/>
                    ws://ESP32-IP:8080<br/>
                    &nbsp;&nbsp;&nbsp;&nbsp;↓<br/>
                    ESP32-S3 Bridge ➔ Pixhawk TELEM2 (UART @ 57600)
                  </div>
                  <p className="text-[10px] text-slate-400">
                    Direct local WebSocket connection. Works when Ground Station is running on <code>http://</code> or native Android app.
                  </p>
                </div>

                {/* Production HTTPS Architecture */}
                <div className="p-2.5 bg-slate-900/90 rounded-lg border border-emerald-500/30 space-y-1">
                  <div className="font-bold text-emerald-300 flex items-center space-x-1">
                    <Lock className="w-3.5 h-3.5" />
                    <span>B. PRODUCTION DEPLOYED HTTPS (Netlify / Cloud)</span>
                  </div>
                  <div className="font-mono text-sky-400 text-[10px] p-2 bg-black/60 rounded">
                    HTTPS Web Ground Station (https://my-app.netlify.app)<br/>
                    &nbsp;&nbsp;&nbsp;&nbsp;↓ (Secure WSS over TLS)<br/>
                    wss://relay.yourdomain.com:8443 (Cloud / TLS Reverse Proxy)<br/>
                    &nbsp;&nbsp;&nbsp;&nbsp;↓ (Forwarded to LAN or VPN)<br/>
                    ESP32-S3 Bridge ➔ Pixhawk TELEM2 (UART @ 57600)
                  </div>
                  <p className="text-[10px] text-slate-400">
                    A deployed HTTPS web application cannot directly reach raw LAN IP addresses (like <code>192.168.10.109</code>) with <code>wss://</code> without a valid SSL/TLS certificate. Production uses a TLS reverse proxy or relay.
                  </p>
                </div>
              </div>
            </div>

            {/* 2. Hardware Architecture & Wiring */}
            <div className="space-y-2">
              <div className="text-xs font-black uppercase text-purple-300 flex items-center space-x-1.5">
                <Cable className="w-4 h-4" />
                <span>2. Pixhawk 2.4.8 TELEM2 Pinout &amp; Wiring</span>
              </div>
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-[11px] text-slate-300 space-y-2">
                <table className="w-full text-left border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-bold">
                      <th className="py-1">TELEM2 Pin</th>
                      <th className="py-1">Signal</th>
                      <th className="py-1">ESP32-S3 Target Pin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-200">
                    <tr>
                      <td className="py-1 font-bold text-amber-400">Pin 1</td>
                      <td>+5V Power</td>
                      <td className="font-bold text-emerald-400">ESP32-S3 5V/VIN Input</td>
                    </tr>
                    <tr>
                      <td className="py-1 font-bold text-sky-400">Pin 2</td>
                      <td>TX (Transmit)</td>
                      <td className="font-bold text-sky-300">ESP32-S3 RX (UART Pin)</td>
                    </tr>
                    <tr>
                      <td className="py-1 font-bold text-sky-400">Pin 3</td>
                      <td>RX (Receive)</td>
                      <td className="font-bold text-sky-300">ESP32-S3 TX (UART Pin)</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-slate-500">Pin 4</td>
                      <td>CTS</td>
                      <td className="text-slate-500">NOT CONNECTED</td>
                    </tr>
                    <tr>
                      <td className="py-1 text-slate-500">Pin 5</td>
                      <td>RTS</td>
                      <td className="text-slate-500">NOT CONNECTED</td>
                    </tr>
                    <tr>
                      <td className="py-1 font-bold text-slate-400">Pin 6</td>
                      <td>GND</td>
                      <td className="font-bold text-slate-300">ESP32-S3 GND</td>
                    </tr>
                  </tbody>
                </table>
                <div className="p-2 bg-rose-950/50 border border-rose-500/40 rounded-lg text-rose-300 text-[10px]">
                  ⚠️ <strong>SAFETY CAUTION:</strong> Do NOT connect Pixhawk 5V output to the ESP32 3.3V pin. Connect to ESP32 5V / VIN pin only.
                </div>
              </div>
            </div>

            {/* 3. Pixhawk ArduPilot Parameter Config */}
            <div className="space-y-2">
              <div className="text-xs font-black uppercase text-purple-300 flex items-center space-x-1.5">
                <Sliders className="w-4 h-4" />
                <span>3. Pixhawk Parameters for TELEM2</span>
              </div>
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-[11px] text-slate-300 space-y-1">
                <div>• <strong>SERIAL2_PROTOCOL = 2</strong> (MAVLink2)</div>
                <div>• <strong>SERIAL2_BAUD = 57</strong> (57600 baud rate)</div>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setShowEsp32Guide(false)}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs rounded-xl transition cursor-pointer"
              >
                Got It, Close Guide
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Connection Diagnostics Screen Modal */}
      <SerialDiagnosticsModal
        isOpen={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        connectionState={connectionState}
      />
    </>
  );
};
