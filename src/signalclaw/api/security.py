from __future__ import annotations
from fastapi import Header, HTTPException, Request, status
from ..config import get_settings
from .rate_limit import _resolve_key


def require_api_key(
    request: Request,
    x_api_key: str | None = Header(default=None),
) -> None:
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")
    rec = _resolve_key(x_api_key, client_ip=ip, user_agent=ua)
    if rec is not None:
        return
    if x_api_key != get_settings().api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid api key")
