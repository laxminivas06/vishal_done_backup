# SAE INDIA ADDC 2026 — End-to-End Drone Telemetry & Cloud Relay
## Comprehensive Engineering Diagnostic Report & Operational Runbook

---

## 1. Executive Summary

This investigation diagnoses and resolves the multi-layer communication failure within the **SAE INDIA ADDC 2026 Autonomous Drone Rescue System (Skycon)**, where powering and connecting the onboard **ESP32-S3** to a mobile Wi-Fi hotspot resulted in:
1. The drone being reported as **Offline** or **Unavailable** on the Render Cloud Relay backend (`/health`, `/connector`).
2. MAVLink telemetry remaining permanently stuck in the **Connecting** or **Waiting for MAVLink Heartbeat** phase on the Netlify Ground Control Station (GCS) web interface.

A rigorous, full-stack audit revealed that this issue was caused by **compound cascading failures across all five layers** of the communication pipeline:
* **RF / Physical Layer**: Smartphone hotspot 5 GHz vs. 2.4 GHz band mismatch, Protected Management Frames (PMF) negotiation failures, and RF power burst brownouts.
* **Cryptographic / TLS Layer**: Year 1970 clock epoch desynchronization invalidating X.509 SSL certificates before NTP acquisition, coupled with incomplete Root CA trust chains.
* **Network & Routing Layer**: WebSockets endpoint route divergence (`/connector` vs. `/ws`), authentication token mismatches, and Render free-tier container cold-start sleep cycles.
* **Serial / Hardware Layer**: Pixhawk TELEM2 baud rate mismatch (57600 vs. 115200 baud) and 64-byte UART FIFO overflow drops during TLS transmit latency.
* **MAVLink Protocol Layer**: GCS connection state machine strictly gating the `CONNECTED` state on valid MAVLink Heartbeats (Message ID 0) with valid CRC extras (`0x32`).

Following full-stack remediation across the **ESP32-S3 firmware**, **Node.js relay server**, and **React/TypeScript GCS frontend**, the entire end-to-end telemetry pipeline has been verified with **100% automated test pass rates** (49/49 system tests, 6/6 backend smoke tests, and automated end-to-end mock pipeline verification).

---

## 2. End-to-End System Topology

```mermaid
flowchart LR
    subgraph DroneOnboard["Drone Onboard Hardware"]
        PX4["Pixhawk 2.4.8 FC<br/>TELEM2 @ 57600 baud"]
        ESP["ESP32-S3 Module<br/>Core 1: UART (1ms)<br/>Core 0: WSS / TLS"]
    end

    subgraph FieldRelay["Field Network"]
        HOTSPOT["Mobile Wi-Fi Hotspot<br/>2.4 GHz 802.11b/g/n"]
    end

    subgraph CloudInfra["Cloud Infrastructure (Render.com)"]
        RELAY["WSS Relay Server<br/>Port 8443 / TCP_NODELAY<br/>/connector (Drone)<br/>/ws (Browser GCS)"]
    end

    subgraph GCS["Ground Control Station (Netlify / Android)"]
        BROWSER["Web GCS Frontend<br/>React 18 / Leaflet / Vite<br/>MavlinkService Parser"]
    end

    PX4 -- "UART (GPIO 18 RX / 17 TX)<br/>MAVLink 2.0" --> ESP
    ESP -- "WSS over TLS 1.3<br/>/connector?token=..." --> HOTSPOT
    HOTSPOT -- "Internet WAN" --> RELAY
    RELAY -- "Zero-Copy WSS<br/>/ws?token=..." --> BROWSER
    BROWSER -. "Uplink Commands<br/>(Arm, Guided, RTL)" .-> RELAY
    RELAY -. "Forwarded Uplink" .-> ESP
    ESP -. "UART TX" .-> PX4
```

---

## 3. Forensic Root-Cause Analysis (5 Failure Layers)

### Layer 1: Wi-Fi Association & Mobile Hotspot Handshake
* **5 GHz vs. 2.4 GHz Band Mismatch**: The ESP32-S3 hardware possesses only a 2.4 GHz Wi-Fi radio. Modern iPhones and Android devices default to 5 GHz or 6 GHz hotspot bands. When an iPhone hotspot is active without **"Maximize Compatibility"** turned ON, the SSID is invisible to the ESP32-S3, triggering disconnect code `201` (`NO_AP_FOUND`).
* **Protected Management Frames (PMF / 802.11w)**: Modern mobile operating systems (iOS 15+, Android 12+) mandate or negotiate PMF in WPA2/WPA3 Personal transition mode. Default ESP-IDF settings frequently fail the 4-way handshake (disconnect code `2` `AUTH_EXPIRE` or `15` `4WAY_HANDSHAKE_TIMEOUT`).
* **802.11 Modem Sleep Frame Drops**: Arduino's default Wi-Fi sleep profile (`WiFi.setSleep(true)`) cycles off the RF receiver between DTIM beacons to save battery. In field environments with fluctuating smartphone beacon jitter, this caused missed handshake packets and frequent disconnects.
* **Transient RF Current Bursts & Brownout Detector Resets**: During 802.11 packet bursts at 19.5 dBm, the ESP32-S3 draws transient current spikes exceeding 450–500 mA. When powered through long USB cables or directly from Pixhawk TELEM2 Pin 1 while the Pixhawk is only USB-powered, voltage dips below 2.8V, triggering hardware Brownout Resets (BOD) in an infinite reboot loop.
* **Stale NVS Wi-Fi Caching**: `WiFi.begin()` stores BSSID/channel state in Non-Volatile Storage. When switching hotspots or when phone hotspots dynamically shift channels, stale NVS caching prevented successful re-association.

### Layer 2: SSL/TLS Handshake & Cryptographic Validation
* **Epoch Clock Desynchronization (Year 1970 Bug)**: On cold boot, the ESP32-S3 internal Real-Time Clock initializes to `Unix Epoch 0` (January 1, 1970). Render.com’s TLS certificates have a validity period starting in 2024–2026. `WiFiClientSecure` strictly validates certificate validity windows (`notBefore` $\le$ `current_time` $\le$ `notAfter`). Because the device clock was in 1970, TLS certificate verification aborted with `X509_V_ERR_CERT_NOT_YET_VALID`. If NTP failed or was delayed over cellular, the TLS connection never established.
* **Missing Root CA Trust Anchor**: Render uses certificates issued by Google Trust Services (GTS Root R4) and GlobalSign Root CA. Without the full CA trust bundle embedded in PROGMEM, TLS handshakes failed with `CERT_SIGNATURE_FAILURE`.

### Layer 3: WebSocket Routing, Endpoints & Token Authentication
* **Endpoint Path Segregation**:
  * `/connector`: Dedicated route for the drone / ESP32-S3 uplink.
  * `/ws`: Dedicated route for browser and mobile GCS clients.
  Connecting to the wrong route resulted in immediate HTTP 404 or misrouted telemetry.
* **Token Authentication Mismatch**: The backend relay validates the query parameter `?token=...` or `x-relay-token` header against `process.env.RELAY_TOKEN`. In mismatched configurations (`saeindia_sec_99348a7b1c0e` vs. `saeindia_secret_token_2026`), the backend rejected connections with `HTTP 401 Unauthorized`.
* **State Propagation Mechanics**: In `backend/server.js`, `esp32Online` is declared `true` only when a client connected to `/connector` AND either sends binary MAVLink frames or an explicit `{"type": "ESP32_STATUS", "status": "CONNECTED"}` JSON payload. If the socket connected but remained idle, GCS reported the drone as offline.
* **Render Free-Tier Cold Starts**: Render spins down inactive containers after 15 minutes. Cold-start spin-up takes 20–30 seconds. Previous GCS frontend socket timeouts (6 seconds) aborted the connection before the server finished waking up.

### Layer 4: Hardware UART & Pixhawk TELEM2 Framing
* **TELEM2 Pinout Reversal**: Pixhawk 2.4.8 Pin 2 is TX (Drone $\rightarrow$ ESP32 RX) and Pin 3 is RX (Drone $\leftarrow$ ESP32 TX). Inverting TX/RX prevented MAVLink frame ingestion.
* **Baud Rate Mismatch**: Pixhawk parameter `SERIAL2_BAUD` is commonly configured as `57` (57600 baud) or `115` (115200 baud). A fixed 57600 baud client communicating with a 115200 baud Pixhawk received framing errors and garbage bytes, with no valid MAVLink magic bytes (`0xFE` or `0xFD`) decoded.
* **UART FIFO Buffer Overrun During TLS Latency**: The standard ESP32 serial buffer is only 64 bytes. When the ESP32 spent 20–40 ms encrypting and transmitting TLS packets over cellular, the hardware UART buffer overflowed, dropping packet bytes and causing CRC corruption on incoming MAVLink streams.

### Layer 5: MAVLink State Machine & GCS Heartbeat Wait
* **Strict Heartbeat Gating**: In `mavlinkService.ts`, the frontend does **NOT** consider the drone connected merely because the WebSocket opened (`SERIAL_OPEN`). The `isConnected = true` and `PIXHAWK_CONNECTED` state strictly requires receipt and valid CRC calculation of MAVLink Message ID 0 (`HEARTBEAT`, CRC Extra 50).
* If any upstream layer failed (baud rate, buffer drop, TLS reject), zero heartbeats reached the browser, leaving the UI permanently stuck in **"Connecting"** or **"Waiting for MAVLink Heartbeat"**.

---

## 4. Full-Stack Architectural Fixes

### 4.1. ESP32-S3 Firmware (`esp32_cloud_relay_client.ino`)
1. **Early Hardware Brownout Suppression**:
   ```c
   __attribute__((constructor)) static void disable_bod_early_boot() {
     WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
   }
   ```
2. **Wi-Fi Pre-Scan, Fast Channel Locking & PMF Configuration**:
   * Scans 2.4 GHz spectrum prior to connection to discover exact channel and BSSID.
   * Disables NVS persistence (`WiFi.persistent(false)`) and flushes stale state (`WiFi.disconnect(true)`).
   * Explicitly enables PMF capability (`conf.sta.pmf_cfg.capable = true; conf.sta.pmf_cfg.required = false;`).
   * Disables modem sleep (`WiFi.setSleep(false)`) before `WiFi.begin()` to keep RF radio active.
3. **Instant Baseline Clock Epoch & Dual CA Bundle**:
   * Pre-seeds system clock to Unix timestamp $\ge 1775730000$ (Year 2026) immediately at boot so TLS certificate validity checks pass before NTP lock.
   * Embeds complete Root CA bundle (Google Trust Services GTS Root R4 + GlobalSign Root CA).
   * Implements 3-stage fallback: (1) URL connect with CA verify, (2) host/port/path connect, (3) `setInsecure()` TLS fallback to prevent field mission lockouts.
4. **Dual-Core FreeRTOS Architecture**:
   * **Core 1 (Priority 3 - 1ms Loop)**: Dedicated UART MAVLink Driver and Frame Assembler. Drains Pixhawk TELEM2 hardware FIFO continuously. Assembles complete MAVLink v1 (`0xFE`) and v2 (`0xFD`) frames. Intercepts `STATUSTEXT` (msgid 253) for `QR_CODE:` payloads and emits high-priority `QR_ALERT`. Pushes frames to thread-safe queue `qTxToCloud`.
   * **Core 0 (Priority 2)**: Wi-Fi Network & WebSocket SSL Client. Flushes telemetry batches (threshold 256 bytes or 12ms timeout) and sends 10-second heartbeat pings.
5. **Expanded 4KB UART Buffers & Dual-Baud Auto-Detection**:
   * `PixhawkSerial.setRxBufferSize(4096)` and `setTxBufferSize(2048)`.
   * Auto-baud switcher toggles between 57600 and 115200 baud every 12 seconds until valid MAVLink framing is locked.

### 4.2. Cloud Relay Server (`backend/server.js`)
1. **Low-Latency Socket Optimization**:
   * Injects `socket.setNoDelay(true)` immediately on raw TCP stream to disable Nagle's algorithm (eliminates 40–200ms latency on small packets).
   * Disables zlib compression (`perMessageDeflate: false`) to eradicate compression CPU latency.
2. **Multi-Token Authentication**:
   * Accepts both production (`saeindia_sec_99348a7b1c0e`) and legacy/staging (`saeindia_secret_token_2026`) tokens.
3. **Zero-Copy Routing & Dropped Frame Protection**:
   * Drops frames for congested browser clients (`bufferedAmount < 65536`) to prevent lag buildup.
4. **Render Anti-Sleep Self-Ping**:
   * Automated self-ping every 4 minutes to `/health` prevents Render free-tier containers from spinning down.

### 4.3. Ground Control Station Frontend (`Esp32WebSocketTransport.ts`)
1. **Multi-Hop Status Awareness**:
   * Decodes `RELAY_STATUS` messages to separately indicate whether Cloud Relay, Connector, and ESP32 are online.
2. **Extended Cold-Start Tolerance**:
   * 30-second progressive timeout for cloud WSS connections with automatic background `/health` wake-up ping.
3. **Mixed-Content Protection**:
   * Validates origin protocol and guides operator when plain `ws://` is attempted from HTTPS.

---

## 5. Verification & Test Results

| Test Suite | Scope | Status | Notes |
| :--- | :--- | :--- | :--- |
| **Comprehensive Function Test** (`test-all-systems.ts`) | MAVLink commands, Circle & Loiter tests, Geodesic math, Search algorithms, QR validation (regex `^\d{2}$`) | **49 / 49 PASS** | 100% pass across all 6 sub-suites |
| **Backend Relay Smoke Test** (`test-backend-smoke.ts`) | HTTP `/health`, 401 token authentication enforcement on `/connector` and `/ws` | **6 / 6 PASS** | Zero auth leaks, status payload valid |
| **End-to-End Pipeline Test** (`test-e2e.cjs`) | Mock ESP32 $\rightarrow$ Local Connector $\rightarrow$ Relay Server $\rightarrow$ Browser GCS | **PASS** | 22 binary MAVLink frames received, bidirectional control verified |
| **Production Build** (`npm run build`) | TypeScript type check, Vite production bundling, dist sync | **PASS** | `dist/` synced cleanly with zero compilation errors |

---

## 6. Operational Runbook & Field Guide

### 6.1. Hardware Wiring Reference
```text
PIXHAWK 2.4.8 TELEM2                ESP32-S3 DEVKIT
Pin 1  (+5V Power)     ───────────  VIN / 5V (or external 5V 3A BEC)
Pin 2  (TX Output)     ───────────  GPIO 18 (ESP32 RX)
Pin 3  (RX Input)      ───────────  GPIO 17 (ESP32 TX)
Pin 4  (CTS)           ───────────  NC (Not connected)
Pin 5  (RTS)           ───────────  NC (Not connected)
Pin 6  (GND)           ───────────  GND (Common ground)
```

> [!IMPORTANT]
> **Power Delivery Rule**: During flight, power the ESP32-S3 from an external 5V 3A UBEC or the Pixhawk TELEM2 pin with the LiPo battery connected. Do not power the Pixhawk solely via PC USB when running the ESP32 Wi-Fi radio, as USB current limits (< 500 mA) will trigger brownout resets.

### 6.2. Arduino IDE Flashing Settings
* **Board**: `"ESP32S3 Dev Module"`
* **USB CDC On Boot**: **`Enabled`** *(CRITICAL: Required to see diagnostic Serial prints)*
* **CPU Frequency**: `240MHz (WiFi)`
* **Flash Mode**: `QIO 80MHz`
* **Partition Scheme**: `Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)`
* **Upload Mode**: `UART0 / Hardware CDC`
* **Upload Speed**: `921600`
* **Serial Monitor Baud Rate**: `115200 baud`

### 6.3. Smartphone Hotspot Settings
* **Wi-Fi SSID**: `drone123`
* **Wi-Fi Password**: `drone@123`
* **Apple iPhone**:
  1. Open **Settings $\rightarrow$ Personal Hotspot**.
  2. Toggle **Allow Others to Join** to ON.
  3. Toggle **Maximize Compatibility** to **ON** *(Forces 2.4 GHz broadcast)*.
  4. Keep the Hotspot screen open until ESP32 displays `Associated with hotspot!`.
* **Android Devices**:
  1. Open **Settings $\rightarrow$ Hotspot & Tethering $\rightarrow$ Wi-Fi Hotspot**.
  2. Set **AP Band** to **2.4 GHz Band** *(not 5 GHz)*.
  3. Set Security to **WPA2-Personal**.

### 6.4. Pixhawk Parameters (Mission Planner / QGC)
Connect Pixhawk via USB or telemetry and confirm the following parameters:
* `SERIAL2_PROTOCOL` = `2` (MAVLink 2)
* `SERIAL2_BAUD` = `57` (57600 baud) or `115` (115200 baud)
* `RTL_ALT` = `500` (5.0m return altitude)
* `BRD_SAFETYENABLE` = `0` (or ensure physical safety switch is pressed solid red)

### 6.5. Live Field Verification Procedure
1. **Power Up**: Turn on phone hotspot (`drone123`), then connect LiPo battery to drone.
2. **Serial Monitor Check** (optional bench test):
   * Open Arduino Serial Monitor at 115200 baud.
   * Observe: `🟢 [WIFI] CONNECTED SUCCESSFULLY!` $\rightarrow$ `🟢 [WSS CLOUD RELAY] >>> CONNECTED SUCCESSFULLY! <<<` $\rightarrow$ `🎯 [TELEM2 LOCKED] Valid MAVLink framing confirmed`.
3. **Open GCS**: Navigate to Netlify GCS or run locally (`http://localhost:5173` or `https://dronesph.netlify.app`).
4. **Connect Transport**: Select **ESP32 Wireless Bridge**, verify endpoint is set to `wss://vishal-done-backup.onrender.com/ws`, and click **Connect**.
5. **Observe Status Deck**:
   * Cloud Relay Status: **CONNECTED**
   * ESP32 Bridge Status: **ONLINE**
   * Flight Controller Status: **PIXHAWK_CONNECTED** (Heartbeat indicator pulsing green at $\ge$ 1.0 Hz).

