from __future__ import annotations
from fastapi import Header, HTTPException, status
from ..config import get_settings
from .rate_limit import get_registry


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    # Try the multi-key registry first; fall back to legacy single-key
    # check so existing single-key deployments keep working even when
    # the env hasn't propagated to the registry singleton.
    rec = get_registry().get(x_api_key)
    if rec is not None:
        return
    if x_api_key != get_settings().api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid api key")
