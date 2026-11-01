# Changelog

All notable changes to the **Gavasah Tuya LAN Gateway** add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.0] - 2026-11-02
### Added
- **Tuya Cloud Auto-Sync & Key Extractor Engine (`tuya-cloud-sync.js` & `tuya-sync-worker.py`)**: Automatic retrieval of secret 16-character AES `local_key`s, Zigbee remotes/sub-devices, and standalone Wi-Fi devices.
- **Smart Life / Tuya Smart App QR-Code Login**: Integrators can log in using only their mobile app user code (`Me -> Settings -> Account and Security -> User Code`) and scan the on-screen QR code with their phone. Bypasses the need for any Tuya IoT Cloud Developer accounts or manual API configuration.
- **Tuya IoT Developer API Sync**: Alternative sync method using official Access ID & Secret for enterprise/dealer cloud projects.
- **Automatic Gateway Re-keying & Remote Auto-Provisioning**: Seamlessly binds retrieved `local_key`s to live gateway instances (e.g., `Tuya Zigbee Gateway 192.168.1.194`), auto-imports paired Zigbee remotes, buttons, and switches into Home Assistant MQTT, and re-establishes encrypted TCP sessions without restart.

## [1.2.1] - 2026-11-02
### Fixed
- **Hardware Architecture & Classification Engine (`device-detector.js`)**: Eliminated false DALI gateway misclassification and fallback MAC address duplication (`00:0c:43:e1:76:29`). Dynamically differentiates between Sunricher DALI Center (`dali_gateway`), Tuya Zigbee 3.0 Gateway (`zigbee_gateway`), and standalone Wi-Fi devices using Tuya ProductKey local catalogs, dynamic Linux `/proc/net/arp` table resolution, port probing (Telnet 23 vs TCP 6668), and online GitHub device definition fallback.
- **Clean Zigbee Gateway Initialization**: Zigbee and generic gateways now initialize with an empty subdevice set (`subDevices: {}`) and dynamically discover real Zigbee endpoints (remotes, buttons, switches) as they communicate, rather than inheriting fake DALI lamps.
- **Ingress Gateway Edit & Type Management**: Added inline gateway editing modal in Ingress UI (`promptEditGateway`) to update gateway friendly names, hardware types, and MAC addresses with instant `/api/gateway/update` persistence.
- **Discovery Radar Hardware Badging**: Auto-discovery radar now highlights device hardware model names (e.g., `Tuya Zigbee Gateway`, `Sunricher DALI Center`) and resolved MAC addresses.

## [1.2.0] - 2026-11-02
### Added
- **Universal Single-Name Architecture**: Unified Home Assistant MQTT device and entity naming (`has_entity_name: true`, `name: null`) so that both the device header and control cards display the exact same single friendly name across the UI without duplicates or discrepancies.
- **Dedicated Standalone Wi-Fi Devices Tab**: Complete management tab for standalone Tuya Wi-Fi devices (plugs, wall switches 1-4 gang, lights, curtains) with real-time 2-way control, power toggles, CCT/brightness/RGB sliders, and custom DP inspector.
- **Commission Wi-Fi Devices Tab**: Dedicated onboarding tab with direct IP commissioning (IP, Name, ID, Local Key, Type, Protocol Version) and automated network discovery.
- **Filtered Network Auto-Discovery Radar**: Radar scanners in both "Add Gateway" and "Add WiFi Devices" tabs filter out already-adopted devices and display `"No New Gateways Found"` and `"No New WiFi Devices Found"` when all endpoints on the subnet are adopted.
- **Immediate Bidirectional DP Querying**: Issues `DP_QUERY` (0x0a) immediately upon socket connection so the add-on instantly captures live hardware states (power, brightness, color) without waiting for user action.
- **Universal Tuya Protocol Compatibility**: Extended frame decoder with safe JSON sanitization, null byte trimming, and robust error handling across Tuya v3.1, v3.3, and v3.4/v3.5 protocols.

## [1.1.1] - 2026-11-02
### Added
- **Intelligent MAC Address Recovery on Gateway Disconnect**: When any gateway drops offline, the add-on automatically checks the Linux ARP table and scans the local subnet to match the hardware MAC address (`00:0c:43:e1:76:29`), locating the gateway's new dynamic DHCP IP and re-establishing communication automatically.
- **5-Minute Anti-Overload Cooldown**: Enforces a strict 5-minute cooldown timer between automated network ARP sweeps per gateway to protect the host network and gateway CPU from broadcast storms.
- **Manual MAC Refresh in GUI**: Added **"🔄 Refresh IP (MAC)"** action in the Gateways tab to allow instant on-demand MAC resolution, bypassing the 5-minute cooldown.
- **Live Cooldown Status Badge**: Added real-time countdown display in the Gateways inventory table indicating remaining cooldown time.

---

## [1.1.0] - 2026-11-02
### Added
- **Multi-Gateway Architecture (`GatewayManager`)**: Full concurrent multi-gateway support for multiple Sunricher DALI Centers, Tuya Zigbee Coordinators, and Tuya Wi-Fi bridges.
- **Dynamic DHCP Re-binding**: Zero-downtime automatic IP re-binding. When a gateway's IP changes via DHCP, the UDP discovery engine instantly updates the socket destination and reconnects the persistent TCP session within seconds.
- **4-Tab Zigbee2MQTT Dashboard**:
  1. **Devices**: Device cards grouped by Gateway with originating gateway badges (`via <Gateway Name>`), power toggles, brightness, CCT, and RGB controls.
  2. **Gateways**: Complete gateway inventory with real-time status indicators, dynamic IP, MAC address (`/sys/class/net/eth0/address`), and sub-device count.
  3. **All Devices**: Unified searchable topology grid with DP inspector and real-time packet monitor.
  4. **Add Gateway**: Automated subnet radar scan and 1-Click Telnet/SSH Auto-Key & sub-device recovery without needing cloud accounts.
- **Tuya Zigbee Remote & Scene Button Raw Action Interception**: Real-time unsolicited frame capture (`0x08`) for scene switches, rotary knobs, SOS buttons, and remotes. Emits instant action events (`single`, `double`, `hold`, `rotate`) to Home Assistant MQTT (`gavasah/tuya/<gwId>/<subId>/action`) and displays animated action badges in the Ingress UI.
- **Comprehensive DALI Driver Profiles**: Extended normalization helper supporting DT6 Single-Channel Dimmer, DT8 Tunable White (CCT), DT8 RGB (3-Channel), DT8 RGBW (4-Channel), and DT8 RGBCW / RGB+CCT (5-Channel) with HSV (`hhhhssssvvvv`) conversions.
- **Bi-Directional Friendly Name Sync**: Editable names for gateways and devices with instant Home Assistant MQTT entity republishing.

---

## [1.0.2] - 2026-11-02
### Fixed
- **Home Assistant Ingress Compatibility**: Fixed relative URL resolution for all REST API endpoints (`${basePath}api/control`, `${basePath}api/devices`) and dynamic WebSocket routing (`${basePath}ws`) so that the Z2M-style GUI operates seamlessly inside HA Ingress panels.
- **WebSocket Upgrade Engine**: Switched WebSocket server in `server.js` to dynamic HTTP upgrade listener (`noServer: true`) to support Ingress reverse-proxy path rewrites.
- **2-Way Push Propagation**: Ensured hardware status packets (Cmd `0x08`) from the Sunricher DALI Gateway always trigger full state synchronization to Home Assistant MQTT and Web Ingress, regardless of prior cached values.
- **DALI Multi-DP & Clean Entity Grouping**: Unified Home Assistant MQTT entity discovery to link all 3 DALI channels under the parent **Sunricher DALI Center** device, avoiding redundant entity name duplication.
- **Explicit TX Command Logging**: Added full telemetry logging for commands dispatched to the gateway over TCP 6668.

---

## [1.0.1] - 2026-11-02
### Added
- Zigbee2MQTT-style web frontend on Home Assistant Ingress with interactive toggle switches, brightness sliders, and color temperature controls.
- Dynamic per-subdevice DP state cache (`dali_0`, `dali_1`, `dali_2`) for multi-channel DALI fixtures.
- Sub-20ms instant optimistic state updates on UI toggle and slider movement.
- Verified Tuya AES `local_key` and gateway `devId` hardware profile for Sunricher DALI Center (`192.168.1.210`).

### Fixed
- Fixed DALI sub-device DP mappings: converted to hardware DP 1 (Power), DP 2 (Brightness 10-1000), and DP 3 (Color Temp 0-1000).
- Fixed Tuya 3.3 Heartbeat packet encoding to omit empty payload strings and send zero-length payloads.
- Fixed `ReferenceError: Cannot access 'wss' before initialization` in server startup.
- Fixed MQTT state retain and instant availability publishing for Home Assistant light entities.

---

## [1.0.0] - 2026-11-02
### Added
- Initial production release for Gavasah Gateway ecosystem.
- Persistent TCP socket client engine for Tuya LAN protocol versions 3.1, 3.3, 3.4, and 3.5.
- Bidirectional real-time Home Assistant MQTT auto-discovery for lights, switches, dimmers, and sensors.
- Specialized driver support for DALI IP Gateways (`SR-GW-EDA`), DALI DT6 single-channel dimmers, and DALI-2 DT8 Tunable White (CCT) luminaires.
- Sub-20ms unsolicited state push updates triggered by physical switches and external sensors.
- Embedded Ingress Web UI dashboard for live packet inspection, DP control, and device configuration.
- Host network binding (`host_network: true`) for high-throughput UDP 6666/6667 auto-discovery.
