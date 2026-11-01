# Changelog

All notable changes to the **Gavasah Tuya LAN Gateway** add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]
### Added
- Automated companion scanner for Sunricher Linux DALI IP gateways over local subnet.
- Cloudflare Dynamic DNS integration profile for remote tunnel telemetry.

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
