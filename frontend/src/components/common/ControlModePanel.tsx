import React, { useState } from 'react';
import { 
  Gamepad2, 
  Power, 
  ArrowUp, 
  ArrowDown, 
  ArrowLeft, 
  ArrowRight, 
  ShieldCheck, 
  Compass, 
  PlaneTakeoff, 
  PlaneLanding, 
  Home, 
  Hand,
  AlertTriangle
} from 'lucide-react';
import { DroneTelemetry } from '../../types/mission';
import { PixhawkConnectionState } from '../../types/mavlink';
import { mavlinkService } from '../../services/mavlinkService';
import { DisarmSafetyConfirmModal } from './DisarmSafetyConfirmModal';

interface ControlModePanelProps {
  telemetry: DroneTelemetry;
  connectionState: PixhawkConnectionState;
  onArmClick: (force?: boolean) => void;
  onDisarmClick: () => void;
  isArmingInProgress?: boolean;
  isDisarmingInProgress?: boolean;
}

export const ControlModePanel: React.FC<ControlModePanelProps> = ({
  telemetry,
  connectionState,
  onArmClick,
  onDisarmClick,
  isArmingInProgress = false,
  isDisarmingInProgress = false
}) => {
  const [activeDirection, setActiveDirection] = useState<string | null>(null);
  const [isSafetyModalOpen, setIsSafetyModalOpen] = useState<boolean>(false);
  const [isCutoffRequested, setIsCutoffRequested] = useState<boolean>(false);
  const [isChangingMode, setIsChangingMode] = useState<string | null>(null);
  const [modeFeedback, setModeFeedback] = useState<{ mode: string; success: boolean; msg: string } | null>(null);
  const [forceBenchArmActive, setForceBenchArmActive] = useState<boolean>(false);

  const isArmed = telemetry.isArmed;

  const handleModeClick = async (mode: 'STABILIZE' | 'ALT_HOLD' | 'LOITER' | 'AUTO' | 'GUIDED' | 'RTL') => {
    setIsChangingMode(mode);
    setModeFeedback(null);
    const ok = await mavlinkService.setFlightMode(mode);
    setIsChangingMode(null);
    if (ok) {
      setModeFeedback({ mode, success: true, msg: `Flight mode set to ${mode} ✓` });
      setTimeout(() => setModeFeedback(null), 3500);
    } else {
      const err = connectionState.lastModeChangeError || `Pixhawk rejected ${mode}. Requires 3D GPS fix.`;
      setModeFeedback({ mode, success: false, msg: err });
    }
  };

  const handleSafeDisarmTrigger = (forceCutoff: boolean = false) => {
    // If airborne, prompt with critical warning popup stating exact altitude
    if (telemetry.isArmed && telemetry.altitude > 0.4) {
      setIsCutoffRequested(forceCutoff);
      setIsSafetyModalOpen(true);
      return;
    }
    if (forceCutoff) {
      mavlinkService.sendDisarmCommand(true);
    }
    onDisarmClick();
  };

  const handleDirectionPress = (dir: 'FORWARD' | 'BACKWARD' | 'LEFT' | 'RIGHT' | 'HOLD') => {
    setActiveDirection(dir);
    mavlinkService.commandManualMove(dir);
    setTimeout(() => setActiveDirection(null), 300);
  };

  const handleTakeoff = () => {
    mavlinkService.commandTakeoff(20);
  };

  const handleLand = () => {
    mavlinkService.commandLand();
  };

  const handleRTL = () => {
    mavlinkService.commandRTL();
  };

  const handleHold = () => {
    mavlinkService.commandHold();
  };

  return (
    <div className="bg-slate-900/90 rounded-2xl border border-slate-800 p-3.5 sm:p-5 shadow-xl font-mono text-slate-100 space-y-4">
      {/* 1. Header: No RC Mode Operational Status */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
        <div className="flex items-center space-x-2.5">
          <div className="p-2 rounded-xl bg-sky-950/80 border border-sky-500/40 text-sky-400">
            <Gamepad2 className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="text-xs sm:text-sm font-black uppercase tracking-wider text-slate-200">
              FLIGHT CONTROL INTERFACE
            </div>
            <div className="text-[10px] text-slate-400">
              MAVLink Web Ground Station Control
            </div>
          </div>
        </div>

        {/* Operating Only in No RC Mode */}
        <div className="flex items-center bg-slate-950 px-3 py-1.5 rounded-xl border border-emerald-500/40 text-emerald-400 self-start sm:self-auto space-x-1.5 shadow-sm">
          <Gamepad2 className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs font-black uppercase tracking-wider">NO RC MODE</span>
        </div>
      </div>

      {/* 2. NO-RC MODE INTERFACE */}
      <div className="space-y-4">
          {/* A. UNIFIED MASTER MOTOR CONTROL (SINGLE DYNAMIC ARM/DISARM BUTTON + EMERGENCY CUTOFF) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                MOTOR POWER CONTROL
              </span>
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full flex items-center space-x-1.5 transition-all ${
                isArmed 
                  ? 'bg-rose-950/90 text-rose-300 border border-rose-500/70 shadow-lg shadow-rose-950/50 animate-pulse' 
                  : 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/40'
              }`}>
                <span className={`w-2 h-2 rounded-full ${isArmed ? 'bg-rose-400 animate-ping' : 'bg-emerald-400'}`} />
                <span>{isArmed ? 'ARMED • MOTORS LIVE' : 'DISARMED • STANDBY'}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
              {/* PRIMARY UNIFIED TOGGLE BUTTON: ARM when disarmed, DISARM when armed */}
              <button
                type="button"
                onClick={isArmed ? () => handleSafeDisarmTrigger(false) : () => onArmClick(forceBenchArmActive)}
                disabled={isArmingInProgress || isDisarmingInProgress || (!connectionState.isConnected && !connectionState.isUsbConnected)}
                className={`sm:col-span-3 py-4 px-4 rounded-xl font-black text-sm sm:text-base uppercase tracking-wider flex items-center justify-center space-x-2.5 border transition-all duration-150 shadow-lg cursor-pointer ${
                  !connectionState.isConnected && !connectionState.isUsbConnected
                    ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed shadow-none'
                    : isArmingInProgress
                    ? 'bg-amber-600 border-amber-400 text-white animate-pulse cursor-wait'
                    : isDisarmingInProgress
                    ? 'bg-amber-700 border-amber-500 text-white animate-pulse cursor-wait'
                    : isArmed
                    ? 'bg-rose-600 hover:bg-rose-500 text-white border-rose-400 shadow-rose-950/60 ring-2 ring-rose-400/50 active:scale-[0.98]'
                    : forceBenchArmActive
                    ? 'bg-amber-600 hover:bg-amber-500 text-white border-amber-400 shadow-amber-950/60 ring-2 ring-amber-400/60 active:scale-[0.98]'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-400 shadow-emerald-950/60 ring-2 ring-emerald-400/40 active:scale-[0.98]'
                }`}
              >
                {isArmed ? (
                  <>
                    <Power className="w-5 h-5 shrink-0" />
                    <span>{isDisarmingInProgress ? 'DISARMING MOTORS...' : 'DISARM MOTORS (CLICK TO STOP)'}</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-5 h-5 shrink-0" />
                    <span>{isArmingInProgress ? 'ARMING MOTORS...' : forceBenchArmActive ? 'FORCE ARM (BYPASS PRE-ARM)' : 'ARM MOTORS (CLICK TO SPIN)'}</span>
                  </>
                )}
              </button>

              {/* EMERGENCY FORCE DISARM / CUTOFF BUTTON */}
              <button
                type="button"
                onClick={() => handleSafeDisarmTrigger(true)}
                disabled={!connectionState.isConnected && !connectionState.isUsbConnected}
                title="Instant hardware emergency motor cutoff (MAVLink param2=21196 force disarm)"
                className="sm:col-span-1 py-4 px-3 rounded-xl font-black text-xs uppercase tracking-wider flex items-center justify-center space-x-1.5 border border-rose-800/80 bg-rose-950/70 hover:bg-rose-900 text-rose-300 hover:text-white transition active:scale-[0.98] cursor-pointer"
              >
                <Power className="w-4 h-4 shrink-0 text-rose-400" />
                <span className="leading-tight text-center">FORCE<br className="hidden sm:inline" /> CUTOFF</span>
              </button>
            </div>

            {/* Bench Force-Arm Bypass Checkbox (for testing motor spin when pre-arm checks fail on bench) */}
            {!isArmed && (
              <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-950/70 border border-slate-800 text-[11px]">
                <label className="flex items-center space-x-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={forceBenchArmActive}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForceBenchArmActive(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-700 text-amber-500 focus:ring-amber-500/40 bg-slate-900"
                  />
                  <span className={forceBenchArmActive ? 'text-amber-300 font-bold' : 'text-slate-400'}>
                    Force Arm Bypass (Bench Test Only — bypasses Pre-Arm &amp; GPS checks)
                  </span>
                </label>
                {forceBenchArmActive && (
                  <span className="text-[10px] text-amber-400 bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-600/50">
                    PARAM2=21196 ACTIVE
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Real-time Pre-Arm Rejection / Safety Switch Status Banner */}
          {(connectionState.preArmFailReason || (connectionState.lastArmCommandAck && connectionState.lastArmCommandAck.result !== 0)) && !isArmed && (() => {
            const reason = connectionState.preArmFailReason || (connectionState.lastArmAckResult || `Command 400 Rejected: ${connectionState.lastArmCommandAck?.resultName || 'FAILED'}`);
            const lower = reason.toLowerCase();
            return (
              <div className="p-3.5 rounded-xl bg-rose-950/90 border border-rose-500 text-rose-200 text-xs space-y-2 shadow-xl animate-in fade-in">
                <div className="flex items-start space-x-2">
                  <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div className="w-full">
                    <strong className="text-rose-300 uppercase tracking-wide flex items-center justify-between">
                      <span>Pixhawk Pre-Arm Rejection:</span>
                      <span className="text-[10px] bg-rose-900/60 text-rose-300 px-1.5 py-0.5 rounded border border-rose-600/40">ARM FAILED</span>
                    </strong>
                    <div className="font-mono text-white text-xs mt-1 bg-black/60 p-2.5 rounded-lg border border-rose-500/50 select-all font-bold">
                      {reason}
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-rose-200 space-y-1.5 pt-1.5 border-t border-rose-500/30">
                  {/* MicroSD / Logging check guidance */}
                  {lower.includes('log') && (
                    <div className="bg-amber-950/70 p-2.5 rounded-lg border border-amber-500/60 text-amber-200 space-y-1">
                      <div className="font-bold text-amber-300 flex items-center space-x-1.5">
                        <span>💾 MicroSD Logging Check Failed (ARMING_CHECK):</span>
                      </div>
                      <div className="text-[11px] leading-relaxed">
                        ArduPilot requires an operational MicroSD card to record flight data logs before arming.
                      </div>
                      <div className="text-[10px] text-amber-100 bg-black/40 p-2 rounded border border-amber-600/30 space-y-1 font-mono">
                        <div>• <strong>Solution A (Hardware):</strong> Insert a FAT32 formatted MicroSD card into the Pixhawk's SD slot.</div>
                        <div>• <strong>Solution B (Mission Planner):</strong> Go to <strong>Config &gt; Full Parameter List</strong> &gt; set <code>ARMING_CHECK = 0</code> (or uncheck "Logging" in Standard Params) &gt; click <strong>Write Params</strong>.</div>
                      </div>
                    </div>
                  )}

                  {lower.includes('switch') && (
                    <div>• <strong>Physical Safety Switch:</strong> Press &amp; hold the Pixhawk safety button for 3 seconds until the LED turns solid red (or set <code>BRD_SAFETYENABLE = 0</code> in Mission Planner).</div>
                  )}
                  {lower.includes('compass') && (
                    <div className="bg-amber-950/60 p-2 rounded-lg border border-amber-600/40 text-amber-200">
                      <div>• <strong>Compass / Port Alert:</strong> If GPS was moved to <code>SERIAL4/5</code>, note that <code>SERIAL4/5</code> has <strong>NO I2C pins</strong>! The GPS puck's 4-pin compass cable <strong>MUST be plugged into the Pixhawk I2C port</strong>, not SERIAL4/5. Then perform Compass Calibration in Mission Planner.</div>
                    </div>
                  )}
                  {(lower.includes('fix') || lower.includes('gps') || lower.includes('nav')) && (
                    <div className="bg-amber-950/60 p-2 rounded-lg border border-amber-600/40 text-amber-200 space-y-1">
                      <div>• <strong>GPS Port Parameters:</strong> If GPS is on <code>SERIAL4/5</code>, set <code>SERIAL4_PROTOCOL = 5</code> (GPS) and <code>SERIAL3_PROTOCOL = 0</code> (disables empty old GPS port so SERIAL4 becomes GPS 1).</div>
                      <div>• <strong>Bench Arming Without GPS:</strong> Switch mode to <strong className="text-emerald-300 underline font-bold">ALT_HOLD</strong> or <strong className="text-emerald-300 underline font-bold">STABILIZE</strong> below (no GPS required to arm).</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Mode Switch Feedback / Failure Banner */}
          {(modeFeedback || connectionState.lastModeChangeError) && (
            <div className={`p-3 rounded-xl text-xs flex items-center justify-between border ${
              modeFeedback?.success
                ? 'bg-emerald-950/90 border-emerald-500/70 text-emerald-200'
                : 'bg-amber-950/90 border-amber-500/70 text-amber-200'
            }`}>
              <div className="flex items-start space-x-2">
                {modeFeedback?.success ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="font-bold">
                    {modeFeedback?.success ? 'Flight Mode Confirmed' : 'Flight Mode Rejection'}
                  </div>
                  <div className="text-[11px] mt-0.5">
                    {modeFeedback?.msg || connectionState.lastModeChangeError}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModeFeedback(null)}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}

          {/* Flight Mode Quick Selector */}
          <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between text-[10px] uppercase font-bold text-slate-400">
              <span>
                Current Mode: <span className="text-emerald-300 font-mono text-xs">{telemetry.flightMode || 'STABILIZE'}</span>
                {connectionState.pendingFlightMode && (
                  <span className="ml-2 text-amber-400 animate-pulse font-normal">
                    (Switching to {connectionState.pendingFlightMode}...)
                  </span>
                )}
              </span>
              <span className="text-slate-500">Select Mode:</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs font-bold">
              {(['STABILIZE', 'ALT_HOLD', 'LOITER', 'AUTO', 'GUIDED', 'RTL'] as const).map((mode) => {
                const isActive = (telemetry.flightMode || '').toUpperCase() === mode;
                const isPending = isChangingMode === mode || connectionState.pendingFlightMode === mode;
                const requiresGps = mode !== 'STABILIZE' && mode !== 'ALT_HOLD';

                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleModeClick(mode)}
                    disabled={(!connectionState.isConnected && !connectionState.isUsbConnected) || isChangingMode !== null}
                    className={`py-2 px-1 rounded-xl text-[10px] transition cursor-pointer font-bold flex flex-col items-center justify-center space-y-0.5 ${
                      isPending
                        ? 'bg-amber-600 text-white animate-pulse ring-2 ring-amber-400'
                        : isActive
                        ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-950/60 ring-2 ring-emerald-400'
                        : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700/80 active:scale-[0.97]'
                    }`}
                  >
                    <span className="tracking-wider">{mode}</span>
                    <span className={`text-[8px] font-mono font-normal ${
                      isActive ? 'text-emerald-100' : requiresGps ? 'text-amber-400/80' : 'text-emerald-400/80'
                    }`}>
                      {isPending ? 'SWITCHING' : isActive ? 'ACTIVE' : requiresGps ? 'GPS REQ' : 'NO GPS'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ArduPilot DISARM_DELAY Safety Notice */}
          <div className="p-2.5 rounded-lg bg-sky-950/40 border border-sky-800/40 flex items-start space-x-2 text-[11px] text-sky-300">
            <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <div className="leading-snug">
              <span className="font-bold">ArduPilot Ground Auto-Disarm:</span> ArduCopter firmware automatically disarms motors after <span className="font-bold underline">10 seconds</span> on the ground if throttle/takeoff is not initiated (<code className="bg-slate-900 px-1 py-0.5 rounded text-[10px]">DISARM_DELAY</code>). Press <span className="font-bold text-emerald-300">TAKEOFF</span> after arming.
            </div>
          </div>

          {/* B. DIRECTIONAL CONTROLS & FLIGHT ACTIONS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 1. D-PAD DIRECTIONAL CONTROLLER */}
            <div className="p-3.5 bg-slate-950/90 rounded-xl border border-slate-800 flex flex-col items-center justify-center space-y-2">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center space-x-1.5 self-start">
                <Compass className="w-3.5 h-3.5 text-sky-400" />
                <span>MANUAL DIRECTIONAL CONTROLS</span>
              </div>

              <div className="grid grid-cols-3 gap-2 w-full max-w-[240px] pt-1">
                {/* Row 1: Forward */}
                <div />
                <button
                  type="button"
                  onClick={() => handleDirectionPress('FORWARD')}
                  disabled={!connectionState.isConnected}
                  className={`p-3.5 rounded-xl border flex flex-col items-center justify-center font-bold text-xs transition active:scale-95 cursor-pointer ${
                    activeDirection === 'FORWARD'
                      ? 'bg-sky-500 text-white border-sky-300'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                  title="Move Forward"
                >
                  <ArrowUp className="w-5 h-5" />
                  <span className="text-[9px] mt-0.5 font-mono">FWD</span>
                </button>
                <div />

                {/* Row 2: Left, Hold, Right */}
                <button
                  type="button"
                  onClick={() => handleDirectionPress('LEFT')}
                  disabled={!connectionState.isConnected}
                  className={`p-3 rounded-xl border flex flex-col items-center justify-center font-bold text-xs transition active:scale-95 cursor-pointer ${
                    activeDirection === 'LEFT'
                      ? 'bg-sky-500 text-white border-sky-300'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                  title="Move Left"
                >
                  <ArrowLeft className="w-5 h-5" />
                  <span className="text-[9px] mt-0.5 font-mono">LEFT</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDirectionPress('HOLD')}
                  disabled={!connectionState.isConnected}
                  className={`p-3 rounded-xl border flex flex-col items-center justify-center font-black text-xs transition active:scale-95 cursor-pointer ${
                    activeDirection === 'HOLD'
                      ? 'bg-amber-500 text-white border-amber-300'
                      : 'bg-amber-950/60 hover:bg-amber-900/60 border-amber-500/50 text-amber-300'
                  }`}
                  title="Position Hold"
                >
                  <Hand className="w-5 h-5" />
                  <span className="text-[9px] mt-0.5 font-mono">HOLD</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDirectionPress('RIGHT')}
                  disabled={!connectionState.isConnected}
                  className={`p-3 rounded-xl border flex flex-col items-center justify-center font-bold text-xs transition active:scale-95 cursor-pointer ${
                    activeDirection === 'RIGHT'
                      ? 'bg-sky-500 text-white border-sky-300'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                  title="Move Right"
                >
                  <ArrowRight className="w-5 h-5" />
                  <span className="text-[9px] mt-0.5 font-mono">RIGHT</span>
                </button>

                {/* Row 3: Backward */}
                <div />
                <button
                  type="button"
                  onClick={() => handleDirectionPress('BACKWARD')}
                  disabled={!connectionState.isConnected}
                  className={`p-3.5 rounded-xl border flex flex-col items-center justify-center font-bold text-xs transition active:scale-95 cursor-pointer ${
                    activeDirection === 'BACKWARD'
                      ? 'bg-sky-500 text-white border-sky-300'
                      : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-200'
                  }`}
                  title="Move Backward"
                >
                  <ArrowDown className="w-5 h-5" />
                  <span className="text-[9px] mt-0.5 font-mono">BWD</span>
                </button>
                <div />
              </div>
            </div>

            {/* 2. FLIGHT ACTIONS GRID */}
            <div className="p-3.5 bg-slate-950/90 rounded-xl border border-slate-800 flex flex-col justify-between space-y-2">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                <PlaneTakeoff className="w-3.5 h-3.5 text-emerald-400" />
                <span>FLIGHT COMMANDS</span>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                {/* TAKEOFF */}
                <button
                  type="button"
                  onClick={handleTakeoff}
                  disabled={!isArmed || !connectionState.isConnected}
                  className={`p-3 rounded-xl border font-bold text-xs flex items-center justify-center space-x-2 transition ${
                    isArmed && connectionState.isConnected
                      ? 'bg-emerald-950/80 hover:bg-emerald-900 border-emerald-500/50 text-emerald-300 cursor-pointer active:scale-95'
                      : 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <PlaneTakeoff className="w-4 h-4" />
                  <span>TAKEOFF (20m)</span>
                </button>

                {/* LAND */}
                <button
                  type="button"
                  onClick={handleLand}
                  disabled={!connectionState.isConnected}
                  className={`p-3 rounded-xl border font-bold text-xs flex items-center justify-center space-x-2 transition ${
                    connectionState.isConnected
                      ? 'bg-amber-950/80 hover:bg-amber-900 border-amber-500/50 text-amber-300 cursor-pointer active:scale-95'
                      : 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <PlaneLanding className="w-4 h-4" />
                  <span>LAND</span>
                </button>

                {/* RTL */}
                <button
                  type="button"
                  onClick={handleRTL}
                  disabled={!connectionState.isConnected}
                  className={`p-3 rounded-xl border font-bold text-xs flex items-center justify-center space-x-2 transition ${
                    connectionState.isConnected
                      ? 'bg-rose-950/80 hover:bg-rose-900 border-rose-500/50 text-rose-300 cursor-pointer active:scale-95'
                      : 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <Home className="w-4 h-4" />
                  <span>RTL</span>
                </button>

                {/* HOLD */}
                <button
                  type="button"
                  onClick={handleHold}
                  disabled={!connectionState.isConnected}
                  className={`p-3 rounded-xl border font-bold text-xs flex items-center justify-center space-x-2 transition ${
                    connectionState.isConnected
                      ? 'bg-sky-950/80 hover:bg-sky-900 border-sky-500/50 text-sky-300 cursor-pointer active:scale-95'
                      : 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  }`}
                >
                  <Hand className="w-4 h-4" />
                  <span>HOLD / LOITER</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Airborne Disarm Safety Warning Modal */}
        <DisarmSafetyConfirmModal
          isOpen={isSafetyModalOpen}
          currentAltitude={telemetry.altitude}
          verticalSpeed={telemetry.verticalSpeed}
          flightMode={telemetry.flightMode}
          isForceCutoff={isCutoffRequested}
          onConfirmDisarm={() => {
            setIsSafetyModalOpen(false);
            if (isCutoffRequested) {
              mavlinkService.sendDisarmCommand(true);
            }
            onDisarmClick();
          }}
          onCommandLand={() => {
            setIsSafetyModalOpen(false);
            mavlinkService.commandLand();
          }}
          onCancel={() => setIsSafetyModalOpen(false)}
        />
      </div>
    );
  };
