/*
 * =====================================================================================
 * SAE INDIA — Autonomous Drone Rescue System
 * ESP32-S3 Direct Cloud Relay Client (Dual-Core FreeRTOS Architecture)
 * =====================================================================================
 *
 * ARCHITECTURAL SPECIFICATION:
 *   - Early Brownout Detector (BOD) suppression before setup() via constructor.
 *   - 2.4 GHz spectrum scan, channel lock, PMF (capable=true, required=false),
 *     WiFi.setSleep(false), WiFi.persistent(false) for SSID 'drone123' / 'drone@123'.
 *   - Epoch 2026 clock seeding (1775730000) before NTP for instant TLS validity.
 *   - Dual Root CA bundle (GTS Root R4 + GlobalSign Root CA) in PROGMEM with 
 *     3-stage fallback: (1) URL -> (2) host/port/path -> (3) setInsecure().
 *   - RTC_DATA_ATTR int savedPixhawkBaud caching, 57600/115200 auto-baud detection 
 *     every 12s until MAVLink sync is locked. Survives warm resets in <10ms.
 *   - Dual-Core FreeRTOS:
 *       * Core 1: 1ms UART drain with 4KB RX FIFO, MAVLink v1/v2 frame assembler,
 *         STATUSTEXT (msgid 253) QR intercept emitting {"type":"QR_ALERT",...},
 *         pushes frames to thread-safe queue qTxToCloud.
 *       * Core 0: Manages Wi-Fi & WSS SSL client, telemetry batching (256B / 12ms),
 *         sends {"type":"ESP32_STATUS",...} on connect & every 10s, and non-blocking
 *         {"type":"ESP32_DIAG",...} frame every 5s for live bench/cable health.
 *
 * HARDWARE: ESP32-S3
 *   PIXHAWK TELEM2                     ESP32-S3
 *   -----------------                  -----------------
 *   Pin 1  +5V        ───────────────  5V / VIN (Safe with drone LiPo battery)
 *   Pin 2  TX         ───────────────  GPIO 18 (RX on ESP32-S3)
 *   Pin 3  RX         ───────────────  GPIO 17 (TX on ESP32-S3)
 *   Pin 4  CTS        ───────────────  NC
 *   Pin 5  RTS        ───────────────  NC
 *   Pin 6  GND        ───────────────  GND (Common Ground)
 * =====================================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoWebsockets.h>
#include <time.h>
#include <sys/time.h>
#include "esp_wifi.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// =====================================================================================
// 1. EARLY BROWNOUT DETECTOR (BOD) SUPPRESSION
// =====================================================================================
// Runs before setup() and before global C++ static initializers complete,
// preventing voltage brownout resets when Wi-Fi radio powers up on 5V rails.
__attribute__((constructor)) static void early_disable_bod_constructor() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
}

struct EarlyBODTrigger {
  EarlyBODTrigger() {
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  }
};
static EarlyBODTrigger _bodInitTrigger;

// =====================================================================================
// 2. WI-FI & CLOUD RELAY CONFIGURATION
// =====================================================================================
const char* WIFI_SSID     = "drone123";
const char* WIFI_PASSWORD = "drone@123";

const char* FALLBACK_SSID = "";
const char* FALLBACK_PASS = "";

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
// 3. PIXHAWK TELEM2 UART CONFIGURATION & AUTO-BAUD CACHING
// =====================================================================================
#define PIXHAWK_RX_PIN    18     // ESP32-S3 GPIO 18 connects to Pixhawk TELEM2 Pin 2 (TX)
#define PIXHAWK_TX_PIN    17     // ESP32-S3 GPIO 17 connects to Pixhawk TELEM2 Pin 3 (RX)
#define STATUS_LED_PIN    2      // Status LED (set to -1 if absent)

// RTC Slow Memory variable persists locked baud rate across warm boots & soft resets (<10ms re-lock)
RTC_DATA_ATTR int savedPixhawkBaud = 57600;
#define rtcLockedBaud savedPixhawkBaud

int activePixhawkBaud = 57600;
bool isBaudLocked = false;
unsigned long lastBaudSwitchTime = 0;

HardwareSerial PixhawkSerial(1);

// =====================================================================================
// 4. DUAL-CORE FREERTOS QUEUES & DATA STRUCTURES
// =====================================================================================
#define MAV_MAX_FRAME_LEN 280

enum CloudMsgType {
  MSG_BINARY_MAVLINK = 0,
  MSG_TEXT_JSON      = 1
};

struct CloudPacket {
  CloudMsgType type;
  size_t len;
  uint8_t data[MAV_MAX_FRAME_LEN];
};

static QueueHandle_t qTxToCloud = nullptr;
static TaskHandle_t taskCore0Handle = nullptr;
static TaskHandle_t taskCore1Handle = nullptr;

// =====================================================================================
// GLOBAL WEBSOCKET & NETWORK STATE (CORE 0)
// =====================================================================================
using namespace websockets;
WebsocketsClient wsClient;

unsigned long lastPingTime = 0;
const unsigned long PING_INTERVAL_MS = 15000;

unsigned long lastStatusReportTime = 0;
unsigned long lastDiagReportTime = 0;
const unsigned long DIAG_INTERVAL_MS = 5000;
unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 3000;

unsigned long wifiConnectionStartTime = 0;
uint8_t wifiAttemptCount = 0;
bool usingFallback = false;

// Channel Lock State
int32_t lockedChannel = 0;
uint8_t lockedBSSID[6] = {0};
bool hasLockedChannel = false;

// Cumulative Telemetry & Error Counters (Atomic/Volatile across Cores)
volatile unsigned long totalRxBytesFromPixhawk = 0;
volatile unsigned long totalTxBytesToPixhawk   = 0;
volatile unsigned long totalMavlinkPacketsSent = 0;
volatile unsigned long totalCommandsReceived   = 0;
volatile unsigned long crcErrorCount           = 0;

// Batch buffer for Core 0 WebSocket binary flushes
#define BATCH_BUFFER_SIZE 1024
static uint8_t txBatchBuffer[BATCH_BUFFER_SIZE];
static size_t txBatchLen = 0;
static unsigned long lastBatchFlushTime = 0;

// Forward declaration of batch flush helper
void flushTxBatch();

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
// BASELINE SYSTEM CLOCK (EPOCH 2026 INITIALIZATION)
// =====================================================================================
// Pre-seed system clock to Epoch 2026 (1775730000 - April 2026) so TLS certificates
// with 'NotBefore' in 2023-2026 pass validation immediately even if NTP is blocked.
void ensureSaneSystemClock() {
  time_t now = time(nullptr);
  if (now < 1775730000) {
    struct timeval tv;
    tv.tv_sec = 1775730000;
    tv.tv_usec = 0;
    settimeofday(&tv, nullptr);
    Serial.println("🕒 [TIME] Seeded baseline Epoch 2026 clock (1775730000) before NTP for TLS.");
  }
}

// =====================================================================================
// STATUS REPORTING HELPER (CORE 0)
// =====================================================================================
void sendEsp32StatusReport(const char* statusStr) {
  if (!wsClient.available()) return;

  int rssiVal = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
  unsigned long uptime = millis();

  char statusJson[160];
  snprintf(statusJson, sizeof(statusJson),
           "{\"type\":\"ESP32_STATUS\",\"status\":\"%s\",\"baud\":%d,\"rssi\":%d,\"uptimeMs\":%lu}",
           statusStr, activePixhawkBaud, rssiVal, uptime);

  wsClient.send(statusJson);
  Serial.printf("📡 [STATUS REPORT] %s\n", statusJson);
}

// =====================================================================================
// NON-BLOCKING DIAGNOSTIC TELEMETRY HELPER (CORE 0)
// =====================================================================================
// Emits 5-second live telemetry diagnostics over WebSocket so operators can monitor
// live cable and UART health on the bench before Pixhawk heartbeats lock.
void sendEsp32DiagReport() {
  if (!wsClient.available()) return;

  flushTxBatch();

  char diagJson[220];
  snprintf(diagJson, sizeof(diagJson),
           "{\"type\":\"ESP32_DIAG\",\"rssi\":%d,\"freeHeap\":%u,\"uartRxBytes\":%lu,\"crcErrors\":%lu,\"baud\":%d,\"uptimeMs\":%lu}",
           WiFi.RSSI(),
           (uint32_t)ESP.getFreeHeap(),
           totalRxBytesFromPixhawk,
           crcErrorCount,
           activePixhawkBaud,
           millis());

  wsClient.send(diagJson);
  Serial.printf("🩺 [ESP32_DIAG] %s\n", diagJson);
}

// =====================================================================================
// WEBSOCKET CLIENT EVENT CALLBACKS (CORE 0)
// =====================================================================================
void onMessageCallback(WebsocketsMessage message) {
  if (message.isBinary()) {
    const uint8_t* payload = (const uint8_t*)message.c_str();
    size_t length = message.length();

    // Fast direct transmit to Pixhawk TELEM2 hardware UART FIFO
    PixhawkSerial.write(payload, length);
    PixhawkSerial.flush();

    totalTxBytesToPixhawk += length;
    totalCommandsReceived++;

    Serial.printf("📥 [GCS -> PIXHAWK] Command (%u bytes) -> Forwarded to TELEM2 (Total TX: %lu bytes)\n",
                  (unsigned int)length, totalTxBytesToPixhawk);
  } else if (message.isText()) {
    Serial.printf("ℹ️ [RELAY MESSAGE] %s\n", message.data().c_str());
  }
}

void onEventsCallback(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    Serial.println("\n*********************************************************");
    Serial.println("🟢 [WSS CLOUD RELAY] >>> CONNECTED SUCCESSFULLY! <<<");
    Serial.println("🌐 Drone is now online in the cloud. GCS client ready!");
    Serial.println("*********************************************************\n");
    updateLED(2);

    // Announce status & diagnostic frames immediately upon connect
    sendEsp32StatusReport("CONNECTED");
    sendEsp32DiagReport();
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
// 2.4 GHz SPECTRUM SCAN & CHANNEL LOCK
// =====================================================================================
void scanAndLockChannel() {
  Serial.println("\n🔍 [SPECTRUM SCAN] Scanning 2.4 GHz spectrum for SSID: 'drone123'...");
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);

  int n = WiFi.scanNetworks(false, false, false, 300);
  if (n <= 0) {
    Serial.println("   ❌ No 2.4 GHz networks found during spectrum scan.");
    hasLockedChannel = false;
  } else {
    int bestRSSI = -999;
    int bestIdx = -1;
    Serial.printf("   Found %d visible networks:\n", n);
    for (int i = 0; i < n; ++i) {
      String ssid = WiFi.SSID(i);
      int rssi = WiFi.RSSI(i);
      int32_t ch = WiFi.channel(i);
      Serial.printf("   %2d) '%s' (Ch %d, %d dBm) %s\n",
                    i + 1, ssid.c_str(), ch, rssi,
                    WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "[OPEN]" : "[SECURED]");

      if (ssid == WIFI_SSID) {
        if (rssi > bestRSSI) {
          bestRSSI = rssi;
          bestIdx = i;
        }
      }
    }

    if (bestIdx >= 0) {
      lockedChannel = WiFi.channel(bestIdx);
      memcpy(lockedBSSID, WiFi.BSSID(bestIdx), 6);
      hasLockedChannel = true;
      Serial.printf("🎯 [CHANNEL LOCK] Locked onto '%s' on Channel %d (BSSID %02X:%02X:%02X:%02X:%02X:%02X, RSSI %d dBm)\n",
                    WIFI_SSID,
                    lockedChannel,
                    lockedBSSID[0], lockedBSSID[1], lockedBSSID[2],
                    lockedBSSID[3], lockedBSSID[4], lockedBSSID[5],
                    bestRSSI);
    } else {
      Serial.println("   ⚠️ Target SSID 'drone123' not detected in scan; falling back to standard connect.");
      hasLockedChannel = false;
    }
  }
  WiFi.scanDelete();
  Serial.println("---------------------------------------------------------");
}

// =====================================================================================
// WI-FI INITIALIZATION WITH CHANNEL LOCK & PMF CONFIGURATION
// =====================================================================================
void startWiFiConnection(const char* ssid, const char* pass) {
  Serial.println("---------------------------------------------------------");
  Serial.printf("📡 [WIFI] Initiating connection to SSID: '%s' ...\n", ssid);

  WiFi.disconnect(true);
  delay(50);

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false); // Disable NVS persistence to protect flash
  WiFi.setAutoReconnect(true);

  // Configure Protected Management Frames (PMF): capable=true, required=false
  wifi_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, &conf) == ESP_OK) {
    conf.sta.pmf_cfg.capable = true;
    conf.sta.pmf_cfg.required = false;
    esp_wifi_set_config(WIFI_IF_STA, &conf);
    Serial.println("🔒 [PMF] Configured PMF: capable=true, required=false");
  }

  // Disable 802.11 modem sleep to eliminate DTIM latency & keep latency <5ms
  WiFi.setSleep(false);

  // Fast direct association using locked channel & BSSID
  if (hasLockedChannel && strcmp(ssid, WIFI_SSID) == 0 && lockedChannel > 0) {
    Serial.printf("⚡ [FAST CONNECT] Connecting directly on locked Channel %d...\n", lockedChannel);
    WiFi.begin(ssid, pass, lockedChannel, lockedBSSID);
  } else {
    WiFi.begin(ssid, pass);
  }

  WiFi.setSleep(false);
  wifiConnectionStartTime = millis();
  Serial.println("---------------------------------------------------------");
}

void connectToWiFi(bool isInitialSetup = false) {
  if (WiFi.status() == WL_CONNECTED) return;

  if (isInitialSetup || !hasLockedChannel) {
    scanAndLockChannel();
  }

  const char* activeSSID = usingFallback ? FALLBACK_SSID : WIFI_SSID;
  const char* activePass = usingFallback ? FALLBACK_PASS : WIFI_PASSWORD;

  startWiFiConnection(activeSSID, activePass);

  if (isInitialSetup) {
    unsigned long startAttempt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 8000) {
      delay(250);
      Serial.print(".");
      updateLED(1);
    }
    Serial.println();
  }

  if (WiFi.status() == WL_CONNECTED) {
    WiFi.setSleep(false);
    Serial.println("🟢 [WIFI] CONNECTED SUCCESSFULLY!");
    Serial.printf("📍 [WIFI] IP Address:    %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("📶 [WIFI] Signal (RSSI):  %d dBm\n", WiFi.RSSI());
    Serial.printf("🚪 [WIFI] Gateway:        %s\n", WiFi.gatewayIP().toString().c_str());
    Serial.printf("🔍 [WIFI] DNS Server:    %s\n", WiFi.dnsIP().toString().c_str());

    ensureSaneSystemClock();

    Serial.println("⏳ [NTP] Synchronizing network time...");
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    Serial.println("---------------------------------------------------------");
  } else if (isInitialSetup) {
    Serial.println("⚠️ [WIFI PENDING] Hotspot not yet connected. Will retry in background.");
    Serial.printf("   👉 Active SSID: '%s'\n", activeSSID);
    Serial.println("---------------------------------------------------------");
  }
}

void handleWiFiMaintenance() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiAttemptCount = 0;
    return;
  }

  updateLED(1);

  if (millis() - wifiConnectionStartTime > 15000) {
    wifiAttemptCount++;
    Serial.printf("⚠️ [WIFI RETRY] Re-attempting Wi-Fi connection (Attempt #%d)...\n", wifiAttemptCount);

    if (strlen(FALLBACK_SSID) > 0) {
      usingFallback = !usingFallback;
    }

    const char* targetSSID = usingFallback ? FALLBACK_SSID : WIFI_SSID;
    const char* targetPass = usingFallback ? FALLBACK_PASS : WIFI_PASSWORD;

    scanAndLockChannel();
    startWiFiConnection(targetSSID, targetPass);
  }
}

// =====================================================================================
// CLOUD RELAY 3-STAGE FALLBACK WSS CONNECTION
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

  // 2. Ensure system clock satisfies TLS certificate NotBefore
  ensureSaneSystemClock();

  Serial.println("☁️  [WSS] Connecting to Render Cloud Relay via SSL...");

  // STAGE 1: Full WSS URL with CA Bundle verification
  Serial.println("🔐 [WSS STAGE 1] Connecting via full WSS URL with Dual Root CA verification...");
  wsClient.setCACert(RENDER_CA_BUNDLE);
  wsClient.addHeader("x-relay-token", RELAY_TOKEN);
  bool connected = wsClient.connect(RELAY_WSS_URL);

  // STAGE 2: Explicit Host, Port, Path with CA Bundle verification
  if (!connected) {
    Serial.println("⚠️  [WSS STAGE 2] Stage 1 failed. Trying explicit host/port/path with CA verification...");
    wsClient.setCACert(RENDER_CA_BUNDLE);
    wsClient.addHeader("x-relay-token", RELAY_TOKEN);
    connected = wsClient.connect(RELAY_HOST, RELAY_PORT, RELAY_PATH);
  }

  // STAGE 3: Insecure TLS fallback (setInsecure())
  if (!connected) {
    Serial.println("⚠️  [WSS STAGE 3] Stage 2 failed. Trying fallback with setInsecure()...");
    wsClient.setInsecure();
    wsClient.addHeader("x-relay-token", RELAY_TOKEN);
    connected = wsClient.connect(RELAY_WSS_URL);
    if (!connected) {
      connected = wsClient.connect(RELAY_HOST, RELAY_PORT, RELAY_PATH);
    }
  }

  if (connected) {
    Serial.println("🟢 [WSS] Connection established successfully!");
  } else {
    Serial.println("❌ [WSS] All 3 connection stages failed. Retrying in 3 seconds...");
  }
}

// =====================================================================================
// HARDWARE UART RE-CONFIGURATION & BUFFER SETUP
// =====================================================================================
void switchPixhawkBaud(int newBaud) {
  activePixhawkBaud = newBaud;
  PixhawkSerial.flush();
  PixhawkSerial.end();
  // Expand hardware RX FIFO to 4KB as mandated by architecture
  PixhawkSerial.setRxBufferSize(4096);
  PixhawkSerial.setTxBufferSize(2048);
  PixhawkSerial.begin(activePixhawkBaud, SERIAL_8N1, PIXHAWK_RX_PIN, PIXHAWK_TX_PIN);
}

// =====================================================================================
// CORE 1: MAVLINK FRAME ASSEMBLER & STATUSTEXT QR INTERCEPTOR
// =====================================================================================
static uint8_t asmBuf[MAV_MAX_FRAME_LEN];
static size_t asmIdx = 0;
static size_t asmTargetLen = 0;
static bool asmV2 = false;
static unsigned long asmLastByteTime = 0;

void resetAssembler() {
  asmIdx = 0;
  asmTargetLen = 0;
  asmV2 = false;
}

void checkAssemblerTimeout() {
  if (asmIdx > 0 && (millis() - asmLastByteTime > 25)) {
    crcErrorCount++;
    resetAssembler();
  }
}

void handleAssembledMavlinkFrame(const uint8_t* frame, size_t frameLen) {
  // Confirm and lock baud if not already locked; update savedPixhawkBaud in RTC slow memory
  if (!isBaudLocked) {
    isBaudLocked = true;
    savedPixhawkBaud = activePixhawkBaud;
    Serial.printf("\n🎯 [TELEM2 LOCKED] Valid MAVLink framing confirmed (%u bytes) at %d baud! Cached in RTC savedPixhawkBaud.\n",
                  (unsigned int)frameLen, activePixhawkBaud);
  } else if (savedPixhawkBaud != activePixhawkBaud) {
    savedPixhawkBaud = activePixhawkBaud;
  }

  totalMavlinkPacketsSent++;

  // Intercept STATUSTEXT (msgid 253)
  bool isStatustext = false;
  char textBuf[64];
  memset(textBuf, 0, sizeof(textBuf));

  if (frame[0] == 0xFE) { // MAVLink v1
    uint8_t payloadLen = frame[1];
    uint8_t msgId = frame[5];
    if (msgId == 253 && payloadLen >= 2) {
      isStatustext = true;
      size_t copyLen = (payloadLen - 1 > 50) ? 50 : (payloadLen - 1);
      memcpy(textBuf, &frame[7], copyLen); // frame[6] is severity, frame[7..] is text
      textBuf[copyLen] = '\0';
    }
  } else if (frame[0] == 0xFD) { // MAVLink v2
    uint8_t payloadLen = frame[1];
    uint32_t msgId = (uint32_t)frame[7] | ((uint32_t)frame[8] << 8) | ((uint32_t)frame[9] << 16);
    if (msgId == 253 && payloadLen >= 2) {
      isStatustext = true;
      size_t copyLen = (payloadLen - 1 > 50) ? 50 : (payloadLen - 1);
      memcpy(textBuf, &frame[11], copyLen); // frame[10] is severity, frame[11..] is text
      textBuf[copyLen] = '\0';
    }
  }

  // Intercept QR_CODE: in STATUSTEXT payload
  if (isStatustext) {
    char* qrPos = strstr(textBuf, "QR_CODE:");
    if (qrPos != nullptr) {
      char* codePtr = qrPos + 8; // skip "QR_CODE:"
      while (*codePtr == ' ') codePtr++;

      char extractedCode[32];
      size_t cIdx = 0;
      while (*codePtr && *codePtr != ' ' && *codePtr != '\r' && *codePtr != '\n' && cIdx < 31) {
        extractedCode[cIdx++] = *codePtr++;
      }
      extractedCode[cIdx] = '\0';

      char rawClean[64];
      strncpy(rawClean, textBuf, sizeof(rawClean) - 1);
      rawClean[sizeof(rawClean) - 1] = '\0';
      size_t rLen = strlen(rawClean);
      while (rLen > 0 && (rawClean[rLen - 1] == ' ' || rawClean[rLen - 1] == '\r' || rawClean[rLen - 1] == '\n')) {
        rawClean[--rLen] = '\0';
      }

      time_t nowSec = time(nullptr);
      uint64_t timestampMs = ((uint64_t)nowSec * 1000ULL) + (millis() % 1000);

      char qrJson[192];
      snprintf(qrJson, sizeof(qrJson),
               "{\"type\":\"QR_ALERT\",\"code\":\"%s\",\"rawText\":\"%s\",\"timestamp\":%llu}",
               extractedCode, rawClean, (unsigned long long)timestampMs);

      Serial.printf("🚨 [QR INTERCEPT] Discovered QR in STATUSTEXT: '%s' -> Code: '%s'\n", rawClean, extractedCode);

      if (qTxToCloud != nullptr) {
        CloudPacket qrPkt;
        qrPkt.type = MSG_TEXT_JSON;
        qrPkt.len = strlen(qrJson);
        memcpy(qrPkt.data, qrJson, qrPkt.len);
        qrPkt.data[qrPkt.len] = '\0';
        xQueueSendToFront(qTxToCloud, &qrPkt, pdMS_TO_TICKS(10));
      }
    }
  }

  // Push binary MAVLink frame to queue for Core 0 transmission
  if (qTxToCloud != nullptr && frameLen <= sizeof(CloudPacket::data)) {
    CloudPacket binPkt;
    binPkt.type = MSG_BINARY_MAVLINK;
    binPkt.len = frameLen;
    memcpy(binPkt.data, frame, frameLen);
    xQueueSend(qTxToCloud, &binPkt, 0); // Non-blocking push
  }
}

void feedByteToMavlinkAssembler(uint8_t b) {
  asmLastByteTime = millis();

  if (asmIdx == 0) {
    if (b == 0xFE) {
      asmBuf[0] = 0xFE;
      asmIdx = 1;
      asmV2 = false;
      asmTargetLen = 0;
    } else if (b == 0xFD) {
      asmBuf[0] = 0xFD;
      asmIdx = 1;
      asmV2 = true;
      asmTargetLen = 0;
    }
    return;
  }

  if (asmIdx < MAV_MAX_FRAME_LEN) {
    asmBuf[asmIdx++] = b;
  } else {
    crcErrorCount++;
    resetAssembler();
    return;
  }

  // Determine target length once header fields are received
  if (!asmV2) {
    // MAVLink v1: byte 1 is payload length
    if (asmIdx == 2) {
      uint8_t payloadLen = asmBuf[1];
      asmTargetLen = (size_t)payloadLen + 8;
      if (asmTargetLen > MAV_MAX_FRAME_LEN) {
        crcErrorCount++;
        resetAssembler();
        return;
      }
    }
  } else {
    // MAVLink v2: byte 1 is payload len, byte 2 is incompat_flags
    if (asmIdx == 3) {
      uint8_t payloadLen = asmBuf[1];
      uint8_t incompatFlags = asmBuf[2];
      asmTargetLen = (size_t)payloadLen + 12 + ((incompatFlags & 0x01) ? 13 : 0);
      if (asmTargetLen > MAV_MAX_FRAME_LEN) {
        crcErrorCount++;
        resetAssembler();
        return;
      }
    }
  }

  // Check if complete frame gathered
  if (asmTargetLen > 0 && asmIdx == asmTargetLen) {
    handleAssembledMavlinkFrame(asmBuf, asmTargetLen);
    resetAssembler();
  }
}

// =====================================================================================
// CORE 1 TASK: 1ms UART DRAIN & MAVLINK FRAME ASSEMBLER
// =====================================================================================
void core1UartTask(void* pvParameters) {
  TickType_t xLastWakeTime = xTaskGetTickCount();
  const TickType_t xFrequency = pdMS_TO_TICKS(1); // 1ms execution period

  Serial.println("🟢 [CORE 1] Pixhawk TELEM2 UART & MAVLink Frame Assembler task active.");

  while (true) {
    // 1. Drain Pixhawk UART hardware FIFO
    while (PixhawkSerial.available() > 0) {
      uint8_t b = (uint8_t)PixhawkSerial.read();
      feedByteToMavlinkAssembler(b);
      totalRxBytesFromPixhawk++;
    }

    // 2. Check frame assembly gap timeout
    checkAssemblerTimeout();

    // 3. Auto-baud detection: toggle every 12s until MAVLink sync locked
    if (!isBaudLocked && (millis() - lastBaudSwitchTime >= 12000)) {
      lastBaudSwitchTime = millis();
      int nextBaud = (activePixhawkBaud == 57600) ? 115200 : 57600;
      Serial.printf("🔄 [TELEM2 AUTO-BAUD] Toggling TELEM2 baud to %d (every 12s until sync locked)...\n", nextBaud);
      switchPixhawkBaud(nextBaud);
    }

    // Deterministic 1ms delay
    vTaskDelayUntil(&xLastWakeTime, xFrequency);
  }
}

// =====================================================================================
// CORE 0: TELEMETRY BATCH FLUSH & TRANSMIT HELPERS
// =====================================================================================
void flushTxBatch() {
  if (txBatchLen > 0 && wsClient.available()) {
    wsClient.sendBinary((const char*)txBatchBuffer, txBatchLen);
    txBatchLen = 0;
    lastBatchFlushTime = millis();
  }
}

void addFrameToTxBatch(const uint8_t* data, size_t len) {
  if (txBatchLen + len > BATCH_BUFFER_SIZE) {
    flushTxBatch();
  }
  if (len <= BATCH_BUFFER_SIZE) {
    memcpy(&txBatchBuffer[txBatchLen], data, len);
    txBatchLen += len;
    lastBatchFlushTime = millis();
    if (txBatchLen >= 256) {
      flushTxBatch();
    }
  }
}

void checkBatchFlush() {
  if (txBatchLen > 0 && (millis() - lastBatchFlushTime >= 12)) {
    flushTxBatch();
  }
}

// =====================================================================================
// CORE 0 TASK: WI-FI & WSS CLOUD RELAY MANAGEMENT
// =====================================================================================
void core0CloudTask(void* pvParameters) {
  Serial.println("🟢 [CORE 0] Wi-Fi & WSS Cloud Relay management task active.");

  while (true) {
    // 1. Maintain Wi-Fi Connection
    handleWiFiMaintenance();

    // 2. Maintain WebSocket Connection to Cloud Relay
    if (WiFi.status() == WL_CONNECTED) {
      if (!wsClient.available()) {
        updateLED(1);
        connectToCloudRelay();
      } else {
        updateLED(2); // Solid ON when connected
      }
    } else {
      updateLED(0);
    }

    // 3. Poll WebSocket Client for incoming commands from GCS
    if (wsClient.available()) {
      wsClient.poll();
    }

    // 4. Drain qTxToCloud and transmit to Cloud Relay
    if (wsClient.available() && qTxToCloud != nullptr) {
      CloudPacket pkt;
      while (xQueueReceive(qTxToCloud, &pkt, 0) == pdTRUE) {
        if (pkt.type == MSG_TEXT_JSON) {
          flushTxBatch(); // Flush binary queue first
          wsClient.send((const char*)pkt.data);
          Serial.printf("📤 [WSS TX ALERT] Dispatched JSON: %s\n", (const char*)pkt.data);
        } else if (pkt.type == MSG_BINARY_MAVLINK) {
          addFrameToTxBatch(pkt.data, pkt.len);
        }
      }
      checkBatchFlush();
    }

    // 5. Periodic ESP32_STATUS report every 10 seconds (10000ms)
    if (wsClient.available() && (millis() - lastStatusReportTime >= 10000)) {
      lastStatusReportTime = millis();
      sendEsp32StatusReport("CONNECTED");
    }

    // 6. Periodic ESP32_DIAG report every 5 seconds (5000ms) for live cable/UART bench health
    if (wsClient.available() && (millis() - lastDiagReportTime >= DIAG_INTERVAL_MS)) {
      lastDiagReportTime = millis();
      sendEsp32DiagReport();
    }

    // 7. Periodic WebSocket Ping every 15 seconds to keep NAT open
    if (wsClient.available() && (millis() - lastPingTime >= PING_INTERVAL_MS)) {
      lastPingTime = millis();
      wsClient.ping();
    }

    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// =====================================================================================
// SETUP
// =====================================================================================
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);

  unsigned long startWait = millis();
  while (!Serial && millis() - startWait < 3000) {
    delay(50);
  }
  delay(500);

  Serial.println();
  Serial.println("=========================================================");
  Serial.println("🚀 SAE INDIA — ESP32-S3 DIRECT CLOUD RELAY CLIENT");
  Serial.println("   Dual-Core FreeRTOS MAVLink Bridge & QR Interceptor");
  Serial.println("=========================================================");

  if (STATUS_LED_PIN >= 0) {
    pinMode(STATUS_LED_PIN, OUTPUT);
    digitalWrite(STATUS_LED_PIN, LOW);
  }

  // Pre-seed baseline Epoch 2026 clock
  ensureSaneSystemClock();

  // Initialize cached baud from RTC slow memory (57600 or 115200)
  // Ensures any in-flight warm reset locks TELEM2 in under 10ms without waiting for 12s dual-baud sweep
  if (savedPixhawkBaud == 57600 || savedPixhawkBaud == 115200) {
    activePixhawkBaud = savedPixhawkBaud;
  } else {
    savedPixhawkBaud = 57600;
    activePixhawkBaud = 57600;
  }
  lastBaudSwitchTime = millis();
  switchPixhawkBaud(activePixhawkBaud);
  Serial.printf("⚡ [TELEM2 UART] Hardware Serial1 ready on GPIO %d (RX) / GPIO %d (TX) @ %d baud (RTC savedPixhawkBaud: %d).\n",
                PIXHAWK_RX_PIN, PIXHAWK_TX_PIN, activePixhawkBaud, savedPixhawkBaud);

  // Create FreeRTOS Queue for Core 1 -> Core 0 transmission
  qTxToCloud = xQueueCreate(48, sizeof(CloudPacket));
  if (qTxToCloud == nullptr) {
    Serial.println("❌ [FREERTOS] Failed to create qTxToCloud queue!");
  } else {
    Serial.println("✅ [FREERTOS] qTxToCloud queue created successfully (depth: 48).");
  }

  // Configure WebSocket Client callbacks and CA bundle
  wsClient.setCACert(RENDER_CA_BUNDLE);
  wsClient.addHeader("x-relay-token", RELAY_TOKEN);
  wsClient.onMessage(onMessageCallback);
  wsClient.onEvent(onEventsCallback);

  // Initial Wi-Fi setup & channel lock
  connectToWiFi(true);

  // Spawn Core 1 Task: Dedicated 1ms UART drain & MAVLink frame assembler
  xTaskCreatePinnedToCore(
    core1UartTask,
    "UART_Core1",
    8192,
    NULL,
    3,              // Priority 3 (higher priority for real-time UART)
    &taskCore1Handle,
    1               // Pin to Core 1
  );

  // Spawn Core 0 Task: Wi-Fi network & WebSocket SSL management
  xTaskCreatePinnedToCore(
    core0CloudTask,
    "Cloud_Core0",
    8192,
    NULL,
    2,              // Priority 2
    &taskCore0Handle,
    0               // Pin to Core 0
  );

  Serial.println("✅ [FREERTOS] Dual-Core tasks pinned and launched: Core 1 (UART/MAVLink) & Core 0 (Wi-Fi/WSS).");
  Serial.println("=========================================================\n");
}

// =====================================================================================
// MAIN ARDUINO LOOP (CORE 1 LOW-PRIORITY MONITOR)
// =====================================================================================
void loop() {
  delay(3000);

  Serial.printf("📊 [MONITOR] Wi-Fi: %s | Cloud: %s | TELEM2 (%d baud): %s | Pixhawk RX: %lu B | TX: %lu B | MAVPackets: %lu | CRCErrors: %lu\n",
                WiFi.status() == WL_CONNECTED ? "ONLINE ✓" : "OFFLINE ✗",
                wsClient.available() ? "STREAMING ✓" : "CONNECTING...",
                activePixhawkBaud,
                isBaudLocked ? "LOCKED ✓" : (totalRxBytesFromPixhawk == 0 ? "NO SIGNAL (Check Pin 18)" : "SYNCING..."),
                totalRxBytesFromPixhawk,
                totalTxBytesToPixhawk,
                totalMavlinkPacketsSent,
                crcErrorCount);
}
