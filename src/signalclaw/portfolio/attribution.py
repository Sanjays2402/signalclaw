"""Performance attribution: portfolio vs benchmark.

Given a portfolio snapshot (per-position weights, unrealized P&L) and price
history for each ticker plus a benchmark, computes:

- portfolio daily return series (weighted)
- benchmark daily return series
- alpha (intercept) and beta (slope) from OLS regression
- per-ticker contribution to total return for the window
- tracking error (annualized stdev of return diff)
- information ratio (excess return / tracking error, annualized)

All numbers are descriptive, not predictive. No look-ahead.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional
import numpy as np
import pandas as pd


@dataclass
class TickerContribution:
    ticker: str
    weight: float
    period_return: float
    contribution: float  # weight * period_return

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class AttributionReport:
    window: int
    portfolio_return: float
    benchmark_return: float
    excess_return: float
    alpha_daily: float
    alpha_annualized: float
    beta: float
    tracking_error_annualized: float
    information_ratio: float
    r_squared: float
    contributions: List[TickerContribution] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["contributions"] = [c.to_dict() for c in self.contributions]
        return d


def _ols_alpha_beta(port_r: np.ndarray, bench_r: np.ndarray) -> tuple[float, float, float]:
    """Return (alpha, beta, r2). Inputs are aligned daily-return arrays."""
    if len(port_r) < 5 or len(bench_r) < 5:
        return 0.0, 0.0, 0.0
    x = bench_r
    y = port_r
    x_mean = x.mean()
    y_mean = y.mean()
    var_x = ((x - x_mean) ** 2).sum()
    if var_x <= 0:
        return float(y_mean), 0.0, 0.0
    cov_xy = ((x - x_mean) * (y - y_mean)).sum()
    beta = float(cov_xy / var_x)
    alpha = float(y_mean - beta * x_mean)
    resid = y - (alpha + beta * x)
    ss_res = float((resid ** 2).sum())
    ss_tot = float(((y - y_mean) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return alpha, beta, r2


def attribution(
    weights: Dict[str, float],
    closes: Dict[str, pd.Series],
    benchmark_close: pd.Series,
    window: int = 60,
) -> Optional[AttributionReport]:
    """Compute attribution over the trailing `window` business days.

    `weights` should sum to ~1; missing/zero-weight tickers are skipped.
    Returns None if there is insufficient overlapping history.
    """
    weights = {k.upper(): float(v) for k, v in weights.items() if v > 0}
    if not weights or benchmark_close is None or benchmark_close.empty:
        return None

    # Align: intersect indices across all tickers + benchmark, tail to window+1
    series = {t: s.dropna() for t, s in closes.items() if t.upper() in weights}
    if not series:
        return None
    common = benchmark_close.index
    for s in series.values():
        common = common.intersection(s.index)
    if len(common) < window + 1:
        return None
    common = common[-(window + 1):]
    bench = benchmark_close.loc[common]
    aligned = {t.upper(): s.loc[common] for t, s in series.items()}

    bench_r = bench.pct_change().dropna().to_numpy()
    per_ticker_r = {t: aligned[t].pct_change().dropna().to_numpy() for t in aligned}

    # Renormalize weights to the actual covered subset
    total_w = sum(weights[t] for t in aligned)
    if total_w <= 0:
        return None
    norm_w = {t: weights[t] / total_w for t in aligned}

    # Daily portfolio return = sum(w_i * r_i). Use fixed weights for the window.
    rmat = np.vstack([per_ticker_r[t] for t in aligned])  # (n_tickers, n_days)
    wvec = np.array([norm_w[t] for t in aligned])
    port_r = wvec @ rmat

    port_total = float(np.prod(1 + port_r) - 1)
    bench_total = float(np.prod(1 + bench_r) - 1)
    excess = port_total - bench_total

    alpha, beta, r2 = _ols_alpha_beta(port_r, bench_r)
    diff = port_r - bench_r
    te_daily = float(diff.std(ddof=1)) if len(diff) > 1 else 0.0
    te_ann = te_daily * float(np.sqrt(252))
    ir = float((excess / te_ann)) if te_ann > 0 else 0.0

    contribs: List[TickerContribution] = []
    for i, t in enumerate(aligned):
        per_total = float(np.prod(1 + rmat[i]) - 1)
        contribs.append(TickerContribution(
            ticker=t,
            weight=float(norm_w[t]),
            period_return=per_total,
            contribution=float(norm_w[t] * per_total),
        ))
    contribs.sort(key=lambda c: c.contribution, reverse=True)

    return AttributionReport(
        window=window,
        portfolio_return=port_total,
        benchmark_return=bench_total,
        excess_return=excess,
        alpha_daily=alpha,
        alpha_annualized=alpha * 252,
        beta=beta,
        tracking_error_annualized=te_ann,
        information_ratio=ir,
        r_squared=r2,
        contributions=contribs,
    )
