"""Outbound webhook destination guard.

Enterprise security teams reject any product that lets users register
arbitrary outbound URLs without server-side validation. The classic
risk is server-side request forgery (SSRF): a user-controlled webhook
URL pointing at ``http://127.0.0.1``, ``http://169.254.169.254``
(cloud metadata), or an internal hostname that resolves to RFC1918
space, turning the webhook delivery worker into an internal port
scanner or a credential exfiltrator.

This module implements two gates that the webhooks subsystem calls:

* :func:`validate_destination_or_raise` is called at subscribe time
  from ``POST /webhooks``. It refuses obviously bad URLs and any
  destination that resolves to a non-public IP, before the row is
  persisted.
* :func:`assert_destination_safe` is called at delivery time from
  :func:`_default_http` for every attempt (including retries and
  byte-for-byte replays). DNS results are not cached: a hostname
  whose A record changes to point at internal space between subscribe
  and delivery is still refused.

Both gates honor an optional operator-managed host allowlist, sourced
from ``SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST`` (comma-separated host
strings, matched case-insensitively against the URL host). When the
allowlist is set, ONLY listed hosts are allowed; when unset, any
public host is allowed. Set ``SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE=1``
to bypass the IP gate in dev / loopback fixtures.
"""
from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass
from typing import Iterable, Optional, Tuple
from urllib.parse import urlparse


_ENV_ALLOWLIST = "SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST"
_ENV_ALLOW_PRIVATE = "SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE"


@dataclass(frozen=True)
class DestinationPolicy:
    """Resolved policy snapshot.

    Captured once per call so the same policy applies to every retry
    inside a delivery attempt, even if the environment changes
    underneath a running process.
    """
    allow_private: bool
    host_allowlist: Tuple[str, ...]

    @classmethod
    def from_env(cls) -> "DestinationPolicy":
        raw = os.environ.get(_ENV_ALLOWLIST, "") or ""
        hosts = tuple(h.strip().lower() for h in raw.split(",") if h.strip())
        ap = (os.environ.get(_ENV_ALLOW_PRIVATE, "") or "").strip().lower()
        return cls(
            allow_private=ap in ("1", "true", "yes", "on"),
            host_allowlist=hosts,
        )


def _host_in_allowlist(host: str, allowlist: Iterable[str]) -> bool:
    h = (host or "").strip().lower()
    return any(h == a or h.endswith("." + a) for a in allowlist)


def _ip_is_public(ip_str: str) -> bool:
    """Return True iff ``ip_str`` is a routable public unicast address.

    Refuses loopback (127/8, ::1), link-local (169.254/16, fe80::/10),
    private (10/8, 172.16/12, 192.168/16, fc00::/7), multicast,
    unspecified (0.0.0.0, ::), and reserved ranges.
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_link_local or ip.is_private:
        return False
    if ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return False
    return True


def _resolve_all(host: str) -> Tuple[str, ...]:
    """Return every A/AAAA the resolver gives us for ``host``.

    All resolved addresses must be public; otherwise an attacker can
    register a hostname with two A records (one public, one internal)
    and the resolver might still hand us the internal one.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return ()
    return tuple({i[4][0] for i in infos if i and i[4]})


def validate_destination(
    url: str, policy: Optional[DestinationPolicy] = None,
) -> Tuple[bool, str]:
    """Return ``(ok, reason)``. ``reason`` is empty on success."""
    pol = policy or DestinationPolicy.from_env()
    if not isinstance(url, str) or not url:
        return False, "url required"
    try:
        u = urlparse(url)
    except ValueError as e:
        return False, f"invalid url: {e}"
    if u.scheme not in ("http", "https"):
        return False, "url must be http(s)"
    if u.username or u.password:
        return False, "url must not contain credentials"
    host = (u.hostname or "").strip()
    if not host:
        return False, "url missing host"
    if pol.host_allowlist and not _host_in_allowlist(host, pol.host_allowlist):
        return False, f"host {host!r} not in webhook allowlist"
    if pol.allow_private:
        return True, ""
    # Literal IP in URL: check directly.
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if not _ip_is_public(str(ip)):
            return False, f"refusing webhook to non-public ip {ip}"
        return True, ""
    # Hostname: resolve and check every answer.
    addrs = _resolve_all(host)
    if not addrs:
        return False, f"could not resolve webhook host {host!r}"
    for a in addrs:
        if not _ip_is_public(a):
            return False, (f"refusing webhook to {host!r}: "
                           f"resolves to non-public address {a}")
    return True, ""


def validate_destination_or_raise(
    url: str, policy: Optional[DestinationPolicy] = None,
) -> None:
    """Subscribe-time gate. Raises ``ValueError`` on rejection."""
    ok, reason = validate_destination(url, policy)
    if not ok:
        raise ValueError(reason)


def assert_destination_safe(
    url: str, policy: Optional[DestinationPolicy] = None,
) -> None:
    """Delivery-time gate. Raises ``ValueError`` on rejection.

    Called per-attempt so a hostname whose DNS flips to internal
    space after subscribe is still blocked at delivery.
    """
    ok, reason = validate_destination(url, policy)
    if not ok:
        raise ValueError(reason)
