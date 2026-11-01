#!/usr/bin/env python3
"""Owner tools for Quad accounts. Stop the server before changing accounts.

Google proves identity; the six-digit PIN unlocks the chat. These commands
help the owner connect an older account to a Google address or set a
temporary PIN that the person should change in Settings.
"""
import argparse
import hashlib
import json
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("QUAD_DATA_DIR", str(ROOT / "data")))
USERS = DATA / "users.json"
INVITE = DATA / "invite.txt"
PIN_ITERATIONS = 310_000


def load() -> dict:
    if not USERS.exists():
        raise SystemExit("No accounts yet. Start the server and let someone sign in first.")
    return json.loads(USERS.read_text(encoding="utf-8"))


def save(store: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    temp = USERS.with_suffix(".json.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        json.dump(store, file, ensure_ascii=False, indent=2)
    os.replace(temp, USERS)


def find(members: list[dict], username: str) -> dict:
    name = username.lower().lstrip("@")
    member = next((m for m in members if m.get("handle", "").lower() == name), None)
    if not member:
        raise SystemExit(f"No account with username @{name} was found.")
    return member


def pin_digest(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), PIN_ITERATIONS).hex()


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage Quad Google-linked accounts and invites.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="list accounts, Google link, and PIN status")
    group.add_argument("--show-invite", action="store_true", help="show the invite code privately")
    group.add_argument("--rotate-invite", action="store_true", help="replace the invite code (keeps accounts)")
    group.add_argument("--link-email", nargs=2, metavar=("USERNAME", "EMAIL"), help="attach a Google email to an existing account")
    group.add_argument("--set-pin", nargs=2, metavar=("USERNAME", "PIN"), help="set a temporary six-digit PIN")
    group.add_argument("--disable", metavar="USERNAME", help="disable an account")
    group.add_argument("--enable", metavar="USERNAME", help="enable an account")
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)

    if args.show_invite:
        code = os.environ.get("QUAD_INVITE_CODE", "").strip()
        if not code and INVITE.exists():
            code = INVITE.read_text(encoding="utf-8").strip()
        print(code or "Start the server once to generate its invite code.")
        return
    if args.rotate_invite:
        if os.environ.get("QUAD_INVITE_CODE"):
            raise SystemExit("The invite comes from QUAD_INVITE_CODE; change that environment variable instead.")
        fd = os.open(INVITE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(secrets.token_urlsafe(24) + "\n")
        print("Invite rotated. Accounts are unchanged. Use --show-invite to display it privately.")
        return

    store = load()
    members = store.get("members", [])
    if args.list:
        if not members:
            print("No accounts yet.")
        for member in members:
            status = "disabled" if member.get("disabled") else "active"
            linked = member.get("google_email") or "NOT LINKED to Google"
            pin = "pin set" if member.get("pin_hash") else "NO PIN"
            print(f"@{member.get('handle', '?'):<22} {member.get('name', ''):<26} {status:<9} {linked:<34} {pin}")
        return

    if args.link_email:
        member = find(members, args.link_email[0])
        member["google_email"] = args.link_email[1].strip().lower()
        save(store)
        print(f"Linked @{member['handle']} to {member['google_email']}. Restart the server to apply.")
        return

    if args.set_pin:
        member = find(members, args.set_pin[0])
        pin = args.set_pin[1]
        if not (pin.isdigit() and len(pin) == 6):
            raise SystemExit("The PIN must be exactly six digits.")
        salt = secrets.token_hex(16)
        member["pin_salt"] = salt
        member["pin_hash"] = pin_digest(pin, salt)
        save(store)
        print(f"Set a temporary PIN for @{member['handle']}. Tell them to change it in Settings. Restart the server to apply.")
        return

    member = find(members, args.disable or args.enable)
    member["disabled"] = bool(args.disable)
    save(store)
    print(f"@{member['handle']} {'disabled' if args.disable else 'enabled'}. Restart the server to apply.")


if __name__ == "__main__":
    main()
