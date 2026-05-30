from __future__ import annotations
import numpy as np
import pandas as pd

from signalclaw.portfolio.attribution import attribution


def _series(returns: np.ndarray, start: float = 100.0, freq: str = "B") -> pd.Series:
    prices = start * np.exp(np.cumsum(returns))
    idx = pd.date_range("2024-01-01", periods=len(prices), freq=freq)
    return pd.Series(prices, index=idx)


def test_attribution_basic_alpha_beta():
    rng = np.random.default_rng(0)
    bench_r = rng.normal(0.0005, 0.01, 200)
    # Portfolio with two names: A correlated with bench (beta~1.2),
    # B uncorrelated with extra drift
    a_r = 1.2 * bench_r + rng.normal(0, 0.003, 200)
    b_r = rng.normal(0.001, 0.012, 200)
    bench = _series(bench_r)
    a = _series(a_r)
    b = _series(b_r)
    rep = attribution({"A": 0.5, "B": 0.5},
                       {"A": a, "B": b}, bench, window=120)
    assert rep is not None
    # Mixed portfolio: weighted beta should be ~0.6 (half of 1.2)
    assert 0.3 < rep.beta < 0.95
    assert -0.05 < rep.alpha_daily < 0.05
    assert 0.0 <= rep.r_squared <= 1.0
    # Contributions exist for both tickers and roughly sum to portfolio return
    assert len(rep.contributions) == 2
    total = sum(c.contribution for c in rep.contributions)
    # geometric vs arithmetic difference is small over short horizons
    assert abs(total - rep.portfolio_return) < 0.02


def test_attribution_insufficient_history():
    rng = np.random.default_rng(1)
    bench = _series(rng.normal(0, 0.01, 30))
    a = _series(rng.normal(0, 0.01, 30))
    rep = attribution({"A": 1.0}, {"A": a}, bench, window=60)
    assert rep is None


def test_attribution_skips_zero_and_missing_tickers():
    rng = np.random.default_rng(2)
    bench = _series(rng.normal(0, 0.01, 300))
    a = _series(rng.normal(0, 0.01, 300))
    rep = attribution({"A": 1.0, "B": 0.0}, {"A": a}, bench, window=120)
    assert rep is not None
    assert {c.ticker for c in rep.contributions} == {"A"}
    assert rep.contributions[0].weight == 1.0


def test_attribution_tracking_error_nonnegative():
    rng = np.random.default_rng(3)
    bench_r = rng.normal(0, 0.01, 200)
    bench = _series(bench_r)
    a = _series(bench_r + rng.normal(0, 0.005, 200))
    rep = attribution({"A": 1.0}, {"A": a}, bench, window=150)
    assert rep is not None
    assert rep.tracking_error_annualized >= 0.0


def test_attribution_serializable():
    rng = np.random.default_rng(4)
    bench = _series(rng.normal(0, 0.01, 200))
    a = _series(rng.normal(0, 0.01, 200))
    rep = attribution({"A": 1.0}, {"A": a}, bench, window=100)
    d = rep.to_dict()
    assert "contributions" in d
    assert isinstance(d["contributions"], list)
    assert "alpha_annualized" in d
