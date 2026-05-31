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


# Optional secondary store of user-managed keys (injected by app factory).
# Kept loose to avoid a circular import on the api_keys package.
_USER_STORE = None


def set_user_key_store(store) -> None:
    global _USER_STORE
    _USER_STORE = store


def _resolve_key(api_key):
    rec = get_registry().get(api_key)
    if rec is not None:
        return rec
    store = _USER_STORE
    if store is not None and api_key:
        stored = store.lookup(api_key)
        if stored is not None:
            # RBAC: the role caps what the key can do. Intersect the
            # stored scope list with the role's allowed set so an older
            # row that lists more than its role permits cannot keep its
            # old privileges after a downgrade. Falls back to the raw
            # scopes if the api_keys helper is unavailable for any
            # reason (defensive: never break auth on bookkeeping).
            try:
                from ..api_keys import cap_scopes_to_role  # local import
                effective = set(cap_scopes_to_role(
                    stored.scopes, getattr(stored, "role", None)))
            except Exception:
                effective = set(stored.scopes)
            return ApiKey(key=api_key, scopes=effective,
                          label=stored.label)
    return None


class ScopeEnforcementMiddleware(BaseHTTPMiddleware):
    """Enforce SCOPE_RULES on every request, not just decorated routes.

    The route decorations only cover a handful of admin endpoints. This
    middleware walks SCOPE_RULES for every request so that a read-only
    API key cannot POST/DELETE against mutating routes even when the
    route author forgot to add a per-route scope dependency.

    Requests without an ``x-api-key`` (or with an unknown key) are left
    alone here so the existing per-route ``require_api_key`` dependency
    can return the standard 401. That keeps authentication errors
    consistent and avoids double-checking inside the middleware stack.
    Exempt paths (health, docs, metrics) are skipped entirely.
    """

    def __init__(self, app, exempt_paths: Iterable[str] = (
        "/health", "/ready", "/metrics", "/disclaimer",
        "/docs", "/openapi.json", "/redoc", "/docs/oauth2-redirect",
    )) -> None:
        super().__init__(app)
        self.exempt = tuple(exempt_paths)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self.exempt):
            return await call_next(request)
        required = required_scope_for(request.method, path)
        if required == "read":
            return await call_next(request)
        api_key = request.headers.get("x-api-key")
        rec = _resolve_key(api_key)
        if rec is None:
            # Defer to the per-route 401 from require_api_key. For
            # routes that lack that dependency (admin-only ones), still
            # fail closed here.
            return JSONResponse(status_code=401,
                                content={"detail": "invalid api key"})
        if not rec.has_scope(required):
            return JSONResponse(
                status_code=403,
                content={"detail": f"missing scope: {required}",
                         "required_scope": required,
                         "method": request.method,
                         "path": path},
            )
        return await call_next(request)


def require_scope(scope: str) -> Callable:
    """FastAPI dependency factory enforcing a scope on a route."""
    def _dep(x_api_key: str | None = Header(default=None)) -> None:
        rec = _resolve_key(x_api_key)
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


def client_ip_from_request(
    request: Request,
    trusted_proxies: Iterable[str] = (),
    trust_forwarded: bool = False,
) -> str:
    """Resolve the real client IP for rate limiting.

    By default we use the immediate peer address from ``request.client``
    so a malicious caller cannot spoof ``X-Forwarded-For`` to dodge
    per-IP buckets. When ``trust_forwarded`` is true and the peer is in
    ``trusted_proxies`` (or the list is empty meaning "trust the proxy
    that already terminated TLS in front of us"), the leftmost entry of
    ``X-Forwarded-For`` wins, matching the convention used by nginx,
    Envoy, and most ingress controllers.
    """
    peer = request.client.host if request.client else ""
    if not trust_forwarded:
        return peer or "unknown"
    trusted = tuple(trusted_proxies)
    if trusted and peer not in trusted:
        return peer or "unknown"
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real
    return peer or "unknown"


class PerIPRateLimitMiddleware(BaseHTTPMiddleware):
    """DoS-style per-source-IP token bucket.

    Sits in front of the per-key limiter so that a flood of anonymous
    or auth-failing requests from a single source cannot exhaust the
    shared ``anon`` bucket or burn CPU on auth checks. Buckets are
    keyed by client IP only (route class is not split) because the
    intent here is coarse abuse control, not per-route shaping.

    Tunables:

    * ``per_minute`` -- bucket capacity and refill rate (req / min / ip)
    * ``trust_forwarded`` -- when true, parse ``X-Forwarded-For`` so the
      bucket keys off the real client behind a reverse proxy. Off by
      default so a direct attacker cannot spoof the header.
    * ``trusted_proxies`` -- optional allowlist of peer IPs whose
      ``X-Forwarded-For`` will be honoured. Empty + ``trust_forwarded``
      true means "any peer" (use only when the API is never reachable
      except through a known L7 proxy).
    """

    def __init__(self, app, per_minute: int = 600,
                 trust_forwarded: bool = False,
                 trusted_proxies: Iterable[str] = (),
                 exempt_paths: Iterable[str] = (
                     "/health", "/ready", "/metrics", "/disclaimer",
                     "/docs", "/openapi.json", "/redoc",
                     "/docs/oauth2-redirect",
                 )) -> None:
        super().__init__(app)
        self.per_minute = max(1, int(per_minute))
        self.trust_forwarded = bool(trust_forwarded)
        self.trusted_proxies = tuple(trusted_proxies)
        self.exempt = tuple(exempt_paths)
        self._lock = threading.Lock()
        self._buckets: Dict[str, TokenBucket] = {}

    def _bucket(self, ip: str) -> TokenBucket:
        with self._lock:
            b = self._buckets.get(ip)
            if b is None:
                b = TokenBucket(
                    capacity=float(self.per_minute),
                    refill_per_sec=self.per_minute / 60.0,
                    tokens=float(self.per_minute),
                )
                self._buckets[ip] = b
            return b

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self.exempt):
            return await call_next(request)
        ip = client_ip_from_request(
            request,
            trusted_proxies=self.trusted_proxies,
            trust_forwarded=self.trust_forwarded,
        )
        bucket = self._bucket(ip)
        allowed, retry = bucket.take(1.0)
        if not allowed:
            return JSONResponse(
                status_code=429,
                headers={
                    "Retry-After": str(int(retry)),
                    "X-RateLimit-Scope": "per-ip",
                },
                content={"detail": "per-ip rate limit exceeded",
                         "retry_after_seconds": int(retry),
                         "scope": "per-ip"},
            )
        return await call_next(request)


class IPAllowlistMiddleware(BaseHTTPMiddleware):
    """Enforce per-key IP allowlists for user-managed API keys.

    For requests carrying an ``x-api-key`` that resolves to a user-
    managed key with a non-empty ``ip_allowlist``, the client IP must
    match one of the listed CIDR blocks or the request is rejected
    with 403. Env-configured registry keys and unauthenticated traffic
    are unaffected so existing deployments keep working unchanged.

    Mirrors the proxy-trust knobs of the rate-limit middlewares so
    operators get one consistent answer for "what is the client IP?".
    """

    def __init__(self, app,
                 trust_forwarded: bool = False,
                 trusted_proxies: Iterable[str] = (),
                 exempt_paths: Iterable[str] = (
                     "/health", "/ready", "/metrics", "/disclaimer",
                     "/docs", "/openapi.json", "/redoc",
                     "/docs/oauth2-redirect",
                 )) -> None:
        super().__init__(app)
        self.trust_forwarded = bool(trust_forwarded)
        self.trusted_proxies = tuple(trusted_proxies)
        self.exempt = tuple(exempt_paths)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self.exempt):
            return await call_next(request)
        api_key = request.headers.get("x-api-key")
        store = _USER_STORE
        if not api_key or store is None:
            return await call_next(request)
        stored = store.lookup(api_key)
        if stored is None or not stored.ip_allowlist:
            return await call_next(request)
        from ..api_keys import is_ip_allowed  # local import to avoid cycle at module load
        ip = client_ip_from_request(
            request,
            trusted_proxies=self.trusted_proxies,
            trust_forwarded=self.trust_forwarded,
        )
        if not is_ip_allowed(stored, ip):
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "client IP not in key allowlist",
                    "client_ip": ip,
                    "key_id": stored.id,
                    "allowlist": list(stored.ip_allowlist),
                },
            )
        return await call_next(request)


class GlobalIPAllowlistMiddleware(BaseHTTPMiddleware):
    """Workspace-level (global) IP allowlist gate.

    Unlike :class:`IPAllowlistMiddleware`, which only enforces per-key
    allowlists when a user-managed API key is presented, this middleware
    is a coarse network policy applied to every request, authenticated
    or not. Enterprise procurement reviews routinely demand the ability
    to restrict the API+dashboard to a known set of office/VPN CIDRs;
    this is that knob.

    Behaviour:

    * When the policy is disabled (default) every request passes.
    * When enabled, the resolved client IP must match at least one CIDR
      in the workspace policy or the request is rejected with 403.
    * Healthcheck and metrics paths are exempt so monitoring continues
      to work from the cluster's own subnet even if it is not on the
      allowlist.
    * Loopback (``127.0.0.1``/``::1``) is always allowed so an operator
      who SSHes into the host and curls locally cannot be locked out.
    """

    def __init__(self, app, store,
                 trust_forwarded: bool = False,
                 trusted_proxies: Iterable[str] = (),
                 exempt_paths: Iterable[str] = (
                     "/health", "/ready", "/healthz", "/readyz",
                     "/metrics", "/disclaimer",
                     "/docs", "/openapi.json", "/redoc",
                     "/docs/oauth2-redirect",
                 )) -> None:
        super().__init__(app)
        self.store = store
        self.trust_forwarded = bool(trust_forwarded)
        self.trusted_proxies = tuple(trusted_proxies)
        self.exempt = tuple(exempt_paths)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self.exempt):
            return await call_next(request)
        ip = client_ip_from_request(
            request,
            trusted_proxies=self.trusted_proxies,
            trust_forwarded=self.trust_forwarded,
        )
        # Loopback bypass: an operator on the box itself is implicitly
        # trusted; otherwise a misconfigured policy could lock everyone
        # out with no recovery path short of editing JSON on disk.
        if ip in ("127.0.0.1", "::1"):
            return await call_next(request)
        allowed, reason = self.store.check(ip)
        if not allowed:
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "client IP not in workspace allowlist",
                    "client_ip": ip,
                    "reason": reason,
                    "scope": "workspace",
                },
            )
        return await call_next(request)


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
