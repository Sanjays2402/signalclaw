"""Workspace-level CORS policy: explicit origin allowlist.

A FastAPI service that ships with ``allow_origins=["*"]`` is a hard
blocker in enterprise procurement reviews: combined with
``allow_credentials=True`` it would (browsers refuse the combination,
but auditors still flag it), and even without credentials it allows
any web page on the internet to call the API from a victim browser
under the user's network identity (DNS-rebind, internal-only deploys,
etc.). This module is the single source of truth for the dashboard
CORS policy and replaces the wide-open default.

Design
------

* JSON-backed under ``<data_dir>/cors_policy.json``. Thread-safe.
* ``enabled=False`` means CORS is **off** (no ``Access-Control-Allow-*``
  headers emitted, same-origin only). Flipping to ``True`` with an
  empty allowlist is rejected so an operator cannot accidentally fall
  back to a permissive default.
* Origins are validated: ``https://app.example.com`` style only. We
  refuse ``*``, ``null``, bare hostnames, paths, query strings, and
  fragments. ``http://`` is allowed only for loopback hosts so a
  developer can run the dashboard locally without weakening prod.
* The middleware mirrors the requested origin only when it is in the
  allowlist, sets a short ``Access-Control-Max-Age``, restricts methods
  to a sane CRUD set, and reflects the requested headers from
  ``Access-Control-Request-Headers`` constrained to a safe whitelist.
* Environment seed: ``SIGNALCLAW_CORS_ORIGINS`` (comma separated) is
  applied on first boot when no policy file exists. This lets ops
  bootstrap deployments without an extra API call.
"""
from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional, Tuple


MAX_ORIGINS = 64

# Headers the dashboard may send. Keep tight; expand on real need.
ALLOWED_REQUEST_HEADERS = (
    "authorization",
    "content-type",
    "x-api-key",
    "x-request-id",
    "x-correlation-id",
    "x-mfa-code",
    "x-dry-run",
)
ALLOWED_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
# Strict origin: scheme://host[:port], nothing else.
_ORIGIN_RE = re.compile(
    r"^(?P<scheme>https?)://(?P<host>[A-Za-z0-9._\-]+|\[[0-9A-Fa-f:]+\])(?::(?P<port>\d{1,5}))?$",
    re.IGNORECASE,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalise_origin(raw: str) -> str:
    """Validate and canonicalise a single Origin string.

    Raises ``ValueError`` on bad input. The returned value is lower
    cased on scheme + host so allowlist membership is case-insensitive
    in the same way browsers send origins.
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("empty origin")
    if s == "*" or s.lower() == "null":
        raise ValueError("wildcard or null origin is not allowed")
    m = _ORIGIN_RE.match(s)
    if not m:
        raise ValueError(f"invalid origin: {raw!r}")
    scheme = m.group("scheme").lower()
    host = m.group("host").lower()
    port = m.group("port")
    if scheme == "http" and host not in _LOOPBACK_HOSTS:
        raise ValueError("http:// origins are restricted to loopback hosts")
    if port is not None:
        p = int(port)
        if not 1 <= p <= 65535:
            raise ValueError(f"invalid port: {port}")
        return f"{scheme}://{host}:{p}"
    return f"{scheme}://{host}"


def normalise_origins(origins: Iterable[str]) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    for raw in origins or []:
        canon = normalise_origin(raw)
        if canon in seen:
            continue
        seen.add(canon)
        out.append(canon)
    if len(out) > MAX_ORIGINS:
        raise ValueError(f"origins may contain at most {MAX_ORIGINS} entries")
    return out


@dataclass
class CorsPolicy:
    enabled: bool = False
    origins: List[str] = field(default_factory=list)
    allow_credentials: bool = False
    updated_at: str = field(default_factory=_now_iso)
    updated_by: Optional[str] = None

    def to_public(self) -> dict:
        d = asdict(self)
        d["max_origins"] = MAX_ORIGINS
        return d


class CorsPolicyStore:
    """Thread-safe, file-backed CORS policy store."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = threading.RLock()
        self._policy: Optional[CorsPolicy] = None

    # ---- persistence ------------------------------------------------
    def _load_unlocked(self) -> CorsPolicy:
        if self._policy is not None:
            return self._policy
        try:
            raw = self._path.read_text(encoding="utf-8")
            j = json.loads(raw)
            self._policy = CorsPolicy(
                enabled=bool(j.get("enabled", False)),
                origins=normalise_origins(j.get("origins", []) or []),
                allow_credentials=bool(j.get("allow_credentials", False)),
                updated_at=str(j.get("updated_at") or _now_iso()),
                updated_by=(j.get("updated_by") or None),
            )
        except FileNotFoundError:
            self._policy = self._seed_from_env()
        except (ValueError, OSError, json.JSONDecodeError):
            # Fail closed: corrupt file means no cross-origin access.
            self._policy = CorsPolicy()
        return self._policy

    def _seed_from_env(self) -> CorsPolicy:
        env = os.environ.get("SIGNALCLAW_CORS_ORIGINS", "").strip()
        if not env:
            return CorsPolicy()
        try:
            origins = normalise_origins(p for p in env.split(",") if p.strip())
        except ValueError:
            return CorsPolicy()
        return CorsPolicy(enabled=bool(origins), origins=origins)

    def _save_unlocked(self) -> None:
        assert self._policy is not None
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(asdict(self._policy), indent=2),
                       encoding="utf-8")
        tmp.replace(self._path)

    # ---- public API -------------------------------------------------
    def get(self) -> CorsPolicy:
        with self._lock:
            p = self._load_unlocked()
            # Return a defensive copy so callers cannot mutate the cache.
            return CorsPolicy(
                enabled=p.enabled,
                origins=list(p.origins),
                allow_credentials=p.allow_credentials,
                updated_at=p.updated_at,
                updated_by=p.updated_by,
            )

    def set_policy(
        self,
        *,
        enabled: Optional[bool] = None,
        origins: Optional[Iterable[str]] = None,
        allow_credentials: Optional[bool] = None,
        actor: Optional[str] = None,
    ) -> CorsPolicy:
        with self._lock:
            cur = self._load_unlocked()
            new_enabled = cur.enabled if enabled is None else bool(enabled)
            new_origins = (
                list(cur.origins) if origins is None
                else normalise_origins(origins)
            )
            new_creds = (
                cur.allow_credentials if allow_credentials is None
                else bool(allow_credentials)
            )
            if new_enabled and not new_origins:
                raise ValueError(
                    "cannot enable CORS with an empty origin allowlist"
                )
            self._policy = CorsPolicy(
                enabled=new_enabled,
                origins=new_origins,
                allow_credentials=new_creds,
                updated_at=_now_iso(),
                updated_by=actor,
            )
            self._save_unlocked()
            return self.get()

    def is_allowed(self, origin: str) -> bool:
        try:
            canon = normalise_origin(origin)
        except ValueError:
            return False
        p = self.get()
        if not p.enabled:
            return False
        return canon in p.origins

    def reset_for_tests(self) -> None:
        with self._lock:
            self._policy = None


_STORE: Optional[CorsPolicyStore] = None
_STORE_LOCK = threading.Lock()


def get_store(data_dir: Optional[Path] = None) -> CorsPolicyStore:
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            if data_dir is None:
                from ..config import get_settings
                data_dir = get_settings().data_dir
            _STORE = CorsPolicyStore(Path(data_dir) / "cors_policy.json")
        return _STORE


def reset_store_for_tests() -> None:
    global _STORE
    with _STORE_LOCK:
        _STORE = None


__all__ = [
    "ALLOWED_METHODS",
    "ALLOWED_REQUEST_HEADERS",
    "MAX_ORIGINS",
    "CorsPolicy",
    "CorsPolicyStore",
    "get_store",
    "normalise_origin",
    "normalise_origins",
    "reset_store_for_tests",
]
