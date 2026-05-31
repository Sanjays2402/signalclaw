"""ASGI middleware that touches the SessionStore on every authenticated
request. Runs after authentication (so we know the key id) and is a
no-op for anonymous or rejected traffic.

Kept as a thin wrapper around :class:`SessionStore.touch` so the store
itself stays framework-free and trivially unit-testable.
"""
from __future__ import annotations

from typing import Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from . import SessionStore


class SessionTrackingMiddleware(BaseHTTPMiddleware):
    DEFAULT_EXEMPT: tuple[str, ...] = (
        "/health",
        "/healthz",
        "/ready",
        "/readyz",
        "/metrics",
        "/disclaimer",
        "/docs",
        "/openapi.json",
        "/redoc",
        "/docs/oauth2-redirect",
        "/favicon.ico",
    )

    def __init__(
        self,
        app,
        store: SessionStore,
        exempt_paths: Iterable[str] = DEFAULT_EXEMPT,
    ) -> None:
        super().__init__(app)
        self._store = store
        self._exempt = tuple(exempt_paths)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self._exempt):
            return await call_next(request)

        response = await call_next(request)

        # Only record successful or auth-rejected calls that carried an
        # API key. 401 with no key is anonymous noise; 200 with no key
        # is a public endpoint and not worth tracking per-session.
        api_key = request.headers.get("x-api-key", "")
        if not api_key:
            return response

        # Resolve the key to get its id + label. Lazy import avoids a
        # circular dependency with ``api.rate_limit``.
        try:
            from ..api.rate_limit import _resolve_key  # type: ignore
            from ..api_keys import _hash as _hash_key  # type: ignore
        except Exception:
            return response

        rec = _resolve_key(api_key)
        if rec is None:
            return response

        # Prefer the user-managed key id when available, else fall back
        # to a stable hash of the secret so legacy env-keys still get a
        # consistent identifier in the session view.
        store = getattr(request.app.state, "api_key_store", None)
        key_id = ""
        if store is not None:
            stored = store.lookup(api_key)
            if stored is not None:
                key_id = stored.id
        if not key_id:
            key_id = "env:" + _hash_key(api_key)[:12]

        client = request.client.host if request.client else ""
        ip = request.headers.get(
            "x-forwarded-for", client).split(",")[0].strip() or client
        ua = request.headers.get("user-agent", "")[:256]

        try:
            self._store.touch(
                key_id=key_id,
                key_label=getattr(rec, "label", "") or "",
                source_ip=ip,
                user_agent=ua,
            )
        except OSError:
            # session tracking is observability, not safety: never let
            # disk pressure break a real request.
            pass
        return response
