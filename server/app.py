#!/usr/bin/env python3
"""Terminal: self-hosted private chat, WebRTC signaling, and covert duress alert server."""
from __future__ import annotations

import asyncio
import base64
import contextvars
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx
import uvicorn
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent


def load_env() -> None:
    """Load git-ignored .env.local / server/.env on the server only (never exposed to clients)."""
    for candidate in (PROJECT_ROOT / ".env.local", PROJECT_ROOT / ".env", ROOT / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            raw_val = value.strip()
            # Strip inline comments if unquoted
            if raw_val and raw_val[0] not in ('"', "'") and " #" in raw_val:
                raw_val = raw_val.split(" #", 1)[0].strip()
            os.environ.setdefault(key.strip(), raw_val.strip('"').strip("'"))


load_env()

DATA = Path(
    os.environ.get("TERMINAL_DATA_DIR")
    or os.environ.get("QUAD_DATA_DIR")
    or str(ROOT / "data")
).resolve()
DIST = PROJECT_ROOT / "dist"
USERS_FILE = DATA / "users.json"
ROOMS_FILE = DATA / "rooms.json"
MESSAGES_FILE = DATA / "messages.v2.json"
LEGACY_MESSAGES_FILE = DATA / "messages.json"
EMERGENCY_FILE = DATA / "emergency_alerts.enc.json"
STORAGE_KEY_FILE = DATA / "storage.key"
SIGNING_KEY_FILE = DATA / "signing.key"
INVITE_FILE = DATA / "invite.txt"
FILES_DIR = DATA / "files"

GENERAL_ROOM = "general"
LEGACY_GROUP = "all-four"
MAX_FILE = 15 * 1024 * 1024
SESSION_SECONDS = 12 * 60 * 60
PIN_ITERATIONS = 310_000
STARTED = time.time()
HANDLE_RE = re.compile(r"^[a-z0-9_]{3,24}$")
ROOM_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,26}$")
PIN_RE = re.compile(r"^[0-9]{6}$")
PALETTE = ["#10b981", "#06b6d4", "#3b82f6", "#8b5cf6", "#f59e0b", "#ec4899"]

# Google OAuth credentials stay strictly in Python server memory.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
TICKETS: dict[str, dict[str, Any]] = {}
TICKET_SECONDS = 300
STATE_SECONDS = 600
ACTIVE_REDIRECT_URI: contextvars.ContextVar[str] = contextvars.ContextVar("active_redirect_uri", default="")

DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
FILES_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
try:
    DATA.chmod(0o700)
    FILES_DIR.chmod(0o700)
except OSError:
    pass


def write_private(path: Path, contents: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(contents)
    os.replace(tmp, path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise RuntimeError(f"Cannot read {path}; restore it from a backup") from exc


def write_json(path: Path, data: Any) -> None:
    write_private(path, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))


if not STORAGE_KEY_FILE.exists():
    if MESSAGES_FILE.exists() or any(FILES_DIR.iterdir()):
        raise RuntimeError("storage.key is missing. Restore it from your backup before starting Terminal.")
    write_private(STORAGE_KEY_FILE, Fernet.generate_key())
CIPHER = Fernet(STORAGE_KEY_FILE.read_bytes().strip())

if not (os.environ.get("TERMINAL_INVITE_CODE") or os.environ.get("QUAD_INVITE_CODE")) and not INVITE_FILE.exists():
    write_private(INVITE_FILE, (secrets.token_urlsafe(24) + "\n").encode())


def invite_code() -> str:
    return (
        os.environ.get("TERMINAL_INVITE_CODE", "").strip()
        or os.environ.get("QUAD_INVITE_CODE", "").strip()
        or INVITE_FILE.read_text(encoding="utf-8").strip()
    )


def server_key() -> bytes:
    """Per-installation secret used to sign OAuth state. Never leaves disk."""
    if SIGNING_KEY_FILE.exists():
        return SIGNING_KEY_FILE.read_bytes().strip()
    env_secret = os.environ.get("NEXTAUTH_SECRET", "").strip()
    key = hashlib.sha256(env_secret.encode()).digest() if env_secret else secrets.token_bytes(32)
    write_private(SIGNING_KEY_FILE, key)
    return key


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign_state(origin: str, verifier: str, redirect_target: str = "") -> str:
    payload = json.dumps({
        "o": origin,
        "v": verifier,
        "r": redirect_target,
        "e": int(time.time()) + STATE_SECONDS,
    }).encode()
    body = b64url(payload)
    return f"{body}.{b64url(hmac.new(server_key(), body.encode(), hashlib.sha256).digest())}"


def verify_state(state: str) -> tuple[str, str, str]:
    try:
        body, signature = state.split(".", 1)
        expected = b64url(hmac.new(server_key(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError()
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if int(payload["e"]) < time.time():
            raise ValueError()
        return str(payload["o"]), str(payload["v"]), str(payload.get("r", ""))
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=400, detail="That sign-in link expired. Start again from Terminal.")


def configured_public_url(request: Request | None = None) -> str:
    explicit = (
        os.environ.get("QUAD_PUBLIC_URL", "").strip()
        or os.environ.get("TERMINAL_PUBLIC_URL", "").strip()
        or os.environ.get("NEXTAUTH_URL", "").strip()
    )
    if explicit:
        return explicit.rstrip("/")
    if request is not None:
        base = str(request.base_url).rstrip("/")
        if "127.0.0.1:8000" in base:
            return "http://localhost:8000"
        return base
    return "http://localhost:8000"


def redirect_uri(request: Request | None = None) -> str:
    explicit_uri = os.environ.get("GOOGLE_REDIRECT_URI", "").strip()
    if explicit_uri:
        return explicit_uri
    path = os.environ.get("GOOGLE_REDIRECT_PATH", "/api/oauth/google/callback").strip() or "/api/oauth/google/callback"
    if not path.startswith("/"):
        path = "/" + path
    return f"{configured_public_url(request)}{path}"


async def exchange_code(code: str, verifier: str) -> dict[str, Any]:
    """Server-side code exchange: the client secret never leaves this process."""
    target_redirect = ACTIVE_REDIRECT_URI.get() or redirect_uri(None)
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": target_redirect,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        })
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="Google rejected the sign-in. Verify your Authorized redirect URI matches http://localhost:8000/api/oauth/google/callback.")
        return response.json()


async def fetch_profile(access_token: str) -> dict[str, str]:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="Google did not return your account details.")
        data = response.json()
    email = str(data.get("email", "")).strip().lower()
    if not email or not data.get("email_verified", True):
        raise HTTPException(status_code=403, detail="Your Google account must have a verified email address.")
    return {
        "sub": str(data.get("sub", "")),
        "email": email,
        "name": str(data.get("name") or email.split("@")[0])[:60],
        "picture": str(data.get("picture", ""))[:500],
    }


def take_ticket(ticket: str) -> dict[str, Any]:
    record = TICKETS.get(ticket)
    now = time.time()
    for key in [key for key, value in TICKETS.items() if value["e"] < now]:
        TICKETS.pop(key, None)
    if not record or record["e"] < now:
        raise HTTPException(status_code=410, detail="That Google sign-in expired. Please sign in again.")
    return record


def check_invite(value: str) -> bool:
    expected = invite_code()
    return bool(expected) and hmac.compare_digest(value.strip(), expected)


def pin_hash(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), PIN_ITERATIONS).hex()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def normalize_room_id(room: str) -> str:
    return GENERAL_ROOM if room in (GENERAL_ROOM, LEGACY_GROUP) else room


def save_users() -> None:
    write_json(USERS_FILE, {"app": "terminal", "version": 3, "members": list(USERS.values())})


BUILTIN_GENERAL = {
    "id": GENERAL_ROOM,
    "name": "General",
    "topic": "Primary workspace channel — always active",
    "system": True,
}


def load_rooms() -> dict[str, dict[str, Any]]:
    raw = read_json(ROOMS_FILE, {"rooms": [BUILTIN_GENERAL]})
    entries = raw.get("rooms", []) if isinstance(raw, dict) else []
    rooms: dict[str, dict[str, Any]] = {GENERAL_ROOM: dict(BUILTIN_GENERAL)}
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            rid = normalize_room_id(entry["id"])
            if rid == GENERAL_ROOM:
                continue
            if ROOM_SLUG_RE.fullmatch(rid):
                rooms[rid] = {
                    "id": rid,
                    "name": str(entry.get("name") or rid.title())[:32],
                    "topic": str(entry.get("topic") or "")[:120],
                    "system": False,
                }
    return rooms


def save_rooms() -> None:
    write_json(ROOMS_FILE, {"rooms": rooms_list()})


def encrypt_payload(payload: dict[str, Any]) -> str:
    return CIPHER.encrypt(json.dumps(payload, ensure_ascii=False).encode()).decode()


def decrypt_message(record: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = json.loads(CIPHER.decrypt(record["payload"].encode()))
    except (InvalidToken, ValueError, KeyError) as exc:
        raise RuntimeError("Cannot decrypt chat history. Restore the matching storage.key.") from exc
    author = record["author"]
    read_by = payload.get("readBy")
    if not isinstance(read_by, list):
        read_by = [author]
    elif author not in read_by:
        read_by = [author, *read_by]
    payload["readBy"] = read_by
    return {
        "id": record["id"],
        "room": normalize_room_id(record["room"]),
        "author": author,
        "ts": record["ts"],
        **payload,
    }


def pack_message(message: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": message["id"],
        "room": normalize_room_id(message["room"]),
        "author": message["author"],
        "ts": message["ts"],
        "payload": encrypt_payload(
            {k: v for k, v in message.items() if k not in {"id", "room", "author", "ts", "clientId"}}
        ),
    }


raw_users = read_json(USERS_FILE, {"members": []})
USERS: dict[str, dict[str, Any]] = {u["id"]: u for u in raw_users.get("members", [])}
ROOMS: dict[str, dict[str, Any]] = load_rooms()

if not MESSAGES_FILE.exists() and LEGACY_MESSAGES_FILE.exists():
    old_messages = read_json(LEGACY_MESSAGES_FILE, [])
    write_json(
        MESSAGES_FILE,
        [pack_message(m) for m in old_messages if all(k in m for k in ("id", "room", "author", "ts"))],
    )
RECORDS: list[dict[str, Any]] = read_json(MESSAGES_FILE, [])
MESSAGES: list[dict[str, Any]] = [decrypt_message(r) for r in RECORDS]
SESSIONS: dict[str, dict[str, Any]] = {}
SOCKETS: dict[WebSocket, tuple[str, str]] = {}
ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
LOCK = asyncio.Lock()


def rooms_list() -> list[dict[str, Any]]:
    """Guaranteed non-empty: General is always first."""
    custom = sorted(
        (r for rid, r in ROOMS.items() if rid != GENERAL_ROOM),
        key=lambda item: item["name"].casefold(),
    )
    return [dict(BUILTIN_GENERAL), *custom]


def registered(member_id: str) -> bool:
    return member_id in USERS and bool(USERS[member_id].get("pin_hash")) and not USERS[member_id].get("disabled", False)


def public_member(member_id: str) -> dict[str, Any]:
    u = USERS[member_id]
    name = u.get("name", u.get("handle", "Member"))
    initials = "".join(part[0] for part in name.split()[:2]).upper() or "?"
    return {
        "id": member_id,
        "name": name,
        "handle": u["handle"],
        "hue": u.get("hue", PALETTE[0]),
        "initials": initials,
        "joinedAt": u.get("issued", ""),
    }


def roster() -> list[dict[str, Any]]:
    return sorted((public_member(uid) for uid in USERS if registered(uid)), key=lambda x: x["name"].casefold())


def presence() -> dict[str, bool]:
    online = {member_id for member_id, _ in SOCKETS.values()}
    return {member_id: member_id in online for member_id in USERS if registered(member_id)}


def session_for(token: str) -> tuple[str, str] | None:
    if not token:
        return None
    digest = hash_token(token)
    session = SESSIONS.get(digest)
    if not session:
        return None
    if session["expires"] <= time.time() or not registered(session["member"]):
        SESSIONS.pop(digest, None)
        return None
    return session["member"], digest


def require_session(request: Request) -> tuple[str, str]:
    auth = request.headers.get("authorization", "")
    session = session_for(auth[7:]) if auth.startswith("Bearer ") else None
    if not session:
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")
    return session


def check_limit(request: Request, scope: str, limit: int, seconds: int) -> tuple[deque[float], float]:
    ip = request.client.host if request.client else "unknown"
    bucket = ATTEMPTS[f"{scope}:{ip}"]
    now = time.time()
    while bucket and bucket[0] < now - seconds:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="Too many attempts. Please wait a few minutes and try again.")
    bucket.append(now)
    return bucket, now


def clean_name(value: str) -> str:
    name = " ".join(value.strip().split())
    if not 1 <= len(name) <= 40 or any(ord(c) < 32 for c in name):
        raise HTTPException(status_code=400, detail="Enter a display name between 1 and 40 characters.")
    return name


def clean_handle(value: str) -> str:
    handle = value.strip().lower().lstrip("@")
    if not HANDLE_RE.fullmatch(handle):
        raise HTTPException(status_code=400, detail="Usernames need 3-24 letters, numbers, or underscores.")
    return handle


def validate_pin(value: str) -> None:
    if not PIN_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail="Your PIN must be exactly six digits.")


def can_access(room: str, member_id: str) -> bool:
    if not registered(member_id):
        return False
    canonical = normalize_room_id(room)
    if canonical in ROOMS:
        return True
    parts = canonical.split(":")
    return (
        len(parts) == 3
        and parts[0] == "dm"
        and parts[1] < parts[2]
        and member_id in parts[1:]
        and registered(parts[1])
        and registered(parts[2])
    )


async def send(ws: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await ws.send_json(payload)
    except (RuntimeError, WebSocketDisconnect, OSError):
        pass


async def broadcast(
    payload: dict[str, Any],
    room: str | None = None,
    target: str | None = None,
    exclude: WebSocket | None = None,
) -> None:
    canonical = normalize_room_id(room) if room else None
    for ws, (uid, digest) in list(SOCKETS.items()):
        session = SESSIONS.get(digest)
        if not session or session["expires"] <= time.time():
            continue
        if ws is exclude or (target and uid != target) or (canonical and not can_access(canonical, uid)):
            continue
        await send(ws, payload)


async def broadcast_roster() -> None:
    await broadcast({"t": "roster", "members": roster(), "presence": presence()})


DEFAULT_ORIGINS = (
    "http://localhost:8000,http://127.0.0.1:8000,"
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost,https://localhost,capacitor://localhost"
)
raw_origins = (
    os.environ.get("TERMINAL_ALLOWED_ORIGINS")
    or os.environ.get("QUAD_ALLOWED_ORIGINS")
    or DEFAULT_ORIGINS
)
ALLOWED_ORIGINS = {origin.strip() for origin in (raw_origins + "," + DEFAULT_ORIGINS).split(",") if origin.strip()}

app = FastAPI(title="Terminal private chat", version="3.0", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    limit = (
        MAX_FILE + 100_000
        if request.url.path == "/api/files"
        else 64_000
        if request.url.path.startswith(("/api/auth/", "/api/messages", "/api/emergency-alert"))
        else None
    )
    content_length = request.headers.get("content-length")
    if limit and content_length:
        try:
            if int(content_length) > limit:
                return JSONResponse({"detail": "Request is too large."}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "Invalid content length."}, status_code=400)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/health")
async def health() -> dict[str, Any]:
    # Never expose member identities or secrets before authentication.
    return {
        "status": "ok",
        "service": "terminal",
        "compat": "quad",
        "version": "3",
        "oauth_configured": bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET),
        "uptime_seconds": int(time.time() - STARTED),
    }


def trusted_origin(origin: str, request: Request) -> bool:
    clean = origin.rstrip("/")
    req_base = str(request.base_url).rstrip("/")
    pub_base = configured_public_url(request)
    return clean in ALLOWED_ORIGINS or clean in {req_base, pub_base}


def find_account(profile: dict[str, str]) -> dict[str, Any] | None:
    for record in USERS.values():
        if record.get("google_sub") and record["google_sub"] == profile["sub"]:
            return record
    for record in USERS.values():
        if str(record.get("google_email", "")).lower() == profile["email"]:
            return record
    return None


def issue_session(member_id: str) -> dict[str, Any]:
    token = secrets.token_urlsafe(32)
    SESSIONS[hash_token(token)] = {"member": member_id, "expires": time.time() + SESSION_SECONDS}
    return {"token": token, "member": public_member(member_id), "expiresIn": SESSION_SECONDS}


@app.get("/api/oauth/google/start")
@app.get("/api/auth/signin/google")
async def oauth_start(request: Request, origin: str = "http://localhost:8000") -> RedirectResponse:
    """Redirect the browser to Google OAuth; client_secret never leaves this server."""
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local.",
        )
    if not trusted_origin(origin, request):
        raise HTTPException(status_code=403, detail="That app address is not allowed by this server.")
    verifier = secrets.token_urlsafe(64)
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    cb_uri = redirect_uri(request)
    query = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": cb_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": sign_state(origin, verifier, cb_uri),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
        "access_type": "online",
    })
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{query}", status_code=302)


@app.get("/api/oauth/google/callback")
@app.get("/api/auth/callback/google")
async def oauth_callback(request: Request, code: str = "", state: str = "") -> RedirectResponse:
    origin, verifier, cb_uri = verify_state(state)
    if not code:
        raise HTTPException(status_code=400, detail="Google did not complete the sign-in.")
    tok_ctx = ACTIVE_REDIRECT_URI.set(cb_uri or redirect_uri(request))
    try:
        token_payload = await exchange_code(code, verifier)
    finally:
        ACTIVE_REDIRECT_URI.reset(tok_ctx)
    access_token = str(token_payload.get("access_token", ""))
    if not access_token:
        raise HTTPException(status_code=502, detail="Google did not return a usable sign-in token.")
    profile = await fetch_profile(access_token)
    ticket = secrets.token_urlsafe(32)
    TICKETS[ticket] = {**profile, "e": time.time() + TICKET_SECONDS}
    separator = "&" if "?" in origin else "?"
    return RedirectResponse(f"{origin}{separator}quad_oauth={ticket}", status_code=302)


class OAuthExchange(BaseModel):
    ticket: str = Field(max_length=200)


@app.post("/api/auth/oauth/exchange")
async def oauth_exchange(payload: OAuthExchange, request: Request) -> dict[str, Any]:
    check_limit(request, "oauth", 30, 300)
    profile = take_ticket(payload.ticket)
    record = find_account(profile)
    if record is None:
        return {"needed": "setup", "email": profile["email"], "name": profile["name"]}
    if record.get("disabled", False):
        raise HTTPException(status_code=403, detail="This account is disabled. Contact the server owner.")
    if not record.get("pin_hash"):
        raise HTTPException(status_code=409, detail="This account has no PIN yet. Ask the server owner to set one.")
    return {
        "needed": "pin",
        "email": profile["email"],
        "name": record.get("name", profile["name"]),
        "handle": record.get("handle", ""),
    }


class OAuthFinish(BaseModel):
    ticket: str = Field(max_length=200)
    pin: str = Field(max_length=16)
    handle: str | None = Field(default=None, max_length=40)
    invite: str = Field(default="", max_length=200)


@app.post("/api/auth/oauth")
async def oauth_finish(payload: OAuthFinish, request: Request) -> dict[str, Any]:
    attempts, attempt_time = check_limit(request, "oauth-pin", 8, 300)
    validate_pin(payload.pin)
    profile = take_ticket(payload.ticket)
    record = find_account(profile)

    if record is None:
        if not check_invite(payload.invite):
            raise HTTPException(status_code=403, detail="That invite code is not valid. Ask the server owner for an invite.")
        handle = clean_handle(payload.handle or "")
        async with LOCK:
            if any(u.get("handle", "").lower() == handle for u in USERS.values()):
                raise HTTPException(status_code=409, detail="That username is already taken.")
            member_id = "u_" + secrets.token_hex(12)
            salt = secrets.token_hex(16)
            USERS[member_id] = {
                "id": member_id,
                "name": clean_name(profile["name"]),
                "handle": handle,
                "hue": PALETTE[secrets.randbelow(len(PALETTE))],
                "google_sub": profile["sub"],
                "google_email": profile["email"],
                "google_picture": profile.get("picture", ""),
                "pin_salt": salt,
                "pin_hash": pin_hash(payload.pin, salt),
                "issued": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            save_users()
        await broadcast_roster()
        TICKETS.pop(payload.ticket, None)
        try:
            attempts.remove(attempt_time)
        except ValueError:
            pass
        return issue_session(member_id)

    if record.get("disabled", False):
        raise HTTPException(status_code=403, detail="This account is disabled. Contact the server owner.")
    if not record.get("pin_hash") or not record.get("pin_salt"):
        raise HTTPException(status_code=409, detail="This account has no PIN yet. Ask the server owner to set one.")
    if not hmac.compare_digest(pin_hash(payload.pin, record["pin_salt"]), record["pin_hash"]):
        raise HTTPException(status_code=403, detail="That PIN is incorrect.")
    try:
        attempts.remove(attempt_time)
    except ValueError:
        pass
    if not record.get("google_sub"):
        record["google_sub"] = profile["sub"]
        record["google_email"] = profile["email"]
        record["google_picture"] = profile.get("picture", "")
        save_users()
        await broadcast_roster()
    TICKETS.pop(payload.ticket, None)
    return issue_session(record["id"])


@app.get("/api/auth/session")
async def auth_session(request: Request) -> dict[str, Any]:
    auth = request.headers.get("authorization", "")
    found = session_for(auth[7:]) if auth.startswith("Bearer ") else None
    if not found:
        return {"user": None, "authenticated": False}
    member_id, _ = found
    rec = USERS[member_id]
    return {
        "authenticated": True,
        "user": {
            **public_member(member_id),
            "email": rec.get("google_email", ""),
        },
    }


@app.post("/api/auth/logout")
@app.post("/api/auth/signout")
async def logout(request: Request) -> dict[str, bool]:
    _, digest = require_session(request)
    SESSIONS.pop(digest, None)
    for ws, (_, socket_digest) in list(SOCKETS.items()):
        if digest == socket_digest:
            try:
                await ws.close(code=4401)
            except RuntimeError:
                pass
    return {"ok": True}


class Profile(BaseModel):
    name: str = Field(max_length=80)
    handle: str = Field(max_length=40)


@app.patch("/api/profile")
async def update_profile(payload: Profile, request: Request) -> dict[str, Any]:
    member_id, _ = require_session(request)
    name, handle = clean_name(payload.name), clean_handle(payload.handle)
    async with LOCK:
        if any(uid != member_id and u.get("handle", "").lower() == handle for uid, u in USERS.items()):
            raise HTTPException(status_code=409, detail="That username is already taken.")
        USERS[member_id].update(name=name, handle=handle)
        save_users()
    await broadcast_roster()
    return {"member": public_member(member_id)}


class PinChange(BaseModel):
    current: str = Field(max_length=16)
    new: str = Field(max_length=16)


@app.post("/api/auth/pin")
async def change_pin(payload: PinChange, request: Request) -> dict[str, bool]:
    member_id, current_digest = require_session(request)
    check_limit(request, "pin-change", 8, 300)
    validate_pin(payload.current)
    validate_pin(payload.new)
    record = USERS[member_id]
    if not hmac.compare_digest(pin_hash(payload.current, record["pin_salt"]), record["pin_hash"]):
        raise HTTPException(status_code=403, detail="Your current PIN is incorrect.")
    async with LOCK:
        salt = secrets.token_hex(16)
        record["pin_salt"] = salt
        record["pin_hash"] = pin_hash(payload.new, salt)
        save_users()
    revoked = [digest for digest, session in SESSIONS.items() if session["member"] == member_id and digest != current_digest]
    for digest in revoked:
        SESSIONS.pop(digest, None)
    for ws, (_, digest) in list(SOCKETS.items()):
        if digest in revoked:
            try:
                await ws.close(code=4401)
            except RuntimeError:
                pass
    return {"ok": True}


@app.get("/api/rooms")
async def get_rooms(request: Request) -> dict[str, Any]:
    require_session(request)
    return {"rooms": rooms_list()}


class RoomCreate(BaseModel):
    name: str = Field(min_length=2, max_length=32)
    topic: str = Field(default="", max_length=120)


@app.post("/api/rooms", status_code=201)
async def create_room(payload: RoomCreate, request: Request) -> dict[str, Any]:
    require_session(request)
    raw_name = " ".join(payload.name.strip().split())
    slug = re.sub(r"[^a-z0-9-]+", "-", raw_name.lower()).strip("-")[:26]
    if not ROOM_SLUG_RE.fullmatch(slug):
        raise HTTPException(status_code=400, detail="Room names must contain at least 2 letters or numbers.")
    async with LOCK:
        if slug in ROOMS:
            raise HTTPException(status_code=409, detail=f"#{slug} already exists.")
        room = {"id": slug, "name": raw_name[:32], "topic": payload.topic.strip()[:120], "system": False}
        ROOMS[slug] = room
        save_rooms()
    all_rooms = rooms_list()
    await broadcast({"t": "rooms", "rooms": all_rooms})
    return {"room": room, "rooms": all_rooms}


class ReplyRef(BaseModel):
    id: str = Field(max_length=80)
    authorName: str = Field(max_length=60)
    preview: str = Field(max_length=240)


class MessageCreate(BaseModel):
    room: str = Field(max_length=120)
    text: str = Field(min_length=1, max_length=4000)
    clientId: str = Field(default="", max_length=80)
    replyTo: ReplyRef | None = None


@app.post("/api/messages", status_code=201)
async def post_message(payload: MessageCreate, request: Request) -> dict[str, Any]:
    member_id, _ = require_session(request)
    room = normalize_room_id(payload.room.strip())
    text = payload.text.strip()
    if not text or len(text) > 4000 or not can_access(room, member_id):
        raise HTTPException(status_code=403, detail="You cannot post in this conversation.")
    message: dict[str, Any] = {
        "id": "m_" + secrets.token_hex(12),
        "room": room,
        "author": member_id,
        "ts": int(time.time() * 1000),
        "text": text,
        "readBy": [member_id],
    }
    if payload.replyTo is not None:
        message["replyTo"] = payload.replyTo.model_dump()
    async with LOCK:
        MESSAGES.append(message)
        RECORDS.append(pack_message(message))
        write_json(MESSAGES_FILE, RECORDS)
    wire = {**message, "clientId": payload.clientId} if payload.clientId else message
    await broadcast({"t": "message", "message": wire}, room=room)
    return {"message": wire}


class ReadReceiptPayload(BaseModel):
    room: str = Field(max_length=120)


async def mark_room_read(room_raw: str, member_id: str) -> list[str]:
    room = normalize_room_id(room_raw)
    if not can_access(room, member_id):
        return []
    updated_ids: list[str] = []
    async with LOCK:
        for idx, msg in enumerate(MESSAGES):
            if msg["room"] != room or msg["author"] == member_id:
                continue
            readers = msg.setdefault("readBy", [msg["author"]])
            if member_id not in readers:
                readers.append(member_id)
                RECORDS[idx] = pack_message(msg)
                updated_ids.append(msg["id"])
        if updated_ids:
            write_json(MESSAGES_FILE, RECORDS)
    if updated_ids:
        await broadcast(
            {
                "t": "messages_read",
                "room": room,
                "reader": member_id,
                "messageIds": updated_ids,
                "readAt": int(time.time() * 1000),
            },
            room=room,
        )
    return updated_ids


@app.post("/api/messages/read")
async def read_messages(payload: ReadReceiptPayload, request: Request) -> dict[str, Any]:
    member_id, _ = require_session(request)
    updated = await mark_room_read(payload.room, member_id)
    return {"updated": updated}


class EmergencyAlertPayload(BaseModel):
    timestamp: str | int
    location: dict[str, Any] | None = None
    device: str = Field(default="", max_length=300)
    queuedAt: str | int | None = None


@app.post("/api/emergency-alert")
async def emergency_alert(payload: EmergencyAlertPayload, request: Request) -> dict[str, bool]:
    """Covert duress sink: stores encrypted alert on disk and returns an unremarkable 200 OK."""
    check_limit(request, "emergency", 20, 300)
    auth = request.headers.get("authorization", "")
    found = session_for(auth[7:]) if auth.startswith("Bearer ") else None
    member_id = found[0] if found else "unauthenticated_or_wiped"
    entry = {
        "id": "duress_" + secrets.token_hex(10),
        "member": member_id,
        "receivedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "clientTimestamp": str(payload.timestamp),
        "queuedAt": str(payload.queuedAt) if payload.queuedAt else None,
        "location": payload.location,
        "device": payload.device,
        "ip": request.client.host if request.client else "unknown",
    }
    async with LOCK:
        existing = read_json(EMERGENCY_FILE, [])
        existing.append({"enc": encrypt_payload(entry)})
        write_json(EMERGENCY_FILE, existing[-500:])
    return {"ok": True}


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")


@app.get("/api/supabase/token")
async def supabase_token(request: Request) -> JSONResponse:
    """Mint a Supabase session for the signed-in member (server-side secret only).

    Lets the local Python deployment use Supabase for realtime messages without
    exposing SUPABASE_SECRET_KEY to the browser.
    """
    member_id, _ = require_session(request)
    record = USERS.get(member_id)
    email = str(record.get("google_email", "")).lower() if record else ""
    if not email:
        raise HTTPException(status_code=409, detail="This account has no linked Google email.")
    if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
        raise HTTPException(status_code=500, detail="Supabase is not configured on this server.")
    headers = {"apikey": SUPABASE_SECRET_KEY, "Authorization": f"Bearer {SUPABASE_SECRET_KEY}"}
    async with httpx.AsyncClient(timeout=15) as client:
        await client.post(
            f"{SUPABASE_URL}/auth/v1/admin/users",
            headers=headers,
            json={"email": email, "email_confirm": True,
                  "user_metadata": {"handle": record.get("handle"), "name": record.get("name")}},
        )
        link = await client.post(
            f"{SUPABASE_URL}/auth/v1/admin/generate_link",
            headers=headers,
            json={"type": "magiclink", "email": email},
        )
        if link.status_code != 200:
            raise HTTPException(status_code=502, detail="Could not create a Supabase session.")
        hashed = (link.json().get("properties") or {}).get("hashed_token")
        if not hashed:
            raise HTTPException(status_code=502, detail="Could not create a Supabase session.")
        verify = await client.post(
            f"{SUPABASE_URL}/auth/v1/verify",
            headers=headers,
            json={"type": "magiclink", "token_hash": hashed},
        )
        if verify.status_code != 200:
            raise HTTPException(status_code=502, detail="Could not verify the Supabase session.")
        payload = verify.json()
    return JSONResponse({
        "access_token": payload.get("access_token", ""),
        "refresh_token": payload.get("refresh_token", ""),
        "expires_at": payload.get("expires_at"),
        "email": email,
        "handle": record.get("handle", email.split("@")[0]),
        "display_name": record.get("name", email.split("@")[0]),
    })


@app.post("/api/files", status_code=201)
async def upload_file(request: Request, room: str = Form(...), file: UploadFile = File(...)) -> dict[str, Any]:
    member_id, _ = require_session(request)
    canonical_room = normalize_room_id(room)
    if not can_access(canonical_room, member_id):
        raise HTTPException(status_code=403, detail="You cannot post in this conversation.")
    content = await file.read(MAX_FILE + 1)
    if not content or len(content) > MAX_FILE:
        raise HTTPException(status_code=413, detail="Files must be between 1 byte and 15 MB.")
    name = re.sub(r"[\x00-\x1f/\\]", "_", file.filename or "attachment")[:160] or "attachment"
    mime = (file.content_type or "application/octet-stream").split(";")[0].lower()[:100]
    if not re.fullmatch(r"[a-z0-9.+-]+/[a-z0-9.+-]+", mime):
        mime = "application/octet-stream"
    file_id = secrets.token_hex(20)
    write_private(FILES_DIR / f"{file_id}.enc", CIPHER.encrypt(content))
    message = {
        "id": "m_" + secrets.token_hex(12),
        "room": canonical_room,
        "author": member_id,
        "ts": int(time.time() * 1000),
        "text": "",
        "readBy": [member_id],
        "file": {"id": file_id, "name": name, "mime": mime, "size": len(content)},
    }
    try:
        async with LOCK:
            MESSAGES.append(message)
            RECORDS.append(pack_message(message))
            write_json(MESSAGES_FILE, RECORDS)
    except Exception:
        (FILES_DIR / f"{file_id}.enc").unlink(missing_ok=True)
        raise
    await broadcast({"t": "message", "message": message}, room=canonical_room)
    return {"message": message}


@app.get("/api/files/{file_id}")
async def get_file(file_id: str, request: Request) -> Response:
    member_id, _ = require_session(request)
    if not re.fullmatch(r"[a-f0-9]{40}", file_id):
        raise HTTPException(status_code=404, detail="File not found.")
    message = next((m for m in MESSAGES if m.get("file", {}).get("id") == file_id), None)
    path = FILES_DIR / f"{file_id}.enc"
    if not message or not can_access(message["room"], member_id) or not path.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    try:
        data = CIPHER.decrypt(path.read_bytes())
    except InvalidToken:
        raise HTTPException(status_code=500, detail="This file could not be decrypted.")
    return Response(
        data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(message["file"]["name"])},
    )


@app.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    await ws.accept()
    member_id = ""
    digest = ""
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=8)
        if len(raw) > 4096:
            await ws.close(code=4401)
            return
        auth = json.loads(raw)
        session = session_for(str(auth.get("token", ""))) if isinstance(auth, dict) and auth.get("t") == "auth" else None
        if not session:
            await ws.close(code=4401)
            return
        member_id, digest = session
        SOCKETS[ws] = (member_id, digest)
        await send(
            ws,
            {
                "t": "ready",
                "you": public_member(member_id),
                "rooms": rooms_list(),
                "members": roster(),
                "presence": presence(),
                "messages": [m for m in MESSAGES if can_access(m["room"], member_id)],
            },
        )
        await broadcast({"t": "presence", "presence": presence()})
        while True:
            session_obj = SESSIONS.get(digest)
            if not session_obj or session_obj["expires"] <= time.time():
                await ws.close(code=4401)
                break
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=min(30, max(0.1, session_obj["expires"] - time.time())))
            except asyncio.TimeoutError:
                continue
            if len(raw) > 70_000:
                continue
            try:
                evt = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(evt, dict):
                continue
            kind = evt.get("t")
            if kind == "message":
                room = normalize_room_id(str(evt.get("room", "")))
                text = str(evt.get("text", "")).strip()
                client_id = str(evt.get("clientId", ""))[:80]
                if not can_access(room, member_id) or not text or len(text) > 4000:
                    await send(ws, {"t": "error", "text": "Message could not be sent."})
                    continue
                message = {
                    "id": "m_" + secrets.token_hex(12),
                    "room": room,
                    "author": member_id,
                    "ts": int(time.time() * 1000),
                    "text": text,
                    "readBy": [member_id],
                }
                async with LOCK:
                    MESSAGES.append(message)
                    RECORDS.append(pack_message(message))
                    write_json(MESSAGES_FILE, RECORDS)
                await broadcast({"t": "message", "message": {**message, "clientId": client_id}}, room=room)
            elif kind in ("typing", "typing_start", "typing_stop"):
                room = normalize_room_id(str(evt.get("room", "")))
                if can_access(room, member_id):
                    on = True if kind == "typing_start" else False if kind == "typing_stop" else bool(evt.get("on"))
                    event_name = "typing_start" if on else "typing_stop"
                    await broadcast(
                        {"t": event_name, "room": room, "member": member_id, "on": on},
                        room=room,
                        exclude=ws,
                    )
                    # Also emit legacy typing event for backward-compatible clients
                    await broadcast(
                        {"t": "typing", "room": room, "member": member_id, "on": on},
                        room=room,
                        exclude=ws,
                    )
            elif kind == "messages_read":
                room = normalize_room_id(str(evt.get("room", "")))
                await mark_room_read(room, member_id)
            elif kind == "react":
                message_id = str(evt.get("id", ""))
                reaction = str(evt.get("reaction", ""))
                index = next((i for i, message in enumerate(MESSAGES) if message["id"] == message_id), None)
                if index is None or reaction not in ("like", "ack", "fire") or not can_access(MESSAGES[index]["room"], member_id):
                    continue
                async with LOCK:
                    target = MESSAGES[index]
                    reactions = target.setdefault("reactions", {})
                    users = reactions.setdefault(reaction, [])
                    if member_id in users:
                        users.remove(member_id)
                    else:
                        users.append(member_id)
                    if not users:
                        reactions.pop(reaction, None)
                    RECORDS[index] = pack_message(target)
                    write_json(MESSAGES_FILE, RECORDS)
                await broadcast({"t": "reaction", "id": message_id, "reactions": reactions}, room=target["room"])
            elif kind == "signal":
                target_id = str(evt.get("to", ""))
                signal = evt.get("data")
                if (
                    registered(target_id)
                    and target_id != member_id
                    and isinstance(signal, dict)
                    and signal.get("type") in {"offer", "answer", "candidate", "end", "decline"}
                ):
                    await broadcast({"t": "signal", "from": member_id, "data": signal}, target=target_id)
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
        pass
    finally:
        if ws in SOCKETS:
            del SOCKETS[ws]
            await broadcast({"t": "presence", "presence": presence()})


if (DIST / "index.html").exists():
    if (DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    async def index(request: Request, code: str = "", state: str = ""):
        # If Google OAuth was configured with http://localhost:8000 as redirect URI directly:
        if code and state:
            return await oauth_callback(request, code=code, state=state)
        return FileResponse(DIST / "index.html")
else:
    @app.get("/")
    async def index_missing(request: Request, code: str = "", state: str = ""):
        if code and state:
            return await oauth_callback(request, code=code, state=state)
        return JSONResponse({"status": "server-only", "hint": "Run npm run build to serve Terminal here."})


if __name__ == "__main__":
    host = os.environ.get("TERMINAL_HOST") or os.environ.get("QUAD_HOST") or "127.0.0.1"
    port = int(os.environ.get("TERMINAL_PORT") or os.environ.get("QUAD_PORT") or "8000")
    print(f"Terminal server listening on http://localhost:{port}")
    print("Invite code source:", INVITE_FILE if not (os.environ.get("TERMINAL_INVITE_CODE") or os.environ.get("QUAD_INVITE_CODE")) else "environment variable")
    print("Google OAuth loaded from .env.local / server/.env. Secrets stay strictly server-side.")
    uvicorn.run(app, host=host, port=port, log_level="info", ws_max_size=100_000)
