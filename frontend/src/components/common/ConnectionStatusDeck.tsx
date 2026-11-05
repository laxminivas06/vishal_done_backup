import React from 'react';
import { PixhawkConnectionState } from '../../types/mavlink';
import { RunnerLinkState } from '../../types/runner';
import { DroneTelemetry } from '../../types/mission';
import { Wifi, Radio, Activity, Video, Smartphone, Cpu, Signal } from 'lucide-react';

interface ConnectionStatusDeckProps {
  pixhawkState: PixhawkConnectionState;
  runnerLink: RunnerLinkState;
  telemetry: DroneTelemetry;
  videoState?: 'LIVE' | 'CONNECTING' | 'DISCONNECTED';
}

interface StatusItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  status: 'ok' | 'warn' | 'error' | 'idle';
}

const StatusItem: React.FC<StatusItemProps> = ({ icon, label, value, status }) => {
  const colors = {
    ok: 'text-emerald-400 bg-emerald-950/50 border-emerald-500/30',
    warn: 'text-amber-400 bg-amber-950/50 border-amber-500/30 animate-pulse',
    error: 'text-rose-400 bg-rose-950/50 border-rose-500/30',
    idle: 'text-slate-400 bg-slate-800/50 border-slate-700/50',
  };

  const dotColors = {
    ok: 'bg-emerald-400',
    warn: 'bg-amber-400 animate-ping',
    error: 'bg-rose-400',
    idle: 'bg-slate-500',
  };

  return (
    <div className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg border text-[11px] font-mono ${colors[status]}`}>
      <div className="flex items-center space-x-1.5">
        <span className="opacity-80">{icon}</span>
        <span className="font-bold uppercase text-[10px] tracking-wide text-slate-300">{label}</span>
      </div>
      <div className="flex items-center space-x-1.5">
        <span className="font-black">{value}</span>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[status]}`} />
      </div>
    </div>
  );
};

export const ConnectionStatusDeck: React.FC<ConnectionStatusDeckProps> = ({
  pixhawkState,
  runnerLink,
  telemetry,
  videoState = 'DISCONNECTED',
}) => {
  const isWifiOn = typeof navigator !== 'undefined' && navigator.onLine;
  const isEsp32Reachable = pixhawkState.isUsbConnected || pixhawkState.isConnected;
  const isWsOpen = pixhawkState.connectionType === 'ESP32_WEBSOCKET' && (pixhawkState.cloudState === 'CONNECTED' || pixhawkState.esp32LinkState === 'CONNECTED' || pixhawkState.isUsbConnected || pixhawkState.isConnected);
  const isMavlinkUp = pixhawkState.isConnected;
  const isDroneAndroid = telemetry.pixhawkConnected || pixhawkState.isConnected;
  const isRunnerUp = runnerLink.isConnected;

  return (
    <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-2.5 space-y-1.5">
      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1 pb-1">
        SYSTEM CONNECTION STATUS
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-1.5">
        <StatusItem
          icon={<Wifi className="w-3.5 h-3.5" />}
          label="Wi-Fi"
          value={pixhawkState.isUsbConnected ? (pixhawkState.wifiSsid || 'drone123') : isWifiOn ? (pixhawkState.wifiSsid || 'ONLINE') : 'OFF'}
          status={pixhawkState.isUsbConnected || isWifiOn ? 'ok' : 'error'}
        />
        <StatusItem
          icon={<Cpu className="w-3.5 h-3.5" />}
          label="ESP32"
          value={isEsp32Reachable ? 'REACHED' : 'OFFLINE'}
          status={isEsp32Reachable ? 'ok' : pixhawkState.phase === 'DISCONNECTED' ? 'error' : 'warn'}
        />
        <StatusItem
          icon={<Signal className="w-3.5 h-3.5" />}
          label="WebSocket"
          value={isWsOpen ? 'OPEN' : pixhawkState.connectionType === 'ESP32_WEBSOCKET' ? 'CLOSED' : 'IDLE'}
          status={isWsOpen ? 'ok' : pixhawkState.connectionType === 'ESP32_WEBSOCKET' ? 'error' : 'idle'}
        />
        <StatusItem
          icon={<Radio className="w-3.5 h-3.5" />}
          label="MAVLink"
          value={isMavlinkUp ? 'LOCKED ✓' : 'WAITING'}
          status={isMavlinkUp ? 'ok' : 'warn'}
        />
        <StatusItem
          icon={<Smartphone className="w-3.5 h-3.5" />}
          label="Drone"
          value={isDroneAndroid ? 'ONLINE' : 'OFFLINE'}
          status={isDroneAndroid ? 'ok' : 'error'}
        />
        <StatusItem
          icon={<Video className="w-3.5 h-3.5" />}
          label="Video"
          value={videoState}
          status={videoState === 'LIVE' ? 'ok' : videoState === 'CONNECTING' ? 'warn' : 'error'}
        />
        <StatusItem
          icon={<Activity className="w-3.5 h-3.5" />}
          label="Runner"
          value={isRunnerUp ? 'CONNECTED' : 'WAITING'}
          status={isRunnerUp ? 'ok' : 'idle'}
        />
      </div>
    </div>
  );
};
