from __future__ import annotations
import time
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from ..logging_ import get_logger

log = get_logger("api.access")


class AccessLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        t0 = time.perf_counter()
        resp = await call_next(request)
        dt_ms = (time.perf_counter() - t0) * 1000
        log.info("http.access", method=request.method, path=request.url.path,
                 status=resp.status_code, dt_ms=round(dt_ms, 2))
        return resp
