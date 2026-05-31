from __future__ import annotations
from fastapi import Header, HTTPException, status
from ..config import get_settings
from .rate_limit import _resolve_key


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    rec = _resolve_key(x_api_key)
    if rec is not None:
        return
    if x_api_key != get_settings().api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid api key")
