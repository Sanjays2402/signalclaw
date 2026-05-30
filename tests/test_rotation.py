"""Tests for sector rotation."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from signalclaw.rotation import sector_rotation, RotationReport


def _make_series(n: int, daily_drift: float, seed: int = 0) -> pd.Series:
    rng = np.random.default_rng(seed)
    rets = rng.normal(loc=daily_drift, scale=0.005, size=n)
    prices = 100 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2024-01-01", periods=n, freq="B")
    return pd.Series(prices, index=idx)


def test_overweight_underweight_split_with_clear_winners():
    n = 200
    # Build closes: SPY benchmark; Tech tickers strong drift, Energy weak.
    closes = {
        "SPY": _make_series(n, 0.0002, seed=1),
        "AAPL": _make_series(n, 0.0010, seed=2),   # tech, strong
        "MSFT": _make_series(n, 0.0009, seed=3),
        "NVDA": _make_series(n, 0.0012, seed=4),
        "XOM":  _make_series(n, -0.0005, seed=5),  # energy, weak
        "CVX":  _make_series(n, -0.0006, seed=6),
        "JPM":  _make_series(n, 0.0001, seed=7),   # financials, mid
        "BAC":  _make_series(n, 0.00005, seed=8),
    }
    rep = sector_rotation(closes, benchmark="SPY")
    assert isinstance(rep, RotationReport)
    sectors = {s.sector for s in rep.scores}
    assert "Technology" in sectors
    assert "Energy" in sectors
    assert "Technology" in rep.overweight
    # The technology composite should beat energy
    tech = next(s for s in rep.scores if s.sector == "Technology")
    energy = next(s for s in rep.scores if s.sector == "Energy")
    assert tech.composite > energy.composite
    assert tech.call == "overweight"


def test_skips_unknown_and_short_history():
    n = 200
    closes = {
        "SPY": _make_series(n, 0.0, seed=10),
        "AAPL": _make_series(n, 0.001, seed=11),
        "MSFT": _make_series(n, 0.001, seed=12),
        "XOM": _make_series(n, -0.001, seed=13),
        "CVX": _make_series(n, -0.001, seed=14),
        "ZZZ_UNKNOWN": _make_series(n, 0.0, seed=15),    # not in sector map
        "PLTR": _make_series(40, 0.001, seed=16),         # too short
    }
    rep = sector_rotation(closes)
    assert "ZZZ_UNKNOWN" in rep.skipped_unknown_sector
    assert "PLTR" in rep.skipped_short_history


def test_requires_benchmark_present():
    n = 200
    closes = {"AAPL": _make_series(n, 0.0, seed=20)}
    with pytest.raises(ValueError):
        sector_rotation(closes, benchmark="SPY")


def test_custom_sector_map_overrides():
    n = 200
    closes = {
        "SPY": _make_series(n, 0.0, seed=30),
        "AAPL": _make_series(n, 0.001, seed=31),
        "MSFT": _make_series(n, 0.001, seed=32),
        "XOM": _make_series(n, -0.001, seed=33),
        "CVX": _make_series(n, -0.001, seed=34),
    }
    # Reassign AAPL to Energy via override
    rep = sector_rotation(closes, sector_map={"AAPL": "Energy"})
    energy_score = next(s for s in rep.scores if s.sector == "Energy")
    assert "AAPL" in energy_score.members


def test_breadth_reflects_outperformers():
    n = 200
    closes = {
        "SPY": _make_series(n, 0.0, seed=40),
        "AAPL": _make_series(n, 0.0015, seed=41),
        "MSFT": _make_series(n, 0.0015, seed=42),
        "NVDA": _make_series(n, 0.0015, seed=43),
    }
    rep = sector_rotation(closes)
    tech = next(s for s in rep.scores if s.sector == "Technology")
    assert tech.breadth == pytest.approx(1.0)


def test_to_dict_serializable():
    n = 200
    closes = {
        "SPY": _make_series(n, 0.0, seed=50),
        "AAPL": _make_series(n, 0.001, seed=51),
        "MSFT": _make_series(n, 0.001, seed=52),
        "XOM": _make_series(n, -0.001, seed=53),
        "CVX": _make_series(n, -0.001, seed=54),
    }
    rep = sector_rotation(closes)
    d = rep.to_dict()
    assert "benchmark" in d and d["benchmark"] == "SPY"
    assert "scores" in d
    assert all("composite" in s for s in d["scores"])
    import json
    json.dumps(d)  # must be JSON-serializable


def test_bad_lookbacks_raise():
    n = 200
    closes = {"SPY": _make_series(n, 0.0)}
    with pytest.raises(ValueError):
        sector_rotation(closes, lookbacks=(10, 20))  # wrong length
    with pytest.raises(ValueError):
        sector_rotation(closes, lookbacks=(0, 10, 20))


def test_empty_after_filters_returns_empty_scores():
    n = 200
    closes = {
        "SPY": _make_series(n, 0.0, seed=60),
        "ZZZ_UNKNOWN": _make_series(n, 0.0, seed=61),
    }
    rep = sector_rotation(closes)
    assert rep.scores == []
    assert rep.overweight == []
    assert rep.underweight == []
    assert "ZZZ_UNKNOWN" in rep.skipped_unknown_sector


def test_call_assignment_is_tertile_based():
    n = 200
    # 6 sectors with clear ordering by drift
    closes = {
        "SPY": _make_series(n, 0.0, seed=70),
        "AAPL": _make_series(n, 0.0020, seed=71),   # Tech
        "MSFT": _make_series(n, 0.0018, seed=72),
        "XOM":  _make_series(n, -0.0020, seed=73),  # Energy
        "CVX":  _make_series(n, -0.0018, seed=74),
        "JPM":  _make_series(n, 0.0015, seed=75),   # Financials
        "BAC":  _make_series(n, 0.0014, seed=76),
        "JNJ":  _make_series(n, -0.0010, seed=77),  # Health
        "PFE":  _make_series(n, -0.0008, seed=78),
        "HD":   _make_series(n, 0.0005, seed=79),   # Cons Disc
        "NKE":  _make_series(n, 0.0006, seed=80),
        "NFLX": _make_series(n, -0.0003, seed=81),  # Comm
        "DIS":  _make_series(n, -0.0002, seed=82),
    }
    rep = sector_rotation(closes)
    n_sec = len(rep.scores)
    assert n_sec >= 4
    # Sum of overweight + neutral + underweight equals total
    over = [s for s in rep.scores if s.call == "overweight"]
    under = [s for s in rep.scores if s.call == "underweight"]
    neutral = [s for s in rep.scores if s.call == "neutral"]
    assert len(over) + len(under) + len(neutral) == n_sec
    # Top composite is overweight, bottom is underweight
    assert rep.scores[0].call == "overweight"
    assert rep.scores[-1].call == "underweight"
