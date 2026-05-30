"""Request-id and correlation-id middleware.

Binds a stable per-request identifier into ``structlog`` contextvars so
every log line emitted during a request, from any module, automatically
carries ``request_id`` (and ``correlation_id`` when supplied by the
upstream caller). The same id is echoed back on the response as
``X-Request-Id`` and stashed on ``request.state.request_id`` for any
downstream middleware that needs it (notably :class:`AuditMiddleware`,
which previously minted its own id and missed the log correlation).

Design notes:

* The inbound ``X-Request-Id`` header is honoured when present so an
  ingress / API gateway can stitch a single id across multiple hops.
  Invalid or oversized values are rejected and a fresh id is minted
  instead, so a malicious caller cannot poison the log stream.
* ``X-Correlation-Id`` is a separate, optional caller-supplied id used
  for cross-system tracing (for example a job id from an upstream
  scheduler). It is bound when present but never minted.
* ``structlog.contextvars`` are cleared on entry and exit so a worker
  process serving the next request starts clean.
"""
from __future__ import annotations

import re
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


REQUEST_ID_HEADER = "x-request-id"
CORRELATION_ID_HEADER = "x-correlation-id"

# Conservative allowlist: hex, dash, underscore, up to 128 chars.
# Wide enough to accept UUIDs, ULIDs, and W3C trace ids, narrow enough
# to keep log shipping pipelines safe.
_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")


def _mint() -> str:
    return uuid.uuid4().hex[:16]


def _clean(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if not _ID_RE.match(value):
        return None
    return value


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Bind request_id / correlation_id into structlog contextvars."""

    async def dispatch(self, request: Request, call_next):
        rid = _clean(request.headers.get(REQUEST_ID_HEADER)) or _mint()
        cid = _clean(request.headers.get(CORRELATION_ID_HEADER))
        # Reset first so we never leak vars from a previous request that
        # ran on the same task in degenerate edge cases.
        structlog.contextvars.clear_contextvars()
        bind = {"request_id": rid}
        if cid:
            bind["correlation_id"] = cid
        structlog.contextvars.bind_contextvars(**bind)
        request.state.request_id = rid
        if cid:
            request.state.correlation_id = cid
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers[REQUEST_ID_HEADER] = rid
        if cid:
            response.headers[CORRELATION_ID_HEADER] = cid
        return response
