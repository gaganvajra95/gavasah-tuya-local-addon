# Changelog

All notable changes to the **Gavasah Tuya LAN Gateway** add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
