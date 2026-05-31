"""Strict CORS middleware backed by :mod:`signalclaw.cors_policy`.

Implemented as a pure ASGI middleware (not :class:`BaseHTTPMiddleware`)
to avoid the known anyio task-group deadlocks that surface when a
``BaseHTTPMiddleware`` short-circuits with a response under the TestClient.
The behaviour is otherwise identical to a Starlette CORSMiddleware: it
handles preflight (``OPTIONS`` with ``Access-Control-Request-Method``)
directly and mirrors the request Origin on simple/actual requests.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Iterable, List, Tuple

from . import (
    ALLOWED_METHODS,
    ALLOWED_REQUEST_HEADERS,
    CorsPolicyStore,
)


_SAFE_HEADERS = {h.lower() for h in ALLOWED_REQUEST_HEADERS}
_SAFE_METHODS = {m.upper() for m in ALLOWED_METHODS}
_ALLOW_METHODS_VALUE = ", ".join(sorted(_SAFE_METHODS))


def _decode_headers(raw: Iterable[Tuple[bytes, bytes]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in raw:
        out[k.decode("latin-1").lower()] = v.decode("latin-1")
    return out


def _filter_request_headers(raw: str) -> str:
    if not raw:
        return ""
    accepted: List[str] = []
    for h in raw.split(","):
        name = h.strip().lower()
        if name and name in _SAFE_HEADERS:
            accepted.append(name)
    return ", ".join(accepted)


def _filter_request_method(raw: str) -> str:
    m = (raw or "").strip().upper()
    return m if m in _SAFE_METHODS else ""


class StrictCorsMiddleware:
    """Pure ASGI CORS middleware with a dynamic per-workspace allowlist."""

    def __init__(self, app, store: CorsPolicyStore) -> None:
        self.app = app
        self._store = store

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = _decode_headers(scope.get("headers", []))
        origin = headers.get("origin")
        method = scope.get("method", "GET").upper()

        policy = self._store.get()
        origin_allowed = bool(
            origin and policy.enabled and origin in policy.origins
        )

        # Preflight
        if method == "OPTIONS" and headers.get("access-control-request-method"):
            if not origin_allowed:
                await self._send_simple(send, 403, b"CORS origin not allowed")
                return
            req_method = _filter_request_method(
                headers.get("access-control-request-method", "")
            )
            if not req_method:
                await self._send_simple(send, 403, b"CORS method not allowed")
                return
            allow_headers = _filter_request_headers(
                headers.get("access-control-request-headers", "")
            )
            resp_headers: List[Tuple[bytes, bytes]] = [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"vary", b"Origin"),
                (b"access-control-allow-methods", _ALLOW_METHODS_VALUE.encode("latin-1")),
                (b"access-control-max-age", b"600"),
                (b"content-length", b"0"),
            ]
            if allow_headers:
                resp_headers.append(
                    (b"access-control-allow-headers", allow_headers.encode("latin-1")),
                )
            if policy.allow_credentials:
                resp_headers.append(
                    (b"access-control-allow-credentials", b"true"),
                )
            await send({
                "type": "http.response.start",
                "status": 204,
                "headers": resp_headers,
            })
            await send({"type": "http.response.body", "body": b""})
            return

        # Wrap send to inject CORS headers on actual responses.
        if not origin_allowed:
            await self.app(scope, receive, send)
            return

        async def _wrapped_send(message):
            if message.get("type") == "http.response.start":
                hdrs = list(message.get("headers") or [])
                # Replace any existing ACAO (defense in depth) and add Vary.
                hdrs = [
                    (k, v) for (k, v) in hdrs
                    if k.lower() != b"access-control-allow-origin"
                ]
                hdrs.append(
                    (b"access-control-allow-origin", origin.encode("latin-1")),
                )
                # Merge Vary header.
                vary_idx = next(
                    (i for i, (k, _) in enumerate(hdrs) if k.lower() == b"vary"),
                    None,
                )
                if vary_idx is None:
                    hdrs.append((b"vary", b"Origin"))
                else:
                    existing = hdrs[vary_idx][1].decode("latin-1")
                    parts = [p.strip() for p in existing.split(",") if p.strip()]
                    if not any(p.lower() == "origin" for p in parts):
                        parts.append("Origin")
                    hdrs[vary_idx] = (b"vary", ", ".join(parts).encode("latin-1"))
                if policy.allow_credentials:
                    hdrs.append(
                        (b"access-control-allow-credentials", b"true"),
                    )
                message = {**message, "headers": hdrs}
            await send(message)

        await self.app(scope, receive, _wrapped_send)

    async def _send_simple(self, send, status: int, body: bytes) -> None:
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"text/plain; charset=utf-8"),
                (b"content-length", str(len(body)).encode("latin-1")),
            ],
        })
        await send({"type": "http.response.body", "body": body})


__all__ = ["StrictCorsMiddleware"]
