from __future__ import annotations
import numpy as np
import pandas as pd


def make_labels(close: pd.Series, horizon: int = 5, watch_q: float = 0.66, skip_q: float = 0.33) -> pd.DataFrame:
    """Forward return labels. Class: 2=watch (top tercile), 0=skip (bottom), 1=hold."""
    fwd = close.shift(-horizon) / close - 1.0
    out = pd.DataFrame({"fwd_ret": fwd})
    out["label"] = 1
    qh = fwd.rolling(252, min_periods=60).quantile(watch_q)
    ql = fwd.rolling(252, min_periods=60).quantile(skip_q)
    out.loc[fwd >= qh, "label"] = 2
    out.loc[fwd <= ql, "label"] = 0
    return out
