#!/usr/bin/env python3
"""Exercise Terminal Google OAuth, PINs, guaranteed General room, optimistic REST messages,
typing_start/stop, read receipts, covert duress alerts, DMs, files, and disk encryption.
"""
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print("PASS", label)


def receive_until(socket, kind):
    for _ in range(40):
        event = socket.receive_json()
        if event.get("t") == kind:
            return event
    raise AssertionError(f"Did not receive websocket event {kind}")


def main():
    with tempfile.TemporaryDirectory(prefix="terminal-test-") as directory:
        os.environ["TERMINAL_DATA_DIR"] = directory
        os.environ["QUAD_DATA_DIR"] = directory
        os.environ["TERMINAL_INVITE_CODE"] = "private-test-invite"
        os.environ["GOOGLE_CLIENT_ID"] = "test-client.apps.googleusercontent.com"
        os.environ["GOOGLE_CLIENT_SECRET"] = "test-secret-do-not-use"
        os.environ["TERMINAL_PUBLIC_URL"] = "http://localhost:8000"
        os.environ["QUAD_PUBLIC_URL"] = "http://localhost:8000"
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import app as server

        profiles = {
            "alice-token": {"sub": "g-alice", "email": "alice@example.com", "name": "Alice", "picture": ""},
            "blair-token": {"sub": "g-blair", "email": "blair@example.com", "name": "Blair", "picture": ""},
            "casey-token": {"sub": "g-casey", "email": "casey@example.com", "name": "Casey", "picture": ""},
            "drew-token": {"sub": "g-drew", "email": "drew@example.com", "name": "Drew", "picture": ""},
            "ellis-token": {"sub": "g-ellis", "email": "ellis@example.com", "name": "Ellis", "picture": ""},
            "dup-token": {"sub": "g-alice", "email": "alice@example.com", "name": "Alice Again", "picture": ""},
        }

        async def fake_exchange(code, verifier):
            check("PKCE verifier reaches the code exchange", code.startswith("code-") and len(verifier) > 40)
            return {"access_token": code.replace("code-", "") + "-token"}

        async def fake_profile(access_token):
            if access_token not in profiles:
                raise AssertionError("unknown fake token")
            return profiles[access_token]

        server.exchange_code = fake_exchange
        server.fetch_profile = fake_profile

        with TestClient(server.app) as client:
            health = client.get("/api/health")
            check("health reports terminal service without exposing members", health.status_code == 200 and health.json()["service"] == "terminal" and "members" not in health.json())
            check("protected API rejects anonymous requests", client.patch("/api/profile", json={"name": "X", "handle": "hello"}).status_code == 401)
            check("JSON key login endpoint is gone", client.post("/api/auth/login", data={"pin": "123456"}).status_code in (404, 405))

            denied = client.get("/api/oauth/google/start", params={"origin": "https://evil.example"})
            check("sign-in refuses unknown app origins", denied.status_code == 403)
            start = client.get("/api/oauth/google/start", params={"origin": "http://localhost:8000"}, follow_redirects=False)
            location = urlparse(start.headers["location"])
            query = parse_qs(location.query)
            check("sign-in redirects to Google using localhost:8000 redirect_uri", location.netloc == "accounts.google.com" and query["redirect_uri"][0] == "http://localhost:8000/api/oauth/google/callback")
            check("client secret never appears in redirect", server.GOOGLE_CLIENT_SECRET not in start.headers["location"])

            def signin(profile_code):
                state_val = query["state"][0]
                response = client.get("/api/oauth/google/callback", params={"code": f"code-{profile_code}", "state": state_val}, follow_redirects=False)
                check(f"{profile_code} callback returns a one-time ticket", response.status_code == 302 and "quad_oauth=" in response.headers["location"])
                return parse_qs(urlparse(response.headers["location"]).query)["quad_oauth"][0]

            alice_ticket = signin("alice")
            step = client.post("/api/auth/oauth/exchange", json={"ticket": alice_ticket}).json()
            check("unknown Google account prompts setup", step["needed"] == "setup")
            alice = client.post("/api/auth/oauth", json={"ticket": alice_ticket, "pin": "123456", "handle": "alice", "invite": "private-test-invite"})
            check("Google sign-in creates account and issues session", alice.status_code == 200 and alice.json()["token"])
            alice_session = alice.json()

            # Check /api/auth/session compatibility
            sess_res = client.get("/api/auth/session", headers={"Authorization": "Bearer " + alice_session["token"]})
            check("session endpoint returns authenticated user", sess_res.status_code == 200 and sess_res.json()["authenticated"] is True)

            accounts = [alice_session]
            for code, handle, pin in (("blair", "blair", "654321"), ("casey", "casey", "111111"), ("drew", "drew", "222222"), ("ellis", "ellis", "333333")):
                ticket = signin(code)
                result = client.post("/api/auth/oauth", json={"ticket": ticket, "pin": pin, "handle": handle, "invite": "private-test-invite"})
                check(f"{handle} registers through Google with a PIN", result.status_code == 200)
                accounts.append(result.json())

            a, b, c = accounts[:3]
            ha = {"Authorization": "Bearer " + a["token"]}
            hb = {"Authorization": "Bearer " + b["token"]}
            hc = {"Authorization": "Bearer " + c["token"]}
            dm = "dm:" + ":".join(sorted([a["member"]["id"], b["member"]["id"]]))

            # Rooms endpoint always contains General
            rooms_res = client.get("/api/rooms", headers=ha)
            check("General room is always guaranteed first", rooms_res.status_code == 200 and rooms_res.json()["rooms"][0]["id"] == "general")

            new_room_res = client.post("/api/rooms", headers=ha, json={"name": "Ops Team", "topic": "Incident coordination"})
            check("authenticated members can create custom channels", new_room_res.status_code == 201 and any(r["id"] == "ops-team" for r in new_room_res.json()["rooms"]))

            with client.websocket_connect("/ws") as wa, client.websocket_connect("/ws") as wb:
                wa.send_json({"t": "auth", "token": a["token"]})
                ready_a = receive_until(wa, "ready")
                wb.send_json({"t": "auth", "token": b["token"]})
                ready_b = receive_until(wb, "ready")
                check("WS ready always includes General room", ready_a["rooms"][0]["id"] == "general")
                check("presence reflects authenticated live sockets", ready_b["presence"].get(a["member"]["id"]) and ready_b["presence"].get(b["member"]["id"]))

                # Optimistic REST message post + clientId echo
                post_res = client.post("/api/messages", headers=ha, json={"room": "general", "text": "optimistic general message", "clientId": "cid-general-1"})
                check("REST message insert returns real ID and clientId", post_res.status_code == 201 and post_res.json()["message"]["clientId"] == "cid-general-1")
                ws_msg = receive_until(wb, "message")["message"]
                check("REST message broadcasts in real time over WebSocket", ws_msg["text"] == "optimistic general message" and ws_msg["room"] == "general")

                # Typing start & stop events
                wa.send_json({"t": "typing_start", "room": "general"})
                t_start = receive_until(wb, "typing_start")
                check("typing_start broadcasts to room peers", t_start["member"] == a["member"]["id"] and t_start["on"] is True)
                wa.send_json({"t": "typing_stop", "room": "general"})
                t_stop = receive_until(wb, "typing_stop")
                check("typing_stop broadcasts to room peers", t_stop["member"] == a["member"]["id"] and t_stop["on"] is False)

                # Read receipts
                read_res = client.post("/api/messages/read", headers=hb, json={"room": "general"})
                check("marking room read updates unseen message IDs", ws_msg["id"] in read_res.json()["updated"])
                read_evt = receive_until(wa, "messages_read")
                check("sender receives realtime messages_read receipt", read_evt["reader"] == b["member"]["id"] and ws_msg["id"] in read_evt["messageIds"])

                # Direct message isolation & encrypted file upload
                client.post("/api/messages", headers=ha, json={"room": dm, "text": "secret dm payload", "clientId": "cid-dm-1"})
                dm_msg = receive_until(wb, "message")["message"]
                check("direct message reaches intended peer", dm_msg["room"] == dm)

                upload = client.post("/api/files", data={"room": dm}, headers=ha, files={"file": ("photo.webp", b"WEBP_COMPRESSED_BYTES", "image/webp")})
                check("compressed WebP upload becomes a chat message", upload.status_code == 201)
                file_id = upload.json()["message"]["file"]["id"]
                check("DM recipient can download file", client.get(f"/api/files/{file_id}", headers=hb).content == b"WEBP_COMPRESSED_BYTES")
                check("unrelated member cannot download DM file", client.get(f"/api/files/{file_id}", headers=hc).status_code == 404)

            # Covert Duress Emergency Alert endpoint
            duress_res = client.post(
                "/api/emergency-alert",
                headers=ha,
                json={
                    "timestamp": "2026-11-01T18:00:00Z",
                    "location": {"latitude": 37.7749, "longitude": -122.4194, "accuracy": 20},
                    "device": "Terminal-TestAgent",
                },
            )
            check("covert emergency-alert endpoint returns unremarkable 200 OK", duress_res.status_code == 200 and duress_res.json() == {"ok": True})
            alert_disk = (Path(directory) / "emergency_alerts.enc.json").read_bytes()
            check("emergency alerts are encrypted at rest on disk", b"37.7749" not in alert_disk and b"Terminal-TestAgent" not in alert_disk)

            disk = (Path(directory) / "messages.v2.json").read_bytes()
            check("chat contents are encrypted on disk", b"optimistic general message" not in disk and b"secret dm payload" not in disk)
        print("All Terminal server checks passed.")


if __name__ == "__main__":
    main()
