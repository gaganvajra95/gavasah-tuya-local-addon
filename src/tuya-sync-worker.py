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

    # Generate QR Code image as base64 PNG data URL
    qr = qrcode.QRCode(border=2)
    qr.add_data(qr_payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return {
        "success": True,
        "token": token,
        "scheme": scheme,
        "qr_payload": qr_payload,
        "qr_data_url": f"data:image/png;base64,{b64}"
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

    # Process into clean structured inventory
    gateways = []
    wifi_devices = []
    sub_devices_by_parent = {}

    for d in all_raw:
        dev_id = getattr(d, "id", None)
        name = getattr(d, "name", dev_id)
        local_key = getattr(d, "local_key", "")
        ip = getattr(d, "ip", "")
        category = getattr(d, "category", "")
        is_sub = getattr(d, "sub", False)
        product_id = getattr(d, "product_id", "")
        parent_id = getattr(d, "parent_id", None) or getattr(d, "mesh_id", None) or getattr(d, "node_id", None)

        entry = {
            "id": dev_id,
            "name": name,
            "local_key": local_key,
            "ip": ip,
            "category": category,
            "product_id": product_id,
            "is_sub": is_sub,
            "parent_id": parent_id
        }

        if is_sub:
            pid = parent_id or "unknown_gw"
            if pid not in sub_devices_by_parent:
                sub_devices_by_parent[pid] = []
            sub_devices_by_parent[pid].append(entry)
        else:
            # Check if gateway (Zigbee coordinator, DALI gateway, multi-mode gateway)
            if category in ("wg2", "wg", "mesh", "gateway") or "gateway" in name.lower() or "coordinator" in name.lower():
                entry["type"] = "zigbee_gateway"
                gateways.append(entry)
            else:
                entry["type"] = "wifi_device"
                wifi_devices.append(entry)

    # Attach subdevices to gateways
    for gw in gateways:
        gw["subDevices"] = {}
        gw_id = gw["id"]
        # Find matching subdevices
        matching_subs = sub_devices_by_parent.get(gw_id, [])
        for idx, sub in enumerate(matching_subs):
            sub_key = f"sub_{idx}"
            sub_type = "remote" if sub["category"] in ("wxkg", "kg", "sensor") or "remote" in sub["name"].lower() else "switch"
            gw["subDevices"][sub_key] = {
                "devId": sub["id"],
                "name": sub["name"],
                "type": sub_type,
                "category": sub["category"],
                "dps": {}
            }

    # If subdevices exist whose parent wasn't categorized as gateway, make that parent a gateway
    for pid, subs in sub_devices_by_parent.items():
        if pid != "unknown_gw" and not any(g["id"] == pid for g in gateways):
            # Find parent in wifi_devices and promote to gateway
            for i, w in enumerate(wifi_devices):
                if w["id"] == pid:
                    w["type"] = "zigbee_gateway"
                    w["subDevices"] = {}
                    for idx, sub in enumerate(subs):
                        sub_key = f"sub_{idx}"
                        sub_type = "remote" if sub["category"] in ("wxkg", "kg", "sensor") or "remote" in sub["name"].lower() else "switch"
                        w["subDevices"][sub_key] = {
                            "devId": sub["id"],
                            "name": sub["name"],
                            "type": sub_type,
                            "category": sub["category"],
                            "dps": {}
                        }
                    gateways.append(w)
                    wifi_devices.pop(i)
                    break

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

    elif cmd == "sync_developer":
        api_key = sys.argv[2] if len(sys.argv) > 2 else ""
        api_secret = sys.argv[3] if len(sys.argv) > 3 else ""
        region = sys.argv[4] if len(sys.argv) > 4 else "us"
        sample_id = sys.argv[5] if len(sys.argv) > 5 else None
        res = sync_developer(api_key, api_secret, region, sample_id)
        print(json.dumps(res))

    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
