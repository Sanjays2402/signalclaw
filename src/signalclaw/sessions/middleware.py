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
from starlette.responses import JSONResponse

from . import SessionStore, _fingerprint
from .revocation import RevocationStore


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
        revocations: RevocationStore | None = None,
        exempt_paths: Iterable[str] = DEFAULT_EXEMPT,
    ) -> None:
        super().__init__(app)
        self._store = store
        self._revocations = revocations
        self._exempt = tuple(exempt_paths)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self._exempt):
            return await call_next(request)

        api_key = request.headers.get("x-api-key", "")
        if not api_key:
            return await call_next(request)

        # Resolve the key to get its id + label. Lazy import avoids a
        # circular dependency with ``api.rate_limit``.
        try:
            from ..api.rate_limit import _resolve_key  # type: ignore
            from ..api_keys import _hash as _hash_key  # type: ignore
        except Exception:
            return await call_next(request)

        rec = _resolve_key(api_key)
        if rec is None:
            return await call_next(request)

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
        session_id = _fingerprint(key_id, ip, ua or "")

        # Enforce force-logout. A revoked (session_id, key_id) tuple
        # is rejected with 401 BEFORE the request reaches the route.
        # Without this check, the admin "Revoke session" button only
        # cleared the ledger row; the same client recreated the row on
        # its next request. Admin endpoints under /admin/sessions and
        # /admin/keys are exempt so an operator who accidentally
        # revokes themselves can still reverse the action.
        if (self._revocations is not None
                and not path.startswith("/admin/sessions")
                and not path.startswith("/admin/keys")):
            try:
                hit = self._revocations.is_revoked(
                    session_id=session_id, key_id=key_id)
            except OSError:
                hit = None
            if hit is not None:
                return JSONResponse(
                    status_code=401,
                    content={
                        "detail": "session revoked",
                        "reason": hit.reason,
                        "scope": hit.scope,
                        "expires_at": hit.expires_at,
                    },
                    headers={"x-session-revoked": "1"},
                )

        response = await call_next(request)

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
