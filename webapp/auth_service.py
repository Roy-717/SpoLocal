"""Optional local accounts, player devices, and remote-command queue.

Search, stream, media, and playlist view stay public. Writes need a session.
TOTP MFA is optional per account and never required to listen.
A logged-in browser can register as a device so later tools can target it.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerificationError, VerifyMismatchError

COOKIE_NAME = "spolocal_session"
TOKEN_TTL_SECONDS = 30 * 24 * 3600
MFA_CHALLENGE_TTL_SECONDS = 5 * 60
MFA_PENDING_TTL_SECONDS = 10 * 60
COMMAND_TTL_SECONDS = 60
DEVICE_STALE_SECONDS = 15 * 60
MIN_PASSWORD_LEN = 10
PBKDF2_ITERS = 210000
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,32}$")
_ALLOWED_ACTIONS = frozenset({"play", "pause", "toggle", "next", "prev"})
_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=2,
    hash_len=32,
    salt_len=16,
)
_DUMMY_HASH = None


def _now_ts() -> float:
    return time.time()


def hash_password(password: str) -> str:
    return _HASHER.hash(password)


def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_urlsafe(24))
    return _DUMMY_HASH


def _verify_pbkdf2(password: str, stored: str) -> bool:
    try:
        _algo, iters_s, salt_hex, hash_hex = stored.split("$", 3)
        iters = int(iters_s)
        dk = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            iters,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


def verify_password(password: str, stored: str) -> bool:
    if not stored:
        return False
    if stored.startswith("$argon2"):
        try:
            return _HASHER.verify(stored, password)
        except (VerifyMismatchError, VerificationError, InvalidHash):
            return False
    if stored.startswith("pbkdf2_sha256$"):
        return _verify_pbkdf2(password, stored)
    return False


def password_needs_rehash(stored: str) -> bool:
    if not stored.startswith("$argon2"):
        return True
    try:
        return _HASHER.check_needs_rehash(stored)
    except (InvalidHash, Exception):
        return True


class AttemptLimiter:
    """In-memory brute-force brake for login/register."""

    def __init__(self, max_n: int = 5, window: float = 60.0):
        self.max_n = max_n
        self.window = window
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def blocked(self, key: str) -> bool:
        now = _now_ts()
        with self._lock:
            stamps = self._hits[key]
            while stamps and now - stamps[0] >= self.window:
                stamps.popleft()
            return len(stamps) >= self.max_n

    def hit(self, key: str) -> None:
        now = _now_ts()
        with self._lock:
            stamps = self._hits[key]
            while stamps and now - stamps[0] >= self.window:
                stamps.popleft()
            stamps.append(now)

    def clear(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class AccountService:
    """Username+password accounts, optional TOTP, cookie sessions, and player devices."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.Lock()
        self._commands: dict[str, list[dict[str, Any]]] = {}
        self._mfa_challenges: dict[str, dict[str, Any]] = {}
        self._mfa_pending: dict[str, dict[str, Any]] = {}
        self._data = {"users": []}
        self._load()

    def _data_file(self) -> Path:
        override = (os.environ.get("SPLOCAL_ACCOUNTS_PATH") or "").strip()
        if override:
            return Path(override)
        playlists = (os.environ.get("SPLOCAL_PLAYLISTS_PATH") or "").strip()
        if playlists:
            return Path(playlists).parent / "accounts.json"
        data_dir = self.root / "data"
        if data_dir.is_dir():
            return data_dir / "accounts.json"
        return self.root / "accounts.json"

    def _load(self) -> None:
        path = self._data_file()
        if not path.is_file():
            self._data = {"users": []}
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._data = {"users": []}
            return
        users = raw.get("users") if isinstance(raw, dict) else None
        self._data = {"users": users if isinstance(users, list) else []}
        self._purge_expired_locked()

    def _save(self) -> None:
        path = self._data_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        payload = json.dumps(self._data, indent=2)
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def _purge_expired_locked(self) -> None:
        now = _now_ts()
        for user in self._data["users"]:
            sessions = [
                s for s in (user.get("sessions") or [])
                if float(s.get("expires_at") or 0) > now
            ]
            user["sessions"] = sessions
            devices = user.get("devices") or []
            for device in devices:
                last = float(device.get("last_seen") or 0)
                if device.get("active") and (now - last) > DEVICE_STALE_SECONDS:
                    device["active"] = False

    def _find_user(self, username: str) -> Optional[dict[str, Any]]:
        key = username.strip().lower()
        for user in self._data["users"]:
            if str(user.get("username") or "").lower() == key:
                return user
        return None

    def _user_by_id(self, user_id: str) -> Optional[dict[str, Any]]:
        for user in self._data["users"]:
            if user.get("id") == user_id:
                return user
        return None

    def _public_user(self, user: dict[str, Any]) -> dict[str, Any]:
        now = _now_ts()
        devices = []
        for device in user.get("devices") or []:
            last = float(device.get("last_seen") or 0)
            devices.append({
                "id": device.get("id"),
                "name": device.get("name") or "Player",
                "active": bool(device.get("active")),
                "online": (now - last) <= DEVICE_STALE_SECONDS,
                "last_seen": last,
            })
        active = next((d["id"] for d in devices if d["active"]), None)
        return {
            "id": user.get("id"),
            "username": user.get("username"),
            "mfa_enabled": bool(user.get("mfa_enabled")),
            "devices": devices,
            "active_device_id": active,
        }

    def _purge_mfa_locked(self) -> None:
        now = _now_ts()
        self._mfa_challenges = {
            key: row for key, row in self._mfa_challenges.items()
            if float(row.get("expires_at") or 0) > now
        }
        self._mfa_pending = {
            key: row for key, row in self._mfa_pending.items()
            if float(row.get("expires_at") or 0) > now
        }

    def _totp_ok(self, secret: str, code: str) -> bool:
        digits = "".join(ch for ch in (code or "") if ch.isdigit())
        if len(digits) != 6 or not secret:
            return False
        try:
            return bool(pyotp.TOTP(secret).verify(digits, valid_window=1))
        except (TypeError, ValueError):
            return False

    def _new_session(self, user: dict[str, Any]) -> str:
        raw = secrets.token_urlsafe(32)
        now = _now_ts()
        sessions = user.setdefault("sessions", [])
        sessions.append({
            "token_hash": hash_token(raw),
            "created_at": now,
            "expires_at": now + TOKEN_TTL_SECONDS,
        })
        return raw

    def _user_from_token(self, raw: Optional[str]) -> Optional[dict[str, Any]]:
        if not raw:
            return None
        digest = hash_token(raw.strip())
        now = _now_ts()
        for user in self._data["users"]:
            for session in user.get("sessions") or []:
                if session.get("token_hash") == digest and float(session.get("expires_at") or 0) > now:
                    return user
        return None

    def user_from_request(self, cookie: Optional[str], authorization: Optional[str]) -> Optional[dict[str, Any]]:
        raw = None
        if authorization:
            parts = authorization.strip().split(None, 1)
            if len(parts) == 2 and parts[0].lower() == "bearer":
                raw = parts[1].strip()
        if not raw:
            raw = (cookie or "").strip() or None
        with self._lock:
            self._purge_expired_locked()
            user = self._user_from_token(raw)
            return self._public_user(user) if user else None

    def register(self, username: str, password: str) -> dict[str, Any]:
        name = (username or "").strip()
        if not _USERNAME_RE.match(name):
            raise ValueError("Username must be 3-32 letters, numbers, or _")
        if not password or len(password) < MIN_PASSWORD_LEN:
            raise ValueError(f"Password must be at least {MIN_PASSWORD_LEN} characters")
        with self._lock:
            if self._find_user(name):
                raise ValueError("Username already taken")
            user = {
                "id": str(uuid4()),
                "username": name,
                "password_hash": hash_password(password),
                "created_at": _now_ts(),
                "sessions": [],
                "devices": [],
            }
            token = self._new_session(user)
            self._data["users"].append(user)
            self._save()
            return {"token": token, "user": self._public_user(user)}

    def login(self, username: str, password: str) -> dict[str, Any]:
        with self._lock:
            user = self._find_user(username or "")
            stored = str(user.get("password_hash") or "") if user else _dummy_hash()
            ok = verify_password(password or "", stored)
            if not user or not ok:
                raise ValueError("Invalid username or password")
            if password_needs_rehash(stored):
                user["password_hash"] = hash_password(password)
                self._save()
            if user.get("mfa_enabled") and str(user.get("mfa_secret") or ""):
                self._purge_mfa_locked()
                raw = secrets.token_urlsafe(32)
                self._mfa_challenges[hash_token(raw)] = {
                    "user_id": user["id"],
                    "expires_at": _now_ts() + MFA_CHALLENGE_TTL_SECONDS,
                }
                return {"mfa_required": True, "mfa_token": raw}
            token = self._new_session(user)
            self._save()
            return {"token": token, "user": self._public_user(user)}

    def complete_mfa_login(self, mfa_token: str, code: str) -> dict[str, Any]:
        raw = (mfa_token or "").strip()
        if not raw:
            raise ValueError("Code expired. Log in again.")
        digest = hash_token(raw)
        with self._lock:
            self._purge_mfa_locked()
            challenge = self._mfa_challenges.get(digest)
            if not challenge:
                raise ValueError("Code expired. Log in again.")
            user = self._user_by_id(str(challenge.get("user_id") or ""))
            secret = str(user.get("mfa_secret") or "") if user else ""
            if not user or not user.get("mfa_enabled") or not self._totp_ok(secret, code):
                raise ValueError("Invalid code")
            self._mfa_challenges.pop(digest, None)
            token = self._new_session(user)
            self._save()
            return {"token": token, "user": self._public_user(user)}

    def begin_mfa_setup(self, user_id: str) -> dict[str, str]:
        """Return a secret to paste into an authenticator. Not stored until confirm."""
        with self._lock:
            self._purge_mfa_locked()
            user = self._user_by_id(user_id)
            if not user:
                raise ValueError("Not logged in")
            if user.get("mfa_enabled"):
                raise ValueError("MFA is already on")
            secret = pyotp.random_base32()
            self._mfa_pending[user_id] = {
                "secret": secret,
                "expires_at": _now_ts() + MFA_PENDING_TTL_SECONDS,
            }
            uri = pyotp.TOTP(secret).provisioning_uri(
                name=str(user.get("username") or "user"),
                issuer_name="SpoLocal",
            )
            return {"secret": secret, "otpauth_uri": uri}

    def confirm_mfa(self, user_id: str, code: str) -> dict[str, Any]:
        with self._lock:
            self._purge_mfa_locked()
            user = self._user_by_id(user_id)
            if not user:
                raise ValueError("Not logged in")
            pending = self._mfa_pending.get(user_id)
            if not pending:
                raise ValueError("Enable MFA first, then enter the code")
            if not self._totp_ok(str(pending.get("secret") or ""), code):
                raise ValueError("Invalid code")
            user["mfa_secret"] = pending["secret"]
            user["mfa_enabled"] = True
            self._mfa_pending.pop(user_id, None)
            self._save()
            return {"user": self._public_user(user)}

    def disable_mfa(self, user_id: str, code: str) -> dict[str, Any]:
        with self._lock:
            user = self._user_by_id(user_id)
            if not user or not user.get("mfa_enabled"):
                raise ValueError("MFA is not on")
            if not self._totp_ok(str(user.get("mfa_secret") or ""), code):
                raise ValueError("Invalid code")
            user["mfa_enabled"] = False
            user.pop("mfa_secret", None)
            self._mfa_pending.pop(user_id, None)
            self._save()
            return {"user": self._public_user(user)}

    def logout(self, cookie: Optional[str], authorization: Optional[str]) -> None:
        raw = None
        if authorization:
            parts = authorization.strip().split(None, 1)
            if len(parts) == 2 and parts[0].lower() == "bearer":
                raw = parts[1].strip()
        if not raw:
            raw = (cookie or "").strip() or None
        if not raw:
            return
        digest = hash_token(raw)
        with self._lock:
            for user in self._data["users"]:
                before = user.get("sessions") or []
                after = [s for s in before if s.get("token_hash") != digest]
                if len(after) != len(before):
                    user["sessions"] = after
                    self._save()
                    return

    def upsert_device(
        self,
        user_id: str,
        device_id: Optional[str],
        name: str,
        *,
        make_active: bool = True,
    ) -> dict[str, Any]:
        label = (name or "").strip()[:80] or "Player"
        with self._lock:
            user = self._user_by_id(user_id)
            if not user:
                raise ValueError("Not logged in")
            devices = user.setdefault("devices", [])
            found = None
            if device_id:
                found = next((d for d in devices if d.get("id") == device_id), None)
            if found is None:
                found = {
                    "id": device_id or str(uuid4()),
                    "name": label,
                    "last_seen": _now_ts(),
                    "active": False,
                }
                devices.append(found)
            found["name"] = label
            found["last_seen"] = _now_ts()
            if make_active:
                for device in devices:
                    device["active"] = device.get("id") == found["id"]
            self._save()
            return self._public_user(user)

    def set_active_device(self, user_id: str, device_id: str) -> dict[str, Any]:
        with self._lock:
            user = self._user_by_id(user_id)
            if not user:
                raise ValueError("Not logged in")
            devices = user.get("devices") or []
            if not any(d.get("id") == device_id for d in devices):
                raise ValueError("Device not found")
            for device in devices:
                device["active"] = device.get("id") == device_id
            self._save()
            return self._public_user(user)

    def enqueue_command(
        self,
        user_id: str,
        action: str,
        device_id: Optional[str] = None,
    ) -> dict[str, Any]:
        act = (action or "").strip().lower()
        if act not in _ALLOWED_ACTIONS:
            raise ValueError("Unknown action")
        with self._lock:
            user = self._user_by_id(user_id)
            if not user:
                raise ValueError("Not logged in")
            target = (device_id or "").strip()
            if not target:
                active = next((d for d in (user.get("devices") or []) if d.get("active")), None)
                if not active:
                    raise ValueError("No active device")
                target = str(active["id"])
            elif not any(d.get("id") == target for d in (user.get("devices") or [])):
                raise ValueError("Device not found")
            cmd = {
                "id": str(uuid4()),
                "device_id": target,
                "action": act,
                "created_at": _now_ts(),
            }
            bucket = self._commands.setdefault(user_id, [])
            bucket.append(cmd)
            return {"ok": True, "command": cmd}

    def poll_commands(self, user_id: str, device_id: str) -> list[dict[str, Any]]:
        now = _now_ts()
        with self._lock:
            bucket = self._commands.get(user_id) or []
            keep: list[dict[str, Any]] = []
            due: list[dict[str, Any]] = []
            for cmd in bucket:
                if now - float(cmd.get("created_at") or 0) > COMMAND_TTL_SECONDS:
                    continue
                if cmd.get("device_id") == device_id:
                    due.append(cmd)
                else:
                    keep.append(cmd)
            self._commands[user_id] = keep
            return due
