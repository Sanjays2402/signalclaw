"""Per-API-key token-bucket rate limiting with scope enforcement.

Two layered concerns share this module:

1. ``ApiKeyRegistry`` resolves an incoming ``x-api-key`` to a key record
   carrying scopes (``read``, ``trade``, ``admin``) and an optional
   per-key rate-limit override. The registry is built from environment
   config or the legacy single-key fallback so existing deployments keep
   working.

2. ``TokenBucket`` and ``RateLimitMiddleware`` apply a refilling bucket
   per (key, route-class) and return HTTP 429 with a ``Retry-After``
   header when the bucket is empty.

Scope checks are exposed as a FastAPI dependency factory ``require_scope``.
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Set

from fastapi import Header, HTTPException, status
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


# Routes that mutate state need the ``trade`` scope. Everything else is
# ``read``. ``/admin/*`` (future) needs ``admin``. The check is a path
# prefix match in priority order.
SCOPE_RULES: List[tuple[str, tuple[str, ...], str]] = [
    # (path_prefix, methods, required_scope)
    ("/admin/", ("*",), "admin"),
    ("/portfolio/trades", ("POST", "DELETE", "PUT"), "trade"),
    ("/stops", ("POST", "DELETE", "PUT"), "trade"),
    ("/alerts", ("POST", "DELETE", "PUT"), "trade"),
    ("/watchlist", ("POST", "DELETE", "PUT"), "trade"),
    ("/earnings", ("POST", "DELETE", "PUT"), "trade"),
    ("/reports/archive", ("POST",), "trade"),
]


def required_scope_for(method: str, path: str) -> str:
    for prefix, methods, scope in SCOPE_RULES:
        if path.startswith(prefix) and ("*" in methods or method.upper() in methods):
            return scope
    return "read"


@dataclass
class ApiKey:
    key: str
    scopes: Set[str] = field(default_factory=lambda: {"read"})
    label: str = ""
    rate_per_minute: Optional[int] = None  # override default

    def has_scope(self, scope: str) -> bool:
        if "admin" in self.scopes:
            return True
        return scope in self.scopes


class ApiKeyRegistry:
    """Loads API keys from env.

    Two sources, merged in this order:

    * ``SIGNALCLAW_API_KEYS_JSON`` -- JSON list of
      ``{"key": "...", "scopes": ["read", "trade"], "label": "...",
      "rate_per_minute": 120}`` entries.
    * Legacy single ``SIGNALCLAW_API_KEY`` -- granted ``read`` + ``trade``
      so existing setups keep their full access.
    """

    def __init__(self, json_env: str = "SIGNALCLAW_API_KEYS_JSON",
                 legacy_env: str = "SIGNALCLAW_API_KEY") -> None:
        self._json_env = json_env
        self._legacy_env = legacy_env
        self._lock = threading.Lock()
        self._keys: Dict[str, ApiKey] = {}
        self.reload()

    def reload(self) -> None:
        keys: Dict[str, ApiKey] = {}
        raw = os.environ.get(self._json_env, "").strip()
        if raw:
            try:
                items = json.loads(raw)
                for it in items:
                    k = ApiKey(
                        key=str(it["key"]),
                        scopes=set(it.get("scopes", ["read"])),
                        label=str(it.get("label", "")),
                        rate_per_minute=it.get("rate_per_minute"),
                    )
                    keys[k.key] = k
            except (json.JSONDecodeError, KeyError, TypeError):
                pass
        legacy = os.environ.get(self._legacy_env, "").strip()
        if legacy and legacy not in keys:
            # legacy single key gets full read+trade, no rate override
            keys[legacy] = ApiKey(key=legacy, scopes={"read", "trade"},
                                  label="legacy")
        # always allow built-in dev key when nothing is configured
        if not keys:
            keys["dev-key"] = ApiKey(key="dev-key",
                                     scopes={"read", "trade", "admin"},
                                     label="dev-fallback")
        with self._lock:
            self._keys = keys

    def get(self, key: Optional[str]) -> Optional[ApiKey]:
        if not key:
            return None
        with self._lock:
            return self._keys.get(key)

    def all(self) -> List[ApiKey]:
        with self._lock:
            return list(self._keys.values())


# module-level registry (refresh by calling .reload() in tests)
_REGISTRY: Optional[ApiKeyRegistry] = None


def get_registry() -> ApiKeyRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = ApiKeyRegistry()
    return _REGISTRY


def reset_registry() -> None:
    global _REGISTRY
    _REGISTRY = None


def require_scope(scope: str) -> Callable:
    """FastAPI dependency factory enforcing a scope on a route."""
    def _dep(x_api_key: str | None = Header(default=None)) -> None:
        rec = get_registry().get(x_api_key)
        if rec is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                detail="invalid api key")
        if not rec.has_scope(scope):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"missing scope: {scope}")
    return _dep


# --- token bucket --------------------------------------------------------

@dataclass
class TokenBucket:
    capacity: float
    refill_per_sec: float
    tokens: float = 0.0
    last: float = field(default_factory=time.monotonic)

    def take(self, n: float = 1.0) -> tuple[bool, float]:
        """Try to take n tokens. Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        elapsed = now - self.last
        self.last = now
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_per_sec)
        if self.tokens >= n:
            self.tokens -= n
            return True, 0.0
        needed = n - self.tokens
        wait = needed / self.refill_per_sec if self.refill_per_sec > 0 else 60.0
        return False, max(1.0, wait)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Per-key + per-route-class token bucket.

    Buckets are keyed by ``(api_key_or_anon, route_class)`` where
    ``route_class`` is ``"write"`` for mutating methods and ``"read"``
    otherwise. Unauthenticated requests share an ``anon`` key.
    """

    def __init__(self, app, default_per_minute: int = 120,
                 write_per_minute: int = 30,
                 exempt_paths: Iterable[str] = ("/health", "/disclaimer", "/docs",
                                                 "/openapi.json", "/redoc",
                                                 "/docs/oauth2-redirect")):
        super().__init__(app)
        self.default = default_per_minute
        self.write = write_per_minute
        self.exempt = tuple(exempt_paths)
        self._lock = threading.Lock()
        self._buckets: Dict[tuple[str, str], TokenBucket] = {}

    def _bucket(self, key: str, kind: str, per_minute: int) -> TokenBucket:
        bkey = (key, kind)
        with self._lock:
            b = self._buckets.get(bkey)
            if b is None or b.capacity != per_minute:
                b = TokenBucket(capacity=float(per_minute),
                                refill_per_sec=per_minute / 60.0,
                                tokens=float(per_minute))
                self._buckets[bkey] = b
            return b

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in self.exempt):
            return await call_next(request)
        api_key = request.headers.get("x-api-key") or "anon"
        rec = get_registry().get(api_key)
        write = request.method.upper() in ("POST", "PUT", "PATCH", "DELETE")
        kind = "write" if write else "read"
        cap = (rec.rate_per_minute if rec and rec.rate_per_minute else
               (self.write if write else self.default))
        bucket = self._bucket(api_key, kind, cap)
        allowed, retry = bucket.take(1.0)
        if not allowed:
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(int(retry))},
                content={"detail": "rate limit exceeded",
                         "retry_after_seconds": int(retry)},
            )
        return await call_next(request)
