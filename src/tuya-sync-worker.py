#!/usr/bin/env python3
"""
GAVASAH Tuya LAN Gateway - Cloud Sync Worker
Retrieves device inventories, local_keys, and Zigbee sub-devices using:
1. Smart Life / Tuya Smart app QR-Code login (Tuya Device Sharing SDK - no developer account needed)
2. Tuya Developer IoT Platform API (tinytuya)
"""

import sys
import json
import os
import base64
import io
import time

CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEMA = "haauthorize"
DATA_DIR = os.environ.get("DATA_DIR", "/data")
SESSION_FILE = os.path.join(DATA_DIR, "tuya_session.json")

def mint_qr(user_code, scheme="smartlife"):
    import qrcode
    import qrcode.image.svg
    from tuya_sharing import LoginControl

    ctrl = LoginControl()
    resp = ctrl.qr_code(CLIENT_ID, SCHEMA, user_code)
    if not resp.get("success"):
        return {
            "success": False,
            "error": f"Failed to mint QR [{resp.get('code')}]: {resp.get('msg')}"
        }

    token = resp["result"]["qrcode"]
    qr_payload = f"{scheme}--qrLogin?token={token}"

    # Generate QR Code image - use pure SVG to avoid PIL/Pillow dependency
    qr = qrcode.QRCode(border=2)
    qr.add_data(qr_payload)
    qr.make(fit=True)

    try:
        img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
        buf = io.BytesIO()
        img.save(buf)
        svg_content = buf.getvalue().decode("utf-8")
        b64 = base64.b64encode(svg_content.encode("utf-8")).decode("ascii")
        qr_data_url = f"data:image/svg+xml;base64,{b64}"
    except Exception:
        # Fallback to PNG if Pillow is available
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        qr_data_url = f"data:image/png;base64,{b64}"

    return {
        "success": True,
        "token": token,
        "scheme": scheme,
        "qr_payload": qr_payload,
        "qr_data_url": qr_data_url
    }

def poll_qr(token, user_code):
    from tuya_sharing import LoginControl

    try:
        ok, result = LoginControl().login_result(token, CLIENT_ID, user_code)
    except Exception as e:
        return {"success": False, "status": "error", "error": str(e)}

    if not ok:
        return {"success": False, "status": "waiting"}

    # Login succeeded! Save session
    session = {
        "client_id": CLIENT_ID,
        "user_code": user_code,
        "terminal_id": result.get("terminal_id"),
        "endpoint": result.get("endpoint") or result.get("end_point"),
        "token_info": {
            "t": result.get("t"),
            "uid": result.get("uid"),
            "expire_time": result.get("expire_time"),
            "access_token": result.get("access_token"),
            "refresh_token": result.get("refresh_token")
        }
    }

    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(SESSION_FILE, "w", encoding="utf-8") as f:
            json.dump(session, f, indent=2)
    except Exception:
        pass

    # Now fetch devices using the established session
    return fetch_devices_from_session(session)

class _DummySaver:
    def __init__(self, session):
        self.session = session
    def update_token(self, token_info):
        self.session["token_info"] = token_info

def fetch_devices_from_session(session):
    from tuya_sharing import Manager

    saver = _DummySaver(session)
    manager = Manager(
        session.get("client_id", CLIENT_ID),
        session["user_code"],
        session["terminal_id"],
        session["endpoint"],
        session["token_info"],
        saver
    )

    manager.device_map.clear()
    homes = manager.home_repository.query_homes()
    all_raw = []

    for home in homes:
        devs = manager.device_repository.query_devices_by_home(home.id)
        for d in devs:
            all_raw.append(d)

    # Process into clean structured inventory using unified matcher
    return _process_raw_devices(all_raw)

def _process_raw_devices(raw_devices):
    gateways = []
    wifi_devices = []
    subs = []

    for d in raw_devices:
        dev_id = getattr(d, "id", None) if not isinstance(d, dict) else d.get("id")
        name = getattr(d, "name", dev_id) if not isinstance(d, dict) else d.get("name", dev_id)
        local_key = getattr(d, "local_key", "") if not isinstance(d, dict) else d.get("local_key", "")
        ip = getattr(d, "ip", "") if not isinstance(d, dict) else d.get("ip", "")
        cat = (getattr(d, "category", "") if not isinstance(d, dict) else d.get("category", "") or "").lower()
        product_name = (getattr(d, "product_name", "") if not isinstance(d, dict) else d.get("product_name", "") or "").lower()
        is_sub = getattr(d, "sub", False) if not isinstance(d, dict) else d.get("sub", False)
        node_id = getattr(d, "node_id", None) if not isinstance(d, dict) else d.get("node_id")
        parent_id = getattr(d, "parent_id", None) if not isinstance(d, dict) else d.get("parent_id")
        status = getattr(d, "status", {}) if not isinstance(d, dict) else d.get("status", {})

        entry = {
            "id": dev_id,
            "name": name,
            "local_key": local_key,
            "ip": ip,
            "category": cat,
            "product_name": product_name,
            "is_sub": is_sub,
            "node_id": node_id,
            "parent_id": parent_id,
            "status": status or {}
        }

        if is_sub:
            subs.append(entry)
        elif cat in ("wg2", "wg", "zgw", "wf_zg", "znwg", "mesh", "gateway") or "gateway" in name.lower() or "gateway" in product_name or "coordinator" in name.lower():
            if "dali" in name.lower() or "dali" in product_name:
                entry["type"] = "dali_gateway"
            else:
                entry["type"] = "zigbee_gateway"
            gateways.append(entry)
        else:
            entry["type"] = "wifi_device"
            wifi_devices.append(entry)

    # Match sub-devices to their gateway
    for gw in gateways:
        gw["subDevices"] = {}
        gw_key = gw.get("local_key")
        gw_id = gw.get("id")

        matched = [s for s in subs if (gw_key and s.get("local_key") == gw_key) or (gw_id and s.get("parent_id") == gw_id)]
        for idx, sub in enumerate(matched):
            sub_cat = sub.get("category", "")
            sub_name = sub.get("name", "")
            if sub_cat in ("wxkg", "ykq") or "remote" in sub_name.lower() or "scene" in sub_name.lower():
                sub_type = "remote_button"
            elif sub_cat in ("dj", "tgq", "tgkg") or "light" in sub_name.lower() or "cct" in sub_name.lower():
                sub_type = "light_cct"
            elif "dimmer" in sub_name.lower() or "dim" in sub_name.lower():
                sub_type = "dimmer"
            elif sub_cat in ("kg", "tdq", "cjkg"):
                sub_type = "switch"
            elif sub_cat in ("hps", "sensor"):
                sub_type = "sensor"
            else:
                sub_type = "remote_button" if "switch" in sub_name.lower() and "scene" in sub_name.lower() else "switch"

            sub_key = f"sub_{idx}"
            gw["subDevices"][sub_key] = {
                "id": sub["id"],
                "devId": sub["node_id"] or sub["id"],
                "nodeId": sub["node_id"],
                "name": sub["name"],
                "type": sub_type,
                "category": sub["category"],
                "dps": sub.get("status") or {}
            }

    return {
        "success": True,
        "status": "authorized",
        "gateways": gateways,
        "wifiDevices": wifi_devices,
        "totalCount": len(gateways) + len(wifi_devices)
    }

def sync_developer(api_key, api_secret, region="us", sample_id=None):
    import tinytuya

    try:
        cloud = tinytuya.Cloud(
            apiRegion=region,
            apiKey=api_key,
            apiSecret=api_secret,
            apiDeviceID=sample_id
        )
        dev_list = cloud.getdevices()
        if not dev_list:
            return {"success": False, "error": "No devices returned from Tuya Cloud. Verify credentials and permissions."}

        gateways = []
        wifi_devices = []

        for d in dev_list:
            dev_id = d.get("id")
            name = d.get("name", dev_id)
            local_key = d.get("key", "")
            ip = d.get("ip", "")
            category = d.get("category", "")
            is_sub = d.get("sub", False)

            entry = {
                "id": dev_id,
                "name": name,
                "local_key": local_key,
                "ip": ip,
                "category": category,
                "is_sub": is_sub,
                "subDevices": {}
            }

            if category in ("wg2", "wg", "mesh") or "gateway" in name.lower():
                entry["type"] = "zigbee_gateway"
                # Query subdevices
                try:
                    subs = cloud.getsubdevices(dev_id)
                    if isinstance(subs, list):
                        for idx, s in enumerate(subs):
                            sub_key = f"sub_{idx}"
                            s_cat = s.get("category", "")
                            sub_type = "remote" if s_cat in ("wxkg", "kg") or "remote" in s.get("name", "").lower() else "switch"
                            entry["subDevices"][sub_key] = {
                                "devId": s.get("id"),
                                "name": s.get("name", f"SubDevice {idx}"),
                                "type": sub_type,
                                "category": s_cat,
                                "dps": {}
                            }
                except Exception:
                    pass
                gateways.append(entry)
            else:
                entry["type"] = "switch"
                wifi_devices.append(entry)

        return {
            "success": True,
            "gateways": gateways,
            "wifiDevices": wifi_devices,
            "totalCount": len(gateways) + len(wifi_devices)
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def sync_session():
    """Sync and classify devices directly from existing active session"""
    dump_res = dump_session()
    if not dump_res.get("success"):
        return dump_res
    return _process_raw_devices(dump_res.get("devices", []))

def dump_session():
    if not os.path.isfile(SESSION_FILE):
        return {"success": False, "error": f"Session file not found at {SESSION_FILE}"}
    try:
        with open(SESSION_FILE, "r", encoding="utf-8") as f:
            session = json.load(f)
    except Exception as e:
        return {"success": False, "error": f"Failed to load session: {e}"}

    from tuya_sharing import Manager
    saver = _DummySaver(session)
    manager = Manager(
        session.get("client_id", CLIENT_ID),
        session["user_code"],
        session["terminal_id"],
        session["endpoint"],
        session["token_info"],
        saver
    )
    homes = manager.home_repository.query_homes()
    raw_devices = []
    for home in homes:
        devs = manager.device_repository.query_devices_by_home(home.id)
        for d in devs:
            raw_devices.append({
                "home_id": home.id,
                "home_name": home.name,
                "id": getattr(d, "id", None),
                "name": getattr(d, "name", None),
                "category": getattr(d, "category", None),
                "product_id": getattr(d, "product_id", None),
                "product_name": getattr(d, "product_name", None),
                "local_key": getattr(d, "local_key", None),
                "sub": getattr(d, "sub", None),
                "node_id": getattr(d, "node_id", None),
                "parent_id": getattr(d, "parent_id", None) or getattr(d, "mesh_id", None),
                "ip": getattr(d, "ip", None),
                "online": getattr(d, "online", None),
                "status": getattr(d, "status", None)
            })
    return {
        "success": True,
        "homes": [{"id": h.id, "name": h.name} for h in homes],
        "device_count": len(raw_devices),
        "devices": raw_devices
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing command argument"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "mint_qr":
        user_code = sys.argv[2] if len(sys.argv) > 2 else ""
        scheme = sys.argv[3] if len(sys.argv) > 3 else "smartlife"
        res = mint_qr(user_code, scheme)
        print(json.dumps(res))

    elif cmd == "poll_qr":
        token = sys.argv[2] if len(sys.argv) > 2 else ""
        user_code = sys.argv[3] if len(sys.argv) > 3 else ""
        res = poll_qr(token, user_code)
        print(json.dumps(res))

    elif cmd == "sync_session":
        res = sync_session()
        print(json.dumps(res))

    elif cmd == "dump_session":
        res = dump_session()
        print(json.dumps(res))

    elif cmd == "sync_developer":
        api_key = sys.argv[2] if len(sys.argv) > 2 else ""
        api_secret = sys.argv[3] if len(sys.argv) > 3 else ""
        region = sys.argv[4] if len(sys.argv) > 4 else "us"
        sample_id = sys.argv[5] if len(sys.argv) > 5 else None
        res = sync_developer(api_key, api_secret, region, sample_id)
        print(json.dumps(res))

    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))

