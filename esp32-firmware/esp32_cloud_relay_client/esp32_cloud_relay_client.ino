/*
 * =====================================================================================
 * SAE INDIA — Autonomous Drone Rescue System
 * ESP32-S3 Cloud Relay Direct WSS Client (Standalone / Zero-Laptop Mode)
 * With Comprehensive Live Serial Monitor Diagnostics & Auto-Baud Detection
 * =====================================================================================
 *
 * HARDWARE: ESP32-S3
 * 
 * EXACT WIRING:
 *   PIXHAWK TELEM2                     ESP32-S3
 *   -----------------                  -----------------
 *   Pin 1  +5V        ───────────────  5V / VIN pin (Safe when drone LiPo battery is connected)
 *   Pin 2  TX         ───────────────  GPIO 18 (RX on ESP32-S3)
 *   Pin 3  RX         ───────────────  GPIO 17 (TX on ESP32-S3)
 *   Pin 4  CTS        ───────────────  NC (Not connected)
 *   Pin 5  RTS        ───────────────  NC (Not connected)
 *   Pin 6  GND        ───────────────  GND (Common Ground)
 *
 * POWER NOTE:
 *   - TELEM2 Pin 1 (+5V) can power the ESP32-S3 directly via the 5V/VIN pin.
 *   - When running on Pixhawk Battery (Power Module / LiPo), TELEM2 delivers 2.5A-3A.
 *   - If Pixhawk is powered ONLY by PC USB without battery, current is limited to ~500mA total.
 *
 * ARDUINO IDE SETTINGS (CRITICAL FOR ESP32-S3 SERIAL MONITOR):
 *   1. Tools -> Board -> "ESP32S3 Dev Module"
 *   2. Tools -> USB CDC On Boot -> "Enabled"  <-- CRITICAL to see Serial output!
 *   3. Tools -> Upload Mode -> "UART0 / Hardware CDC" or "USB-OTG CDC"
 *   4. Set Serial Monitor Baud Rate to: 115200
 *
 * MISSION PLANNER PARAMETERS (TELEM2):
 *   SERIAL2_PROTOCOL = 2   (MAVLink 2)
 *   SERIAL2_BAUD     = 57  (57600 baud) or 115 (115200 baud)
 * =====================================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoWebsockets.h>
#include <time.h>
#include <sys/time.h>

// =====================================================================================
// 1. WI-FI CONFIGURATION (Phone Hotspot or Field Wi-Fi)
// =====================================================================================
// Primary Phone Hotspot / Wi-Fi credentials:
const char* WIFI_SSID     = "drone123";      // <-- Enter your hotspot/Wi-Fi name
const char* WIFI_PASSWORD = "drone@123";   // <-- Enter your Wi-Fi password

// Optional Fallback Wi-Fi (Home / Lab / Backup hotspot):
const char* FALLBACK_SSID = "";
const char* FALLBACK_PASS = "";

// =====================================================================================
// 2. CLOUD RELAY WSS CONFIGURATION (ACTIVE PRODUCTION RELAY)
// =====================================================================================
const char* RELAY_HOST    = "vishal-done-backup.onrender.com";
const uint16_t RELAY_PORT = 443;
const char* RELAY_PATH    = "/connector?token=saeindia_sec_99348a7b1c0e";
const char* RELAY_WSS_URL = "wss://vishal-done-backup.onrender.com/connector?token=saeindia_sec_99348a7b1c0e";
const char* RELAY_TOKEN   = "saeindia_sec_99348a7b1c0e";

// Combined Root CA Certificate Bundle trusted by Render.com & Cloudflare:
// 1. Google Trust Services (GTS Root R4) - Cross-signed by GlobalSign
// 2. GlobalSign Root CA
const char RENDER_CA_BUNDLE[] PROGMEM = 
"-----BEGIN CERTIFICATE-----\n"
"MIIDejCCAmKgAwIBAgIQf+UwvzMTQ77dghYQST2KGzANBgkqhkiG9w0BAQsFADBX\n"
"MQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2lnbiBudi1zYTEQMA4GA1UE\n"
"CxMHUm9vdCBDQTEbMBkGA1UEAxMSR2xvYmFsU2lnbiBSb290IENBMB4XDTIzMTEx\n"
"NTAzNDMyMVoXDTI4MDEyODAwMDA0MlowRzELMAkGA1UEBhMCVVMxIjAgBgNVBAoT\n"
"GUdvb2dsZSBUcnVzdCBTZXJ2aWNlcyBMTEMxFDASBgNVBAMTC0dUUyBSb290IFI0\n"
"MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE83Rzp2iLYK5DuDXFgTB7S0md+8Fhzube\n"
"Rr1r1WEYNa5A3XP3iZEwWus87oV8okB2O6nGuEfYKueSkWpz6bFyOZ8pn6KY019e\n"
"WIZlD6GEZQbR3IvJx3PIjGov5cSr0R2Ko4H/MIH8MA4GA1UdDwEB/wQEAwIBhjAd\n"
"BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwDwYDVR0TAQH/BAUwAwEB/zAd\n"
"BgNVHQ4EFgQUgEzW63T/STaj1dj8tT7FavCUHYwwHwYDVR0jBBgwFoAUYHtmGkUN\n"
"l8qJUC99BM00qP/8/UswNgYIKwYBBQUHAQEEKjAoMCYGCCsGAQUFBzAChhpodHRw\n"
"Oi8vaS5wa2kuZ29vZy9nc3IxLmNydDAtBgNVHR8EJjAkMCKgIKAehhxodHRwOi8v\n"
"Yy5wa2kuZ29vZy9yL2dzcjEuY3JsMBMGA1UdIAQMMAowCAYGZ4EMAQIBMA0GCSqG\n"
"SIb3DQEBCwUAA4IBAQAYQrsPBtYDh5bjP2OBDwmkoWhIDDkic574y04tfzHpn+cJ\n"
"odI2D4SseesQ6bDrarZ7C30ddLibZatoKiws3UL9xnELz4ct92vID24FfVbiI1hY\n"
"+SW6FoVHkNeWIP0GCbaM4C6uVdF5dTUsMVs/ZbzNnIdCp5Gxmx5ejvEau8otR/Cs\n"
"kGN+hr/W5GvT1tMBjgWKZ1i4//emhA1JG1BbPzoLJQvyEotc03lXjTaCzv8mEbep\n"
"8RqZ7a2CPsgRbuvTPBwcOMBBmuFeU88+FSBX6+7iP0il8b4Z0QFqIwwMHfs/L6K1\n"
"vepuoxtGzi4CZ68zJpiq1UvSqTbFJjtbD4seiMHl\n"
"-----END CERTIFICATE-----\n"
"-----BEGIN CERTIFICATE-----\n"
"MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkG\n"
"A1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jv\n"
"b3QgQ0ExGzAZBgNVBAMTEkdsb2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAw\n"
"MDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9i\n"
"YWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJHbG9iYWxT\n"
"aWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaDuaZ\n"
"jc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavp\n"
"xy0Sy6scTHAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp\n"
"1Wrjsok6Vjk4bwY8iGlbKk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdG\n"
"snUOhugZitVtbNV4FpWi6cgKOOvyJBNPc1STE4U6G7weNLWLBYy5d4ux2x8gkasJ\n"
"U26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrXgzT/LCrBbBlDSgeF59N8\n"
"9iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8E\n"
"BTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0B\n"
"AQUFAAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOz\n"
"yj1hTdNGCbM+w6DjY1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE\n"
"38NflNUVyRRBnMRddWQVDf9VMOyGj/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymP\n"
"AbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhHhm4qxFYxldBniYUr+WymXUad\n"
"DKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveCX4XSQRjbgbME\n"
"HMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==\n"
"-----END CERTIFICATE-----\n";

// =====================================================================================
// 3. PIXHAWK TELEM2 UART CONFIGURATION
// =====================================================================================
#define PIXHAWK_RX_PIN    18     // ESP32-S3 GPIO 18 connects to Pixhawk TELEM2 Pin 2 (TX)
#define PIXHAWK_TX_PIN    17     // ESP32-S3 GPIO 17 connects to Pixhawk TELEM2 Pin 3 (RX)
#define PIXHAWK_BAUD      57600  // Initial default baud (57600)

// Auto-Baud Detection: Automatically syncs whether TELEM2 is configured for 57600 or 115200 baud!
const uint32_t TELEM2_BAUDS[] = {57600, 115200};
uint8_t currentBaudIdx = 0;
uint32_t activePixhawkBaud = 57600;
bool isBaudLocked = false;
unsigned long lastBaudSwitchTime = 0;

// Status LED (GPIO 2, set to -1 if your S3 board has no onboard LED)
#define STATUS_LED_PIN    2

// =====================================================================================
// GLOBAL OBJECTS & TELEMETRY COUNTERS
// =====================================================================================
using namespace websockets;
WebsocketsClient wsClient;

// Hardware UART1 on ESP32-S3 for Pixhawk TELEM2
HardwareSerial PixhawkSerial(1);

unsigned long lastPingTime = 0;
const unsigned long PING_INTERVAL_MS = 15000;

unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 3000;

// Wi-Fi Connection Management
unsigned long wifiConnectionStartTime = 0;
uint8_t wifiAttemptCount = 0;
bool usingFallback = false;

// Periodic 3-second live diagnostic print timer
unsigned long lastDiagnosticPrint = 0;
const unsigned long DIAGNOSTIC_INTERVAL_MS = 3000;

// Cumulative statistics
unsigned long totalRxBytesFromPixhawk = 0;
unsigned long totalTxBytesToPixhawk   = 0;
unsigned long totalMavlinkPacketsSent = 0;
unsigned long totalCommandsReceived   = 0;

// UART Batch Buffer for ultra-low-latency, zero-jitter telemetry streaming
#define UART_BUFFER_SIZE 1024
uint8_t uartBuffer[UART_BUFFER_SIZE];
size_t uartBatchLen = 0;
unsigned long lastUartByteTime = 0;

// =====================================================================================
// STATUS LED HELPER
// =====================================================================================
void updateLED(int mode) {
  if (STATUS_LED_PIN < 0) return;
  if (mode == 2) {
    digitalWrite(STATUS_LED_PIN, HIGH); // Solid ON (Connected)
  } else if (mode == 0) {
    digitalWrite(STATUS_LED_PIN, LOW);  // OFF
  } else {
    digitalWrite(STATUS_LED_PIN, (millis() / 250) % 2); // Blinking (Connecting)
  }
}

// =====================================================================================
// BASELINE SYSTEM CLOCK INITIALIZATION (CRITICAL FOR SSL/TLS VALIDATION)
// =====================================================================================
// When ESP32 powers on, RTC clock is at Epoch 0 (1970). Any TLS certificate with
// 'NotBefore' in 2023-2026 will immediately fail validation if system time is 1970!
// This function sets a sane 2026 baseline timestamp so TLS works immediately even
// if mobile hotspot blocks NTP UDP port 123.
void ensureSaneSystemClock() {
  time_t now = time(nullptr);
  if (now < 1704067200) { // If before Jan 1, 2024
    struct timeval tv;
    tv.tv_sec = 1775730000; // Baseline epoch (Year 2026)
    tv.tv_usec = 0;
    settimeofday(&tv, nullptr);
    Serial.println("🕒 [TIME] Initialized baseline system clock (Year 2026) for instant TLS validation.");
  }
}

// =====================================================================================
// WEBSOCKET EVENT CALLBACKS
// =====================================================================================
void onMessageCallback(WebsocketsMessage message) {
  if (message.isBinary()) {
    // Binary MAVLink command frame received from Phone -> Forward to Pixhawk TELEM2
    const uint8_t* payload = (const uint8_t*)message.c_str();
    size_t length = message.length();
    
    // Write directly to ESP32 Hardware UART FIFO without blocking CPU
    PixhawkSerial.write(payload, length);

    totalTxBytesToPixhawk += length;
    totalCommandsReceived++;

    Serial.printf("📥 [PHONE -> PIXHAWK] Command received (%u bytes) -> Sent to TELEM2 (Total TX: %lu bytes)\n",
                  length, totalTxBytesToPixhawk);
  } else if (message.isText()) {
    Serial.printf("ℹ️ [RELAY MESSAGE] %s\n", message.data().c_str());
  }
}

void onEventsCallback(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    Serial.println("\n");
    Serial.println("*********************************************************");
    Serial.println("🟢 [WSS CLOUD RELAY] >>> CONNECTED SUCCESSFULLY! <<<");
    Serial.println("🌐 Drone is now online in the cloud. Phone webapp ready!");
    Serial.println("*********************************************************\n");
    updateLED(2);

    // Announce connection to relay server
    wsClient.send("{\"type\":\"ESP32_STATUS\",\"status\":\"CONNECTED\",\"device\":\"ESP32_S3_STANDALONE\"}");
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    Serial.println("\n🔴 [WSS CLOUD RELAY] Connection closed. Will reconnect automatically...");
    updateLED(0);
  } else if (event == WebsocketsEvent::GotPing) {
    // Ping acknowledged
  } else if (event == WebsocketsEvent::GotPong) {
    // Pong received
  }
}

// =====================================================================================
// WI-FI SCANNER DIAGNOSTIC HELPER
// =====================================================================================
void scanVisibleNetworks() {
  Serial.println("\n🔍 [WIFI SCAN] Scanning visible 2.4 GHz networks in the air...");
  int n = WiFi.scanNetworks(false, false, false, 300);
  if (n <= 0) {
    Serial.println("   ❌ No 2.4 GHz Wi-Fi networks found!");
    Serial.println("   👉 iPhone Users: Turn ON 'Maximize Compatibility' in Personal Hotspot settings!");
    Serial.println("   👉 Android Users: Set Hotspot band to '2.4 GHz' (ESP32 cannot see 5 GHz)!");
  } else {
    Serial.printf("   Found %d networks:\n", n);
    for (int i = 0; i < n; ++i) {
      Serial.printf("   %2d) '%s' (Signal: %d dBm) %s\n",
                    i + 1,
                    WiFi.SSID(i).c_str(),
                    WiFi.RSSI(i),
                    WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "[OPEN]" : "[SECURED]");
    }
  }
  WiFi.scanDelete();
  Serial.println("---------------------------------------------------------");
}

// =====================================================================================
// WI-FI CONNECTION HELPER (ROBUST & NON-BLOCKING)
// =====================================================================================
void startWiFiConnection(const char* ssid, const char* pass) {
  Serial.println("---------------------------------------------------------");
  Serial.printf("📡 [WIFI] Initiating connection to SSID: '%s' ...\n", ssid);
  Serial.println("---------------------------------------------------------");
  
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, pass);
  wifiConnectionStartTime = millis();
}

void connectToWiFi(bool isInitialSetup = false) {
  if (WiFi.status() == WL_CONNECTED) return;

  const char* activeSSID = usingFallback ? FALLBACK_SSID : WIFI_SSID;
  const char* activePass = usingFallback ? FALLBACK_PASS : WIFI_PASSWORD;

  startWiFiConnection(activeSSID, activePass);

  if (isInitialSetup) {
    // Give up to 8 seconds for initial fast connection
    unsigned long startAttempt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 8000) {
      delay(250);
      Serial.print(".");
      updateLED(1);
    }
    Serial.println();
  }

  if (WiFi.status() == WL_CONNECTED) {
    // Disable ESP32 802.11 modem sleep to eliminate DTIM jitter & keep latency <5ms
    WiFi.setSleep(false);
    Serial.println("🟢 [WIFI] CONNECTED SUCCESSFULLY!");
    Serial.printf("📍 [WIFI] IP Address:    %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("📶 [WIFI] Signal (RSSI):  %d dBm\n", WiFi.RSSI());
    Serial.printf("🚪 [WIFI] Gateway:        %s\n", WiFi.gatewayIP().toString().c_str());
    Serial.printf("🔍 [WIFI] DNS Server:    %s\n", WiFi.dnsIP().toString().c_str());
    
    // Ensure system clock has valid timestamp for TLS
    ensureSaneSystemClock();

    Serial.println("⏳ [NTP] Synchronizing network time...");
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    Serial.println("---------------------------------------------------------");
  } else if (isInitialSetup) {
    Serial.println("⚠️ [WIFI PENDING] Hotspot not yet connected. Will retry in background.");
    Serial.println("   👉 iPhone: Ensure 'Maximize Compatibility' is enabled.");
    Serial.println("   👉 Android: Ensure Hotspot band is set to 2.4 GHz.");
    Serial.printf("   👉 Active SSID: '%s'\n", activeSSID);
    Serial.println("---------------------------------------------------------");
    scanVisibleNetworks();
  }
}

// Background Wi-Fi monitor called from loop()
void handleWiFiMaintenance() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiAttemptCount = 0;
    return;
  }

  updateLED(1);

  // If disconnected for > 15 seconds, switch between primary and fallback, then retry
  if (millis() - wifiConnectionStartTime > 15000) {
    wifiAttemptCount++;
    Serial.printf("⚠️ [WIFI RETRY] Re-attempting Wi-Fi connection (Attempt #%d)...\n", wifiAttemptCount);

    if (strlen(FALLBACK_SSID) > 0) {
      usingFallback = !usingFallback;
    }

    const char* targetSSID = usingFallback ? FALLBACK_SSID : WIFI_SSID;
    const char* targetPass = usingFallback ? FALLBACK_PASS : WIFI_PASSWORD;

    WiFi.disconnect(false); // Soft disconnect without resetting RF calibrations
    delay(100);
    startWiFiConnection(targetSSID, targetPass);

    // If 3 failed attempts, scan the air to assist troubleshooting
    if (wifiAttemptCount >= 3) {
      wifiAttemptCount = 0;
      scanVisibleNetworks();
    }
  }
}

// =====================================================================================
// CLOUD RELAY CONNECTION HELPER (BULLETPROOF SSL/TLS)
// =====================================================================================
void connectToCloudRelay() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (wsClient.available()) return;

  if (millis() - lastReconnectAttempt < RECONNECT_INTERVAL_MS) return;
  lastReconnectAttempt = millis();

  // 1. Verify DNS resolution
  IPAddress relayIP;
  if (!WiFi.hostByName(RELAY_HOST, relayIP)) {
    Serial.printf("❌ [DNS FAILED] Could not resolve '%s' via DNS %s. Check Internet connection!\n",
                  RELAY_HOST, WiFi.dnsIP().toString().c_str());
    return;
  }
  Serial.printf("🌐 [DNS OK] %s -> %s\n", RELAY_HOST, relayIP.toString().c_str());

  // 2. Ensure baseline clock is initialized so TLS certificate is not rejected as 'not yet valid'
  ensureSaneSystemClock();

  Serial.println("☁️  [WSS] Connecting to Render Cloud Relay via SSL...");
  Serial.printf("🔗 [WSS] URL: %s\n", RELAY_WSS_URL);
  
  // 3. Configure CA Certificate Bundle for Render.com (GTS Root R4 + GlobalSign Root CA)
  wsClient.setCACert(RENDER_CA_BUNDLE);
  wsClient.addHeader("x-relay-token", RELAY_TOKEN);

  // 4. Attempt connection using full WSS URL
  bool connected = wsClient.connect(RELAY_WSS_URL);

  // Fallback: If URL connect failed, attempt explicit host, port, path
  if (!connected) {
    Serial.println("⚠️  [WSS] URL connect failed, trying explicit host/port/path...");
    connected = wsClient.connect(RELAY_HOST, RELAY_PORT, RELAY_PATH);
  }

  if (!connected) {
    Serial.println("⚠️  [WSS] Connection attempt failed. Retrying in 3 seconds...");
  }
}

// =====================================================================================
// SETUP
// =====================================================================================
void setup() {
  // Initialize USB Serial for Monitor
  Serial.begin(115200);
  
  // Give ESP32-S3 Native USB CDC time to attach to PC (prevents missed logs)
  unsigned long startWait = millis();
  while (!Serial && millis() - startWait < 3000) {
    delay(50);
  }
  delay(500);

  Serial.println();
  Serial.println("=========================================================");
  Serial.println("🚀 SAE INDIA — ESP32-S3 DIRECT CLOUD RELAY CLIENT");
  Serial.println("   Standalone Phone-to-Drone MAVLink Bridge");
  Serial.println("=========================================================");
  Serial.printf("📋 Hardware Target:     ESP32-S3\n");
  Serial.printf("🔌 Pixhawk TELEM2 RX:   GPIO %d (Connects to Pixhawk TX Pin 2)\n", PIXHAWK_RX_PIN);
  Serial.printf("🔌 Pixhawk TELEM2 TX:   GPIO %d (Connects to Pixhawk RX Pin 3)\n", PIXHAWK_TX_PIN);
  Serial.printf("⚡ Pixhawk Baud Rate:   %lu baud (Auto-Sync: 57600 / 115200)\n", (unsigned long)activePixhawkBaud);
  Serial.printf("☁️  Cloud Relay Host:   %s\n", RELAY_HOST);
  Serial.println("=========================================================\n");

  if (STATUS_LED_PIN >= 0) {
    pinMode(STATUS_LED_PIN, OUTPUT);
    digitalWrite(STATUS_LED_PIN, LOW);
  }

  // Pre-seed baseline system clock for TLS certificate checks
  ensureSaneSystemClock();

  // Initialize Pixhawk Hardware UART1:
  // RX = GPIO 18 (connects to Pixhawk TELEM2 Pin 2 TX)
  // TX = GPIO 17 (connects to Pixhawk TELEM2 Pin 3 RX)
  PixhawkSerial.setRxBufferSize(2048); // Expand hardware FIFO to prevent buffer overflow on burst telemetry
  PixhawkSerial.setTxBufferSize(2048); // Expand hardware FIFO for smooth outbound MAVLink commands
  PixhawkSerial.begin(activePixhawkBaud, SERIAL_8N1, PIXHAWK_RX_PIN, PIXHAWK_TX_PIN);
  PixhawkSerial.setTimeout(5); // Non-blocking 5ms timeout for ultra-low-latency UART reads
  Serial.printf("✅ [TELEM2 UART] Hardware Serial1 ready on GPIO 18 (RX) and GPIO 17 (TX) @ %lu baud.\n", (unsigned long)activePixhawkBaud);

  // Configure WebSocket Client callbacks, CA certificates, and headers
  wsClient.setCACert(RENDER_CA_BUNDLE);
  wsClient.addHeader("x-relay-token", RELAY_TOKEN);
  wsClient.onMessage(onMessageCallback);
  wsClient.onEvent(onEventsCallback);

  // Connect to Wi-Fi / Phone Hotspot (initial quick attempt)
  connectToWiFi(true);
}

// =====================================================================================
// MAIN LOOP
// =====================================================================================
void loop() {
  // 1. Maintain Wi-Fi Connection (Non-blocking background monitor)
  handleWiFiMaintenance();

  // 2. Maintain WebSocket Connection to Cloud Relay
  if (WiFi.status() == WL_CONNECTED) {
    if (!wsClient.available()) {
      updateLED(1);
      connectToCloudRelay();
    } else {
      updateLED(2); // Solid ON when fully connected
    }
  }

  // 3. Poll WebSocket Client for incoming commands from Phone (Zero delay)
  if (wsClient.available()) {
    wsClient.poll();
  }

  // 4. Send Periodic Ping to keep cloud relay connection alive through NAT
  if (wsClient.available() && millis() - lastPingTime > PING_INTERVAL_MS) {
    lastPingTime = millis();
    wsClient.ping();
  }

  // 5. Read binary MAVLink telemetry from Pixhawk TELEM2 -> Forward to Cloud Relay
  // ULTRA-LOW-LATENCY INTELLIGENT BATCHING:
  // Collect bytes from UART until either 256 bytes accumulate OR UART line goes idle for 12ms.
  while (PixhawkSerial.available() > 0 && uartBatchLen < UART_BUFFER_SIZE) {
    uint8_t b = (uint8_t)PixhawkSerial.read();
    if (b == 0xFE || b == 0xFD) {
      if (!isBaudLocked) {
        isBaudLocked = true;
        Serial.printf("\n🎯 [TELEM2 LOCKED] Valid MAVLink framing (0x%02X) confirmed at %lu baud!\n", b, (unsigned long)activePixhawkBaud);
      }
    }
    uartBuffer[uartBatchLen++] = b;
    lastUartByteTime = millis();
    totalRxBytesFromPixhawk++;
  }

  // Auto-baud switcher: If no valid MAVLink header seen after 7s, test alternate baud (57600 <-> 115200)
  if (!isBaudLocked && (millis() - lastBaudSwitchTime > 7000)) {
    lastBaudSwitchTime = millis();
    currentBaudIdx = (currentBaudIdx + 1) % 2;
    activePixhawkBaud = TELEM2_BAUDS[currentBaudIdx];
    PixhawkSerial.begin(activePixhawkBaud, SERIAL_8N1, PIXHAWK_RX_PIN, PIXHAWK_TX_PIN);
    Serial.printf("🔄 [TELEM2 AUTO-BAUD] Testing %lu baud on TELEM2...\n", (unsigned long)activePixhawkBaud);
  }

  bool shouldFlush = (uartBatchLen >= 256) || (uartBatchLen > 0 && (millis() - lastUartByteTime >= 12));

  if (shouldFlush && wsClient.available()) {
    wsClient.sendBinary((const char*)uartBuffer, uartBatchLen);
    totalMavlinkPacketsSent++;
    uartBatchLen = 0;
  }

  // 6. Periodic 3-Second Live Status Heartbeat
  if (millis() - lastDiagnosticPrint > DIAGNOSTIC_INTERVAL_MS) {
    lastDiagnosticPrint = millis();

    Serial.printf("📊 [MONITOR] Wi-Fi: %s | Cloud: %s | TELEM2 (%lu baud): %s | Pixhawk RX: %lu B | TX: %lu B\n",
                  WiFi.status() == WL_CONNECTED ? "ONLINE ✓" : "OFFLINE ✗",
                  wsClient.available() ? "STREAMING ✓" : "CONNECTING...",
                  (unsigned long)activePixhawkBaud,
                  isBaudLocked ? "LOCKED ✓" : (totalRxBytesFromPixhawk == 0 ? "NO SIGNAL (Check Pin 18)" : "SYNCING..."),
                  totalRxBytesFromPixhawk,
                  totalTxBytesToPixhawk);
  }
}
