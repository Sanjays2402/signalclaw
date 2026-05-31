"""Sandbox / dry-run mode for destructive API endpoints.

Enterprise buyers ask: "Can my automation safely probe your API
in production without writing any state?" This middleware answers
yes. Any mutating request (POST/PUT/PATCH/DELETE) that carries
``?dry_run=true`` (or the ``X-Dry-Run: 1`` header) is short-circuited
with a structured 202 Accepted response describing what *would*
have happened, without invoking the route handler. No stores are
touched. No webhooks fire. No notifications are sent.

The audit log still records the call (with ``dry_run=true`` in
extra), so compliance teams can prove that probe traffic was
authenticated and authorised. Rate limits, scopes, IP allowlists,
and MFA gates all run normally because they sit OUTSIDE this
middleware in the chain. That is the point: a buyer can validate
that their key has the right scope to delete a record without
deleting one.

Read-only methods (GET, HEAD, OPTIONS) are passed through
unchanged so dashboards work.
"""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


_DRY_VALUES = {"1", "true", "yes", "on"}
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def _wants_dry_run(request: Request) -> bool:
    qv = request.query_params.get("dry_run")
    if qv is not None and qv.lower() in _DRY_VALUES:
        return True
    hv = request.headers.get("x-dry-run")
    if hv is not None and hv.lower() in _DRY_VALUES:
        return True
    return False


class DryRunMiddleware(BaseHTTPMiddleware):
    """Short-circuit mutating requests when dry-run is requested.

    Added to the FastAPI app *before* the audit middleware in source
    order, which means audit wraps it: a dry-run request still
    produces a normal audit row with status 202 and the ``dry_run``
    flag in extras.
    """

    async def dispatch(self, request: Request, call_next):
        method = request.method.upper()
        if method not in _MUTATING or not _wants_dry_run(request):
            return await call_next(request)

        # Stash on request.state so the audit middleware can flag the
        # event without parsing query params itself.
        request.state.dry_run = True

        body_preview = {}
        try:
            raw = await request.body()
            if raw:
                # Cap preview so we never log secrets in bulk.
                body_preview = {
                    "bytes": len(raw),
                    "truncated": len(raw) > 256,
                }
        except Exception:
            body_preview = {}

        payload = {
            "dry_run": True,
            "would_execute": {
                "method": method,
                "path": request.url.path,
                "query": dict(request.query_params),
            },
            "body": body_preview,
            "note": (
                "Sandbox mode: no state changed. Remove dry_run=true "
                "to apply this request."
            ),
        }
        headers = {
            "X-Dry-Run": "true",
            "Cache-Control": "no-store",
        }
        return JSONResponse(payload, status_code=202, headers=headers)
