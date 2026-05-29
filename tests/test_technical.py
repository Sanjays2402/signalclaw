import numpy as np, pandas as pd
from hypothesis import given, strategies as st, settings as hsettings
from signalclaw.features.technical import rsi, macd, bollinger_bands, atr, obv, sma, ema


def _series(n=200, seed=0):
    rng = np.random.default_rng(seed)
    return pd.Series(100 + np.cumsum(rng.normal(0, 1, n)))


def test_rsi_bounds():
    s = _series()
    r = rsi(s, 14)
    assert r.between(0, 100).all()


def test_macd_columns():
    s = _series()
    m = macd(s)
    assert set(m.columns) == {"macd", "macd_signal", "macd_hist"}


def test_bollinger_consistency():
    s = _series()
    bb = bollinger_bands(s, 20, 2.0)
    valid = bb.dropna()
    assert (valid["bb_upper"] >= valid["bb_mid"]).all()
    assert (valid["bb_lower"] <= valid["bb_mid"]).all()


def test_atr_positive():
    n = 200; rng = np.random.default_rng(1)
    close = pd.Series(100 + np.cumsum(rng.normal(0, 1, n)))
    high = close + rng.uniform(0.1, 1, n)
    low = close - rng.uniform(0.1, 1, n)
    a = atr(high, low, close, 14).dropna()
    assert (a > 0).all()


def test_obv_monotone_volume_directions():
    close = pd.Series([1, 2, 3, 2, 4])
    vol = pd.Series([10, 10, 10, 10, 10])
    o = obv(close, vol)
    assert len(o) == 5


@given(st.integers(min_value=80, max_value=300))
@hsettings(deadline=None, max_examples=20)
def test_sma_length_property(n):
    s = _series(n)
    out = sma(s, 20)
    assert len(out) == n
