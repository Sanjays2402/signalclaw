"""HTTP security headers middleware.

Procurement / pentest checklists (SOC2, ISO 27001, OWASP ASVS L2) all
ask for the same short list of response headers on every HTTP response:

* ``Strict-Transport-Security`` -- force HTTPS on subsequent visits.
* ``X-Content-Type-Options: nosniff`` -- block MIME confusion.
* ``X-Frame-Options: DENY`` -- defence-in-depth against clickjacking
  on top of the CSP ``frame-ancestors`` directive.
* ``Referrer-Policy: no-referrer`` -- never leak the full URL (which
  may carry a workspace id or request id) to third parties.
* ``Permissions-Policy`` -- explicitly deny powerful browser APIs the
  JSON API will never use (camera, microphone, geolocation, etc.).
* ``Content-Security-Policy`` -- for API responses, the strictest
  possible policy: nothing loads from anywhere. This is the right
  default for a JSON API since browsers should never render its
  responses as documents.
* ``Cross-Origin-Opener-Policy: same-origin`` and
  ``Cross-Origin-Resource-Policy: same-site`` -- contain Spectre-style
  cross-origin leaks.

Knobs (env, all optional):
* ``SIGNALCLAW_SECURITY_HEADERS_ENABLED`` -- ``0`` disables the
  middleware entirely. Default ``1``.
* ``SIGNALCLAW_HSTS_MAX_AGE`` -- HSTS lifetime in seconds. Default
  ``31536000`` (one year). Set ``0`` to suppress the HSTS header
  (useful on plain-HTTP staging deployments).
* ``SIGNALCLAW_HSTS_PRELOAD`` -- ``1`` adds ``; preload`` to HSTS so
  the domain qualifies for browser preload lists. Default ``0``.
* ``SIGNALCLAW_HSTS_INCLUDE_SUBDOMAINS`` -- ``1`` adds
  ``; includeSubDomains``. Default ``1``.
* ``SIGNALCLAW_CSP`` -- override the API CSP string. Default is the
  strict ``default-src 'none'; frame-ancestors 'none'`` policy.

The middleware is intentionally a pure header-writer. It never reads
the request body, never short-circuits a response, and never touches
authentication. That keeps it cheap (no measurable latency impact in
practice) and impossible to break by misconfiguration: the worst case
is a missing header, never a 5xx.
"""
from __future__ import annotations

import os
from typing import Dict, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        v = int(raw)
        return v if v >= 0 else default
    except ValueError:
        return default


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip() in ("1", "true", "yes", "on")


def build_header_policy() -> Dict[str, str]:
    """Resolve the final header set from environment overrides.

    Returned as a plain dict so the admin console can serve it as JSON
    for an at-a-glance view of what every response will carry.
    """
    headers: Dict[str, str] = {}

    hsts_age = _env_int("SIGNALCLAW_HSTS_MAX_AGE", 31_536_000)
    if hsts_age > 0:
        parts = [f"max-age={hsts_age}"]
        if _env_flag("SIGNALCLAW_HSTS_INCLUDE_SUBDOMAINS", True):
            parts.append("includeSubDomains")
        if _env_flag("SIGNALCLAW_HSTS_PRELOAD", False):
            parts.append("preload")
        headers["Strict-Transport-Security"] = "; ".join(parts)

    headers["X-Content-Type-Options"] = "nosniff"
    headers["X-Frame-Options"] = "DENY"
    headers["Referrer-Policy"] = "no-referrer"
    headers["Permissions-Policy"] = (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
        "magnetometer=(), microphone=(), payment=(), usb=()"
    )
    headers["Cross-Origin-Opener-Policy"] = "same-origin"
    headers["Cross-Origin-Resource-Policy"] = "same-site"

    csp_override = os.environ.get("SIGNALCLAW_CSP")
    headers["Content-Security-Policy"] = (
        csp_override
        if csp_override and csp_override.strip()
        else "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    )
    return headers


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Stamp a static set of security headers onto every response.

    Existing headers set by a downstream handler are preserved. This
    matters for endpoints that intentionally need a looser CSP (none
    today, but the contract is honoured for future expansion).
    """

    def __init__(self, app, policy: Optional[Dict[str, str]] = None) -> None:
        super().__init__(app)
        self._policy = policy if policy is not None else build_header_policy()

    @property
    def policy(self) -> Dict[str, str]:
        return dict(self._policy)

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        for name, value in self._policy.items():
            # Do not clobber a header the handler explicitly set, e.g. a
            # future endpoint that needs a looser CSP for an embedded
            # viewer. The default API surface never sets these so in
            # practice the middleware always wins.
            response.headers.setdefault(name, value)
        return response
