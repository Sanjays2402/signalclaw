"""Workspace-level network policy: global IP allowlist gate.

Enterprise security teams routinely require that an API+dashboard can be
restricted to a known set of CIDRs (office egress, VPN, bastion). This
module is the single source of truth for that workspace-wide policy and
is enforced by ``GlobalIPAllowlistMiddleware`` ahead of authentication
so non-allowlisted callers are dropped before any handler runs.

Key properties:

* JSON-backed under ``<data_dir>/network_policy.json``. Thread-safe.
* ``enabled=False`` means open access (legacy default). Flipping to
  ``True`` with an empty CIDR list is rejected so an operator cannot
  accidentally lock themselves out.
* CIDRs are validated with the stdlib ``ipaddress`` module. Bare IPs
  are accepted and treated as ``/32`` (v4) or ``/128`` (v6).
* ``check(ip)`` returns ``(allowed, reason)`` with a short reason
  string suitable for the 403 body and audit log. Open mode short
  circuits to ``(True, "policy_disabled")``.
* Bypass loopback for healthchecks is handled at the middleware exempt
  list, not here, so this module stays pure.
"""
from __future__ import annotations

import ipaddress
import json
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional, Tuple


MAX_CIDRS = 128


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalise_cidr(raw: str) -> str:
    """Validate and canonicalise a CIDR or bare IP.

    Raises ``ValueError`` on bad input. Bare IPs become host networks so
    downstream membership checks are uniform.
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("empty CIDR")
    if "/" not in s:
        # Bare IP. ip_address validates v4/v6, then we promote to /32 or /128.
        addr = ipaddress.ip_address(s)
        s = f"{addr}/{addr.max_prefixlen}"
    net = ipaddress.ip_network(s, strict=False)
    return str(net)


@dataclass
class NetworkPolicy:
    enabled: bool = False
    cidrs: List[str] = field(default_factory=list)
    updated_at: str = field(default_factory=_now_iso)
    updated_by: str = ""

    def to_public(self) -> dict:
        return asdict(self)


class NetworkPolicyStore:
    """JSON-backed workspace network policy."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self._write(NetworkPolicy())

    # --- io --------------------------------------------------------------
    def _read(self) -> NetworkPolicy:
        try:
            raw = json.loads(self.path.read_text() or "{}")
        except Exception:
            raw = {}
        return NetworkPolicy(
            enabled=bool(raw.get("enabled", False)),
            cidrs=list(raw.get("cidrs", []) or []),
            updated_at=str(raw.get("updated_at") or _now_iso()),
            updated_by=str(raw.get("updated_by") or ""),
        )

    def _write(self, p: NetworkPolicy) -> None:
        self.path.write_text(json.dumps(asdict(p), indent=2))

    # --- public API ------------------------------------------------------
    def get(self) -> NetworkPolicy:
        with self._lock:
            return self._read()

    def set(self, *, enabled: bool, cidrs: Iterable[str],
            actor: str = "") -> NetworkPolicy:
        """Replace the policy atomically.

        * Validates and canonicalises every CIDR.
        * Rejects ``enabled=True`` with an empty list to avoid lockout.
        * Caps total CIDRs at ``MAX_CIDRS``.
        """
        normalised: List[str] = []
        for c in cidrs or []:
            normalised.append(normalise_cidr(c))
        # dedupe preserving order
        seen = set()
        deduped: List[str] = []
        for c in normalised:
            if c in seen:
                continue
            seen.add(c)
            deduped.append(c)
        if len(deduped) > MAX_CIDRS:
            raise ValueError(f"too many CIDRs (max {MAX_CIDRS})")
        if enabled and not deduped:
            raise ValueError(
                "refusing to enable policy with empty CIDR list; "
                "add at least one CIDR first to avoid lockout")
        p = NetworkPolicy(
            enabled=bool(enabled),
            cidrs=deduped,
            updated_at=_now_iso(),
            updated_by=str(actor or ""),
        )
        with self._lock:
            self._write(p)
        return p

    def check(self, client_ip: str) -> Tuple[bool, str]:
        """Return ``(allowed, reason)`` for a candidate client IP."""
        p = self.get()
        if not p.enabled:
            return True, "policy_disabled"
        try:
            ip = ipaddress.ip_address((client_ip or "").strip())
        except Exception:
            return False, "client_ip_unparseable"
        for c in p.cidrs:
            try:
                if ip in ipaddress.ip_network(c, strict=False):
                    return True, "allow"
            except Exception:
                # A bad row should not silently allow traffic; skip and
                # keep evaluating remaining entries.
                continue
        return False, "not_in_allowlist"


_STORE_SINGLETON: Optional[NetworkPolicyStore] = None
_SINGLETON_LOCK = threading.Lock()


def get_store(path: Optional[Path] = None) -> NetworkPolicyStore:
    """Process-wide policy store. ``path`` is required on first call."""
    global _STORE_SINGLETON
    with _SINGLETON_LOCK:
        if _STORE_SINGLETON is None:
            if path is None:
                raise RuntimeError("network policy store not yet initialised")
            _STORE_SINGLETON = NetworkPolicyStore(path)
        return _STORE_SINGLETON


def reset_store() -> None:
    """Test helper: drop the singleton so the next ``get_store`` rebuilds."""
    global _STORE_SINGLETON
    with _SINGLETON_LOCK:
        _STORE_SINGLETON = None


__all__ = [
    "MAX_CIDRS",
    "NetworkPolicy",
    "NetworkPolicyStore",
    "normalise_cidr",
    "get_store",
    "reset_store",
]
