"""Unit tests for accounts, sessions, MFA, devices, and the login limiter."""
from __future__ import annotations

import hashlib
import hmac
import json

import pyotp
import pytest

import auth_service
from auth_service import (
    AccountService,
    AttemptLimiter,
    hash_password,
    hash_token,
    password_needs_rehash,
    verify_password,
)


class TestPasswordHashing:
    def test_argon2_round_trip(self) -> None:
        stored = hash_password("correct horse")
        assert stored.startswith("$argon2")
        assert verify_password("correct horse", stored)
        assert not verify_password("wrong", stored)

    def test_pbkdf2_round_trip(self) -> None:
        salt = "00112233445566778899aabbccddeeff"
        iters = 210000
        dk = hashlib.pbkdf2_hmac("sha256", b"secret", bytes.fromhex(salt), iters)
        stored = f"pbkdf2_sha256${iters}${salt}${dk.hex()}"
        assert verify_password("secret", stored)
        assert not verify_password("nope", stored)

    def test_unknown_hash_is_rejected(self) -> None:
        assert not verify_password("x", "")
        assert not verify_password("x", "plaintext")
        assert not verify_password("x", "pbkdf2_sha256$bad")

    def test_needs_rehash(self) -> None:
        assert password_needs_rehash("pbkdf2_sha256$1$aa$bb")
        assert not password_needs_rehash(hash_password("x"))


class TestHashToken:
    def test_matches_sha256(self) -> None:
        raw = "abc123"
        assert hash_token(raw) == hashlib.sha256(raw.encode()).hexdigest()

    def test_is_deterministic(self) -> None:
        assert hash_token("x") == hash_token("x")
        assert hash_token("x") != hash_token("y")


class TestAttemptLimiter:
    def test_blocks_after_max_hits(self, monkeypatch: pytest.MonkeyPatch) -> None:
        now = [1000.0]
        monkeypatch.setattr(auth_service, "_now_ts", lambda: now[0])
        limiter = AttemptLimiter(max_n=3, window=60.0)
        assert not limiter.blocked("ip")
        for _ in range(3):
            limiter.hit("ip")
        assert limiter.blocked("ip")
        assert not limiter.blocked("other")

    def test_window_expires(self, monkeypatch: pytest.MonkeyPatch) -> None:
        now = [1000.0]
        monkeypatch.setattr(auth_service, "_now_ts", lambda: now[0])
        limiter = AttemptLimiter(max_n=2, window=10.0)
        limiter.hit("ip")
        limiter.hit("ip")
        assert limiter.blocked("ip")
        now[0] += 11.0
        assert not limiter.blocked("ip")

    def test_clear(self) -> None:
        limiter = AttemptLimiter(max_n=1, window=60.0)
        limiter.hit("ip")
        assert limiter.blocked("ip")
        limiter.clear("ip")
        assert not limiter.blocked("ip")


class TestRegisterAndLogin:
    def test_register_returns_token_and_public_user(self, accounts: AccountService) -> None:
        result = accounts.register("alice", "long enough")
        assert result["token"]
        assert result["user"]["username"] == "alice"
        assert "password_hash" not in result["user"]

    def test_register_rejects_duplicate(self, accounts: AccountService) -> None:
        accounts.register("alice", "long enough")
        with pytest.raises(ValueError, match="already taken"):
            accounts.register("ALICE", "long enough")

    @pytest.mark.parametrize("username", ["ab", "a" * 33, "bad name", "bad-name", ""])
    def test_register_rejects_bad_username(self, accounts: AccountService, username: str) -> None:
        with pytest.raises(ValueError, match="Username"):
            accounts.register(username, "long enough")

    def test_register_rejects_short_password(self, accounts: AccountService) -> None:
        with pytest.raises(ValueError, match="at least"):
            accounts.register("alice", "short")

    def test_login_round_trip(self, accounts: AccountService) -> None:
        accounts.register("alice", "long enough")
        result = accounts.login("alice", "long enough")
        assert result["token"]
        assert result["user"]["username"] == "alice"

    def test_login_is_case_insensitive_on_username(self, accounts: AccountService) -> None:
        accounts.register("Alice", "long enough")
        assert accounts.login("alice", "long enough")["token"]

    def test_login_rejects_wrong_password(self, accounts: AccountService) -> None:
        accounts.register("alice", "long enough")
        with pytest.raises(ValueError, match="Invalid"):
            accounts.login("alice", "wrong")

    def test_login_rejects_unknown_user(self, accounts: AccountService) -> None:
        with pytest.raises(ValueError, match="Invalid"):
            accounts.login("nobody", "whatever")

    def test_session_lookup_and_logout(self, accounts: AccountService) -> None:
        token = accounts.register("alice", "long enough")["token"]
        user = accounts.user_from_request(token, None)
        assert user and user["username"] == "alice"
        accounts.logout(token, None)
        assert accounts.user_from_request(token, None) is None

    def test_bearer_token_lookup(self, accounts: AccountService) -> None:
        token = accounts.register("alice", "long enough")["token"]
        user = accounts.user_from_request(None, f"Bearer {token}")
        assert user and user["username"] == "alice"

    def test_expired_session_is_ignored(self, accounts: AccountService, monkeypatch: pytest.MonkeyPatch) -> None:
        token = accounts.register("alice", "long enough")["token"]
        now = auth_service._now_ts()
        monkeypatch.setattr(auth_service, "_now_ts", lambda: now + auth_service.TOKEN_TTL_SECONDS + 1)
        assert accounts.user_from_request(token, None) is None

    def test_persists_to_disk(self, accounts: AccountService, temp_root) -> None:
        accounts.register("alice", "long enough")
        path = temp_root / "accounts.json"
        assert path.is_file()
        data = json.loads(path.read_text())
        assert data["users"][0]["username"] == "alice"
        reloaded = AccountService(temp_root)
        assert reloaded.login("alice", "long enough")["token"]


class TestMfa:
    def test_setup_confirm_login_and_disable(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        setup = accounts.begin_mfa_setup(user_id)
        secret = setup["secret"]
        assert setup["otpauth_uri"].startswith("otpauth://totp/")

        code = pyotp.TOTP(secret).now()
        confirmed = accounts.confirm_mfa(user_id, code)
        assert confirmed["user"]["mfa_enabled"] is True

        login = accounts.login("alice", "long enough")
        assert login["mfa_required"] is True
        assert "token" not in login

        completed = accounts.complete_mfa_login(login["mfa_token"], pyotp.TOTP(secret).now())
        assert completed["token"]
        assert completed["user"]["mfa_enabled"] is True

        accounts.disable_mfa(user_id, pyotp.TOTP(secret).now())
        assert accounts.login("alice", "long enough")["token"]

    def test_setup_twice_is_rejected(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        secret = accounts.begin_mfa_setup(user_id)["secret"]
        accounts.confirm_mfa(user_id, pyotp.TOTP(secret).now())
        with pytest.raises(ValueError, match="already on"):
            accounts.begin_mfa_setup(user_id)

    def test_confirm_requires_setup(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        with pytest.raises(ValueError, match="Enable MFA"):
            accounts.confirm_mfa(user_id, "123456")

    def test_confirm_rejects_bad_code(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        accounts.begin_mfa_setup(user_id)
        with pytest.raises(ValueError, match="Invalid code"):
            accounts.confirm_mfa(user_id, "000000")

    def test_mfa_login_rejects_bad_code(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        secret = accounts.begin_mfa_setup(user_id)["secret"]
        accounts.confirm_mfa(user_id, pyotp.TOTP(secret).now())
        challenge = accounts.login("alice", "long enough")["mfa_token"]
        with pytest.raises(ValueError, match="Invalid code"):
            accounts.complete_mfa_login(challenge, "000000")

    def test_mfa_login_rejects_unknown_challenge(self, accounts: AccountService) -> None:
        with pytest.raises(ValueError, match="expired"):
            accounts.complete_mfa_login("nope", "123456")

    def test_disable_requires_mfa(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        with pytest.raises(ValueError, match="not on"):
            accounts.disable_mfa(user_id, "123456")


class TestDevicesAndCommands:
    def test_upsert_device_makes_it_active(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        public = accounts.upsert_device(user_id, "dev-1", "Living room")
        assert public["devices"][0]["id"] == "dev-1"
        assert public["active_device_id"] == "dev-1"

    def test_upsert_second_device_switches_active(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        accounts.upsert_device(user_id, "dev-1", "One")
        public = accounts.upsert_device(user_id, "dev-2", "Two")
        assert public["active_device_id"] == "dev-2"
        assert [d["active"] for d in public["devices"]] == [False, True]

    def test_set_active_device(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        accounts.upsert_device(user_id, "dev-1", "One")
        accounts.upsert_device(user_id, "dev-2", "Two")
        public = accounts.set_active_device(user_id, "dev-1")
        assert public["active_device_id"] == "dev-1"

    def test_set_active_unknown_device(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        with pytest.raises(ValueError, match="not found"):
            accounts.set_active_device(user_id, "nope")

    def test_enqueue_and_poll_commands(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        accounts.upsert_device(user_id, "dev-1", "One")
        result = accounts.enqueue_command(user_id, "play")
        assert result["ok"] is True
        assert result["command"]["device_id"] == "dev-1"

        due = accounts.poll_commands(user_id, "dev-1")
        assert [c["action"] for c in due] == ["play"]
        assert accounts.poll_commands(user_id, "dev-1") == []

    def test_enqueue_rejects_unknown_action(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        with pytest.raises(ValueError, match="Unknown action"):
            accounts.enqueue_command(user_id, "explode")

    def test_enqueue_requires_active_device(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        with pytest.raises(ValueError, match="No active device"):
            accounts.enqueue_command(user_id, "play")

    def test_enqueue_targets_named_device(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        accounts.upsert_device(user_id, "dev-1", "One")
        accounts.upsert_device(user_id, "dev-2", "Two")
        result = accounts.enqueue_command(user_id, "pause", device_id="dev-1")
        assert result["command"]["device_id"] == "dev-1"

    def test_enqueue_rejects_unknown_device(self, accounts: AccountService) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        with pytest.raises(ValueError, match="not found"):
            accounts.enqueue_command(user_id, "play", device_id="nope")

    def test_expired_commands_are_dropped(self, accounts: AccountService, monkeypatch: pytest.MonkeyPatch) -> None:
        user_id = accounts.register("alice", "long enough")["user"]["id"]
        accounts.upsert_device(user_id, "dev-1", "One")
        accounts.enqueue_command(user_id, "next")
        now = auth_service._now_ts()
        monkeypatch.setattr(auth_service, "_now_ts", lambda: now + auth_service.COMMAND_TTL_SECONDS + 1)
        assert accounts.poll_commands(user_id, "dev-1") == []

    def test_commands_are_per_user(self, accounts: AccountService) -> None:
        alice = accounts.register("alice", "long enough")["user"]["id"]
        bob = accounts.register("bob", "long enough")["user"]["id"]
        accounts.upsert_device(alice, "dev-a", "A")
        accounts.upsert_device(bob, "dev-b", "B")
        accounts.enqueue_command(alice, "play")
        assert accounts.poll_commands(bob, "dev-b") == []
