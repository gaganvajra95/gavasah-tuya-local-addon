# Changelog

All notable changes to the **Gavasah Tuya LAN Gateway** add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
