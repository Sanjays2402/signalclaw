"""Per-tenant outbound webhook host allowlist.

Enterprise security teams routinely require that each tenant can
restrict the destinations its webhooks may fire to. The
``SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST`` env knob already covers a
single global allowlist for the whole deployment, but a SaaS buyer
expects to manage their own allowlist without an operator round trip
and without affecting another tenant's policy. This module is that
per-tenant store.

Properties:

* JSON backed under ``<data_dir>/webhook_host_allowlist.json``.
* Keyed by ``owner_key_id`` (the same identity webhooks already use
  for tenancy). The ``None`` key is the legacy operator default and
  treated as the global tenant.
* ``enabled=False`` means open (subject to the existing SSRF gate and
  the global env allowlist). Flipping to ``True`` with an empty host
  list is rejected so a tenant cannot accidentally lock themselves
  out of all webhook delivery.
* Hosts are lower-cased, validated as DNS-shaped or IP literals, and
  matched with the same ``host == a or host.endswith("." + a)`` rule
  the env allowlist uses so subdomain semantics stay consistent.
* ``check(owner_key_id, url)`` returns ``(allowed, reason)`` and is
  called from both subscribe-time validation and per-attempt
  delivery validation so a hostname that flips after subscribe is
  still refused.
"""
from __future__ import annotations

import ipaddress
import json
import re
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse


MAX_HOSTS = 64
_HOST_RE = re.compile(
    r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)"
    r"(\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?))*$"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tenant_key(owner_key_id: Optional[str]) -> str:
    return owner_key_id if owner_key_id else "__default__"


def normalise_host(raw: str) -> str:
    """Validate and canonicalise a host entry.

    Accepts a DNS hostname or an IP literal. Strips leading dots, lowers
    case, rejects URLs (with scheme/path) so the operator does not type
    ``https://example.com/path`` and get surprising matches.
    """
    s = (raw or "").strip().lower().rstrip(".")
    if not s:
        raise ValueError("empty host")
    if "://" in s or "/" in s or " " in s:
        raise ValueError("host must not contain scheme or path")
    # IP literal (v4 or v6 inside brackets).
    bare = s[1:-1] if s.startswith("[") and s.endswith("]") else s
    try:
        ipaddress.ip_address(bare)
        return bare
    except ValueError:
        pass
    if not _HOST_RE.match(s):
        raise ValueError(f"invalid host {raw!r}")
    return s


def host_matches(host: str, allow: Iterable[str]) -> bool:
    h = (host or "").strip().lower().rstrip(".")
    for a in allow:
        a = (a or "").strip().lower()
        if not a:
            continue
        if h == a or h.endswith("." + a):
            return True
    return False


@dataclass
class TenantHostPolicy:
    owner_key_id: Optional[str] = None
    enabled: bool = False
    hosts: List[str] = field(default_factory=list)
    updated_at: str = field(default_factory=_now_iso)
    updated_by: str = ""

    def to_public(self) -> dict:
        d = asdict(self)
        d["max_hosts"] = MAX_HOSTS
        return d


class WebhookHostAllowlistStore:
    """JSON-backed per-tenant outbound webhook host allowlist."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"tenants": {}}, indent=2))

    # --- io --------------------------------------------------------------
    def _read_all(self) -> Dict[str, dict]:
        try:
            raw = json.loads(self.path.read_text() or "{}")
        except Exception:
            raw = {}
        return dict(raw.get("tenants") or {})

    def _write_all(self, tenants: Dict[str, dict]) -> None:
        self.path.write_text(json.dumps({"tenants": tenants}, indent=2))

    # --- public API ------------------------------------------------------
    def get(self, owner_key_id: Optional[str]) -> TenantHostPolicy:
        with self._lock:
            tenants = self._read_all()
        raw = tenants.get(_tenant_key(owner_key_id)) or {}
        return TenantHostPolicy(
            owner_key_id=owner_key_id,
            enabled=bool(raw.get("enabled", False)),
            hosts=list(raw.get("hosts") or []),
            updated_at=str(raw.get("updated_at") or _now_iso()),
            updated_by=str(raw.get("updated_by") or ""),
        )

    def set(self, owner_key_id: Optional[str], *,
            enabled: bool, hosts: Iterable[str],
            actor: str = "") -> TenantHostPolicy:
        normalised: List[str] = []
        for h in hosts or []:
            normalised.append(normalise_host(h))
        seen: set = set()
        deduped: List[str] = []
        for h in normalised:
            if h in seen:
                continue
            seen.add(h)
            deduped.append(h)
        if len(deduped) > MAX_HOSTS:
            raise ValueError(f"too many hosts (max {MAX_HOSTS})")
        if enabled and not deduped:
            raise ValueError(
                "refusing to enable allowlist with no hosts; add at "
                "least one host before enforcing")
        rec = {
            "enabled": bool(enabled),
            "hosts": deduped,
            "updated_at": _now_iso(),
            "updated_by": str(actor or ""),
        }
        with self._lock:
            tenants = self._read_all()
            tenants[_tenant_key(owner_key_id)] = rec
            self._write_all(tenants)
        return TenantHostPolicy(owner_key_id=owner_key_id, **rec)

    def check(self, owner_key_id: Optional[str],
              url: str) -> Tuple[bool, str]:
        """Return ``(allowed, reason)`` for a candidate URL under tenant policy.

        ``reason`` is a short stable string suitable for the 400 body or
        the delivery error column. Disabled policies short-circuit to
        allow so this gate composes additively with the SSRF gate.
        """
        pol = self.get(owner_key_id)
        if not pol.enabled:
            return True, "tenant_policy_disabled"
        if not isinstance(url, str) or not url:
            return False, "url required"
        try:
            u = urlparse(url)
        except ValueError as e:
            return False, f"invalid url: {e}"
        host = (u.hostname or "").strip().lower().rstrip(".")
        if not host:
            return False, "url missing host"
        if host_matches(host, pol.hosts):
            return True, "allow"
        return False, f"host {host!r} not in tenant webhook allowlist"


_STORE_SINGLETON: Optional[WebhookHostAllowlistStore] = None
_SINGLETON_LOCK = threading.Lock()


def get_store(path: Optional[Path] = None) -> WebhookHostAllowlistStore:
    global _STORE_SINGLETON
    with _SINGLETON_LOCK:
        if _STORE_SINGLETON is None:
            if path is None:
                raise RuntimeError(
                    "webhook host allowlist store not yet initialised")
            _STORE_SINGLETON = WebhookHostAllowlistStore(path)
        return _STORE_SINGLETON


def reset_store() -> None:
    global _STORE_SINGLETON
    with _SINGLETON_LOCK:
        _STORE_SINGLETON = None


__all__ = [
    "MAX_HOSTS",
    "TenantHostPolicy",
    "WebhookHostAllowlistStore",
    "normalise_host",
    "host_matches",
    "get_store",
    "reset_store",
]
