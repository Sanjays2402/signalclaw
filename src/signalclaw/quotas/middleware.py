"""ASGI middleware that enforces monthly quotas and emits standard
``X-RateLimit-*`` response headers.

Behaviour
---------

* Skips exempt paths (health, metrics, docs, disclaimer) so monitoring
  and the OpenAPI doc never burn customer quota.
* Resolves the caller's key id from ``x-api-key``. If the request is
  unauthenticated the middleware is a no-op (auth/scope middlewares
  already gate access for the routes that care).
* Looks up the assigned plan and current usage. If usage already meets
  or exceeds the monthly ceiling, returns ``429`` with::

      X-RateLimit-Scope:    monthly
      X-RateLimit-Limit:    <plan.monthly_limit>
      X-RateLimit-Remaining: 0
      X-RateLimit-Reset:    <unix-epoch of next month UTC>
      Retry-After:          <seconds until next month>

  Body includes ``plan``, ``limit``, and ``reset_at`` so a customer
  dashboard can render the failure without re-probing.
* Successful requests get the same ``X-RateLimit-*`` headers reflecting
  the post-increment state. Unlimited plans get ``X-RateLimit-Limit: 0``
  (matches GitHub's convention for unlimited) and omit ``Remaining``.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Iterable, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import QuotaStore, month_key, seconds_until_next_month
from ..api.rate_limit import get_registry, _USER_STORE  # type: ignore
import hashlib


DEFAULT_EXEMPT = (
    "/health", "/healthz", "/ready", "/readyz",
    "/metrics", "/disclaimer",
    "/docs", "/openapi.json", "/redoc",
    "/docs/oauth2-redirect",
    "/public",
)


def _key_id_for(api_key: Optional[str]) -> Optional[str]:
    """Resolve an ``x-api-key`` header to a stable key identifier.

    For user-managed keys we use the stored ``id`` so usage survives
    secret rotation. For env-configured (legacy) keys we derive a
    deterministic ``env:<sha8>`` id so two different env keys do not
    collide on the same bucket. Anonymous / unrecognised traffic
    returns ``None`` and is skipped by the middleware.
    """
    if not api_key:
        return None
    # Prefer the user-managed store (survives rotation via stored id).
    from ..api import rate_limit as _rl  # late import to read current binding
    store = _rl._USER_STORE
    if store is not None:
        stored = store.lookup(api_key)
        if stored is not None:
            return f"key:{stored.id}"
    rec = get_registry().get(api_key)
    if rec is not None:
        digest = hashlib.sha256(api_key.encode()).hexdigest()[:8]
        return f"env:{digest}"
    return None


def _set_rate_headers(response: Response, *, limit: int, remaining: int,
                      reset_epoch: int, scope: str = "monthly") -> None:
    response.headers["X-RateLimit-Scope"] = scope
    response.headers["X-RateLimit-Limit"] = str(int(limit))
    response.headers["X-RateLimit-Reset"] = str(int(reset_epoch))
    if remaining >= 0:
        response.headers["X-RateLimit-Remaining"] = str(int(remaining))


class QuotaMiddleware(BaseHTTPMiddleware):
    """Per-key monthly usage cap + standard rate-limit headers."""

    def __init__(self, app, store: QuotaStore,
                 exempt_paths: Iterable[str] = DEFAULT_EXEMPT) -> None:
        super().__init__(app)
        self.store = store
        self.exempt = tuple(exempt_paths)

    def _is_exempt(self, path: str) -> bool:
        return any(path == p or path.startswith(p + "/") for p in self.exempt)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if self._is_exempt(path):
            return await call_next(request)

        api_key = request.headers.get("x-api-key")
        key_id = _key_id_for(api_key)
        if not key_id:
            # Anonymous or unrecognised key: do not bill against any
            # plan, do not surface headers (they would be misleading).
            return await call_next(request)

        plan = self.store.plan_for(key_id)
        now = datetime.now(timezone.utc)
        m = month_key(now)
        used = self.store.usage(key_id, m)
        reset_epoch = int(now.timestamp()) + seconds_until_next_month(now)

        # Enforce ceiling BEFORE incrementing so a saturated key sees a
        # clean 429 without paying for the rejected request.
        if plan.monthly_limit > 0 and used >= plan.monthly_limit:
            retry = seconds_until_next_month(now)
            body = {
                "detail": "monthly quota exceeded",
                "plan": plan.to_public(),
                "scope": "monthly",
                "limit": int(plan.monthly_limit),
                "used": int(used),
                "remaining": 0,
                "reset_at": datetime.fromtimestamp(
                    reset_epoch, tz=timezone.utc).isoformat().replace(
                    "+00:00", "Z"),
                "retry_after_seconds": int(retry),
            }
            resp = JSONResponse(status_code=429, content=body)
            resp.headers["Retry-After"] = str(int(retry))
            _set_rate_headers(
                resp,
                limit=plan.monthly_limit,
                remaining=0,
                reset_epoch=reset_epoch,
            )
            return resp

        # Within budget: count this call. We bump BEFORE awaiting the
        # downstream so concurrent callers race fairly on the counter
        # and the response headers we emit reflect what the next caller
        # will see, not a stale pre-increment value.
        new_used = self.store.increment(key_id, 1, month=m)
        response = await call_next(request)

        if plan.monthly_limit > 0:
            remaining = max(0, plan.monthly_limit - new_used)
            _set_rate_headers(
                response,
                limit=plan.monthly_limit,
                remaining=remaining,
                reset_epoch=reset_epoch,
            )
        else:
            # Unlimited plan: signal "no cap" but still advertise the
            # reset window so the client can surface a usage figure if
            # it wants. GitHub uses 0 for unlimited; we mirror that.
            _set_rate_headers(
                response,
                limit=0,
                remaining=-1,
                reset_epoch=reset_epoch,
            )
            response.headers["X-RateLimit-Remaining"] = "unlimited"
        return response
