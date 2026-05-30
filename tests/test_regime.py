from __future__ import annotations
import numpy as np
import pandas as pd
import pytest

from signalclaw.regime import detect_regime, regime_series, RegimeLabel


def _series(returns: np.ndarray, start: float = 100.0) -> pd.Series:
    prices = start * np.exp(np.cumsum(returns))
    idx = pd.date_range("2020-01-01", periods=len(prices), freq="B")
    return pd.Series(prices, index=idx)


def test_detect_regime_bull():
    rng = np.random.default_rng(0)
    # steady drift up, modest vol
    rets = rng.normal(0.0008, 0.008, 400)
    snap = detect_regime(_series(rets))
    assert snap is not None
    assert snap.label == RegimeLabel.BULL
    assert snap.risk_scale > 1.0
    assert snap.drawdown <= 0.0


def test_detect_regime_crash():
    rng = np.random.default_rng(1)
    rets = np.concatenate([
        rng.normal(0.0005, 0.01, 200),
        rng.normal(-0.01, 0.03, 100),  # crash leg
    ])
    snap = detect_regime(_series(rets))
    assert snap is not None
    assert snap.label in (RegimeLabel.CRASH, RegimeLabel.BEAR)
    assert snap.risk_scale <= 0.5
    assert snap.drawdown < -0.10


def test_detect_regime_insufficient_data():
    s = pd.Series([100.0, 101.0, 102.0])
    assert detect_regime(s) is None


def test_regime_series_length_and_values():
    rng = np.random.default_rng(2)
    rets = rng.normal(0.0005, 0.01, 500)
    series = regime_series(_series(rets))
    assert len(series) == 500
    # at least some labels assigned after warmup
    assert series.dropna().shape[0] >= 200
    assert set(series.dropna().unique()).issubset({"bull", "chop", "bear", "crash"})


def test_regime_snapshot_serializable():
    rng = np.random.default_rng(3)
    rets = rng.normal(0.0006, 0.009, 400)
    snap = detect_regime(_series(rets))
    d = snap.to_dict()
    assert isinstance(d["label"], str)
    assert "risk_scale" in d
