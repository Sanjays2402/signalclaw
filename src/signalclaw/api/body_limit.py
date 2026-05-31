"""Request body size limit middleware.

Enterprise security reviews routinely flag APIs that accept
unbounded request bodies. An attacker (or a misbehaving client)
can ship a multi-gigabyte payload and pin the process on parsing
or buffering before any auth check runs. This middleware caps the
payload size in two layers of defence:

1. ``Content-Length`` header check: if the client declares a body
   larger than the configured cap, we reject immediately with
   ``413 Payload Too Large`` and never read a byte.
2. Streaming guard: if the header is missing or lies (chunked
   transfer, broken client), we wrap the ASGI ``receive`` and
   tally bytes as they arrive. The moment the running total
   exceeds the cap, we abort with 413.

The cap is configurable at runtime via the admin console
(``GET/PUT /admin/body-limit``) so an operator can raise it for a
bulk-import endpoint or lower it after a security incident,
without redeploying. Persisted to ``<data_dir>/body_limit.json``
so the value survives restarts.

Rejections write a structured ``body.limit.exceeded`` audit row
with the actor (when known), method, path, declared/observed
bytes, and the active cap. GET/HEAD/OPTIONS are always exempt
because they have no body to limit.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..logging_ import get_logger

log = get_logger("api.body_limit")


# Hard floor / ceiling for the configurable cap so a misconfigured
# admin call cannot turn the limit off entirely or set a value that
# would OOM the host. 1 KiB up to 1 GiB.
MIN_LIMIT_BYTES = 1024
MAX_LIMIT_BYTES = 1024 * 1024 * 1024

# Default 1 MiB. Comfortably above every JSON payload these APIs
# accept (largest is a webhook subscription list, well under 64 KiB)
# and small enough to stop a casual DoS probe.
DEFAULT_LIMIT_BYTES = 1024 * 1024

_EXEMPT_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class BodyLimitConfig:
    max_bytes: int = DEFAULT_LIMIT_BYTES

    def to_dict(self) -> dict:
        return {"max_bytes": int(self.max_bytes)}


class BodyLimitStore:
    """File-backed config store. JSON, single dict, atomic write."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._cfg = self._load()

    def _load(self) -> BodyLimitConfig:
        if not self.path.exists():
            return BodyLimitConfig()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            mb = int(raw.get("max_bytes", DEFAULT_LIMIT_BYTES))
            return BodyLimitConfig(max_bytes=_clamp(mb))
        except Exception:
            return BodyLimitConfig()

    def _save(self) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._cfg.to_dict()), encoding="utf-8")
        tmp.replace(self.path)

    def get(self) -> BodyLimitConfig:
        with self._lock:
            return BodyLimitConfig(max_bytes=self._cfg.max_bytes)

    def set_max_bytes(self, value: int) -> BodyLimitConfig:
        clamped = _clamp(value)
        with self._lock:
            self._cfg = BodyLimitConfig(max_bytes=clamped)
            self._save()
            return BodyLimitConfig(max_bytes=clamped)


def _clamp(value: int) -> int:
    v = int(value)
    if v < MIN_LIMIT_BYTES:
        return MIN_LIMIT_BYTES
    if v > MAX_LIMIT_BYTES:
        return MAX_LIMIT_BYTES
    return v


async def _send_413(send: Send, declared: Optional[int], cap: int) -> None:
    body = json.dumps({
        "error": "payload_too_large",
        "message": (
            "Request body exceeds the configured limit. "
            "Contact your workspace admin to raise the cap or split "
            "the payload across multiple requests."
        ),
        "limit_bytes": int(cap),
        "declared_bytes": int(declared) if declared is not None else None,
    }).encode("utf-8")
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
        (b"x-body-limit-bytes", str(int(cap)).encode("ascii")),
        (b"connection", b"close"),
    ]
    await send({"type": "http.response.start", "status": 413, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


class BodyLimitMiddleware:
    """Pure ASGI middleware.

    Implemented at the ASGI level (not BaseHTTPMiddleware) so we can
    intercept ``http.request`` messages and short-circuit BEFORE
    Starlette buffers the full body into memory. BaseHTTPMiddleware
    eagerly reads the body, which would defeat the point of a body
    size guard.
    """

    def __init__(self, app: ASGIApp, store: BodyLimitStore, audit_log=None) -> None:
        self.app = app
        self.store = store
        self.audit_log = audit_log

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET").upper()
        if method in _EXEMPT_METHODS:
            await self.app(scope, receive, send)
            return

        cap = self.store.get().max_bytes

        # Layer 1: trust the Content-Length header if present.
        declared: Optional[int] = None
        for hk, hv in scope.get("headers", []):
            if hk == b"content-length":
                try:
                    declared = int(hv.decode("ascii"))
                except (ValueError, UnicodeDecodeError):
                    declared = None
                break

        if declared is not None and declared > cap:
            self._audit(scope, declared, cap, layer="header")
            await _send_413(send, declared, cap)
            return

        # Layer 2: stream guard.
        running = {"bytes": 0, "tripped": False}

        async def guarded_receive() -> Message:
            msg = await receive()
            if msg["type"] == "http.request" and not running["tripped"]:
                body = msg.get("body", b"") or b""
                running["bytes"] += len(body)
                if running["bytes"] > cap:
                    running["tripped"] = True
                    self._audit(scope, running["bytes"], cap, layer="stream")
            return msg

        sent_response = {"flag": False}

        async def guarded_send(msg: Message) -> None:
            if running["tripped"] and not sent_response["flag"]:
                sent_response["flag"] = True
                await _send_413(send, running["bytes"], cap)
                return
            if sent_response["flag"]:
                return
            await send(msg)

        try:
            await self.app(scope, guarded_receive, guarded_send)
        except Exception:
            if running["tripped"] and not sent_response["flag"]:
                sent_response["flag"] = True
                await _send_413(send, running["bytes"], cap)
                return
            raise

    def _audit(self, scope: Scope, observed: int, cap: int, *, layer: str) -> None:
        path = scope.get("path", "")
        method = scope.get("method", "")
        log.warning(
            "body.limit.exceeded",
            path=path, method=method, observed=observed,
            cap=cap, layer=layer,
        )
        if self.audit_log is None:
            return
        try:
            from datetime import datetime, timezone
            import uuid as _uuid
            from ..audit.log import AuditEvent
            client = scope.get("client") or ("", 0)
            src_ip = client[0] if client else ""
            self.audit_log.record(AuditEvent(
                ts=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                request_id=str(_uuid.uuid4()),
                method=method,
                path=path,
                status=413,
                actor_key_hash="",
                actor_label="",
                source_ip=src_ip,
                duration_ms=0.0,
                action="body.limit.exceeded",
                extra={"observed_bytes": int(observed),
                       "limit_bytes": int(cap),
                       "layer": layer},
            ))
        except Exception:
            # Never let an audit failure break the rejection path.
            pass
