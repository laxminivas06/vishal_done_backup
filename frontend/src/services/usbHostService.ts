import { transportManager } from './transports/TransportManager';
import { ConnectionPhase, UsbDeviceDiagnostics } from '../types/mavlink';

type DataListener = (chunk: Uint8Array) => void;
type StateListener = (phase: ConnectionPhase, message: string, diagnostics: Partial<UsbDeviceDiagnostics>) => void;

class UsbHostService {
  private dataListeners: Set<DataListener> = new Set();
  private stateListeners: Set<StateListener> = new Set();
  private currentPhase: ConnectionPhase = 'DISCONNECTED';
  private currentBaudRate: number = 115200;

  constructor() {
    transportManager.subscribeData((chunk) => {
      this.dataListeners.forEach((fn) => fn(chunk));
    });

    transportManager.subscribeState((event) => {
      const phase = this.mapPhase(event.phase);
      this.currentPhase = phase;
      const diag: Partial<UsbDeviceDiagnostics> = {
        deviceName: event.device?.deviceName,
        productName: event.device?.productName,
        manufacturerName: event.device?.manufacturerName,
        vendorId: event.device?.vendorId,
        productId: event.device?.productId,
        interfaceCount: event.device?.interfaceCount,
        interfaceType: event.device?.interfaceType,
        endpointIn: event.device?.endpointIn,
        endpointOut: event.device?.endpointOut,
        hasPermission: event.device?.hasPermission,
        baudRate: this.currentBaudRate,
        driverType: this.mapDriverType(transportManager.getActiveTransport().type),
        lastError: event.error
      };
      this.stateListeners.forEach((fn) => fn(phase, event.message, diag));
    });
  }

  private mapPhase(rawPhase: string): ConnectionPhase {
    const validPhases: ConnectionPhase[] = [
      'DISCONNECTED',
      'USB_DEVICE_DETECTED',
      'USB_PERMISSION_REQUIRED',
      'USB_PERMISSION_GRANTED',
      'SERIAL_OPENING',
      'SERIAL_OPEN',
      'WAITING_FOR_MAVLINK',
      'HEARTBEAT_RECEIVED',
      'PIXHAWK_CONNECTED',
      'TELEMETRY_ACTIVE',
      'REQUESTING_PERMISSION',
      'PERMISSION_GRANTED',
      'OPENING_USB',
      'USB_CONNECTED',
      'WAKING_RELAY',
      'AUTHENTICATING_WSS',
      'WAITING_FOR_ESP32',
      'WAITING_FOR_HEARTBEAT',
      'MAVLINK_CONNECTED',
      'USB_NOT_DETECTED',
      'PERMISSION_DENIED',
      'UNSUPPORTED_DEVICE',
      'INTERFACE_NOT_SUPPORTED',
      'SERIAL_OPEN_FAILED',
      'NO_SERIAL_DATA',
      'NO_MAVLINK_HEARTBEAT',
      'HEARTBEAT_TIMEOUT',
      'CONNECTION_LOST',
      'MAVLINK_ERROR',
      'IOS_UNSUPPORTED'
    ];
    if (validPhases.includes(rawPhase as ConnectionPhase)) {
      return rawPhase as ConnectionPhase;
    }
    return 'DISCONNECTED';
  }

  private mapDriverType(type: string): UsbDeviceDiagnostics['driverType'] {
    switch (type) {
      case 'ANDROID_USB': return 'NATIVE_ANDROID_USB';
      case 'IOS_ACCESSORY': return 'IOS_ACCESSORY';
      case 'WEBSERIAL': return 'WEBSERIAL';
      case 'WEBUSB': return 'WEBUSB';
      case 'ESP32_WEBSOCKET': return 'ESP32_WEBSOCKET';
      case 'UDP': return 'UDP';
      case 'TCP': return 'TCP';
      default: return 'SIMULATOR';
    }
  }

  public subscribeData(fn: DataListener) {
    this.dataListeners.add(fn);
    return () => this.dataListeners.delete(fn);
  }

  public subscribeState(fn: StateListener) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  public async autoConnect(baudRate: number = 115200): Promise<boolean> {
    this.currentBaudRate = baudRate;
    return await transportManager.connect({ baudRate });
  }

  public async connectEsp32(options?: import('./transports/Esp32WebSocketTransport').Esp32WebSocketOptions): Promise<boolean> {
    return await transportManager.connectEsp32(options);
  }

  public async checkEsp32Http(host?: string, port?: number): Promise<{ reachable: boolean; latencyMs?: number; message?: string }> {
    return await transportManager.getEsp32Transport().checkEsp32Http(host, port);
  }

  public async requestUsbPermission(): Promise<boolean> {
    return await transportManager.requestUsbPermission();
  }

  public async scanUsbDevices(): Promise<any[]> {
    return await transportManager.scanUsbDevices();
  }

  public async sendBytes(bytes: Uint8Array): Promise<boolean> {
    return await transportManager.send(bytes);
  }

  public async disconnect(): Promise<void> {
    await transportManager.disconnect();
  }

  public async getDiagnostics(): Promise<Partial<UsbDeviceDiagnostics>> {
    const diag = await transportManager.getDiagnostics();
    return {
      ...diag,
      driverType: this.mapDriverType(transportManager.getActiveTransport().type),
      baudRate: this.currentBaudRate
    };
  }

  public getCurrentPhase(): ConnectionPhase {
    return this.currentPhase;
  }
}

export const usbHostService = new UsbHostService();
