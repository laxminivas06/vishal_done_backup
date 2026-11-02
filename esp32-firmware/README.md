# ESP32-S3 Direct Cloud Relay Client (Standalone Drone Setup)

This firmware allows your drone's **ESP32-S3** to connect **directly to your cloud relay over WSS** using your **Phone Hotspot** or any Wi-Fi.

### Why use this?
- **Zero Laptop Required**: You don't need a computer in the field.
- **Zero Local Connector**: You never have to run `npm run connector:start` again.
- **Worldwide Access**: You can open your Netlify web ground station URL on your phone browser anywhere, and the drone connects automatically as soon as it's powered on!

---

## 1. Exact Hardware Wiring (ESP32-S3 ↔ Pixhawk TELEM2)

| Pixhawk TELEM2 Pin | Signal | ESP32-S3 Pin | Note |
| :--- | :--- | :--- | :--- |
| **Pin 1** | +5V | **NC** | Powered externally or via USB |
| **Pin 2** | **TX** | **GPIO 18 (RX)** | Receives MAVLink telemetry from Pixhawk |
| **Pin 3** | **RX** | **GPIO 17 (TX)** | Transmits commands from phone to Pixhawk |
| **Pin 4** | CTS | **NC** | Not connected |
| **Pin 5** | RTS | **NC** | Not connected |
| **Pin 6** | **GND** | **GND** | Common ground reference |

---

## 2. Pixhawk TELEM2 Parameters (Mission Planner)

Ensure your Pixhawk TELEM2 port is configured for MAVLink at 57600 baud:
- `SERIAL2_PROTOCOL` = `2` (MAVLink2)
- `SERIAL2_BAUD` = `57` (57600 baud)

---

## 3. Arduino IDE Setup (1-Time Setup)

1. Open **Arduino IDE**.
2. Select Board:
   * **Tools ➔ Board ➔ ESP32 Arduino ➔ ESP32S3 Dev Module**
   * **Tools ➔ USB CDC On Boot ➔ Enabled**
3. Install the WebSocket library:
   * Go to **Sketch ➔ Include Library ➔ Manage Libraries...**
   * Search for: **`ArduinoWebsockets`**
   * Install **`ArduinoWebsockets` by Gil Maimon** (Version 0.5.3 or higher).

---

## 4. Configure Wi-Fi & Upload

Open [`esp32_cloud_relay_client.ino`](file:///c:/Users/brish/OneDrive/Desktop/saeindia/esp32-firmware/esp32_cloud_relay_client.ino) and update lines 49–50 with your Phone Hotspot or Wi-Fi:

```cpp
const char* WIFI_SSID     = "YOUR_PHONE_HOTSPOT_NAME";
const char* WIFI_PASSWORD = "YOUR_HOTSPOT_PASSWORD";
```

### Pre-Configured Cloud Relay Settings:
- **Relay URL**: `wss://vishal-done-backup.onrender.com/connector?token=saeindia_sec_99348a7b1c0e`
- **UART Pins**: `RX = GPIO 18`, `TX = GPIO 17`
- **Baud Rate**: `57600`

Click **Upload** in Arduino IDE.
