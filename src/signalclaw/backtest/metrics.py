from __future__ import annotations
import numpy as np
import pandas as pd


def sharpe(returns: pd.Series, rf: float = 0.0, periods: int = 252) -> float:
    r = returns.dropna() - rf / periods
    sd = r.std()
    if sd == 0 or len(r) < 2:
        return 0.0
    return float(np.sqrt(periods) * r.mean() / sd)


def sortino(returns: pd.Series, rf: float = 0.0, periods: int = 252) -> float:
    r = returns.dropna() - rf / periods
    downside = r[r < 0]
    sd = downside.std()
    if sd == 0 or len(r) < 2:
        return 0.0
    return float(np.sqrt(periods) * r.mean() / sd)


def max_drawdown(equity: pd.Series) -> float:
    if equity.empty:
        return 0.0
    peak = equity.cummax()
    dd = (equity - peak) / peak
    return float(dd.min())


def hit_rate(returns: pd.Series) -> float:
    r = returns.dropna()
    if r.empty:
        return 0.0
    return float((r > 0).mean())


def cagr(equity: pd.Series, periods: int = 252) -> float:
    if equity.empty or len(equity) < 2:
        return 0.0
    total = equity.iloc[-1] / equity.iloc[0]
    n = len(equity) / periods
    if n <= 0 or total <= 0:
        return 0.0
    return float(total ** (1 / n) - 1)
