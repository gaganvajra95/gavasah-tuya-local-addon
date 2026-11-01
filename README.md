# Gavasah Tuya LAN Gateway Add-on

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Gavasah%20Gateway%20%7C%20Home%20Assistant-green.svg)](https://dealer.gavasah.com)
[![Protocol](https://img.shields.io/badge/protocol-Tuya%20LAN%20%26%20DALI-orange.svg)](DOCS.md)

An enterprise-grade, zero-cloud Home Assistant Supervisor add-on designed for the **Gavasah Gateway** ecosystem. It provides low-latency local execution, bidirectional state synchronization, and MQTT auto-discovery for Tuya Wi-Fi endpoints and Sunricher DALI IP gateways.

---

## Key Features

* **100% Cloud-Free**: Operates strictly on local IP sockets (`TCP 6668` & `UDP 6666/6667`). Devices can be firewalled from the Internet completely.
* **Instant 2-Way Feedback**: Unsolicited TCP push events deliver wall switch toggles and sensor triggers to Home Assistant in under 20 milliseconds.
* **Sunricher DALI Master Support**: Specialized mapping for Sunricher DALI-1 and DALI-2 drivers, including DT6 single-channel and DT8 Tunable White lamps.
* **Home Assistant MQTT Discovery**: Auto-generates native `light.*`, `switch.*`, and `sensor.*` entities with zero manual YAML configuration.
* **Embedded Ingress UI**: Real-time packet monitor, device commissioning, and DP inspector directly in your Home Assistant sidebar.

---

## Architecture Flow

```text
+-------------------------+          +-------------------------+
|   Tuya / DALI Gateway   |          |  Gavasah Gateway (HA)   |
|     192.168.1.210       |          |      192.168.1.200      |
+-------------------------+          +-------------------------+
             |                                    |
   (TCP 6668 | Persistent Socket)                 |
             v                                    v
+--------------------------------------------------------------+
|             Gavasah Tuya LAN Add-on Container                |
|  - UDP 6666/6667 Discovery Engine                            |
|  - AES-128-ECB & AES-128-GCM Protocol Transceiver            |
|  - DALI DT6 / DT8 Normalization Core                         |
+--------------------------------------------------------------+
             |                                    |
             v                                    v
     Mosquitto MQTT Broker            Home Assistant Core UI
 (homeassistant/light/+/state)        (Instant Bidirectional Sync)
```

---

## License & Support
Maintained by the **GAVASAH Engineering Team** for the Gavasah Cloud Hub and Gavasah Gateway platform.
