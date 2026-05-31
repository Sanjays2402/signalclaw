"""TOTP-based multi-factor authentication for high-privilege API keys.

SignalClaw authenticates callers with an ``x-api-key`` header. For
admin-scoped actions (key minting, audit log access, GDPR export +
delete) an enterprise procurement reviewer will reasonably ask for a
second factor.

This module adds RFC 6238 TOTP enrollment, scoped to a single API key
(identified by the SHA-256 of its secret so the secret itself is never
written to disk). Enrolled keys must present a fresh ``x-mfa-code`` on
every admin call. Unenrolled keys are allowed by default and rejected
when ``SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN=1`` so an operator can flip
the deployment into "MFA required" mode without rewriting middleware.

Implementation notes:

* TOTP is HMAC-SHA1, 6 digits, 30 second step, per RFC 6238. We accept
  the current step plus a one-step window in either direction to
  tolerate clock skew.
* Secrets are stored as the raw base32 because the verifier needs them
  back. They live in a 0600 file under ``<data_dir>/mfa/enrollments.json``.
* The provisioning URI is generated for ``otpauth://totp/`` so any
  authenticator app (1Password, Authy, Google Authenticator, etc.) can
  enroll by scanning a QR rendering of it. We return the URI as text
  and let the UI render the QR client-side.
* Replay protection: we record the last accepted step per enrollment.
  A code is rejected when it matches the most recently accepted step,
  so an attacker who shoulder-surfs a 30s code cannot reuse it.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, Optional, Tuple
from urllib.parse import quote


_STEP_SECONDS = 30
_DIGITS = 6
_WINDOW = 1  # accept +/- one step for clock skew


def _hash_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def _b32_secret(num_bytes: int = 20) -> str:
    """Return a fresh base32 secret. 160 bits matches HMAC-SHA1 block."""
    return base64.b32encode(secrets.token_bytes(num_bytes)).decode("ascii").rstrip("=")


def _decode_secret(b32: str) -> bytes:
    pad = (-len(b32)) % 8
    return base64.b32decode(b32.upper() + "=" * pad, casefold=True)


def _hotp(secret: bytes, counter: int, digits: int = _DIGITS) -> str:
    msg = struct.pack(">Q", counter)
    h = hmac.new(secret, msg, hashlib.sha1).digest()
    offset = h[-1] & 0x0F
    code = (
        ((h[offset] & 0x7F) << 24)
        | ((h[offset + 1] & 0xFF) << 16)
        | ((h[offset + 2] & 0xFF) << 8)
        | (h[offset + 3] & 0xFF)
    )
    return str(code % (10 ** digits)).zfill(digits)


def _step_now(now: Optional[float] = None) -> int:
    return int((now if now is not None else time.time()) // _STEP_SECONDS)


def generate_code(secret_b32: str, at: Optional[float] = None) -> str:
    """Return the current 6-digit TOTP code for a secret. Useful for tests."""
    return _hotp(_decode_secret(secret_b32), _step_now(at))


def provisioning_uri(secret_b32: str, label: str, issuer: str = "SignalClaw") -> str:
    """Return an ``otpauth://`` URI any authenticator can scan."""
    safe_label = quote(f"{issuer}:{label}", safe="")
    safe_issuer = quote(issuer, safe="")
    return (
        f"otpauth://totp/{safe_label}?secret={secret_b32}"
        f"&issuer={safe_issuer}&algorithm=SHA1&digits={_DIGITS}&period={_STEP_SECONDS}"
    )


@dataclass
class Enrollment:
    key_hash: str
    secret_b32: str
    label: str = ""
    created_at: float = field(default_factory=time.time)
    confirmed: bool = False
    last_step: int = -1  # most recent accepted step, for replay protection

    def to_public(self) -> dict:
        return {
            "key_hash_prefix": self.key_hash[:8],
            "label": self.label,
            "created_at": self.created_at,
            "confirmed": self.confirmed,
        }


class MfaStore:
    """File-backed enrollment store. One record per api-key hash."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._items: Dict[str, Enrollment] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text())
        except (OSError, json.JSONDecodeError):
            return
        for raw in data.get("enrollments", []):
            try:
                e = Enrollment(**raw)
                self._items[e.key_hash] = e
            except TypeError:
                continue

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        body = {"enrollments": [asdict(e) for e in self._items.values()]}
        tmp.write_text(json.dumps(body, indent=2, sort_keys=True))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self._path)

    def get(self, api_key: str) -> Optional[Enrollment]:
        if not api_key:
            return None
        with self._lock:
            return self._items.get(_hash_key(api_key))

    def is_enrolled(self, api_key: str) -> bool:
        rec = self.get(api_key)
        return rec is not None and rec.confirmed

    def begin_enroll(self, api_key: str, label: str = "") -> Enrollment:
        """Start (or restart) enrollment. Returns the pending Enrollment.

        If a confirmed enrollment already exists we keep it and refuse
        to overwrite, returning the existing record. The UI should call
        :meth:`disable` first if the user wants to rotate.
        """
        kh = _hash_key(api_key)
        with self._lock:
            existing = self._items.get(kh)
            if existing is not None and existing.confirmed:
                return existing
            e = Enrollment(key_hash=kh, secret_b32=_b32_secret(),
                           label=label or (existing.label if existing else ""))
            self._items[kh] = e
            self._save()
            return e

    def confirm(self, api_key: str, code: str) -> bool:
        """Verify the first code and mark the enrollment confirmed."""
        rec = self.get(api_key)
        if rec is None or rec.confirmed:
            return False
        ok, step = _verify_code(rec.secret_b32, code, rec.last_step)
        if not ok:
            return False
        with self._lock:
            rec.confirmed = True
            rec.last_step = step
            self._save()
        return True

    def verify(self, api_key: str, code: str) -> bool:
        rec = self.get(api_key)
        if rec is None or not rec.confirmed:
            return False
        ok, step = _verify_code(rec.secret_b32, code, rec.last_step)
        if not ok:
            return False
        with self._lock:
            rec.last_step = step
            self._save()
        return True

    def disable(self, api_key: str) -> bool:
        kh = _hash_key(api_key)
        with self._lock:
            if kh not in self._items:
                return False
            del self._items[kh]
            self._save()
            return True

    def all_public(self) -> list:
        with self._lock:
            return [e.to_public() for e in self._items.values()]


def _verify_code(secret_b32: str, code: str, last_step: int,
                 at: Optional[float] = None) -> Tuple[bool, int]:
    """Return (ok, accepted_step). Rejects replays of last_step."""
    if not code or not code.isdigit() or len(code) not in (6, 7, 8):
        return False, -1
    secret = _decode_secret(secret_b32)
    now_step = _step_now(at)
    for delta in range(-_WINDOW, _WINDOW + 1):
        step = now_step + delta
        if step <= last_step:
            continue
        if hmac.compare_digest(_hotp(secret, step), code):
            return True, step
    return False, -1


__all__ = [
    "Enrollment",
    "MfaStore",
    "generate_code",
    "provisioning_uri",
]
