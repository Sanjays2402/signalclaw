from __future__ import annotations
import numpy as np
import pandas as pd


def log_returns(close: pd.Series) -> pd.Series:
    return np.log(close / close.shift(1))


def simple_returns(close: pd.Series, periods: int = 1) -> pd.Series:
    return close.pct_change(periods)


def rolling_volatility(close: pd.Series, n: int = 20) -> pd.Series:
    return log_returns(close).rolling(n, min_periods=n).std() * np.sqrt(252)


def volatility_regime(vol: pd.Series, lookback: int = 252) -> pd.Series:
    """Return a categorical regime label per row: -1 low, 0 mid, 1 high."""
    q1 = vol.rolling(lookback, min_periods=lookback // 4).quantile(0.33)
    q2 = vol.rolling(lookback, min_periods=lookback // 4).quantile(0.66)
    out = pd.Series(0, index=vol.index)
    out[vol <= q1] = -1
    out[vol >= q2] = 1
    return out
