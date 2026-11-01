# Gavasah Tuya LAN Gateway Add-on Documentation

## Overview
The **Gavasah Tuya LAN Gateway** add-on connects any Tuya-compatible device (Wi-Fi or Ethernet) directly to your **Gavasah Gateway** (Home Assistant) with **zero cloud dependencies** and **real-time bidirectional communication**.

---

## 1. Prerequisites
1. **MQTT Broker**: The official Mosquitto broker add-on must be installed and running on your Gavasah Gateway.
2. **Device Discovery**: Devices must reside on the same Layer-2 automation subnet/VLAN as the Gavasah Gateway to allow UDP broadcasts on ports `6666` and `6667`.
3. **Cryptographic Local Key**: Each Tuya device requires its 16-character `local_key`. For Sunricher DALI IP gateways (`SR-GW-EDA`), the key can be fetched directly or synced once.

---

## 2. Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `mqtt_host` | string | `core-mosquitto` | Hostname or IP of the Mosquitto MQTT broker |
| `mqtt_port` | integer | `1883` | MQTT port (default `1883`) |
| `mqtt_user` | string | `""` | MQTT username (leave blank if anonymous) |
| `mqtt_password` | string | `""` | MQTT password |
| `log_level` | string | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `auto_discover_udp`| boolean| `true` | Continuously listen for UDP 6666/6667 broadcasts |
| `devices` | list | `[]` | Static device definitions with keys and sub-devices |

---

## 3. Supported Data Points & DALI Luminaire Mapping

### DALI-2 DT8 (Tunable White)
* **DP 20**: Power state (`true`/`false`)
* **DP 21**: Light mode (`white`, `colour`, `scene`, `music`)
* **DP 22**: Brightness intensity (`10` to `1000`)
* **DP 23**: Color temperature Kelvin / Mireds (`0` to `1000`)

### DALI DT6 (Single Channel Intensity)
* **DP 20**: Power state (`true`/`false`)
* **DP 22**: Brightness intensity (`10` to `1000`)

---

## 4. Isolating Devices from the Internet (Perpetual LAN)
Once paired and configured in this add-on:
1. Log in to your Omada ER605 / OC200 router dashboard.
2. Navigate to **Network Security > ACL > Gateway ACL**.
3. Create a rule:
   * **Direction**: LAN to WAN
   * **Source**: IP of the Tuya/DALI device (e.g. `192.168.1.210`)
   * **Policy**: Block
4. All local controls, Home Assistant automations, and physical switch feedbacks will continue to function in real-time with zero packet loss.

